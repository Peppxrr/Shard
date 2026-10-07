#include "system_info.h"

#include <cstdio>

#ifdef _WIN32
#include <windows.h>
#include <winternl.h>
#include <d3dkmthk.h>
#endif

namespace shard {

std::string formatDriverVersion(uint64_t version, uint32_t vendorId)
{
  if (!version)
    return "unknown";
  const unsigned a = static_cast<unsigned>((version >> 48) & 0xffff);
  const unsigned b = static_cast<unsigned>((version >> 32) & 0xffff);
  const unsigned c = static_cast<unsigned>((version >> 16) & 0xffff);
  const unsigned d = static_cast<unsigned>(version & 0xffff);
  char text[64];
  if (vendorId == 0x10de) {
    // NVIDIA's public number is the last digit of the third field followed by
    // the four-digit fourth field: 32.0.16.1074 -> 610.74.
    const unsigned nvidia = (c % 10) * 10000 + d;
    std::snprintf(text, sizeof(text), "%u.%u.%u.%u (%u.%02u)", a, b, c, d, nvidia / 100, nvidia % 100);
  } else {
    std::snprintf(text, sizeof(text), "%u.%u.%u.%u", a, b, c, d);
  }
  return text;
}

const char* gpuVendorName(uint32_t vendorId)
{
  switch (vendorId) {
    case 0x10de: return "nvidia";
    case 0x1002:
    case 0x1022: return "amd";
    case 0x8086: return "intel";
    case 0: return "unknown";
    default: return "other";
  }
}

bool processElevated()
{
#ifdef _WIN32
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
    return false;
  TOKEN_ELEVATION elevation{};
  DWORD size = 0;
  const bool ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size) != FALSE;
  CloseHandle(token);
  return ok && elevation.TokenIsElevated != 0;
#else
  return false;
#endif
}

const char* processPriorityClassName()
{
#ifdef _WIN32
  switch (GetPriorityClass(GetCurrentProcess())) {
    case IDLE_PRIORITY_CLASS: return "idle";
    case BELOW_NORMAL_PRIORITY_CLASS: return "below_normal";
    case NORMAL_PRIORITY_CLASS: return "normal";
    case ABOVE_NORMAL_PRIORITY_CLASS: return "above_normal";
    case HIGH_PRIORITY_CLASS: return "high";
    case REALTIME_PRIORITY_CLASS: return "realtime";
    default: return "unknown";
  }
#else
  return "unknown";
#endif
}

std::optional<bool> hagsEnabled(uint64_t adapterLuid)
{
#ifdef _WIN32
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
#else
  (void)adapterLuid;
  return std::nullopt;
#endif
}

} // namespace shard
