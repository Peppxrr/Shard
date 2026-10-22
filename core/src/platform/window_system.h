// Top-level window information for game detection and capture targeting.
//
// Windows enumerates HWNDs. Linux (Wayland only) has no portable window API;
// the KDE Plasma implementation mirrors KWin's window list through a KWin
// script that reports to the core over the session D-Bus. Without a supported
// compositor windowInfoAvailable() is false and detection relies on process
// evidence alone.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace shard::platform {

struct TopLevelWindow {
  uintptr_t handle = 0; // opaque, stable while the window exists; never 0 for a real window
  uint32_t pid = 0;
  std::string title;
  std::string cls;      // Windows class name / Wayland app id (resourceClass)
  long area = 0;        // client area in physical pixels
  // Client rectangle in desktop coordinates (Windows: physical pixels;
  // KWin: logical pixels). 0 when unknown.
  int x = 0, y = 0, width = 0, height = 0;
  bool eligible = false;    // not cloaked/tool/notification: a candidate game surface
  bool minimized = false;
  bool onScreen = false;    // intersects a display
  bool fullscreen = false;
  bool captureable = false; // eligible && !minimized && onScreen && area >= 320x200
};

// Start/stop any background bridge (Linux: KWin script + D-Bus service).
// Safe to call repeatedly; queries before start() return empty results.
void startWindowSystem();
void stopWindowSystem();

// Whether the running desktop exposes window information at all.
bool windowInfoAvailable();

// Visible (non-hidden) top-level windows of every process, in stacking or
// enumeration order. Minimized windows are included with minimized=true.
// pid != 0 restricts the result to that process (filtered before any
// per-window queries).
std::vector<TopLevelWindow> listWindows(uint32_t pid = 0);

// Processes owning a visible, non-minimized top-level window of any
// eligibility. Cheaper than listWindows(): no per-window description.
std::vector<uint32_t> visibleWindowPids();

// Process owning the focused window; 0 when unknown.
uint32_t foregroundPid();

// Current state of one window; returns false when it no longer exists.
bool queryWindow(uintptr_t handle, TopLevelWindow& out);

} // namespace shard::platform
