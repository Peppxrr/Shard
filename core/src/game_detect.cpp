#include "game_detect.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <fstream>
#include <thread>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

namespace clipforge {

using namespace std::chrono;

namespace {

std::string toLower(std::string s)
{
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)std::tolower(c); });
  return s;
}

std::string baseName(const std::string& path)
{
  size_t pos = path.find_last_of("/\\");
  return pos == std::string::npos ? path : path.substr(pos + 1);
}

#ifdef _WIN32
// Resolve the foreground window: executable name, window title/class, pid,
// and whether the window is true fullscreen (rect == monitor rect, ignoring
// regular maximized windows). Returns false on any failure (elevated
// processes we cannot open are reported as unknown, never a crash).
struct ForegroundInfo {
  std::string exe;
  std::string title;
  std::string cls;
  uint32_t pid = 0;
  bool fullscreen = false;
};

ForegroundInfo foregroundWindowInfo()
{
  ForegroundInfo info;
  HWND hwnd = GetForegroundWindow();
  if (!hwnd)
    return info;

  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  info.pid = pid;

  wchar_t titleW[512] = {0};
  if (GetWindowTextW(hwnd, titleW, 512) > 0) {
    int len = WideCharToMultiByte(CP_UTF8, 0, titleW, -1, nullptr, 0, nullptr, nullptr);
    if (len > 1) {
      info.title.assign(len - 1, '\0');
      WideCharToMultiByte(CP_UTF8, 0, titleW, -1, info.title.data(), len, nullptr, nullptr);
    }
  }
  wchar_t clsW[256] = {0};
  if (GetClassNameW(hwnd, clsW, 256) > 0) {
    int len = WideCharToMultiByte(CP_UTF8, 0, clsW, -1, nullptr, 0, nullptr, nullptr);
    if (len > 1) {
      info.cls.assign(len - 1, '\0');
      WideCharToMultiByte(CP_UTF8, 0, clsW, -1, info.cls.data(), len, nullptr, nullptr);
    }
  }

  // Fullscreen check (mirrors game_capture's get_fullscreen_window): window
  // rect covers a monitor exactly, excluding regular maximized windows.
  RECT rect;
  if (GetWindowRect(hwnd, &rect)) {
    DWORD styles = (DWORD)GetWindowLongPtr(hwnd, GWL_STYLE);
    bool maximized = (styles & WS_MAXIMIZE) != 0 && (styles & WS_BORDER) != 0;
    if (!maximized) {
      HMONITOR monitor = MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST);
      MONITORINFO mi = {};
      mi.cbSize = sizeof(mi);
      if (monitor && GetMonitorInfo(monitor, &mi)) {
        info.fullscreen = rect.left == mi.rcMonitor.left && rect.right == mi.rcMonitor.right &&
                          rect.top == mi.rcMonitor.top && rect.bottom == mi.rcMonitor.bottom;
      }
    }
  }

  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc)
    return info;
  wchar_t path[MAX_PATH] = {0};
  DWORD size = MAX_PATH;
  if (QueryFullProcessImageNameW(proc, 0, path, &size))
    info.exe = baseName(std::string(path, path + wcslen(path)));
  CloseHandle(proc);

  info.exe = toLower(info.exe);
  return info;
}

// SetWinEventHook callbacks carry no context pointer; route through a single
// process-wide target (one GameDetect per process).
static std::atomic<GameDetect*> g_hookTarget{nullptr};

void WINAPI foregroundHookImpl(HWINEVENTHOOK /*hook*/, DWORD /*event*/, HWND /*hwnd*/, LONG /*idObject*/,
                               LONG /*idChild*/, DWORD /*eventThread*/, DWORD /*msEventTime*/)
{
  GameDetect* target = g_hookTarget.load();
  if (target)
    target->onHookFired();
}
#endif

} // namespace

GameDetect::GameDetect(Config& config, Events& events, SourceManager& sources, Recorder& recorder)
    : config_(config), events_(events), sources_(sources), recorder_(recorder)
{
}

GameDetect::~GameDetect()
{
  stop();
}

#ifdef _WIN32
#endif

void GameDetect::start()
{
  if (run_.exchange(true))
    return;

  loadGames();
  armHook();

  // Prime current foreground immediately, then poll at 1 s (some games steal
  // and immediately return foreground; the poll catches the settled state).
  checkForeground();
  pollThread_ = std::thread([this] { pollLoop(); });
}

void GameDetect::stop()
{
  if (!run_.exchange(false))
    return;
  if (pollThread_.joinable())
    pollThread_.join();
  disarmHook();
}

void GameDetect::armHook()
{
#ifdef _WIN32
  if (hookHandle_)
    return;
  g_hookTarget.store(this);
  hookHandle_ = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, foregroundHookImpl, 0, 0,
                                WINEVENT_OUTOFCONTEXT);
  // SetWinEventHook can fail silently on some configurations; the 1 s poll
  // fallback keeps detection working regardless.
#endif
}

void GameDetect::disarmHook()
{
#ifdef _WIN32
  if (hookHandle_) {
    UnhookWinEvent((HWINEVENTHOOK)hookHandle_);
    hookHandle_ = nullptr;
  }
  g_hookTarget.store(nullptr);
#endif
}

void GameDetect::pollLoop()
{
  // Poll faster right after a hook event so quick window switches are caught.
  constexpr auto fastInterval = milliseconds(200);
  constexpr auto slowInterval = seconds(1);

  auto next = steady_clock::now() + slowInterval;
  while (run_.load()) {
    checkForeground();

    // Auto-record grace: once the foreground left a known game, stop the
    // recording after graceSeconds.
    if (config_.game.autoRecord && !autoRecording_.load() && recorder_.active()) {
      if (leaveGameAt_ != std::chrono::steady_clock::time_point{}) {
        auto grace = seconds(config_.game.graceSeconds);
        if (steady_clock::now() - leaveGameAt_ >= grace)
          recorder_.stop();
      }
    }

    bool fired = hookFired_.exchange(false);
    auto interval = fired ? fastInterval : slowInterval;
    next = steady_clock::now() + interval;
    std::this_thread::sleep_until(next);
  }
}

void GameDetect::checkForeground()
{
#ifdef _WIN32
  ForegroundInfo fg = foregroundWindowInfo();
  if (fg.exe == currentExe())
    return; // no change

  std::string name;
  bool known = false;
  {
    std::lock_guard<std::mutex> lock(gamesMtx_);
    for (const auto& g : games_) {
      if (g.exe == fg.exe) {
        known = true;
        name = g.name;
        break;
      }
    }
  }

  onForegroundChange(fg.exe, name, known, fg.pid, fg.title, fg.cls, fg.fullscreen);
#endif
}

void GameDetect::onForegroundChange(const std::string& exe, const std::string& name, bool known, uint32_t pid,
                                    const std::string& title, const std::string& cls, bool fullscreen)
{
  {
    std::lock_guard<std::mutex> lock(stateMtx_);
    currentExe_ = exe;
    currentName_ = known ? name : "";
    currentKnown_ = known;
    currentPid_ = pid;
  }

  events_.emit("game.changed", {{"exe", exe}, {"name", known ? nlohmann::json(name) : nlohmann::json(nullptr)},
                                {"pid", pid}, {"known", known}});

  // A new foreground window: drive the capture subject (game window capture
  // vs desktop; debounced switching between open games).
  sources_.onGameForegroundChanged(known, exe, name, pid, title, cls, fullscreen);

  // Auto-record: start when a known game appears; stop after the grace period
  // once foreground moves to a non-game.
  if (config_.game.autoRecord) {
    if (known && !exe.empty()) {
      if (!recorder_.active())
        recorder_.start();
      autoRecording_.store(true);
      leaveGameAt_ = std::chrono::steady_clock::time_point{};
    } else if (autoRecording_.exchange(false)) {
      leaveGameAt_ = steady_clock::now();
    }
  }
}

void GameDetect::reload()
{
  loadGames();
}

void GameDetect::loadGames()
{
  std::lock_guard<std::mutex> lock(gamesMtx_);
  games_.clear();

  if (config_.game.gamesPath.empty())
    return;

  std::ifstream in(config_.game.gamesPath);
  if (!in.is_open())
    return;

  try {
    nlohmann::json j;
    in >> j;
    if (j.is_array()) {
      for (const auto& e : j) {
        if (!e.contains("exe") || !e.contains("name"))
          continue;
        GameEntry g;
        g.exe = toLower(e["exe"].get<std::string>());
        g.name = e["name"].get<std::string>();
        games_.push_back(std::move(g));
      }
    }
  } catch (...) {
    // Corrupt games.json: treat as empty list.
  }
}

void GameDetect::saveGames()
{
  if (config_.game.gamesPath.empty())
    return;

  nlohmann::json j = nlohmann::json::array();
  {
    std::lock_guard<std::mutex> lock(gamesMtx_);
    for (const auto& g : games_)
      j.push_back({{"exe", g.exe}, {"name", g.name}});
  }

  std::ofstream out(config_.game.gamesPath, std::ios::trunc);
  if (out.is_open())
    out << j.dump(2);
}

nlohmann::json GameDetect::listKnown() const
{
  nlohmann::json j = nlohmann::json::array();
  std::lock_guard<std::mutex> lock(gamesMtx_);
  for (const auto& g : games_)
    j.push_back({{"exe", g.exe}, {"name", g.name}});
  return j;
}

bool GameDetect::addKnown(const std::string& exe, const std::string& name)
{
  std::string key = toLower(exe);
  if (key.empty() || name.empty())
    return false;

  {
    std::lock_guard<std::mutex> lock(gamesMtx_);
    for (auto& g : games_) {
      if (g.exe == key) {
        g.name = name;
        saveGames();
        return true;
      }
    }
    games_.push_back({key, name});
  }
  saveGames();
  return true;
}

bool GameDetect::removeKnown(const std::string& exe)
{
  std::string key = toLower(exe);
  bool removed = false;
  {
    std::lock_guard<std::mutex> lock(gamesMtx_);
    auto it = std::remove_if(games_.begin(), games_.end(), [&](const GameEntry& g) { return g.exe == key; });
    removed = it != games_.end();
    games_.erase(it, games_.end());
  }
  if (removed)
    saveGames();
  return removed;
}

} // namespace clipforge
