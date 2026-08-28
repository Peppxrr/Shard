// Layered game registry: the single source of truth for game definitions.
//
// Layers (kept conceptually separate, merged at query time):
//   Discovered  installed-product metadata + live-qualified executables
//   User        manually added by the user, persisted
//
// Identity rules:
//   * A definition is identified by its `id` (stable across restarts:
//     "d:<launcher>:<launcher-id>" discovered, "u:<slug>" user).
//   * When a discovered game's normalized name matches an existing user entry,
//     the discovered metadata (launcher refs, executables, install paths) is
//     MERGED into that entry instead of creating a duplicate row — one game,
//     one row, multiple mappings.
//   * Executable lookup resolves by precedence user > discovered so a user
//     override always wins.
//
// Persistence: games.json v10 at config.game.gamesPath (default
// <configDir>/games.json). Only user mappings and positively qualified live
// processes persist; explicit executable ignores are preserved.
#pragma once

#include <nlohmann/json.hpp>

#include <cstdint>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace clipforge {

enum class GameSource { Discovered, User };

struct LauncherRef {
  std::string type; // steam | epic | gog | ubisoft | ea | battlenet | riot | msstore | heroic | custom | runtime
  std::string id;   // launcher/product identity (runtime uses a stable path hash)

  bool operator==(const LauncherRef& o) const { return type == o.type && id == o.id; }
};

struct GameDefinition {
  std::string id;
  std::string name;
  // Only explicit user mappings and executables proven by positive live game
  // evidence. Launcher scans populate installPaths/launchers, never this list.
  std::vector<std::string> executables;  // lowercase exe basenames ("eldenring.exe")
  std::vector<std::string> installPaths; // normalized ("c:\\games\\eldenring\\")
  std::vector<LauncherRef> launchers;
  GameSource source = GameSource::Discovered;
  // Authoritative product classification from platform metadata
  // game | software | tool | dlc | unknown
  std::string productType = "unknown";
  bool enabled = true;
  bool stale = false; // discovered entry whose install dir vanished
  bool emulator = false; // runs via an emulator (capture follows the game window)
  int64_t discoveredAtMs = 0;

  // Classification derived with precedence:
  // 1. user override (source==User) => CONFIRMED_GAME
  // 2. authoritative productType
  std::string classification() const {
    if (source == GameSource::User) return "confirmed-game";
    if (productType == "game") return "confirmed-game";
    if (productType == "software" || productType == "tool" || productType == "dlc") return "confirmed-non-game";
    return "unknown";
  }

  nlohmann::json toJson() const;
  static GameDefinition fromJson(const nlohmann::json& j, GameSource source);
};


class GameRegistry {
public:
  GameRegistry() = default;

  void setPath(const std::string& path) { path_ = path; }
  const std::string& path() const { return path_; }

  // Read games.json (v1 or v2) and rebuild indexes. Missing/corrupt file:
  // builtin-only registry, no crash.
  void load();
  void save();

  // Requires mtx_ held (internal).
  void saveLocked();

  // ------------------------------------------------------------ mutations --
  // Add/update a user game. Returns the resulting id ("" on invalid input).
  // Duplicate executables within the user layer update the existing entry.
  std::string upsertUserGame(const GameDefinition& g);
  bool removeUserGame(const std::string& id);
  // Remove a standalone discovered entry (stale/unwanted scan results).
  bool removeDiscoveredGame(const std::string& id);
  // Remove a launcher product that authoritative metadata classifies as
  // software/tool. Unlike user removal, this does not ignore its executable
  // or hide the product id if Steam later reclassifies it as a game.
  bool discardNonGameProduct(const std::string& id);
  // Add executables/installPaths to an existing user game (associate extra
  // executables).
  bool extendUserGame(const std::string& id, const std::vector<std::string>& executables,
                      const std::vector<std::string>& installPaths);

  // Merge a discovered scan result. If the normalized name matches an existing
  // user entry, the discovered metadata is merged into it; otherwise a
  // standalone discovered entry is created/updated by launcher id.
  // If the id is in hiddenDiscoveredIds_ (user removed), it is skipped and not
  // re-added on rescan — this fixes "removed games came back" (the new Game
  // Detection UI shows only user/overrides, not the full discovered dump).
  void mergeDiscovered(const GameDefinition& g);
  // Add a positively qualified executable to an existing product. Persists
  // launcher-product associations; runtime-only identities still need current
  // game-engine evidence on every launch.
  bool addRuntimeExecutable(const std::string& productId, const std::string& exeLower);


  // ------------------------------------------------------------- queries --
  const GameDefinition* findById(const std::string& id) const;
  // Best definition for an executable (user > discovered), or null.
  const GameDefinition* findByExe(const std::string& exeLower) const;
  // Best definition whose install dir contains the (lowercased) process path.
  const GameDefinition* findByInstallPath(const std::string& lowerPath) const;
  // All definitions for UI display, layer order: user, discovered.
  std::vector<GameDefinition> all() const;
  std::vector<GameDefinition> userGames() const;
  std::vector<GameDefinition> discoveredGames() const;

  // ---------------------------------------------------------------- ignore --
  void addIgnoredExe(const std::string& exeLower);
  bool removeIgnoredExe(const std::string& exeLower);
  bool isIgnoredExe(const std::string& exeLower) const;
  std::vector<std::string> ignoredExes() const;


  void setVerboseLogging(bool on) { verbose_ = on; }
  bool verboseLogging() const { return verbose_; }

  size_t migratedV1Count() const { return migratedV1_; }
  int64_t lastSaveMs() const { return lastSaveMs_; }

private:
  friend class GameSystem; // migration hooks for tests
  void rebuildIndexes();

  mutable std::mutex mtx_;
  std::string path_;

  std::vector<GameDefinition> discovered_;
  std::vector<GameDefinition> user_;

   std::vector<std::string> ignoredExes_;
  std::set<std::string> hiddenDiscoveredIds_; // ids user explicitly removed (don't re-add on rescan)

  // exe -> best definition id (rebuilt on every mutation).
  std::map<std::string, std::string> exeIndex_;

  bool verbose_ = false;
  size_t migratedV1_ = 0;
  int64_t lastSaveMs_ = 0;
};

} // namespace clipforge
