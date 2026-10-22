#include "gpu_engines.h"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <map>
#include <tuple>

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

// GpuEngineMonitor (Impl, open, isOpen, sample) is implemented per platform
// in platform/<os>/gpu_engines_<os>.cpp.

} // namespace shard
