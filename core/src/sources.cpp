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
  // Game window: WGC window_capture, no injection (works with anti-cheat and
  // borderless games). The target is set when a game subject appears; method
  // 2 = METHOD_WGC, priority 2 = WINDOW_PRIORITY_EXE.
  {
    obs_data_t* s = obs_data_create();
    obs_data_set_int(s, "method", 2);
    obs_data_set_int(s, "priority", 2);
    obs_data_set_bool(s, "cursor", true);
    obs_data_set_string(s, "window", "::");
    windowSource_ = obs_source_create("window_capture", "game-window", s, nullptr);
    obs_data_release(s);
  }

  if (monitorSource_)
    monitorItem_ = obs_scene_add(app_.scene(), monitorSource_);
  if (windowSource_)
    windowItem_ = obs_scene_add(app_.scene(), windowSource_);

  if (!monitorSource_ && !windowSource_) {
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
  pending_ = Subject{};
  pendingActive_ = false;
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
  const bool showWindow = subject_.kind == Subject::Kind::Window;
  if (monitorItem_) {
    obs_sceneitem_set_visible(monitorItem_, showMonitor);
    fillFrame(monitorItem_);
  }
  if (windowItem_) {
    obs_sceneitem_set_visible(windowItem_, showWindow);
    fillFrame(windowItem_);
  }
  if (showWindow)
    setWindowTargetLocked(subject_);
}

// Scale the item to fill the canvas (fit-to-screen, aspect preserved) so a
// capture smaller than the output (windowed game, secondary monitor) does
// not sit in a black corner.
void SourceManager::fillFrame(obs_sceneitem_t* item)
{
  if (!item)
    return;
  struct vec2 bounds = {(float)app_.baseWidth(), (float)app_.baseHeight()};
  obs_sceneitem_set_bounds(item, &bounds);
  obs_sceneitem_set_bounds_type(item, OBS_BOUNDS_SCALE_INNER);
}

void SourceManager::setWindowTargetLocked(const Subject& s)
{
  if (!windowSource_)
    return;
  const std::string desc = encodeWindowPart(s.title) + ":" + encodeWindowPart(s.cls) + ":" + encodeWindowPart(s.exe);
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

void SourceManager::onGameForegroundChanged(bool known, const std::string& exe, const std::string& name,
                                           uint32_t pid, const std::string& title, const std::string& cls,
                                           bool fullscreen)
{
  std::lock_guard<std::mutex> lock(sourceMutex_);
  if (config_.capture.mode == "screen")
    return; // monitor capture always wins in screen mode

  if (known || fullscreen) {
    // A game window is foreground.
    if (subject_.kind == Subject::Kind::Window && subject_.pid == pid) {
      // Same game refocused: cancel any pending switch.
      pendingActive_ = false;
      pending_ = Subject{};
      return;
    }
    Subject cand{Subject::Kind::Window, exe, title, cls, name.empty() ? exe : name, pid};
    if (subject_.kind != Subject::Kind::Window) {
      // Nothing / desktop was capturing: switch to the game immediately.
      subject_ = cand;
      applySubjectLocked();
      emitSubjectChanged();
    } else {
      // Another game took focus: debounce the switch (keep the buffer).
      pending_ = cand;
      pendingSince_ = std::chrono::steady_clock::now();
      pendingActive_ = true;
    }
  } else {
    // Foreground is not a game; an open game stays the subject until it exits.
    pendingActive_ = false;
    pending_ = Subject{};
  }
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
  while (watchdogRun_.load()) {
    const std::string mode = config_.capture.mode;
    {
      std::lock_guard<std::mutex> lock(sourceMutex_);
      // The game closed: switch to a pending game if one is open, else back
      // to desktop (auto) or nothing (game-only mode).
      if (subject_.kind == Subject::Kind::Window && !pidAlive(subject_.pid)) {
        if (pendingActive_ && pidAlive(pending_.pid)) {
          subject_ = pending_;
          pendingActive_ = false;
          pending_ = Subject{};
        } else if (mode == "auto") {
          subject_ = Subject{Subject::Kind::Monitor, "", "", "", "Desktop", 0};
        } else {
          subject_ = Subject{};
        }
        applySubjectLocked();
        emitSubjectChanged();
      }
      // Debounced multi-game switch: 10 s of the new game holding focus.
      if (pendingActive_ && subject_.kind == Subject::Kind::Window &&
          std::chrono::steady_clock::now() - pendingSince_ >= std::chrono::seconds(10)) {
        if (pidAlive(pending_.pid)) {
          subject_ = pending_;
          applySubjectLocked();
          emitSubjectChanged();
        }
        pendingActive_ = false;
        pending_ = Subject{};
      }
    }

    // Feed capture activity into the ring lifecycle every tick (the ring
    // evaluates its 15 s idle timeout on each call).
    bool active = false;
    {
      std::lock_guard<std::mutex> lock(sourceMutex_);
      active = (subject_.kind == Subject::Kind::Monitor) ||
               (subject_.kind == Subject::Kind::Window && pidAlive(subject_.pid));
    }
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
