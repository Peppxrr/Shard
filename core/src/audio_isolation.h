// Per-application audio isolation: platform-independent routing decisions.
//
// An isolated app ("process" row with excludeFromDesktop) must exist on
// exactly one editable track. Windows process loopback captures a process
// tree's render streams on every endpoint, while endpoint loopback captures
// every process mixed together, so the Desktop track cannot simply subtract
// the app. Instead a filtered Desktop row is rebuilt from the processes that
// own audio sessions on its endpoint, excluding isolated application trees:
//
//   endpoint sessions ─┬─ discord.exe (not isolated) ─> Desktop track
//                      └─ spotify.exe (isolated)     ─> Spotify track only
//
// Every captured tree is mixed by OBS onto master mix 0 plus its row's mix, so
// the master contains each application once and the row mixes are disjoint
// stems. This file holds the decisions that can be tested without hardware;
// audio_isolation_capture.* applies them to live WASAPI/OBS objects.
#pragma once

#include "config.h"

#include <compare>
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace shard {

// Mix 0 is the master. Configured rows keep stable mixes 1..5 (rows past the
// fifth share mix 5), matching the replay ring/recorder track allocation.
uint32_t audioMixersForRow(size_t configuredIndex);

// Lowercase basename of the executable named by an OBS window descriptor
// ("class:title:exe", with ':' and '#' encoded as #3A / #22). Empty when the
// descriptor names no executable (an App audio row with no app chosen yet).
std::string isolationExeFromWindow(const std::string& window);

enum class AudioRowRoute {
  Disabled,        // row toggled off; keeps its mix reserved
  Device,          // OBS wasapi_input_capture / wasapi_output_capture
  AppWindow,       // OBS wasapi_process_output_capture (app also stays in Desktop)
  IsolatedApp,     // Shard process loopback of every process tree of the exe
  FilteredDesktop, // endpoint sessions minus isolated app trees
};

struct AudioRoutePlan {
  std::vector<AudioRowRoute> routes;     // one per configured row
  std::vector<std::string> isolatedExes; // unique, in configured order
  // An enabled row asked for isolation but process loopback is unavailable;
  // rows fall back to the duplicate-capture routes and the caller must log it.
  bool isolationUnavailable = false;
};

// `processLoopback` is true when the OS supports process loopback capture.
AudioRoutePlan routeAudioSources(const std::vector<AudioSourceConfig>& sources, bool processLoopback);

struct AudioProcess {
  uint32_t pid = 0;
  uint32_t parentPid = 0;
  std::string exe;         // lowercase basename
  uint64_t createTime = 0; // FILETIME ticks; 0 when unknown
};

// A PID is only an identity together with its creation time: Windows reuses
// PIDs, and a capture must never follow an unrelated process.
struct AudioProcessKey {
  uint32_t pid = 0;
  uint64_t createTime = 0;
  auto operator<=>(const AudioProcessKey&) const = default;
};

class AudioProcessForest {
public:
  explicit AudioProcessForest(std::vector<AudioProcess> processes);

  const AudioProcess* find(uint32_t pid) const;
  // The live parent, or nullptr when the parent exited (its PID may already
  // belong to a younger, unrelated process).
  const AudioProcess* parentOf(const AudioProcess& process) const;
  // True when `ancestor` is a strict ancestor of `process`.
  bool isAncestor(const AudioProcess& ancestor, const AudioProcess& process) const;
  // Nearest process on the chain (self first) whose exe is in `exes`.
  const AudioProcess* isolatedOwner(const AudioProcess& process, const std::set<std::string>& exes) const;
  const std::vector<AudioProcess>& processes() const { return processes_; }

private:
  std::vector<AudioProcess> processes_;
  std::unordered_map<uint32_t, size_t> index_;
};

// Shared-mode render sessions on one filtered Desktop row's endpoint.
struct EndpointSessions {
  bool available = false;     // endpoint exists and its sessions were enumerated
  std::vector<uint32_t> pids; // owning process of each non-expired session
};

struct IsolationPlan {
  // Process trees to capture for each isolated exe: every process of that exe
  // whose ancestors are not the same exe (all instances, restarts, helpers).
  std::map<std::string, std::vector<AudioProcessKey>> appRoots;
  // Process trees to capture for each filtered Desktop row (same order as the
  // `desktops` input). A session owned by a descendant of another captured
  // session process is already inside that tree and is not captured twice; a
  // process with sessions on several filtered endpoints goes to the first row.
  std::vector<std::vector<AudioProcessKey>> desktopRoots;

  struct Excluded {
    size_t row = 0;
    AudioProcessKey session;
    std::string exe;
    std::string isolatedExe;
  };
  // Endpoint sessions left out of a Desktop row because an isolated app owns them.
  std::vector<Excluded> excluded;

  struct Overlap {
    AudioProcessKey outer;
    std::string outerExe;
    std::string outerTrack; // "desktop:<row>" or "app:<exe>"
    AudioProcessKey inner;
    std::string innerExe;
    std::string innerTrack;
  };
  // A captured tree that also contains another track's root. Process loopback
  // has no single-process mode, so the inner tree is heard on both tracks;
  // audio is preserved and the controller reports isolation as degraded.
  std::vector<Overlap> overlaps;
};

IsolationPlan planAudioIsolation(const AudioProcessForest& forest, const std::vector<std::string>& isolatedExes,
                                 const std::vector<EndpointSessions>& desktops);

} // namespace shard
