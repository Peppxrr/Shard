#include "capture_resilience.h"
#include "replay_timing.h"
#include "capture_geometry.h"

#include <cassert>
#include <cstdio>
#include <array>

using shard::CaptureRecoveryState;
using shard::CaptureRecoverySchedule;
using shard::captureHookRetryDelayMs;
using shard::computeClientAreaCrop;
using shard::captionBoundaryInset;

int main()
{
  using shard::CaptureSize;
  assert((shard::fitCaptureSize({3440, 1440}, {1280, 720}) == CaptureSize{1280, 534}));
  assert((shard::fitCaptureSize({2560, 1600}, {1280, 720}) == CaptureSize{1152, 720}));
  assert((shard::fitCaptureSize({1280, 960}, {1280, 720}) == CaptureSize{960, 720}));
  assert((shard::fitCaptureSize({800, 600}, {1920, 1080}) == CaptureSize{800, 600}));
  shard::CaptureSizeStability stable;
  assert(!stable.ready({800, 600}, 100));
  assert(!stable.ready({800, 600}, 1500));
  assert(stable.ready({800, 600}, 1600));
  assert(!stable.ready({1280, 960}, 1700));
  assert(!stable.ready({}, 3000));
  assert(!stable.ready({1280, 960}, 4000));
  using shard::CaptureFrameContent;
  using shard::CaptureBackendHealth;
  constexpr uint32_t probeWidth = 64, probeHeight = 36, stride = 272;
  std::array<uint8_t, stride * probeHeight> pixels{};
  assert(shard::captureFrameContent(nullptr, probeWidth, probeHeight, stride) == CaptureFrameContent::Unknown);
  assert(shard::captureFrameContent(pixels.data(), probeWidth, probeHeight, stride) == CaptureFrameContent::Black);
  // Bright window chrome outside the interior is not a working game image.
  for (uint32_t y = 0; y < probeHeight; ++y) {
    for (uint32_t x = 0; x < probeWidth; ++x) {
      auto* p = pixels.data() + y * stride + x * 4;
      p[3] = 255;
      if (y < probeHeight / 5 || x < probeWidth / 5) p[0] = p[1] = p[2] = 255;
    }
  }
  assert(shard::captureFrameContent(pixels.data(), probeWidth, probeHeight, stride) == CaptureFrameContent::Black);
  pixels[18 * stride + 32 * 4] = 255; // A cursor-sized speck is not enough.
  assert(shard::captureFrameContent(pixels.data(), probeWidth, probeHeight, stride) == CaptureFrameContent::Black);
  pixels.fill(80);
  assert(shard::captureFrameContent(pixels.data(), probeWidth, probeHeight, stride) == CaptureFrameContent::Content);

  CaptureBackendHealth health;
  for (uint64_t t = 500; t <= 10000; t += 500)
    health.sample(CaptureFrameContent::Black, CaptureFrameContent::Black, t);
  assert(!health.hookRejected()); // Legitimate black loading screen.
  for (uint64_t t = 10500; t <= 13000; t += 500)
    health.sample(CaptureFrameContent::Black, CaptureFrameContent::Content, t);
  assert(!health.hookRejected()); // Transient disagreement must settle.
  health.sample(CaptureFrameContent::Black, CaptureFrameContent::Content, 13500);
  assert(health.hookRejected());
  health.sample(CaptureFrameContent::Unknown, CaptureFrameContent::Unknown, 14000);
  assert(health.hookRejected()); // Minimize/missing frames do not clear failure.
  for (uint64_t t = 14500; t <= 16000; t += 500)
    health.sample(CaptureFrameContent::Content, CaptureFrameContent::Content, t);
  assert(health.hookRejected());
  health.sample(CaptureFrameContent::Content, CaptureFrameContent::Content, 16500);
  assert(!health.hookRejected()); // Sustained hook recovery restores preference.
  health.sample(CaptureFrameContent::Black, CaptureFrameContent::Content, 17000);
  health.sample(CaptureFrameContent::Black, CaptureFrameContent::Content, 30000);
  assert(!health.hookRejected()); // Scheduling/sleep gap is not evidence.
  health = {};
  for (uint64_t t = 500; t <= 10000; t += 500)
    health.sample(CaptureFrameContent::Black, CaptureFrameContent::Unknown, t);
  assert(!health.hookRejected()); // Never promote an unverified black fallback.

  // A full five-minute 60 fps replay retains every distinct decode timestamp,
  // negative preroll, B-frame ordering, and genuine missing-frame gaps.
  for (int64_t frame = 0; frame < 18000; ++frame) {
    const auto timing = shard::replayTimestamps(frame + 2, frame, 60, 60, 1500000);
    assert(timing.dts == frame - 90);
    assert(timing.pts - timing.dts == 2);
  }
  const auto bframe = shard::replayTimestamps(101, 102, 60, 60, 1500000);
  assert(bframe.pts == 11 && bframe.dts == 12);
  assert(shard::replayTimestamps(1001, 1001, 60000, 60000, 0).dts == 1001);
  assert(shard::replayTimestamps(48000, 48000, 48000, 48000, 1500000).dts == -24000);
  assert(shard::replayTimestamps(108, 106, 60, 60, 1500000).dts == 16);
  assert(shard::replayCanPurge(false, 3));
  assert(!shard::replayCanPurge(false, 2));
  assert(!shard::replayCanPurge(true, 3));
  const auto framed = computeClientAreaCrop(976, 579, 100, 100, 108, 131, 960, 540);
  assert(framed.valid);
  assert(framed.left == 8);
  assert(framed.top == 31);
  assert(framed.right == 8);
  assert(framed.bottom == 8);

  assert(captionBoundaryInset(96) == 4);
  assert(captionBoundaryInset(120) == 5);
  assert(captionBoundaryInset(192) == 8);
  const auto guarded =
      computeClientAreaCrop(976, 579, 100, 100, 108, 131 + captionBoundaryInset(120),
                            960, 540 - captionBoundaryInset(120));
  assert(guarded.valid);
  assert(guarded.top == 36);
  assert(guarded.bottom == 8);

  const auto borderless = computeClientAreaCrop(1920, 1080, 0, 0, 0, 0, 1920, 1080);
  assert(borderless.valid);
  assert(borderless.left == 0 && borderless.top == 0 && borderless.right == 0 && borderless.bottom == 0);

  const auto stale = computeClientAreaCrop(1280, 720, 0, 0, 5000, 5000, 960, 540);
  assert(!stale.valid);
  assert(stale.left == 0 && stale.top == 0 && stale.right == 0 && stale.bottom == 0);

  CaptureRecoveryState recovery;
  recovery.onDisplayState(1); // Initial registration callback: not a wake.
  assert(!recovery.consumeRecovery());
  recovery.onDisplayState(0);
  assert(!recovery.consumeRecovery());
  recovery.onDisplayState(1);
  assert(recovery.consumeRecovery());
  assert(!recovery.consumeRecovery());
  recovery.onResume();
  assert(recovery.consumeRecovery());
  recovery.onDisplayState(0);
  recovery.onDisplayState(2); // Some displays first wake into the dimmed state.
  assert(recovery.consumeRecovery());
  recovery.onDisplayState(1);
  assert(!recovery.consumeRecovery()); // Dimmed -> on does not require another rebuild.
  recovery.onGraphicsRebuilt();
  assert(recovery.consumeRecovery());

  CaptureRecoverySchedule schedule;
  assert(!schedule.consumeDue(10000));
  recovery.onResume();
  recovery.onGraphicsRebuilt();
  assert(recovery.consumeRecovery());
  assert(!recovery.consumeRecovery());
  schedule.request(10000);
  assert(!schedule.consumeDue(11000)); // Give the driver time to settle.
  schedule.request(11000); // Interactive wake follows automatic wake.
  assert(!schedule.consumeDue(11500));
  assert(schedule.consumeDue(12500));
  assert(!schedule.consumeDue(13000));
  schedule.request(13000); // A later GPU reset is retained, not discarded.
  assert(!schedule.consumeDue(14500));
  assert(schedule.consumeDue(17500)); // No repeated rebuild inside five seconds.
  assert(!schedule.consumeDue(18000));
  schedule.request(3600000); // A later full sleep/wake still recovers.
  assert(!schedule.consumeDue(3601000));
  assert(schedule.consumeDue(3601500));

  assert(captureHookRetryDelayMs(0) == 3000);
  assert(captureHookRetryDelayMs(19) == 3000);
  assert(captureHookRetryDelayMs(20) == 15000);
  assert(captureHookRetryDelayMs(1000000) == 15000); // Never exhaust retries.

  std::puts("capture resilience tests passed");
  return 0;
}
