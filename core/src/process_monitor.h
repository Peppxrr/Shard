// Event-driven process monitor (Todo #4).
//
// Primary: WMI async notifications (Win32_ProcessStartTrace / StopTrace) —
// the OS pushes process start/stop events; no polling. The WMI subscription
// runs on its own thread and queues events.
//
// Safety net: a cheap reconciliation scan (CreateToolhelp32Snapshot, ~1 ms)
// every tick() that diffs the process table against the previous snapshot, so
// missed WMI events (WMI unavailable, subscription hiccups) never lose a
// process. The owner loop calls tick() at ~1 Hz.
//
// The monitor emits *candidates* (raw process facts: pid, exe, parent, path
// on demand) — it never decides anything is a game (Todo #5).
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
  uint32_t parentPid = 0;
  int64_t startMs = 0;  // unix ms; 0 when unknown
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

  // Fill path/startMs for a pid (OpenProcess + QueryFullProcessImageName +
  // GetProcessTimes). Called lazily by the detector for candidates only.
  void resolve(uint32_t pid);
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
