// GameSession lifecycle manager.
//
// One session per GAME (not per process): a game that spawns several
// processes (launcher + game + anti-cheat helper) produces exactly one
// session, so detection popups stay deduplicated and the capture subject
// never flip-flops between its own processes. The session tracks all pids of
// the game; `pid` is the active process (newest, or the survivor when one
// exits) that the window probe + capture follow.
//
// Sessions are COMPLETELY independent of the foreground window: alt-tab,
// minimize, Discord or browser focus never end a session. Which session is
// PRIMARY is a capture decision made by the owner loop (active-game
// following with a debounce) — not a session-lifetime signal.
#pragma once

#include "detector.h"
#include "process_monitor.h"

#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

namespace clipforge {

struct GameSession {
  std::string gameId;
  std::string gameName;
  std::vector<uint32_t> pids; // every process of this game
  uint32_t pid = 0;           // active process (window probe + capture target)
  std::string exe;            // active process exe
  std::string path;
  int64_t startMs = 0;
  int score = 0;
  std::string launcher; // e.g. "steam" ("" when none)
  std::string title;    // active process window (refreshed by the owner loop)
  std::string cls;
  bool fullscreen = false;
  bool hasWindow = false;
  bool emulator = false;
  bool primary = false;
  bool active = true;
};

class GameSessionManager {
public:
  // Events emitted as JSON params (without the type string).
  using Sink = std::function<void(const char* type, const nlohmann::json& params)>;

  void setSink(Sink sink) { sink_ = std::move(sink); }

  // A detection fired for a process. Starts a session for the game if none is
  // active; otherwise folds the process into the existing session.
  void onDetected(const DetectionResult& r, const ProcessInfo& p);

  // Process exit. Ends the session when its last pid dies; otherwise the
  // active pid moves to the newest survivor.
  void onProcessExited(uint32_t pid);

  // Refresh window metadata for the active process of a session.
  void updateWindow(uint32_t pid, const std::string& title, const std::string& cls, bool fullscreen,
                    bool hasWindow);
  // Refresh the active process's exe/path (survivor migration, re-probe).
  void updateProcess(uint32_t pid, const std::string& exe, const std::string& path);

  // The active-game switch (owner loop, debounced): make the session for
  // gameId primary. Emits "primary" (and game.changed via the sink caller).
  void setPrimaryByGameId(const std::string& gameId);

  // Session containing this pid (nullptr when none).
  const GameSession* sessionForPid(uint32_t pid) const;

  GameSession primary() const;
  std::vector<GameSession> all() const;
  size_t count() const;
  const GameSession* activeForGame(const std::string& gameId) const;

private:
  mutable std::mutex mtx_;
  std::vector<GameSession> sessions_;
  Sink sink_;

  size_t primaryIndex() const; // requires mtx_
  void emit(const char* type, const nlohmann::json& params);
  void emitSessionEvent(const char* state, const GameSession& s);
  nlohmann::json sessionJson(const GameSession& s) const;
};

} // namespace clipforge
