#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace shard {

// One parsed "\GPU Engine(*)\Utilization Percentage" instance, e.g.
// "pid_1234_luid_0x00000000_0x0000F152_phys_0_eng_0_engtype_3D".
struct GpuEngineInstance {
  uint32_t pid = 0;
  uint64_t luid = 0;
  uint32_t phys = 0;
  uint32_t engine = 0;
  std::string type; // lowercase engine type: "3d", "videoencode", "copy", ...
};
bool parseGpuEngineInstance(std::string_view name, GpuEngineInstance& out);

struct GpuEngineUsage {
  uint32_t pid = 0;
  uint64_t luid = 0;
  uint32_t phys = 0;
  uint32_t engine = 0;
  std::string type;
  double percent = 0;
};

// Utilization of the capture adapter's engines, split by engine type and by
// process. Engine-type values follow Task Manager: per-engine utilization is
// summed over processes and the busiest engine of a type is reported.
struct GpuEngineSample {
  bool available = false;
  double engine3d = 0;      // busiest 3D engine, percent
  double videoEncode = 0;   // busiest video encode engine (NVENC/VCN/QSV), percent
  double copy = 0;          // busiest copy engine, percent
  double target3d = 0;      // 3D used by the capture subject's processes
  double self3d = 0;        // 3D used by this process
  double selfEncode = 0;    // video encode used by this process
  uint32_t top3dPid = 0;    // process using the most 3D time
  double top3d = 0;
};

// Pure aggregation, separated from PDH for tests.
GpuEngineSample aggregateGpuEngines(const std::vector<GpuEngineUsage>& usage, uint64_t adapterLuid,
                                    const std::vector<uint32_t>& targetPids, uint32_t selfPid);

// PDH reader for the GPU Engine counter set. Not thread-safe; owned by the
// performance monitor thread.
class GpuEngineMonitor {
public:
  GpuEngineMonitor();
  ~GpuEngineMonitor();
  GpuEngineMonitor(const GpuEngineMonitor&) = delete;
  GpuEngineMonitor& operator=(const GpuEngineMonitor&) = delete;

  // False when the counter set is unavailable (old OS/driver, disabled perf counters).
  bool open();
  bool isOpen() const;
  const std::string& lastError() const { return lastError_; }
  GpuEngineSample sample(uint64_t adapterLuid, const std::vector<uint32_t>& targetPids);

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  std::string lastError_;
};

} // namespace shard
