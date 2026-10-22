// Windows GPU engine sampling: PDH "\\GPU Engine(*)\\Utilization Percentage".

#include "gpu_engines.h"

#include <windows.h>
#include <pdh.h>
#include <pdhmsg.h>

#include <string>

namespace shard {

struct GpuEngineMonitor::Impl {
  PDH_HQUERY query = nullptr;
  PDH_HCOUNTER counter = nullptr;
  bool primed = false;
  std::vector<unsigned char> buffer;
  std::vector<GpuEngineUsage> usage;
};

GpuEngineMonitor::GpuEngineMonitor() : impl_(std::make_unique<Impl>()) {}

GpuEngineMonitor::~GpuEngineMonitor()
{
  if (impl_->query)
    PdhCloseQuery(impl_->query);
}

bool GpuEngineMonitor::open()
{
  if (impl_->query)
    return true;
  PDH_STATUS status = PdhOpenQueryW(nullptr, 0, &impl_->query);
  if (status != ERROR_SUCCESS) {
    lastError_ = "PdhOpenQuery failed (" + std::to_string(status) + ")";
    impl_->query = nullptr;
    return false;
  }
  // English path: counter names are localized on non-English Windows.
  status = PdhAddEnglishCounterW(impl_->query, L"\\GPU Engine(*)\\Utilization Percentage", 0, &impl_->counter);
  if (status != ERROR_SUCCESS) {
    lastError_ = "GPU Engine counters unavailable (" + std::to_string(status) + ")";
    PdhCloseQuery(impl_->query);
    impl_->query = nullptr;
    return false;
  }
  // Utilization is a rate counter: the first collection only primes it.
  PdhCollectQueryData(impl_->query);
  impl_->primed = true;
  return true;
}

bool GpuEngineMonitor::isOpen() const
{
  return impl_->query != nullptr;
}

GpuEngineSample GpuEngineMonitor::sample(uint64_t adapterLuid, const std::vector<uint32_t>& targetPids)
{
  GpuEngineSample empty;
  if (!impl_->query)
    return empty;
  // Wildcard instances are re-enumerated on every collection, so processes
  // that start after the query was opened are included.
  if (PdhCollectQueryData(impl_->query) != ERROR_SUCCESS)
    return empty;
  DWORD bytes = 0, count = 0;
  PDH_STATUS status = PdhGetFormattedCounterArrayW(impl_->counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &bytes, &count,
                                                   nullptr);
  if (status != PDH_MORE_DATA || !bytes)
    return empty;
  impl_->buffer.resize(bytes);
  auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(impl_->buffer.data());
  status = PdhGetFormattedCounterArrayW(impl_->counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &bytes, &count, items);
  if (status != ERROR_SUCCESS)
    return empty;
  impl_->usage.clear();
  impl_->usage.reserve(count);
  std::string name;
  for (DWORD i = 0; i < count; ++i) {
    const auto& item = items[i];
    if (item.FmtValue.CStatus != PDH_CSTATUS_VALID_DATA && item.FmtValue.CStatus != PDH_CSTATUS_NEW_DATA)
      continue;
    if (item.FmtValue.doubleValue <= 0.0)
      continue;
    // Instance names are ASCII.
    name.clear();
    for (const wchar_t* c = item.szName; c && *c; ++c)
      name.push_back(static_cast<char>(*c & 0x7f));
    GpuEngineInstance instance;
    if (!parseGpuEngineInstance(name, instance))
      continue;
    impl_->usage.push_back({instance.pid, instance.luid, instance.phys, instance.engine, std::move(instance.type),
                            item.FmtValue.doubleValue});
  }
  return aggregateGpuEngines(impl_->usage, adapterLuid, targetPids, GetCurrentProcessId());
}

} // namespace shard
