// Launcher discovery: finds installed games from launcher metadata without
// scanning the whole filesystem (Todo #3).
//
// Supported integrations:
//   steam    libraryfolders.vdf + appmanifest_*.acf (VDF/ACF text parsing)
//   epic     %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item (JSON)
//   gog      registry: HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id>
//   ubisoft  registry: HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id>
//   ea       registry: HKLM\SOFTWARE\WOW6432Node\Electronic Arts\EA Core\Installed Games\<id>
//   battlenet registry: HKLM\SOFTWARE\WOW6432Node\Blizzard Entertainment\<Game> (InstallPath/GamePath)
//   riot     %ProgramData%\Riot Games\RiotClientInstalls.json (JSON)
//   msstore  AppModel repository registry + AppxManifest.xml (packaged desktop
//            apps = Game Pass full-trust packages)
//
// All providers are pure given a ScanContext (injectable file roots + registry
// access) so they can be unit-tested against fixture directories. Registry
// access is abstracted behind two std::functions; production wires Win32
// Reg* calls, tests wire a fake map.
#pragma once

#include "game_registry.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace clipforge {

// A user-configured game folder scanned for games (indie/itch installs,
// emulator libraries, ...).
struct CustomFolderSpec {
  std::string id;
  std::string name;
  std::string path; // normalized
  bool emulator = false;
};

struct ScanContext {
  // File roots (tests point these at fixture dirs).
  std::string steamLibraryFile;   // <Steam>/steamapps/libraryfolders.vdf
  std::string epicManifestsDir;   // Epic Game Launcher Data/Manifests
  std::string riotInstallsFile;   // %ProgramData%/Riot Games/RiotClientInstalls.json
  std::string heroicConfigDir;    // %USERPROFILE%/.config/heroic (games_config/*.json)

  // User-configured game folders (populated from the registry before a scan).
  std::vector<CustomFolderSpec> customFolders;

  // Registry access (hive: "HKLM" | "HKCU"; keyPath without hive; valueName).
  std::function<std::string(const std::string& hive, const std::string& keyPath,
                            const std::string& valueName)>
      readRegistry;
  std::function<std::vector<std::string>(const std::string& hive, const std::string& keyPath)>
      listRegistryKeys;

  // MS Store AppModel repository key (subkeys enumerate installed packages).
  std::string msStorePackagesKey;
};

class LauncherDiscovery {
public:
  struct Result {
    std::string type;
    int games = 0;      // definitions merged into the registry
    bool ran = false;   // provider executed (enabled and present)
    int64_t lastScanMs = 0;
  };

  explicit LauncherDiscovery(GameRegistry& registry);
  void setContext(const ScanContext& ctx) { ctx_ = ctx; }

  // Scan every enabled launcher and merge results into the registry.
  std::vector<Result> scanAll();

  // Static pure providers (testable).
  static std::vector<GameDefinition> scanSteam(const ScanContext& ctx);
  static std::vector<GameDefinition> scanEpic(const ScanContext& ctx);
  static std::vector<GameDefinition> scanGog(const ScanContext& ctx);
  static std::vector<GameDefinition> scanUbisoft(const ScanContext& ctx);
  static std::vector<GameDefinition> scanEa(const ScanContext& ctx);
  static std::vector<GameDefinition> scanBattleNet(const ScanContext& ctx);
  static std::vector<GameDefinition> scanRiot(const ScanContext& ctx);
  static std::vector<GameDefinition> scanMsStore(const ScanContext& ctx);
  static std::vector<GameDefinition> scanHeroic(const ScanContext& ctx);
  static std::vector<GameDefinition> scanCustom(const ScanContext& ctx);

  // Fill well-known Windows paths (call once at startup on Windows).
  static ScanContext defaults();

  // Bounded executable scan of an install dir (depth-limited, noise dirs and
  // installer/redist artifacts skipped, capped count).
  static std::vector<std::string> scanDirForExes(const std::string& dir, int maxDepth = 3, int maxExes = 25);

  static int64_t nowMs();

private:
  static Result runOne(const std::string& type, const std::vector<GameDefinition>& games);

  GameRegistry& registry_;
  ScanContext ctx_;
};

} // namespace clipforge
