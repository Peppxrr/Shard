#include "app.h"

#include "encoders.h"
#include "x265_encoder.h"
#include "capture_adapter.h"

#include <obs-module.h>
#include <algorithm>

#include <filesystem>
#include <unordered_map>

#ifdef _WIN32
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <iostream>
#endif

namespace shard {

namespace fs = std::filesystem;

#ifdef _WIN32
namespace {

std::string utf8FromWide(const wchar_t* value)
{
  if (!value || !*value)
    return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1)
    return {};
  std::string result(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), size, nullptr, nullptr);
  result.pop_back();
  return result;
}

uint64_t adapterLuid(LUID luid)
{
  return (static_cast<uint64_t>(static_cast<uint32_t>(luid.HighPart)) << 32) | luid.LowPart;
}

uint32_t automaticCaptureAdapter()
{
  using Microsoft::WRL::ComPtr;
  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
    std::cerr << "[capture-adapter] enumeration_failed selected_index=0 reason=dxgi_unavailable\n";
    return 0;
  }
  std::vector<CaptureAdapter> adapters;
  std::vector<DXGI_ADAPTER_DESC1> descriptions;
  for (UINT index = 0;; ++index) {
    ComPtr<IDXGIAdapter1> adapter;
    if (FAILED(factory->EnumAdapters1(index, &adapter))) break;
    DXGI_ADAPTER_DESC1 desc{};
    if (FAILED(adapter->GetDesc1(&desc))) continue;
    const bool software = (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0;
    const bool supported = !software && SUCCEEDED(D3D11CreateDevice(
        adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0, nullptr, 0,
        D3D11_SDK_VERSION, nullptr, nullptr, nullptr));
    adapters.push_back({index, adapterLuid(desc.AdapterLuid), desc.DedicatedVideoMemory, software, supported});
    descriptions.push_back(desc);
    std::cerr << "[capture-adapter] detected index=" << index << " name=\"" << utf8FromWide(desc.Description)
              << "\" vendor_id=" << desc.VendorId << " device_id=" << desc.DeviceId
              << " luid=" << adapterLuid(desc.AdapterLuid) << " dedicated_bytes=" << desc.DedicatedVideoMemory
              << " software=" << software << " d3d11=" << supported << '\n';
  }
  uint64_t preferred = 0;
  ComPtr<IDXGIFactory6> modernFactory;
  if (SUCCEEDED(factory.As(&modernFactory))) {
    for (UINT rank = 0;; ++rank) {
      ComPtr<IDXGIAdapter1> adapter;
      if (FAILED(modernFactory->EnumAdapterByGpuPreference(
              rank, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, IID_PPV_ARGS(&adapter)))) break;
      DXGI_ADAPTER_DESC1 desc{};
      if (FAILED(adapter->GetDesc1(&desc))) continue;
      const auto id = adapterLuid(desc.AdapterLuid);
      const auto usable = std::find_if(adapters.begin(), adapters.end(), [id](const auto& candidate) {
        return candidate.luid == id && !candidate.software && candidate.supportsD3D11;
      });
      if (usable != adapters.end()) { preferred = id; break; }
    }
  }
  const auto selected = selectCaptureAdapter(adapters, preferred);
  for (size_t i = 0; i < adapters.size(); ++i) {
    if (adapters[i].index != selected) continue;
    const auto& desc = descriptions[i];
    std::cerr << "[capture-adapter] selected_index=" << selected << " name=\"" << utf8FromWide(desc.Description)
              << "\" vendor_id=" << desc.VendorId << " luid=" << adapters[i].luid
              << " reason=" << (preferred ? "windows_high_performance" : "hardware_memory_fallback") << '\n';
  }
  return selected;
}

std::unordered_map<std::string, std::string> activeMonitorNames()
{
  UINT32 pathCount = 0;
  UINT32 modeCount = 0;
  if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &pathCount, &modeCount) != ERROR_SUCCESS)
    return {};

  std::vector<DISPLAYCONFIG_PATH_INFO> paths(pathCount);
  std::vector<DISPLAYCONFIG_MODE_INFO> modes(modeCount);
  if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &pathCount, paths.data(), &modeCount, modes.data(), nullptr) !=
      ERROR_SUCCESS)
    return {};

  std::unordered_map<std::string, std::string> names;
  for (UINT32 index = 0; index < pathCount; index++) {
    const auto& path = paths[index];
    DISPLAYCONFIG_SOURCE_DEVICE_NAME source = {};
    source.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
    source.header.size = sizeof(source);
    source.header.adapterId = path.sourceInfo.adapterId;
    source.header.id = path.sourceInfo.id;
    if (DisplayConfigGetDeviceInfo(&source.header) != ERROR_SUCCESS)
      continue;

    DISPLAYCONFIG_TARGET_DEVICE_NAME target = {};
    target.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
    target.header.size = sizeof(target);
    target.header.adapterId = path.targetInfo.adapterId;
    target.header.id = path.targetInfo.id;
    if (DisplayConfigGetDeviceInfo(&target.header) != ERROR_SUCCESS)
      continue;

    const std::string device = utf8FromWide(source.viewGdiDeviceName);
    const std::string friendly = utf8FromWide(target.monitorFriendlyDeviceName);
    if (!device.empty() && !friendly.empty())
      names.emplace(device, friendly);
  }
  return names;
}

struct MonitorEnumerationContext {
  std::vector<MonitorInfo>& displays;
  const std::unordered_map<std::string, std::string>& names;
};

} // namespace
#endif

App::App(Config& config, Events& events) : config_(config), events_(events) {}

App::~App()
{
  shutdown();
}

bool App::init()
{
  ok_ = false;
  shutdownDone_ = false;
  graphicsAdapterSelected_ = false;

  if (!startup())
    return false;
  if (!resetVideo())
    return false;
  if (!resetAudio())
    return false;

  // Load plugins after the graphics device exists: win-capture decides WGC
  // support at module load via gs_get_device_type() == D3D11, and without a
  // context it falls back to BitBlt (black captures for GPU-rendered windows).
  obs_load_all_modules();
  registerX265Encoder();

  scene_ = obs_scene_create("main");
  if (!scene_) {
    lastError_ = "obs_scene_create failed";
    return false;
  }

  // Render the scene into the main video mix. Without this the mix's view is
  // empty: render_main_texture clears to black and encodes black frames, and
  // scene audio sources are never activated (silent captures).
  obs_set_output_source(0, obs_scene_get_source(scene_));

  ok_ = true;
  return true;
}

bool App::startup()
{
  fs::create_directories(config_.configDir);

  if (!obs_startup("en-US", config_.configDir.c_str(), nullptr)) {
    lastError_ = "obs_startup failed";
    return false;
  }

  // Module paths: obs_startup already registered the platform defaults
  // ("../../obs-plugins/64bit" + "../../data/obs-plugins/%module%", relative
  // to the CWD). The core chdirs into <coreBin>/obs-plugins/64bit before
  // this runs (see main.cpp), so those defaults resolve to the staged
  // runtime. Adding the same paths explicitly here would register every
  // module twice; at obs_shutdown libobs bfrees each registered type's id,
  // and duplicated registrations share the same module-static id pointer —
  // a double free that corrupts the heap on exit.
  // libobs core data (effects, locales): <coreBin>/data/libobs. libobs's own
  // data lookup resolves "../../data/libobs" relative to the CWD; we still
  // add it explicitly so it works regardless of where the process was started.
  std::string libobsData = (fs::path(config_.coreBinDir) / "data" / "libobs").string();
  obs_add_data_path(libobsData.c_str());

  return true;
}

std::vector<MonitorInfo> App::monitors() const
{
  std::vector<MonitorInfo> result;
#ifdef _WIN32
  const auto names = activeMonitorNames();
  MonitorEnumerationContext context{result, names};
  EnumDisplayMonitors(
      nullptr, nullptr,
      [](HMONITOR monitor, HDC, LPRECT rect, LPARAM param) -> BOOL {
        auto& context = *reinterpret_cast<MonitorEnumerationContext*>(param);
        auto& displays = context.displays;
        const auto& names = context.names;
        MONITORINFOEXA monitorInfo = {};
        monitorInfo.cbSize = sizeof(monitorInfo);
        if (!GetMonitorInfoA(monitor, &monitorInfo))
          return TRUE;

        DISPLAY_DEVICEA device = {};
        device.cb = sizeof(device);
        EnumDisplayDevicesA(monitorInfo.szDevice, 0, &device, EDD_GET_DEVICE_INTERFACE_NAME);

        DEVMODEA mode = {};
        mode.dmSize = sizeof(mode);
        const bool haveMode = EnumDisplaySettingsA(monitorInfo.szDevice, ENUM_CURRENT_SETTINGS, &mode) != FALSE;

        MonitorInfo info;
        info.index = static_cast<int>(displays.size());
        info.id = device.DeviceID;
        const auto named = names.find(monitorInfo.szDevice);
        const std::string friendly =
            named != names.end() ? named->second : (device.DeviceString[0] ? device.DeviceString : "Monitor");
        info.name = friendly + " (" + monitorInfo.szDevice + ")";
        info.width = haveMode && mode.dmPelsWidth ? mode.dmPelsWidth : static_cast<uint32_t>(rect->right - rect->left);
        info.height =
            haveMode && mode.dmPelsHeight ? mode.dmPelsHeight : static_cast<uint32_t>(rect->bottom - rect->top);
        info.primary = (monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0;
        displays.push_back(std::move(info));
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&context));
#endif
  if (result.empty())
    result.push_back(MonitorInfo{0, "", "Display 1", baseWidth_, baseHeight_, true});
  return result;
}

bool App::resetVideo(uint32_t captureWidth, uint32_t captureHeight)
{
  struct obs_video_info ovi = {};
  ovi.graphics_module = "libobs-d3d11";
#ifdef _WIN32
  // obs_reset_video retains the existing graphics device. Keep the actual
  // adapter stable during canvas/output resets rather than claiming a new GPU.
  if (!graphicsAdapterSelected_) {
    graphicsAdapter_ = automaticCaptureAdapter();
    graphicsAdapterSelected_ = true;
  }
  ovi.adapter = graphicsAdapter_;
#endif
  ovi.fps_den = 1;

  // Match the OBS canvas to the configured desktop monitor. This avoids a
  // full-frame GPU scale on multi-monitor systems with different resolutions.
  const auto displays = monitors();
  auto selected = std::find_if(displays.begin(), displays.end(),
                               [this](const MonitorInfo& display) { return display.index == config_.capture.monitor; });
  if (selected == displays.end())
    selected = std::find_if(displays.begin(), displays.end(),
                            [](const MonitorInfo& display) { return display.primary; });
  if (captureWidth && captureHeight) {
    baseWidth_ = captureWidth;
    baseHeight_ = captureHeight;
  } else if (selected != displays.end()) {
    baseWidth_ = selected->width ? selected->width : 1920;
    baseHeight_ = selected->height ? selected->height : 1080;
  }
  ovi.base_width = baseWidth_;
  ovi.base_height = baseHeight_;

  // Output size/fps follow the preset; medium/high capture at the monitor's
  // native resolution (no downscale).
  int effW = 0, effH = 0, effFps = 0, effBitrate = 0;
  EncoderManager(config_).effectiveVideoParams(baseWidth_, baseHeight_, effW, effH, effFps, effBitrate);
  ovi.output_width = effW;
  ovi.output_height = effH;
  ovi.fps_num = (uint32_t)effFps;
  ovi.fps_den = 1;

  ovi.output_format = VIDEO_FORMAT_NV12;
  ovi.gpu_conversion = true;
  ovi.colorspace = VIDEO_CS_709;
  ovi.range = VIDEO_RANGE_PARTIAL;
  ovi.scale_type = OBS_SCALE_BILINEAR;

  int ret = obs_reset_video(&ovi);
  if (ret != OBS_VIDEO_SUCCESS) {
    lastError_ = "obs_reset_video failed: " + std::to_string(ret);
    return false;
  }
  return true;
}

bool App::resetAudio()
{
  struct obs_audio_info oai = {};
  oai.samples_per_sec = 48000;
  oai.speakers = SPEAKERS_STEREO;
  if (!obs_reset_audio(&oai)) {
    lastError_ = "obs_reset_audio failed";
    return false;
  }
  return true;
}

void App::shutdown()
{
  if (shutdownDone_)
    return;
  shutdownDone_ = true;
  if (!obs_initialized())
    return;

  if (scene_) {
    obs_set_output_source(0, nullptr); // release the view's ref before the scene
    obs_scene_release(scene_);
    scene_ = nullptr;
  }
  obs_shutdown();
}

} // namespace shard
