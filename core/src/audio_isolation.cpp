#include "audio_isolation.h"

#include <algorithm>
#include <cctype>
#include <functional>

namespace shard {

namespace {

constexpr int kMaxAncestorHops = 64; // guards against PID-reuse cycles

std::string lower(std::string value)
{
  std::transform(value.begin(), value.end(), value.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return value;
}

std::string decodeWindowPart(const std::string& part)
{
  std::string out;
  out.reserve(part.size());
  for (size_t i = 0; i < part.size(); i++) {
    if (part[i] == '#' && i + 2 < part.size()) {
      const std::string code = part.substr(i + 1, 2);
      if (code == "3A") {
        out += ':';
        i += 2;
        continue;
      }
      if (code == "22") {
        out += '#';
        i += 2;
        continue;
      }
    }
    out += part[i];
  }
  return out;
}

AudioProcessKey keyOf(const AudioProcess& process)
{
  return {process.pid, process.createTime};
}

// Session owners that need their own capture so each is heard exactly once.
// An owner is skipped only when its direct parent is captured: one of
// `fixedRoots` or another kept owner (process loopback stops at children).
std::vector<const AudioProcess*> uncoveredOwners(const AudioProcessForest& forest,
                                                 const std::vector<const AudioProcess*>& owners,
                                                 const std::set<AudioProcessKey>& fixedRoots)
{
  std::set<AudioProcessKey> ownerKeys;
  for (const AudioProcess* owner : owners)
    ownerKeys.insert(keyOf(*owner));
  std::map<AudioProcessKey, bool> kept;
  const std::function<bool(const AudioProcess&)> keep = [&](const AudioProcess& process) {
    const AudioProcessKey key = keyOf(process);
    if (const auto it = kept.find(key); it != kept.end())
      return it->second;
    kept[key] = true; // provisional; breaks parent cycles from unknown creation times
    bool captured = fixedRoots.count(key) > 0;
    if (const AudioProcess* parent = forest.parentOf(process); parent && !captured) {
      const AudioProcessKey parentKey = keyOf(*parent);
      captured = fixedRoots.count(parentKey) || (ownerKeys.count(parentKey) && keep(*parent));
    }
    kept[key] = !captured;
    return !captured;
  };
  std::vector<const AudioProcess*> out;
  for (const AudioProcess* owner : owners) {
    if (keep(*owner))
      out.push_back(owner);
  }
  return out;
}

} // namespace

uint32_t audioMixersForRow(size_t configuredIndex)
{
  const size_t track = std::min<size_t>(configuredIndex + 1, 5);
  return (1u << 0) | (1u << static_cast<unsigned>(track));
}

std::vector<std::string> audioTrackTitles(const std::vector<AudioSourceConfig>& sources)
{
  // "Playback Mix" is what the app already recognizes as the master track.
  std::vector<std::string> titles{"Playback Mix"};
  for (size_t row = 0; row < sources.size(); row++) {
    const auto& source = sources[row];
    std::string name = source.name;
    const auto notSpace = [](unsigned char c) { return !std::isspace(c); };
    name.erase(name.begin(), std::find_if(name.begin(), name.end(), notSpace));
    name.erase(std::find_if(name.rbegin(), name.rend(), notSpace).base(), name.end());
    if (name.empty())
      name = source.kind == "input" ? "Microphone" : source.kind == "output" ? "System audio" : "Application audio";
    const size_t track = std::min<size_t>(row + 1, 5);
    if (track < titles.size())
      titles[track] += " + " + name;
    else
      titles.push_back(name);
  }
  return titles;
}

std::string isolationExeFromWindow(const std::string& window)
{
  // OBS descriptors are "class:title:exe"; Shard writes "::exe".
  const size_t first = window.find(':');
  const size_t second = first == std::string::npos ? std::string::npos : window.find(':', first + 1);
  std::string exe = decodeWindowPart(second == std::string::npos ? std::string() : window.substr(second + 1));
  const size_t slash = exe.find_last_of("\\/");
  if (slash != std::string::npos)
    exe = exe.substr(slash + 1);
  while (!exe.empty() && std::isspace(static_cast<unsigned char>(exe.back())))
    exe.pop_back();
  while (!exe.empty() && std::isspace(static_cast<unsigned char>(exe.front())))
    exe.erase(exe.begin());
  return lower(exe);
}

AudioRoutePlan routeAudioSources(const std::vector<AudioSourceConfig>& sources, bool processLoopback)
{
  AudioRoutePlan plan;
  plan.routes.resize(sources.size(), AudioRowRoute::Disabled);
  std::set<std::string> seen;
  for (const auto& source : sources) {
    if (!source.enabled || source.kind != "process" || !source.excludeFromDesktop)
      continue;
    const std::string exe = isolationExeFromWindow(source.window);
    if (!exe.empty() && seen.insert(exe).second)
      plan.isolatedExes.push_back(exe);
  }
  if (!plan.isolatedExes.empty() && !processLoopback) {
    plan.isolationUnavailable = true;
    plan.isolatedExes.clear();
  }
  const bool filtering = !plan.isolatedExes.empty();

  for (size_t i = 0; i < sources.size(); i++) {
    const auto& source = sources[i];
    if (!source.enabled)
      continue;
    if (source.kind == "process") {
      const bool isolated = filtering && source.excludeFromDesktop && !isolationExeFromWindow(source.window).empty();
      plan.routes[i] = isolated ? AudioRowRoute::IsolatedApp : AudioRowRoute::AppWindow;
    } else if (source.kind == "input") {
      plan.routes[i] = AudioRowRoute::Device;
    } else {
      plan.routes[i] = filtering ? AudioRowRoute::FilteredDesktop : AudioRowRoute::Device;
    }
  }
  return plan;
}

AudioProcessForest::AudioProcessForest(std::vector<AudioProcess> processes) : processes_(std::move(processes))
{
  index_.reserve(processes_.size());
  for (size_t i = 0; i < processes_.size(); i++)
    index_.emplace(processes_[i].pid, i);
}

const AudioProcess* AudioProcessForest::find(uint32_t pid) const
{
  const auto it = index_.find(pid);
  return it == index_.end() ? nullptr : &processes_[it->second];
}

const AudioProcess* AudioProcessForest::parentOf(const AudioProcess& process) const
{
  if (process.parentPid == 0 || process.parentPid == process.pid)
    return nullptr;
  const AudioProcess* parent = find(process.parentPid);
  if (!parent)
    return nullptr;
  // A parent created after its child is a reused PID, not the real parent.
  if (parent->createTime && process.createTime && parent->createTime > process.createTime)
    return nullptr;
  return parent;
}

bool AudioProcessForest::loopbackIncludes(const AudioProcess& root, const AudioProcess& process) const
{
  if (keyOf(root) == keyOf(process))
    return true;
  const AudioProcess* parent = parentOf(process);
  return parent && keyOf(*parent) == keyOf(root);
}

const AudioProcess* AudioProcessForest::isolatedOwner(const AudioProcess& process,
                                                      const std::set<std::string>& exes) const
{
  const AudioProcess* current = &process;
  for (int hop = 0; current && hop < kMaxAncestorHops; hop++) {
    if (exes.count(current->exe))
      return current;
    current = parentOf(*current);
  }
  return nullptr;
}

IsolationPlan planAudioIsolation(const AudioProcessForest& forest, const std::vector<std::string>& isolatedExes,
                                 const std::vector<EndpointSessions>& desktops)
{
  IsolationPlan plan;
  const std::set<std::string> isolated(isolatedExes.begin(), isolatedExes.end());

  struct Root {
    const AudioProcess* process;
    std::string track;
  };
  std::vector<Root> roots;

  for (const auto& exe : isolatedExes)
    plan.appRoots[exe];
  for (const auto& process : forest.processes()) {
    if (!isolated.count(process.exe))
      continue;
    bool nested = false;
    const AudioProcess* parent = forest.parentOf(process);
    for (int hop = 0; parent && hop < kMaxAncestorHops && !nested; hop++) {
      nested = parent->exe == process.exe;
      parent = forest.parentOf(*parent);
    }
    if (nested)
      continue;
    plan.appRoots[process.exe].push_back(keyOf(process));
    roots.push_back({&process, "app:" + process.exe});
  }
  for (auto& [exe, keys] : plan.appRoots)
    std::sort(keys.begin(), keys.end());

  std::map<const AudioProcess*, size_t> candidateRows;
  std::vector<const AudioProcess*> candidates;
  std::map<std::string, std::vector<const AudioProcess*>> appSessions;
  std::set<uint32_t> claimed;
  std::set<uint32_t> appClaimed;
  plan.desktopRoots.resize(desktops.size());
  for (size_t row = 0; row < desktops.size(); row++) {
    if (!desktops[row].available)
      continue;
    for (const uint32_t pid : desktops[row].pids) {
      // 0 = idle/system-sounds aggregate, 4 = System; neither is a capturable tree.
      if (pid <= 4)
        continue;
      const AudioProcess* process = forest.find(pid);
      if (!process)
        continue; // exited between session enumeration and the process snapshot
      if (const AudioProcess* owner = forest.isolatedOwner(*process, isolated)) {
        plan.excluded.push_back({row, keyOf(*process), process->exe, owner->exe});
        if (appClaimed.insert(pid).second)
          appSessions[owner->exe].push_back(process);
        continue;
      }
      if (claimed.insert(pid).second) {
        candidateRows[process] = row;
        candidates.push_back(process);
      }
    }
  }
  for (const AudioProcess* process : uncoveredOwners(forest, candidates, {})) {
    const size_t row = candidateRows[process];
    plan.desktopRoots[row].push_back(keyOf(*process));
    roots.push_back({process, "desktop:" + std::to_string(row)});
  }
  for (auto& keys : plan.desktopRoots)
    std::sort(keys.begin(), keys.end());
  // An isolated app's own captures hear only their direct children. A session
  // owner deeper in the tree it launched (a launcher's game) gets its own
  // capture on the app's track instead of being lost to both tracks.
  for (const auto& [exe, sessions] : appSessions) {
    auto& keys = plan.appRoots[exe];
    const std::set<AudioProcessKey> exeRoots(keys.begin(), keys.end());
    for (const AudioProcess* process : uncoveredOwners(forest, sessions, exeRoots)) {
      keys.push_back(keyOf(*process));
      roots.push_back({process, "app:" + exe});
    }
    std::sort(keys.begin(), keys.end());
  }

  for (const auto& outer : roots) {
    for (const auto& inner : roots) {
      if (outer.track == inner.track || outer.process == inner.process ||
          !forest.loopbackIncludes(*outer.process, *inner.process))
        continue;
      plan.overlaps.push_back({keyOf(*outer.process), outer.process->exe, outer.track, keyOf(*inner.process),
                               inner.process->exe, inner.track});
    }
  }
  return plan;
}

} // namespace shard
