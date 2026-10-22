// Windows process/libobs/display boundary (platform/platform.h) and the
// Windows parts of system_info.h.

#include "platform/platform.h"

#include "capture_adapter.h"
#include "log.h"
#include "platform/windows/process_supervisor.h"
#include "platform/windows/win_util.h"
#include "priority_task.h"
#include "system_info.h"

#include <obs.h>

#include <windows.h>
#include <winternl.h>
#include <d3dkmthk.h>
#include <d3d11.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

#include <algorithm>
#include <sstream>
#include <unordered_map>

namespace shard {

namespace {

using win::utf8FromWide;

// The process must be DPI-aware for WGC window capture to work: from an
// unaware process on a scaled monitor, GetClientRect returns the *virtualized*
// (logical) client size while the WGC frame surface is physical, so the
// captured texture comes out 1/scale too small and the fit transform upscales
// it — window capture looks "zoomed in". Desktop (monitor) capture is
// unaffected because it has no per-window DPI involvement. OBS Studio ships
// DPI-aware; the core (no manifest) must opt in at startup, before any
// window is created. Per-monitor-aware-v2 (physical pixels on every monitor),
// falling back to system-aware on older systems.
void setProcessDpiAware()
{
  typedef BOOL(WINAPI * PFN_SetProcessDpiAwarenessContext)(HANDLE);
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (user32) {
    PFN_SetProcessDpiAwarenessContext setCtx =
        (PFN_SetProcessDpiAwarenessContext)GetProcAddress(user32, "SetProcessDpiAwarenessContext");
    if (setCtx && setCtx((HANDLE)-4)) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
      return;
  }
  SetProcessDPIAware();
}

uint64_t adapterLuid(LUID luid)
{
  return (static_cast<uint64_t>(static_cast<uint32_t>(luid.HighPart)) << 32) | luid.LowPart;
}

GraphicsAdapterInfo automaticCaptureAdapter()
{
  using Microsoft::WRL::ComPtr;
  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
    logLine("[capture-adapter] enumeration_failed selected_index=0 reason=dxgi_unavailable");
    return {};
  }
  std::vector<CaptureAdapter> adapters;
  std::vector<DXGI_ADAPTER_DESC1> descriptions;
  std::vector<uint64_t> driverVersions;
  for (UINT index = 0;; ++index) {
    ComPtr<IDXGIAdapter1> adapter;
    if (FAILED(factory->EnumAdapters1(index, &adapter))) break;
    DXGI_ADAPTER_DESC1 desc{};
    if (FAILED(adapter->GetDesc1(&desc))) continue;
    const bool software = (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0;
    const bool supported = !software && SUCCEEDED(D3D11CreateDevice(
        adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0, nullptr, 0,
        D3D11_SDK_VERSION, nullptr, nullptr, nullptr));
    LARGE_INTEGER umd{};
    driverVersions.push_back(SUCCEEDED(adapter->CheckInterfaceSupport(__uuidof(IDXGIDevice), &umd))
                                 ? static_cast<uint64_t>(umd.QuadPart) : 0);
    adapters.push_back({index, adapterLuid(desc.AdapterLuid), desc.DedicatedVideoMemory, software, supported});
    descriptions.push_back(desc);
    std::ostringstream line;
    line << "[capture-adapter] detected index=" << index << " name=\"" << utf8FromWide(desc.Description)
         << "\" vendor_id=" << desc.VendorId << " device_id=" << desc.DeviceId
         << " luid=" << adapterLuid(desc.AdapterLuid) << " dedicated_bytes=" << desc.DedicatedVideoMemory
         << " software=" << software << " d3d11=" << supported;
    logLine(line.str());
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
  GraphicsAdapterInfo info;
  info.index = selectCaptureAdapter(adapters, preferred);
  for (size_t i = 0; i < adapters.size(); ++i) {
    if (adapters[i].index != info.index) continue;
    const auto& desc = descriptions[i];
    info.luid = adapters[i].luid;
    info.name = utf8FromWide(desc.Description);
    info.vendorId = desc.VendorId;
    info.driverVersion = driverVersions[i];
    std::ostringstream line;
    line << "[capture-adapter] selected_index=" << info.index << " name=\"" << info.name
         << "\" vendor_id=" << desc.VendorId << " luid=" << adapters[i].luid
         << " driver=" << formatDriverVersion(info.driverVersion, info.vendorId)
         << " reason=" << (preferred ? "windows_high_performance" : "hardware_memory_fallback");
    logLine(line.str());
  }
  return info;
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

// ------------------------------------------------------------ system_info.h

bool processElevated()
{
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
    return false;
  TOKEN_ELEVATION elevation{};
  DWORD size = 0;
  const bool ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size) != FALSE;
  CloseHandle(token);
  return ok && elevation.TokenIsElevated != 0;
}

const char* processPriorityClassName()
{
  switch (GetPriorityClass(GetCurrentProcess())) {
    case IDLE_PRIORITY_CLASS: return "idle";
    case BELOW_NORMAL_PRIORITY_CLASS: return "below_normal";
    case NORMAL_PRIORITY_CLASS: return "normal";
    case ABOVE_NORMAL_PRIORITY_CLASS: return "above_normal";
    case HIGH_PRIORITY_CLASS: return "high";
    case REALTIME_PRIORITY_CLASS: return "realtime";
    default: return "unknown";
  }
}

std::optional<bool> hagsEnabled(uint64_t adapterLuid)
{
  if (!adapterLuid)
    return std::nullopt;
  D3DKMT_OPENADAPTERFROMLUID open{};
  open.AdapterLuid.LowPart = static_cast<DWORD>(adapterLuid & 0xffffffffu);
  open.AdapterLuid.HighPart = static_cast<LONG>(adapterLuid >> 32);
  if (D3DKMTOpenAdapterFromLuid(&open) != 0)
    return std::nullopt;
  D3DKMT_WDDM_2_7_CAPS caps{};
  D3DKMT_QUERYADAPTERINFO query{};
  query.hAdapter = open.hAdapter;
  query.Type = KMTQAITYPE_WDDM_2_7_CAPS;
  query.pPrivateDriverData = &caps;
  query.PrivateDriverDataSize = sizeof(caps);
  const NTSTATUS status = D3DKMTQueryAdapterInfo(&query);
  D3DKMT_CLOSEADAPTER close{open.hAdapter};
  D3DKMTCloseAdapter(&close);
  if (status != 0)
    return std::nullopt;
  return caps.HwSchEnabled != 0;
}

// --------------------------------------------------------------- platform.h

namespace platform {

std::optional<int> runPreCoreEntry(int argc, char** argv)
{
  // Recording priority helpers (status/install/bridge/elevated entry) run
  // instead of the core and never start the normal supervisor.
  if (const auto code = runPriorityMode(argc, argv))
    return code;
  if (!isSupervisedChild(argc, argv))
    return superviseProcessTree();
  return std::nullopt;
}

void initCoreProcess()
{
  setProcessDpiAware(); // before any window/obs_startup: WGC needs DPI awareness
  // An elevated core (Recording priority, or Shard run as administrator)
  // must never resolve DLLs from PATH or the working directory.
  if (processElevated())
    hardenElevatedDllSearch();
}

bool terminationRequested()
{
  return false;
}

bool prepareObs(std::string&)
{
  return true;
}

void releaseObs() {}

void loadObsModules(const std::string&)
{
  obs_load_all_modules();
}

const char* graphicsModule()
{
  return "libobs-d3d11";
}

GraphicsAdapterInfo selectGraphicsAdapter()
{
  return automaticCaptureAdapter();
}

std::vector<MonitorInfo> listMonitors()
{
  std::vector<MonitorInfo> result;
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
  return result;
}

} // namespace platform
} // namespace shard
