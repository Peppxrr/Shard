#include "system_info.h"

#include <cstdio>

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

// processElevated, processPriorityClassName and hagsEnabled are implemented
// per platform (platform/<os>/platform_<os>.cpp).

} // namespace shard
