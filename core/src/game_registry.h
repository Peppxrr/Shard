// Layered game registry: the single source of truth for game definitions.
//
// Layers (kept conceptually separate, merged at query time):
//   Discovered  found by launcher scanning (Steam/Epic/GOG/.../custom), persisted
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
// Persistence: games.json v2 at config.game.gamesPath (default
// <configDir>/games.json). v1 (flat [{exe,name}] arrays) is migrated into the
// user layer on load. Custom game folders (incl. emulator folders) are
// persisted here too.
#pragma once

#include <nlohmann/json.hpp>

#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace clipforge {

enum class GameSource { Discovered, User };

struct LauncherRef {
  std::string type; // steam | epic | gog | ubisoft | ea | battlenet | riot | msstore | heroic | custom
  std::string id;   // launcher-specific id (steam appid, epic appname, ...)

  bool operator==(const LauncherRef& o) const { return type == o.type && id == o.id; }
};

struct GameDefinition {
  std::string id;
  std::string name;
  std::vector<std::string> executables;  // lowercase exe basenames ("eldenring.exe")
  std::vector<std::string> installPaths; // normalized ("c:\\games\\eldenring\\")
  std::vector<LauncherRef> launchers;
  GameSource source = GameSource::Discovered;
  bool enabled = true;
  bool stale = false; // discovered entry whose install dir vanished
  bool emulator = false; // runs via an emulator (capture follows the game window)
  int64_t discoveredAtMs = 0;

  nlohmann::json toJson() const;
  static GameDefinition fromJson(const nlohmann::json& j, GameSource source);
};

// A user-configured game folder scanned for games (indie/itch installs,
// emulator libraries, ...).
struct CustomFolder {
  std::string id;
  std::string name;
  std::string path; // normalized
  bool emulator = false;

  nlohmann::json toJson() const;
  static CustomFolder fromJson(const nlohmann::json& j);
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
  // Add executables/installPaths to an existing user game (associate extra
  // executables).
  bool extendUserGame(const std::string& id, const std::vector<std::string>& executables,
                      const std::vector<std::string>& installPaths);

  // Merge a discovered scan result. If the normalized name matches an existing
  // user entry, the discovered metadata is merged into it; otherwise a
  // standalone discovered entry is created/updated by launcher id.
  void mergeDiscovered(const GameDefinition& g);

  // --------------------------------------------------------- custom fold --
  std::string addCustomFolder(const CustomFolder& f); // returns the id
  bool removeCustomFolder(const std::string& id);
  std::vector<CustomFolder> customFolders() const;

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

  // ------------------------------------------------------------ launchers --
  void setLauncherEnabled(const std::string& type, bool enabled);
  bool launcherEnabled(const std::string& type) const;
  std::map<std::string, bool> launcherEnabledMap() const;

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
  std::vector<CustomFolder> customFolders_;

  std::vector<std::string> ignoredExes_;
  std::map<std::string, bool> launcherEnabled_;

  // exe -> best definition id (rebuilt on every mutation).
  std::map<std::string, std::string> exeIndex_;

  bool verbose_ = false;
  size_t migratedV1_ = 0;
  int64_t lastSaveMs_ = 0;
};

} // namespace clipforge
