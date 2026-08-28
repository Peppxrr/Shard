// Installed-product discovery from launcher metadata. Providers return product
// ids/install roots as ephemeral live-detection hints; they never populate the
// user-visible game registry or recursively claim directory executables.
// Supported integrations:
//   steam    libraryfolders.vdf + appmanifest_*.acf + appcache/appinfo.vdf
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

struct ScanContext {
  // File roots (tests point these at fixture dirs).
  std::string steamLibraryFile;   // <Steam>/steamapps/libraryfolders.vdf
  std::string steamAppInfoFile;   // <Steam>/appcache/appinfo.vdf (authoritative product type)
  std::string epicManifestsDir;   // Epic Game Launcher Data/Manifests
  std::string riotInstallsFile;   // %ProgramData%/Riot Games/RiotClientInstalls.json
  std::string heroicConfigDir;    // %USERPROFILE%/.config/heroic (games_config/*.json)


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
    int games = 0;      // installed product hints found by the provider
    bool ran = false;   // provider executed (enabled and present)
    int64_t lastScanMs = 0;
  };

  struct ScanOutput {
    std::vector<Result> results;
    std::vector<GameDefinition> products;
  };

  LauncherDiscovery() = default;
  void setContext(const ScanContext& ctx) { ctx_ = ctx; }

  // Scan all available launchers. Product metadata is returned as ephemeral
  // identity hints; it is never merged into the user-visible game registry.
  ScanOutput scanAll();

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

  // Fill well-known Windows paths (call once at startup on Windows).
  static ScanContext defaults();


  static int64_t nowMs();

private:
  static Result runOne(const std::string& type, const std::vector<GameDefinition>& games);

  ScanContext ctx_;
};

} // namespace clipforge
