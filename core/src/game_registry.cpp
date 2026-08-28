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
          {"productType", productType},
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
  if (j.contains("productType") && j["productType"].is_string())
    g.productType = j["productType"].get<std::string>();
  else
    g.productType = (source == GameSource::User ? "game" : "unknown");
  // Normalize
  if (g.productType != "game" && g.productType != "software" && g.productType != "tool" && g.productType != "dlc")
    g.productType = "unknown";
  return g;
}


// ------------------------------------------------------------------- load --

void GameRegistry::load()
{
  std::lock_guard<std::mutex> lock(mtx_);
  discovered_.clear();
  user_.clear();
  ignoredExes_.clear();
  hiddenDiscoveredIds_.clear();
  migratedV1_ = 0;
  bool rewriteMigratedFile = false;

  if (path_.empty())
    path_ = std::string("games.json"); // relative to configDir via cwd; overwritten by config.set
  std::ifstream in(path_);
  if (in.is_open()) {
    try {
      nlohmann::json j;
      in >> j;
      int fileVersion = 0;
      if (j.is_object() && j.contains("version") && j["version"].is_number_integer())
        fileVersion = j["version"].get<int>();

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
        rewriteMigratedFile = migratedV1_ > 0;
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
              if (!g.id.empty() && !g.name.empty() &&
                  (!g.executables.empty() || !g.installPaths.empty() || !g.launchers.empty()))
                discovered_.push_back(std::move(g));
            }
        if (j.contains("ignoredExes") && j["ignoredExes"].is_array())
          for (const auto& e : j["ignoredExes"])
            if (e.is_string())
              ignoredExes_.push_back(toLower(e.get<std::string>()));
        if (j.contains("hiddenDiscoveredIds") && j["hiddenDiscoveredIds"].is_array())
          for (const auto& e : j["hiddenDiscoveredIds"])
            if (e.is_string())
              hiddenDiscoveredIds_.insert(e.get<std::string>());
        if (j.contains("verboseDetection"))
          verbose_ = j.value("verboseDetection", false);
        // v10 invalidates every executable learned by the former permissive
        // graphics/fullscreen classifier. User mappings remain authoritative;
        // launcher products and runtime-engine games are re-qualified live by
        // the positive-only detector.
        if (fileVersion > 0 && fileVersion < 10) {
          discovered_.clear();
          hiddenDiscoveredIds_.clear();
          rewriteMigratedFile = true;
        } else if (fileVersion == 0 && !discovered_.empty()) {
          discovered_.clear();
          hiddenDiscoveredIds_.clear();
          rewriteMigratedFile = true;
        }
      }
    } catch (...) {
      // Corrupt games.json: empty registry, no crash.
    }
  }

  rebuildIndexes();
  if (rewriteMigratedFile)
    saveLocked();
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
  j["version"] = 10;
  {
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& game : user_)
      arr.push_back(game.toJson());
    j["user"] = std::move(arr);
  }
  {
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& game : discovered_)
      arr.push_back(game.toJson());
    j["discovered"] = std::move(arr);
  }
  j["ignoredExes"] = ignoredExes_;
  {
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& id : hiddenDiscoveredIds_)
      arr.push_back(id);
    j["hiddenDiscoveredIds"] = std::move(arr);
  }
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
  nu.productType = "game";
  if (!g.installPaths.empty()) nu.installPaths = g.installPaths;
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
  // Move all executables of the removed product to the ignored list so it
  // is never re-detected via unknown promotion or path fallback, even if a
  // future scan re-creates the same product with a different id (e.g., exe-
  // based unknown promotion). This satisfies "delete in detected → ignored".
  for (auto itr = it; itr != discovered_.end(); ++itr) {
    for (const auto& exe : itr->executables) {
      if (!exe.empty() && std::find(ignoredExes_.begin(), ignoredExes_.end(), exe) == ignoredExes_.end())
        ignoredExes_.push_back(exe);
    }
  }
  discovered_.erase(it, discovered_.end());
  hiddenDiscoveredIds_.insert(id);
  rebuildIndexes();
  saveLocked();
  return true;
}

bool GameRegistry::discardNonGameProduct(const std::string& id)
{
  std::lock_guard<std::mutex> lock(mtx_);
  const auto before = discovered_.size();
  discovered_.erase(std::remove_if(discovered_.begin(), discovered_.end(),
                                   [&](const GameDefinition& game) { return game.id == id; }),
                    discovered_.end());
  if (discovered_.size() == before)
    return false;
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
  // User explicitly removed this discovered product — don't re-add on rescan.
  std::string probeId = g.id;
  if (probeId.empty() && !g.launchers.empty())
    probeId = "d:" + g.launchers[0].type + ":" + g.launchers[0].id;
  if (!probeId.empty() && hiddenDiscoveredIds_.count(probeId))
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
    // Keep authoritative productType if provided and base is discovered; user entries stay "game"
    if (base.source == GameSource::Discovered && g.productType != "unknown" && !g.productType.empty())
      base.productType = g.productType;
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
    if (g.productType != "unknown" && !g.productType.empty())
      d.productType = g.productType;
    rebuildIndexes();
    saveLocked();
    return;
  }

  GameDefinition nd = g;
  nd.id = key;
  nd.source = GameSource::Discovered;
  if (nd.productType.empty()) nd.productType = "unknown";
  if (nd.discoveredAtMs == 0)
    nd.discoveredAtMs = nowMs();
  discovered_.push_back(std::move(nd));
  rebuildIndexes();
  saveLocked();
}

bool GameRegistry::addRuntimeExecutable(const std::string& productId, const std::string& exeLower)
{
  std::lock_guard<std::mutex> lock(mtx_);
  const std::string exe = toLower(exeLower);
  if (exe.empty() || productId.empty()) return false;
  for (auto& d : discovered_) if (d.id == productId) {
    if (std::find(d.executables.begin(), d.executables.end(), exe) == d.executables.end()) {
      d.executables.push_back(exe);
      rebuildIndexes();
      saveLocked();
      return true;
    }
    return false;
  }
  for (auto& u : user_) if (u.id == productId) {
    if (std::find(u.executables.begin(), u.executables.end(), exe) == u.executables.end()) {
      u.executables.push_back(exe);
      rebuildIndexes();
      saveLocked();
      return true;
    }
    return false;
  }
  return false;
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
  const GameDefinition* best = nullptr;
  size_t bestLength = 0;
  auto consider = [&](const GameDefinition& game) {
    if (!game.enabled)
      return;
    for (const auto& installPath : game.installPaths) {
      if (installPath.size() > bestLength && pathUnder(lowerPath, installPath)) {
        best = &game;
        bestLength = installPath.size();
      }
    }
  };
  // User products retain precedence when equally specific.
  for (const auto& game : user_)
    consider(game);
  for (const auto& game : discovered_)
    consider(game);
  return best;
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


} // namespace clipforge
