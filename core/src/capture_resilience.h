#pragma once

#include <atomic>
#include <cstdint>

namespace clipforge {

struct ClientAreaCrop {
  uint32_t left = 0;
  uint32_t top = 0;
  uint32_t right = 0;
  uint32_t bottom = 0;
  bool valid = false;
};

// WGC and DWM can disagree at the client/non-client boundary after DPI
// scaling, and some captioned games paint the resize separator inside the
// nominal client edge. Crop four logical pixels into captioned client areas;
// this removes the residual bar without affecting fullscreen/borderless games.
inline uint32_t captionBoundaryInset(uint32_t dpi) noexcept
{
  const uint32_t effectiveDpi = dpi ? dpi : 96;
  const uint32_t scaled = (4 * effectiveDpi + 95) / 96;
  return scaled < 4 ? 4 : scaled;
}

// Translate a physical Win32 client rectangle into crop margins for a WGC
// texture whose origin is the DWM extended-frame rectangle. Invalid or stale
// geometry returns an invalid zero crop so callers can keep the full surface
// live rather than turning capture black.
inline ClientAreaCrop computeClientAreaCrop(uint32_t sourceWidth, uint32_t sourceHeight,
                                            int64_t frameLeft, int64_t frameTop,
                                            int64_t clientLeft, int64_t clientTop,
                                            int64_t clientWidth, int64_t clientHeight) noexcept
{
  ClientAreaCrop crop;
  if (!sourceWidth || !sourceHeight || clientWidth <= 0 || clientHeight <= 0)
    return crop;

  const int64_t left = clientLeft > frameLeft ? clientLeft - frameLeft : 0;
  const int64_t top = clientTop > frameTop ? clientTop - frameTop : 0;
  if (left >= sourceWidth || top >= sourceHeight)
    return crop;

  const uint32_t visibleWidth = static_cast<uint32_t>(
      clientWidth < static_cast<int64_t>(sourceWidth) - left
          ? clientWidth
          : static_cast<int64_t>(sourceWidth) - left);
  const uint32_t visibleHeight = static_cast<uint32_t>(
      clientHeight < static_cast<int64_t>(sourceHeight) - top
          ? clientHeight
          : static_cast<int64_t>(sourceHeight) - top);
  if (!visibleWidth || !visibleHeight)
    return crop;

  crop.left = static_cast<uint32_t>(left);
  crop.top = static_cast<uint32_t>(top);
  crop.right = sourceWidth - crop.left - visibleWidth;
  crop.bottom = sourceHeight - crop.top - visibleHeight;
  crop.valid = true;
  return crop;
}

// Power callbacks may run on an OS worker thread while the source watchdog
// consumes recovery requests. Coalescing happens naturally through the flag.
class CaptureRecoveryState {
public:
  void onDisplayState(int state) noexcept
  {
    const int previous = displayState_.exchange(state);
    if (state == 1 && previous == 0)
      recoveryRequested_.store(true);
  }

  void onResume() noexcept { recoveryRequested_.store(true); }

  bool consumeRecovery() noexcept { return recoveryRequested_.exchange(false); }

private:
  std::atomic<int> displayState_{-1};
  std::atomic<bool> recoveryRequested_{false};
};

} // namespace clipforge
