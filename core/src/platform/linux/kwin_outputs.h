// Output layout mirrored from KWin by window_system_linux.cpp; used by
// capture_linux.cpp to map window geometry (KWin logical pixels) onto the
// desktop screencast (physical pixels).
#pragma once

#include <string>
#include <vector>

namespace shard::platform::kwin {

struct Output {
  std::string name; // connector name, same as MonitorInfo::id (wl_output name)
  int x = 0, y = 0, width = 0, height = 0; // logical pixels
  double scale = 1.0;
};

// Empty until the KWin script reported (or without KWin).
std::vector<Output> outputs();

} // namespace shard::platform::kwin
