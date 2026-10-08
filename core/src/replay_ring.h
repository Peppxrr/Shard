#pragma once

#include "app.h"
#include "config.h"
#include "encoders.h"
#include "replay_timing.h"
#include "save_queue.h"

#include <obs.h>

#include <atomic>
#include <chrono>
#include <mutex>
#include <string>
#include <cstdint>
#include <thread>
#include <vector>

namespace shard {

class PerfMonitor;

// RAM replay ring. Registers a custom encoded output type ("shard_ring")
// whose encoded_packet callback keeps a RAM ring of keyframe-anchored encoded
// packets (byte cap + time cap). save(durationSec) snapshots the tail of the
// ring (keeping the keyframe that precedes the start), offsets timestamps to
// zero, and muxes to mp4 through the obs-ffmpeg-mux helper subprocess.
// Saves are serialized on a dedicated worker so rapid hotkey presses cannot
// corrupt a mux in progress.
class ReplayRing {
public:
  struct Ring; // forward decl (defined in replay_ring.cpp); pointer-only use here

  ReplayRing(App& app, Config& config, Events& events, EncoderManager& encoders);
  ~ReplayRing();

  ReplayRing(const ReplayRing&) = delete;
  ReplayRing& operator=(const ReplayRing&) = delete;

  // Create output + encoders and begin capture when a subject is available.
  bool start();
  void stop();
  // Tear down and re-create (encoder/video setting changes).
  void restart();

  // Live capture-activity signal (fed by the source watchdog): while true the
  // ring buffers; after 15 s of false it stops and frees its RAM, and
  // restarts when capture returns.
  void setCaptureActive(bool active);

  // Queue a save of the last durationSec (0 = save everything buffered).
  // Returns the request id, or 0 when no replay buffer is running (nothing
  // is queued). An accepted request emits "clip.queued" {request} at once and
  // ends with exactly one "clip.saved", "clip.dropped" or "error" carrying
  // the same request id, also when the ring stops concurrently.
  uint64_t save(int durationSec);

  void updateCaps();

  void getStats(int& secondsBuffered, double& mbUsed) const;

  bool active() const { return active_.load(); }
  bool muxing() const { return muxing_.load(); }

  // Optional: encoder-path reporting and per-clip lag markers.
  void setPerfMonitor(PerfMonitor* perf) { perf_ = perf; }

private:
  // ---- registered output type ----
  static const char* ringGetName(void* type);
  static void* ringCreate(obs_data_t* settings, obs_output_t* output);
  static void ringDestroy(void* data);
  static bool ringStart(void* data);
  static void ringStop(void* data, uint64_t ts);
  static void ringData(void* data, struct encoder_packet* packet);
  static void ringDefaults(obs_data_t* s);

  // ---- ring internals ----
  bool startLocked(); // requires lifecycleMtx_
  bool startWithVideoEncoderLocked(const std::string& videoId); // requires lifecycleMtx_
  void stopLocked();  // requires lifecycleMtx_
  void ingestPacket(Ring* r, struct encoder_packet* packet);
  static bool purgeFront(Ring* ring);
  static void purge(Ring* ring);
  struct SaveRequest {
    uint64_t id = 0;
    int durationSec = 0;
    int64_t endTimeUs = 0;
    uint64_t requestSteadyUs = 0; // steady clock at the hotkey/RPC
  };
  // Accepted only between startLocked() succeeding and stopLocked().
  SaveQueue<SaveRequest> saves_;
  bool snapshotSave(const SaveRequest& request, std::vector<encoder_packet>& out, std::string& path, double& actualSec,
                    uint64_t& startSteadyUs, uint64_t& endSteadyUs);
  void saveWorker();
  void muxToFile(const std::vector<encoder_packet>& packets, const std::string& path, bool& success,
                 std::string& error);

  App& app_;
  Config& config_;
  Events& events_;
  EncoderManager& encoders_;
  PerfMonitor* perf_ = nullptr;

  Ring* ring_ = nullptr;
  obs_output_t* output_ = nullptr;
  obs_encoder_t* videoEncoder_ = nullptr;
  std::vector<obs_encoder_t*> audioEncoders_; // one ffmpeg_aac per audio track
  std::string videoCodec_; // "h264" | "hevc" | "av1" | ... (from the video encoder)

  std::atomic<bool> active_{false};
  std::atomic<bool> muxing_{false};

  mutable std::mutex lifecycleMtx_;
  ReplayActivityGrace activityGrace_;

  std::thread saveThread_;
};

} // namespace shard
