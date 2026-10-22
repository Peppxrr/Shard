// GPU engine utilization has no vendor-neutral per-process source on Linux
// (DRM fdinfo engine counters differ per driver and NVIDIA's proprietary
// driver exposes none), so perf samples report the monitor as unavailable.
#include "gpu_engines.h"

namespace shard {

struct GpuEngineMonitor::Impl {};

GpuEngineMonitor::GpuEngineMonitor() : impl_(std::make_unique<Impl>()) {}
GpuEngineMonitor::~GpuEngineMonitor() = default;

bool GpuEngineMonitor::open()
{
  lastError_ = "GPU engine counters are unavailable on Linux";
  return false;
}

bool GpuEngineMonitor::isOpen() const
{
  return false;
}

GpuEngineSample GpuEngineMonitor::sample(uint64_t, const std::vector<uint32_t>&)
{
  return {};
}

} // namespace shard
