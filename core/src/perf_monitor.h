#pragma once

#include "app.h"
#include "config.h"
#include "gpu_engines.h"
#include "perf_analysis.h"

#include <nlohmann/json.hpp>
#include <obs.h>

#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace shard {

class SourceManager;

// How an output's video encoder receives frames.
struct VideoEncoderPath {
  std::string output;         // "replay" | "recording"
  std::string encoderId;
  bool textureCapable = false; // encoder type accepts GPU textures
  bool nv12Texture = false;    // libobs shares NV12 textures with this encoder
  bool gpuScaling = false;     // encoder-side rescale (extra pass / CPU path)
  bool fellBack = false;       // plugin logged a non-texture fallback while starting
  bool zeroCopy = false;       // frames stay on the GPU end to end
  std::string reason;          // why zero-copy is not active
  std::string settingsJson;
};

// Inspect a started encoder. `startMessages` are the libobs messages logged
// on the starting thread during obs_output_start (see ObsLogCapture).
VideoEncoderPath inspectVideoEncoderPath(const char* output, obs_encoder_t* encoder,
                                         const std::vector<std::string>& startMessages);

// Samples libobs frame pacing (render lag, encoder skips, frame time) four
// times per second and GPU engine utilization once per second, classifies
// the cause of lost frames, emits `perf.stats`, writes `[perf]` diagnostics,
// and keeps a bounded history so saved clips can carry their lag markers.
class PerfMonitor {
public:
  PerfMonitor(App& app, Config& config, Events& events, SourceManager& sources);
  ~PerfMonitor();
  PerfMonitor(const PerfMonitor&) = delete;
  PerfMonitor& operator=(const PerfMonitor&) = delete;

  void start();
  void stop();

  void setLaunchMode(std::string mode);
  // Called by outputs after their video encoder started. Logs the session
  // diagnostics; the replay ring's path decides how skips are attributed.
  void outputStarted(const VideoEncoderPath& path);

  // Lag inside [startUs, endUs) of steady_clock microseconds, with segment
  // times relative to startUs. Null when the history does not cover it.
  nlohmann::json lagJson(uint64_t startUs, uint64_t endUs) const;
  nlohmann::json stateJson() const;

  static uint64_t nowUs();

private:
  void run();
  bool readCounters(FrameCounters& counters);
  nlohmann::json sessionJsonLocked() const;
  std::vector<uint32_t> targetPids() const;
  void logSessionLocked(const char* reason);

  App& app_;
  Config& config_;
  Events& events_;
  SourceManager& sources_;

  std::thread thread_;
  std::mutex wakeMutex_;
  std::condition_variable wake_;
  bool running_ = false;
  // Opened by start(); afterwards used only by the sampler thread.
  GpuEngineMonitor gpu_;

  // Fixed for the process/graphics-device lifetime.
  bool elevated_ = false;
  std::optional<bool> hags_;

  mutable std::mutex mutex_;
  std::deque<FrameSlice> slices_;
  nlohmann::json latest_ = nullptr;
  std::string launchMode_ = "normal";
  VideoEncoderPath replayPath_;
  VideoEncoderPath recordingPath_;
  bool gpuCountersAvailable_ = false;
  std::string gpuCountersError_;
  std::atomic<bool> texturePath_{false};
  PerfCause cause_ = PerfCause::Ok;
  uint64_t causeSinceUs_ = 0;
  uint64_t warmupUntilUs_ = 0;
};

} // namespace shard
