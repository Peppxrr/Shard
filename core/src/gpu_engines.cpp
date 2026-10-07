#include "gpu_engines.h"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <map>
#include <tuple>

#ifdef _WIN32
#include <windows.h>
#include <pdh.h>
#include <pdhmsg.h>
#endif

namespace shard {

namespace {

bool parseNumber(std::string_view text, size_t& pos, int base, uint64_t& value)
{
  const char* begin = text.data() + pos;
  const char* end = text.data() + text.size();
  const auto result = std::from_chars(begin, end, value, base);
  if (result.ec != std::errc() || result.ptr == begin)
    return false;
  pos = static_cast<size_t>(result.ptr - text.data());
  return true;
}

bool expect(std::string_view text, size_t& pos, std::string_view token)
{
  if (text.substr(pos, token.size()) != token)
    return false;
  pos += token.size();
  return true;
}

bool isType(const std::string& type, std::string_view prefix)
{
  return type.compare(0, prefix.size(), prefix) == 0;
}

bool is3d(const std::string& type) { return type == "3d"; }
bool isEncode(const std::string& type) { return isType(type, "videoencode") || isType(type, "videocodec"); }
bool isCopy(const std::string& type) { return isType(type, "copy"); }

} // namespace

bool parseGpuEngineInstance(std::string_view name, GpuEngineInstance& out)
{
  std::string lower(name);
  std::transform(lower.begin(), lower.end(), lower.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  const std::string_view text(lower);
  size_t pos = 0;
  uint64_t pid = 0, high = 0, low = 0, phys = 0, engine = 0;
  if (!expect(text, pos, "pid_") || !parseNumber(text, pos, 10, pid))
    return false;
  if (!expect(text, pos, "_luid_0x") || !parseNumber(text, pos, 16, high))
    return false;
  if (!expect(text, pos, "_0x") || !parseNumber(text, pos, 16, low))
    return false;
  if (!expect(text, pos, "_phys_") || !parseNumber(text, pos, 10, phys))
    return false;
  if (!expect(text, pos, "_eng_") || !parseNumber(text, pos, 10, engine))
    return false;
  if (!expect(text, pos, "_engtype_") || pos >= text.size())
    return false;
  out.pid = static_cast<uint32_t>(pid);
  out.luid = (high << 32) | (low & 0xffffffffull);
  out.phys = static_cast<uint32_t>(phys);
  out.engine = static_cast<uint32_t>(engine);
  out.type = std::string(text.substr(pos));
  return true;
}

GpuEngineSample aggregateGpuEngines(const std::vector<GpuEngineUsage>& usage, uint64_t adapterLuid,
                                    const std::vector<uint32_t>& targetPids, uint32_t selfPid)
{
  GpuEngineSample sample;
  sample.available = true;
  std::map<std::tuple<uint32_t, uint32_t>, std::pair<std::string, double>> engines;
  std::map<uint32_t, double> process3d;
  for (const auto& item : usage) {
    if (adapterLuid && item.luid != adapterLuid)
      continue;
    auto& engine = engines[{item.phys, item.engine}];
    engine.first = item.type;
    engine.second += item.percent;
    if (is3d(item.type)) {
      process3d[item.pid] += item.percent;
      if (item.pid == selfPid)
        sample.self3d += item.percent;
      if (std::find(targetPids.begin(), targetPids.end(), item.pid) != targetPids.end())
        sample.target3d += item.percent;
    } else if (isEncode(item.type) && item.pid == selfPid) {
      sample.selfEncode = std::max(sample.selfEncode, item.percent);
    }
  }
  for (const auto& [key, engine] : engines) {
    const double percent = std::min(100.0, engine.second);
    if (is3d(engine.first))
      sample.engine3d = std::max(sample.engine3d, percent);
    else if (isEncode(engine.first))
      sample.videoEncode = std::max(sample.videoEncode, percent);
    else if (isCopy(engine.first))
      sample.copy = std::max(sample.copy, percent);
  }
  for (const auto& [pid, percent] : process3d) {
    if (percent > sample.top3d) {
      sample.top3d = std::min(100.0, percent);
      sample.top3dPid = pid;
    }
  }
  sample.target3d = std::min(100.0, sample.target3d);
  sample.self3d = std::min(100.0, sample.self3d);
  return sample;
}

#ifdef _WIN32

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

#else

struct GpuEngineMonitor::Impl {};
GpuEngineMonitor::GpuEngineMonitor() : impl_(std::make_unique<Impl>()) {}
GpuEngineMonitor::~GpuEngineMonitor() = default;
bool GpuEngineMonitor::open()
{
  lastError_ = "GPU engine counters are Windows-only";
  return false;
}
bool GpuEngineMonitor::isOpen() const { return false; }
GpuEngineSample GpuEngineMonitor::sample(uint64_t, const std::vector<uint32_t>&) { return {}; }

#endif

} // namespace shard
