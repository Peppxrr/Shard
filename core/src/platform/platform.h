// Process-level and libobs platform boundary.
//
// Shared core code calls these functions; exactly one implementation is
// compiled per target: platform/windows/*.cpp or platform/linux/*.cpp
// (selected in core/CMakeLists.txt). Implementations may keep private state
// but must not leak OS types through this header.
#pragma once

#include "system_info.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace shard {

struct MonitorInfo {
  int index = 0;
  std::string id;   // platform display id (Windows: GDI device interface id; Linux: output name)
  std::string name; // user-facing label
  uint32_t width = 0;
  uint32_t height = 0;
  bool primary = false;
};

namespace platform {

// First call in the process. Returns an exit code when argv selects a
// platform-only mode that replaces the core (Windows: Recording priority
// helpers and the process-tree supervisor parent).
std::optional<int> runPreCoreEntry(int argc, char** argv);

// Core process setup before logging/OBS (Windows: DPI awareness, elevated DLL
// search hardening; Linux: parent-death signal, SIGTERM/SIGINT handling).
void initCoreProcess();

// True once the OS asked the core to exit (Linux SIGTERM/SIGINT). The main
// loop treats it like the shutdown RPC.
bool terminationRequested();

// Before obs_startup: connect the platform display libobs renders with
// (Linux: Wayland display + OBS_NIX_PLATFORM_WAYLAND). False with `error`.
bool prepareObs(std::string& error);
// After obs_shutdown: release what prepareObs acquired.
void releaseObs();

// Load OBS modules from the staged runtime once the graphics device exists.
void loadObsModules(const std::string& coreBinDir);

// libobs graphics module for obs_video_info ("libobs-d3d11" / "libobs-opengl").
const char* graphicsModule();
// Adapter used for the libobs device; fixed for the device lifetime. `index`
// is what obs_video_info::adapter expects.
GraphicsAdapterInfo selectGraphicsAdapter();

// Displays in a stable order; index matches config.capture.monitor.
std::vector<MonitorInfo> listMonitors();

} // namespace platform
} // namespace shard
