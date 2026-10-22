// Windows launcher discovery context: registry access and well-known
// launcher install paths.

#include "launchers.h"

#include <windows.h>

#include <cstdlib>
#include <string>
#include <vector>

namespace shard {

// ------------------------------------------------------------ Win32 impl ---

namespace {

const char* kAppModelPackagesKey =
    "SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\"
    "Packages";

std::string winReadRegistry(const std::string& hive, const std::string& keyPath, const std::string& valueName)
{
  HKEY root = hive == "HKCU" ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE;
  HKEY key = nullptr;
  if (RegOpenKeyExA(root, keyPath.c_str(), 0, KEY_READ | KEY_WOW64_64KEY, &key) != ERROR_SUCCESS)
    return "";
  std::string out;
  DWORD type = 0;
  DWORD size = 0;
  if (RegQueryValueExA(key, valueName.c_str(), nullptr, &type, nullptr, &size) == ERROR_SUCCESS && size > 0) {
    out.resize(size);
    DWORD actual = size;
    if (RegQueryValueExA(key, valueName.c_str(), nullptr, &type, reinterpret_cast<LPBYTE>(out.data()), &actual) ==
        ERROR_SUCCESS) {
      if (type == REG_SZ || type == REG_EXPAND_SZ) {
        while (!out.empty() && out.back() == '\0')
          out.pop_back();
      } else {
        out.clear(); // non-string value: not usable
      }
    } else {
      out.clear();
    }
  }
  RegCloseKey(key);
  return out;
}

std::vector<std::string> winListRegistryKeys(const std::string& hive, const std::string& keyPath)
{
  std::vector<std::string> out;
  HKEY root = hive == "HKCU" ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE;
  HKEY key = nullptr;
  if (RegOpenKeyExA(root, keyPath.c_str(), 0, KEY_READ | KEY_WOW64_64KEY, &key) != ERROR_SUCCESS)
    return out;
  char name[512];
  for (DWORD i = 0;; i++) {
    DWORD size = sizeof(name);
    LONG r = RegEnumKeyExA(key, i, name, &size, nullptr, nullptr, nullptr, nullptr);
    if (r == ERROR_NO_MORE_ITEMS)
      break;
    if (r != ERROR_SUCCESS)
      break;
    out.emplace_back(name, size);
  }
  RegCloseKey(key);
  return out;
}

} // namespace

ScanContext LauncherDiscovery::defaults()
{
  ScanContext ctx;
  ctx.readRegistry = winReadRegistry;
  ctx.listRegistryKeys = winListRegistryKeys;
  ctx.msStorePackagesKey = kAppModelPackagesKey;

  const char* pf86 = getenv("ProgramFiles(x86)");
  const char* pf = getenv("ProgramFiles");
  const char* pd = getenv("ProgramData");
  const char* drive = getenv("SystemDrive");

  if (pf86) {
    ctx.steamLibraryFile = std::string(pf86) + "\\Steam\\steamapps\\libraryfolders.vdf";
    ctx.steamAppInfoFile = std::string(pf86) + "\\Steam\\appcache\\appinfo.vdf";
  } else if (pf) {
    ctx.steamLibraryFile = std::string(pf) + "\\Steam\\steamapps\\libraryfolders.vdf";
    ctx.steamAppInfoFile = std::string(pf) + "\\Steam\\appcache\\appinfo.vdf";
  }
  if (pd)
    ctx.epicManifestsDir = std::string(pd) + "\\Epic\\EpicGamesLauncher\\Data\\Manifests";
  if (pd) {
    const std::string riotDir = std::string(pd) + "\\Riot Games";
    ctx.riotInstallsFile = riotDir + "\\RiotClientInstalls.json";
  }
  if (const char* home = getenv("USERPROFILE"))
    ctx.heroicConfigDir = std::string(home) + "\\.config\\heroic";
  (void)drive;
  return ctx;
}

} // namespace shard
