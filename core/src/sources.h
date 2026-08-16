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
  void fillFrame(obs_sceneitem_t* item);
  // Reset a stalled WGC session by re-applying the current target. OBS only
  // retries a failed WinRT initialization after a settings update.
  void retryWindowCaptureLocked();
  void emitSubjectChanged();
  void removeVideoSourceItem();

  App& app_;
  Config& config_;
  Events& events_;

  // Capture sources + scene items. For a game, gameItem_ is below windowItem_:
  // visible WGC frames win, but WGC draws nothing when minimized and exposes
  // the still-running game hook beneath it.
  obs_source_t* monitorSource_ = nullptr;
  obs_sceneitem_t* monitorItem_ = nullptr;
  obs_source_t* gameSource_ = nullptr; // game_capture (injected graphics hook)
  obs_sceneitem_t* gameItem_ = nullptr;
  obs_source_t* windowSource_ = nullptr; // window_capture (WGC)
  obs_sceneitem_t* windowItem_ = nullptr;

  Subject subject_; // what is currently captured/shown

  // Combined game-capture health state. Either the injected hook or WGC is
  // usable once it reports real dimensions.
  std::chrono::steady_clock::time_point captureHealthyAt_{};
  std::chrono::steady_clock::time_point lastWindowRetry_{};
  bool windowNoFramesReported_ = false;
  bool windowSuppressedForMinimize_ = false;

  std::function<void(bool)> captureActivityCb_;

  std::vector<obs_source_t*> audioSources_;
  std::vector<obs_sceneitem_t*> audioItems_;

  std::thread watchdogThread_;
  std::atomic<bool> watchdogRun_{false};
  mutable std::mutex sourceMutex_;
};

} // namespace clipforge
