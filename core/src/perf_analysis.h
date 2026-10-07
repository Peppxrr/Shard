#pragma once

// Pure frame-pacing analysis shared by the performance monitor and its tests.
// No OBS, PDH or clock dependency.
//
// How libobs loses frames (vendor/obs-studio/libobs):
// - Render lag: the graphics thread misses a frame deadline; video_sleep()
//   counts the missed intervals in obs_get_lagged_frames() and the encoder is
//   handed a repeat of the previous frame for each of them.
// - Encoder backlog: the graphics thread queues frames for the encoder
//   (NUM_ENCODE_TEXTURES = 10 on the GPU texture path, MAX_CACHE_SIZE = 16 on
//   the raw path). While that queue is full every newly rendered frame is
//   dropped and the last queued frame is repeated instead. Each repeat is
//   still encoded later, so after a stall the encoder keeps emitting repeated
//   frames until the backlog drains - the picture stays frozen or choppy after
//   the load that caused it is gone. video_output_get_skipped_frames() counts
//   those repeats when they are encoded, not when the frames were lost.

#include <algorithm>
#include <cstdint>
#include <deque>
#include <string>
#include <vector>

namespace shard {

enum class PerfCause {
  Ok,
  // Frames are lost while the GPU's 3D engine is saturated: libobs misses
  // render deadlines, or the texture encoder's GPU copy waits behind the
  // game's work and its queue overflows.
  GpuStarved,
  // libobs misses render deadlines while the 3D engine has headroom (or GPU
  // counters are unavailable): CPU starvation, driver stalls, blocking work.
  RenderStall,
  // Frames render on time but the encoder cannot keep up.
  EncoderOverloaded,
};

inline const char* perfCauseName(PerfCause cause)
{
  switch (cause) {
    case PerfCause::GpuStarved: return "gpu_starved";
    case PerfCause::RenderStall: return "render_stall";
    case PerfCause::EncoderOverloaded: return "encoder_overloaded";
    default: return "ok";
  }
}

// Plain-English guidance for the user. `priorityActive` is true when libobs
// already raised its GPU priority; `catchingUp` when the encoder is still
// repeating frames after the load that caused the backlog has passed.
inline std::string perfCauseHint(PerfCause cause, bool priorityActive, bool catchingUp = false)
{
  switch (cause) {
    case PerfCause::GpuStarved: {
      std::string hint = catchingUp ? "Recording is catching up after your GPU was maxed out and repeats frames until it does. "
                                    : "Your GPU is maxed out. ";
      return hint + (priorityActive ? "Cap the game's FPS or lower its graphics settings."
                                    : "Cap the game's FPS or turn on Recording priority.");
    }
    case PerfCause::RenderStall:
      return "Recording is missing frames even though the GPU has headroom. Close heavy background apps; "
             "if it keeps happening, export diagnostics and send them to us.";
    case PerfCause::EncoderOverloaded:
      return "The video encoder can't keep up. Lower the recording resolution, frame rate or bitrate, "
             "or choose a hardware encoder.";
    default: return {};
  }
}

// Monotonic libobs counters. Each can restart from zero when the video mix
// is reset or outputs restart.
struct FrameCounters {
  uint32_t rendered = 0; // obs_get_total_frames (render ticks, lagged included)
  uint32_t lagged = 0;   // obs_get_lagged_frames
  uint32_t encoded = 0;  // video_output_get_total_frames (frames handed to encoders)
  uint32_t skipped = 0;  // video_output_get_skipped_frames
};

inline uint32_t counterDelta(uint32_t previous, uint32_t current)
{
  return current >= previous ? current - previous : current;
}

// libobs' texture-encoder path counts each repeat it encodes as skipped,
// including those standing in for render-lagged frames. Only the excess is
// attributable to the encoder. The raw path counts only frames the encoder
// thread could not take.
inline uint32_t encoderSkippedFrames(uint32_t skipped, uint32_t lagged, bool texturePath)
{
  if (!texturePath)
    return skipped;
  return skipped > lagged ? skipped - lagged : 0;
}

// Frames libobs queues for the encoder before it starts dropping new ones.
inline uint32_t encoderQueueFrames(bool texturePath)
{
  return texturePath ? 10u : 16u; // NUM_ENCODE_TEXTURES / MAX_CACHE_SIZE
}

// One short interval of frame accounting (the monitor uses 250 ms).
struct FrameSlice {
  uint64_t startUs = 0;
  uint64_t endUs = 0;
  uint32_t rendered = 0; // render ticks, lagged included
  uint32_t lagged = 0;   // render deadlines missed
  uint32_t encoded = 0;  // frames the encoder thread consumed
  uint32_t repeated = 0; // repeats encoded beyond render lag (libobs "skipped", encode-time view)
  uint32_t backlog = 0;  // frames rendered but not yet encoded at the end of the slice
  uint32_t stalled = 0;  // rendered frames dropped because the encoder queue was full
  double engine3d = -1;    // busiest 3D engine during the interval; < 0 = unknown
  double videoEncode = -1; // busiest video encode engine; < 0 = unknown
};

// `encoding`: an output's encoder is consuming this video mix. Without one
// (or after an encoder restart) there is no backlog.
inline FrameSlice frameSlice(const FrameCounters& previous, const FrameCounters& current, bool texturePath,
                             uint32_t previousBacklog, bool encoding, uint64_t startUs, uint64_t endUs)
{
  FrameSlice slice;
  slice.startUs = startUs;
  slice.endUs = endUs;
  slice.rendered = counterDelta(previous.rendered, current.rendered);
  slice.lagged = std::min(slice.rendered, counterDelta(previous.lagged, current.lagged));
  slice.encoded = counterDelta(previous.encoded, current.encoded);
  slice.repeated = std::min(slice.encoded,
                            encoderSkippedFrames(counterDelta(previous.skipped, current.skipped), slice.lagged, texturePath));
  if (!encoding || current.encoded < previous.encoded)
    return slice;
  const int64_t backlog = int64_t(previousBacklog) + slice.rendered - slice.encoded;
  slice.backlog = backlog > 0 ? static_cast<uint32_t>(backlog) : 0;
  // Ticks spent with a full queue drop their new frame. Lagged ticks had no
  // new frame to lose and are already counted.
  const uint32_t queue = encoderQueueFrames(texturePath);
  const uint32_t low = std::min(previousBacklog, slice.backlog);
  const uint32_t high = std::max(previousBacklog, slice.backlog);
  const uint32_t full = low >= queue ? slice.rendered : high > queue ? high - queue : 0;
  slice.stalled = std::min(full, slice.rendered - slice.lagged);
  return slice;
}

// The 3D engine counts as saturated from here; games that pin the GPU read
// 95-100 % while short spikes from other apps stay well below.
constexpr double kGpuBusyPercent = 90.0;
// The video encode engine (NVENC/VCN/QSV) counts as saturated from here.
constexpr double kEncoderBusyPercent = 85.0;
// At least this share of rendered frames in a window must be lost before a
// cause is reported.
constexpr double kLossThreshold = 0.02;

struct WindowTotals {
  uint32_t rendered = 0;
  uint32_t lagged = 0;
  uint32_t encoded = 0;
  uint32_t repeated = 0;
  uint32_t stalled = 0;
  uint32_t backlog = 0; // at the end of the window
  bool gpuKnown = false; // a lossy slice had GPU counters
  // Lost frames (lagged + stalled) attributed slice by slice, so the window's
  // cause follows where the frames were actually lost.
  uint32_t lostGpu = 0;
  uint32_t lostRender = 0;
  uint32_t lostEncoder = 0;
  // The previous slice dropped frames on a full encoder queue that GPU
  // starvation filled; consecutive stalls drain that same queue.
  bool gpuQueueDraining = false;
};

// Per-slice attribution:
// - render lag while the 3D engine is saturated: GPU starvation; otherwise a
//   render stall (CPU, driver, blocking work, or GPU counters unavailable).
// - encoder-queue stalls: still GPU starvation while a queue filled by it
//   drains; the encoder when the video encode engine is saturated; GPU
//   starvation when the 3D engine is (the texture encoder's GPU copy waits
//   behind the game); otherwise the encoder (e.g. a software encoder).
inline void addSlice(WindowTotals& totals, const FrameSlice& slice)
{
  totals.rendered += slice.rendered;
  totals.lagged += slice.lagged;
  totals.encoded += slice.encoded;
  totals.repeated += slice.repeated;
  totals.stalled += slice.stalled;
  totals.backlog = slice.backlog;
  if (!slice.lagged && !slice.stalled) {
    totals.gpuQueueDraining = false;
    return;
  }
  totals.gpuKnown = totals.gpuKnown || slice.engine3d >= 0;
  const bool gpuBusy = slice.engine3d >= kGpuBusyPercent;
  const bool encodeBusy = slice.videoEncode >= kEncoderBusyPercent;
  (gpuBusy ? totals.lostGpu : totals.lostRender) += slice.lagged;
  bool stallGpu = false;
  if (slice.stalled) {
    stallGpu = totals.gpuQueueDraining || (!encodeBusy && gpuBusy);
    (stallGpu ? totals.lostGpu : totals.lostEncoder) += slice.stalled;
  }
  totals.gpuQueueDraining = slice.stalled && stallGpu;
}

inline PerfCause classifyFrameLoss(const WindowTotals& totals)
{
  const uint32_t lost = totals.lagged + totals.stalled;
  if (!lost || !totals.rendered || double(lost) / double(totals.rendered) < kLossThreshold)
    return PerfCause::Ok;
  // The cause that lost the most frames; ties favour GPU, then encoder.
  if (totals.lostGpu >= totals.lostEncoder && totals.lostGpu >= totals.lostRender && totals.lostGpu)
    return PerfCause::GpuStarved;
  if (totals.lostEncoder >= totals.lostRender && totals.lostEncoder)
    return PerfCause::EncoderOverloaded;
  return PerfCause::RenderStall;
}

// A backlog built while the GPU was saturated keeps dropping frames after the
// load is gone; it remains GPU starvation until the queue has drained.
inline PerfCause classifyWithBacklog(const WindowTotals& totals, PerfCause previous, bool texturePath)
{
  const PerfCause cause = classifyFrameLoss(totals);
  if (previous == PerfCause::GpuStarved && cause != PerfCause::Ok && cause != PerfCause::GpuStarved &&
      totals.backlog >= encoderQueueFrames(texturePath))
    return PerfCause::GpuStarved;
  return cause;
}

// Any lost frame inside a span marks it on the clip, even below the
// classification threshold: users see exactly where frames were dropped.
struct LagSegment {
  double start = 0; // seconds from clip start
  double end = 0;
  uint32_t lagged = 0;
  uint32_t stalled = 0;
  PerfCause cause = PerfCause::Ok;
};

struct ClipLag {
  uint32_t frames = 0;
  uint32_t lagged = 0;
  uint32_t stalled = 0;
  PerfCause cause = PerfCause::Ok; // cause of the most lost frames
  std::vector<LagSegment> segments;
};

// Slices that lose frames and lie less than `mergeGapUs` apart form one
// segment. Slices are clipped to [startUs, endUs).
inline ClipLag clipLagFromSlices(const std::deque<FrameSlice>& slices, uint64_t startUs, uint64_t endUs,
                                 uint64_t mergeGapUs = 1000000)
{
  ClipLag lag;
  if (endUs <= startUs)
    return lag;
  struct Open {
    bool active = false;
    uint64_t startUs = 0;
    uint64_t endUs = 0;
    WindowTotals totals;
  } open;
  uint32_t lostByCause[4] = {};
  const auto close = [&] {
    if (!open.active)
      return;
    LagSegment segment;
    segment.start = double(open.startUs - startUs) / 1e6;
    segment.end = double(open.endUs - startUs) / 1e6;
    segment.lagged = open.totals.lagged;
    segment.stalled = open.totals.stalled;
    // Within a lossy span every lost frame counts, so classify by the span's
    // own losses rather than the window threshold.
    WindowTotals span = open.totals;
    span.rendered = span.lagged + span.stalled;
    segment.cause = classifyFrameLoss(span);
    lostByCause[static_cast<int>(segment.cause)] += segment.lagged + segment.stalled;
    lag.segments.push_back(segment);
    open = {};
  };
  for (const auto& slice : slices) {
    if (slice.endUs <= startUs || slice.startUs >= endUs)
      continue;
    lag.frames += slice.rendered;
    lag.lagged += slice.lagged;
    lag.stalled += slice.stalled;
    if (!slice.lagged && !slice.stalled)
      continue;
    const uint64_t sliceStart = std::max(slice.startUs, startUs);
    const uint64_t sliceEnd = std::min(slice.endUs, endUs);
    if (open.active && sliceStart > open.endUs + mergeGapUs)
      close();
    if (!open.active) {
      open.active = true;
      open.startUs = sliceStart;
    }
    open.endUs = sliceEnd;
    addSlice(open.totals, slice);
  }
  close();
  uint32_t worst = 0;
  for (int cause = 1; cause < 4; ++cause) {
    if (lostByCause[cause] > worst) {
      worst = lostByCause[cause];
      lag.cause = static_cast<PerfCause>(cause);
    }
  }
  return lag;
}

} // namespace shard
