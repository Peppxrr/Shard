// ProcessMonitor on Linux: every tick reads a /proc snapshot (no root-free
// process event source exists; the netlink process connector needs
// CAP_NET_ADMIN). Wine/Proton processes are reported under their Windows
// executable name so launcher metadata, user mappings and the detector's
// Windows-oriented rules apply unchanged.
#include "process_monitor.h"

#include "game_util.h"
#include "runtime_roles.h"

#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <climits>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <limits>
#include <set>
#include <sstream>
#include <unordered_map>
#include <vector>

namespace shard {

namespace {

std::string readFile(const std::string& path, size_t maxBytes = 1 << 20)
{
  std::ifstream in(path, std::ios::binary);
  if (!in)
    return {};
  std::string out;
  char buffer[4096];
  while (out.size() < maxBytes) {
    in.read(buffer, sizeof(buffer));
    const std::streamsize n = in.gcount();
    if (n <= 0)
      break;
    out.append(buffer, static_cast<size_t>(n));
  }
  if (out.size() > maxBytes)
    out.resize(maxBytes);
  return out;
}

std::string readLink(const std::string& path)
{
  char buffer[PATH_MAX];
  const ssize_t n = readlink(path.c_str(), buffer, sizeof(buffer) - 1);
  if (n <= 0)
    return {};
  std::string out(buffer, static_cast<size_t>(n));
  // The kernel marks replaced/removed images; the name is still the image's.
  static const std::string kDeleted = " (deleted)";
  if (out.size() > kDeleted.size() && out.compare(out.size() - kDeleted.size(), kDeleted.size(), kDeleted) == 0)
    out.resize(out.size() - kDeleted.size());
  return out;
}

bool regularFile(const std::string& path)
{
  struct stat st = {};
  return stat(path.c_str(), &st) == 0 && S_ISREG(st.st_mode);
}

bool endsWith(const std::string& value, const char* suffix)
{
  const size_t length = std::strlen(suffix);
  return value.size() >= length && value.compare(value.size() - length, length, suffix) == 0;
}

bool startsWith(const std::string& value, const char* prefix)
{
  return value.rfind(prefix, 0) == 0;
}

int64_t bootTimeMs()
{
  static const int64_t value = [] {
    std::istringstream stat(readFile("/proc/stat"));
    std::string key;
    while (stat >> key) {
      if (key == "btime") {
        int64_t seconds = 0;
        stat >> seconds;
        return seconds * 1000;
      }
      stat.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
    }
    return int64_t{0};
  }();
  return value;
}

struct StatFields {
  std::string comm;
  uint32_t ppid = 0;
  uint64_t startTicks = 0;
};

// /proc/<pid>/stat: "pid (comm) state ppid ... starttime(22) ...". comm may
// contain spaces and parentheses, so fields are counted after the last ')'.
bool readStat(uint32_t pid, StatFields& out)
{
  const std::string text = readFile("/proc/" + std::to_string(pid) + "/stat", 4096);
  const size_t open = text.find('(');
  const size_t close = text.rfind(')');
  if (open == std::string::npos || close == std::string::npos || close < open)
    return false;
  out.comm = text.substr(open + 1, close - open - 1);
  std::istringstream fields(text.substr(close + 1));
  std::string field;
  for (int index = 3; fields >> field; index++) {
    if (index == 4)
      out.ppid = static_cast<uint32_t>(std::strtoul(field.c_str(), nullptr, 10));
    else if (index == 22) {
      out.startTicks = std::strtoull(field.c_str(), nullptr, 10);
      return true;
    }
  }
  return false;
}

int64_t startMsFromTicks(uint64_t ticks)
{
  static const long hz = sysconf(_SC_CLK_TCK);
  const int64_t boot = bootTimeMs();
  if (!boot || hz <= 0)
    return 0;
  return boot + static_cast<int64_t>(ticks * 1000 / static_cast<uint64_t>(hz));
}

std::vector<std::string> readArgs(uint32_t pid)
{
  const std::string raw = readFile("/proc/" + std::to_string(pid) + "/cmdline");
  std::vector<std::string> args;
  size_t start = 0;
  while (start < raw.size()) {
    size_t end = raw.find('\0', start);
    if (end == std::string::npos)
      end = raw.size();
    args.emplace_back(raw, start, end - start);
    start = end + 1;
  }
  return args;
}

// The detector parses command lines with Windows (CommandLineToArgvW) rules;
// quote arguments the same way so spaces inside one argv entry survive.
std::string joinCommandLine(const std::vector<std::string>& args)
{
  std::string out;
  for (const auto& arg : args) {
    if (!out.empty())
      out.push_back(' ');
    const bool quote = arg.empty() || arg.find_first_of(" \t\n\v\"") != std::string::npos;
    if (!quote) {
      out += arg;
      continue;
    }
    out.push_back('"');
    size_t backslashes = 0;
    for (char c : arg) {
      if (c == '\\') {
        backslashes++;
        continue;
      }
      if (c == '"')
        out.append(backslashes * 2 + 1, '\\');
      else
        out.append(backslashes, '\\');
      backslashes = 0;
      out.push_back(c);
    }
    out.append(backslashes * 2, '\\');
    out.push_back('"');
  }
  return out;
}

bool isWineLoader(const std::string& base)
{
  return base == "wine" || base == "wine64" || base == "wine-preloader" || base == "wine64-preloader";
}

bool windowsExecutableArg(const std::string& arg)
{
  return endsWith(toLower(arg), ".exe");
}

std::string environValue(uint32_t pid, const char* name)
{
  const std::string raw = readFile("/proc/" + std::to_string(pid) + "/environ");
  const std::string key = std::string(name) + "=";
  size_t start = 0;
  while (start < raw.size()) {
    size_t end = raw.find('\0', start);
    if (end == std::string::npos)
      end = raw.size();
    if (raw.compare(start, key.size(), key) == 0)
      return raw.substr(start + key.size(), end - start - key.size());
    start = end + 1;
  }
  return {};
}

// Unix path of a Wine argv0: "Z:\home\u\game.exe" maps to the root; other
// drives resolve through the prefix's dosdevices links. Original case.
std::string unixPathFromWine(uint32_t pid, const std::string& argv0)
{
  if (!argv0.empty() && argv0[0] == '/')
    return argv0;
  if (argv0.size() < 3 || !std::isalpha(static_cast<unsigned char>(argv0[0])) || argv0[1] != ':' ||
      (argv0[2] != '\\' && argv0[2] != '/'))
    return {};
  std::string rest = argv0.substr(2);
  for (char& c : rest)
    if (c == '\\')
      c = '/';
  const char drive = static_cast<char>(std::tolower(static_cast<unsigned char>(argv0[0])));
  if (drive == 'z')
    return rest;
  std::string prefix = environValue(pid, "WINEPREFIX");
  if (prefix.empty()) {
    const std::string home = environValue(pid, "HOME");
    if (home.empty())
      return {};
    prefix = home + "/.wine";
  }
  const std::string mapped = prefix + "/dosdevices/" + drive + ":" + rest;
  char resolved[PATH_MAX];
  return realpath(mapped.c_str(), resolved) ? std::string(resolved) : mapped;
}

struct Identity {
  std::string exe;  // lowercase basename
  std::string path; // original case; empty when unknown
  bool wine = false;
  bool provisional = false; // Wine loader before it renamed argv0
};

Identity identify(uint32_t pid, const std::string& comm, const std::vector<std::string>& args)
{
  Identity id;
  id.path = readLink("/proc/" + std::to_string(pid) + "/exe");
  const std::string imageBase = toLower(baseName(id.path));
  const std::string argv0 = args.empty() ? std::string() : args[0];
  if (windowsExecutableArg(argv0) && (isWineLoader(imageBase) || imageBase.empty() || imageBase != toLower(baseName(argv0)))) {
    id.wine = true;
    id.exe = toLower(baseName(argv0));
    id.path = unixPathFromWine(pid, argv0);
    return id;
  }
  if (isWineLoader(imageBase))
    id.provisional = true;
  // Processes of other users (and kernel threads) hide their image; comm is
  // the kernel's 15-character name, still the best available identity.
  id.exe = imageBase.empty() ? toLower(comm) : imageBase;
  return id;
}

// Windows module names: Proton/Wine maps PE modules from .dll files.
const char* const kGraphicsModules[] = {
    "d3d9.dll", "d3d10.dll", "d3d10_1.dll", "d3d11.dll", "d3d12.dll", "dxgi.dll", "opengl32.dll", "vulkan-1.dll",
};
const char* const kGameRuntimeModules[] = {
    "unityplayer.dll", "gameassembly.dll", "unityplayer.so", "gameassembly.so",
};
const char* const kModernGameInputModules[] = {
    "windows.gaming.input.dll", "gameinput.dll",
};
const char* const kControllerInputModules[] = {
    "dinput8.dll", "xinput1_4.dll", "xinput1_3.dll", "xinput9_1_0.dll",
};
const char* const kWebRuntimeModules[] = {
    "libcef.dll", "chrome_elf.dll", "msedge_elf.dll", "webview2loader.dll", "embeddedbrowserwebview.dll", "libcef.so",
};
const char* const kMediaRuntimeModules[] = {
    "libvlc.dll", "libvlccore.dll", "libmpv-2.dll", "gstreamer-1.0-0.dll",
};

template <size_t N>
bool moduleMatches(const std::string& name, const char* const (&candidates)[N])
{
  for (const char* candidate : candidates)
    if (name == candidate)
      return true;
  return false;
}

// Native shared objects: "libvulkan.so.1", "libGL.so.1.7.0", ...
bool sharedObject(const std::string& name, const char* stem)
{
  const std::string prefix = std::string(stem) + ".so";
  return name == prefix || startsWith(name, (prefix + ".").c_str());
}

bool hasElectronApplicationLayout(const std::string& imagePath)
{
  const size_t separator = imagePath.find_last_of('/');
  if (separator == std::string::npos)
    return false;
  const std::string root = imagePath.substr(0, separator);
  return regularFile(root + "/resources/app.asar") &&
         (regularFile(root + "/resources.pak") || regularFile(root + "/chrome_100_percent.pak"));
}

} // namespace

void ProcessMonitor::start(std::function<void(const ProcessEvent&)> sink)
{
  if (run_.exchange(true))
    return;
  sink_ = std::move(sink);
}

void ProcessMonitor::stop()
{
  run_.store(false);
}

// No unprivileged push source exists; tick() snapshots alone keep the table.
void ProcessMonitor::eventLoop() {}

namespace {

// Identity cache for tick(): the exe link is re-read every tick (one cheap
// readlink) and the command line only when the link changed or the process
// is a Wine loader that has not renamed argv0 yet. Owned by the tick thread.
struct CachedIdentity {
  int64_t startMs = 0;
  std::string link;
  std::string exe;
  bool provisional = false;
};
std::unordered_map<uint32_t, CachedIdentity> gIdentityCache;

} // namespace

void ProcessMonitor::tick()
{
  std::unordered_map<uint32_t, std::string> knownExe;
  {
    std::lock_guard<std::mutex> lock(mtx_);
    knownExe.reserve(table_.size());
    for (const auto& [pid, info] : table_)
      knownExe.emplace(pid, info.exe);
  }

  std::map<uint32_t, ProcessInfo> fresh;
  std::unordered_map<uint32_t, CachedIdentity> cache;
  cache.reserve(gIdentityCache.size());
  DIR* proc = opendir("/proc");
  if (!proc)
    return;
  while (dirent* entry = readdir(proc)) {
    char* end = nullptr;
    const unsigned long value = std::strtoul(entry->d_name, &end, 10);
    if (!value || !end || *end || value > UINT32_MAX)
      continue;
    const auto pid = static_cast<uint32_t>(value);
    StatFields stat;
    if (!readStat(pid, stat))
      continue;
    ProcessInfo p;
    p.pid = pid;
    p.parentPid = stat.ppid;
    p.startMs = startMsFromTicks(stat.startTicks);

    CachedIdentity identity;
    identity.startMs = p.startMs;
    identity.link = readLink("/proc/" + std::to_string(pid) + "/exe");
    const auto cached = gIdentityCache.find(pid);
    if (cached != gIdentityCache.end() && cached->second.startMs == p.startMs &&
        cached->second.link == identity.link && !cached->second.provisional) {
      identity = cached->second;
    } else {
      const Identity id = identify(pid, stat.comm, readArgs(pid));
      identity.exe = id.exe;
      identity.provisional = id.provisional;
    }
    p.exe = identity.exe;
    cache.emplace(pid, identity);

    // exec (or a Wine loader renaming argv0) changes the identity of a known
    // pid. Report it like a new process: leave it out of this snapshot
    // (Exited) so the next tick reports it Started under its new name.
    const auto known = knownExe.find(pid);
    if (known != knownExe.end() && !known->second.empty() && known->second != p.exe)
      continue;
    fresh.emplace(pid, std::move(p));
  }
  closedir(proc);
  gIdentityCache = std::move(cache);
  applySnapshot(std::move(fresh));
}

void ProcessMonitor::resolve(uint32_t pid)
{
  StatFields stat;
  if (!pid || !readStat(pid, stat))
    return;
  const std::vector<std::string> args = readArgs(pid);
  const Identity id = identify(pid, stat.comm, args);
  std::string path = toLower(id.path);
  std::string commandLine = toLower(joinCommandLine(args));
  const int64_t startMs = startMsFromTicks(stat.startTicks);

  std::lock_guard<std::mutex> lock(mtx_);
  auto it = table_.find(pid);
  if (it == table_.end())
    return;
  if (!id.exe.empty())
    it->second.exe = id.exe;
  if (!path.empty())
    it->second.path = std::move(path);
  if (!commandLine.empty())
    it->second.commandLine = std::move(commandLine);
  if (it->second.startMs == 0)
    it->second.startMs = startMs;
}

ProcessRuntimeFacts ProcessMonitor::probeRuntime(uint32_t pid) const
{
  ProcessRuntimeFacts facts;
  if (pid == 0)
    return facts;
  const ProcessInfo process = lookup(pid);
  facts.editorRuntime = isEditorProcess(process.exe, process.commandLine);

  StatFields stat;
  const std::vector<std::string> args = readArgs(pid);
  const Identity id = readStat(pid, stat) ? identify(pid, stat.comm, args) : Identity{};
  const size_t separator = id.path.find_last_of('/');
  if (separator != std::string::npos) {
    const std::string root = id.path.substr(0, separator);
    facts.editorRuntime = facts.editorRuntime || regularFile(root + "/Data/Managed/UnityEditor.dll") ||
                          regularFile(root + "/Data/Managed/UnityEngine/UnityEditor.dll");
  }
  // Electron keeps the same distribution layout and app.asar argument on
  // Linux (Discord, launchers, editors) as on Windows.
  facts.webRuntime = (!id.wine && hasElectronApplicationLayout(id.path)) ||
                     process.commandLine.find("app.asar") != std::string::npos;

  const std::string maps = readFile("/proc/" + std::to_string(pid) + "/maps", 16 << 20);
  if (maps.empty())
    return facts;
  facts.probeSucceeded = true;

  std::set<std::string> modules;
  size_t start = 0;
  while (start < maps.size()) {
    size_t end = maps.find('\n', start);
    if (end == std::string::npos)
      end = maps.size();
    // "addr perms offset dev inode   /path/to/file": only lines naming a file.
    const auto lineEnd = maps.begin() + static_cast<std::ptrdiff_t>(end);
    if (std::find(maps.begin() + static_cast<std::ptrdiff_t>(start), lineEnd, '/') != lineEnd) {
      const size_t base = maps.rfind('/', end - 1);
      modules.insert(toLower(maps.substr(base + 1, end - base - 1)));
    }
    start = end + 1;
  }

  bool modernGameInput = false;
  bool controllerInput = false;
  for (const auto& name : modules) {
    facts.graphicsApi = facts.graphicsApi || moduleMatches(name, kGraphicsModules) || sharedObject(name, "libvulkan") ||
                        sharedObject(name, "libgl") || sharedObject(name, "libegl") || startsWith(name, "libglx");
    // Editor-only modules override positive engine/input evidence.
    const bool editorModule = name == "unityeditor.dll" || startsWith(name, "unityeditor.") ||
                              startsWith(name, "unrealeditor-") || startsWith(name, "ue4editor-") ||
                              startsWith(name, "libunrealeditor-") || startsWith(name, "libue4editor-");
    facts.editorRuntime = facts.editorRuntime || editorModule;
    facts.gameRuntime = facts.gameRuntime || moduleMatches(name, kGameRuntimeModules) ||
                        (!editorModule && startsWith(name, "libunreal"));
    modernGameInput = modernGameInput || moduleMatches(name, kModernGameInputModules);
    controllerInput = controllerInput || moduleMatches(name, kControllerInputModules);
    facts.webRuntime = facts.webRuntime || moduleMatches(name, kWebRuntimeModules) || endsWith(name, ".node");
    facts.mediaRuntime = facts.mediaRuntime || moduleMatches(name, kMediaRuntimeModules) ||
                         sharedObject(name, "libvlc") || sharedObject(name, "libvlccore") ||
                         sharedObject(name, "libmpv") || sharedObject(name, "libgstreamer-1.0") ||
                         startsWith(name, "avformat-") || startsWith(name, "libavformat");
  }
  facts.gameInput = modernGameInput && controllerInput;
  return facts;
}

} // namespace shard
