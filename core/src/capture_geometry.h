#pragma once

#include <algorithm>
#include <cstdint>
#include <string>

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

// Live scene transforms can absorb source-size changes without discarding
// encoded history when the canvas proportions and output format stay fixed.
// An aspect/encoded-size change still needs the normal video reset boundary.
inline bool captureCanPreserveVideo(CaptureSize source, CaptureSize canvas,
                                    CaptureSize desiredOutput, CaptureSize currentOutput,
                                    uint32_t desiredFps, uint32_t fpsNum, uint32_t fpsDen)
{
  return source.valid() && canvas.valid() && desiredOutput.valid() && currentOutput.valid() &&
         uint64_t(source.width) * canvas.height == uint64_t(canvas.width) * source.height &&
         desiredOutput == currentOutput && desiredFps && fpsDen &&
         uint64_t(desiredFps) * fpsDen == fpsNum;
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

// Fitting the canvas to a new size resets OBS video, which restarts the
// encoders and discards the replay ring. The canvas belongs to the capture
// subject it was fitted for, so that subject's own format changes still fit
// natively. Another subject (game swap, desktop <-> game) is scaled inside the
// existing canvas while the ring retains history, and takes the canvas only
// once the ring has been idle (nothing left to lose).
class CaptureCanvasOwner {
public:
  // Call on every geometry tick; returns whether `subject` owns the canvas.
  bool update(const std::string& subject, bool ringActive)
  {
    if (!ringActive) owner_.clear();
    if (owner_.empty()) owner_ = subject;
    return !subject.empty() && subject == owner_;
  }
  const std::string& owner() const { return owner_; }
  // The canvas was refit; the next observed subject owns it.
  void reset() { owner_.clear(); }
private:
  std::string owner_;
};

} // namespace shard
