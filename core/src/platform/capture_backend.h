// Platform capture backend used by SourceManager (sources.cpp).
//
// SourceManager owns the platform-neutral capture model: a desktop source, a
// preferred game "hook" source layered above a window fallback source, frame
// probes, health/recovery policy and audio rows. This header is the only place
// it learns which OBS source ids/settings and window/display APIs exist.
//
//   Windows: monitor_capture (WGC), game_capture (official signed hook),
//            window_capture (WGC), WASAPI audio.
//   Linux:   pipewire-desktop-capture-source (monitor-only xdg-desktop-portal ScreenCast,
//            restore token persisted), vkcapture-source when the obs-vkcapture
//            plugin is staged (games launched with OBS_VKCAPTURE=1), the
//            desktop screencast reused as the window fallback, PulseAudio API
//            sources served by PipeWire.
//
// All functions are called with SourceManager's source mutex held unless
// noted, never from OBS graphics callbacks.
#pragma once

#include "capture_display.h"
#include "capture_geometry.h"
#include "capture_subject.h"
#include "config.h"

#include <nlohmann/json.hpp>
#include <obs.h>

#include <memory>
#include <optional>
#include <string>

namespace shard {

class CaptureRecoveryState;

namespace capture {

// Method names reported by [capture-method] logs and perf.stats
// (contracts.ts PerfSession.capture.method).
struct MethodNames {
  const char* desktop; // "wgc_monitor" | "pipewire_desktop"
  const char* window;  // "wgc_window"  | "pipewire_desktop_window"
  const char* hook;    // "game_capture" | "vkcapture"
  // User-facing name of the window fallback in error messages.
  const char* windowLabel; // "WGC" | "window capture"
};
const MethodNames& methodNames();

// ---------------------------------------------------------------- sources --

// Desktop capture of config.capture.monitor. May return nullptr.
obs_source_t* createDesktopSource(const Config& config);
// Re-apply settings so OBS retries a failed/stalled desktop session.
void retryDesktopSource(obs_source_t* desktop, const Config& config);
// Called once per watchdog tick (desktop may be null). Linux persists the
// portal restore token so later sessions start without a picker dialog.
void persistDesktopState(obs_source_t* desktop, const Config& config);

// Preferred game backend; nullptr when the platform/runtime has none.
obs_source_t* createHookSource();
// Window fallback layered under the hook. `desktop` is the live desktop
// source (Linux returns a new reference to it). May return nullptr.
obs_source_t* createWindowSource(obs_source_t* desktop);
// Point both game backends at `subject` (either may be null).
void targetGameSources(obs_source_t* window, obs_source_t* hook, const CaptureSubject& subject);
// Re-apply the current target so OBS retries a stalled window session.
void retryWindowSource(obs_source_t* window, const CaptureSubject& subject);
// Re-apply the current target so the hook retries; returns the descriptor
// used, for [GC] diagnostics.
std::string retryHookSource(obs_source_t* hook, const CaptureSubject& subject);
// True when recreating the window source yields a new capture session. False
// when it aliases the desktop source (Linux), so recovery skips that level.
bool windowSourceIsIndependent();
// True when destroying and recreating the hook source starts a new capture
// attempt (Windows game_capture re-injects). False when the game's connection
// outlives the source (Linux vkcapture), so recovery only re-targets it.
bool hookRecreationResets();
// Why the hook cannot attach to `pid` at all, reported as the window-fallback
// reason instead of "hook_not_attached"; "" when unknown (Windows). Linux:
// "vkcapture_not_enabled" when the game has neither the vkcapture Vulkan
// layer nor the OpenGL capture library loaded.
std::string hookUnavailableReason(uint32_t pid);

// ---------------------------------------------------------------- targets --

// Best visible window of subject.pid: class match (+2) and title match (+1)
// win, ties go to the larger window. 0 when the process has none.
uintptr_t findSubjectWindow(const CaptureSubject& subject);
// Window exists and is minimized (iconic).
bool windowMinimized(uintptr_t window);
// Window still exists, is visible and belongs to pid.
bool windowLiveForPid(uintptr_t window, uint32_t pid);
struct WindowIdentity {
  std::string title;
  std::string cls;
};
std::optional<WindowIdentity> windowIdentity(uintptr_t window);
std::optional<CaptureSize> windowClientSize(uintptr_t window);

// Scene-item crop removing the non-client frame from a window-source surface
// of sourceWidth x sourceHeight. clientSize is the validated client extent
// before the cosmetic caption inset. valid=false keeps the uncropped surface.
struct WindowSceneCrop {
  bool valid = false;
  uint32_t left = 0, top = 0, right = 0, bottom = 0;
  CaptureSize clientSize;
};
WindowSceneCrop windowSceneCrop(uintptr_t window, uint32_t sourceWidth, uint32_t sourceHeight);

// Window the window source actually acquired (uniquely within pid); nullopt
// before acquisition or when ambiguous/unsupported.
std::optional<uintptr_t> acquiredWindow(obs_source_t* window, uint32_t pid);
// Display identity for a window subject (its window) or the desktop index.
uintptr_t displayForTarget(bool windowSubject, uintptr_t window, int monitorIndex);
// Name/HDR/advanced-color state of a display from displayForTarget.
CaptureDisplayState queryCaptureDisplay(uintptr_t display);

// Process exists (a protected process that refuses queries counts as alive).
bool processAlive(uint32_t pid);

// ------------------------------------------------------- system events ---

// Display power, suspend/resume and graphics-device-loss notifications for
// the watchdog's lifetime. Created and destroyed on the watchdog thread.
class SystemEventSubscription {
public:
  explicit SystemEventSubscription(CaptureRecoveryState& state);
  ~SystemEventSubscription();
  SystemEventSubscription(const SystemEventSubscription&) = delete;
  SystemEventSubscription& operator=(const SystemEventSubscription&) = delete;

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// ------------------------------------------------------------------ audio --

// Devices for audio rows: [{id,name,isInput,isVoicemeeter}]. Any thread.
nlohmann::json listAudioDevices();
// Endpoint capture; deviceId "default" selects the default device.
obs_source_t* createAudioDeviceSource(bool input, const std::string& deviceId, const std::string& name);
// Window-addressed application audio (row kind "process" without isolation);
// nullptr when unsupported.
obs_source_t* createAppAudioSource(const std::string& window, const std::string& name);

} // namespace capture
} // namespace shard
