#include "capture_resilience.h"
#include "replay_timing.h"
#include "capture_geometry.h"
#include "capture_adapter.h"
#include "capture_display.h"

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
  // Custom 1080p can absorb a 1440p game/window transition without clearing
  // replay packets or splitting recording. Native format/aspect changes cannot.
  assert(shard::captureCanPreserveVideo({2560, 1440}, {1920, 1080},
                                      {1920, 1080}, {1920, 1080}, 60, 60, 1));
  assert(shard::captureCanPreserveVideo({3840, 2160}, {2560, 1440},
                                      {1280, 720}, {1280, 720}, 30, 30000, 1000));
  assert(!shard::captureCanPreserveVideo({2560, 1440}, {1920, 1080},
                                       {2560, 1440}, {1920, 1080}, 60, 60, 1));
  assert(!shard::captureCanPreserveVideo({1920, 1200}, {1920, 1080},
                                       {1920, 1080}, {1920, 1080}, 60, 60, 1));
  assert(!shard::captureCanPreserveVideo({960, 540}, {1920, 1080},
                                       {960, 540}, {1920, 1080}, 60, 60, 1));
  assert(!shard::captureCanPreserveVideo({2560, 1440}, {1920, 1080},
                                       {1920, 1080}, {1920, 1080}, 30, 60, 1));
  assert(!shard::captureCanPreserveVideo({}, {1920, 1080},
                                       {1920, 1080}, {1920, 1080}, 60, 60, 1));
  // WGC chrome/inset cleanup must not invent a 960x534 video format while
  // its validated client and hook both represent 16:9 content.
  const auto clientCrop = computeClientAreaCrop(962, 579, 0, 0, 1, 38, 960, 540);
  const auto displayCrop = computeClientAreaCrop(962, 579, 0, 0, 1, 43, 960, 535);
  assert(clientCrop.valid && displayCrop.valid && displayCrop.top - clientCrop.top == 5);
  const CaptureSize clientSize{962 - clientCrop.left - clientCrop.right, 579 - clientCrop.top - clientCrop.bottom};
  assert((clientSize == CaptureSize{960, 540}));
  assert(shard::captureCanPreserveVideo(clientSize, {2560, 1440},
      shard::fitCaptureSize(clientSize, {960, 540}), {960, 540}, 60, 60, 1));
  // Initial acquisition, short startup gaps, target replacement and alt-tab
  // all get the same grace. Sustained loss still frees the ring exactly once.
  shard::ReplayActivityGrace activity;
  assert(!activity.shouldStop(false, false, 0)); // Game-only has no ring yet.
  assert(!activity.shouldStop(false, true, 0)); // Eager acquisition at boot/config.
  assert(!activity.shouldStop(false, true, 5000));
  assert(!activity.shouldStop(false, true, 7000));
  assert(!activity.shouldStop(true, true, 8000));
  assert(!activity.shouldStop(false, true, 10000));
  assert(!activity.shouldStop(false, true, 24999));
  assert(activity.shouldStop(false, true, 25000));
  assert(!activity.shouldStop(false, false, 26000));
  assert(!activity.shouldStop(true, true, 27000)); // Activity restart.
  assert(!activity.shouldStop(false, true, 28000));
  activity.reset(); // Explicit encoder restart gets a fresh acquisition grace.
  assert(!activity.shouldStop(false, true, 60000));
  assert(!activity.shouldStop(false, true, 74999));
  assert(activity.shouldStop(false, true, 75000));
  using shard::CaptureFrameContent;
  using shard::CaptureBackendHealth;
  using shard::CaptureDiagnosticSchedule;
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
  assert(std::string(shard::captureFrameContentName(CaptureFrameContent::Unknown)) == "unknown");
  assert(std::string(shard::captureFrameContentName(CaptureFrameContent::Black)) == "black");
  assert(std::string(shard::captureFrameContentName(CaptureFrameContent::Content)) == "content");

  const auto fingerprint = shard::captureFrameFingerprint(pixels.data(), probeWidth, probeHeight, stride);
  pixels[0] ^= 1; // Chrome and row padding do not affect interior fingerprints.
  pixels[stride - 1] ^= 1;
  assert(shard::captureFrameFingerprint(pixels.data(), probeWidth, probeHeight, stride) == fingerprint);
  pixels[18 * stride + 32 * 4] ^= 1;
  assert(shard::captureFrameFingerprint(pixels.data(), probeWidth, probeHeight, stride) != fingerprint);
  assert(shard::captureFrameFingerprint(nullptr, probeWidth, probeHeight, stride) == 0);

  shard::CaptureFrameObservation observation;
  assert(!observation.fresh(100) && !observation.healthy(100));
  observation.observe(CaptureFrameContent::Content, 1, 100);
  assert(observation.hasPixels && observation.healthy(100) && !observation.frameChanged);
  observation.observe(CaptureFrameContent::Content, 1, 600);
  assert(observation.unchangedAge(600) == 500 && !observation.changing(600));
  assert(!observation.fresh(3101)); // Dimensions cannot keep a stopped probe healthy.
  observation.observe(CaptureFrameContent::Unknown, 1, 3200);
  assert(observation.fresh(3200) && !observation.healthy(3200));
  assert(observation.unchangedAge(3200) == 0); // Probe gaps restart freeze evidence.

  shard::CaptureFrameObservation pixelObservation;
  std::array<uint8_t, stride * probeHeight> movingPixels{};
  for (uint64_t t = 500; t <= 40000; t += 500) {
    movingPixels.fill(80);
    const uint32_t cursorX = 20 + static_cast<uint32_t>((t / 500) % 20);
    for (uint32_t y = 17; y < 20; ++y)
      for (uint32_t x = cursorX; x < cursorX + 3; ++x)
        for (uint32_t channel = 0; channel < 3; ++channel)
          movingPixels[y * stride + x * 4 + channel] = 255;
    pixelObservation.observePixels(movingPixels.data(), probeWidth, probeHeight, stride, t);
    assert(pixelObservation.healthy(t) && !pixelObservation.changing(t));
    if (t > 500) assert(pixelObservation.frameChanged);
  }
  assert(pixelObservation.unchangedAge(40000) == 0); // Cursor movement remains visible in diagnostics.
  for (uint64_t t = 40500; t <= 43000; t += 500) {
    movingPixels.fill((t / 500) % 2 ? 80 : 40);
    pixelObservation.observePixels(movingPixels.data(), probeWidth, probeHeight, stride, t);
  }
  assert(pixelObservation.changing(43000)); // Broad content changes establish real movement.
  for (uint64_t t = 43500; t <= 50000; t += 500) {
    movingPixels.fill(40);
    movingPixels[18 * stride + (20 + (t / 500) % 20) * 4] = 255;
    pixelObservation.observePixels(movingPixels.data(), probeWidth, probeHeight, stride, t);
  }
  assert(!pixelObservation.changing(50000)); // Cursor motion cannot prolong old meaningful movement.
  movingPixels.fill(80);
  pixelObservation.observePixels(movingPixels.data(), probeWidth, probeHeight, stride, 100000);
  assert(!pixelObservation.changing(100000)); // A sleep gap clears pixel comparison history.
  movingPixels.fill(87);
  pixelObservation.observePixels(movingPixels.data(), probeWidth, probeHeight, stride, 100500);
  assert(pixelObservation.frameChanged && !pixelObservation.changing(100500)); // Subthreshold RGB noise.

  CaptureDiagnosticSchedule diagnostics;
  assert(diagnostics.shouldLog("healthy", 100)); // First game snapshot.
  assert(!diagnostics.shouldLog("healthy", 500));
  assert(!diagnostics.shouldLog("black", 600)); // Debounce a short-lived probe change.
  assert(!diagnostics.shouldLog("content", 1100));
  assert(diagnostics.shouldLog("content", 2100)); // Stable state change after two seconds.
  assert(!diagnostics.shouldLog("content", 12099));
  assert(diagnostics.shouldLog("content", 12100)); // Unchanged state heartbeat at ten seconds.
  diagnostics.reset();
  assert(diagnostics.shouldLog("new subject", 12200));

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

  // A/B: Readback observations catch opaque black and content-but-frozen hooks.
  shard::CaptureFrameObservation hookObservation, wgcObservation;
  health = {};
  for (uint64_t t = 500; t <= 4000; t += 500) {
    hookObservation.observe(CaptureFrameContent::Black, 0, t);
    wgcObservation.observe(CaptureFrameContent::Content, t, t);
    health.sample(hookObservation, wgcObservation, t);
  }
  assert(health.hookRejected());
  assert(std::string(health.rejectionReason()) == "hook_black_while_wgc_content_for_3s");
  health = {}; hookObservation = {}; wgcObservation = {};
  for (uint64_t t = 500; t <= 30000; t += 500) {
    hookObservation.observe(CaptureFrameContent::Content, 1, t);
    wgcObservation.observe(CaptureFrameContent::Content, t, t);
    health.sample(hookObservation, wgcObservation, t);
  }
  assert(!health.hookRejected());
  hookObservation.observe(CaptureFrameContent::Content, 1, 30500);
  wgcObservation.observe(CaptureFrameContent::Content, 30500, 30500);
  health.sample(hookObservation, wgcObservation, 30500);
  assert(health.hookRejected());
  assert(std::string(health.rejectionReason()) == "hook_frozen_while_wgc_changing");
  assert(health.hookRetryJustified(wgcObservation, 30500));
  for (uint64_t t = 31000; t <= 35000; t += 500) {
    hookObservation.observe(CaptureFrameContent::Content, 1, t);
    wgcObservation.observe(CaptureFrameContent::Content, 30500, t);
    health.sample(hookObservation, wgcObservation, t);
  }
  assert(health.hookRejected()); // Losing comparison movement cannot restore a frozen hook.
  assert(!health.hookRetryJustified(wgcObservation, 35000)); // Nor repeatedly destroy it on a static menu.
  assert(health.hookRetryJustified(wgcObservation, 38000)); // Stale WGC cannot suppress recovery.
  shard::CaptureFrameObservation unusableWgc;
  unusableWgc.observe(CaptureFrameContent::Black, 1, 35000);
  assert(health.hookRetryJustified(unusableWgc, 35000)); // Sized black fallback is unhealthy.
  unusableWgc.observe(CaptureFrameContent::Unknown, 1, 35000);
  assert(health.hookRetryJustified(unusableWgc, 35000));
  assert(health.hookRetryJustified({}, 35000)); // Never-mapped fallback is unknown.
  for (uint64_t t = 35500; t <= 37500; t += 500) {
    hookObservation.observe(CaptureFrameContent::Content, t, t);
    wgcObservation.observe(CaptureFrameContent::Content, t, t);
    health.sample(hookObservation, wgcObservation, t);
  }
  assert(!health.hookRejected());

  // G: A static menu or a one-frame WGC cursor blip is inconclusive.
  health = {}; hookObservation = {}; wgcObservation = {};
  for (uint64_t t = 500; t <= 90000; t += 500) {
    hookObservation.observe(CaptureFrameContent::Content, 1, t);
    wgcObservation.observe(CaptureFrameContent::Content, t < 45000 ? 2 : 3, t);
    health.sample(hookObservation, wgcObservation, t);
  }
  assert(!health.hookRejected());
  // E: Freshly classified unknown pixels are observed, but not healthy.
  hookObservation.observe(CaptureFrameContent::Unknown, 1, 90500);
  assert(hookObservation.hasPixels && !hookObservation.healthy(90500));
  assert(!wgcObservation.healthy(100000));

  // E: Never-mapped, stale, and freshly unknown hook probes all yield to
  // verified WGC only after a sustained degraded interval.
  for (int mode = 0; mode < 3; ++mode) {
    health = {}; hookObservation = {}; wgcObservation = {};
    const uint64_t rejectMs = mode == 1 ? 18500 : 15500;
    for (uint64_t t = 500; t <= rejectMs; t += 500) {
      if (mode == 1 && t == 500) hookObservation.observe(CaptureFrameContent::Content, 1, t);
      if (mode == 2) hookObservation.observe(CaptureFrameContent::Unknown, 1, t);
      wgcObservation.observe(CaptureFrameContent::Content, 2, t);
      health.sample(hookObservation, wgcObservation, t);
      assert(health.hookRejected() == (t == rejectMs));
    }
    assert(std::string(health.rejectionReason()) == "hook_probe_degraded_while_wgc_content");
    for (uint64_t t = rejectMs + 500; t <= rejectMs + 2500; t += 500) {
      hookObservation.observe(CaptureFrameContent::Content, 1, t);
      wgcObservation.observe(CaptureFrameContent::Content, 2, t);
      health.sample(hookObservation, wgcObservation, t);
      assert(health.hookRejected() == (t < rejectMs + 2500));
    }
  }
  health = {}; hookObservation = {}; wgcObservation = {};
  for (uint64_t t = 500; t <= 15000; t += 500) {
    wgcObservation.observe(CaptureFrameContent::Content, 2, t);
    health.sample(hookObservation, wgcObservation, t);
  }
  assert(!health.hookRejected());
  hookObservation.observe(CaptureFrameContent::Content, 1, 15500);
  wgcObservation.observe(CaptureFrameContent::Content, 2, 15500);
  health.sample(hookObservation, wgcObservation, 15500);
  assert(!health.hookRejected()); // A transient map/callback outage recovered.
  health = {}; hookObservation = {}; wgcObservation = {};
  for (uint64_t t = 500; t <= 90000; t += 500)
    health.sample(hookObservation, wgcObservation, t);
  assert(!health.hookRejected()); // No verified fallback means no rejection.

  using Action = shard::CaptureRecoveryAction;
  shard::CaptureHealthRecovery escalation;
  shard::CaptureHealthRecovery::Input input;
  input.eligible = true;
  input.unusable = true;
  // C/D: Short black screens do nothing; prolonged outages progress in order.
  for (uint64_t t = 500; t < 120500; t += 500)
    assert(escalation.update(input, t) == Action::None);
  assert(escalation.update(input, 120500) == Action::Retry);
  for (uint64_t t = 121000; t < 150500; t += 500)
    assert(escalation.update(input, t) == Action::None);
  assert(escalation.update(input, 150500) == Action::RecreateHook);
  for (uint64_t t = 151000; t < 180500; t += 500)
    assert(escalation.update(input, t) == Action::None);
  assert(escalation.update(input, 180500) == Action::RecreateWgc);
  for (uint64_t t = 181000; t < 240500; t += 500)
    assert(escalation.update(input, t) == Action::None);
  assert(escalation.update(input, 240500) == Action::RebuildSources);
  for (uint64_t t = 241000; t <= 359500; t += 500)
    assert(escalation.update(input, t) == Action::None); // Fresh both-black never resets video.
  assert(escalation.update(input, 360500) == Action::Retry);
  input.stalePipeline = true;
  for (uint64_t t = 361000; t < 420500; t += 500)
    assert(escalation.update(input, t) == Action::None);
  assert(escalation.update(input, 420500) == Action::ResetVideo);
  // Successful content clears failure levels but retains hard-reset cooldown.
  input.healthy = true;
  assert(escalation.update(input, 421000) == Action::None);

  // F: Source content with black composition targets the scene, never the hook.
  input.healthy = false; input.downstream = true; input.unusable = false;
  for (uint64_t t = 421500; t < 450500; t += 500)
    assert(escalation.update(input, t) == Action::None);
  assert(escalation.update(input, 450500) == Action::RebindScene);
  for (uint64_t t = 451000; t < 720500; t += 500)
    assert(escalation.update(input, t) == Action::None);
  assert(escalation.update(input, 720500) == Action::ResetVideo);

  // H: Wake coalescing resets accumulated failure without dropping cooldowns.
  escalation = {};
  input = {}; input.eligible = true; input.downstream = true;
  for (uint64_t t = 500; t < 15500; t += 500)
    assert(escalation.update(input, t) == Action::None);
  assert(escalation.update(input, 15500) == Action::RebindScene);
  escalation.externalRecovery(16000);
  for (uint64_t t = 16500; t < 46000; t += 500)
    assert(escalation.update(input, t) == Action::None);
  assert(escalation.update(input, 46000) == Action::RebindScene);
  input.eligible = false; // Minimized/invalid/asleep targets never escalate.
  for (uint64_t t = 46500; t <= 900000; t += 500)
    assert(escalation.update(input, t) == Action::None);
  input = {}; input.eligible = true; input.healthy = true;
  for (uint64_t t = 900500; t <= 1200000; t += 500)
    assert(escalation.update(input, t) == Action::None);
  escalation = {};
  input.healthy = false; input.unusable = true;
  assert(escalation.update(input, 1000) == Action::None);
  assert(escalation.update(input, 1000000) == Action::None); // Scheduling gap is not outage evidence.

  // Desktop recovery shares the same bounded policy without hook recreation.
  escalation = {};
  input.monitor = true;
  for (uint64_t t = 500; t < 120500; t += 500)
    assert(escalation.update(input, t) == Action::None);
  assert(escalation.update(input, 120500) == Action::Retry);
  for (uint64_t t = 121000; t < 150500; t += 500)
    assert(escalation.update(input, t) == Action::None);
  assert(escalation.update(input, 150500) == Action::RebuildSources);
  for (uint64_t t = 151000; t < 270500; t += 500)
    assert(escalation.update(input, t) == Action::None);
  assert(escalation.update(input, 270500) == Action::Retry);

  // I: Match DXGI GPU preference by LUID to OBS's original enumeration index.
  const std::vector<shard::CaptureAdapter> adapters{
      {0, 100, 0, false, true}, {1, 200, 8ULL << 30, false, true},
      {2, 300, 16ULL << 30, true, true}, {3, 400, 24ULL << 30, false, false}};
  assert(shard::selectCaptureAdapter(adapters, 200) == 1);
  assert(shard::selectCaptureAdapter(adapters, 100) == 0); // Explicit OS preference outranks memory.
  assert(shard::selectCaptureAdapter(adapters, 999) == 1); // Vendor-neutral hardware fallback.
  assert(shard::selectCaptureAdapter({{0, 100, 0, false, true}}) == 0);
  assert(shard::selectCaptureAdapter({}) == 0);

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
  assert(recovery.displaySleeping());
  assert(!recovery.consumeRecovery());
  recovery.onDisplayState(1);
  assert(!recovery.displaySleeping());
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
  assert(!schedule.pending());
  assert(!schedule.consumeDue(10000));
  recovery.onResume();
  recovery.onGraphicsRebuilt();
  assert(recovery.consumeRecovery());
  assert(!recovery.consumeRecovery());
  schedule.request(10000);
  assert(schedule.pending());
  assert(!schedule.consumeDue(11000)); // Give the driver time to settle.
  schedule.request(11000); // Interactive wake follows automatic wake.
  assert(!schedule.consumeDue(11500));
  assert(schedule.consumeDue(12500));
  assert(!schedule.pending());
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

  // A primary SDR desktop and a secondary HDR window display must remain
  // independent. Moving the same HWND changes the resolved display.
  uintptr_t windowDisplay = 2;
  int desktopQueries = 0;
  const auto fromWindow = [&](uintptr_t hwnd) { assert(hwnd == 42); return windowDisplay; };
  const auto fromDesktop = [&](int index) { assert(index == 0); ++desktopQueries; return uintptr_t{1}; };
  const auto selectedHdr = [&](bool window, uintptr_t hwnd) {
    return shard::selectCaptureMonitor(window, hwnd, 0, fromWindow, fromDesktop) == 2;
  };
  assert(selectedHdr(true, 42));
  assert(desktopQueries == 0);
  windowDisplay = 1;
  assert(!selectedHdr(true, 42));
  assert(desktopQueries == 0);
  assert(shard::selectCaptureMonitor(true, 0, 0, fromWindow, fromDesktop) == 0);
  assert(desktopQueries == 0); // Missing HWND never defaults to primary.
  assert(!selectedHdr(false, 42));
  assert(desktopQueries == 1);
  std::puts("capture resilience tests passed");
  return 0;
}
