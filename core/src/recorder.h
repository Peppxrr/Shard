#pragma once

#include "app.h"
#include "config.h"
#include "encoders.h"

#include <obs.h>

#include <atomic>
#include <string>
#include <vector>

namespace clipforge {

// Manual recording: an ffmpeg_muxer output (mkv container — crash-safe) with
// its own encoder instances identical to the ring's. The app remuxes the mkv
// to mp4 after `recording.state {active:false}` and imports it into the
// library; the core never touches the library.
class Recorder {
public:
  Recorder(App& app, Config& config, Events& events, EncoderManager& encoders);
  ~Recorder();

  Recorder(const Recorder&) = delete;
  Recorder& operator=(const Recorder&) = delete;

  bool start();
  void stop();
  // Stop and block until the muxer fully finalizes (needed before
  // obs_reset_video / obs_shutdown). Timeout-bounded.
  void stopAndWait(int timeoutMs = 10000);
  bool active() const { return active_.load(); }

  // Path of the in-progress mkv (empty when inactive).
  std::string currentPath() const { return currentPath_; }

private:
  static void onOutputStop(void* data, calldata_t* cd);

  App& app_;
  Config& config_;
  Events& events_;
  EncoderManager& encoders_;

  obs_output_t* output_ = nullptr;
  obs_encoder_t* videoEncoder_ = nullptr;
  std::vector<obs_encoder_t*> audioEncoders_; // one ffmpeg_aac per audio track
  std::atomic<bool> active_{false};
  std::string currentPath_;
};

} // namespace clipforge
