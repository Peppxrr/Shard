// Frame-loss attribution, encoder backlog, clip lag segments and GPU engine
// counter parsing.
#undef NDEBUG
#include "gpu_engines.h"
#include "perf_analysis.h"

#include <cassert>
#include <cmath>
#include <cstdio>

using namespace shard;

namespace {

FrameSlice slice(uint64_t startMs, uint32_t rendered, uint32_t lagged, uint32_t stalled, double engine3d = -1,
                 double videoEncode = -1)
{
  FrameSlice s;
  s.startUs = startMs * 1000;
  s.endUs = (startMs + 250) * 1000;
  s.rendered = rendered;
  s.lagged = lagged;
  s.encoded = rendered;
  s.stalled = stalled;
  s.engine3d = engine3d;
  s.videoEncode = videoEncode;
  return s;
}

bool near(double a, double b) { return std::fabs(a - b) < 1e-6; }

WindowTotals totals(std::initializer_list<FrameSlice> slices)
{
  WindowTotals window;
  for (const auto& s : slices)
    addSlice(window, s);
  return window;
}

} // namespace

int main()
{
  // Texture encoders count repeats of render-lagged frames as skipped; only
  // the excess belongs to the encoder. The raw path is already exact.
  assert(encoderSkippedFrames(10, 10, true) == 0);
  assert(encoderSkippedFrames(14, 10, true) == 4);
  assert(encoderSkippedFrames(3, 10, true) == 0);
  assert(encoderSkippedFrames(3, 10, false) == 3);

  // Counters restart from zero after a video reset; deltas must not wrap and
  // the encoder backlog starts over.
  FrameSlice reset = frameSlice({1000, 40, 990, 40}, {30, 2, 28, 2}, true, 50, true, 0, 250000);
  assert(reset.rendered == 30 && reset.lagged == 2 && reset.encoded == 28 && reset.repeated == 0);
  assert(reset.backlog == 0 && reset.stalled == 0);
  FrameSlice normal = frameSlice({100, 0, 100, 0}, {115, 3, 115, 9}, true, 0, true, 0, 250000);
  assert(normal.rendered == 15 && normal.lagged == 3 && normal.repeated == 6 && normal.backlog == 0);
  // No encoder consuming the mix: rendering ahead of encoding is not a backlog.
  assert(frameSlice({0, 0, 0, 0}, {15, 0, 0, 0}, true, 0, false, 0, 250000).backlog == 0);

  // The encoder falls behind: frames queue up to the texture queue (10), then
  // every new frame is dropped until the queue drains again.
  FrameSlice queueing = frameSlice({0, 0, 0, 0}, {15, 0, 7, 0}, true, 0, true, 0, 250000);
  assert(queueing.backlog == 8 && queueing.stalled == 0);
  FrameSlice overflow = frameSlice({15, 0, 7, 0}, {30, 0, 11, 0}, true, queueing.backlog, true, 0, 250000);
  assert(overflow.backlog == 19 && overflow.stalled == 9);
  FrameSlice full = frameSlice({30, 0, 11, 0}, {45, 1, 15, 4}, true, overflow.backlog, true, 0, 250000);
  assert(full.backlog == 30 && full.stalled == 14); // every new frame but the lagged one
  // Draining a large backlog after the load drops still drops new frames...
  FrameSlice draining = frameSlice({45, 1, 15, 4}, {60, 1, 60, 49}, true, 300, true, 0, 250000);
  assert(draining.backlog == 270 && draining.stalled == 15);
  // ...until the queue has room again; the raw path queues 16 frames.
  FrameSlice drained = frameSlice({60, 1, 30, 19}, {75, 1, 51, 24}, true, 15, true, 0, 250000);
  assert(drained.backlog == 9 && drained.stalled == 5);
  assert(frameSlice({0, 0, 0, 0}, {15, 0, 0, 0}, false, 14, true, 0, 250000).stalled == 13);

  // Classification thresholds and precedence.
  assert(classifyFrameLoss(totals({slice(0, 300, 1, 0, 99)})) == PerfCause::Ok); // 0.3 %
  assert(classifyFrameLoss(totals({slice(0, 300, 30, 0, 99)})) == PerfCause::GpuStarved);
  assert(classifyFrameLoss(totals({slice(0, 300, 30, 0, 40)})) == PerfCause::RenderStall);
  assert(classifyFrameLoss(totals({slice(0, 300, 30, 0)})) == PerfCause::RenderStall); // GPU unknown
  // Texture encoder stalls behind a saturated 3D engine with NVENC idle: the
  // GPU, not the encoder, is the bottleneck.
  assert(classifyFrameLoss(totals({slice(0, 300, 2, 120, 97, 2)})) == PerfCause::GpuStarved);
  assert(classifyFrameLoss(totals({slice(0, 300, 0, 120, 30, 95)})) == PerfCause::EncoderOverloaded);
  assert(classifyFrameLoss(totals({slice(0, 300, 0, 120, 30, 5)})) == PerfCause::EncoderOverloaded);
  // Only losses during busy slices count as evidence.
  assert(classifyFrameLoss(totals({slice(0, 150, 0, 0, 99), slice(250, 150, 20, 0, 40)})) == PerfCause::RenderStall);

  // A backlog left by GPU starvation stays GPU starvation while it drains,
  // even though the 3D engine is idle again.
  WindowTotals drainWindow = totals({slice(0, 300, 0, 200, 20, 40)});
  drainWindow.backlog = 400;
  assert(classifyFrameLoss(drainWindow) == PerfCause::EncoderOverloaded);
  assert(classifyWithBacklog(drainWindow, PerfCause::GpuStarved, true) == PerfCause::GpuStarved);
  assert(classifyWithBacklog(drainWindow, PerfCause::Ok, true) == PerfCause::EncoderOverloaded);
  drainWindow.backlog = 5;
  assert(classifyWithBacklog(drainWindow, PerfCause::GpuStarved, true) == PerfCause::EncoderOverloaded);

  // Mostly GPU-starved loss: render lag and texture-queue stalls at 98 % 3D.
  assert(classifyFrameLoss(totals({slice(0, 15, 4, 3, 98, 10), slice(250, 15, 5, 4, 99, 10),
                                   slice(500, 15, 1, 0, 60, 10)})) == PerfCause::GpuStarved);
  // One brief GPU-starved slice, then most frames lost to render stalls with
  // headroom: the window follows where the frames were lost.
  WindowTotals briefSpike = totals({slice(0, 15, 2, 0, 99), slice(250, 15, 6, 0, 45), slice(500, 15, 7, 0, 40),
                                    slice(750, 15, 5, 0, 50)});
  assert(briefSpike.lostGpu == 2 && briefSpike.lostRender == 18);
  assert(classifyFrameLoss(briefSpike) == PerfCause::RenderStall);
  // Encoder saturation: stalls with the video encode engine pinned, even
  // while the game also loads the 3D engine.
  WindowTotals encoderBound = totals({slice(0, 15, 0, 6, 95, 99), slice(250, 15, 0, 8, 92, 97), slice(500, 15, 1, 0, 95, 40)});
  assert(encoderBound.lostEncoder == 14 && encoderBound.lostGpu == 1);
  assert(classifyFrameLoss(encoderBound) == PerfCause::EncoderOverloaded);
  // GPU starvation fills the queue; once the 3D engine drops, the stalls that
  // drain that same queue stay GPU starvation...
  WindowTotals drainAfterSpike = totals({slice(0, 15, 3, 10, 99, 20), slice(250, 15, 0, 12, 40, 60),
                                         slice(500, 15, 0, 12, 35, 60), slice(750, 15, 0, 9, 30, 60)});
  assert(drainAfterSpike.lostGpu == 46 && drainAfterSpike.lostEncoder == 0);
  assert(classifyFrameLoss(drainAfterSpike) == PerfCause::GpuStarved);
  // ...until a slice without loss shows the queue had room again.
  WindowTotals drainedThenEncoder = totals({slice(0, 15, 0, 10, 99, 20), slice(250, 15, 0, 0, 40, 20),
                                            slice(500, 15, 0, 12, 35, 20), slice(750, 15, 0, 12, 35, 20)});
  assert(drainedThenEncoder.lostGpu == 10 && drainedThenEncoder.lostEncoder == 24);
  assert(classifyFrameLoss(drainedThenEncoder) == PerfCause::EncoderOverloaded);

  assert(perfCauseHint(PerfCause::GpuStarved, false).find("Recording priority") != std::string::npos);
  assert(perfCauseHint(PerfCause::GpuStarved, true).find("Recording priority") == std::string::npos);
  assert(perfCauseHint(PerfCause::GpuStarved, false, true).find("catching up") != std::string::npos);
  assert(perfCauseHint(PerfCause::Ok, false).empty());

  // Clip lag: segments are relative to the clip start, clipped to it, merged
  // across gaps up to one second and split beyond that.
  std::deque<FrameSlice> slices;
  for (uint64_t ms = 0; ms < 20000; ms += 250)
    slices.push_back(slice(ms, 15, 0, 0, 50, 5));
  const auto at = [&](uint64_t ms) -> FrameSlice& { return slices[ms / 250]; };
  at(1000) = slice(1000, 15, 5, 0, 50, 5);   // before the clip window
  at(5000) = slice(5000, 15, 6, 0, 99, 2);   // render lag, GPU pinned
  at(5500) = slice(5500, 15, 0, 9, 99, 2);   // 250 ms gap: same segment
  at(8000) = slice(8000, 15, 0, 3, 60, 96);  // > 1 s later, encoder saturated
  at(19750) = slice(19750, 15, 2, 0, 30, 5); // straddles the clip end

  ClipLag lag = clipLagFromSlices(slices, 2000 * 1000, 19900 * 1000);
  assert(lag.lagged == 8);
  assert(lag.stalled == 12);
  assert(lag.segments.size() == 3);
  assert(near(lag.segments[0].start, 3.0) && near(lag.segments[0].end, 3.75));
  assert(lag.segments[0].lagged == 6 && lag.segments[0].stalled == 9);
  assert(lag.segments[0].cause == PerfCause::GpuStarved);
  assert(near(lag.segments[1].start, 6.0) && lag.segments[1].cause == PerfCause::EncoderOverloaded);
  assert(near(lag.segments[2].start, 17.75) && near(lag.segments[2].end, 17.9));
  assert(lag.segments[2].cause == PerfCause::RenderStall);
  assert(lag.cause == PerfCause::GpuStarved); // most lost frames
  assert(clipLagFromSlices(slices, 10000 * 1000, 12000 * 1000).segments.empty());
  assert(clipLagFromSlices(slices, 5000, 5000).frames == 0);

  // GPU Engine counter instance names (Task Manager/PDH format).
  GpuEngineInstance instance;
  assert(parseGpuEngineInstance("pid_36176_luid_0x00000000_0x0000F152_phys_0_eng_0_engtype_3D", instance));
  assert(instance.pid == 36176 && instance.luid == 0xF152 && instance.engine == 0 && instance.type == "3d");
  assert(parseGpuEngineInstance("pid_4_luid_0x00000001_0x0000A000_phys_0_eng_14_engtype_Compute_0", instance));
  assert(instance.luid == ((1ull << 32) | 0xA000) && instance.engine == 14 && instance.type == "compute_0");
  assert(parseGpuEngineInstance("pid_30952_luid_0x00000000_0x0000f152_phys_0_eng_6_engtype_videoencode", instance));
  assert(instance.type == "videoencode");
  assert(!parseGpuEngineInstance("pid_x_luid_0x0_0x0_phys_0_eng_0_engtype_3D", instance));
  assert(!parseGpuEngineInstance("pid_1_luid_0x0_0x0_phys_0_eng_0_engtype_", instance));

  // Engine utilization sums processes per engine, reports the busiest engine
  // per type, ignores other adapters and attributes 3D time to processes.
  const uint64_t luid = 0xF152;
  std::vector<GpuEngineUsage> usage = {
      {100, luid, 0, 0, "3d", 92.0},          // game
      {200, luid, 0, 0, "3d", 1.5},           // core (self)
      {300, luid, 0, 0, "3d", 3.0},           // other app
      {200, luid, 0, 6, "videoencode", 4.0},  // NVENC engine 0
      {200, luid, 0, 7, "videoencode", 3.0},  // NVENC engine 1
      {100, 0x9999, 0, 0, "3d", 80.0},        // other adapter
  };
  GpuEngineSample sample = aggregateGpuEngines(usage, luid, {100}, 200);
  assert(sample.available);
  assert(near(sample.engine3d, 96.5));
  assert(near(sample.videoEncode, 4.0));
  assert(near(sample.target3d, 92.0));
  assert(near(sample.self3d, 1.5) && near(sample.selfEncode, 4.0));
  assert(sample.top3dPid == 100 && near(sample.top3d, 92.0));
  usage.push_back({400, luid, 0, 0, "3d", 30.0});
  assert(near(aggregateGpuEngines(usage, luid, {100}, 200).engine3d, 100.0)); // capped

  std::puts("perf analysis tests passed");
  return 0;
}
