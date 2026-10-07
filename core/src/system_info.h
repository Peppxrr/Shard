#pragma once

#include <cstdint>
#include <optional>
#include <string>

namespace shard {

// The D3D11 adapter selected for the libobs graphics device.
struct GraphicsAdapterInfo {
  uint32_t index = 0;        // EnumAdapters1 index passed to OBS
  uint64_t luid = 0;
  std::string name;
  uint32_t vendorId = 0;
  uint64_t driverVersion = 0; // DXGI user-mode driver version (aa.bb.cccc.dddd)
};

// "32.0.16.1074", with the vendor's own numbering appended when known
// (NVIDIA: "32.0.16.1074 (610.74)").
std::string formatDriverVersion(uint64_t version, uint32_t vendorId);
const char* gpuVendorName(uint32_t vendorId);

// True when this process token is elevated (administrator).
bool processElevated();
// CPU priority class of this process ("normal", "high", ...). Shard never
// changes it; this records what the launcher (e.g. Task Scheduler) gave us.
const char* processPriorityClassName();
// Hardware-accelerated GPU scheduling state of the adapter; nullopt when the
// driver or OS cannot report it.
std::optional<bool> hagsEnabled(uint64_t adapterLuid);

} // namespace shard
