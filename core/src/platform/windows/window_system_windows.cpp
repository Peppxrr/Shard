// Windows top-level window information (platform/window_system.h): HWND
// enumeration with the same probing GameSystem used for game detection.

#include "platform/window_system.h"

#include "platform/windows/win_util.h"

#include <windows.h>
#include <dwmapi.h>

#include <set>

namespace shard::platform {

namespace {

// Fills `out` for one top-level window. Mirrors the original GameSystem
// probe: eligibility excludes cloaked, tool and no-activate windows.
void describeWindow(HWND h, TopLevelWindow& out)
{
  out = {};
  out.handle = reinterpret_cast<uintptr_t>(h);
  DWORD wpid = 0;
  GetWindowThreadProcessId(h, &wpid);
  out.pid = wpid;
  const bool visible = IsWindowVisible(h) != FALSE;
  DWORD cloaked = 0;
  const bool isCloaked = SUCCEEDED(DwmGetWindowAttribute(h, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked;
  const LONG_PTR exStyles = GetWindowLongPtr(h, GWL_EXSTYLE);
  out.eligible = visible && !isCloaked && (exStyles & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) == 0;

  wchar_t titleW[512] = {0};
  if (GetWindowTextW(h, titleW, 512) > 0)
    out.title = win::utf8FromWide(titleW);
  wchar_t clsW[256] = {0};
  if (GetClassNameW(h, clsW, 256) > 0)
    out.cls = win::utf8FromWide(clsW);

  RECT client = {};
  POINT origin = {};
  if (GetClientRect(h, &client) && ClientToScreen(h, &origin)) {
    out.x = origin.x;
    out.y = origin.y;
    out.width = client.right - client.left;
    out.height = client.bottom - client.top;
  }

  RECT rect;
  if (GetWindowRect(h, &rect)) {
    RECT clientArea = {};
    if (GetClientRect(h, &clientArea))
      out.area = (long)(clientArea.right - clientArea.left) * (long)(clientArea.bottom - clientArea.top);
    // Minimized windows report an off-screen icon rect — IsIconic is the
    // reliable check. onScreen = the window rect intersects a monitor.
    out.minimized = IsIconic(h) != 0;
    out.onScreen = MonitorFromRect(&rect, MONITOR_DEFAULTTONULL) != nullptr;
    out.captureable = out.eligible && !out.minimized && out.onScreen && out.area >= (long)320 * 200;
    DWORD styles = (DWORD)GetWindowLongPtr(h, GWL_STYLE);
    bool maximized = (styles & WS_MAXIMIZE) != 0 && (styles & WS_BORDER) != 0;
    if (!maximized) {
      HMONITOR monitor = MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST);
      MONITORINFO mi = {};
      mi.cbSize = sizeof(mi);
      if (monitor && GetMonitorInfo(monitor, &mi)) {
        out.fullscreen = rect.left == mi.rcMonitor.left && rect.right == mi.rcMonitor.right &&
                         rect.top == mi.rcMonitor.top && rect.bottom == mi.rcMonitor.bottom;
      }
    }
  } else {
    out.minimized = IsIconic(h) != 0;
  }
}

} // namespace

void startWindowSystem() {}
void stopWindowSystem() {}

bool windowInfoAvailable()
{
  return true;
}

std::vector<TopLevelWindow> listWindows(uint32_t pid)
{
  struct Ctx {
    uint32_t pid;
    std::vector<TopLevelWindow> windows;
  } ctx{pid, {}};
  EnumWindows(
      [](HWND h, LPARAM lp) -> BOOL {
        auto& c = *reinterpret_cast<Ctx*>(lp);
        if (c.pid) {
          DWORD wpid = 0;
          GetWindowThreadProcessId(h, &wpid);
          if (wpid != c.pid)
            return TRUE;
        }
        if (!IsWindowVisible(h))
          return TRUE;
        c.windows.emplace_back();
        describeWindow(h, c.windows.back());
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&ctx));
  return std::move(ctx.windows);
}

std::vector<uint32_t> visibleWindowPids()
{
  std::set<uint32_t> visible;
  EnumWindows([](HWND window, LPARAM param) -> BOOL {
    if (IsWindowVisible(window) && !IsIconic(window)) {
      DWORD pid = 0;
      GetWindowThreadProcessId(window, &pid);
      reinterpret_cast<std::set<uint32_t>*>(param)->insert(pid);
    }
    return TRUE;
  }, reinterpret_cast<LPARAM>(&visible));
  return {visible.begin(), visible.end()};
}

uint32_t foregroundPid()
{
  HWND fg = GetForegroundWindow();
  if (!fg)
    return 0;
  DWORD pid = 0;
  GetWindowThreadProcessId(fg, &pid);
  return pid;
}

bool queryWindow(uintptr_t handle, TopLevelWindow& out)
{
  const HWND h = reinterpret_cast<HWND>(handle);
  if (!h || !IsWindow(h))
    return false;
  describeWindow(h, out);
  return true;
}

} // namespace shard::platform
