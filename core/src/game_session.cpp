#include "game_session.h"

#include "game_util.h"

#include <algorithm>

namespace clipforge {

void GameSessionManager::emit(const char* type, const nlohmann::json& params)
{
  if (sink_)
    sink_(type, params);
}

nlohmann::json GameSessionManager::sessionJson(const GameSession& s) const
{
  return {{"gameId", s.gameId},
          {"name", s.gameName},
          {"exe", s.exe},
          {"pid", s.pid},
          {"pids", s.pids},
          {"startMs", s.startMs},
          {"confidence", s.score},
          {"launcher", s.launcher.empty() ? nlohmann::json(nullptr) : nlohmann::json(s.launcher)},
          {"emulator", s.emulator},
          {"primary", s.primary}};
}

void GameSessionManager::emitSessionEvent(const char* state, const GameSession& s)
{
  emit("game.session", {{"state", state}, {"gameId", s.gameId}, {"name", s.gameName}, {"exe", s.exe},
                        {"pid", s.pid}, {"pids", s.pids}, {"confidence", s.score},
                        {"launcher", s.launcher.empty() ? nlohmann::json(nullptr) : nlohmann::json(s.launcher)},
                        {"emulator", s.emulator}});
}

size_t GameSessionManager::primaryIndex() const
{
  // Most recently started active session wins (the owner loop overrides this
  // via setPrimaryByGameId when the user actively focuses another game).
  size_t best = (size_t)-1;
  for (size_t i = 0; i < sessions_.size(); i++) {
    if (!sessions_[i].active)
      continue;
    if (best == (size_t)-1 || sessions_[i].startMs > sessions_[best].startMs)
      best = i;
  }
  return best;
}

void GameSessionManager::setPrimaryByGameId(const std::string& gameId)
{
  GameSession ns;
  bool changed = false;
  bool hasPrimary = false;
  {
    std::lock_guard<std::mutex> lock(mtx_);
    size_t target = (size_t)-1;
    for (size_t i = 0; i < sessions_.size(); i++)
      if (sessions_[i].active && sessions_[i].gameId == gameId)
        target = i;
    if (target == (size_t)-1)
      return;
    for (size_t i = 0; i < sessions_.size(); i++) {
      const bool nowPrimary = i == target;
      if (sessions_[i].primary != nowPrimary) {
        sessions_[i].primary = nowPrimary;
        changed = true;
      }
    }
    ns = sessions_[target];
    hasPrimary = true;
  }
  if (changed && hasPrimary)
    emitSessionEvent("primary", ns);
}

void GameSessionManager::onDetected(const DetectionResult& r, const ProcessInfo& p)
{
  bool started = false;
  GameSession ns;
  {
    std::lock_guard<std::mutex> lock(mtx_);
    for (auto& s : sessions_) {
      if (s.gameId != r.gameId || !s.active)
        continue;
      // Existing session: fold this process in (deduped), make it the active
      // process, refresh metadata. Never restarts the session.
      if (std::find(s.pids.begin(), s.pids.end(), p.pid) == s.pids.end())
        s.pids.push_back(p.pid);
      s.pid = p.pid;
      s.exe = p.exe;
      s.path = p.path;
      s.score = r.score;
      s.launcher = r.launcher;
      s.emulator = s.emulator || r.emulator;
      return; // no event: same game, not a new detection
    }

    GameSession s;
    s.gameId = r.gameId;
    s.gameName = r.gameName;
    s.pids = {p.pid};
    s.pid = p.pid;
    s.exe = p.exe;
    s.path = p.path;
    s.startMs = p.startMs;
    s.score = r.score;
    s.launcher = r.launcher;
    s.emulator = r.emulator;
    s.active = true;
    sessions_.push_back(std::move(s));
    const size_t idx = sessions_.size() - 1;
    // A brand-new session is by definition the most recent -> primary.
    for (size_t i = 0; i < sessions_.size(); i++)
      sessions_[i].primary = (i == idx);
    ns = sessions_[idx];
    started = true;
  }
  if (started)
    emitSessionEvent("started", ns);
}

void GameSessionManager::onProcessExited(uint32_t pid)
{
  std::vector<GameSession> ended;
  {
    std::lock_guard<std::mutex> lock(mtx_);
    for (auto& s : sessions_) {
      if (std::find(s.pids.begin(), s.pids.end(), pid) == s.pids.end())
        continue;
      s.pids.erase(std::remove(s.pids.begin(), s.pids.end(), pid), s.pids.end());
      if (s.pids.empty()) {
        ended.push_back(s);
        continue;
      }
      // The active process died but the game lives on (launcher + game):
      // follow the newest survivor.
      if (s.pid == pid) {
        s.pid = s.pids.back();
        const auto it = std::find(s.pids.begin(), s.pids.end(), s.pid);
        (void)it;
        s.exe.clear();
        s.title.clear();
        s.cls.clear();
        s.hasWindow = false;
        // The owner loop re-probes and refills exe/title on its next tick.
      }
    }
    sessions_.erase(std::remove_if(sessions_.begin(), sessions_.end(),
                                   [&](const GameSession& s) {
                                     return std::find_if(ended.begin(), ended.end(), [&](const GameSession& e) {
                                              return e.gameId == s.gameId;
                                            }) != ended.end();
                                   }),
                    sessions_.end());
  }
  for (const auto& s : ended) {
    // Only ended sessions that were actually active in the list get events;
    // ended was collected before erasure, so all of them were removed.
    emitSessionEvent("ended", s);
  }
  // If the primary ended, the newest remaining session takes over.
  if (!ended.empty())
    setPrimaryByGameId(primary().gameId);
}

void GameSessionManager::updateWindow(uint32_t pid, const std::string& title, const std::string& cls,
                                      bool fullscreen, bool hasWindow)
{
  std::lock_guard<std::mutex> lock(mtx_);
  for (auto& s : sessions_) {
    if (s.pid != pid)
      continue;
    s.title = title;
    s.cls = cls;
    s.fullscreen = fullscreen;
    s.hasWindow = hasWindow;
    return;
  }
}

void GameSessionManager::updateProcess(uint32_t pid, const std::string& exe, const std::string& path)
{
  std::lock_guard<std::mutex> lock(mtx_);
  for (auto& s : sessions_) {
    if (s.pid != pid)
      continue;
    s.exe = exe;
    s.path = path;
    return;
  }
}

const GameSession* GameSessionManager::sessionForPid(uint32_t pid) const
{
  std::lock_guard<std::mutex> lock(mtx_);
  for (const auto& s : sessions_)
    if (s.active && std::find(s.pids.begin(), s.pids.end(), pid) != s.pids.end())
      return &s;
  return nullptr;
}

GameSession GameSessionManager::primary() const
{
  std::lock_guard<std::mutex> lock(mtx_);
  // An explicitly-marked primary (owner loop's active-game following) wins;
  // fall back to the most recently started session.
  for (const auto& s : sessions_)
    if (s.active && s.primary)
      return s;
  const size_t best = primaryIndex();
  if (best == (size_t)-1)
    return {};
  return sessions_[best];
}

std::vector<GameSession> GameSessionManager::all() const
{
  std::lock_guard<std::mutex> lock(mtx_);
  return sessions_;
}

size_t GameSessionManager::count() const
{
  std::lock_guard<std::mutex> lock(mtx_);
  return sessions_.size();
}

const GameSession* GameSessionManager::activeForGame(const std::string& gameId) const
{
  std::lock_guard<std::mutex> lock(mtx_);
  for (const auto& s : sessions_)
    if (s.gameId == gameId && s.active)
      return &s;
  return nullptr;
}

} // namespace clipforge
