#pragma once

#include <atomic>
#include <array>
#include <cstdint>
#include <string>

namespace shard {

enum class CaptureFrameContent { Unknown, Black, Content };

inline const char* captureFrameContentName(CaptureFrameContent content) noexcept
{
  switch (content) {
    case CaptureFrameContent::Black: return "black";
    case CaptureFrameContent::Content: return "content";
    default: return "unknown";
  }
}

// Emit game-capture health when its state changes and at a bounded interval
// while unchanged. The caller owns formatting and the actual output stream.
class CaptureDiagnosticSchedule {
public:
  bool shouldLog(const std::string& snapshot, uint64_t nowMs,
                 uint64_t intervalMs = 10000, uint64_t minChangeIntervalMs = 2000)
  {
    if (!hasLogged_ || nowMs - lastLogMs_ >= intervalMs ||
        (snapshot != lastSnapshot_ && nowMs - lastLogMs_ >= minChangeIntervalMs)) {
      lastSnapshot_ = snapshot;
      lastLogMs_ = nowMs;
      hasLogged_ = true;
      return true;
    }
    return false;
  }

  void reset() noexcept
  {
    lastSnapshot_.clear();
    lastLogMs_ = 0;
    hasLogged_ = false;
  }

private:
  std::string lastSnapshot_;
  uint64_t lastLogMs_ = 0;
  bool hasLogged_ = false;
};

// Inspect only the interior: WGC's title bar and a small cursor must not turn
// an otherwise black surface into evidence of a working game image.
inline CaptureFrameContent captureFrameContent(const uint8_t* rgba, uint32_t width,
                                               uint32_t height, uint32_t stride) noexcept
{
  if (!rgba || width < 16 || height < 16 || stride < width * 4)
    return CaptureFrameContent::Unknown;
  uint32_t pixels = 0, lit = 0, bright = 0;
  for (uint32_t y = height / 5; y < height - height / 5; ++y) {
    for (uint32_t x = width / 5; x < width - width / 5; ++x) {
      const auto* p = rgba + y * stride + x * 4;
      ++pixels;
      if (p[3] > 16) {
        if (p[0] > 12 || p[1] > 12 || p[2] > 12) ++lit;
        if (p[0] > 24 || p[1] > 24 || p[2] > 24) ++bright;
      }
    }
  }
  if (lit * 100 <= pixels) return CaptureFrameContent::Black;
  if (bright * 20 >= pixels) return CaptureFrameContent::Content;
  return CaptureFrameContent::Unknown;
}

// Hash the same interior pixels as the content classifier; ignore row padding
// and window chrome. This consumes an existing mapped probe, never another copy.
inline uint64_t captureFrameFingerprint(const uint8_t* rgba, uint32_t width,
                                        uint32_t height, uint32_t stride) noexcept
{
  if (!rgba || width < 16 || height < 16 || stride < width * 4) return 0;
  uint64_t hash = 14695981039346656037ULL;
  for (uint32_t y = height / 5; y < height - height / 5; ++y)
    for (uint32_t x = width / 5; x < width - width / 5; ++x)
      for (uint32_t channel = 0; channel < 4; ++channel) {
        hash ^= rgba[y * stride + x * 4 + channel];
        hash *= 1099511628211ULL;
      }
  return hash;
}

struct CaptureFrameObservation {
  CaptureFrameContent content = CaptureFrameContent::Unknown;
  uint64_t observedMs = 0;
  uint64_t changedMs = 0;
  bool frameChanged = false;
  bool hasPixels = false;

  void observe(CaptureFrameContent value, uint64_t fingerprint, uint64_t nowMs,
               bool meaningfulChange = true) noexcept
  {
    frameChanged = hasPixels && fingerprint != fingerprint_;
    // A scheduling gap cannot prove sustained movement or sustained freezing.
    const bool gap = hasPixels && nowMs - observedMs > 2500;
    if (gap || (changeCount_ && nowMs - meaningfulChangedMs_ > 2500)) {
      changeCount_ = 0;
      changesSinceMs_ = 0;
    }
    if (!hasPixels || gap) changedMs = nowMs;
    if (frameChanged) {
      changedMs = nowMs;
      if (meaningfulChange) {
        if (!changeCount_) changesSinceMs_ = nowMs;
        if (changeCount_ < 3) ++changeCount_;
        meaningfulChangedMs_ = nowMs;
      }
    }
    content = value;
    fingerprint_ = fingerprint;
    observedMs = nowMs;
    hasPixels = true;
    pixelHistory_ = false;
  }

  // Keep only the existing tiny probe's interior RGB pixels. Cursor-sized
  // changes still update the diagnostic fingerprint, but cannot establish
  // sustained backend movement used to reject another source as frozen.
  void observePixels(const uint8_t* rgba, uint32_t width, uint32_t height,
                     uint32_t stride, uint64_t nowMs) noexcept
  {
    if (!rgba || width < 16 || height < 16 || width > 64 || height > 36 || stride < width * 4)
      return;
    const bool comparable = pixelHistory_ && previousWidth_ == width && previousHeight_ == height &&
                            hasPixels && nowMs >= observedMs && nowMs - observedMs <= 2500;
    uint32_t count = 0, changed = 0;
    for (uint32_t y = height / 5; y < height - height / 5; ++y) {
      for (uint32_t x = width / 5; x < width - width / 5; ++x) {
        const auto* pixel = rgba + y * stride + x * 4;
        bool different = false;
        for (uint32_t channel = 0; channel < 3; ++channel) {
          auto& previous = previousPixels_[count * 3 + channel];
          const int delta = static_cast<int>(pixel[channel]) - static_cast<int>(previous);
          if (delta >= 8 || delta <= -8) different = true;
          previous = pixel[channel];
        }
        if (comparable && different) ++changed;
        ++count;
      }
    }
    observe(captureFrameContent(rgba, width, height, stride),
            captureFrameFingerprint(rgba, width, height, stride), nowMs,
            comparable && changed * 20 >= count);
    previousWidth_ = width;
    previousHeight_ = height;
    pixelHistory_ = true;
  }
  bool fresh(uint64_t nowMs) const noexcept
  { return hasPixels && nowMs >= observedMs && nowMs - observedMs <= 2500; }
  bool healthy(uint64_t nowMs) const noexcept
  { return fresh(nowMs) && content == CaptureFrameContent::Content; }
  bool changing(uint64_t nowMs) const noexcept
  {
    return healthy(nowMs) && changeCount_ >= 3 && nowMs - meaningfulChangedMs_ <= 2500 &&
           meaningfulChangedMs_ - changesSinceMs_ >= 2000;
  }
  uint64_t unchangedAge(uint64_t nowMs) const noexcept
  { return hasPixels && nowMs >= changedMs ? nowMs - changedMs : 0; }

private:
  uint64_t fingerprint_ = 0;
  uint64_t changesSinceMs_ = 0;
  uint64_t meaningfulChangedMs_ = 0;
  unsigned changeCount_ = 0;
  std::array<uint8_t, 64 * 36 * 3> previousPixels_{};
  uint32_t previousWidth_ = 0, previousHeight_ = 0;
  bool pixelHistory_ = false;
};

// Fed fresh paired samples at 2 Hz. Require three seconds of disagreement,
// then two seconds of recovered hook images before returning to the hook.
// Both-black loading screens and unavailable/minimized WGC are inconclusive.
class CaptureBackendHealth {
public:
  void sample(CaptureFrameContent hook, CaptureFrameContent wgc, uint64_t nowMs) noexcept
  {
    if (lastSampleMs_ && nowMs - lastSampleMs_ > 1500)
      badSince_ = goodSince_ = 0;
    lastSampleMs_ = nowMs;
    if (hook == CaptureFrameContent::Black && wgc == CaptureFrameContent::Content) {
      if (!badSince_) badSince_ = nowMs;
      goodSince_ = 0;
      if (nowMs - badSince_ >= 3000) {
        rejected_ = true;
        frozenRejected_ = false;
        degradedRejected_ = false;
      }
    } else {
      badSince_ = 0;
      if (hook == CaptureFrameContent::Content) {
        if (!goodSince_) goodSince_ = nowMs;
        if (nowMs - goodSince_ >= 2000) rejected_ = false;
      } else {
        goodSince_ = 0;
      }
    }
  }
  void sample(const CaptureFrameObservation& hook, const CaptureFrameObservation& wgc,
              uint64_t nowMs) noexcept
  {
    if (lastSampleMs_ && nowMs - lastSampleMs_ > 1500)
      badSince_ = goodSince_ = wgcChangingSince_ = degradedSince_ = 0;
    lastSampleMs_ = nowMs;
    if (wgc.changing(nowMs)) {
      if (!wgcChangingSince_) wgcChangingSince_ = nowMs;
    } else wgcChangingSince_ = 0;
    const bool black = hook.fresh(nowMs) && hook.content == CaptureFrameContent::Black && wgc.healthy(nowMs);
    const bool frozen = hook.healthy(nowMs) && hook.unchangedAge(nowMs) >= 30000 &&
                        wgcChangingSince_ && nowMs - wgcChangingSince_ >= 5000;
    const bool degraded = (!hook.fresh(nowMs) || hook.content == CaptureFrameContent::Unknown) && wgc.healthy(nowMs);
    if (degraded) {
      if (!degradedSince_) degradedSince_ = nowMs;
    } else degradedSince_ = 0;
    const bool sustainedDegraded = degradedSince_ && nowMs - degradedSince_ >= 15000;
    if (!black) badSince_ = 0;
    if (black || frozen || sustainedDegraded) {
      goodSince_ = 0;
      if (black && !badSince_) badSince_ = nowMs;
      if (frozen || sustainedDegraded || (black && nowMs - badSince_ >= 3000)) {
        if (!rejected_ || (frozen && !frozenRejected_)) {
          rejectedAtMs_ = nowMs;
          changedAfterRejection_ = false;
        }
        rejected_ = true;
        // Missing observations do not erase a previously proven freeze.
        if (!sustainedDegraded || !frozenRejected_) {
          frozenRejected_ = frozen;
          degradedRejected_ = sustainedDegraded;
        }
      }
      return;
    }
    badSince_ = 0;
    if (hook.fresh(nowMs) && hook.frameChanged && hook.changedMs > rejectedAtMs_)
      changedAfterRejection_ = true;
    if (hook.healthy(nowMs) && (!frozenRejected_ || changedAfterRejection_)) {
      if (!goodSince_) goodSince_ = nowMs;
      if (nowMs - goodSince_ >= 2000) {
        rejected_ = false;
        frozenRejected_ = false;
        degradedRejected_ = false;
      }
    } else goodSince_ = 0;
  }
  bool hookRejected() const noexcept { return rejected_; }
  bool hookRetryJustified(const CaptureFrameObservation& wgc, uint64_t nowMs) const noexcept
  {
    // Once a proven freeze has promoted WGC, a static menu must not cause
    // repeated hook destruction. Retain fallback until comparison movement
    // returns or the hook itself demonstrates recovery. Suppression requires
    // positively healthy fallback pixels; black/stale/unknown WGC cannot
    // quarantine a failed hook merely because its surface has dimensions.
    return rejected_ && (!frozenRejected_ || !wgc.healthy(nowMs) || wgc.changing(nowMs));
  }
  const char* rejectionReason() const noexcept
  {
    return !rejected_ ? "none" : frozenRejected_ ? "hook_frozen_while_wgc_changing" :
           degradedRejected_ ? "hook_probe_degraded_while_wgc_content" :
                                               "hook_black_while_wgc_content_for_3s";
  }

private:
  uint64_t lastSampleMs_ = 0, badSince_ = 0, goodSince_ = 0;
  bool rejected_ = false;
  bool frozenRejected_ = false, changedAfterRejection_ = false;
  bool degradedRejected_ = false;
  uint64_t rejectedAtMs_ = 0, wgcChangingSince_ = 0, degradedSince_ = 0;
};

enum class CaptureRecoveryAction { None, Retry, RecreateHook, RecreateWgc, RebuildSources, RebindScene, ResetVideo };

inline const char* captureRecoveryActionName(CaptureRecoveryAction action) noexcept
{
  switch (action) {
    case CaptureRecoveryAction::Retry: return "retry";
    case CaptureRecoveryAction::RecreateHook: return "recreate_hook";
    case CaptureRecoveryAction::RecreateWgc: return "recreate_wgc";
    case CaptureRecoveryAction::RebuildSources: return "rebuild_sources";
    case CaptureRecoveryAction::RebindScene: return "rebind_scene";
    case CaptureRecoveryAction::ResetVideo: return "reset_video_mix";
    default: return "none";
  }
}

// Watchdog-owned escalation evidence. Source recreation must not reset this
// policy. Static content is healthy; only unavailable/black observations or
// proven downstream failure enter it. Callers gate eligibility on a live,
// non-minimized target and an awake display.
class CaptureHealthRecovery {
public:
  struct Input {
    bool eligible = false;
    bool healthy = false;
    bool downstream = false;
    bool unusable = false;
    bool stalePipeline = false;
    bool monitor = false;
  };

  CaptureRecoveryAction update(const Input& input, uint64_t nowMs) noexcept
  {
    if (lastUpdateMs_ && nowMs - lastUpdateMs_ > 5000) resetEvidence();
    lastUpdateMs_ = nowMs;
    if (!input.eligible || (input.healthy && !input.downstream) ||
        (!input.downstream && !input.unusable)) {
      resetEvidence();
      return CaptureRecoveryAction::None;
    }
    if (!hasFailure_ || downstream_ != input.downstream) {
      hasFailure_ = true;
      failureSinceMs_ = nowMs;
      downstream_ = input.downstream;
      level_ = 0;
    }
    const uint64_t age = nowMs - failureSinceMs_;
    const uint64_t cooldown = level_ >= 3 ? 60000 : 30000;
    if (hasAction_ && nowMs - lastActionMs_ < cooldown) return CaptureRecoveryAction::None;
    CaptureRecoveryAction action = CaptureRecoveryAction::None;
    if (downstream_) {
      if (!level_ && age >= 15000) action = CaptureRecoveryAction::RebindScene;
      else if (level_ && age >= 120000 && canReset(nowMs)) action = CaptureRecoveryAction::ResetVideo;
    } else if (age >= 120000) {
      switch (level_) {
        case 0: action = CaptureRecoveryAction::Retry; break;
        case 1: action = input.monitor ? CaptureRecoveryAction::RebuildSources : CaptureRecoveryAction::RecreateHook; break;
        case 2: action = CaptureRecoveryAction::RecreateWgc; break;
        case 3: action = CaptureRecoveryAction::RebuildSources; break;
        default:
          if (input.stalePipeline && age >= 300000 && canReset(nowMs)) action = CaptureRecoveryAction::ResetVideo;
          // Fresh black loading screens may retry, but never reset the mix.
          else if (!input.stalePipeline && nowMs - lastActionMs_ >= 120000) action = CaptureRecoveryAction::Retry;
          break;
      }
    }
    if (action != CaptureRecoveryAction::None) {
      lastActionMs_ = nowMs;
      hasAction_ = true;
      if (action == CaptureRecoveryAction::ResetVideo) {
        lastResetMs_ = nowMs;
        hasReset_ = true;
        resetEvidence();
      } else if (level_ < 4) ++level_;
      if (input.monitor && action == CaptureRecoveryAction::RebuildSources) level_ = 4;
    }
    return action;
  }

  void resetEvidence() noexcept
  { hasFailure_ = false; level_ = 0; failureSinceMs_ = lastUpdateMs_ = 0; }
  void externalRecovery(uint64_t nowMs) noexcept
  { resetEvidence(); hasAction_ = true; lastActionMs_ = nowMs; }

private:
  bool canReset(uint64_t nowMs) const noexcept
  { return !hasReset_ || nowMs - lastResetMs_ >= 300000; }
  bool hasFailure_ = false, downstream_ = false, hasAction_ = false, hasReset_ = false;
  unsigned level_ = 0;
  uint64_t failureSinceMs_ = 0, lastActionMs_ = 0, lastResetMs_ = 0, lastUpdateMs_ = 0;
};

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
    if ((state == 1 || state == 2) && previous == 0)
      recoveryRequested_.store(true);
  }

  void onResume() noexcept { recoveryRequested_.store(true); }
  void onGraphicsRebuilt() noexcept { recoveryRequested_.store(true); }

  bool consumeRecovery() noexcept { return recoveryRequested_.exchange(false); }
  bool displaySleeping() const noexcept { return displayState_.load() == 0; }

private:
  std::atomic<int> displayState_{-1};
  std::atomic<bool> recoveryRequested_{false};
};

// Watchdog-thread state. Let display/driver wake notifications settle before
// rebuilding; retain late requests while preventing rapid source destruction.
class CaptureRecoverySchedule {
public:
  void request(uint64_t nowMs) noexcept
  {
    pending_ = true;
    dueMs_ = nowMs + 1500;
  }

  bool consumeDue(uint64_t nowMs) noexcept
  {
    if (!pending_ || nowMs < dueMs_ || (rebuilt_ && nowMs - lastRebuildMs_ < 5000))
      return false;
    pending_ = false;
    rebuilt_ = true;
    lastRebuildMs_ = nowMs;
    return true;
  }
  bool pending() const noexcept { return pending_; }

private:
  bool pending_ = false;
  bool rebuilt_ = false;
  uint64_t dueMs_ = 0;
  uint64_t lastRebuildMs_ = 0;
};

// A slow wake or a temporary injection failure must never exhaust recovery.
// Back off after the initial attempts instead of permanently giving up.
inline uint64_t captureHookRetryDelayMs(int attempts) noexcept
{
  return attempts < 20 ? 3000 : 15000;
}

} // namespace shard
