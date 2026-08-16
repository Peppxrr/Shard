// GameSystem — owns the whole detection subsystem (Todo #19): the layered
// registry, launcher discovery, process monitor, confidence detector, and
// session manager. Replaces the old foreground-window-only GameDetect.
//
// Pipeline (each stage independent, data flows downward):
//   LauncherDiscovery -> GameRegistry -> ProcessMonitor -> GameDetector
//        -> GameSessionManager -> SourceManager (capture subject)
//
// Threading: one owner loop thread (~2 Hz) drains the process monitor (WMI
// events + toolhelp reconciliation), evaluates candidates, refreshes session
// window metadata, and drives capture + auto-record. Discovery runs on the
// loop thread at startup, hourly, and on demand (RPC). Registry/session state
// is mutex-guarded for the RPC threads.
#pragma once

#include "app.h"
#include "config.h"
#include "detector.h"
#include "game_registry.h"
#include "game_session.h"
#include "launchers.h"
#include "process_monitor.h"
#include "recorder.h"
#include "sources.h"

#include <atomic>
#include <chrono>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>

namespace clipforge {

class GameSystem {
public:
  GameSystem(Config& config, Events& events, SourceManager& sources, Recorder& recorder);
  ~GameSystem();

  GameSystem(const GameSystem&) = delete;
  GameSystem& operator=(const GameSystem&) = delete;

  void start();
  void stop();
  void onConfigChanged(); // config.set game slice

  // ------------------------------------------------------------ RPC -------
  nlohmann::json listKnown() const; // compat: [{exe,name}] across layers
  bool addKnown(const std::string& exe, const std::string& name);
  bool removeKnown(const std::string& exe);
  nlohmann::json listGames() const;
  nlohmann::json addUserGame(const nlohmann::json& params);
  bool removeUserGame(const std::string& id);
  bool removeDiscovered(const std::string& id);
  nlohmann::json updateUserGame(const nlohmann::json& params);
  nlohmann::json listIgnored() const;
  bool ignoreExe(const std::string& exe);
  bool unignoreExe(const std::string& exe);
  nlohmann::json listLaunchers() const;
  bool setLauncherEnabled(const std::string& type, bool enabled);
  nlohmann::json refreshDiscovery();
  nlohmann::json sessions() const;
  nlohmann::json detectExplain(const nlohmann::json& params) const;
  // Custom game folders (indie/itch installs, emulator libraries).
  nlohmann::json listCustomFolders() const;
  nlohmann::json addCustomFolder(const nlohmann::json& params);
  bool removeCustomFolder(const std::string& id);

  // ------------------------------------------------------ state.get -------
  std::string currentExe() const;
  std::string currentName() const;
  bool currentKnown() const;
  uint32_t currentPid() const;
  nlohmann::json sessionsJson() const;

  // Tests override where the registry persists.
  void setGamesPathForTest(const std::string& p) { registryPathOverride_ = p; }

private:
  std::string effectiveRegistryPath() const;

  void loop();
  void handleProcessEvent(const ProcessEvent& e);
  void evaluateProcess(uint32_t pid);
  void reEvaluateCandidates();
  void unknownGamePromotion();
  void probeSessions();
  void runDiscoveryScan();
  void updateCaptureSubject();
  void applyFocusPrimary();
  void emitGameChanged();
  void logDetection(const ProcessInfo& p, const DetectionResult& r);

  bool hasLauncherAncestry(uint32_t pid) const;
  bool pathUnderDiscoveredInstall(const std::string& lowerPath) const;
  uint32_t foregroundPid() const;

  // Window probe results for one pid (WIN32; empty off-Windows).
  struct WindowProbe {
    std::string title;
    std::string cls;
    bool hasWindow = false;
    bool fullscreen = false;
    bool foreground = false;
  };
  // Best window for the pid: fullscreen > title-contains-hint > largest.
  WindowProbe probeWindow(uint32_t pid, const std::string& titleHint = "") const;

  Config& config_;
  Events& events_;
  SourceManager& sources_;
  Recorder& recorder_;

  GameRegistry registry_;
  LauncherDiscovery discovery_;
  ProcessMonitor monitor_;
  GameSessionManager sessions_;

  std::string registryPathOverride_;
  std::thread loopThread_;
  std::atomic<bool> run_{false};

  mutable std::mutex stateMtx_;
  // pid -> gameId for processes already promoted to a session
  std::map<uint32_t, std::string> knownPids_;
  // Candidate re-evaluation: pid -> first candidate timestamp (unix ms).
  std::map<uint32_t, int64_t> candidateSince_;
  // Unknown-game workflow: pid -> first seen timestamp.
  std::map<uint32_t, int64_t> unknownSince_;
  // pids the unknown workflow already promoted (avoid repeats).
  std::set<uint32_t> unknownPromoted_;

  // Active-game following: the game holding focus becomes primary after it
  // keeps focus for the debounce window (capture follows the active game).
  std::string focusGameId_;
  int64_t focusSinceMs_ = 0;
  const int64_t kFocusDebounceMs = 10000;

  std::chrono::steady_clock::time_point lastDiscovery_{};
  std::vector<LauncherDiscovery::Result> lastScanResults_;
  int64_t lastScanAtMs_ = 0;

  // Primary session bookkeeping for capture + events.
  std::string pushedSubjectExe_;
  uint32_t pushedSubjectPid_ = 0;
  std::string pushedSubjectTitle_;
  std::string pushedSubjectClass_;
  int64_t lastSessionEndMs_ = 0;
  bool autoRecording_ = false;
};

} // namespace clipforge
