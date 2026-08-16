#include "sources.h"

#include <obs-module.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#endif

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstdio>
#include <iterator>

namespace clipforge {

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

bool subjectWindowMinimized(const SourceManager::Subject& subject)
{
#ifdef _WIN32
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

  return candidate.window && IsIconic(candidate.window);
#else
  (void)subject;
  return false;
#endif
}

} // namespace

SourceManager::SourceManager(App& app, Config& config, Events& events)
    : app_(app), config_(config), events_(events)
{
}

SourceManager::~SourceManager()
{
  stopWatchdog();
  removeVideoSourceItem();
  for (size_t i = 0; i < audioSources_.size(); i++) {
    if (audioItems_[i]) {
      obs_sceneitem_remove(audioItems_[i]);
      obs_sceneitem_release(audioItems_[i]);
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
  if (monitorItem_) {
    obs_sceneitem_remove(monitorItem_);
    obs_sceneitem_release(monitorItem_);
    monitorItem_ = nullptr;
  }
  if (monitorSource_) {
    obs_source_release(monitorSource_);
    monitorSource_ = nullptr;
  }
  if (gameItem_) {
    obs_sceneitem_remove(gameItem_);
    obs_sceneitem_release(gameItem_);
    gameItem_ = nullptr;
  }
  if (gameSource_) {
    obs_source_release(gameSource_);
    gameSource_ = nullptr;
  }
  if (windowItem_) {
    obs_sceneitem_remove(windowItem_);
    obs_sceneitem_release(windowItem_);
    windowItem_ = nullptr;
  }
  if (windowSource_) {
    obs_source_release(windowSource_);
    windowSource_ = nullptr;
  }
}

void SourceManager::releaseAll()
{
  std::lock_guard<std::mutex> lock(sourceMutex_);
  removeVideoSourceItem();

  for (size_t i = 0; i < audioSources_.size(); i++) {
    if (audioItems_[i]) {
      obs_sceneitem_remove(audioItems_[i]);
      obs_sceneitem_release(audioItems_[i]);
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
    monitorSource_ = obs_source_create("monitor_capture", "monitor-capture", s, nullptr);
    obs_data_release(s);
  }
  // Games use two layered backends. The injected OBS game hook keeps the
  // graphics texture alive while a game renders in the background/minimized.
  // WGC is layered above it for non-injectable and anti-cheat-protected games.
  {
    obs_data_t* s = obs_data_create();
    obs_data_set_string(s, "capture_mode", "window");
    obs_data_set_int(s, "priority", 2); // WINDOW_PRIORITY_EXE
    obs_data_set_bool(s, "capture_cursor", true);
    obs_data_set_bool(s, "anti_cheat_hook", true);
    obs_data_set_int(s, "hook_rate", 1); // HOOK_RATE_NORMAL
    const char* diagnostics = std::getenv("SHARD_GAME_CAPTURE_DIAGNOSTICS");
    obs_data_set_bool(s, "shard_gc_diagnostics", diagnostics && *diagnostics && std::string(diagnostics) != "0");
    obs_data_set_string(s, "window", "::");
    gameSource_ = obs_source_create("game_capture", "game-capture", s, nullptr);
    obs_data_release(s);
  }
  // WGC window capture remains the primary visible-window path. The target is
  // set when a game subject appears; method 2 = METHOD_WGC.
  {
    obs_data_t* s = obs_data_create();
    obs_data_set_int(s, "method", 2);
    obs_data_set_int(s, "priority", 2);
    obs_data_set_bool(s, "cursor", true);
    // Capture the complete WGC surface. Client-area cropping depends on a
    // Win32 client rect matching the compositor texture; borderless games can
    // report an unusable rect and otherwise never produce a texture.
    obs_data_set_bool(s, "client_area", false);
    obs_data_set_string(s, "window", "::");
    windowSource_ = obs_source_create("window_capture", "game-window", s, nullptr);
    obs_data_release(s);
  }

  if (monitorSource_)
    monitorItem_ = obs_scene_add(app_.scene(), monitorSource_);
  // Scene rendering is bottom-to-top: the game hook sits below WGC. When a
  // minimized WGC source draws nothing, the hooked texture remains visible.
  if (gameSource_)
    gameItem_ = obs_scene_add(app_.scene(), gameSource_);
  if (windowSource_)
    windowItem_ = obs_scene_add(app_.scene(), windowSource_);

  if (!monitorSource_ && !windowSource_ && !gameSource_) {
    events_.emit("error", {{"code", "CAPTURE_INIT_FAILED"}, {"message", "Could not create capture sources"}});
    return;
  }

  // Re-evaluate the subject for the current mode.
  const std::string mode = config_.capture.mode;
  if (mode == "screen") {
    subject_ = Subject{Subject::Kind::Monitor, "", "", "", "Desktop", 0};
  } else if (subject_.kind == Subject::Kind::Window && pidAlive(subject_.pid)) {
    // keep an existing game subject
  } else if (mode == "auto") {
    subject_ = Subject{Subject::Kind::Monitor, "", "", "", "Desktop", 0};
  } else {
    subject_ = Subject{};
  }
  applySubjectLocked();
  emitSubjectChanged();
}

bool SourceManager::pidAlive(uint32_t pid)
{
  if (pid == 0)
    return false;
#ifdef _WIN32
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h)
    return false;
  CloseHandle(h);
  return true;
#else
  return false;
#endif
}

void SourceManager::applySubjectLocked()
{
  const bool showMonitor = subject_.kind == Subject::Kind::Monitor;
  const bool showGame = subject_.kind == Subject::Kind::Window;
  if (showGame)
    setWindowTargetLocked(subject_);
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
    fillFrame(windowItem_);
  }
}

// Fit a capture to the canvas without cropping it. Bounds-based transforms
// work for desktop capture, but a WGC window source begins life at 0x0 and can
// retain its unscaled transform until its first frame arrives. Set an explicit
// source-size-based transform once dimensions are available instead.
void SourceManager::fillFrame(obs_sceneitem_t* item)
{
  if (!item)
    return;

  obs_source_t* source = obs_sceneitem_get_source(item);
  const uint32_t sourceWidth = source ? obs_source_get_width(source) : 0;
  const uint32_t sourceHeight = source ? obs_source_get_height(source) : 0;
  if (sourceWidth && sourceHeight) {
    const float canvasWidth = (float)app_.baseWidth();
    const float canvasHeight = (float)app_.baseHeight();
    const float scale = std::min(canvasWidth / (float)sourceWidth, canvasHeight / (float)sourceHeight);
    struct vec2 itemScale = {scale, scale};
    struct vec2 pos = {(canvasWidth - (float)sourceWidth * scale) / 2.0f,
                       (canvasHeight - (float)sourceHeight * scale) / 2.0f};

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

void SourceManager::setWindowTargetLocked(const Subject& s)
{
  if (!windowSource_ && !gameSource_)
    return;
  const std::string desc = encodeWindowPart(s.title) + ":" + encodeWindowPart(s.cls) + ":" + encodeWindowPart(s.exe);
  obs_data_t* d = obs_data_create();
  obs_data_set_string(d, "window", desc.c_str());
  if (windowSource_)
    obs_source_update(windowSource_, d);
  if (gameSource_)
    obs_source_update(gameSource_, d);
  obs_data_release(d);

  const auto now = std::chrono::steady_clock::now();
  captureHealthyAt_ = now;
  lastWindowRetry_ = now;
  windowNoFramesReported_ = false;
  windowSuppressedForMinimize_ = false;
}

void SourceManager::retryWindowCaptureLocked()
{
  if (!windowSource_ || subject_.kind != Subject::Kind::Window)
    return;
  const std::string desc = encodeWindowPart(subject_.title) + ":" + encodeWindowPart(subject_.cls) + ":" +
                           encodeWindowPart(subject_.exe);
  obs_data_t* d = obs_data_create();
  obs_data_set_string(d, "window", desc.c_str());
  obs_source_update(windowSource_, d);
  obs_data_release(d);
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
  if (config_.capture.mode == "screen")
    return; // monitor capture always wins in screen mode

  Subject cand{Subject::Kind::Window, exe, title, cls, name.empty() ? exe : name, pid};
  if (subject_ == cand)
    return;

  const bool visibleIdentityChanged =
      subject_.kind != Subject::Kind::Window || subject_.pid != cand.pid || subject_.name != cand.name;
  subject_ = std::move(cand);
  applySubjectLocked();
  if (visibleIdentityChanged)
    emitSubjectChanged();
}

void SourceManager::clearGameSubject()
{
  std::lock_guard<std::mutex> lock(sourceMutex_);
  if (subject_.kind != Subject::Kind::Window)
    return;
  if (config_.capture.mode == "auto") {
    subject_ = Subject{Subject::Kind::Monitor, "", "", "", "Desktop", 0};
  } else {
    subject_ = Subject{};
  }
  applySubjectLocked();
  emitSubjectChanged();
}

void SourceManager::startWatchdog()
{
  if (watchdogRun_.exchange(true))
    return;
  watchdogThread_ = std::thread([this] { watchdogLoop(); });
}

void SourceManager::stopWatchdog()
{
  if (!watchdogRun_.exchange(false))
    return;
  if (watchdogThread_.joinable())
    watchdogThread_.join();
}

void SourceManager::watchdogLoop()
{
  constexpr auto kWindowRetryDelay = std::chrono::seconds(3);
  constexpr auto kWindowNoFramesDelay = std::chrono::seconds(10);

  while (watchdogRun_.load()) {
    const std::string mode = config_.capture.mode;
    bool active = false;
    {
      std::lock_guard<std::mutex> lock(sourceMutex_);
      // Safety net: the game process died without a clearGameSubject
      // (missed exit event) — fall back to desktop (auto) or nothing.
      if (subject_.kind == Subject::Kind::Window && !pidAlive(subject_.pid)) {
        if (mode == "auto") {
          subject_ = Subject{Subject::Kind::Monitor, "", "", "", "Desktop", 0};
        } else {
          subject_ = Subject{};
        }
        applySubjectLocked();
        emitSubjectChanged();
      }

      if (subject_.kind == Subject::Kind::Monitor) {
        active = monitorSource_ != nullptr;
      } else if (subject_.kind == Subject::Kind::Window && pidAlive(subject_.pid)) {
        const bool minimized = subjectWindowMinimized(subject_);
        if (windowSuppressedForMinimize_ != minimized) {
          windowSuppressedForMinimize_ = minimized;
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
        const bool gameReady = gameWidth && gameHeight;
        const auto now = std::chrono::steady_clock::now();

        if (usableWindowReady || gameReady) {
          // WGC normally supplies the visible window. On true minimization it
          // retains an opaque final texture, so hide that scene item and expose
          // the still-updating injected Game Capture source underneath.
          active = true;
          captureHealthyAt_ = now;
          lastWindowRetry_ = now;
          windowNoFramesReported_ = false;
          if (gameReady)
            fillFrame(gameItem_);
          if (usableWindowReady)
            fillFrame(windowItem_);
        } else {
          if (captureHealthyAt_.time_since_epoch().count() == 0)
            captureHealthyAt_ = now;
          if (lastWindowRetry_.time_since_epoch().count() == 0)
            lastWindowRetry_ = now;

          // OBS's WGC source stops retrying after WinRT initialization fails
          // once. Re-applying the target invokes its force_reset path. The
          // game hook retries independently inside the win-capture plugin.
          if (now - captureHealthyAt_ >= kWindowRetryDelay && now - lastWindowRetry_ >= kWindowRetryDelay) {
            retryWindowCaptureLocked();
            lastWindowRetry_ = now;
          }

          if (now - captureHealthyAt_ >= kWindowNoFramesDelay && !windowNoFramesReported_) {
            events_.emit("error",
                         {{"code", "CAPTURE_NO_FRAMES"},
                          {"message", "Capture for " + subject_.name +
                                          " is not producing frames through either game capture or WGC; recovery "
                                          "is still retrying"}});
            windowNoFramesReported_ = true;
          }
        }
      }
    }

    // Feed only healthy capture into the ring lifecycle. A minimized game
    // remains healthy through the injected hook even though WGC is 0x0.
    if (captureActivityCb_)
      captureActivityCb_(active);
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
}

// ---------------------------------------------------------------- audio ----

void SourceManager::applyAudioSources()
{
  setAudioSources(config_.audioSources);
}

void SourceManager::setAudioSources(const std::vector<AudioSourceConfig>& sources)
{
  std::lock_guard<std::mutex> lock(sourceMutex_);

  for (size_t i = 0; i < audioSources_.size(); i++) {
    if (audioItems_[i]) {
      obs_sceneitem_remove(audioItems_[i]);
      obs_sceneitem_release(audioItems_[i]);
    }
    if (audioSources_[i])
      obs_source_release(audioSources_[i]);
  }
  audioSources_.clear();
  audioItems_.clear();

  for (const auto& c : sources) {
    if (!c.enabled)
      continue;

    obs_source_t* src = nullptr;
    if (c.kind == "process") {
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
    // Each enabled source gets its own audio track (1-based, capped at the
    // 6-mix limit) in addition to the master mix (track 0) so recordings can
    // be split per source. The ring/recorder create an encoder per used mix.
    int track = (int)audioSources_.size() + 1;
    if (track > 5)
      track = 5;
    obs_source_set_audio_mixers(src, (1u << 0) | (1u << (unsigned)track));
    obs_sceneitem_t* item = obs_scene_add(app_.scene(), src);
    audioSources_.push_back(src);
    audioItems_.push_back(item); // item may be null; harmless
  }

  // Never run silent: with no configured/enabled sources, capture the default
  // output device so clips always have audio.
  if (audioSources_.empty()) {
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

} // namespace clipforge
