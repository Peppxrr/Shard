#pragma once

#include <optional>

namespace shard {

// "Recording priority": an opt-in Task Scheduler task that starts only the
// native core elevated (RunLevel=Highest), so libobs-d3d11 can apply its own
// GPU scheduling priority without a UAC prompt on every launch. The Electron
// UI stays non-elevated and keeps using the localhost WebSocket.
//
// Command-line modes handled before normal core startup:
//   --priority-task status    --config-dir D --core-bin B --games G
//   --priority-task install   --config-dir D --core-bin B --games G  (UAC once)
//   --priority-task uninstall                                      (UAC if present)
//   --priority-bridge         <normal core args>  non-elevated stand-in for the
//                             core: starts the task and relays its stdio/exit
//   --priority-task run <pipe> <baked core args>  (started by Task Scheduler)
//
// The elevated process only ever runs a copy of the core runtime in an
// administrators-only directory under Program Files, never the user-writable
// install, so the task cannot be used to elevate a replaced binary.
//
// Returns the process exit code when argv selects one of these modes.
std::optional<int> runPriorityMode(int argc, char** argv);

// Bridge exit code asking the app to start the core normally instead.
inline constexpr int kPriorityFallbackExit = 124;

// Elevated processes resolve DLLs only from the application directory,
// System32 and explicitly added directories (never PATH or the CWD).
void hardenElevatedDllSearch();

// Whether the (non-elevated) interactive user may create files in `dir` or,
// if it does not exist yet, in its nearest existing ancestor. Used by an
// elevated core before writing clips/recordings to a configurable folder.
bool interactiveUserCanWrite(const char* dir);

} // namespace shard
