#include "game_registry.h"

#include "game_util.h"

#include <algorithm>
#include <chrono>
#include <fstream>
#include <filesystem>

namespace clipforge {

using namespace std::chrono;

namespace {

std::string sourceStr(GameSource s)
{
  switch (s) {
    case GameSource::Discovered:
      return "discovered";
    case GameSource::User:
      return "user";
  }
  return "discovered";
}

int64_t nowMs()
{
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

// Append, deduplicating.
void appendUnique(std::vector<std::string>& dst, const std::vector<std::string>& src)
{
  for (const auto& v : src)
    if (std::find(dst.begin(), dst.end(), v) == dst.end())
      dst.push_back(v);
}

} // namespace

// --------------------------------------------------------------------- json

nlohmann::json GameDefinition::toJson() const
{
  return {{"id", id},
          {"name", name},
          {"executables", executables},
          {"installPaths", installPaths},
          {"launchers", [this] {
             nlohmann::json arr = nlohmann::json::array();
             for (const auto& l : launchers)
               arr.push_back({{"type", l.type}, {"id", l.id}});
             return arr;
           }()},
          {"source", sourceStr(source)},
          {"enabled", enabled},
          {"stale", stale},
          {"emulator", emulator},
          {"discoveredAtMs", discoveredAtMs}};
}

GameDefinition GameDefinition::fromJson(const nlohmann::json& j, GameSource source)
{
  GameDefinition g;
  g.id = j.value("id", std::string());
  g.name = j.value("name", std::string());
  g.source = source;
  if (j.contains("executables") && j["executables"].is_array())
    for (const auto& e : j["executables"])
      if (e.is_string())
        g.executables.push_back(toLower(e.get<std::string>()));
  if (j.contains("installPaths") && j["installPaths"].is_array())
    for (const auto& p : j["installPaths"])
      if (p.is_string())
        g.installPaths.push_back(normalizePath(p.get<std::string>()));
  if (j.contains("launchers") && j["launchers"].is_array())
    for (const auto& l : j["launchers"])
      if (l.is_object())
        g.launchers.push_back({l.value("type", std::string()), l.value("id", std::string())});
  g.enabled = j.value("enabled", true);
  g.stale = j.value("stale", false);
  g.emulator = j.value("emulator", false);
  g.discoveredAtMs = j.value("discoveredAtMs", (int64_t)0);
  return g;
}

nlohmann::json CustomFolder::toJson() const
{
  return {{"id", id}, {"name", name}, {"path", path}, {"emulator", emulator}};
}

CustomFolder CustomFolder::fromJson(const nlohmann::json& j)
{
  CustomFolder f;
  f.id = j.value("id", std::string());
  f.name = j.value("name", std::string());
  f.path = normalizePath(j.value("path", std::string()));
  f.emulator = j.value("emulator", false);
  return f;
}

// ------------------------------------------------------------------- load --

void GameRegistry::load()
{
  std::lock_guard<std::mutex> lock(mtx_);
  discovered_.clear();
  user_.clear();
  customFolders_.clear();
  ignoredExes_.clear();
  migratedV1_ = 0;

  if (path_.empty())
    path_ = std::string("games.json"); // relative to configDir via cwd; overwritten by config.set
  std::ifstream in(path_);
  if (in.is_open()) {
    try {
      nlohmann::json j;
      in >> j;

      if (j.is_array()) {
        // Legacy v1: [{exe, name}, ...]. Migrate to the user layer as-is.
        for (const auto& e : j) {
          if (!e.is_object() || !e.contains("exe") || !e.contains("name"))
            continue;
          const std::string exe = toLower(e["exe"].get<std::string>());
          const std::string name = e["name"].get<std::string>();
          if (exe.empty() || name.empty())
            continue;
          GameDefinition g;
          g.id = "u:" + slugify(name) + "-" + slugify(exe);
          g.name = name;
          g.executables = {exe};
          g.source = GameSource::User;
          user_.push_back(std::move(g));
          migratedV1_++;
        }
      } else if (j.is_object()) {
        if (j.contains("user") && j["user"].is_array())
          for (const auto& e : j["user"])
            if (e.is_object()) {
              GameDefinition g = GameDefinition::fromJson(e, GameSource::User);
              if (!g.id.empty() && !g.name.empty() && !g.executables.empty())
                user_.push_back(std::move(g));
            }
        if (j.contains("discovered") && j["discovered"].is_array())
          for (const auto& e : j["discovered"])
            if (e.is_object()) {
              GameDefinition g = GameDefinition::fromJson(e, GameSource::Discovered);
              if (!g.id.empty() && !g.name.empty() && !g.executables.empty())
                discovered_.push_back(std::move(g));
            }
        if (j.contains("customFolders") && j["customFolders"].is_array())
          for (const auto& e : j["customFolders"])
            if (e.is_object()) {
              CustomFolder f = CustomFolder::fromJson(e);
              if (!f.id.empty() && !f.name.empty() && !f.path.empty())
                customFolders_.push_back(std::move(f));
            }
        if (j.contains("ignoredExes") && j["ignoredExes"].is_array())
          for (const auto& e : j["ignoredExes"])
            if (e.is_string())
              ignoredExes_.push_back(toLower(e.get<std::string>()));
        if (j.contains("launchers") && j["launchers"].is_object())
          for (auto it = j["launchers"].begin(); it != j["launchers"].end(); ++it)
            launcherEnabled_[it.key()] = it.value().get<bool>();
        if (j.contains("verboseDetection"))
          verbose_ = j.value("verboseDetection", false);
      }
    } catch (...) {
      // Corrupt games.json: empty registry, no crash.
    }
  }

  rebuildIndexes();
}

void GameRegistry::rebuildIndexes()
{
  exeIndex_.clear();

  // Precedence: user > discovered. First claim wins per exe.
  auto claim = [&](const GameDefinition& g) {
    for (const auto& exe : g.executables) {
      if (exe.empty())
        continue;
      auto it = exeIndex_.find(exe);
      if (it == exeIndex_.end())
        exeIndex_[exe] = g.id;
    }
  };

  for (auto& g : user_)
    if (g.enabled)
      claim(g);
  for (auto& g : discovered_)
    if (g.enabled)
      claim(g);
}

void GameRegistry::save()
{
  std::lock_guard<std::mutex> lock(mtx_);
  saveLocked();
}

void GameRegistry::saveLocked()
{
  if (path_.empty())
    return;

  nlohmann::json j;
  j["version"] = 2;
  {
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& g : user_)
      arr.push_back(g.toJson());
    j["user"] = std::move(arr);
  }
  {
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& g : discovered_)
      arr.push_back(g.toJson());
    j["discovered"] = std::move(arr);
  }
  {
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& f : customFolders_)
      arr.push_back(f.toJson());
    j["customFolders"] = std::move(arr);
  }
  j["ignoredExes"] = ignoredExes_;
  j["launchers"] = launcherEnabled_;
  j["verboseDetection"] = verbose_;

  try {
    std::filesystem::create_directories(std::filesystem::path(path_).parent_path());
    std::ofstream out(path_, std::ios::trunc);
    if (out.is_open())
      out << j.dump(2);
    lastSaveMs_ = nowMs();
  } catch (...) {
    // Never crash on a write failure.
  }
}

// --------------------------------------------------------------- mutations

std::string GameRegistry::upsertUserGame(const GameDefinition& g)
{
  std::lock_guard<std::mutex> lock(mtx_);
  if (g.name.empty() || g.executables.empty())
    return "";

  std::vector<std::string> exes;
  for (const auto& e : g.executables) {
    const std::string exe = toLower(e);
    if (!exe.empty())
      exes.push_back(exe);
  }
  if (exes.empty())
    return "";

  // Reuse an existing user entry that shares an executable (rename/update),
  // or create a fresh one.
  GameDefinition* target = nullptr;
  for (auto& u : user_) {
    for (const auto& exe : exes) {
      if (std::find(u.executables.begin(), u.executables.end(), exe) != u.executables.end()) {
        target = &u;
        break;
      }
    }
    if (target)
      break;
  }

  if (target) {
    target->name = g.name;
    appendUnique(target->executables, exes);
    appendUnique(target->installPaths, g.installPaths);
    const std::string id = target->id;
    rebuildIndexes();
    saveLocked();
    return id;
  }

  GameDefinition nu = g;
  nu.id = "u:" + slugify(g.name);
  // Keep ids unique within the user layer.
  bool dup = std::any_of(user_.begin(), user_.end(), [&](const GameDefinition& u) { return u.id == nu.id; });
  if (dup)
    nu.id = "u:" + slugify(g.name) + "-" + slugify(exes[0]);
  nu.executables = exes;
  nu.source = GameSource::User;
  user_.push_back(std::move(nu));
  const std::string id = user_.back().id;
  rebuildIndexes();
  saveLocked();
  return id;
}

bool GameRegistry::removeUserGame(const std::string& id)
{
  std::lock_guard<std::mutex> lock(mtx_);
  auto it = std::remove_if(user_.begin(), user_.end(), [&](const GameDefinition& g) { return g.id == id; });
  if (it == user_.end())
    return false;
  user_.erase(it, user_.end());
  rebuildIndexes();
  saveLocked();
  return true;
}

bool GameRegistry::removeDiscoveredGame(const std::string& id)
{
  std::lock_guard<std::mutex> lock(mtx_);
  auto it = std::remove_if(discovered_.begin(), discovered_.end(),
                           [&](const GameDefinition& g) { return g.id == id; });
  if (it == discovered_.end())
    return false;
  discovered_.erase(it, discovered_.end());
  rebuildIndexes();
  saveLocked();
  return true;
}

bool GameRegistry::extendUserGame(const std::string& id, const std::vector<std::string>& executables,
                                  const std::vector<std::string>& installPaths)
{
  std::lock_guard<std::mutex> lock(mtx_);
  for (auto& g : user_) {
    if (g.id != id)
      continue;
    size_t before = g.executables.size() + g.installPaths.size();
    for (const auto& e : executables) {
      const std::string exe = toLower(e);
      if (!exe.empty() && std::find(g.executables.begin(), g.executables.end(), exe) == g.executables.end())
        g.executables.push_back(exe);
    }
    for (const auto& p : installPaths) {
      const std::string np = normalizePath(p);
      if (std::find(g.installPaths.begin(), g.installPaths.end(), np) == g.installPaths.end())
        g.installPaths.push_back(np);
    }
    const bool changed = g.executables.size() + g.installPaths.size() != before;
    if (changed) {
      rebuildIndexes();
      saveLocked();
    }
    return true;
  }
  return false;
}

void GameRegistry::mergeDiscovered(const GameDefinition& g)
{
  std::lock_guard<std::mutex> lock(mtx_);
  if (g.name.empty())
    return;

  const std::string normName = normalizedGameName(g.name);

  // Merge into an existing user entry with the same normalized name.
  auto mergeIntoExisting = [&](GameDefinition& base) {
    appendUnique(base.executables, g.executables);
    appendUnique(base.installPaths, g.installPaths);
    for (const auto& l : g.launchers)
      if (std::find(base.launchers.begin(), base.launchers.end(), l) == base.launchers.end())
        base.launchers.push_back(l);
    base.stale = false;
    base.emulator = base.emulator || g.emulator;
  };

  for (auto& u : user_) {
    if (normalizedGameName(u.name) == normName) {
      mergeIntoExisting(u);
      rebuildIndexes();
      saveLocked();
      return;
    }
  }

  // Standalone discovered entry, keyed by its launcher id (dedupe across
  // rescan runs).
  std::string key = g.id;
  if (key.empty() && !g.launchers.empty())
    key = "d:" + g.launchers[0].type + ":" + g.launchers[0].id;
  if (key.empty())
    key = "d:" + slugify(g.name);

  for (auto& d : discovered_) {
    if (d.id != key)
      continue;
    d.name = g.name;
    mergeIntoExisting(d);
    d.emulator = g.emulator;
    rebuildIndexes();
    saveLocked();
    return;
  }

  GameDefinition nd = g;
  nd.id = key;
  nd.source = GameSource::Discovered;
  if (nd.discoveredAtMs == 0)
    nd.discoveredAtMs = nowMs();
  discovered_.push_back(std::move(nd));
  rebuildIndexes();
  saveLocked();
}

// --------------------------------------------------------- custom fold ----

std::string GameRegistry::addCustomFolder(const CustomFolder& f)
{
  std::lock_guard<std::mutex> lock(mtx_);
  if (f.name.empty() || f.path.empty())
    return "";

  // Reuse an existing folder on the same path.
  const std::string np = normalizePath(f.path);
  for (auto& existing : customFolders_) {
    if (existing.path == np) {
      existing.name = f.name;
      existing.emulator = f.emulator;
      saveLocked();
      return existing.id;
    }
  }

  CustomFolder nu = f;
  nu.path = np;
  nu.id = "c:" + slugify(f.name);
  bool dup = std::any_of(customFolders_.begin(), customFolders_.end(),
                         [&](const CustomFolder& x) { return x.id == nu.id; });
  if (dup)
    nu.id = "c:" + slugify(f.name) + "-" + std::to_string(customFolders_.size());
  customFolders_.push_back(std::move(nu));
  saveLocked();
  return customFolders_.back().id;
}

bool GameRegistry::removeCustomFolder(const std::string& id)
{
  std::lock_guard<std::mutex> lock(mtx_);
  auto it = std::remove_if(customFolders_.begin(), customFolders_.end(),
                           [&](const CustomFolder& f) { return f.id == id; });
  if (it == customFolders_.end())
    return false;
  customFolders_.erase(it, customFolders_.end());
  saveLocked();
  return true;
}

std::vector<CustomFolder> GameRegistry::customFolders() const
{
  std::lock_guard<std::mutex> lock(mtx_);
  return customFolders_;
}

// ---------------------------------------------------------------- queries --

const GameDefinition* GameRegistry::findById(const std::string& id) const
{
  std::lock_guard<std::mutex> lock(mtx_);
  for (const auto& g : user_)
    if (g.id == id)
      return &g;
  for (const auto& g : discovered_)
    if (g.id == id)
      return &g;
  return nullptr;
}

const GameDefinition* GameRegistry::findByExe(const std::string& exeLower) const
{
  const std::string key = toLower(exeLower);
  std::lock_guard<std::mutex> lock(mtx_);
  auto it = exeIndex_.find(key);
  if (it == exeIndex_.end())
    return nullptr;
  for (const auto& g : user_)
    if (g.id == it->second)
      return &g;
  for (const auto& g : discovered_)
    if (g.id == it->second)
      return &g;
  return nullptr;
}

const GameDefinition* GameRegistry::findByInstallPath(const std::string& lowerPath) const
{
  std::lock_guard<std::mutex> lock(mtx_);
  auto claim = [&](const GameDefinition& g) -> const GameDefinition* {
    if (!g.enabled)
      return nullptr;
    for (const auto& ip : g.installPaths)
      if (pathUnder(lowerPath, ip))
        return &g;
    return nullptr;
  };
  for (const auto& g : user_)
    if (const auto* hit = claim(g))
      return hit;
  for (const auto& g : discovered_)
    if (const auto* hit = claim(g))
      return hit;
  return nullptr;
}

std::vector<GameDefinition> GameRegistry::all() const
{
  std::lock_guard<std::mutex> lock(mtx_);
  std::vector<GameDefinition> out;
  out.reserve(user_.size() + discovered_.size());
  out.insert(out.end(), user_.begin(), user_.end());
  out.insert(out.end(), discovered_.begin(), discovered_.end());
  return out;
}

std::vector<GameDefinition> GameRegistry::userGames() const
{
  std::lock_guard<std::mutex> lock(mtx_);
  return user_;
}

std::vector<GameDefinition> GameRegistry::discoveredGames() const
{
  std::lock_guard<std::mutex> lock(mtx_);
  return discovered_;
}

// ----------------------------------------------------------------- ignore --

void GameRegistry::addIgnoredExe(const std::string& exeLower)
{
  std::lock_guard<std::mutex> lock(mtx_);
  const std::string exe = toLower(exeLower);
  if (exe.empty())
    return;
  if (std::find(ignoredExes_.begin(), ignoredExes_.end(), exe) == ignoredExes_.end())
    ignoredExes_.push_back(exe);
  saveLocked();
}

bool GameRegistry::removeIgnoredExe(const std::string& exeLower)
{
  std::lock_guard<std::mutex> lock(mtx_);
  const std::string exe = toLower(exeLower);
  auto it = std::find(ignoredExes_.begin(), ignoredExes_.end(), exe);
  if (it == ignoredExes_.end())
    return false;
  ignoredExes_.erase(it);
  saveLocked();
  return true;
}

bool GameRegistry::isIgnoredExe(const std::string& exeLower) const
{
  std::lock_guard<std::mutex> lock(mtx_);
  return std::find(ignoredExes_.begin(), ignoredExes_.end(), exeLower) != ignoredExes_.end();
}

std::vector<std::string> GameRegistry::ignoredExes() const
{
  std::lock_guard<std::mutex> lock(mtx_);
  return ignoredExes_;
}

// -------------------------------------------------------------- launchers --

void GameRegistry::setLauncherEnabled(const std::string& type, bool enabled)
{
  std::lock_guard<std::mutex> lock(mtx_);
  launcherEnabled_[type] = enabled;
  saveLocked();
}

bool GameRegistry::launcherEnabled(const std::string& type) const
{
  std::lock_guard<std::mutex> lock(mtx_);
  auto it = launcherEnabled_.find(type);
  return it == launcherEnabled_.end() || it->second; // enabled by default
}

std::map<std::string, bool> GameRegistry::launcherEnabledMap() const
{
  std::lock_guard<std::mutex> lock(mtx_);
  std::map<std::string, bool> out;
  for (const auto& type : {"steam", "epic", "gog", "ubisoft", "ea", "battlenet", "riot", "msstore", "heroic",
                           "custom"}) {
    auto it = launcherEnabled_.find(type);
    out[type] = it == launcherEnabled_.end() || it->second;
  }
  return out;
}

} // namespace clipforge
