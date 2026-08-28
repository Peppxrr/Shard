#pragma once

#include "app.h"
#include "config.h"

#include <obs.h>

#include <atomic>
#include <chrono>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace clipforge {

inline uint64_t duration_ms_now()
{
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

// Manages the capture subject — WGC monitor_capture for the desktop and a
// layered WGC window_capture + injected game_capture pair for games. WGC is
// the visible-window path; game capture remains available underneath it when
// the game is minimized. Also owns configured audio sources and WASAPI device
// enumeration.
//
// Subject model: while a game window is the subject, capture follows that
// game until its process exits, even if another window takes focus. When a
// second game takes focus the switch is debounced by 10 s (buffer is kept).
class SourceManager {
public:
  struct Subject {
    enum class Kind { None, Monitor, Window };
    Kind kind = Kind::None;
    std::string exe;   // lowercase exe basename (window subjects), e.g. "eldenring.exe"
    std::string title; // window title (may be empty)
    std::string cls;   // window class (may be empty)
    std::string name;  // display name (game name / "Desktop")
    uint32_t pid = 0;  // process id (window subjects)

    bool operator==(const Subject& o) const
    {
      return kind == o.kind && exe == o.exe && title == o.title && cls == o.cls && pid == o.pid &&
             name == o.name;
    }
    bool operator!=(const Subject& o) const { return !(*this == o); }
  };

  SourceManager(App& app, Config& config, Events& events);
  ~SourceManager();

  SourceManager(const SourceManager&) = delete;
  SourceManager& operator=(const SourceManager&) = delete;

  // (Re)create the monitor + layered game capture sources from
  // config_.capture and re-evaluate the subject. Safe to call repeatedly.
  void applyVideoSource();
  // (Re)create/destroy/update audio sources from config_.audioSources.
  void applyAudioSources();
  // Live change of the configured audio mix (config.set audio).
  void setAudioSources(const std::vector<AudioSourceConfig>& sources);

  // WASAPI device enumeration: [{id,name,isInput,isVoicemeeter}]
  nlohmann::json listDevices();
  // Desktop displays: [{index,name,width,height,primary}].
  nlohmann::json listMonitors() const;

  // GameSystem session callback: the primary game session changed. Switches
  // the capture subject to that game's layered WGC + game-hook sources; a
  // repeat call with the same pid refreshes the window descriptor.
  void setGameSubject(const std::string& exe, const std::string& name, const std::string& title,
                      const std::string& cls, uint32_t pid);
  // The primary session ended; fall back to the desktop (auto mode) or
  // nothing (game-only mode).
  void clearGameSubject();

  // The watchdog feeds live capture activity into this callback every tick;
  // main wires it to the replay ring so buffering stops (and RAM is freed)
  // ~15 s after the capture subject disappears.
  void setCaptureActivityCb(std::function<void(bool)> cb) { captureActivityCb_ = std::move(cb); }

  void startWatchdog();
  void stopWatchdog();

  // Drop every scene item + source (used before obs_shutdown / full restart).
  void releaseAll();

  // Current capture subject (RPC thread reads this for state.get).
  Subject subject() const
  {
    std::lock_guard<std::mutex> lock(sourceMutex_);
    return subject_;
  }

private:
  void watchdogLoop();
  static bool pidAlive(uint32_t pid);
  // Requires sourceMutex_ held.
  void applySubjectLocked();
  void setWindowTargetLocked(const Subject& s);
  void fillFrame(obs_sceneitem_t* item, const struct obs_sceneitem_crop* crop = nullptr);
  // Crop the full WGC surface at the scene layer. Invalid Win32 geometry
  // deliberately falls back to the uncropped live surface.
  void fillWindowFrameLocked();
  void retryMonitorCaptureLocked();
  // Reset a stalled WGC session by re-applying the current target. OBS only
  // retries a failed WinRT initialization after a settings update.
  void retryWindowCaptureLocked();
  // Force the game_capture source to re-try hook injection. Required because
  // win-capture sets error_acquiring=true on validation failures and then
  // stops its internal retry until the next settings update.
  void retryGameCaptureLocked();
  void emitSubjectChanged();
  void removeVideoSourceItem();

  App& app_;
  Config& config_;
  Events& events_;

  // Capture sources + scene items. Hook is the primary game backend (top
  // layer); WGC window_capture is the fallback beneath it. When the hook is
  // producing frames its texture covers the fallback; when the hook is not
  // ready the fallback's WGC frames are exposed. This ordering survives
  // minimization: WGC draws nothing while iconic, hook keeps updating.
  obs_source_t* monitorSource_ = nullptr;
  obs_sceneitem_t* monitorItem_ = nullptr;
  obs_source_t* gameSource_ = nullptr; // game_capture (injected hook) - primary, top
  obs_sceneitem_t* gameItem_ = nullptr;
  obs_source_t* windowSource_ = nullptr; // window_capture (WGC) - fallback, below hook
  obs_sceneitem_t* windowItem_ = nullptr;

  Subject subject_; // what is currently captured/shown

  // Hook-primary health + retry state. WGC is only promoted after the hook
  // has been given several injection attempts.
  std::chrono::steady_clock::time_point captureHealthyAt_{};
  std::chrono::steady_clock::time_point lastWindowRetry_{};
  std::chrono::steady_clock::time_point lastHookRetry_{};
  int hookRetryCount_ = 0;
  int wgcRetryCount_ = 0;
  bool windowNoFramesReported_ = false;
  bool windowSuppressedForMinimize_ = false;
  // Which backend is currently exposed (for visibility toggling). Not persisted.
  enum class ActiveBackend { None, Hook, Wgc } activeBackend_ = ActiveBackend::None;
  std::function<void(bool)> captureActivityCb_;

  std::vector<obs_source_t*> audioSources_;
  std::vector<obs_sceneitem_t*> audioItems_;

  std::thread watchdogThread_;
  std::atomic<bool> watchdogRun_{false};
  mutable std::mutex sourceMutex_;
};

} // namespace clipforge
