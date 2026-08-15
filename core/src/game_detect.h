#pragma once

#include "app.h"
#include "config.h"
#include "recorder.h"
#include "sources.h"

#include <atomic>
#include <chrono>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace clipforge {

// Foreground-window game detection (Windows: SetWinEventHook + poll
// fallback). Matches the foreground executable against games.json and emits
// game.changed. Optional auto-record: starts recording when a known game
// foregrounds, stops after a grace period once it leaves.
class GameDetect {
public:
  GameDetect(Config& config, Events& events, SourceManager& sources, Recorder& recorder);
  ~GameDetect();

  GameDetect(const GameDetect&) = delete;
  GameDetect& operator=(const GameDetect&) = delete;

  void start();
  void stop();

  // RPC: known games list
  nlohmann::json listKnown() const;
  bool addKnown(const std::string& exe, const std::string& name);
  bool removeKnown(const std::string& exe);

  // config.set game.gamesPath / autoRecord
  void reload();

  // Last known foreground game (empty if none).
  std::string currentExe() const
  {
    std::lock_guard<std::mutex> lock(stateMtx_);
    return currentExe_;
  }
  std::string currentName() const
  {
    std::lock_guard<std::mutex> lock(stateMtx_);
    return currentName_;
  }
  bool currentKnown() const
  {
    std::lock_guard<std::mutex> lock(stateMtx_);
    return currentKnown_;
  }

#ifdef _WIN32
  // Called from the SetWinEventHook callback thread (process-wide hook target).
  void onHookFired() { hookFired_.store(true); }
#endif

private:
  void pollLoop();
  void checkForeground();
  void onForegroundChange(const std::string& exe, const std::string& name, bool known, uint32_t pid,
                          const std::string& title, const std::string& cls, bool fullscreen);
  void loadGames();
  void saveGames();
  void armHook();
  void disarmHook();

  Config& config_;
  Events& events_;
  SourceManager& sources_;
  Recorder& recorder_;

#ifdef _WIN32
  void* hookHandle_ = nullptr; // HWINEVENTHOOK
#endif
  std::atomic<bool> hookFired_{false};

  std::thread pollThread_;
  std::atomic<bool> run_{false};

  mutable std::mutex gamesMtx_;
  struct GameEntry {
    std::string exe; // lowercase exe basename, e.g. "eldenring.exe"
    std::string name;
  };
  std::vector<GameEntry> games_;

  mutable std::mutex stateMtx_;
  std::string currentExe_;
  std::string currentName_;
  bool currentKnown_ = false;
  uint32_t currentPid_ = 0;

  std::atomic<bool> autoRecording_{false};
  std::chrono::steady_clock::time_point leaveGameAt_{};
};

} // namespace clipforge
