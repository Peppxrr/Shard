#include "game_system.h"

#include "game_util.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <map>
#include <set>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

namespace clipforge {

namespace fs = std::filesystem;

using namespace std::chrono;

namespace {

constexpr int64_t kDiscoveryIntervalMs = 3600000; // rescan launchers hourly
constexpr int64_t kUnknownPromoteMs = 30000;      // unknown candidate -> registry
constexpr int64_t kCandidateTimeoutMs = 90000;    // stop re-scoring lost causes
constexpr int64_t kReevalIntervalMs = 2000;

int64_t unixNowMs()
{
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

// Human label per launcher type (UI + diagnostics).
const char* launcherLabel(const std::string& type)
{
  static const std::map<std::string, const char*> kLabels = {
      {"steam", "Steam"},
      {"epic", "Epic Games"},
      {"gog", "GOG Galaxy"},
      {"ubisoft", "Ubisoft Connect"},
      {"ea", "EA app"},
      {"battlenet", "Battle.net"},
      {"riot", "Riot"},
      {"msstore", "Microsoft Store / Xbox"},
      {"heroic", "Heroic"},
      {"custom", "Game folders"},
  };
  auto it = kLabels.find(type);
  return it == kLabels.end() ? type.c_str() : it->second;
}

} // namespace

GameSystem::GameSystem(Config& config, Events& events, SourceManager& sources, Recorder& recorder)
    : config_(config), events_(events), sources_(sources), recorder_(recorder), discovery_(registry_)
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

  // Persist launcher toggles from settings (they may have been set before
  // the registry file existed).
  for (const auto& [type, enabled] : config_.game.launcherEnabled) {
    if (registry_.launcherEnabled(type) != enabled)
      registry_.setLauncherEnabled(type, enabled);
  }

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
  for (const auto& [type, enabled] : config_.game.launcherEnabled)
    registry_.setLauncherEnabled(type, enabled);
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
      reEvaluateCandidates();
      unknownGamePromotion();
      probeSessions();
      applyFocusPrimary();
      updateCaptureSubject();

      // Discovery: startup + hourly + explicit refresh.
      if (lastDiscovery_ == steady_clock::time_point{} ||
          steady_clock::now() - lastDiscovery_ >= milliseconds(kDiscoveryIntervalMs)) {
        runDiscoveryScan();
        lastDiscovery_ = steady_clock::now();
      }

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
    // Defer evaluation to the loop tick (cheap: WMI gives us the pid early,
    // the reconcile snapshot completes exe/parent). Uniquely-windowed games
    // are evaluated within 500 ms.
    evaluateProcess(e.info.pid);
  } else {
    std::lock_guard<std::mutex> lock(stateMtx_);
    knownPids_.erase(e.info.pid);
    candidateSince_.erase(e.info.pid);
    unknownSince_.erase(e.info.pid);
    sessions_.onProcessExited(e.info.pid);
  }
}

void GameSystem::evaluateProcess(uint32_t pid)
{
  if (pid == 0)
    return;
  ProcessInfo p = monitor_.lookup(pid);
  if (p.exe.empty() || p.exe == "clipcore.exe")
    return; // snapshot has not run yet; next tick picks it up

  {
    std::lock_guard<std::mutex> lock(stateMtx_);
    if (knownPids_.count(pid))
      return;
  }

  // The monitor resolves path/startMs lazily (one OpenProcess per candidate).
  monitor_.resolve(pid);
  p = monitor_.lookup(pid);

  DetectContext ctx;
  ctx.registry = &registry_;
  ctx.chain = [this](uint32_t id) { return monitor_.ancestors(id); };
  ctx.lookup = [this](uint32_t id) { return monitor_.lookup(id); };
  ctx.nowMs = unixNowMs();

  const WindowProbe probe = probeWindow(pid);
  ctx.window.hasVisibleWindow = probe.hasWindow;
  ctx.window.fullscreen = probe.fullscreen;
  ctx.window.foreground = probe.foreground;

  DetectionResult r = GameDetector::detect(p, ctx);
  logDetection(p, r);

  if (r.decision == DetectionResult::Decision::Detected) {
    {
      std::lock_guard<std::mutex> lock(stateMtx_);
      knownPids_[pid] = r.gameId;
      candidateSince_.erase(pid);
      unknownSince_.erase(pid);
      unknownPromoted_.erase(pid);
    }
    sessions_.onDetected(r, p);
  } else if (r.decision == DetectionResult::Decision::Candidate) {
    std::lock_guard<std::mutex> lock(stateMtx_);
    candidateSince_.try_emplace(pid, unixNowMs());
  } else {
    // Hard-ignored (known non-game / user ignore) or too weak. Only
    // unknown-shaped processes — NOT known non-games or user-ignored exes —
    // with launcher/install evidence enter the promotion watchlist.
    if (!GameDetector::isKnownNonGameExe(p.exe) && !registry_.isIgnoredExe(p.exe) &&
        (hasLauncherAncestry(pid) || pathUnderDiscoveredInstall(p.path))) {
      std::lock_guard<std::mutex> lock(stateMtx_);
      unknownSince_.try_emplace(pid, unixNowMs());
    }
  }
}

void GameSystem::reEvaluateCandidates()
{
  std::vector<uint32_t> toCheck;
  {
    std::lock_guard<std::mutex> lock(stateMtx_);
    const int64_t now = unixNowMs();
    for (auto it = candidateSince_.begin(); it != candidateSince_.end();) {
      if (now - it->second >= kReevalIntervalMs)
        toCheck.push_back(it->first);
      if (now - it->second >= kCandidateTimeoutMs) {
        it = candidateSince_.erase(it);
        continue;
      }
      ++it;
    }
  }
  for (uint32_t pid : toCheck)
    if (monitor_.alive(pid))
      evaluateProcess(pid);
}

bool GameSystem::hasLauncherAncestry(uint32_t pid) const
{
  const auto chain = monitor_.ancestors(pid);
  for (size_t i = 1; i < chain.size(); i++) {
    const ProcessInfo anc = monitor_.lookup(chain[i]);
    if (!GameDetector::launcherTypeOfExe(anc.exe).empty())
      return true;
  }
  return false;
}

bool GameSystem::pathUnderDiscoveredInstall(const std::string& lowerPath) const
{
  if (lowerPath.empty())
    return false;
  for (const auto& g : registry_.discoveredGames())
    for (const auto& ip : g.installPaths)
      if (pathUnder(lowerPath, ip))
        return true;
  return false;
}

// Unknown game workflow (Todo #11): a process with strong launcher/install
// evidence but no registry entry becomes a discovered game after it survives
// kUnknownPromoteMs — enough evidence, no junk.
void GameSystem::unknownGamePromotion()
{
  std::vector<std::pair<uint32_t, int64_t>> ready;
  {
    std::lock_guard<std::mutex> lock(stateMtx_);
    const int64_t now = unixNowMs();
    for (auto it = unknownSince_.begin(); it != unknownSince_.end();) {
      if (unknownPromoted_.count(it->first)) {
        it = unknownSince_.erase(it);
        continue;
      }
      if (now - it->second >= kUnknownPromoteMs)
        ready.push_back(*it);
      ++it;
    }
  }
  for (const auto& [pid, _] : ready) {
    if (!monitor_.alive(pid))
      continue;
    ProcessInfo p = monitor_.lookup(pid);
    monitor_.resolve(pid);
    p = monitor_.lookup(pid);
    if (p.exe.empty() || GameDetector::isKnownNonGameExe(p.exe) || registry_.isIgnoredExe(p.exe))
      continue;

    // Determine the launcher type from ancestry (or WindowsApps path).
    std::string launcherType;
    for (uint32_t anc : monitor_.ancestors(pid)) {
      const ProcessInfo a = monitor_.lookup(anc);
      const std::string t = GameDetector::launcherTypeOfExe(a.exe);
      if (!t.empty()) {
        launcherType = t;
        break;
      }
    }
    if (launcherType.empty() && p.path.find("\\windowsapps\\") != std::string::npos)
      launcherType = "msstore";
    if (launcherType.empty())
      continue; // not enough evidence: never auto-classify
    // MS Store bloat (Xbox/Store apps) must never promote: require a visible
    // window, and let the known-non-game list keep filtering the rest.
    if (launcherType == "msstore" && !probeWindow(pid).hasWindow)
      continue;

    GameDefinition g;
    g.name = baseName(p.exe);
    g.name = g.name.substr(0, g.name.size() - 4); // strip .exe
    g.executables = {p.exe};
    if (!p.path.empty())
      g.installPaths = {normalizePath(p.path.substr(0, p.path.find_last_of('\\')))};
    g.launchers = {{launcherType, p.exe}};
    g.source = GameSource::Discovered;
    registry_.mergeDiscovered(g);
    std::lock_guard<std::mutex> lock(stateMtx_);
    unknownPromoted_.insert(pid);
    unknownSince_.erase(pid);
    if (registry_.verboseLogging())
      std::fprintf(stderr,
                   "[GameDetection] unknown process %s (%u) promoted to discovered game \"%s\" via %s\n",
                   p.exe.c_str(), pid, g.name.c_str(), launcherType.c_str());
    // Re-evaluate immediately — the new entry gives it an exe match.
    evaluateProcess(pid);
  }
}

void GameSystem::probeSessions()
{
  const GameSession prim = sessions_.primary();
  if (prim.pid == 0)
    return;
  // Emulator/multi-window games: the probe prefers the fullscreen window or
  // the window whose title contains the game name — i.e. the actual game
  // window, not the emulator GUI.
  const WindowProbe probe = probeWindow(prim.pid, prim.gameName);
  sessions_.updateWindow(prim.pid, probe.title, probe.cls, probe.fullscreen, probe.hasWindow);

  // Re-run the detector on the active process so score changes (sustained
  // runtime, window facts, new launcher evidence) refresh the session metadata
  // without ever restarting it. One process per tick — negligible cost.
  if (!monitor_.alive(prim.pid))
    return;
  ProcessInfo p = monitor_.lookup(prim.pid);
  if (p.exe.empty())
    return;
  sessions_.updateProcess(prim.pid, p.exe, p.path);
  DetectContext ctx;
  ctx.registry = &registry_;
  ctx.chain = [this](uint32_t id) { return monitor_.ancestors(id); };
  ctx.lookup = [this](uint32_t id) { return monitor_.lookup(id); };
  ctx.nowMs = unixNowMs();
  ctx.window.hasVisibleWindow = probe.hasWindow;
  ctx.window.fullscreen = probe.fullscreen;
  ctx.window.foreground = probe.foreground;
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
          w.area = (long)(rect.right - rect.left) * (long)(rect.bottom - rect.top);
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
  out.fullscreen = best->fullscreen;
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
void GameSystem::applyFocusPrimary()
{
  const GameSession* fgSession = sessions_.sessionForPid(foregroundPid());
  const std::string target = fgSession ? fgSession->gameId : std::string();
  {
    std::lock_guard<std::mutex> lock(stateMtx_);
    if (target != focusGameId_) {
      focusGameId_ = target;
      focusSinceMs_ = target.empty() ? 0 : unixNowMs();
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
    if (prim.gameId != focusGameId_)
      sessions_.setPrimaryByGameId(focusGameId_);
  }
}

void GameSystem::updateCaptureSubject()
{
  const GameSession prim = sessions_.primary();
  const bool hasSubject = prim.pid != 0 && !prim.exe.empty();

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
  // Custom game folders + Heroic config dir feed the providers.
  ScanContext ctx = LauncherDiscovery::defaults();
  for (const auto& f : registry_.customFolders())
    ctx.customFolders.push_back({f.id, f.name, f.path, f.emulator});
  discovery_.setContext(ctx);
  const auto results = discovery_.scanAll();
  lastScanResults_ = results;
  lastScanAtMs_ = unixNowMs();

  // Self-heal: drop discovered entries whose executables are ALL known
  // non-games or user-ignored (leftovers from scans before the filters
  // existed, or entries the user has since ignored). The detector ignores
  // them anyway; this keeps the registry clean.
  for (const auto& g : registry_.discoveredGames()) {
    bool allNoise = !g.executables.empty();
    for (const auto& exe : g.executables) {
      if (!GameDetector::isKnownNonGameExe(exe) && !registry_.isIgnoredExe(exe)) {
        allNoise = false;
        break;
      }
    }
    if (allNoise)
      registry_.removeDiscoveredGame(g.id);
  }

  if (registry_.verboseLogging()) {
    for (const auto& r : results)
      std::fprintf(stderr, "[GameDetection] discovery %s: %d game(s)\n", r.type.c_str(), r.games);
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

nlohmann::json GameSystem::listCustomFolders() const
{
  nlohmann::json arr = nlohmann::json::array();
  for (const auto& f : registry_.customFolders())
    arr.push_back(f.toJson());
  return arr;
}

nlohmann::json GameSystem::addCustomFolder(const nlohmann::json& params)
{
  CustomFolder f;
  f.name = params.value("name", std::string());
  f.path = params.value("path", std::string());
  f.emulator = params.value("emulator", false);
  const std::string id = registry_.addCustomFolder(f);
  return {{"id", id}, {"ok", !id.empty()}};
}

bool GameSystem::removeCustomFolder(const std::string& id)
{
  return registry_.removeCustomFolder(id);
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

nlohmann::json GameSystem::listLaunchers() const
{
  nlohmann::json arr = nlohmann::json::array();
  const ScanContext ctx = LauncherDiscovery::defaults();
  for (const auto& [type, enabled] : registry_.launcherEnabledMap()) {
    bool installed = false;
    if (type == "steam")
      installed = !ctx.steamLibraryFile.empty() && fs::exists(ctx.steamLibraryFile);
    else if (type == "epic")
      installed = !ctx.epicManifestsDir.empty() && fs::is_directory(ctx.epicManifestsDir);
    else if (type == "riot")
      installed = !ctx.riotInstallsFile.empty() && fs::exists(ctx.riotInstallsFile);
    else if (type == "heroic")
      installed = !ctx.heroicConfigDir.empty() &&
                  fs::is_directory(fs::path(ctx.heroicConfigDir) / "games_config");
    else if (type == "custom")
      installed = true; // user-defined folders always available
    else if (type == "msstore")
      installed = ctx.listRegistryKeys && !ctx.listRegistryKeys("HKCU", ctx.msStorePackagesKey).empty();
    else if (ctx.listRegistryKeys) {
      // Registry-based launchers: the platform key exists.
      const std::string base = type == "gog" ? "SOFTWARE\\WOW6432Node\\GOG.com\\Games"
                               : type == "ubisoft" ? "SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs"
                               : type == "ea" ? "SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Core\\Installed Games"
                               : type == "battlenet" ? "SOFTWARE\\WOW6432Node\\Blizzard Entertainment"
                                                     : std::string();
      if (!base.empty())
        installed = !ctx.listRegistryKeys("HKLM", base).empty();
    }

    int gameCount = 0;
    int64_t lastScanMs = 0;
    for (const auto& r : lastScanResults_)
      if (r.type == type) {
        gameCount = r.games;
        lastScanMs = r.lastScanMs;
      }
    nlohmann::json j = {{"type", type},
                        {"label", launcherLabel(type)},
                        {"enabled", enabled},
                        {"installed", installed},
                        {"lastScanMs", lastScanMs == 0 ? nlohmann::json(nullptr) : nlohmann::json(lastScanMs)},
                        {"gameCount", gameCount}};
    arr.push_back(std::move(j));
  }
  return arr;
}

bool GameSystem::setLauncherEnabled(const std::string& type, bool enabled)
{
  registry_.setLauncherEnabled(type, enabled);
  return true;
}

nlohmann::json GameSystem::refreshDiscovery()
{
  runDiscoveryScan();
  return listLaunchers();
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
  DetectContext ctx;
  ctx.registry = &registry_;
  ctx.chain = [this](uint32_t id) { return monitor_.ancestors(id); };
  ctx.lookup = [this](uint32_t id) { return monitor_.lookup(id); };
  ctx.nowMs = unixNowMs();
  ctx.window.hasVisibleWindow = probe.hasWindow;
  ctx.window.fullscreen = probe.fullscreen;
  ctx.window.foreground = probe.foreground;
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
