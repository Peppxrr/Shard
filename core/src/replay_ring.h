#pragma once

#include "app.h"
#include "config.h"
#include "encoders.h"

#include <obs.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace clipforge {

// RAM replay ring. Registers a custom encoded output type ("clipforge_ring")
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

  // Create output + encoders and begin capture. The ring is always warm
  // (auto-started at boot) so hotkeys work at any moment.
  bool start();
  void stop();
  // Tear down and re-create (encoder/video setting changes).
  void restart();

  // Live capture-activity signal (fed by the source watchdog): while true the
  // ring buffers; after 15 s of false it stops and frees its RAM, and
  // restarts when capture returns.
  void setCaptureActive(bool active);

  // Queue a save of the last durationSec (0 = save everything buffered).
  void save(int durationSec);

  void updateCaps();

  void getStats(int& secondsBuffered, double& mbUsed) const;

  bool active() const { return active_.load(); }
  bool muxing() const { return muxing_.load(); }

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
  void stopLocked();  // requires lifecycleMtx_
  void ingestPacket(Ring* r, struct encoder_packet* packet);
  bool purgeFront();
  void purge();
  bool snapshotSave(int durationSec, std::vector<encoder_packet>& out, std::string& path, double& actualSec);
  void saveWorker();
  void muxToFile(const std::vector<encoder_packet>& packets, const std::string& path, bool& success,
                 std::string& error);

  App& app_;
  Config& config_;
  Events& events_;
  EncoderManager& encoders_;

  Ring* ring_ = nullptr;
  obs_output_t* output_ = nullptr;
  obs_encoder_t* videoEncoder_ = nullptr;
  std::vector<obs_encoder_t*> audioEncoders_; // one ffmpeg_aac per audio track
  std::string videoCodec_; // "h264" | "hevc" | "av1" | ... (from the video encoder)

  std::atomic<bool> active_{false};
  std::atomic<bool> muxing_{false};

  // Serializes start/stop/restart/setCaptureActive (watchdog thread vs RPC).
  std::mutex lifecycleMtx_;
  std::chrono::steady_clock::time_point inactiveSince_{};

  std::mutex saveMtx_;
  std::condition_variable saveCv_;
  std::deque<int> saveQueue_;
  std::thread saveThread_;
  std::atomic<bool> saveThreadRun_{true};
};

} // namespace clipforge
