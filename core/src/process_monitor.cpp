#include "process_monitor.h"

#include <utility>
#include <vector>

// Platform parts (start, stop, tick, eventLoop, resolve, probeRuntime) live in
// platform/<os>/process_monitor_<os>.cpp.

namespace shard {

ProcessMonitor::~ProcessMonitor()
{
  stop();
}

void ProcessMonitor::pushEvent(const ProcessEvent& e)
{
  std::lock_guard<std::mutex> lock(mtx_);
  queue_.push_back(e);
}

void ProcessMonitor::applySnapshot(std::map<uint32_t, ProcessInfo> fresh)
{
  std::vector<ProcessEvent> toEmit;
  {
    std::lock_guard<std::mutex> lock(mtx_);

    // Apply queued WMI events first: they update table_ and are emitted
    // immediately (their pids then count as "known" for the diff below).
    while (!queue_.empty()) {
      ProcessEvent e = std::move(queue_.front());
      queue_.pop_front();
      if (e.type == ProcessEvent::Type::Started) {
        table_[e.info.pid] = e.info;
        if (fresh.find(e.info.pid) == fresh.end())
          fresh[e.info.pid] = e.info; // process already gone; still reported
      } else {
        table_.erase(e.info.pid);
      }
      toEmit.push_back(std::move(e));
    }

    // Carry lazily-resolved data (path/startMs) and the most precise start
    // time across snapshots.
    for (auto& [pid, p] : fresh) {
      auto it = table_.find(pid);
      if (it == table_.end())
        continue;
      if (p.parentPid == 0)
        p.parentPid = it->second.parentPid;
      if (it->second.startMs != 0)
        p.startMs = it->second.startMs;
      p.path = it->second.path;
      p.commandLine = it->second.commandLine;
    }

    // Diff: only genuinely new/exited processes produce events.
    for (const auto& [pid, p] : fresh)
      if (!table_.count(pid)) {
        ProcessEvent ev;
        ev.type = ProcessEvent::Type::Started;
        ev.info = p;
        toEmit.push_back(std::move(ev));
      }
    for (const auto& [pid, p] : table_) {
      (void)p;
      if (!fresh.count(pid)) {
        ProcessEvent ev;
        ev.type = ProcessEvent::Type::Exited;
        ev.info.pid = pid;
        toEmit.push_back(std::move(ev));
      }
    }

    table_ = std::move(fresh);
  }

  // Emit outside the lock: sinks call back into the monitor (resolve/lookup).
  if (sink_)
    for (const auto& ev : toEmit)
      sink_(ev);
}

ProcessInfo ProcessMonitor::lookup(uint32_t pid) const
{
  std::lock_guard<std::mutex> lock(mtx_);
  auto it = table_.find(pid);
  return it == table_.end() ? ProcessInfo{} : it->second;
}

std::vector<uint32_t> ProcessMonitor::ancestors(uint32_t pid, int maxDepth) const
{
  std::lock_guard<std::mutex> lock(mtx_);
  std::vector<uint32_t> out;
  uint32_t cur = pid;
  for (int i = 0; i < maxDepth && cur != 0; i++) {
    out.push_back(cur);
    auto it = table_.find(cur);
    if (it == table_.end() || it->second.parentPid == cur)
      break;
    cur = it->second.parentPid;
  }
  return out;
}

bool ProcessMonitor::alive(uint32_t pid) const
{
  std::lock_guard<std::mutex> lock(mtx_);
  return table_.find(pid) != table_.end();
}

std::vector<uint32_t> ProcessMonitor::allPids() const
{
  std::lock_guard<std::mutex> lock(mtx_);
  std::vector<uint32_t> out;
  out.reserve(table_.size());
  for (const auto& [pid, _] : table_) out.push_back(pid);
  return out;
}

} // namespace shard
