#include "sources.h"
#include "capture_resilience.h"

#include <obs-module.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
// Callback-mode display and suspend/resume notifications. No message window
// is required, so recovery remains active in this headless core process.
#include <powersetting.h>
#include <powrprof.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#endif

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <iomanip>
#include <iterator>
#include <set>
#include <sstream>

namespace shard {

namespace {

// UTF-16 (WASAPI device ids) -> UTF-8.
std::string utf8FromWide(const wchar_t* w)
{
  if (!w)
    return {};
#ifdef _WIN32
  int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (len <= 1)
    return {};
  std::string out(len - 1, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), len, nullptr, nullptr);
  return out;
#else
  return {};
#endif
}

// OBS window_capture descriptor escaping: ':' and '#' must be encoded
// (see ms_build_window_strings in libobs/util/windows/window-helpers.c).
std::string encodeWindowPart(const std::string& s)
{
  std::string out;
  out.reserve(s.size());
  for (char c : s) {
    if (c == '#')
      out += "#22";
    else if (c == ':')
      out += "#3A";
    else
      out += c;
  }
  return out;
}

// Both modern OBS 32.2.1 capture sources expose this boolean and pass it
// to libobs-winrt, which selects BGRA8 before allocating the WGC frame pool.
// Shard outputs Rec.709 SDR, including when Windows displays HDR content.
void setWgcSdrSettings(obs_data_t* settings)
{
  obs_data_set_bool(settings, "force_sdr", true);
}

HMONITOR monitorHandle(int index)
{
  struct Context { int index; int current = 0; HMONITOR monitor = nullptr; } context{index};
  EnumDisplayMonitors(nullptr, nullptr,
      [](HMONITOR monitor, HDC, LPRECT, LPARAM param) -> BOOL {
        auto& state = *reinterpret_cast<Context*>(param);
        if (state.current++ != state.index) return TRUE;
        state.monitor = monitor;
        return FALSE;
      }, reinterpret_cast<LPARAM>(&context));
  return context.monitor;
}

CaptureDisplayState queryCaptureDisplay(HMONITOR monitor)
{
  CaptureDisplayState result;
  result.monitor = reinterpret_cast<uintptr_t>(monitor);
  MONITORINFOEXW info = {};
  info.cbSize = sizeof(info);
  if (!monitor || !GetMonitorInfoW(monitor, &info)) return result;
  result.name = utf8FromWide(info.szDevice);

  // Map the selected GDI display to an active DisplayConfig target. Query
  // failures remain unknown, rather than silently claiming SDR. Topology can
  // change between sizing and querying; retry that race a bounded three times.
  for (int attempt = 0; attempt < 3; ++attempt) {
    UINT32 pathCount = 0, modeCount = 0;
    if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &pathCount, &modeCount) != ERROR_SUCCESS) break;
    std::vector<DISPLAYCONFIG_PATH_INFO> paths(pathCount);
    std::vector<DISPLAYCONFIG_MODE_INFO> modes(modeCount);
    const LONG status = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &pathCount, paths.data(),
                                           &modeCount, modes.data(), nullptr);
    if (status == ERROR_INSUFFICIENT_BUFFER) continue;
    if (status != ERROR_SUCCESS) break;
    for (UINT32 i = 0; i < pathCount; ++i) {
      const auto& path = paths[i];
      DISPLAYCONFIG_SOURCE_DEVICE_NAME source = {};
      source.header = {DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, sizeof(source),
                       path.sourceInfo.adapterId, path.sourceInfo.id};
      if (DisplayConfigGetDeviceInfo(&source.header) != ERROR_SUCCESS ||
          wcscmp(source.viewGdiDeviceName, info.szDevice) != 0) continue;
      DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO color = {};
      color.header = {DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO, sizeof(color),
                      path.targetInfo.adapterId, path.targetInfo.id};
      if (DisplayConfigGetDeviceInfo(&color.header) == ERROR_SUCCESS)
        result.advancedColor = color.advancedColorEnabled != 0;
#if NTDDI_VERSION >= NTDDI_WIN11_GA
      // On newer Windows, ACM/WCG and HDR are distinct advanced-color modes.
      DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO_2 color2 = {};
      color2.header = {DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO_2, sizeof(color2),
                       path.targetInfo.adapterId, path.targetInfo.id};
      if (DisplayConfigGetDeviceInfo(&color2.header) == ERROR_SUCCESS) {
        result.advancedColor = color2.advancedColorActive != 0;
        result.hdr = color2.activeColorMode == DISPLAYCONFIG_ADVANCED_COLOR_MODE_HDR;
      }
#endif
      break;
    }
    break;
  }
  // Older Windows lacks the separate HDR state API. Use the OS-reported
  // active DXGI output color space, not luminance, bit depth or probe pixels.
  if (!result.hdr.has_value()) {
    using Microsoft::WRL::ComPtr;
    ComPtr<IDXGIFactory1> factory;
    if (SUCCEEDED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
      for (UINT i = 0; !result.hdr.has_value(); ++i) {
        ComPtr<IDXGIAdapter1> adapter;
        if (factory->EnumAdapters1(i, &adapter) != S_OK) break;
        for (UINT j = 0; ; ++j) {
          ComPtr<IDXGIOutput> output;
          if (adapter->EnumOutputs(j, &output) != S_OK) break;
          DXGI_OUTPUT_DESC desc = {};
          if (FAILED(output->GetDesc(&desc)) || desc.Monitor != monitor) continue;
          ComPtr<IDXGIOutput6> output6;
          DXGI_OUTPUT_DESC1 desc1 = {};
          if (SUCCEEDED(output.As(&output6)) && SUCCEEDED(output6->GetDesc1(&desc1)))
            result.hdr = desc1.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
          break;
        }
      }
    }
  }
  return result;
}

// The WGC monitor capture ("monitor_capture" → duplicator-monitor-capture)
// targets a monitor by its device-interface id string ("monitor_id"), while
// the config stores a monitor *index* (EnumDisplayMonitors order). Resolve
// the index to the id; returns "" when the index is out of range.
std::string monitorDeviceId(int index)
{
  struct Ctx {
    int index;
    int cur = 0;
    char id[256] = {0};
  } ctx;
  ctx.index = index;
  EnumDisplayMonitors(
      nullptr, nullptr,
      [](HMONITOR hmon, HDC /*hdc*/, LPRECT /*rect*/, LPARAM lp) -> BOOL {
        Ctx* c = reinterpret_cast<Ctx*>(lp);
        if (c->cur++ != c->index)
          return TRUE;
        MONITORINFOEXA mi = {};
        mi.cbSize = sizeof(mi);
        if (GetMonitorInfoA(hmon, &mi)) {
          DISPLAY_DEVICEA dev = {};
          dev.cb = sizeof(dev);
          if (EnumDisplayDevicesA(mi.szDevice, 0, &dev, EDD_GET_DEVICE_INTERFACE_NAME))
            strncpy(c->id, dev.DeviceID, sizeof(c->id) - 1);
        }
        return FALSE; // found the target monitor; stop
      },
      reinterpret_cast<LPARAM>(&ctx));
  return ctx.id;
}

#ifdef _WIN32
HWND findSubjectWindow(const SourceManager::Subject& subject)
{
  struct Candidate {
    const SourceManager::Subject* subject;
    HWND window = nullptr;
    int score = -1;
    long area = -1;
  } candidate{&subject};

  EnumWindows(
      [](HWND window, LPARAM param) -> BOOL {
        Candidate* best = reinterpret_cast<Candidate*>(param);
        DWORD pid = 0;
        GetWindowThreadProcessId(window, &pid);
        if (pid != best->subject->pid || !IsWindowVisible(window))
          return TRUE;

        wchar_t titleW[512] = {};
        wchar_t classW[256] = {};
        GetWindowTextW(window, titleW, static_cast<int>(std::size(titleW)));
        GetClassNameW(window, classW, static_cast<int>(std::size(classW)));
        const std::string title = utf8FromWide(titleW);
        const std::string cls = utf8FromWide(classW);
        int score = 0;
        if (!best->subject->cls.empty() && cls == best->subject->cls)
          score += 2;
        if (!best->subject->title.empty() && title == best->subject->title)
          score += 1;

        RECT rect = {};
        long area = 0;
        if (GetWindowRect(window, &rect))
          area = (rect.right - rect.left) * (rect.bottom - rect.top);
        if (score > best->score || (score == best->score && area > best->area)) {
          best->window = window;
          best->score = score;
          best->area = area;
        }
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&candidate));

  return candidate.window;
}

// OBS exposes metadata read from its actual wc->window through get_hooked,
// but no numeric HWND. Resolve that metadata uniquely within the target PID.
// Ambiguous/missing matches stay unknown rather than reporting another window's
// monitor. Before OBS acquires a target, use Shard's resolved target HWND.
std::optional<uintptr_t> acquiredWgcWindow(obs_source_t* source, uint32_t pid)
{
  if (!source) return std::nullopt;
  calldata_t data = {};
  const bool acquired = proc_handler_call(obs_source_get_proc_handler(source), "get_hooked", &data) &&
                        calldata_bool(&data, "hooked");
  if (!acquired) { calldata_free(&data); return std::nullopt; }
  struct Context {
    uint32_t pid;
    std::string title;
    std::string cls;
    HWND window = nullptr;
    int matches = 0;
  } context{pid, calldata_string(&data, "title"), calldata_string(&data, "class")};
  calldata_free(&data);
  EnumWindows([](HWND window, LPARAM param) -> BOOL {
    auto& state = *reinterpret_cast<Context*>(param);
    DWORD windowPid = 0;
    GetWindowThreadProcessId(window, &windowPid);
    if (windowPid != state.pid || !IsWindowVisible(window)) return TRUE;
    wchar_t title[512] = {}, cls[256] = {};
    GetWindowTextW(window, title, static_cast<int>(std::size(title)));
    GetClassNameW(window, cls, static_cast<int>(std::size(cls)));
    if (utf8FromWide(title) == state.title && utf8FromWide(cls) == state.cls) {
      state.window = window;
      ++state.matches;
    }
    return TRUE;
  }, reinterpret_cast<LPARAM>(&context));
  return context.matches == 1 ? reinterpret_cast<uintptr_t>(context.window) : uintptr_t{0};
}
#endif

bool subjectWindowMinimized(const SourceManager::Subject& subject)
{
#ifdef _WIN32
  const HWND window = findSubjectWindow(subject);
  return window && IsIconic(window);
#else
  (void)subject;
  return false;
#endif
}

#ifdef _WIN32
ULONG CALLBACK capturePowerCallback(PVOID context, ULONG type, PVOID setting)
{
  auto* state = static_cast<CaptureRecoveryState*>(context);
  if (!state)
    return ERROR_SUCCESS;

  if (type == PBT_APMRESUMEAUTOMATIC || type == PBT_APMRESUMECRITICAL || type == PBT_APMRESUMESUSPEND) {
    state->onResume();
  } else if (type == PBT_POWERSETTINGCHANGE && setting) {
    const auto* change = static_cast<const POWERBROADCAST_SETTING*>(setting);
    if (IsEqualGUID(change->PowerSetting, GUID_CONSOLE_DISPLAY_STATE) && change->DataLength >= sizeof(DWORD)) {
      DWORD displayState = 0;
      std::memcpy(&displayState, change->Data, sizeof(displayState));
      state->onDisplayState(static_cast<int>(displayState));
    }
  }
  return ERROR_SUCCESS;
}
#endif

} // namespace

SourceManager::SourceManager(App& app, Config& config, Events& events)
    : app_(app), config_(config), events_(events)
{
}

SourceManager::~SourceManager()
{
  stopWatchdog();
  removeVideoSourceItem();
  audioIsolation_.stop();
  for (size_t i = 0; i < audioSources_.size(); i++) {
    if (audioItems_[i]) {
      obs_sceneitem_remove(audioItems_[i]);
    }
    if (audioSources_[i])
      obs_source_release(audioSources_[i]);
  }
  audioSources_.clear();
  audioItems_.clear();
}

// ---------------------------------------------------------------- video ----

void SourceManager::removeVideoSourceItem()
{
  // obs_scene_add returns borrowed items. remove releases the scene's item
  // reference; an additional release would access an already freed item.
  resetFrameProbeLocked();
  if (monitorItem_) {
    obs_sceneitem_remove(monitorItem_);
    monitorItem_ = nullptr;
  }
  if (monitorSource_) {
    obs_source_release(monitorSource_);
    monitorSource_ = nullptr;
  }
  if (gameItem_) {
    obs_sceneitem_remove(gameItem_);
    gameItem_ = nullptr;
  }
  if (gameSource_) {
    obs_source_release(gameSource_);
    gameSource_ = nullptr;
  }
  if (windowItem_) {
    obs_sceneitem_remove(windowItem_);
    windowItem_ = nullptr;
  }
  if (windowSource_) {
    obs_source_release(windowSource_);
    windowSource_ = nullptr;
  }
  windowClientSize_ = {};
}

void SourceManager::releaseAll()
{
  std::lock_guard<std::mutex> lock(sourceMutex_);
  removeVideoSourceItem();
  audioIsolation_.stop();

  for (size_t i = 0; i < audioSources_.size(); i++) {
    if (audioItems_[i]) {
      obs_sceneitem_remove(audioItems_[i]);
    }
    if (audioSources_[i])
      obs_source_release(audioSources_[i]);
  }
  audioSources_.clear();
  audioItems_.clear();
}

void SourceManager::applyVideoSource()
{
  std::lock_guard<std::mutex> lock(sourceMutex_);
  healthRecovery_.resetEvidence();
  videoRecoveryRequested_ = false;
  applyVideoSourceLocked();
}

void SourceManager::applyVideoSourceLocked()
{
  removeVideoSourceItem();

  // Desktop: WGC monitor capture of the configured monitor. With graphics
  // initialized before module load, "monitor_capture" is the WGC duplicator,
  // which targets monitors by device-id string ("monitor_id"); the legacy
  // BitBlt implementation used the "monitor" index. Set both.
  {
    obs_data_t* s = obs_data_create();
    const std::string devId = monitorDeviceId(config_.capture.monitor);
    if (!devId.empty())
      obs_data_set_string(s, "monitor_id", devId.c_str());
    obs_data_set_int(s, "monitor", config_.capture.monitor);
    obs_data_set_int(s, "method", 2); // METHOD_WGC
    obs_data_set_bool(s, "capture_cursor", true);
    setWgcSdrSettings(s);
    monitorSource_ = obs_source_create("monitor_capture", "monitor-capture", s, nullptr);
    obs_data_release(s);
  }
  // The hook is preferred while healthy. Keep WGC running underneath so it
  // can take over without waiting for a new capture session.
  createGameCaptureLocked();
  createWindowCaptureLocked();

  if (monitorSource_)
    monitorItem_ = obs_scene_add(app_.scene(), monitorSource_);
  // Scene rendering is bottom-to-top: WGC window_capture is the fallback
  // below the injected hook. Hook-primary means the game hook sits on top;
  // when it produces frames it covers the fallback, otherwise the fallback's
  // WGC frames show. The watchdog promotes WGC above an opaque broken hook;
  // both sources stay active so the hook can recover in the background.
  if (windowSource_)
    windowItem_ = obs_scene_add(app_.scene(), windowSource_);
  if (gameSource_)
    gameItem_ = obs_scene_add(app_.scene(), gameSource_);

  if (!monitorSource_ && !windowSource_ && !gameSource_) {
    events_.emit("error", {{"code", "CAPTURE_INIT_FAILED"}, {"message", "Could not create capture sources"}});
    return;
  }

  const auto now = std::chrono::steady_clock::now();
  captureHealthyAt_ = now;
  lastWindowRetry_ = now;
  lastHookRetry_ = now;
  hookRetryCount_ = 0;
  wgcRetryCount_ = 0;
  lastHookAction_ = "none";
  lastHookActionMs_ = 0;
  lastWindowAction_ = "none";
  lastWindowActionMs_ = 0;
  windowNoFramesReported_ = false;
  windowSuppressedForMinimize_ = false;
  activeBackend_ = ActiveBackend::None;

  // Re-evaluate the subject for the current mode. GameSystem's primary game
  // survives screen-mode periods, so returning to auto/game resumes it.
  const std::string mode = config_.capture.mode;
  if (mode == "screen") {
    subject_ = Subject{Subject::Kind::Monitor, "", "", "", "Desktop", 0};
  } else if (requestedGame_.kind == Subject::Kind::Window && pidAlive(requestedGame_.pid)) {
    if (subject_.pid != requestedGame_.pid) targetWindow_ = 0;
    subject_ = requestedGame_;
  } else if (mode == "auto") {
    subject_ = Subject{Subject::Kind::Monitor, "", "", "", "Desktop", 0};
  } else {
    subject_ = Subject{};
  }
  applySubjectLocked();
  emitSubjectChanged();
}

void SourceManager::createWindowCaptureLocked()
{
  obs_data_t* s = obs_data_create();
  obs_data_set_int(s, "method", 2);
  setWgcSdrSettings(s);
  obs_data_set_int(s, "priority", 2);
  obs_data_set_bool(s, "cursor", true);
  // Keep WGC's complete surface alive. The scene item is cropped to the
  // Win32 client rect only when that geometry is valid; failed geometry
  // therefore falls back to a live full-window frame instead of black.
  obs_data_set_bool(s, "client_area", false);
  obs_data_set_string(s, "window", "::");
  windowSource_ = obs_source_create("window_capture", "game-window", s, nullptr);
  obs_data_release(s);
}

bool SourceManager::pidAlive(uint32_t pid)
{
  if (pid == 0)
    return false;
#ifdef _WIN32
  // A handle can outlive the process (OBS holds one to a hooked target), so
  // check the exit state. Protected processes may refuse even limited query
  // access while running; only a missing PID is treated as exited.
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h)
    return GetLastError() == ERROR_ACCESS_DENIED;
  DWORD exitCode = 0;
  const bool alive = GetExitCodeProcess(h, &exitCode) && exitCode == STILL_ACTIVE;
  CloseHandle(h);
  return alive;
#else
  return false;
#endif
}

CaptureSize SourceManager::captureSize() const
{
  std::lock_guard<std::mutex> lock(sourceMutex_);
  obs_source_t* source = nullptr;
  obs_sceneitem_t* item = nullptr;
  if (subject_.kind == Subject::Kind::Monitor) {
    source = monitorSource_;
  } else if (subject_.kind == Subject::Kind::Window) {
    if (activeBackend_ == ActiveBackend::Hook) source = gameSource_;
    else if (!subjectWindowMinimized(subject_)) { source = windowSource_; item = windowItem_; }
  }
  if (!source) return {};
  const uint32_t width = obs_source_get_width(source), height = obs_source_get_height(source);
  if (item && width && height && windowClientSize_.valid()) return windowClientSize_;
  obs_sceneitem_crop crop = {};
  if (item) obs_sceneitem_get_crop(item, &crop);
  const uint32_t horizontal = crop.left + crop.right, vertical = crop.top + crop.bottom;
  return width > horizontal && height > vertical ? CaptureSize{width - horizontal, height - vertical} : CaptureSize{};
}

bool SourceManager::resizeCanvas(CaptureSize size)
{
  std::lock_guard<std::mutex> lock(sourceMutex_);
  const CaptureSize previous{app_.baseWidth(), app_.baseHeight()};
  if (!app_.resetVideo(size.width, size.height)) {
    // Keep an encoder-rejected size from leaving the video mix unavailable.
    app_.resetVideo(previous.width, previous.height);
    return false;
  }
  fillFrame(monitorItem_);
  fillFrame(gameItem_);
  fillWindowFrameLocked();
  return true;
}

void SourceManager::refreshTargetWindowLocked()
{
#ifdef _WIN32
  const HWND window = findSubjectWindow(subject_);
  if (!window || IsIconic(window)) return;
  const uintptr_t identity = reinterpret_cast<uintptr_t>(window);
  if (identity == targetWindow_) return;
  const bool replaced = targetWindow_ != 0;
  targetWindow_ = identity;
  if (!replaced) return;
  // Launchers/splash screens can replace the HWND without changing PID,
  // title or class. The old hook texture can remain acquired indefinitely.
  wchar_t title[512] = {}, cls[256] = {};
  GetWindowTextW(window, title, static_cast<int>(std::size(title)));
  GetClassNameW(window, cls, static_cast<int>(std::size(cls)));
  subject_.title = utf8FromWide(title);
  subject_.cls = utf8FromWide(cls);
  logRecoveryLocked("target_window_replaced", "recreate_game_and_wgc", 2, duration_ms_now());
  healthRecovery_.resetEvidence();
  resetFrameProbeLocked();
  recreateGameCaptureLocked();
  recreateWindowCaptureLocked();
  setWindowTargetLocked(subject_);
  std::fprintf(stderr, "capture: game window replaced for pid=%lu; reacquiring capture\n",
               static_cast<unsigned long>(subject_.pid));
#endif
}

void SourceManager::refreshCaptureDisplayLocked(uint64_t nowMs)
{
#ifdef _WIN32
  if (subject_.kind == Subject::Kind::None) {
    captureDisplay_ = {};
    captureDisplayWindow_ = 0;
    lastDisplayQueryMs_ = 0;
    return;
  }
  captureDisplayWindow_ = subject_.kind == Subject::Kind::Window
      ? acquiredWgcWindow(windowSource_, subject_.pid).value_or(targetWindow_) : 0;
  const uintptr_t monitor = selectCaptureMonitor(subject_.kind == Subject::Kind::Window,
      captureDisplayWindow_, config_.capture.monitor,
      [](uintptr_t hwnd) {
        const HWND window = reinterpret_cast<HWND>(hwnd);
        return IsWindow(window) ? reinterpret_cast<uintptr_t>(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST)) : 0;
      },
      [](int index) { return reinterpret_cast<uintptr_t>(monitorHandle(index)); });
  if (monitor == captureDisplay_.monitor && lastDisplayQueryMs_ && nowMs - lastDisplayQueryMs_ < 5000) return;
  captureDisplay_ = queryCaptureDisplay(reinterpret_cast<HMONITOR>(monitor));
  lastDisplayQueryMs_ = nowMs;
  // Always-forced SDR means moving displays or toggling HDR doesn't change
  // WGC's BGRA8 format. OBS follows the window; do not reset any source/output.
#endif
}

std::string SourceManager::colorDiagnosticsLocked() const
{
  const auto state = [](std::optional<bool> value) { return value ? (*value ? "true" : "false") : "unknown"; };
  obs_source_t* source = subject_.kind == Subject::Kind::Monitor ? monitorSource_ :
      subject_.kind == Subject::Kind::Window ? windowSource_ : nullptr;
  obs_data_t* settings = source ? obs_source_get_settings(source) : nullptr;
  const bool forceSdr = settings && obs_data_get_bool(settings, "force_sdr");
  if (settings) obs_data_release(settings);
  std::ostringstream line;
  line << " target_monitor_hwnd=0x" << std::hex << captureDisplayWindow_ << std::dec
       << " target_monitor=" << captureDisplay_.name
       << " target_monitor_hdr=" << state(captureDisplay_.hdr)
       << " target_monitor_advanced_color=" << state(captureDisplay_.advancedColor)
       << " wgc_force_sdr=" << (forceSdr ? "true" : "false")
       << " output_color_space=Rec709/SDR";
  return line.str();
}

void SourceManager::applySubjectLocked()
{
  const bool showMonitor = subject_.kind == Subject::Kind::Monitor;
  const bool showGame = subject_.kind == Subject::Kind::Window;
  if (showGame) {
    setWindowTargetLocked(subject_);
#ifdef _WIN32
    targetWindow_ = reinterpret_cast<uintptr_t>(findSubjectWindow(subject_));
#endif
  }
  lastDisplayQueryMs_ = 0;
  refreshCaptureDisplayLocked(duration_ms_now());
  if (monitorItem_) {
    obs_sceneitem_set_visible(monitorItem_, showMonitor);
    fillFrame(monitorItem_);
  }
  if (gameItem_) {
    obs_sceneitem_set_visible(gameItem_, showGame);
    fillFrame(gameItem_);
  }
  if (windowItem_) {
    obs_sceneitem_set_visible(windowItem_, showGame);
    fillWindowFrameLocked();
  }
}

// Fit a capture to the canvas without cropping its visible content. Window
// fallback capture passes a validated scene crop that removes only the
// non-client frame.
void SourceManager::fillFrame(obs_sceneitem_t* item, const struct obs_sceneitem_crop* crop)
{
  if (!item)
    return;

  struct obs_sceneitem_crop appliedCrop = {};
  if (crop)
    appliedCrop = *crop;

  obs_source_t* source = obs_sceneitem_get_source(item);
  const uint32_t sourceWidth = source ? obs_source_get_width(source) : 0;
  const uint32_t sourceHeight = source ? obs_source_get_height(source) : 0;
  const int horizontalCrop = appliedCrop.left + appliedCrop.right;
  const int verticalCrop = appliedCrop.top + appliedCrop.bottom;
  if (horizontalCrop < 0 || verticalCrop < 0 || static_cast<uint32_t>(horizontalCrop) >= sourceWidth ||
      static_cast<uint32_t>(verticalCrop) >= sourceHeight) {
    appliedCrop = {};
  }
  obs_sceneitem_set_crop(item, &appliedCrop);

  if (sourceWidth && sourceHeight) {
    const uint32_t visibleWidth = sourceWidth - static_cast<uint32_t>(appliedCrop.left + appliedCrop.right);
    const uint32_t visibleHeight = sourceHeight - static_cast<uint32_t>(appliedCrop.top + appliedCrop.bottom);
    const float canvasWidth = (float)app_.baseWidth();
    const float canvasHeight = (float)app_.baseHeight();
    const float scale = std::min(canvasWidth / (float)visibleWidth, canvasHeight / (float)visibleHeight);
    struct vec2 itemScale = {scale, scale};
    struct vec2 pos = {(canvasWidth - (float)visibleWidth * scale) / 2.0f,
                       (canvasHeight - (float)visibleHeight * scale) / 2.0f};

    obs_sceneitem_set_bounds_type(item, OBS_BOUNDS_NONE);
    obs_sceneitem_set_bounds_crop(item, false);
    obs_sceneitem_set_alignment(item, OBS_ALIGN_TOP | OBS_ALIGN_LEFT);
    obs_sceneitem_set_scale(item, &itemScale);
    obs_sceneitem_set_pos(item, &pos);
    return;
  }

  // WGC has not produced a frame yet. This gives it a sensible transform for
  // the first frame; the watchdog will replace it with the exact transform.
  struct vec2 bounds = {(float)app_.baseWidth(), (float)app_.baseHeight()};
  obs_sceneitem_set_bounds(item, &bounds);
  obs_sceneitem_set_bounds_type(item, OBS_BOUNDS_SCALE_INNER);
  obs_sceneitem_set_bounds_crop(item, false);
}

void SourceManager::fillWindowFrameLocked()
{
  struct obs_sceneitem_crop sceneCrop = {};
  windowClientSize_ = {};
#ifdef _WIN32
  if (windowItem_ && windowSource_ && subject_.kind == Subject::Kind::Window) {
    const uint32_t sourceWidth = obs_source_get_width(windowSource_);
    const uint32_t sourceHeight = obs_source_get_height(windowSource_);
    const HWND window = findSubjectWindow(subject_);
    RECT client = {};
    RECT frame = {};
    POINT clientOrigin = {};
    if (sourceWidth && sourceHeight && window && !IsIconic(window) && GetClientRect(window, &client) &&
        ClientToScreen(window, &clientOrigin) &&
        SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &frame, sizeof(frame)))) {
      const LONG_PTR style = GetWindowLongPtrW(window, GWL_STYLE);
      const int64_t clientHeight = client.bottom - client.top;
      const uint32_t captionInset =
          (style & WS_CAPTION) == WS_CAPTION && clientOrigin.y > frame.top
              ? captionBoundaryInset(GetDpiForWindow(window))
              : 0;
      const ClientAreaCrop crop =
          computeClientAreaCrop(sourceWidth, sourceHeight, frame.left, frame.top, clientOrigin.x,
                                clientOrigin.y + captionInset, client.right - client.left,
                                clientHeight - captionInset);
      if (crop.valid) {
        sceneCrop.left = static_cast<int>(crop.left);
        sceneCrop.top = static_cast<int>(crop.top);
        sceneCrop.right = static_cast<int>(crop.right);
        sceneCrop.bottom = static_cast<int>(crop.bottom);
        // The small caption-boundary inset is display cleanup, not a change
        // in the game's aspect ratio. Keep video geometry consistent with
        // the hook/client so fallback switching cannot discard replay history.
        const auto clientCrop = computeClientAreaCrop(sourceWidth, sourceHeight, frame.left, frame.top,
            clientOrigin.x, clientOrigin.y, client.right - client.left, clientHeight);
        if (clientCrop.valid)
          windowClientSize_ = {sourceWidth - clientCrop.left - clientCrop.right,
                               sourceHeight - clientCrop.top - clientCrop.bottom};
      }
    }
  }
#endif
  fillFrame(windowItem_, &sceneCrop);
}

void SourceManager::setWindowTargetLocked(const Subject& s)
{
  windowClientSize_ = {};
  if (!windowSource_ && !gameSource_)
    return;
  resetFrameProbeLocked();
  const std::string desc = encodeWindowPart(s.title) + ":" + encodeWindowPart(s.cls) + ":" + encodeWindowPart(s.exe);
  obs_data_t* d = obs_data_create();
  obs_data_set_string(d, "window", desc.c_str());
  if (windowSource_) {
    obs_data_t* windowSettings = obs_data_create();
    obs_data_apply(windowSettings, d);
    setWgcSdrSettings(windowSettings);
    obs_source_update(windowSource_, windowSettings);
    obs_data_release(windowSettings);
  }
  if (gameSource_)
    obs_source_update(gameSource_, d);
  obs_data_release(d);

  const auto now = std::chrono::steady_clock::now();
  captureHealthyAt_ = now;
  lastWindowRetry_ = now;
  lastHookRetry_ = now;
  hookRetryCount_ = 0;
  wgcRetryCount_ = 0;
  lastHookAction_ = "none";
  lastHookActionMs_ = 0;
  lastWindowAction_ = "none";
  lastWindowActionMs_ = 0;
  windowNoFramesReported_ = false;
  windowSuppressedForMinimize_ = false;
  activeBackend_ = ActiveBackend::None;
}

void SourceManager::createGameCaptureLocked()
{
  obs_data_t* s = obs_data_create();
  obs_data_set_string(s, "capture_mode", "window");
  obs_data_set_int(s, "priority", 2);
  obs_data_set_bool(s, "capture_cursor", true);
  obs_data_set_bool(s, "anti_cheat_hook", true);
  obs_data_set_int(s, "hook_rate", 1);
  const char* diagnostics = std::getenv("SHARD_GAME_CAPTURE_DIAGNOSTICS");
  obs_data_set_bool(s, "shard_gc_diagnostics", diagnostics && *diagnostics && std::string(diagnostics) != "0");
  obs_data_set_string(s, "window", "::");
  gameSource_ = obs_source_create("game_capture", "game-capture", s, nullptr);
  obs_data_release(s);
}

void SourceManager::recreateGameCaptureLocked()
{
  // Updating the same descriptor does not reset an already acquired texture
  // in OBS. Recreate only the failed hook, leaving WGC and audio uninterrupted.
  probeHookPending_ = false;
  hookObservation_ = {};
  if (gameItem_) {
    obs_sceneitem_remove(gameItem_);
    gameItem_ = nullptr;
  }
  if (gameSource_) obs_source_release(gameSource_);
  gameSource_ = nullptr;
  createGameCaptureLocked();
  if (gameSource_) {
    gameItem_ = obs_scene_add(app_.scene(), gameSource_);
    retryGameCaptureLocked();
    fillFrame(gameItem_);
  }
  if (windowItem_) obs_sceneitem_set_order(windowItem_, OBS_ORDER_MOVE_TOP);
  activeBackend_ = windowItem_ ? ActiveBackend::Wgc : ActiveBackend::None;
  lastHookAction_ = "recreate";
  lastHookActionMs_ = duration_ms_now();
  std::fprintf(stderr, "capture: recreated stalled game hook for pid=%lu; keeping WGC fallback\n",
               static_cast<unsigned long>(subject_.pid));
}

void SourceManager::recreateWindowCaptureLocked()
{
  probeWindowPending_ = false;
  windowObservation_ = {};
  if (windowItem_) obs_sceneitem_remove(windowItem_);
  windowItem_ = nullptr;
  if (windowSource_) obs_source_release(windowSource_);
  windowSource_ = nullptr;
  createWindowCaptureLocked();
  if (windowSource_) windowItem_ = obs_scene_add(app_.scene(), windowSource_);
  retryWindowCaptureLocked();
  if (windowItem_) obs_sceneitem_set_visible(windowItem_, !windowSuppressedForMinimize_);
  fillWindowFrameLocked();
  if (activeBackend_ == ActiveBackend::Hook && gameItem_)
    obs_sceneitem_set_order(gameItem_, OBS_ORDER_MOVE_TOP);
  lastWindowAction_ = "recreate";
  lastWindowActionMs_ = duration_ms_now();
}

void SourceManager::resetFrameProbeLocked()
{
  backendHealth_ = {};
  probeHookPending_ = probeWindowPending_ = probeScenePending_ = false;
  lastProbeMs_ = 0;
  hookObservation_ = windowObservation_ = monitorObservation_ = sceneObservation_ = {};
  diagnosticSchedule_.reset();
  // releaseAll runs before obs_shutdown; the destructor may run afterward.
  if (!probeRender_ && !probeHook_ && !probeWindow_ && !probeScene_) return;
  obs_enter_graphics();
  gs_texrender_destroy(probeRender_);
  gs_stagesurface_destroy(probeHook_);
  gs_stagesurface_destroy(probeWindow_);
  gs_stagesurface_destroy(probeScene_);
  probeRender_ = nullptr;
  probeHook_ = probeWindow_ = probeScene_ = nullptr;
  obs_leave_graphics();
}

void SourceManager::sampleCaptureFrames(void* data)
{
  auto& self = *static_cast<SourceManager*>(data);
  // Never block the graphics thread on a watchdog source update/teardown.
  std::unique_lock<std::mutex> lock(self.sourceMutex_, std::try_to_lock);
  if (!lock || self.subject_.kind == Subject::Kind::None) return;
  const uint64_t now = duration_ms_now();
  if (now - self.lastProbeMs_ < 500) return;
  const uint64_t stagedMs = self.lastProbeMs_;
  self.lastProbeMs_ = now;
  if (self.subject_.kind == Subject::Kind::Window && self.windowSuppressedForMinimize_) {
    self.probeHookPending_ = self.probeWindowPending_ = self.probeScenePending_ = false;
    self.hookObservation_ = self.windowObservation_ = self.sceneObservation_ = {};
    return;
  }
  constexpr uint32_t width = 64, height = 36;
  if (!self.probeRender_) self.probeRender_ = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
  if (!self.probeHook_) self.probeHook_ = gs_stagesurface_create(width, height, GS_RGBA);
  if (!self.probeWindow_) self.probeWindow_ = gs_stagesurface_create(width, height, GS_RGBA);
  if (!self.probeScene_) self.probeScene_ = gs_stagesurface_create(width, height, GS_RGBA);
  if (!self.probeRender_) return;

  // Read the previous sample, giving the GPU half a second to finish the
  // tiny copy instead of synchronously reading a full-resolution frame.
  const auto read = [&](gs_stagesurf_t* surface, bool pending, CaptureFrameObservation& observation) {
    // A scheduling/sleep gap must not relabel an old staged frame as fresh.
    if (!surface || !pending || !stagedMs || now - stagedMs > 1500) return;
    uint8_t* pixels = nullptr;
    uint32_t stride = 0;
    if (!gs_stagesurface_map(surface, &pixels, &stride)) return;
    observation.observePixels(pixels, width, height, stride, stagedMs);
    gs_stagesurface_unmap(surface);
  };
  if (self.subject_.kind == Subject::Kind::Window) {
    read(self.probeHook_, self.probeHookPending_, self.hookObservation_);
    read(self.probeWindow_, self.probeWindowPending_, self.windowObservation_);
  } else {
    read(self.probeHook_, self.probeHookPending_, self.monitorObservation_);
  }
  read(self.probeScene_, self.probeScenePending_, self.sceneObservation_);

  const auto stage = [&](obs_source_t* source, gs_stagesurf_t* surface) {
    const uint32_t cx = source ? obs_source_get_width(source) : 0;
    const uint32_t cy = source ? obs_source_get_height(source) : 0;
    if (!surface || !cx || !cy) return false;
    gs_texrender_reset(self.probeRender_);
    if (!gs_texrender_begin(self.probeRender_, width, height)) return false;
    struct vec4 clear = {};
    gs_clear(GS_CLEAR_COLOR, &clear, 0.0f, 0);
    gs_ortho(0.0f, static_cast<float>(cx), 0.0f, static_cast<float>(cy), -100.0f, 100.0f);
    gs_blend_state_push();
    gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
    obs_source_video_render(source);
    gs_blend_state_pop();
    gs_texrender_end(self.probeRender_);
    gs_stage_texture(surface, gs_texrender_get_texture(self.probeRender_));
    return true;
  };
  self.probeHookPending_ = stage(self.subject_.kind == Subject::Kind::Monitor
                                   ? self.monitorSource_ : self.gameSource_, self.probeHook_);
  self.probeWindowPending_ = self.subject_.kind == Subject::Kind::Window &&
                            stage(self.windowSource_, self.probeWindow_);

  // Observe the real video mix AFTER composition, not another rendering of
  // the scene. Only this path needs a new tiny readback; fingerprints reuse
  // each surface's already mapped pixels.
  self.probeScenePending_ = false;
  auto* texture = obs_get_main_texture();
  if (texture && self.probeScene_) {
    gs_texrender_reset(self.probeRender_);
    if (gs_texrender_begin(self.probeRender_, width, height)) {
      struct vec4 clear = {};
      gs_clear(GS_CLEAR_COLOR, &clear, 0.0f, 0);
      gs_ortho(0.0f, static_cast<float>(width), 0.0f, static_cast<float>(height), -100.0f, 100.0f);
      gs_blend_state_push();
      gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
      const bool srgb = gs_framebuffer_srgb_enabled();
      gs_enable_framebuffer_srgb(true);
      auto* effect = obs_get_base_effect(OBS_EFFECT_DEFAULT);
      gs_effect_set_texture_srgb(gs_effect_get_param_by_name(effect, "image"), texture);
      while (gs_effect_loop(effect, "Draw")) gs_draw_sprite(texture, 0, width, height);
      gs_enable_framebuffer_srgb(srgb);
      gs_blend_state_pop();
      gs_texrender_end(self.probeRender_);
      gs_stage_texture(self.probeScene_, gs_texrender_get_texture(self.probeRender_));
      self.probeScenePending_ = true;
    }
  }
}

void SourceManager::retryMonitorCaptureLocked()
{
  if (!monitorSource_ || subject_.kind != Subject::Kind::Monitor)
    return;
  obs_data_t* settings = obs_data_create();
  const std::string devId = monitorDeviceId(config_.capture.monitor);
  if (!devId.empty())
    obs_data_set_string(settings, "monitor_id", devId.c_str());
  obs_data_set_int(settings, "monitor", config_.capture.monitor);
  obs_data_set_int(settings, "method", 2);
  obs_data_set_bool(settings, "capture_cursor", true);
  setWgcSdrSettings(settings);
  obs_source_update(monitorSource_, settings);
  obs_data_release(settings);
}

void SourceManager::retryWindowCaptureLocked()
{
  if (!windowSource_ || subject_.kind != Subject::Kind::Window)
    return;
  const std::string desc = encodeWindowPart(subject_.title) + ":" + encodeWindowPart(subject_.cls) + ":" +
                           encodeWindowPart(subject_.exe);
  obs_data_t* d = obs_data_create();
  obs_data_set_string(d, "window", desc.c_str());
  setWgcSdrSettings(d);
  obs_source_update(windowSource_, d);
  obs_data_release(d);
  lastWindowAction_ = "retry";
  lastWindowActionMs_ = duration_ms_now();
}

void SourceManager::retryGameCaptureLocked()
{
  if (!gameSource_ || subject_.kind != Subject::Kind::Window)
    return;
  const std::string desc = encodeWindowPart(subject_.title) + ":" + encodeWindowPart(subject_.cls) + ":" +
                           encodeWindowPart(subject_.exe);
  obs_data_t* d = obs_data_create();
  obs_data_set_string(d, "window", desc.c_str());
  obs_source_update(gameSource_, d);
  obs_data_release(d);
  lastHookAction_ = "retry";
  lastHookActionMs_ = duration_ms_now();
  const char* diagnostics = std::getenv("SHARD_GAME_CAPTURE_DIAGNOSTICS");
  if (diagnostics && *diagnostics && std::string(diagnostics) != "0") {
    std::fprintf(stderr,
                 "[GC] ts_ms=%llu stage=HookRetry pid=%lu attempt=%d desc=\"%s\"\n",
                 static_cast<unsigned long long>(duration_ms_now()),
                 static_cast<unsigned long>(subject_.pid), hookRetryCount_ + 1, desc.c_str());
    std::fflush(stderr);
  }
}

void SourceManager::emitSubjectChanged()
{
  switch (subject_.kind) {
    case Subject::Kind::Monitor:
      events_.emit("capture.subject", {{"kind", "monitor"}, {"name", "Desktop"}});
      break;
    case Subject::Kind::Window:
      events_.emit("capture.subject", {{"kind", "game"}, {"name", subject_.name}});
      break;
    default:
      events_.emit("capture.subject", {{"kind", "none"}, {"name", nullptr}});
      break;
  }
}

void SourceManager::setGameSubject(const std::string& exe, const std::string& name, const std::string& title,
                                   const std::string& cls, uint32_t pid)
{
  std::lock_guard<std::mutex> lock(sourceMutex_);
  Subject cand{Subject::Kind::Window, exe, title, cls, name.empty() ? exe : name, pid};
  requestedGame_ = cand;
  if (config_.capture.mode == "screen")
    return; // monitor capture always wins in screen mode
  if (subject_ == cand)
    return;

  const bool visibleIdentityChanged =
      subject_.kind != Subject::Kind::Window || subject_.pid != cand.pid || subject_.name != cand.name;
#ifdef _WIN32
  // Games rewrite their titles (FPS counters, level names). The same HWND
  // needs no retarget: a new descriptor would restart the hook and the WGC
  // session. OBS only uses the title to choose among this exe's windows.
  if (subject_.kind == Subject::Kind::Window && subject_.pid == cand.pid && subject_.exe == cand.exe &&
      targetWindow_ && reinterpret_cast<uintptr_t>(findSubjectWindow(cand)) == targetWindow_) {
    subject_ = std::move(cand);
    if (visibleIdentityChanged)
      emitSubjectChanged();
    return;
  }
#endif
  if (subject_.pid != cand.pid) targetWindow_ = 0;
  healthRecovery_.resetEvidence();
  videoRecoveryRequested_ = false;
  subject_ = std::move(cand);
  applySubjectLocked();
  if (visibleIdentityChanged)
    emitSubjectChanged();
}

void SourceManager::clearGameSubject()
{
  std::lock_guard<std::mutex> lock(sourceMutex_);
  requestedGame_ = {};
  if (subject_.kind != Subject::Kind::Window)
    return;
  healthRecovery_.resetEvidence();
  videoRecoveryRequested_ = false;
  if (config_.capture.mode == "auto") {
    subject_ = Subject{Subject::Kind::Monitor, "", "", "", "Desktop", 0};
  } else {
    subject_ = Subject{};
  }
  // A pending hook surface must not become the first monitor observation
  // when the probe's shared staging slot changes subjects.
  resetFrameProbeLocked();
  applySubjectLocked();
  emitSubjectChanged();
}

void SourceManager::startWatchdog()
{
  if (watchdogRun_.exchange(true))
    return;
  obs_add_main_rendered_callback(sampleCaptureFrames, this);
  watchdogThread_ = std::thread([this] { watchdogLoop(); });
}

void SourceManager::stopWatchdog()
{
  if (!watchdogRun_.exchange(false))
    return;
  if (watchdogThread_.joinable())
    watchdogThread_.join();
  obs_remove_main_rendered_callback(sampleCaptureFrames, this);
}
bool SourceManager::consumeVideoRecoveryRequest()
{
  std::lock_guard<std::mutex> lock(sourceMutex_);
  const bool requested = videoRecoveryRequested_;
  videoRecoveryRequested_ = false;
  return requested;
}

std::string SourceManager::probeDiagnosticsLocked(uint64_t nowMs) const
{
  std::ostringstream text;
  const auto append = [&](const char* name, const CaptureFrameObservation& frame) {
    text << ' ' << name << "_pixels_observed=" << (frame.hasPixels ? "true" : "false")
         << ' ' << name << "_probe_fresh=" << (frame.fresh(nowMs) ? "true" : "false")
         << ' ' << name << "_frame_changed=" << (frame.frameChanged && frame.fresh(nowMs) ? "true" : "false")
         << ' ' << name << "_changing=" << (frame.changing(nowMs) ? "true" : "false")
         << ' ' << name << "_health=" << (frame.healthy(nowMs) ? "content" : frame.fresh(nowMs) &&
                                          frame.content == CaptureFrameContent::Black ? "black" : "degraded_unknown")
         << ' ' << name << "_probe_age_ms=" << (frame.hasPixels ? std::to_string(nowMs - frame.observedMs) : "never")
         << ' ' << name << "_unchanged_age_ms=" << (frame.hasPixels ? std::to_string(frame.unchangedAge(nowMs)) : "never");
  };
  append("hook", hookObservation_);
  append("wgc", windowObservation_);
  append("scene", sceneObservation_);
  text << " scene_content=" << captureFrameContentName(sceneObservation_.content);
  if (subject_.kind == Subject::Kind::Monitor) {
    append("monitor", monitorObservation_);
    text << " monitor_content=" << captureFrameContentName(monitorObservation_.content);
  }
  return text.str();
}

void SourceManager::logRecoveryLocked(const char* reason, const char* action, int level, uint64_t nowMs)
{
  refreshCaptureDisplayLocked(nowMs);
  std::ostringstream line;
  const char* backend = subject_.kind == Subject::Kind::Monitor ? "monitor" :
      activeBackend_ == ActiveBackend::Hook ? "hook" : activeBackend_ == ActiveBackend::Wgc ? "wgc" : "none";
  line << "[capture-recovery][warn] ts_ms=" << nowMs << " reason=" << reason
       << " recovery_level=" << level << " action=" << action << " selected_backend_before=" << backend
       << " pid=" << subject_.pid << " hwnd=0x" << std::hex << targetWindow_ << std::dec
       << " hook_retry_count=" << hookRetryCount_ << " wgc_retry_count=" << wgcRetryCount_
       << " hook_reject_reason=" << backendHealth_.rejectionReason()
       << " previous_recovery_age_ms=" << (lastRecoveryMs_ ? std::to_string(nowMs - lastRecoveryMs_) : "never");
  const auto observation = [&](const char* name, const CaptureFrameObservation& frame, obs_source_t* source) {
    line << ' ' << name << "_source=" << (source ? "present" : "missing")
         << ' ' << name << "_size=" << (source ? obs_source_get_width(source) : 0) << 'x'
         << (source ? obs_source_get_height(source) : 0)
         << ' ' << name << "_content=" << captureFrameContentName(frame.content)
         << ' ' << name << "_pixels_observed=" << frame.hasPixels
         << ' ' << name << "_frame_changed=" << frame.frameChanged
         << ' ' << name << "_changing=" << frame.changing(nowMs)
         << ' ' << name << "_healthy=" << frame.healthy(nowMs)
         << ' ' << name << "_probe_age_ms=" << (frame.observedMs ? std::to_string(nowMs - frame.observedMs) : "never")
         << ' ' << name << "_unchanged_age_ms=" << (frame.hasPixels ? std::to_string(frame.unchangedAge(nowMs)) : "never");
  };
  line << colorDiagnosticsLocked();
  observation("hook", hookObservation_, gameSource_);
  observation("wgc", windowObservation_, windowSource_);
  observation("scene", sceneObservation_, obs_scene_get_source(app_.scene()));
  if (subject_.kind == Subject::Kind::Monitor) observation("monitor", monitorObservation_, monitorSource_);
  std::fprintf(stderr, "%s\n", line.str().c_str());
  std::fflush(stderr);
  lastRecoveryMs_ = nowMs;
}

void SourceManager::repairSceneLocked()
{
  // Repair downstream binding/visibility/transforms without reacquiring a
  // healthy target or disturbing audio, replay packets or recording outputs.
  obs_set_output_source(0, obs_scene_get_source(app_.scene()));
  const bool monitor = subject_.kind == Subject::Kind::Monitor;
  if (monitorItem_) obs_sceneitem_set_visible(monitorItem_, monitor);
  if (gameItem_) obs_sceneitem_set_visible(gameItem_, !monitor && subject_.kind == Subject::Kind::Window);
  if (windowItem_) obs_sceneitem_set_visible(windowItem_, !monitor && !windowSuppressedForMinimize_);
  fillFrame(monitorItem_);
  fillFrame(gameItem_);
  fillWindowFrameLocked();
  if (activeBackend_ == ActiveBackend::Wgc && windowItem_) obs_sceneitem_set_order(windowItem_, OBS_ORDER_MOVE_TOP);
  else if (activeBackend_ == ActiveBackend::Hook && gameItem_) obs_sceneitem_set_order(gameItem_, OBS_ORDER_MOVE_TOP);
}

void SourceManager::recoverCaptureLocked(bool eligible, bool monitor, uint64_t nowMs)
{
  const bool hookHealthy = gameSource_ && obs_source_get_width(gameSource_) && obs_source_get_height(gameSource_) &&
                           hookObservation_.healthy(nowMs) && !backendHealth_.hookRejected();
  const bool wgcHealthy = windowSource_ && obs_source_get_width(windowSource_) && obs_source_get_height(windowSource_) &&
                          windowObservation_.healthy(nowMs);
  const bool sourceHealthy = monitor ? monitorSource_ && monitorObservation_.healthy(nowMs) : hookHealthy || wgcHealthy;
  const auto& selected = monitor ? monitorObservation_ : activeBackend_ == ActiveBackend::Wgc
                                                    ? windowObservation_ : hookObservation_;
  const bool sceneFrozen = sceneObservation_.fresh(nowMs) && sceneObservation_.hasPixels &&
      sceneObservation_.unchangedAge(nowMs) >= 30000 && selected.changing(nowMs);
  const bool downstream = sourceHealthy && (!sceneObservation_.healthy(nowMs) || sceneFrozen);
  const bool healthy = sourceHealthy && sceneObservation_.healthy(nowMs) && !sceneFrozen;
  CaptureHealthRecovery::Input input;
  input.eligible = eligible && !videoRecoveryRequested_;
  input.healthy = healthy;
  input.downstream = downstream;
  input.unusable = !healthy;
  input.stalePipeline = !sceneObservation_.fresh(nowMs);
  input.monitor = monitor;
  const auto action = healthRecovery_.update(input, nowMs);
  if (action == CaptureRecoveryAction::None) return;
  const char* reason = downstream ? "source_content_scene_unusable" : input.stalePipeline
      ? "persistent_stale_or_missing_probes" : "persistent_unusable_capture";
  logRecoveryLocked(reason, captureRecoveryActionName(action), static_cast<int>(action), nowMs);
  switch (action) {
    case CaptureRecoveryAction::Retry:
      if (monitor) retryMonitorCaptureLocked();
      else { retryGameCaptureLocked(); retryWindowCaptureLocked(); }
      lastHookRetry_ = lastWindowRetry_ = std::chrono::steady_clock::now();
      if (!monitor) ++hookRetryCount_;
      ++wgcRetryCount_;
      break;
    case CaptureRecoveryAction::RecreateHook:
      recreateGameCaptureLocked();
      lastHookRetry_ = std::chrono::steady_clock::now();
      ++hookRetryCount_;
      break;
    case CaptureRecoveryAction::RecreateWgc:
      recreateWindowCaptureLocked();
      lastWindowRetry_ = std::chrono::steady_clock::now();
      ++wgcRetryCount_;
      break;
    case CaptureRecoveryAction::RebuildSources:
      applyVideoSourceLocked();
      break;
    case CaptureRecoveryAction::RebindScene:
      repairSceneLocked();
      break;
    case CaptureRecoveryAction::ResetVideo:
      videoRecoveryRequested_ = true;
      break;
    default: break;
  }
}

void SourceManager::watchdogLoop()
{
  constexpr auto kRetryDelay = std::chrono::seconds(3);
  constexpr auto kNoFramesDelay = std::chrono::seconds(10);
  CaptureRecoveryState recoveryState;
  CaptureRecoverySchedule recoverySchedule;
#ifdef _WIN32
  // Shared hook textures may fail to reopen during a D3D11 device reset
  // while game_capture still reports its previous dimensions. Recreate the
  // sources after OBS has rebuilt its device, outside the graphics callback.
  gs_device_loss graphicsRecovery = {};
  graphicsRecovery.data = &recoveryState;
  graphicsRecovery.device_loss_release = [](void*) {};
  graphicsRecovery.device_loss_rebuild = [](void*, void* data) {
    static_cast<CaptureRecoveryState*>(data)->onGraphicsRebuilt();
  };
  obs_enter_graphics();
  gs_register_loss_callbacks(&graphicsRecovery);
  obs_leave_graphics();
  DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS powerSubscription = {};
  powerSubscription.Callback = capturePowerCallback;
  powerSubscription.Context = &recoveryState;
  HPOWERNOTIFY displayNotification = nullptr;
  HPOWERNOTIFY suspendNotification = nullptr;
  const DWORD displayResult = PowerSettingRegisterNotification(&GUID_CONSOLE_DISPLAY_STATE, DEVICE_NOTIFY_CALLBACK,
                                       reinterpret_cast<HANDLE>(&powerSubscription),
                                       &displayNotification);
  if (displayResult != ERROR_SUCCESS) {
    std::fprintf(stderr, "capture: display notification registration failed (%lu)\n", displayResult);
    displayNotification = nullptr;
  }
  const DWORD suspendResult = PowerRegisterSuspendResumeNotification(DEVICE_NOTIFY_CALLBACK,
                                             reinterpret_cast<HANDLE>(&powerSubscription),
                                             &suspendNotification);
  if (suspendResult != ERROR_SUCCESS) {
    std::fprintf(stderr, "capture: suspend notification registration failed (%lu)\n", suspendResult);
    suspendNotification = nullptr;
  }
#endif
  auto lastWatchdogTick = std::chrono::steady_clock::now();

  while (watchdogRun_.load()) {
    const auto tickNow = std::chrono::steady_clock::now();
    const bool resumedAfterLongPause = tickNow - lastWatchdogTick >= std::chrono::seconds(5);
    // Always consume the notification, even when the scheduling-gap fallback
    // fires on this tick. Short-circuiting here used to rebuild twice.
    const bool notified = recoveryState.consumeRecovery();
    const uint64_t tickMs = duration_ms_now();
    if (resumedAfterLongPause || notified) {
      recoverySchedule.request(tickMs);
      std::lock_guard<std::mutex> lock(sourceMutex_);
      healthRecovery_.resetEvidence();
      videoRecoveryRequested_ = false;
    }
    if (recoverySchedule.consumeDue(tickMs)) {
      // Recreate only video sources. Audio capture remains continuous, while
      // fresh WGC sessions and a fresh hook source replace stale black textures.
      std::lock_guard<std::mutex> lock(sourceMutex_);
      logRecoveryLocked("display_system_wake_or_graphics_reset", "rebuild_sources", 4, tickMs);
      healthRecovery_.externalRecovery(tickMs);
      videoRecoveryRequested_ = false;
      applyVideoSourceLocked();
    }
    const std::string mode = config_.capture.mode;
    bool active = false;
    {
      std::lock_guard<std::mutex> lock(sourceMutex_);
      if (subject_.kind == Subject::Kind::Window && !pidAlive(subject_.pid)) {
        if (requestedGame_.pid == subject_.pid) requestedGame_ = {};
        if (mode == "auto") {
          subject_ = Subject{Subject::Kind::Monitor, "", "", "", "Desktop", 0};
        } else {
          subject_ = Subject{};
        }
        resetFrameProbeLocked();
        applySubjectLocked();
        healthRecovery_.resetEvidence();
        videoRecoveryRequested_ = false;
        emitSubjectChanged();
      }

      if (subject_.kind == Subject::Kind::Monitor) {
        refreshCaptureDisplayLocked(tickMs);
        const auto now = std::chrono::steady_clock::now();
        const uint32_t monitorWidth = monitorSource_ ? obs_source_get_width(monitorSource_) : 0;
        const uint32_t monitorHeight = monitorSource_ ? obs_source_get_height(monitorSource_) : 0;
        const bool monitorReady = monitorWidth && monitorHeight;
        const bool monitorHealthy = monitorReady && monitorObservation_.healthy(tickMs);
        active = monitorReady;
        activeBackend_ = ActiveBackend::None;
        if (monitorHealthy) {
          captureHealthyAt_ = now;
          lastWindowRetry_ = now;
          windowNoFramesReported_ = false;
        } else {
          if (!monitorReady && !recoveryState.displaySleeping() && !recoverySchedule.pending() &&
              now - lastWindowRetry_ >= kRetryDelay) {
            logRecoveryLocked("monitor_dimensions_unavailable", "retry_monitor", 0, tickMs);
            retryMonitorCaptureLocked();
            lastWindowRetry_ = now;
          }
          if (!monitorReady && !recoveryState.displaySleeping() &&
              now - captureHealthyAt_ >= kNoFramesDelay && !windowNoFramesReported_) {
            events_.emit("error",
                         {{"code", "CAPTURE_NO_FRAMES"},
                          {"message", "Desktop capture is not producing frames; recovery is still retrying"}});
            windowNoFramesReported_ = true;
          }
        }
        if (monitorReady) fillFrame(monitorItem_);
        std::ostringstream signature;
        signature << "mode=" << mode << "|subject=monitor|source=" << (monitorSource_ != nullptr) << '|'
                  << monitorWidth << 'x' << monitorHeight << "|ready=" << monitorReady << '|' << monitorHealthy
                  << '|' << captureFrameContentName(monitorObservation_.content) << '|'
                  << captureFrameContentName(sceneObservation_.content) << '|' << sceneObservation_.fresh(tickMs);
        const uint64_t diagnosticNowMs = duration_ms_now();
        signature << colorDiagnosticsLocked();
        if (diagnosticSchedule_.shouldLog(signature.str(), diagnosticNowMs)) {
          std::ostringstream line;
          line << "[capture-health][" << (monitorHealthy ? "info" : "warn") << "] ts_ms=" << diagnosticNowMs
               << " capture_mode=" << mode << " subject_kind=monitor selected_backend=monitor"
               << " monitor_source=" << (monitorSource_ ? "present" : "missing") << " monitor_size=" << monitorWidth
               << 'x' << monitorHeight << " monitor_size_ready=" << (monitorReady ? "true" : "false")
               << " backend_ready_active=" << (active ? "true" : "false")
               << " backend_healthy=" << (monitorHealthy ? "true" : "false")
               << " content_probe=64x36_interior source_dimensions_mean_frame_size_only=true"
               << colorDiagnosticsLocked() << probeDiagnosticsLocked(diagnosticNowMs);
          std::fprintf(stderr, "%s\n", line.str().c_str());
          std::fflush(stderr);
        }
        recoverCaptureLocked(!recoveryState.displaySleeping() && !recoverySchedule.pending(), true, tickMs);
      } else if (subject_.kind == Subject::Kind::Window && pidAlive(subject_.pid)) {
        refreshTargetWindowLocked();
        refreshCaptureDisplayLocked(tickMs);
        const bool minimized = subjectWindowMinimized(subject_);
        if (windowSuppressedForMinimize_ != minimized) {
          windowSuppressedForMinimize_ = minimized;
          // WGC retains its last compositor frame for some minimized games.
          // Hide that opaque layer so the still-running graphics hook is the
          // only game surface rendered until the window is restored.
          if (windowItem_)
            obs_sceneitem_set_visible(windowItem_, !minimized);
          const char* diagnostics = std::getenv("SHARD_GAME_CAPTURE_DIAGNOSTICS");
          if (diagnostics && *diagnostics && std::string(diagnostics) != "0") {
            std::fprintf(stderr, "[GC] ts_ms=%llu stage=WindowLayer minimized=%s wgc_visible=%s pid=%lu\n",
                         static_cast<unsigned long long>(duration_ms_now()), minimized ? "true" : "false",
                         minimized ? "false" : "true", static_cast<unsigned long>(subject_.pid));
            std::fflush(stderr);
          }
        }
        const uint32_t windowWidth = windowSource_ ? obs_source_get_width(windowSource_) : 0;
        const uint32_t windowHeight = windowSource_ ? obs_source_get_height(windowSource_) : 0;
        const uint32_t gameWidth = gameSource_ ? obs_source_get_width(gameSource_) : 0;
        const uint32_t gameHeight = gameSource_ ? obs_source_get_height(gameSource_) : 0;
        const bool windowReady = windowWidth && windowHeight;
        const bool usableWindowReady = windowReady && !minimized;
        // Evaluate aging evidence even if the graphics callback stops. Only
        // successful maps update the observations feeding this policy.
        backendHealth_.sample(hookObservation_, windowObservation_, tickMs);
        const bool windowHealthy = usableWindowReady && windowObservation_.healthy(tickMs);
        const bool hookRejected = backendHealth_.hookRejected();
        const bool hookHealthy = gameWidth && gameHeight && !hookRejected && hookObservation_.healthy(tickMs);
        const bool hookProbeStale = hookObservation_.hasPixels && !hookObservation_.fresh(tickMs) &&
                                   tickMs - hookObservation_.observedMs >= 15000;
        const bool gameReady = gameWidth && gameHeight && !hookRejected && !(hookProbeStale && windowHealthy);
        const bool downstreamFailure = (hookHealthy || windowHealthy) && !sceneObservation_.healthy(tickMs);
        const bool normalRecoveryAllowed = !minimized && !recoveryState.displaySleeping() &&
            !recoverySchedule.pending() && !videoRecoveryRequested_ && !downstreamFailure;
        const auto now = std::chrono::steady_clock::now();
        // A minimized live game is an expected WGC outage, not a dead capture
        // subject. Keep the replay lifecycle active so its existing packets
        // are never discarded; WGC retries resume after restore. Do not emit
        // CAPTURE_NO_FRAMES while minimized.
        if (minimized) {
          active = true;
          captureHealthyAt_ = now;
          windowNoFramesReported_ = false;
        }

        if (usableWindowReady || gameReady) {
          active = true;
          if (hookHealthy || windowHealthy) {
            captureHealthyAt_ = now;
            windowNoFramesReported_ = false;
          }
          if (gameReady)
            fillFrame(gameItem_);
          if (usableWindowReady)
            fillWindowFrameLocked();

          ActiveBackend desired = ActiveBackend::None;
          if (gameReady)
            desired = ActiveBackend::Hook;
          else if (usableWindowReady)
            desired = ActiveBackend::Wgc;

          if (desired != activeBackend_) {
            if (activeBackend_ != ActiveBackend::None)
              logRecoveryLocked(hookRejected ? backendHealth_.rejectionReason() : "backend_readiness_changed",
                                desired == ActiveBackend::Wgc ? "select_wgc" : "select_hook", 0, tickMs);
            activeBackend_ = desired;
            // A black hook still has an opaque texture. Merely naming WGC
            // as the backend cannot expose it; change the actual layer order.
            if (desired == ActiveBackend::Wgc && windowItem_)
              obs_sceneitem_set_order(windowItem_, OBS_ORDER_MOVE_TOP);
            else if (desired == ActiveBackend::Hook && gameItem_)
              obs_sceneitem_set_order(gameItem_, OBS_ORDER_MOVE_TOP);
            const char* backendStr = desired == ActiveBackend::Hook ? "hook" : "wgc";
            std::fprintf(stderr,
                         "[GC] ts_ms=%llu stage=BackendSwitch backend=%s game=%ux%u wgc=%ux%u pid=%lu black_hook=%s\n",
                         static_cast<unsigned long long>(duration_ms_now()), backendStr, gameWidth, gameHeight,
                         windowWidth, windowHeight, static_cast<unsigned long>(subject_.pid),
                         hookRejected ? "true" : "false");
            std::fflush(stderr);
          }
        } else {
          if (captureHealthyAt_.time_since_epoch().count() == 0)
            captureHealthyAt_ = now;
          if (lastWindowRetry_.time_since_epoch().count() == 0)
            lastWindowRetry_ = now;
          if (lastHookRetry_.time_since_epoch().count() == 0)
            lastHookRetry_ = now;

          if (!minimized && !recoveryState.displaySleeping() &&
              now - captureHealthyAt_ >= kNoFramesDelay && !windowNoFramesReported_) {
            std::string msg = "Capture for " + subject_.name +
                              " is not producing frames through either game capture or WGC; recovery "
                              "is still retrying";
            events_.emit("error", {{"code", "CAPTURE_NO_FRAMES"}, {"message", msg}});
            windowNoFramesReported_ = true;
          }
        }
        // Keep the fallback ready even while the hook works. OBS compatibility
        // JSON flags select which capture method a warning applies to; they
        // are not a list of titles that prohibit WGC.
        if (windowHealthy) {
          lastWindowRetry_ = now;
          wgcRetryCount_ = 0;
        } else if (!usableWindowReady && normalRecoveryAllowed && now - lastWindowRetry_ >= kRetryDelay) {
          logRecoveryLocked("wgc_dimensions_unavailable", "retry_wgc", 0, tickMs);
          retryWindowCaptureLocked();
          lastWindowRetry_ = now;
          wgcRetryCount_++;
        }
        // Recover the hook independently of WGC. A fallback with dimensions
        // can still be black (notably for protected titles), and must not
        // prevent the preferred backend from ever getting another attempt.
        if (hookHealthy) {
          lastHookRetry_ = now;
          hookRetryCount_ = 0;
        } else if (normalRecoveryAllowed && (!gameWidth || !gameHeight ||
                       backendHealth_.hookRetryJustified(windowObservation_, tickMs)) &&
                   now - lastHookRetry_ >= std::chrono::milliseconds(
                       hookRejected ? 15000 : captureHookRetryDelayMs(hookRetryCount_))) {
          if ((hookRejected && gameWidth && gameHeight) ||
              (!gameWidth && !gameHeight && hookRetryCount_ > 0 && hookRetryCount_ % 5 == 0)) {
            logRecoveryLocked(hookRejected ? backendHealth_.rejectionReason() : "hook_dimensions_unavailable",
                              "recreate_hook", 2, tickMs);
            recreateGameCaptureLocked();
          } else {
            logRecoveryLocked("hook_dimensions_unavailable", "retry_hook", 0, tickMs);
            retryGameCaptureLocked();
          }
          lastHookRetry_ = now;
          if (hookRetryCount_ < 1000000)
            hookRetryCount_++;
        }

        obs_sceneitem_crop wgcCrop = {};
        if (windowItem_)
          obs_sceneitem_get_crop(windowItem_, &wgcCrop);
        const uint32_t wgcVisibleWidth =
            windowWidth > static_cast<uint32_t>(std::max(0, wgcCrop.left + wgcCrop.right))
                ? windowWidth - static_cast<uint32_t>(wgcCrop.left + wgcCrop.right)
                : 0;
        const uint32_t wgcVisibleHeight =
            windowHeight > static_cast<uint32_t>(std::max(0, wgcCrop.top + wgcCrop.bottom))
                ? windowHeight - static_cast<uint32_t>(wgcCrop.top + wgcCrop.bottom)
                : 0;
        uint32_t clientWidth = 0, clientHeight = 0;
#ifdef _WIN32
        HWND diagnosticWindow = reinterpret_cast<HWND>(targetWindow_);
        RECT diagnosticClient = {};
        if (diagnosticWindow && IsWindow(diagnosticWindow) && GetClientRect(diagnosticWindow, &diagnosticClient)) {
          clientWidth = static_cast<uint32_t>(std::max<LONG>(0, diagnosticClient.right - diagnosticClient.left));
          clientHeight = static_cast<uint32_t>(std::max<LONG>(0, diagnosticClient.bottom - diagnosticClient.top));
        }
#endif
        const char* selectedBackend = "none";
        if (activeBackend_ == ActiveBackend::Hook)
          selectedBackend = "hook";
        else if (activeBackend_ == ActiveBackend::Wgc)
          selectedBackend = "wgc";

        // The signature excludes timestamps and ages so a steady game emits a
        // heartbeat every ten seconds rather than a line on every watchdog tick.
        std::ostringstream signature;
        signature << subject_.exe << '|' << subject_.pid << '|' << targetWindow_ << '|'
                  << minimized << '|' << active << '|' << (gameSource_ != nullptr) << '|'
                  << (windowSource_ != nullptr) << '|'
                  << gameWidth << 'x' << gameHeight << '|' << captureFrameContentName(hookObservation_.content) << '|'
                  << windowWidth << 'x' << windowHeight << '|' << captureFrameContentName(windowObservation_.content) << '|'
                  << wgcCrop.left << ',' << wgcCrop.top << ',' << wgcCrop.right << ',' << wgcCrop.bottom << '|'
                  << clientWidth << 'x' << clientHeight << '|' << hookRejected << '|'
                  << selectedBackend << '|' << hookRetryCount_ << ':' << lastHookAction_ << '|'
                  << wgcRetryCount_ << ':' << lastWindowAction_ << '|'
                  << hookHealthy << '|' << windowHealthy << '|' << hookProbeStale << '|'
                  << captureFrameContentName(sceneObservation_.content) << '|' << sceneObservation_.fresh(tickMs);
        const uint64_t diagnosticNowMs = duration_ms_now();
        signature << colorDiagnosticsLocked();
        if (diagnosticSchedule_.shouldLog(signature.str(), diagnosticNowMs)) {
          const auto ageText = [diagnosticNowMs](uint64_t thenMs) {
            return thenMs ? std::to_string(diagnosticNowMs - thenMs) + "ms" : std::string("never");
          };
          const char* severity =
              hookRejected || (!minimized && ((!hookHealthy && !windowHealthy) || downstreamFailure)) ? "warn" : "info";
          std::ostringstream line;
          line << "[capture-health][" << severity << "] ts_ms=" << diagnosticNowMs
               << " subject_exe=" << subject_.exe << " pid=" << subject_.pid << " hwnd=0x"
               << std::hex << targetWindow_ << std::dec << " minimized=" << (minimized ? "true" : "false")
               << " backend_ready_active=" << (active ? "true" : "false")
               << " hook_source=" << (gameSource_ ? "present" : "missing") << " hook_size=" << gameWidth << 'x'
               << gameHeight << " hook_size_ready=" << (gameWidth && gameHeight ? "true" : "false")
               << " hook_content=" << captureFrameContentName(hookObservation_.content)
               << " hook_healthy=" << (hookHealthy ? "true" : "false")
               << " wgc_source=" << (windowSource_ ? "present" : "missing") << " wgc_size=" << windowWidth << 'x'
               << windowHeight << " wgc_size_ready=" << (windowReady ? "true" : "false")
               << " wgc_content=" << captureFrameContentName(windowObservation_.content)
               << " wgc_healthy=" << (windowHealthy ? "true" : "false")
               << " content_probe=64x36_interior probe_age_ms="
               << (hookObservation_.hasPixels && windowObservation_.hasPixels
                       ? std::to_string(diagnosticNowMs - std::min(hookObservation_.observedMs, windowObservation_.observedMs))
                       : "never")
               << " probe_callback_age_ms=" << (lastProbeMs_ ? std::to_string(diagnosticNowMs - lastProbeMs_) : "never")
               << " source_dimensions_mean_frame_size_only=true"
               << " win32_client=" << (clientWidth && clientHeight ? std::to_string(clientWidth) + 'x' +
                                                                  std::to_string(clientHeight)
                                                                : std::string("unknown"))
               << " wgc_crop=" << wgcCrop.left << ',' << wgcCrop.top << ',' << wgcCrop.right << ',' << wgcCrop.bottom
               << " wgc_visible=" << wgcVisibleWidth << 'x' << wgcVisibleHeight
               << " hook_rejected=" << (hookRejected ? "true" : "false")
               << " hook_reject_reason="
               << backendHealth_.rejectionReason()
               << " selected_backend=" << selectedBackend << " hook_retry_count=" << hookRetryCount_
               << " hook_last_action=" << lastHookAction_ << " hook_last_action_age_ms="
               << ageText(lastHookActionMs_) << " wgc_retry_count=" << wgcRetryCount_
               << " wgc_last_action=" << lastWindowAction_ << " wgc_last_action_age_ms="
               << ageText(lastWindowActionMs_) << colorDiagnosticsLocked() << probeDiagnosticsLocked(diagnosticNowMs);
          std::fprintf(stderr, "%s\n", line.str().c_str());
          std::fflush(stderr);
        }
        bool validWindow = false;
#ifdef _WIN32
        DWORD targetPid = 0;
        const HWND currentWindow = reinterpret_cast<HWND>(targetWindow_);
        validWindow = currentWindow && IsWindow(currentWindow) && IsWindowVisible(currentWindow) &&
                      GetWindowThreadProcessId(currentWindow, &targetPid) && targetPid == subject_.pid;
#endif
        recoverCaptureLocked(validWindow && !minimized && !recoveryState.displaySleeping() &&
                             !recoverySchedule.pending(), false, tickMs);
      } else {
        refreshCaptureDisplayLocked(tickMs);
        std::ostringstream signature;
        signature << "mode=" << mode << "|subject=none|source=none|active=false";
        const uint64_t diagnosticNowMs = duration_ms_now();
        signature << colorDiagnosticsLocked();
        if (diagnosticSchedule_.shouldLog(signature.str(), diagnosticNowMs)) {
          std::ostringstream line;
          const char* severity = mode == "game" ? "info" : "warn";
          line << "[capture-health][" << severity << "] ts_ms=" << diagnosticNowMs
               << " capture_mode=" << mode << " subject_kind=none selected_backend=none"
               << " backend_ready_active=false frame_content_probe=unavailable" << colorDiagnosticsLocked();
          std::fprintf(stderr, "%s\n", line.str().c_str());
          std::fflush(stderr);
        }
      }
    }

    if (captureActivityCb_)
      captureActivityCb_(active);
    // Source teardown/re-injection can itself take seconds. Do not mistake
    // our own recovery work for another sleep and continuously rebuild.
    lastWatchdogTick = std::chrono::steady_clock::now();
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
#ifdef _WIN32
  if (displayNotification)
    PowerSettingUnregisterNotification(displayNotification);
  if (suspendNotification)
    PowerUnregisterSuspendResumeNotification(suspendNotification);
  obs_enter_graphics();
  gs_unregister_loss_callbacks(&recoveryState);
  obs_leave_graphics();
#endif
}

// ---------------------------------------------------------------- audio ----

void SourceManager::applyAudioSources()
{
  setAudioSources(config_.audioSources);
}

void SourceManager::setAudioSources(const std::vector<AudioSourceConfig>& sources)
{
  std::lock_guard<std::mutex> lock(sourceMutex_);

  audioIsolation_.stop();
  for (size_t i = 0; i < audioSources_.size(); i++) {
    if (audioItems_[i]) {
      obs_sceneitem_remove(audioItems_[i]);
    }
    if (audioSources_[i])
      obs_source_release(audioSources_[i]);
  }
  audioSources_.clear();
  audioItems_.clear();
  const bool allConfiguredSourcesDisabled =
      !sources.empty() && std::none_of(sources.begin(), sources.end(),
                                      [](const AudioSourceConfig& source) { return source.enabled; });

  const AudioRoutePlan routes = routeAudioSources(sources, processLoopbackSupported());
  if (routes.isolationUnavailable) {
    std::fprintf(stderr, "[audio-isolation][warn] event=isolation_state state=unavailable "
                         "reason=process_loopback_unsupported fallback=duplicate_capture "
                         "effect=\"isolated apps are also recorded in Desktop audio\"\n");
    std::fflush(stderr);
  }
  std::vector<IsolationRow> isolationRows;

  for (size_t configuredIndex = 0; configuredIndex < sources.size(); configuredIndex++) {
    const auto& c = sources[configuredIndex];
    const AudioRowRoute route = routes.routes[configuredIndex];
    if (route == AudioRowRoute::Disabled)
      continue;
    if (route == AudioRowRoute::IsolatedApp || route == AudioRowRoute::FilteredDesktop) {
      IsolationRow row;
      row.kind = route == AudioRowRoute::IsolatedApp ? IsolationRow::Kind::App : IsolationRow::Kind::Desktop;
      row.configuredIndex = configuredIndex;
      row.name = c.name;
      row.exe = route == AudioRowRoute::IsolatedApp ? isolationExeFromWindow(c.window) : std::string();
      row.deviceId = route == AudioRowRoute::FilteredDesktop ? c.id : std::string();
      row.gain = c.gain;
      isolationRows.push_back(std::move(row));
      continue;
    }

    obs_source_t* src = nullptr;
    if (route == AudioRowRoute::AppWindow) {
      obs_data_t* s = obs_data_create();
      obs_data_set_string(s, "window", c.window.empty() ? "::" : c.window.c_str());
      obs_data_set_bool(s, "use_device_timing", false);
      src = obs_source_create("wasapi_process_output_capture", c.name.c_str(), s, nullptr);
      obs_data_release(s);
    } else if (c.kind == "input") {
      obs_data_t* s = obs_data_create();
      obs_data_set_string(s, "device_id", c.id.c_str());
      obs_data_set_bool(s, "use_device_timing", false);
      src = obs_source_create("wasapi_input_capture", c.name.c_str(), s, nullptr);
      obs_data_release(s);
    } else {
      obs_data_t* s = obs_data_create();
      obs_data_set_string(s, "device_id", c.id.c_str());
      obs_data_set_bool(s, "use_device_timing", false);
      src = obs_source_create("wasapi_output_capture", c.name.c_str(), s, nullptr);
      obs_data_release(s);
    }

    if (!src)
      continue;

    obs_source_set_volume(src, c.gain);
    // Keep configured rows on stable mixes while toggled off. Ring and
    // recorder outputs allocate tracks from the configured row count, so an
    // enabled toggle can remove/re-add this source without restarting either
    // output or discarding buffered packets.
    obs_source_set_audio_mixers(src, audioMixersForRow(configuredIndex));
    obs_sceneitem_t* item = obs_scene_add(app_.scene(), src);
    audioSources_.push_back(src);
    audioItems_.push_back(item); // item may be null; harmless
  }

  const bool isolationOwnsRows = !isolationRows.empty();
  if (isolationOwnsRows)
    audioIsolation_.start(app_.scene(), std::move(isolationRows), routes.isolatedExes);

  // An empty configuration gets the safe default output. A non-empty list
  // with every row disabled is intentional silence and must not silently
  // re-enable the default device behind the UI toggle.
  if (audioSources_.empty() && !isolationOwnsRows && !allConfiguredSourcesDisabled) {
    obs_data_t* s = obs_data_create();
    obs_data_set_string(s, "device_id", "default");
    obs_data_set_bool(s, "use_device_timing", false);
    obs_source_t* src = obs_source_create("wasapi_output_capture", "Default output", s, nullptr);
    obs_data_release(s);
    if (src) {
      obs_source_set_volume(src, 1.0f);
      obs_source_set_audio_mixers(src, (1u << 0) | (1u << 1)); // master + track 1
      obs_sceneitem_t* item = obs_scene_add(app_.scene(), src);
      audioSources_.push_back(src);
      audioItems_.push_back(item);
    }
  }
}

// ------------------------------------------------------------- devices ----

nlohmann::json SourceManager::listDevices()
{
  nlohmann::json out = nlohmann::json::array();

#ifdef _WIN32
  HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  bool needUninit = SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE;
  if (hr == RPC_E_CHANGED_MODE) {
    // Already initialized as MTA on this thread; keep using it.
    needUninit = false;
  }

  IMMDeviceEnumerator* enumerator = nullptr;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                        (void**)&enumerator);
  if (SUCCEEDED(hr) && enumerator) {
    auto collect = [&](EDataFlow flow, bool isInput) {
      IMMDeviceCollection* collection = nullptr;
      if (FAILED(enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &collection)))
        return;
      UINT count = 0;
      collection->GetCount(&count);
      for (UINT i = 0; i < count; i++) {
        IMMDevice* device = nullptr;
        if (FAILED(collection->Item(i, &device)))
          continue;

        LPWSTR idW = nullptr;
        DWORD state = 0;
        if (SUCCEEDED(device->GetId(&idW)) && SUCCEEDED(device->GetState(&state))) {
          IPropertyStore* props = nullptr;
          std::string name = "Unknown device";
          if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &props))) {
            PROPVARIANT var;
            PropVariantInit(&var);
            if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &var)) && var.pwszVal)
              name = utf8FromWide(var.pwszVal);
            PropVariantClear(&var);
            props->Release();
          }
          std::string id;
          if (idW)
            id = utf8FromWide(idW);
          bool vm = name.find("voicemeeter") != std::string::npos ||
                    name.find("Voicemeeter") != std::string::npos ||
                    name.find("VOICEMEETER") != std::string::npos;
          out.push_back({{"id", id}, {"name", name}, {"isInput", isInput}, {"isVoicemeeter", vm}});
          CoTaskMemFree(idW);
        }
        device->Release();
      }
      collection->Release();
    };

    collect(eRender, false);
    collect(eCapture, true);

    enumerator->Release();
  }

  if (needUninit)
    CoUninitialize();
#endif
  return out;
}

nlohmann::json SourceManager::listMonitors() const
{
  nlohmann::json out = nlohmann::json::array();
  for (const auto& m : app_.monitors()) {
    out.push_back({{"index", m.index},
                   {"id", m.id},
                   {"name", m.name},
                   {"width", m.width},
                   {"height", m.height},
                   {"primary", m.primary}});
  }
  return out;
}

} // namespace shard
