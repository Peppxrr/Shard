// Windows capture backend (platform/capture_backend.h): WGC monitor/window
// capture, the official signed game_capture hook, DWM geometry, display HDR
// state, power/device-loss notifications and WASAPI audio.

#include "platform/capture_backend.h"

#include "capture_resilience.h"
#include "log.h"
#include "platform/windows/win_util.h"

#include <obs-module.h>

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

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <iterator>
#include <vector>

namespace shard::capture {

namespace {

using win::utf8FromWide;

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

std::string windowDescriptor(const CaptureSubject& subject)
{
  return encodeWindowPart(subject.title) + ":" + encodeWindowPart(subject.cls) + ":" + encodeWindowPart(subject.exe);
}

// Both modern OBS 32.2.1 capture sources expose this boolean and pass it
// to libobs-winrt, which selects BGRA8 before allocating the WGC frame pool.
// Shard outputs Rec.709 SDR, including when Windows displays HDR content.
void setWgcSdrSettings(obs_data_t* settings)
{
  obs_data_set_bool(settings, "force_sdr", true);
}

bool gameCaptureDiagnostics()
{
  const char* diagnostics = std::getenv("SHARD_GAME_CAPTURE_DIAGNOSTICS");
  return diagnostics && *diagnostics && std::string(diagnostics) != "0";
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

// Desktop: WGC monitor capture of the configured monitor. With graphics
// initialized before module load, "monitor_capture" is the WGC duplicator,
// which targets monitors by device-id string ("monitor_id"); the legacy
// BitBlt implementation used the "monitor" index. Set both.
obs_data_t* desktopSettings(const Config& config)
{
  obs_data_t* s = obs_data_create();
  const std::string devId = monitorDeviceId(config.capture.monitor);
  if (!devId.empty())
    obs_data_set_string(s, "monitor_id", devId.c_str());
  obs_data_set_int(s, "monitor", config.capture.monitor);
  obs_data_set_int(s, "method", 2); // METHOD_WGC
  obs_data_set_bool(s, "capture_cursor", true);
  setWgcSdrSettings(s);
  return s;
}

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

obs_source_t* createWasapiSource(const char* id, const std::string& deviceId, const std::string& name)
{
  obs_data_t* s = obs_data_create();
  obs_data_set_string(s, "device_id", deviceId.c_str());
  obs_data_set_bool(s, "use_device_timing", false);
  obs_source_t* src = obs_source_create(id, name.c_str(), s, nullptr);
  obs_data_release(s);
  return src;
}

} // namespace

const MethodNames& methodNames()
{
  static const MethodNames names{"wgc_monitor", "wgc_window", "game_capture", "WGC"};
  return names;
}

// ---------------------------------------------------------------- sources --

obs_source_t* createDesktopSource(const Config& config)
{
  obs_data_t* s = desktopSettings(config);
  obs_source_t* source = obs_source_create("monitor_capture", "monitor-capture", s, nullptr);
  obs_data_release(s);
  return source;
}

void retryDesktopSource(obs_source_t* desktop, const Config& config)
{
  obs_data_t* settings = desktopSettings(config);
  obs_source_update(desktop, settings);
  obs_data_release(settings);
}

void persistDesktopState(obs_source_t*, const Config&) {}

obs_source_t* createHookSource()
{
  obs_data_t* s = obs_data_create();
  obs_data_set_string(s, "capture_mode", "window");
  obs_data_set_int(s, "priority", 2);
  obs_data_set_bool(s, "capture_cursor", true);
  obs_data_set_bool(s, "anti_cheat_hook", true);
  obs_data_set_int(s, "hook_rate", 1);
  obs_data_set_bool(s, "shard_gc_diagnostics", gameCaptureDiagnostics());
  obs_data_set_string(s, "window", "::");
  obs_source_t* source = obs_source_create("game_capture", "game-capture", s, nullptr);
  obs_data_release(s);
  return source;
}

obs_source_t* createWindowSource(obs_source_t*)
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
  obs_source_t* source = obs_source_create("window_capture", "game-window", s, nullptr);
  obs_data_release(s);
  return source;
}

void targetGameSources(obs_source_t* window, obs_source_t* hook, const CaptureSubject& subject)
{
  const std::string desc = windowDescriptor(subject);
  obs_data_t* d = obs_data_create();
  obs_data_set_string(d, "window", desc.c_str());
  if (window) {
    obs_data_t* windowSettings = obs_data_create();
    obs_data_apply(windowSettings, d);
    setWgcSdrSettings(windowSettings);
    obs_source_update(window, windowSettings);
    obs_data_release(windowSettings);
  }
  if (hook)
    obs_source_update(hook, d);
  obs_data_release(d);
}

void retryWindowSource(obs_source_t* window, const CaptureSubject& subject)
{
  const std::string desc = windowDescriptor(subject);
  obs_data_t* d = obs_data_create();
  obs_data_set_string(d, "window", desc.c_str());
  setWgcSdrSettings(d);
  obs_source_update(window, d);
  obs_data_release(d);
}

std::string retryHookSource(obs_source_t* hook, const CaptureSubject& subject)
{
  const std::string desc = windowDescriptor(subject);
  obs_data_t* d = obs_data_create();
  obs_data_set_string(d, "window", desc.c_str());
  obs_source_update(hook, d);
  obs_data_release(d);
  return desc;
}

bool windowSourceIsIndependent()
{
  return true;
}

bool hookRecreationResets()
{
  return true;
}

std::string hookUnavailableReason(uint32_t)
{
  return {};
}

// ---------------------------------------------------------------- targets --

uintptr_t findSubjectWindow(const CaptureSubject& subject)
{
  struct Candidate {
    const CaptureSubject* subject;
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

  return reinterpret_cast<uintptr_t>(candidate.window);
}

bool windowMinimized(uintptr_t window)
{
  const HWND hwnd = reinterpret_cast<HWND>(window);
  return hwnd && IsIconic(hwnd);
}

bool windowLiveForPid(uintptr_t window, uint32_t pid)
{
  DWORD targetPid = 0;
  const HWND currentWindow = reinterpret_cast<HWND>(window);
  return currentWindow && IsWindow(currentWindow) && IsWindowVisible(currentWindow) &&
         GetWindowThreadProcessId(currentWindow, &targetPid) && targetPid == pid;
}

std::optional<WindowIdentity> windowIdentity(uintptr_t window)
{
  const HWND hwnd = reinterpret_cast<HWND>(window);
  if (!hwnd || !IsWindow(hwnd))
    return std::nullopt;
  wchar_t title[512] = {}, cls[256] = {};
  GetWindowTextW(hwnd, title, static_cast<int>(std::size(title)));
  GetClassNameW(hwnd, cls, static_cast<int>(std::size(cls)));
  return WindowIdentity{utf8FromWide(title), utf8FromWide(cls)};
}

std::optional<CaptureSize> windowClientSize(uintptr_t window)
{
  const HWND hwnd = reinterpret_cast<HWND>(window);
  RECT client = {};
  if (!hwnd || !IsWindow(hwnd) || !GetClientRect(hwnd, &client))
    return std::nullopt;
  return CaptureSize{static_cast<uint32_t>(std::max<LONG>(0, client.right - client.left)),
                     static_cast<uint32_t>(std::max<LONG>(0, client.bottom - client.top))};
}

WindowSceneCrop windowSceneCrop(uintptr_t windowHandle, uint32_t sourceWidth, uint32_t sourceHeight)
{
  WindowSceneCrop result;
  const HWND window = reinterpret_cast<HWND>(windowHandle);
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
      result.valid = true;
      result.left = crop.left;
      result.top = crop.top;
      result.right = crop.right;
      result.bottom = crop.bottom;
      // The small caption-boundary inset is display cleanup, not a change
      // in the game's aspect ratio. Keep video geometry consistent with
      // the hook/client so fallback switching cannot discard replay history.
      const auto clientCrop = computeClientAreaCrop(sourceWidth, sourceHeight, frame.left, frame.top,
          clientOrigin.x, clientOrigin.y, client.right - client.left, clientHeight);
      if (clientCrop.valid)
        result.clientSize = {sourceWidth - clientCrop.left - clientCrop.right,
                             sourceHeight - clientCrop.top - clientCrop.bottom};
    }
  }
  return result;
}

// OBS exposes metadata read from its actual wc->window through get_hooked,
// but no numeric HWND. Resolve that metadata uniquely within the target PID.
// Ambiguous/missing matches stay unknown rather than reporting another window's
// monitor. Before OBS acquires a target, use Shard's resolved target HWND.
std::optional<uintptr_t> acquiredWindow(obs_source_t* source, uint32_t pid)
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

uintptr_t displayForTarget(bool windowSubject, uintptr_t window, int monitorIndex)
{
  return selectCaptureMonitor(windowSubject, window, monitorIndex,
      [](uintptr_t hwnd) {
        const HWND window = reinterpret_cast<HWND>(hwnd);
        return IsWindow(window) ? reinterpret_cast<uintptr_t>(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST)) : 0;
      },
      [](int index) { return reinterpret_cast<uintptr_t>(monitorHandle(index)); });
}

CaptureDisplayState queryCaptureDisplay(uintptr_t display)
{
  const HMONITOR monitor = reinterpret_cast<HMONITOR>(display);
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

bool processAlive(uint32_t pid)
{
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
}

// ------------------------------------------------------- system events ---

struct SystemEventSubscription::Impl {
  CaptureRecoveryState* state = nullptr;
  gs_device_loss graphicsRecovery = {};
  DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS powerSubscription = {};
  HPOWERNOTIFY displayNotification = nullptr;
  HPOWERNOTIFY suspendNotification = nullptr;
};

SystemEventSubscription::SystemEventSubscription(CaptureRecoveryState& state) : impl_(std::make_unique<Impl>())
{
  impl_->state = &state;
  // Shared hook textures may fail to reopen during a D3D11 device reset
  // while game_capture still reports its previous dimensions. Recreate the
  // sources after OBS has rebuilt its device, outside the graphics callback.
  impl_->graphicsRecovery.data = &state;
  impl_->graphicsRecovery.device_loss_release = [](void*) {};
  impl_->graphicsRecovery.device_loss_rebuild = [](void*, void* data) {
    static_cast<CaptureRecoveryState*>(data)->onGraphicsRebuilt();
  };
  obs_enter_graphics();
  gs_register_loss_callbacks(&impl_->graphicsRecovery);
  obs_leave_graphics();
  impl_->powerSubscription.Callback = capturePowerCallback;
  impl_->powerSubscription.Context = &state;
  const DWORD displayResult = PowerSettingRegisterNotification(&GUID_CONSOLE_DISPLAY_STATE, DEVICE_NOTIFY_CALLBACK,
                                       reinterpret_cast<HANDLE>(&impl_->powerSubscription),
                                       &impl_->displayNotification);
  if (displayResult != ERROR_SUCCESS) {
    logFormat("capture: display notification registration failed (%lu)", displayResult);
    impl_->displayNotification = nullptr;
  }
  const DWORD suspendResult = PowerRegisterSuspendResumeNotification(DEVICE_NOTIFY_CALLBACK,
                                             reinterpret_cast<HANDLE>(&impl_->powerSubscription),
                                             &impl_->suspendNotification);
  if (suspendResult != ERROR_SUCCESS) {
    logFormat("capture: suspend notification registration failed (%lu)", suspendResult);
    impl_->suspendNotification = nullptr;
  }
}

SystemEventSubscription::~SystemEventSubscription()
{
  if (impl_->displayNotification)
    PowerSettingUnregisterNotification(impl_->displayNotification);
  if (impl_->suspendNotification)
    PowerUnregisterSuspendResumeNotification(impl_->suspendNotification);
  obs_enter_graphics();
  gs_unregister_loss_callbacks(impl_->state);
  obs_leave_graphics();
}

// ------------------------------------------------------------------ audio --

nlohmann::json listAudioDevices()
{
  nlohmann::json out = nlohmann::json::array();

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
  return out;
}

obs_source_t* createAudioDeviceSource(bool input, const std::string& deviceId, const std::string& name)
{
  return createWasapiSource(input ? "wasapi_input_capture" : "wasapi_output_capture", deviceId, name);
}

obs_source_t* createAppAudioSource(const std::string& window, const std::string& name)
{
  obs_data_t* s = obs_data_create();
  obs_data_set_string(s, "window", window.empty() ? "::" : window.c_str());
  obs_data_set_bool(s, "use_device_timing", false);
  obs_source_t* src = obs_source_create("wasapi_process_output_capture", name.c_str(), s, nullptr);
  obs_data_release(s);
  return src;
}

} // namespace shard::capture
