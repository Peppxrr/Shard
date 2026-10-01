#pragma once

#include <cstdint>
#include <vector>

namespace shard {

struct CaptureAdapter {
  uint32_t index = 0;
  uint64_t luid = 0;
  uint64_t dedicatedBytes = 0;
  bool software = false;
  bool supportsD3D11 = false;
};

// OBS uses EnumAdapters1 indices, not the reordered GPU-preference indices.
// Match Windows' preferred hardware by identity, with a vendor-neutral fallback
// on older systems where preference enumeration is unavailable.
inline uint32_t selectCaptureAdapter(const std::vector<CaptureAdapter>& adapters,
                                     uint64_t preferredLuid = 0) noexcept
{
  const CaptureAdapter* best = nullptr;
  for (const auto& adapter : adapters) {
    if (adapter.software || !adapter.supportsD3D11) continue;
    if (preferredLuid && adapter.luid == preferredLuid) return adapter.index;
    if (!best || adapter.dedicatedBytes > best->dedicatedBytes) best = &adapter;
  }
  return best ? best->index : 0;
}

} // namespace shard
