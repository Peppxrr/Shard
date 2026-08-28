#include "game_system.h"

#include "game_util.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

namespace clipforge {

namespace fs = std::filesystem;

using namespace std::chrono;

namespace {

constexpr int64_t kDiscoveryIntervalMs = 3600000; // rescan launchers hourly
constexpr int64_t kCandidateTimeoutMs = 15000; // renderer/window startup budget
constexpr int64_t kReevalIntervalMs = 250;

int64_t unixNowMs()
{
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}


} // namespace

GameSystem::GameSystem(Config& config, Events& events, SourceManager& sources, Recorder& recorder)
    : config_(config), events_(events), sources_(sources), recorder_(recorder)
{
}

GameSystem::~GameSystem()
{
  stop();
}

std::string GameSystem::effectiveRegistryPath() const
{
  if (!registryPathOverride_.empty())
    return registryPathOverride_;
  if (!config_.game.gamesPath.empty())
    return config_.game.gamesPath;
  return (fs::path(config_.configDir) / "games.json").string();
}

// ------------------------------------------------------------------ start --

void GameSystem::start()
{
  if (run_.exchange(true))
    return;

  registry_.setPath(effectiveRegistryPath());
  registry_.load();
  registry_.setVerboseLogging(config_.game.verboseDetection);

  // Well-known launcher/registry paths; providers are pure given this context.
  discovery_.setContext(LauncherDiscovery::defaults());


  monitor_.start([this](const ProcessEvent& e) { handleProcessEvent(e); });
  sessions_.setSink([this](const char* type, const nlohmann::json& params) {
    events_.emit(type, params);
    if (std::strcmp(type, "game.session") == 0) {
      const std::string state = params.value("state", std::string());
      if (state == "started" || state == "ended" || state == "primary")
        emitGameChanged();
      if (state == "ended")
        lastSessionEndMs_ = unixNowMs();
    }
  });

  loopThread_ = std::thread([this] { loop(); });
}

void GameSystem::stop()
{
  if (!run_.exchange(false))
    return;
  if (loopThread_.joinable())
    loopThread_.join();
  monitor_.stop();
}

void GameSystem::onConfigChanged()
{
  if (!run_.load())
    return;
  registry_.setPath(effectiveRegistryPath());
  registry_.load();
  registry_.setVerboseLogging(config_.game.verboseDetection);
  discoveryRequested_.store(true);
}

// ------------------------------------------------------------------- loop --

void GameSystem::loop()
{
  int64_t lastTick = 0;
  while (run_.load()) {
    const int64_t now = unixNowMs();
    if (now - lastTick >= 500) {
      lastTick = now;
      monitor_.tick();
      // Product metadata must exist before live qualification, otherwise an
      // already-running launcher game would be stored as a duplicate runtime
      // product during the first tick.
      if (discoveryRequested_.exchange(false) ||
          lastDiscovery_ == steady_clock::time_point{} ||
          steady_clock::now() - lastDiscovery_ >= milliseconds(kDiscoveryIntervalMs)) {
        runDiscoveryScan();
        lastDiscovery_ = steady_clock::now();
      }
      evaluateForegroundProcess();
      reEvaluateCandidates();
      applyFocusPrimary();
      probeSessions();
      updateCaptureSubject();

      // Auto-record: start when a session is active, stop after the grace
      // period once the last session ended.
      if (config_.game.autoRecord) {
        if (sessions_.count() > 0 && !recorder_.active()) {
          recorder_.start();
          autoRecording_ = true;
        } else if (sessions_.count() == 0 && autoRecording_ && recorder_.active() &&
                   lastSessionEndMs_ > 0 && now - lastSessionEndMs_ >= (int64_t)config_.game.graceSeconds * 1000) {
          recorder_.stop();
          autoRecording_ = false;
        }
      }
    }
    std::this_thread::sleep_for(milliseconds(100));
  }
}

void GameSystem::handleProcessEvent(const ProcessEvent& e)
{
  if (e.type == ProcessEvent::Type::Started) {
    // WMI usually arrives before the process has a window. Evaluate once for
    // already-ready processes; foreground observation keeps only plausible
    // renderer candidates hot while their window/modules finish loading.
    evaluateProcess(e.info.pid);
    return;
  }

  std::lock_guard<std::mutex> lock(stateMtx_);
  knownPids_.erase(e.info.pid);
  candidateSince_.erase(e.info.pid);
  if (observedForegroundPid_ == e.info.pid)
    observedForegroundPid_ = 0;
  sessions_.onProcessExited(e.info.pid);
}

void GameSystem::evaluateProcess(uint32_t pid)
{
  if (pid == 0)
    return;
  ProcessInfo process = monitor_.lookup(pid);
  if (process.exe.empty() || process.exe == "shardcore.exe")
    return;

  {
    std::lock_guard<std::mutex> lock(stateMtx_);
    if (knownPids_.count(pid))
      return;
  }

  monitor_.resolve(pid);
  process = monitor_.lookup(pid);
  const auto productHint = productHintForPath(process.path);
  const WindowProbe probe = probeWindow(pid);
  const ProcessRuntimeFacts runtime = monitor_.probeRuntime(pid);

  DetectContext context;
  context.registry = &registry_;
  context.productHint = productHint ? &*productHint : nullptr;
  context.chain = [this](uint32_t id) { return monitor_.ancestors(id); };
  context.lookup = [this](uint32_t id) { return monitor_.lookup(id); };
  context.nowMs = unixNowMs();
  context.window.hasVisibleWindow = probe.hasWindow;
  context.window.title = probe.title;
  context.window.captureable = probe.captureable;
  context.window.fullscreen = probe.fullscreen;
  context.window.foreground = probe.foreground;
  context.window.area = probe.area;
  context.runtime.probeSucceeded = runtime.probeSucceeded;
  context.runtime.graphicsApi = runtime.graphicsApi;
  context.runtime.gameRuntime = runtime.gameRuntime;
  context.runtime.webRuntime = runtime.webRuntime;
  context.runtime.mediaRuntime = runtime.mediaRuntime;
  context.runtime.gameInput = runtime.gameInput;
  context.recentProcess = process.startMs > 0 && context.nowMs >= process.startMs &&
                          context.nowMs - process.startMs <= kCandidateTimeoutMs;
  if (probe.foreground) {
    std::lock_guard<std::mutex> lock(stateMtx_);
    const auto candidate = candidateSince_.find(pid);
    if (candidate != candidateSince_.end())
      context.foregroundIntentMs = context.nowMs - candidate->second;
  }

  DetectionResult result = GameDetector::detect(process, context);
  logDetection(process, result);

  if (result.decision == DetectionResult::Decision::Detected && !result.gameId.empty() &&
      !registry_.findById(result.gameId) && productHint && productHint->id == result.gameId) {
    GameDefinition qualifiedProduct = *productHint;
    qualifiedProduct.executables = {process.exe};
    registry_.mergeDiscovered(qualifiedProduct);
    result = GameDetector::detect(process, context);
  }

  if (result.decision == DetectionResult::Decision::Detected && result.gameId.empty()) {
    // A qualified child may join an authoritative installed/user product.
    // Runtime-discovered ancestors never own descendants; those get their own
    // stable identity. Mere ancestry is never qualifying evidence.
    std::string ancestorGameId;
    {
      std::lock_guard<std::mutex> lock(stateMtx_);
      const auto chain = monitor_.ancestors(pid);
      for (size_t i = 1; i < chain.size(); i++) {
        const auto known = knownPids_.find(chain[i]);
        if (known == knownPids_.end())
          continue;
        // Runtime products represent one qualified executable, not ownership
        // of every qualified descendant. Otherwise an application host such
        // as CurseForge absorbs javaw.exe and the launcher becomes the game.
        if (GameDetector::canOwnQualifiedDescendant(known->second)) {
          ancestorGameId = known->second;
          break;
        }
      }
    }
    if (!ancestorGameId.empty())
      registry_.addRuntimeExecutable(ancestorGameId, process.exe);
    else
      createRuntimeProduct(process, result);
    result = GameDetector::detect(process, context);
  }

  if (result.decision == DetectionResult::Decision::Detected && !result.gameId.empty()) {
    {
      std::lock_guard<std::mutex> lock(stateMtx_);
      knownPids_[pid] = result.gameId;
      candidateSince_.erase(pid);
    }
    sessions_.onDetected(result, process);

    // The process passed positive game qualification. Persist only this
    // executable, never its unobserved directory siblings.
    const GameDefinition* product = registry_.findById(result.gameId);
    if (product && !registry_.findByExe(process.exe))
      registry_.addRuntimeExecutable(result.gameId, process.exe);
    return;
  }

  if (result.decision == DetectionResult::Decision::Candidate) {
    std::lock_guard<std::mutex> lock(stateMtx_);
    candidateSince_.try_emplace(pid, unixNowMs());
  }
}

void GameSystem::reEvaluateCandidates()
{
  std::vector<uint32_t> toCheck;
  {
    std::lock_guard<std::mutex> lock(stateMtx_);
    const int64_t now = unixNowMs();
    for (auto it = candidateSince_.begin(); it != candidateSince_.end();) {
      if (now - it->second >= kCandidateTimeoutMs) {
        it = candidateSince_.erase(it);
        continue;
      }
      if (now - it->second >= kReevalIntervalMs)
        toCheck.push_back(it->first);
      ++it;
    }
  }
  for (uint32_t pid : toCheck)
    if (monitor_.alive(pid))
      evaluateProcess(pid);
}

void GameSystem::evaluateForegroundProcess()
{
  const uint32_t pid = foregroundPid();
  if (pid == 0)
    return;

  bool shouldEvaluate = false;
  {
    std::lock_guard<std::mutex> lock(stateMtx_);
    if (knownPids_.count(pid))
      return;
    if (pid != observedForegroundPid_) {
      observedForegroundPid_ = pid;
      candidateSince_[pid] = unixNowMs();
      shouldEvaluate = true;
    } else {
      shouldEvaluate = candidateSince_.count(pid) != 0;
    }
  }
  if (shouldEvaluate)
    evaluateProcess(pid);
}

std::string GameSystem::createRuntimeProduct(const ProcessInfo& process, const DetectionResult& result)
{
  const fs::path executablePath(process.path);
  const std::string installPath = process.path.empty() ? std::string() : normalizePath(executablePath.parent_path().string());
  const std::string identity = process.path.empty() ? process.exe : normalizePath(process.path);
  uint64_t hash = 1469598103934665603ULL;
  for (unsigned char c : identity) {
    hash ^= c;
    hash *= 1099511628211ULL;
  }
  char idPart[17] = {};
  std::snprintf(idPart, sizeof(idPart), "%016llx", (unsigned long long)hash);

  GameDefinition game;
  game.id = std::string("d:runtime:") + idPart;
  game.name = result.gameName.empty() ? process.exe : result.gameName;
  game.executables = {process.exe};
  if (!installPath.empty())
    game.installPaths = {installPath};
  game.launchers = {{"runtime", idPart}};
  game.productType = "game";
  game.source = GameSource::Discovered;

  registry_.mergeDiscovered(game);
  const GameDefinition* merged = registry_.findByExe(process.exe);
  return merged ? merged->id : game.id;
}



std::optional<GameDefinition> GameSystem::productHintForPath(const std::string& lowerPath) const
{
  if (lowerPath.empty())
    return std::nullopt;
  std::lock_guard<std::mutex> lock(productHintsMtx_);
  const GameDefinition* best = nullptr;
  size_t bestLength = 0;
  for (const auto& product : productHints_) {
    if (!product.enabled)
      continue;
    for (const auto& installPath : product.installPaths) {
      if (installPath.size() > bestLength && pathUnder(lowerPath, installPath)) {
        best = &product;
        bestLength = installPath.size();
      }
    }
  }
  return best ? std::optional<GameDefinition>(*best) : std::nullopt;
}



void GameSystem::probeSessions()
{
  GameSession prim = sessions_.primary();
  if (prim.pid == 0)
    return;
  // Emulator/multi-window games: the probe prefers the fullscreen window or
  // the window whose title contains the game name — i.e. the actual game
  // window, not the emulator GUI.
  // FIX: a session aggregates multiple pids (VRChat + UnityCrashHandler).
  // Probing only prim.pid (which may be the helper with no window, e.g.
  // UnityCrashHandler64) made the capture descriptor empty → WGC found no
  // window → black. Probe every pid in the session and keep the best visible
  // window, promoting its pid to the session's primary pid if needed.
  WindowProbe bestProbe;
  uint32_t bestPid = 0;
  std::string bestTitle;
  for (uint32_t pid : prim.pids) {
    WindowProbe probe = probeWindow(pid, prim.gameName);
    if (!probe.hasWindow || probe.minimized || !probe.onScreen)
      continue;
    // Prefer: fullscreen > title contains game name > any window.
    // The per-pid probe already prefers those internally; across pids we need
    // the same ordering. Use fullscreen first, then hint, then first seen.
    bool isBetter = false;
    if (bestPid == 0)
      isBetter = true;
    else if (probe.fullscreen != bestProbe.fullscreen)
      isBetter = probe.fullscreen;
    else {
      const std::string hint = toLower(trim(prim.gameName));
      const bool probeHint = !hint.empty() && toLower(probe.title).find(hint) != std::string::npos;
      const bool bestHint = !hint.empty() && toLower(bestProbe.title).find(hint) != std::string::npos;
      if (probeHint != bestHint)
        isBetter = probeHint;
    }
    if (isBetter) {
      bestProbe = probe;
      bestPid = pid;
    }
  }
  // No on-screen window among pids: fall back to probing the session's
  // primary pid (may be minimized/hidden) so at least we report something.
  if (bestPid == 0) {
    bestProbe = probeWindow(prim.pid, prim.gameName);
    bestPid = prim.pid;
  }
  // If the best window lives on a different pid than prim.pid, heal the
  // session: make the window-bearing pid the session's representative.
  if (bestPid != prim.pid && bestProbe.hasWindow) {
    ProcessInfo bestInfo = monitor_.lookup(bestPid);
    if (!bestInfo.exe.empty()) {
      sessions_.updateProcess(prim.pid, bestInfo.exe, bestInfo.path);
      // updateWindow is keyed by pid, so also move the window info to bestPid
      // and update primary's pid visibly: we can't change prim.pid directly
      // without a session API, so we refresh the session via onDetected which
      // will fold bestPid in and make it the primary pid. Simulate by
      // re-detecting bestPid.
      const ProcessRuntimeFacts runtime = monitor_.probeRuntime(bestPid);
      DetectContext ctx;
      ctx.registry = &registry_;
      ctx.chain = [this](uint32_t id) { return monitor_.ancestors(id); };
      ctx.lookup = [this](uint32_t id) { return monitor_.lookup(id); };
      ctx.nowMs = unixNowMs();
      ctx.window.hasVisibleWindow = bestProbe.hasWindow;
      ctx.window.title = bestProbe.title;
      ctx.window.captureable = bestProbe.captureable;
      ctx.window.fullscreen = bestProbe.fullscreen;
      ctx.window.foreground = bestProbe.foreground;
      ctx.window.area = bestProbe.area;
      ctx.runtime = {runtime.probeSucceeded, runtime.graphicsApi, runtime.gameRuntime, runtime.gameInput,
                     runtime.webRuntime, runtime.mediaRuntime};
      DetectionResult r = GameDetector::detect(bestInfo, ctx);
      if (r.decision == DetectionResult::Decision::Detected) {
        sessions_.onDetected(r, bestInfo);
        // Re-fetch prim after healing
        prim = sessions_.primary();
        bestProbe = probeWindow(prim.pid, prim.gameName);
      }
    }
  }
  sessions_.updateWindow(prim.pid, bestProbe.title, bestProbe.cls, bestProbe.fullscreen, bestProbe.hasWindow);

  // Re-run the detector on the active process so current window/runtime
  // evidence refreshes session metadata without restarting the session.
  if (!monitor_.alive(prim.pid))
    return;
  ProcessInfo p = monitor_.lookup(prim.pid);
  if (p.exe.empty())
    return;
  sessions_.updateProcess(prim.pid, p.exe, p.path);
  const ProcessRuntimeFacts runtime = monitor_.probeRuntime(prim.pid);
  DetectContext ctx;
  ctx.registry = &registry_;
  ctx.chain = [this](uint32_t id) { return monitor_.ancestors(id); };
  ctx.lookup = [this](uint32_t id) { return monitor_.lookup(id); };
  ctx.nowMs = unixNowMs();
  ctx.window.hasVisibleWindow = bestProbe.hasWindow;
  ctx.window.title = bestProbe.title;
  ctx.window.captureable = bestProbe.captureable;
  ctx.window.fullscreen = bestProbe.fullscreen;
  ctx.window.foreground = bestProbe.foreground;
  ctx.window.area = bestProbe.area;
  ctx.runtime = {runtime.probeSucceeded, runtime.graphicsApi, runtime.gameRuntime, runtime.gameInput,
                 runtime.webRuntime, runtime.mediaRuntime};
  DetectionResult r = GameDetector::detect(p, ctx);
  if (r.decision != DetectionResult::Decision::Ignored)
    sessions_.onDetected(r, p); // refreshes score/launcher, never restarts
}

GameSystem::WindowProbe GameSystem::probeWindow(uint32_t pid, const std::string& titleHint) const
{
  WindowProbe out;
#ifdef _WIN32
  if (pid == 0)
    return out;

  HWND fg = GetForegroundWindow();
  DWORD fgPid = 0;
  if (fg)
    GetWindowThreadProcessId(fg, &fgPid);
  out.foreground = fgPid == pid;

  // Collect every visible top-level window of the pid, then pick the best
  // capture target: fullscreen > title contains the game name (emulators and
  // multi-window games create a separate game window) > largest > first.
  struct Win {
    HWND hwnd = nullptr;
    std::string title;
    std::string cls;
    long area = 0;
    bool fullscreen = false;
    bool minimized = false;
    bool onScreen = false;
    bool captureable = false;
  };
  std::vector<Win> wins;
  struct Ctx {
    uint32_t pid;
    std::vector<Win>* wins;
  } ctx = {pid, &wins};
  EnumWindows(
      [](HWND h, LPARAM lp) -> BOOL {
        Ctx* c = reinterpret_cast<Ctx*>(lp);
        DWORD wpid = 0;
        GetWindowThreadProcessId(h, &wpid);
        if (wpid != c->pid || !IsWindowVisible(h))
          return TRUE;
        const LONG_PTR exStyles = GetWindowLongPtr(h, GWL_EXSTYLE);
        if ((exStyles & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) != 0)
          return TRUE;
        Win w;
        w.hwnd = h;
        wchar_t titleW[512] = {0};
        if (GetWindowTextW(h, titleW, 512) > 0) {
          int len = WideCharToMultiByte(CP_UTF8, 0, titleW, -1, nullptr, 0, nullptr, nullptr);
          if (len > 1) {
            w.title.assign(len - 1, '\0');
            WideCharToMultiByte(CP_UTF8, 0, titleW, -1, w.title.data(), len, nullptr, nullptr);
          }
        }
        wchar_t clsW[256] = {0};
        if (GetClassNameW(h, clsW, 256) > 0) {
          int len = WideCharToMultiByte(CP_UTF8, 0, clsW, -1, nullptr, 0, nullptr, nullptr);
          if (len > 1) {
            w.cls.assign(len - 1, '\0');
            WideCharToMultiByte(CP_UTF8, 0, clsW, -1, w.cls.data(), len, nullptr, nullptr);
          }
        }
        RECT rect;
        if (GetWindowRect(h, &rect)) {
          RECT client = {};
          if (GetClientRect(h, &client))
            w.area = (long)(client.right - client.left) * (long)(client.bottom - client.top);
          // Minimized windows report an off-screen icon rect — IsIconic is the
          // reliable check. onScreen = the window rect intersects a monitor.
          w.minimized = IsIconic(h) != 0;
          w.onScreen = MonitorFromRect(&rect, MONITOR_DEFAULTTONULL) != nullptr;
          w.captureable = !w.minimized && w.onScreen && w.area >= (long)320 * 200;
          DWORD styles = (DWORD)GetWindowLongPtr(h, GWL_STYLE);
          bool maximized = (styles & WS_MAXIMIZE) != 0 && (styles & WS_BORDER) != 0;
          if (!maximized) {
            HMONITOR monitor = MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST);
            MONITORINFO mi = {};
            mi.cbSize = sizeof(mi);
            if (monitor && GetMonitorInfo(monitor, &mi)) {
              w.fullscreen = rect.left == mi.rcMonitor.left && rect.right == mi.rcMonitor.right &&
                             rect.top == mi.rcMonitor.top && rect.bottom == mi.rcMonitor.bottom;
            }
          }
        }
        c->wins->push_back(std::move(w));
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&ctx));

  out.hasWindow = !wins.empty();
  if (wins.empty())
    return out;

  const std::string hint = toLower(trim(titleHint));
  const Win* best = &wins[0];
  for (const auto& w : wins) {
    const bool wFull = w.fullscreen;
    const bool bFull = best->fullscreen;
    const bool wHint = !hint.empty() && toLower(w.title).find(hint) != std::string::npos;
    const bool bHint = !hint.empty() && toLower(best->title).find(hint) != std::string::npos;
    if (wFull != bFull) {
      if (wFull)
        best = &w;
      continue;
    }
    if (wHint != bHint) {
      if (wHint)
        best = &w;
      continue;
    }
    if (w.area > best->area)
      best = &w;
  }
  out.title = best->title;
  out.cls = best->cls;
  out.captureable = best->captureable;
  out.fullscreen = best->fullscreen;
  out.minimized = best->minimized;
  out.onScreen = best->onScreen;
  out.area = best->area;
#endif
  (void)pid;
  (void)titleHint;
  return out;
}

uint32_t GameSystem::foregroundPid() const
{
#ifdef _WIN32
  HWND fg = GetForegroundWindow();
  if (!fg)
    return 0;
  DWORD pid = 0;
  GetWindowThreadProcessId(fg, &pid);
  return pid;
#else
  return 0;
#endif
}

// Active-game following: the game that holds focus for the debounce window
// becomes primary, so capture switches back and forth between running games
// like the user does. Focus on a non-game never changes the primary.
// This is the SINGLE authority for primary selection (updateCaptureSubject
// never mutates primary).
void GameSystem::applyFocusPrimary()
{
  const GameSession* fgSession = sessions_.sessionForPid(foregroundPid());
  const std::string target = fgSession ? fgSession->gameId : std::string();
  {
    std::lock_guard<std::mutex> lock(stateMtx_);
    if (target != focusGameId_) {
      focusGameId_ = target;
      focusSinceMs_ = target.empty() ? 0 : unixNowMs();
      if (registry_.verboseLogging() && !target.empty()) {
        std::fprintf(stderr, "[GameDetection] focus changed -> %s (pid %u) debounce start\n",
                     fgSession->gameName.c_str(), fgSession->pid);
      } else if (registry_.verboseLogging() && target.empty()) {
        std::fprintf(stderr, "[GameDetection] focus -> non-game/desktop, keeping primary %s\n",
                     sessions_.primary().gameName.c_str());
      }
    }
  }
  if (focusGameId_.empty())
    return;
  int64_t sinceMs = 0;
  {
    std::lock_guard<std::mutex> lock(stateMtx_);
    sinceMs = focusSinceMs_;
  }
  if (unixNowMs() - sinceMs >= kFocusDebounceMs) {
    const GameSession prim = sessions_.primary();
    if (prim.gameId != focusGameId_) {
      if (registry_.verboseLogging()) {
        std::fprintf(stderr, "[GameDetection] debounce satisfied %lldms: primary %s -> %s\n",
                     (long long)(unixNowMs() - sinceMs),
                     prim.gameName.empty() ? "<none>" : prim.gameName.c_str(),
                     fgSession ? fgSession->gameName.c_str() : focusGameId_.c_str());
      }
      sessions_.setPrimaryByGameId(focusGameId_);
    }
  }
}

void GameSystem::updateCaptureSubject()
{
  // SINGLE responsibility: read selected primary, push to SourceManager.
  // Never decides who primary is — that is applyFocusPrimary's job.
  // Re-fetch primary here so we never operate on a stale snapshot.
  GameSession prim = sessions_.primary();
  bool hasSubject = prim.pid != 0 && !prim.exe.empty();

  if (!hasSubject) {
    if (pushedSubjectPid_ != 0) {
      pushedSubjectPid_ = 0;
      pushedSubjectExe_.clear();
      pushedSubjectTitle_.clear();
      pushedSubjectClass_.clear();
      sources_.clearGameSubject();
    }
    return;
  }
  if (pushedSubjectPid_ == prim.pid && pushedSubjectTitle_ == prim.title && pushedSubjectClass_ == prim.cls &&
      pushedSubjectExe_ == prim.exe)
    return; // unchanged

  pushedSubjectPid_ = prim.pid;
  pushedSubjectExe_ = prim.exe;
  pushedSubjectTitle_ = prim.title;
  pushedSubjectClass_ = prim.cls;
  sources_.setGameSubject(prim.exe, prim.gameName, prim.title, prim.cls, prim.pid);
}

void GameSystem::emitGameChanged()
{
  const GameSession prim = sessions_.primary();
  const bool known = prim.pid != 0;
  events_.emit("game.changed",
               {{"exe", known ? prim.exe : ""},
                {"name", known ? nlohmann::json(prim.gameName) : nlohmann::json(nullptr)},
                {"pid", known ? prim.pid : 0},
                {"known", known}});
}

// ------------------------------------------------------------ discovery ---

void GameSystem::runDiscoveryScan()
{
  ScanContext ctx = LauncherDiscovery::defaults();
  discovery_.setContext(ctx);
  auto scan = discovery_.scanAll();
  if (registry_.verboseLogging()) {
    for (const auto& result : scan.results)
      std::fprintf(stderr, "[GameDetection] discovery %s: %d product hint(s)\n",
                   result.type.c_str(), result.games);
  }
  // Purge previously learned executables for products that Steam now
  // authoritatively identifies as non-games. Keep them as ephemeral hints so
  // the detector rejects their install paths without an executable denylist.
  for (const auto& product : scan.products) {
    if (product.productType == "software" || product.productType == "tool")
      registry_.discardNonGameProduct(product.id);
  }
  {
    std::lock_guard<std::mutex> lock(productHintsMtx_);
    productHints_ = std::move(scan.products);
  }
}

// -------------------------------------------------------------- RPC -------

nlohmann::json GameSystem::listKnown() const
{
  nlohmann::json arr = nlohmann::json::array();
  for (const auto& g : registry_.all()) {
    if (!g.enabled)
      continue;
    for (const auto& exe : g.executables) {
      // Emit one entry per exe, deduped across layers (exe index precedence).
      const GameDefinition* best = registry_.findByExe(exe);
      if (!best || best->id != g.id)
        continue;
      arr.push_back({{"exe", exe}, {"name", g.name}});
    }
  }
  return arr;
}

bool GameSystem::addKnown(const std::string& exe, const std::string& name)
{
  GameDefinition g;
  g.name = name;
  g.executables = {exe};
  return !registry_.upsertUserGame(g).empty();
}

bool GameSystem::removeKnown(const std::string& exe)
{
  const std::string key = toLower(exe);
  const GameDefinition* g = registry_.findByExe(key);
  if (g && g->source == GameSource::User) {
    if (registry_.removeUserGame(g->id))
      return true;
  }
  // Builtin/discovered entries cannot be deleted; removing them means
  // "stop treating this exe as a game" -> ignore rule.
  if (g) {
    registry_.addIgnoredExe(key);
    return true;
  }
  return registry_.removeIgnoredExe(key);
}

nlohmann::json GameSystem::listGames() const
{
  nlohmann::json arr = nlohmann::json::array();
  for (const auto& g : registry_.all())
    arr.push_back(g.toJson());
  return arr;
}

nlohmann::json GameSystem::addUserGame(const nlohmann::json& params)
{
  GameDefinition g;
  g.name = params.value("name", std::string());
  if (params.contains("executables") && params["executables"].is_array())
    for (const auto& e : params["executables"])
      if (e.is_string())
        g.executables.push_back(e.get<std::string>());
  if (params.contains("installPaths") && params["installPaths"].is_array())
    for (const auto& p : params["installPaths"])
      if (p.is_string())
        g.installPaths.push_back(p.get<std::string>());
  const std::string id = registry_.upsertUserGame(g);
  return {{"id", id}, {"ok", !id.empty()}};
}

bool GameSystem::removeUserGame(const std::string& id)
{
  return registry_.removeUserGame(id);
}

bool GameSystem::removeDiscovered(const std::string& id)
{
  return registry_.removeDiscoveredGame(id);
}


nlohmann::json GameSystem::updateUserGame(const nlohmann::json& params)
{
  const std::string id = params.value("id", std::string());
  if (id.empty())
    return {{"ok", false}, {"error", "id required"}};
  std::vector<std::string> exes;
  if (params.contains("executables") && params["executables"].is_array())
    for (const auto& e : params["executables"])
      if (e.is_string())
        exes.push_back(e.get<std::string>());
  std::vector<std::string> paths;
  if (params.contains("installPaths") && params["installPaths"].is_array())
    for (const auto& p : params["installPaths"])
      if (p.is_string())
        paths.push_back(p.get<std::string>());
  return {{"ok", registry_.extendUserGame(id, exes, paths)}};
}

nlohmann::json GameSystem::listIgnored() const
{
  return registry_.ignoredExes();
}

bool GameSystem::ignoreExe(const std::string& exe)
{
  registry_.addIgnoredExe(exe);
  return true;
}

bool GameSystem::unignoreExe(const std::string& exe)
{
  return registry_.removeIgnoredExe(exe);
}




nlohmann::json GameSystem::sessions() const
{
  return sessionsJson();
}

nlohmann::json GameSystem::sessionsJson() const
{
  nlohmann::json arr = nlohmann::json::array();
  for (const auto& s : sessions_.all()) {
    arr.push_back({{"gameId", s.gameId},
                   {"name", s.gameName},
                   {"exe", s.exe},
                   {"pid", s.pid},
                   {"pids", s.pids},
                   {"startMs", s.startMs},
                   {"confidence", s.score},
                   {"launcher", s.launcher.empty() ? nlohmann::json(nullptr) : nlohmann::json(s.launcher)},
                   {"emulator", s.emulator},
                   {"primary", s.primary}});
  }
  return arr;
}

nlohmann::json GameSystem::detectExplain(const nlohmann::json& params) const
{
  const uint32_t pid = params.value("pid", (uint32_t)0);
  ProcessInfo p = monitor_.lookup(pid);
  if (p.exe.empty()) {
    if (pid == 0)
      return {{"error", "pid required"}};
    return {{"error", "process not found"}, {"pid", pid}};
  }
  const_cast<ProcessMonitor&>(monitor_).resolve(pid);
  p = monitor_.lookup(pid);
  const WindowProbe probe = probeWindow(pid);
  const ProcessRuntimeFacts runtime = monitor_.probeRuntime(pid);
  const auto productHint = productHintForPath(p.path);
  DetectContext ctx;
  ctx.registry = &registry_;
  ctx.productHint = productHint ? &*productHint : nullptr;
  ctx.chain = [this](uint32_t id) { return monitor_.ancestors(id); };
  ctx.lookup = [this](uint32_t id) { return monitor_.lookup(id); };
  ctx.nowMs = unixNowMs();
  ctx.window.hasVisibleWindow = probe.hasWindow;
  ctx.window.title = probe.title;
  ctx.window.captureable = probe.captureable;
  ctx.window.fullscreen = probe.fullscreen;
  ctx.window.foreground = probe.foreground;
  ctx.window.area = probe.area;
  ctx.runtime = {runtime.probeSucceeded, runtime.graphicsApi, runtime.gameRuntime, runtime.gameInput,
                 runtime.webRuntime, runtime.mediaRuntime};
  ctx.recentProcess = p.startMs > 0 && ctx.nowMs >= p.startMs &&
                      ctx.nowMs - p.startMs <= kCandidateTimeoutMs;
  if (probe.foreground) {
    std::lock_guard<std::mutex> lock(stateMtx_);
    const auto candidate = candidateSince_.find(pid);
    if (candidate != candidateSince_.end())
      ctx.foregroundIntentMs = ctx.nowMs - candidate->second;
  }
  const DetectionResult r = GameDetector::detect(p, ctx);

  nlohmann::json reasons = nlohmann::json::array();
  for (const auto& rr : r.reasons)
    reasons.push_back({{"signal", rr.signal}, {"delta", rr.delta}, {"note", rr.note}});
  const char* decision = r.decision == DetectionResult::Decision::Detected
                             ? "DETECTED"
                             : r.decision == DetectionResult::Decision::Candidate ? "CANDIDATE" : "IGNORED";
  return {{"exe", p.exe},
          {"pid", pid},
          {"score", r.score},
          {"decision", decision},
          {"gameId", r.gameId.empty() ? nlohmann::json(nullptr) : nlohmann::json(r.gameId)},
          {"gameName", r.gameName.empty() ? nlohmann::json(nullptr) : nlohmann::json(r.gameName)},
          {"reasons", reasons}};
}

// -------------------------------------------------------------- state -----

std::string GameSystem::currentExe() const
{
  const GameSession prim = sessions_.primary();
  return prim.pid == 0 ? std::string() : prim.exe;
}

std::string GameSystem::currentName() const
{
  const GameSession prim = sessions_.primary();
  return prim.pid == 0 ? std::string() : prim.gameName;
}

bool GameSystem::currentKnown() const
{
  return sessions_.primary().pid != 0;
}

uint32_t GameSystem::currentPid() const
{
  return sessions_.primary().pid;
}

void GameSystem::logDetection(const ProcessInfo& p, const DetectionResult& r)
{
  if (!registry_.verboseLogging())
    return;
  const char* decision = r.decision == DetectionResult::Decision::Detected
                             ? "DETECTED"
                             : r.decision == DetectionResult::Decision::Candidate ? "CANDIDATE" : "IGNORED";
  std::fprintf(stderr, "[GameDetection]\n  Process: %s (pid %u)\n", p.exe.c_str(), p.pid);
  if (!r.gameName.empty())
    std::fprintf(stderr, "  Candidate: %s\n", r.gameName.c_str());
  std::fprintf(stderr, "  Score: %d\n", r.score);
  for (const auto& reason : r.reasons)
    std::fprintf(stderr, "  - %s %+d (%s)\n", reason.signal.c_str(), reason.delta, reason.note.c_str());
  std::fprintf(stderr, "  Decision: %s\n", decision);
}

} // namespace clipforge
