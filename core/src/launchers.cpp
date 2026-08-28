#include "launchers.h"

#include "game_util.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <set>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

namespace clipforge {

namespace fs = std::filesystem;

using namespace std::chrono;

int64_t LauncherDiscovery::nowMs()
{
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

// ------------------------------------------------------------ Win32 impl ---

#ifdef _WIN32

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

bool fileExists(const std::string& p)
{
  std::error_code ec;
  return fs::exists(p, ec) && !fs::is_directory(p, ec);
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

#else

ScanContext LauncherDiscovery::defaults()
{
  ScanContext ctx;
  return ctx; // Linux-ready: providers return empty without Win32 roots
}

#endif

// ------------------------------------------------------------ exe scan ----

namespace {


std::string inferProductTypeFromName(const std::string& nameLower)
{
  if (nameLower.find(" dlc") != std::string::npos || nameLower.find("-dlc") != std::string::npos ||
      nameLower.find("dlc ") != std::string::npos || nameLower == "dlc")
    return "dlc";
  if (nameLower.find("sdk") != std::string::npos || nameLower.find("server") != std::string::npos ||
      nameLower.find("dedicated server") != std::string::npos)
    return "software";
  if (nameLower.find("tool") != std::string::npos || nameLower.find("redist") != std::string::npos ||
      nameLower.find("steamworks") != std::string::npos || nameLower == "steamvr")
    return "tool";
  if (nameLower.find("launcher") != std::string::npos || nameLower.find("helper") != std::string::npos)
    return "tool";
  if (nameLower.find("wallpaper") != std::string::npos)
    return "tool";
  return "game";
}


} // namespace


// ------------------------------------------------------------- VDF/ACF ----

namespace {

// Tolerant VDF/ACF tokenizer: quoted strings ("a b" with \\ escapes) and bare
// tokens; braces are returned as their own tokens.
std::vector<std::string> tokenizeVdf(const std::string& text)
{
  std::vector<std::string> out;
  size_t i = 0;
  const size_t n = text.size();
  while (i < n) {
    char c = text[i];
    if (std::isspace((unsigned char)c)) {
      i++;
      continue;
    }
    if (c == '{' || c == '}') {
      out.emplace_back(1, c);
      i++;
      continue;
    }
    if (c == '"') {
      std::string tok;
      i++;
      while (i < n && text[i] != '"') {
        if (text[i] == '\\' && i + 1 < n) {
          tok.push_back(text[i + 1]);
          i += 2;
        } else {
          tok.push_back(text[i]);
          i++;
        }
      }
      i++; // closing quote
      out.push_back(tok);
    } else {
      std::string tok;
      while (i < n && !std::isspace((unsigned char)text[i]) && text[i] != '{' && text[i] != '}') {
        tok.push_back(text[i]);
        i++;
      }
      out.push_back(tok);
    }
  }
  return out;
}

// Section-aware VDF tree: a key followed by '{' opens a section, a key
// followed by a value is a leaf pair. Sections can nest (libraryfolders.vdf).
struct VdfSection {
  std::map<std::string, std::string> values;
  std::vector<std::pair<std::string, VdfSection>> children;

  // Leaf value, searching this section only.
  const std::string* find(const std::string& key) const
  {
    auto it = values.find(key);
    return it == values.end() ? nullptr : &it->second;
  }
  // Direct child section by key.
  const VdfSection* child(const std::string& key) const
  {
    for (const auto& [k, s] : children)
      if (k == key)
        return &s;
    return nullptr;
  }
};

VdfSection parseVdfSection(const std::vector<std::string>& toks, size_t& i)
{
  VdfSection node;
  while (i < toks.size()) {
    const std::string key = toks[i++];
    if (i >= toks.size())
      break;
    const std::string val = toks[i++];
    if (val == "{") {
      node.children.push_back({key, parseVdfSection(toks, i)});
    } else if (val == "}") {
      return node;
    } else {
      node.values[key] = val;
    }
  }
  return node;
}

VdfSection parseVdf(const std::string& text)
{
  size_t i = 0;
  return parseVdfSection(tokenizeVdf(text), i);
}

std::string readFileText(const std::string& path)
{
  std::ifstream in(path, std::ios::binary);
  if (!in.is_open())
    return {};
  std::string out((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  return out;
}


class SteamBinaryReader {
public:
  SteamBinaryReader(const std::string& bytes, size_t start, size_t limit)
      : bytes_(bytes), pos_(start), limit_(std::min(limit, bytes.size()))
  {
  }

  bool u8(uint8_t& value)
  {
    if (pos_ >= limit_)
      return false;
    value = static_cast<uint8_t>(bytes_[pos_++]);
    return true;
  }

  bool u32(uint32_t& value)
  {
    if (limit_ - pos_ < 4)
      return false;
    value = static_cast<uint32_t>(static_cast<uint8_t>(bytes_[pos_])) |
            (static_cast<uint32_t>(static_cast<uint8_t>(bytes_[pos_ + 1])) << 8) |
            (static_cast<uint32_t>(static_cast<uint8_t>(bytes_[pos_ + 2])) << 16) |
            (static_cast<uint32_t>(static_cast<uint8_t>(bytes_[pos_ + 3])) << 24);
    pos_ += 4;
    return true;
  }

  bool u64(uint64_t& value)
  {
    uint32_t low = 0;
    uint32_t high = 0;
    if (!u32(low) || !u32(high))
      return false;
    value = static_cast<uint64_t>(low) | (static_cast<uint64_t>(high) << 32);
    return true;
  }

  bool skip(size_t count)
  {
    if (count > limit_ - pos_)
      return false;
    pos_ += count;
    return true;
  }

  bool cstring(std::string& value)
  {
    const size_t start = pos_;
    while (pos_ < limit_ && bytes_[pos_] != '\0')
      pos_++;
    if (pos_ >= limit_)
      return false;
    value.assign(bytes_.data() + start, pos_ - start);
    pos_++;
    return true;
  }

  bool wideString()
  {
    while (limit_ - pos_ >= 2) {
      const bool end = bytes_[pos_] == '\0' && bytes_[pos_ + 1] == '\0';
      pos_ += 2;
      if (end)
        return true;
    }
    return false;
  }

  size_t pos() const { return pos_; }

private:
  const std::string& bytes_;
  size_t pos_;
  size_t limit_;
};

bool parseSteamKvObject(SteamBinaryReader& reader, const std::vector<std::string>& strings,
                        int commonDepth, std::string& productType, int depth)
{
  if (depth > 64)
    return false;
  for (;;) {
    uint8_t type = 0;
    if (!reader.u8(type))
      return false;
    if (type == 8)
      return true;

    uint32_t keyIndex = 0;
    if (!reader.u32(keyIndex) || keyIndex >= strings.size())
      return false;
    const std::string& key = strings[keyIndex];

    if (type == 0) {
      const int childCommonDepth =
          commonDepth >= 0 ? commonDepth + 1 : (key == "common" ? 0 : -1);
      if (!parseSteamKvObject(reader, strings, childCommonDepth, productType, depth + 1))
        return false;
    } else if (type == 1) {
      std::string value;
      if (!reader.cstring(value))
        return false;
      if (commonDepth == 0 && key == "type")
        productType = toLower(value);
    } else if (type == 2 || type == 3 || type == 4 || type == 6) {
      if (!reader.skip(4))
        return false;
    } else if (type == 5) {
      if (!reader.wideString())
        return false;
    } else if (type == 7 || type == 10) {
      if (!reader.skip(8))
        return false;
    } else {
      return false;
    }
  }
}

std::map<uint32_t, std::string> readSteamProductTypes(const std::string& path)
{
  std::map<uint32_t, std::string> out;
  const std::string bytes = readFileText(path);
  if (bytes.size() < 20)
    return out;

  SteamBinaryReader header(bytes, 0, bytes.size());
  uint32_t magic = 0;
  uint32_t universe = 0;
  uint64_t stringTableOffset = 0;
  if (!header.u32(magic) || !header.u32(universe) || !header.u64(stringTableOffset) ||
      (magic >> 8) != 0x075644 || (magic & 0xff) != 41 || universe != 1 ||
      stringTableOffset >= bytes.size()) {
    return out;
  }

  SteamBinaryReader table(bytes, static_cast<size_t>(stringTableOffset), bytes.size());
  uint32_t stringCount = 0;
  if (!table.u32(stringCount) || stringCount > 100000)
    return out;
  std::vector<std::string> strings;
  strings.reserve(stringCount);
  for (uint32_t i = 0; i < stringCount; i++) {
    std::string value;
    if (!table.cstring(value))
      return {};
    strings.push_back(std::move(value));
  }

  size_t entryPos = 16;
  while (entryPos + 8 <= stringTableOffset) {
    SteamBinaryReader entryHeader(bytes, entryPos, static_cast<size_t>(stringTableOffset));
    uint32_t appid = 0;
    uint32_t entrySize = 0;
    if (!entryHeader.u32(appid) || !entryHeader.u32(entrySize) || appid == 0)
      break;
    const size_t payloadStart = entryHeader.pos();
    if (entrySize > stringTableOffset - payloadStart)
      break;
    const size_t entryEnd = payloadStart + entrySize;

    SteamBinaryReader entry(bytes, payloadStart, entryEnd);
    uint32_t ignored32 = 0;
    uint64_t ignored64 = 0;
    if (!entry.u32(ignored32) || !entry.u32(ignored32) || !entry.u64(ignored64) ||
        !entry.skip(20) || !entry.u32(ignored32) || !entry.skip(20)) {
      break;
    }

    uint8_t rootType = 0;
    uint32_t rootKey = 0;
    std::string productType;
    if (entry.u8(rootType) && rootType == 0 && entry.u32(rootKey) && rootKey < strings.size() &&
        parseSteamKvObject(entry, strings, -1, productType, 0) && !productType.empty()) {
      out[appid] = productType;
    }
    entryPos = entryEnd;
  }
  return out;
}

std::string normalizeSteamProductType(const std::string& type)
{
  const std::string lower = toLower(type);
  if (lower == "game" || lower == "demo")
    return "game";
  if (lower == "application" || lower == "software")
    return "software";
  if (lower == "tool")
    return "tool";
  if (lower == "dlc")
    return "dlc";
  return "unknown";
}
// Extract every value of an XML attribute regardless of namespace prefix
// (e.g. `Executable="..."`, `uap:Executable="..."`).
std::vector<std::string> xmlAttrs(const std::string& xml, const std::string& attr)
{
  std::vector<std::string> out;
  size_t pos = 0;
  const std::string needle = attr + "=\"";
  while (true) {
    // Find the attribute name at a tag boundary (quote, space, '/', '<').
    size_t at = xml.find(needle, pos);
    if (at == std::string::npos)
      break;
    // The char before the attribute name must not be alnum/'-'/'_'/':' so we
    // don't match "GameExecutable" when looking for "Executable".
    if (at > 0) {
      char prev = xml[at - 1];
      if (std::isalnum((unsigned char)prev) || prev == '-' || prev == '_' || prev == ':') {
        pos = at + 1;
        continue;
      }
    }
    size_t start = at + needle.size();
    size_t end = xml.find('"', start);
    if (end == std::string::npos)
      break;
    out.push_back(xml.substr(start, end - start));
    pos = end + 1;
  }
  return out;
}

} // namespace

// -------------------------------------------------------------- providers --

std::vector<GameDefinition> LauncherDiscovery::scanSteam(const ScanContext& ctx)
{
  std::vector<GameDefinition> out;
  if (ctx.steamLibraryFile.empty())
    return out;

  const VdfSection vdf = parseVdf(readFileText(ctx.steamLibraryFile));
  if (vdf.values.empty() && vdf.children.empty())
    return out;

  // libraryfolders.vdf wraps everything in a "libraryfolders" section whose
  // children are numbered folder sections; tolerate a root-level layout too.
  const VdfSection* folders = vdf.child("libraryfolders");
  const VdfSection* src = folders ? folders : &vdf;

  std::vector<std::string> libraryPaths;
  for (const auto& [folderKey, section] : src->children) {
    (void)folderKey;
    if (const std::string* p = section.find("path"))
      if (!p->empty())
        libraryPaths.push_back(*p);
  }
  if (libraryPaths.empty())
    return out;

  // The primary install is not always listed in the vdf; derive it from the
  // vdf location (<steam>/steamapps/libraryfolders.vdf).
  std::string steamDir = ctx.steamLibraryFile;
  const size_t apps = steamDir.find("steamapps");
  if (apps != std::string::npos)
    steamDir = steamDir.substr(0, apps);
  libraryPaths.push_back(steamDir);
  const std::string appInfoPath =
      !ctx.steamAppInfoFile.empty()
          ? ctx.steamAppInfoFile
          : (fs::path(steamDir) / "appcache" / "appinfo.vdf").string();
  const auto steamProductTypes = readSteamProductTypes(appInfoPath);

  std::set<std::string> seen;
  for (const auto& lib : libraryPaths) {
    std::error_code ec;
    const fs::path appsDir = fs::path(lib) / "steamapps";
    if (!fs::is_directory(appsDir, ec))
      continue;
    fs::directory_iterator it(appsDir, ec);
    if (ec)
      continue;
    for (const auto& e : it) {
      const std::string fname = e.path().filename().string();
      if (fname.rfind("appmanifest_", 0) != 0 || fname.size() < 15 ||
          fname.compare(fname.size() - 4, 4, ".acf") != 0)
        continue;
      std::error_code lec;
      if (!e.is_regular_file(lec))
        continue;
      const std::string appid = fname.substr(12, fname.size() - 16); // "appmanifest_" + id + ".acf"
      if (seen.count(appid))
        continue;
      seen.insert(appid);

      const VdfSection acf = parseVdf(readFileText(e.path().string()));
      const std::string* name = nullptr;
      const std::string* installdir = nullptr;
      // ACF wraps everything in a single "AppState" section; some tools omit
      // the wrapper, so check both the root and the first child.
      if (const std::string* n = acf.find("name"))
        name = n;
      if (const std::string* d = acf.find("installdir"))
        installdir = d;
      if (!acf.children.empty()) {
        const VdfSection& app = acf.children[0].second;
        if (!name && app.find("name"))
          name = app.find("name");
        if (!installdir && app.find("installdir"))
          installdir = app.find("installdir");
      }
      if (!name || !installdir)
        continue;

      // Steam's appcache carries the authoritative PICS product class. ACF
      // manifests intentionally omit it, which previously promoted every
      // installed Application (Wallpaper Engine, Blender, Baballonia, etc.)
      // to a game. Fall back to structural metadata only when appinfo is
      // unavailable; no app-id or executable denylist is involved.
      const std::string nameLower = toLower(*name);
      const std::string installLower = toLower(*installdir);
      std::string productType = inferProductTypeFromName(nameLower);
      try {
        const auto found = steamProductTypes.find(static_cast<uint32_t>(std::stoul(appid)));
        if (found != steamProductTypes.end()) {
          const std::string authoritative = normalizeSteamProductType(found->second);
          if (authoritative != "unknown")
            productType = authoritative;
        }
      } catch (...) {
      }
      if (installLower.find("_commonredist") != std::string::npos ||
          installLower.find("steamworks redist") != std::string::npos)
        productType = "tool";

      const fs::path installDir = appsDir / "common" / *installdir;
      std::error_code dec;
      if (!fs::is_directory(installDir, dec))
        continue;

      GameDefinition g;
      g.id = "d:steam:" + appid;
      g.name = *name;
      g.installPaths = {normalizePath(installDir.string())};
      g.launchers = {{"steam", appid}};
      g.productType = productType;
      g.source = GameSource::Discovered;
      out.push_back(std::move(g));
    }
  }
  return out;
}

std::vector<GameDefinition> LauncherDiscovery::scanEpic(const ScanContext& ctx)
{
  std::vector<GameDefinition> out;
  if (ctx.epicManifestsDir.empty())
    return out;
  std::error_code ec;
  if (!fs::is_directory(ctx.epicManifestsDir, ec))
    return out;

  fs::directory_iterator it(ctx.epicManifestsDir, ec);
  if (ec)
    return out;
  for (const auto& e : it) {
    std::error_code lec;
    if (!e.is_regular_file(lec) || e.path().extension() != ".item")
      continue;
    try {
      nlohmann::json j = nlohmann::json::parse(readFileText(e.path().string()));
      if (!j.is_object())
        continue;
      const std::string appName = j.value("AppName", std::string());
      const std::string displayName = j.value("DisplayName", std::string());
      const std::string install = j.value("InstallLocation", std::string());
      if (appName.empty() || install.empty())
        continue;
      bool thirdParty = false;
      if (j.contains("AppCategories") && j["AppCategories"].is_array())
        for (const auto& c : j["AppCategories"])
          if (c.is_string() && toLower(c.get<std::string>()) == "third-party")
            thirdParty = true;
      if (thirdParty)
        continue; // redirector manifest, not an installed game
      std::error_code dec;
      const bool installed = fs::is_directory(install, dec);
      GameDefinition g;
      g.id = "d:epic:" + appName;
      g.name = displayName.empty() ? appName : displayName;
      g.installPaths = {normalizePath(install)};
      g.launchers = {{"epic", appName}};
      g.productType = inferProductTypeFromName(toLower(g.name));
      g.source = GameSource::Discovered;
      g.stale = !installed;
      out.push_back(std::move(g));
    } catch (...) {
      continue; // corrupt manifest
    }
  }
  return out;
}

namespace {

GameDefinition registryGame(const ScanContext& ctx, const std::string& hive, const std::string& keyPath,
                            const std::string& id, const std::string& type, const std::string& nameKey,
                            const std::string& installKey, const std::string& exeKey)
{
  GameDefinition g;
  g.id = "d:" + type + ":" + id;
  g.name = ctx.readRegistry(hive, keyPath, nameKey);
  const std::string install = ctx.readRegistry(hive, keyPath, installKey);
  const std::string exe = ctx.readRegistry(hive, keyPath, exeKey);
  g.launchers = {{type, id}};
  g.source = GameSource::Discovered;
  g.productType = inferProductTypeFromName(toLower(g.name));
  if (!install.empty()) {
    std::error_code ec;
    g.stale = !fs::is_directory(install, ec);
    g.installPaths = {normalizePath(install)};
  } else if (!exe.empty()) {
    const fs::path executablePath(exe);
    if (executablePath.has_parent_path())
      g.installPaths = {normalizePath(executablePath.parent_path().string())};
  }
  if (g.name.empty() && !exe.empty())
    g.name = baseName(exe);
  return g;
}

} // namespace

std::vector<GameDefinition> LauncherDiscovery::scanGog(const ScanContext& ctx)
{
  std::vector<GameDefinition> out;
  const std::string base = "SOFTWARE\\WOW6432Node\\GOG.com\\Games";
  for (const auto& id : ctx.listRegistryKeys("HKLM", base)) {
    GameDefinition g = registryGame(ctx, "HKLM", base + "\\" + id, id, "gog", "gameName", "path", "gameExe");
    if (!g.installPaths.empty())
      out.push_back(std::move(g));
  }
  return out;
}

std::vector<GameDefinition> LauncherDiscovery::scanUbisoft(const ScanContext& ctx)
{
  std::vector<GameDefinition> out;
  const std::string base = "SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs";
  for (const auto& id : ctx.listRegistryKeys("HKLM", base)) {
    GameDefinition g =
        registryGame(ctx, "HKLM", base + "\\" + id, id, "ubisoft", "GameName", "InstallDir", "Exe");
    if (!g.installPaths.empty())
      out.push_back(std::move(g));
  }
  return out;
}

std::vector<GameDefinition> LauncherDiscovery::scanEa(const ScanContext& ctx)
{
  std::vector<GameDefinition> out;
  const std::string base = "SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Core\\Installed Games";
  for (const auto& id : ctx.listRegistryKeys("HKLM", base)) {
    GameDefinition g = registryGame(ctx, "HKLM", base + "\\" + id, id, "ea", "DisplayName", "Install Dir",
                                    "Game Exe");
    if (!g.executables.empty() || !g.installPaths.empty())
      out.push_back(std::move(g));
  }
  return out;
}

std::vector<GameDefinition> LauncherDiscovery::scanBattleNet(const ScanContext& ctx)
{
  std::vector<GameDefinition> out;
  const std::string base = "SOFTWARE\\WOW6432Node\\Blizzard Entertainment";
  for (const auto& key : ctx.listRegistryKeys("HKLM", base)) {
    const std::string keyPath = base + "\\" + key;
    // Unlike the other registry launchers, the game name IS the key name
    // ("World of Warcraft", "Diablo IV", ...); the values hold the paths.
    const std::string install = ctx.readRegistry("HKLM", keyPath, "InstallPath");
    const std::string gamePath = ctx.readRegistry("HKLM", keyPath, "GamePath");
    if (install.empty() && gamePath.empty())
      continue;
    GameDefinition g;
    g.id = "d:battlenet:" + key;
    g.name = key;
    g.launchers = {{"battlenet", key}};
    g.productType = inferProductTypeFromName(toLower(g.name));
    g.source = GameSource::Discovered;
    std::error_code ec;
    if (!install.empty()) {
      g.installPaths = {normalizePath(install)};
    } else if (!gamePath.empty()) {
      const fs::path executablePath(gamePath);
      if (executablePath.has_parent_path())
        g.installPaths = {normalizePath(executablePath.parent_path().string())};
    }
    if (!g.installPaths.empty())
      out.push_back(std::move(g));
  }
  return out;
}

std::vector<GameDefinition> LauncherDiscovery::scanRiot(const ScanContext& ctx)
{
  std::vector<GameDefinition> out;
  if (ctx.riotInstallsFile.empty())
    return out;
  try {
    const std::string text = readFileText(ctx.riotInstallsFile);
    if (text.empty())
      return out;
    nlohmann::json j = nlohmann::json::parse(text);
    if (!j.is_object())
      return out;
    // Walk the whole tree: any object with product_name + install path is a
    // game client (the file nests them under associated_game_clients.<key>).
    std::function<void(const nlohmann::json&, const std::string&)> walk =
        [&](const nlohmann::json& node, const std::string& keyPath) {
          if (!node.is_object())
            return;
          if (node.contains("product_install_full_path") && node["product_install_full_path"].is_string() &&
              (node.contains("product_name") && node["product_name"].is_string())) {
            const std::string install = node["product_install_full_path"].get<std::string>();
            const std::string name = node["product_name"].get<std::string>();
            std::error_code ec;
            if (!fs::is_directory(install, ec))
              return;
            GameDefinition g;
            g.id = "d:riot:" + keyPath;
            g.name = name;
            g.installPaths = {normalizePath(install)};
            g.launchers = {{"riot", keyPath}};
            g.productType = inferProductTypeFromName(toLower(g.name));
            g.source = GameSource::Discovered;
            out.push_back(std::move(g));
            return;
          }
          for (auto it = node.begin(); it != node.end(); ++it) {
            if (it.value().is_object() || it.value().is_array()) {
              const std::string childPath = keyPath.empty() ? it.key() : keyPath + "." + it.key();
              if (it.value().is_array()) {
                for (const auto& el : it.value())
                  walk(el, childPath);
              } else {
                walk(it.value(), childPath);
              }
            }
          }
        };
    walk(j, "");
  } catch (...) {
    // Corrupt/missing Riot data: nothing discovered.
  }
  return out;
}

std::vector<GameDefinition> LauncherDiscovery::scanMsStore(const ScanContext& ctx)
{
  std::vector<GameDefinition> out;
  if (ctx.msStorePackagesKey.empty() || !ctx.listRegistryKeys)
    return out;

  for (const auto& family : ctx.listRegistryKeys("HKCU", ctx.msStorePackagesKey)) {
    const std::string familyLower = toLower(family);
    // Known non-game package families (Store/Xbox infrastructure, bloat).
    static const std::vector<std::string> kBloat = {
        "microsoft.storepurchaseapp", "microsoft.windowsstore", "microsoft.windowsstoreui",
        "microsoft.xbox",             "microsoft.gamingoverlay", "microsoft.gamingservices",
        "microsoft.gamebar",          "microsoft.xboxgamecallableui", "microsoft.spartan",
        "microsoft.gamingapp",        "microsoft.windowsgaminghub",
    };
    bool bloat = false;
    for (const auto& b : kBloat)
      if (familyLower.find(b) == 0) {
        bloat = true;
        break;
      }
    if (bloat)
      continue;

    const std::string keyPath = ctx.msStorePackagesKey + "\\" + family;
    const std::string root = ctx.readRegistry("HKCU", keyPath, "PackageRootFolder");
    if (root.empty())
      continue;
    const std::string manifest = readFileText(root + "\\AppxManifest.xml");
    if (manifest.empty())
      continue;
    // Game Pass PC games are packaged desktop apps (full-trust process);
    // plain UWP apps are never full-trust.
    if (manifest.find("windows.fullTrustProcess") == std::string::npos)
      continue;

    std::string display = "";
    for (const auto& v : xmlAttrs(manifest, "DisplayName")) {
      display = v;
      break;
    }
    if (display.rfind("ms-resource:", 0) == 0)
      display = ""; // localized resource we cannot resolve cheaply
    if (display.empty()) {
      // Fall back to the package family name without the publisher hash.
      size_t us = family.rfind('_');
      display = us == std::string::npos ? family : family.substr(0, us);
    }

    GameDefinition g;
    g.id = "d:msstore:" + family;
    g.name = display;
    g.productType = inferProductTypeFromName(toLower(display));
    g.installPaths = {normalizePath(root)};
    g.launchers = {{"msstore", family}};
    g.source = GameSource::Discovered;
    if (!g.executables.empty() || !g.installPaths.empty())
      out.push_back(std::move(g));
  }
  return out;
}

std::vector<GameDefinition> LauncherDiscovery::scanHeroic(const ScanContext& ctx)
{
  std::vector<GameDefinition> out;
  if (ctx.heroicConfigDir.empty())
    return out;
  const fs::path configDir = fs::path(ctx.heroicConfigDir) / "games_config";
  std::error_code ec;
  if (!fs::is_directory(configDir, ec))
    return out;

  fs::directory_iterator it(configDir, ec);
  if (ec)
    return out;
  for (const auto& e : it) {
    std::error_code lec;
    if (!e.is_regular_file(lec) || e.path().extension() != ".json")
      continue;
    try {
      nlohmann::json j = nlohmann::json::parse(readFileText(e.path().string()));
      if (!j.is_object())
        continue;
      const std::string title = j.value("title", std::string());
      const std::string appName = j.value("app_name", std::string());
      const std::string install =
          j.contains("install") && j["install"].is_object() ? j["install"].value("path", std::string())
                                                            : std::string();
      if (title.empty() || install.empty())
        continue;
      std::error_code dec;
      if (!fs::is_directory(install, dec))
        continue; // Heroic entry without an installed path: skip
      GameDefinition g;
      g.id = "d:heroic:" + (appName.empty() ? slugify(title) : appName);
      g.name = title;
      g.installPaths = {normalizePath(install)};
      g.launchers = {{"heroic", appName.empty() ? g.id : appName}};
      g.productType = inferProductTypeFromName(toLower(g.name));
      g.source = GameSource::Discovered;
      out.push_back(std::move(g));
    } catch (...) {
      continue; // corrupt config
    }
  }
  return out;
}


// ------------------------------------------------------------------ scan ----

LauncherDiscovery::Result LauncherDiscovery::runOne(const std::string& type,
                                                    const std::vector<GameDefinition>& games)
{
  Result r;
  r.type = type;
  r.ran = true;
  r.lastScanMs = nowMs();
  r.games = (int)games.size();
  return r;
}


LauncherDiscovery::ScanOutput LauncherDiscovery::scanAll()
{
  ScanOutput output;

  struct Provider {
    const char* type;
    std::vector<GameDefinition> (*fn)(const ScanContext&);
  };
  static const Provider kProviders[] = {
      {"steam", scanSteam},     {"epic", scanEpic},         {"gog", scanGog},
      {"ubisoft", scanUbisoft}, {"ea", scanEa},             {"battlenet", scanBattleNet},
      {"riot", scanRiot},       {"msstore", scanMsStore},   {"heroic", scanHeroic},
  };

  for (const auto& provider : kProviders) {
    std::vector<GameDefinition> products;
    try {
      products = provider.fn(ctx_);
    } catch (...) {
      products.clear();
    }
    output.results.push_back(runOne(provider.type, products));
    for (auto& product : products)
      output.products.push_back(std::move(product));
  }
  return output;
}

} // namespace clipforge
