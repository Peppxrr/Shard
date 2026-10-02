#pragma once

#include <cstdint>
#include <optional>
#include <string>

namespace shard {

struct CaptureDisplayState {
  uintptr_t monitor = 0;
  std::string name = "unknown";
  std::optional<bool> hdr;
  std::optional<bool> advancedColor;
};

// Resolve window subjects from their HWND, never the configured desktop or
// primary monitor. Injectable API boundaries exercise mixed-display selection
// without requiring an HDR monitor on the test machine.
template<class WindowMonitor, class DesktopMonitor>
uintptr_t selectCaptureMonitor(bool windowSubject, uintptr_t hwnd, int index,
                               WindowMonitor fromWindow, DesktopMonitor fromIndex)
{
  return windowSubject ? (hwnd ? fromWindow(hwnd) : 0) : fromIndex(index);
}

} // namespace shard
