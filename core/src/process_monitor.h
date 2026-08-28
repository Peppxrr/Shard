// Event-driven process and runtime monitor.
//
// Primary: WMI async Win32_ProcessStartTrace / StopTrace notifications.
// Safety net: each tick reconciles a Toolhelp process snapshot, so WMI access
// failures or missed events cannot lose process lifecycle transitions.
//
// Path/start time/command line are resolved lazily. probeRuntime combines the
// candidate's loaded modules with structural application-host layout evidence
// for graphics, game-engine, web, and media runtimes; classification remains
// GameDetector's responsibility.
#pragma once

#include <atomic>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>

namespace clipforge {

struct ProcessInfo {
  uint32_t pid = 0;
  std::string exe;      // lowercase basename, e.g. "eldenring.exe"
  std::string path;     // lowercase full path (resolved on demand)
  std::string commandLine; // lowercase process command line when accessible
  uint32_t parentPid = 0;
  int64_t startMs = 0;  // unix ms; 0 when unknown
};

struct ProcessRuntimeFacts {
  bool probeSucceeded = false;
  bool graphicsApi = false;
  bool gameRuntime = false; // recognized game engine, not generic graphics/middleware
  bool gameInput = false; // modern gaming input plus XInput/DirectInput corroboration
  bool webRuntime = false;
  bool mediaRuntime = false;
};

struct ProcessEvent {
  enum class Type { Started, Exited };
  Type type = Type::Started;
  ProcessInfo info;
};

class ProcessMonitor {
public:
  ProcessMonitor() = default;
  ~ProcessMonitor();

  ProcessMonitor(const ProcessMonitor&) = delete;
  ProcessMonitor& operator=(const ProcessMonitor&) = delete;

  void start(std::function<void(const ProcessEvent&)> sink);
  void stop();

  // Drain WMI events + reconcile against a fresh snapshot; invoke the sink
  // for Started/Exited diffs. Call from the owner loop (~1 Hz).
  void tick();

  ProcessInfo lookup(uint32_t pid) const;
  // Walk the parent chain: [pid, parent, grandparent, ...] (maxDepth hops).
  std::vector<uint32_t> ancestors(uint32_t pid, int maxDepth = 5) const;
  bool alive(uint32_t pid) const;
  std::vector<uint32_t> allPids() const;

  // Fill path/startMs for a pid (OpenProcess + QueryFullProcessImageName +
  // GetProcessTimes). Called lazily by the detector for candidates only.
  void resolve(uint32_t pid);
  // Inspect modules loaded by the process itself. Recognized game-engine
  // modules provide identity; generic graphics/middleware modules only
  // corroborate a launcher-classified or user-mapped game.
  ProcessRuntimeFacts probeRuntime(uint32_t pid) const;
  bool wmiAvailable() const { return wmiOk_.load(); }

private:
  void wmiLoop();
  void pushEvent(const ProcessEvent& e);
  void applySnapshot();

  mutable std::mutex mtx_;
  std::map<uint32_t, ProcessInfo> table_;
  std::deque<ProcessEvent> queue_;
  std::function<void(const ProcessEvent&)> sink_;

  std::thread wmiThread_;
  std::atomic<bool> run_{false};
  std::atomic<bool> wmiOk_{false};
};

} // namespace clipforge
