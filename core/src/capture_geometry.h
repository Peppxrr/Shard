#pragma once

#include <algorithm>
#include <cstdint>

namespace shard {

struct CaptureSize {
  uint32_t width = 0, height = 0;
  bool valid() const { return width >= 16 && height >= 16 && width <= 16384 && height <= 16384; }
  bool operator==(const CaptureSize&) const = default;
};

// Resolution presets are bounds, never a new aspect ratio. OBS aligns encoded
// width to four pixels and height to two; apply that explicitly before reset.
inline CaptureSize fitCaptureSize(CaptureSize source, CaptureSize bounds)
{
  if (!source.valid() || !bounds.valid()) return {};
  const double scale = std::min({1.0, static_cast<double>(bounds.width) / source.width,
                                static_cast<double>(bounds.height) / source.height});
  return {std::max(16u, static_cast<uint32_t>(source.width * scale) & ~3u),
          std::max(16u, static_cast<uint32_t>(source.height * scale) & ~1u)};
}

class CaptureSizeStability {
public:
  bool ready(CaptureSize size, uint64_t nowMs)
  {
    if (!size.valid()) { candidate_ = {}; since_ = nowMs; return false; }
    if (size != candidate_) { candidate_ = size; since_ = nowMs; return false; }
    return nowMs - since_ >= 1500;
  }
  void reset() { candidate_ = {}; }
private:
  CaptureSize candidate_;
  uint64_t since_ = 0;
};

} // namespace shard
