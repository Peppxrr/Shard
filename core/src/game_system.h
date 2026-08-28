// GameSystem owns installed-product discovery, event-driven process facts,
// live renderer qualification, game sessions, and the capture subject.
//
// LauncherDiscovery -> GameRegistry provides product identity only. A process
// enters GameSessionManager only after GameDetector sees an explicit user
// mapping or a captureable foreground window with renderer/custom-folder
// evidence. Qualified executables are then learned individually.
//
// One owner loop (~2 Hz) drains WMI/toolhelp events, follows foreground intent,
// rechecks windows/modules while a renderer loads, refreshes sessions, and
// drives capture + auto-record. Discovery runs at startup, hourly, and by RPC.
// Registry/session state is mutex-guarded for RPC threads.
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
#include <string>
#include <optional>
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
  nlohmann::json sessions() const;
  nlohmann::json detectExplain(const nlohmann::json& params) const;

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
  void evaluateForegroundProcess();
  void probeSessions();
  void runDiscoveryScan();
  void updateCaptureSubject();
  void applyFocusPrimary();
  void emitGameChanged();
  void logDetection(const ProcessInfo& p, const DetectionResult& r);

  std::string createRuntimeProduct(const ProcessInfo& process, const DetectionResult& result);
  uint32_t foregroundPid() const;

  std::optional<GameDefinition> productHintForPath(const std::string& lowerPath) const;
  // Window probe results for one pid (WIN32; empty off-Windows).
  struct WindowProbe {
    std::string title;
    std::string cls;
    bool hasWindow = false;
    bool captureable = false;
    bool fullscreen = false;
    bool foreground = false;
    bool minimized = false; // best window is iconic (minimized)
    bool onScreen = false;  // best window rect intersects a monitor
    long area = 0; // best window client area (for standalone heuristic)
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
  std::atomic<bool> discoveryRequested_{false};

  mutable std::mutex stateMtx_;
  // pid -> gameId for processes already qualified into a session.
  std::map<uint32_t, std::string> knownPids_;
  // Recently started or foreground candidates are re-evaluated while their
  // renderer modules and top-level window are still loading.
  std::map<uint32_t, int64_t> candidateSince_;
  uint32_t observedForegroundPid_ = 0;

  // Active-game following: the game holding focus becomes primary after it
  // keeps focus for the debounce window (capture follows the active game).
  // 1.5s rejects transient 200ms flick, but 8s focus on B reliably captures B.
  // This is the SINGLE authority for primary selection (updateCaptureSubject
  // never mutates primary).
  std::string focusGameId_;
  int64_t focusSinceMs_ = 0;
  const int64_t kFocusDebounceMs = 1500;

  std::chrono::steady_clock::time_point lastDiscovery_{};
  mutable std::mutex productHintsMtx_;
  std::vector<GameDefinition> productHints_;

  // Primary session bookkeeping for capture + events.
  std::string pushedSubjectExe_;
  uint32_t pushedSubjectPid_ = 0;
  std::string pushedSubjectTitle_;
  std::string pushedSubjectClass_;
  int64_t lastSessionEndMs_ = 0;
  bool autoRecording_ = false;
};

} // namespace clipforge
