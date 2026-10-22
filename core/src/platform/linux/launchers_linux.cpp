// Launcher roots on Linux. Steam (native, legacy symlink or Flatpak) and
// Heroic keep their metadata in the user's home; registry-based providers
// (GOG Galaxy, Ubisoft, EA, Battle.net, MS Store) have nothing to read and
// return no products.
#include "launchers.h"

#include <cstdlib>
#include <filesystem>
#include <string>
#include <vector>

namespace shard {

namespace fs = std::filesystem;

namespace {

std::string firstDirectory(const std::vector<fs::path>& candidates)
{
  std::error_code ec;
  for (const auto& dir : candidates)
    if (fs::is_directory(dir, ec))
      return dir.string();
  return {};
}

} // namespace

ScanContext LauncherDiscovery::defaults()
{
  ScanContext ctx;
  ctx.readRegistry = [](const std::string&, const std::string&, const std::string&) { return std::string(); };
  ctx.listRegistryKeys = [](const std::string&, const std::string&) { return std::vector<std::string>(); };

  const char* homeEnv = std::getenv("HOME");
  if (!homeEnv || !*homeEnv)
    return ctx;
  const fs::path home = homeEnv;

  const std::string steam = firstDirectory({home / ".local/share/Steam", home / ".steam/steam",
                                            home / ".var/app/com.valvesoftware.Steam/.local/share/Steam"});
  if (!steam.empty()) {
    ctx.steamLibraryFile = (fs::path(steam) / "steamapps" / "libraryfolders.vdf").string();
    ctx.steamAppInfoFile = (fs::path(steam) / "appcache" / "appinfo.vdf").string();
  }

  ctx.heroicConfigDir =
      firstDirectory({home / ".config/heroic", home / ".var/app/com.heroicgameslauncher.hgl/config/heroic"});
  return ctx;
}

} // namespace shard
