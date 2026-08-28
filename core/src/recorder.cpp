#include "recorder.h"

#include <obs-module.h>
#include <algorithm>

#include <chrono>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <thread>

namespace clipforge {

namespace fs = std::filesystem;

using namespace std::chrono;

Recorder::Recorder(App& app, Config& config, Events& events, EncoderManager& encoders)
    : app_(app), config_(config), events_(events), encoders_(encoders)
{
}

Recorder::~Recorder()
{
  if (active_.load())
    stop();
  if (output_) {
    signal_handler_t* sh = obs_output_get_signal_handler(output_);
    signal_handler_disconnect(sh, "stop", onOutputStop, this);
    obs_output_release(output_);
  }
  if (videoEncoder_)
    obs_encoder_release(videoEncoder_);
  for (auto* e : audioEncoders_)
    obs_encoder_release(e);
}

void Recorder::onOutputStop(void* data, calldata_t* /*cd*/)
{
  auto* self = static_cast<Recorder*>(data);
  if (!self)
    return;
  std::string path = self->currentPath_;
  self->active_.store(false);
  self->events_.emit("recording.state", {{"active", false}, {"path", path}});
}

bool Recorder::start()
{
  if (active_.load())
    return true;

  // Release a previous (stopped) output/encoders before creating new ones.
  if (output_) {
    signal_handler_t* sh = obs_output_get_signal_handler(output_);
    signal_handler_disconnect(sh, "stop", onOutputStop, this);
    obs_output_release(output_);
    output_ = nullptr;
  }
  if (videoEncoder_) {
    obs_encoder_release(videoEncoder_);
    videoEncoder_ = nullptr;
  }
  for (auto* e : audioEncoders_)
    obs_encoder_release(e);
  audioEncoders_.clear();

  const std::string videoId = encoders_.resolveVideoEncoderId(config_.video.encoder);
  videoEncoder_ = obs_video_encoder_create(videoId.c_str(), "rec-video", encoders_.videoSettings(), nullptr);
  if (!videoEncoder_) {
    events_.emit("error", {{"code", "ENCODER_FAIL"}, {"message", "Could not create recording video encoder"}});
    return false;
  }
  // Allocate one encoder for each configured row, even while that row is
  // disabled. Source toggles then change the live mix without splitting the
  // recording or restarting its output.
  const int audioTracks = 1 + std::min(static_cast<int>(config_.audioSources.size()), 5);
  for (int track = 0; track < audioTracks; track++) {
    char name[32];
    std::snprintf(name, sizeof(name), "rec-audio-%d", track);
    obs_encoder_t* aenc = obs_audio_encoder_create("ffmpeg_aac", name, encoders_.audioSettings(), track, nullptr);
    if (!aenc) {
      obs_encoder_release(videoEncoder_);
      videoEncoder_ = nullptr;
      events_.emit("error", {{"code", "ENCODER_FAIL"}, {"message", "Could not create recording audio encoder"}});
      return false;
    }
    obs_encoder_set_audio(aenc, obs_get_audio());
    audioEncoders_.push_back(aenc);
  }

  // Fragmented mp4: crash-safe, no remux step needed.
  // Unique filename: recording-YYYYMMDD-HHMMSS-<microsec>.mp4
  auto now = system_clock::now();
  std::time_t t = system_clock::to_time_t(now);
  std::tm tm{};
#ifdef _WIN32
  localtime_s(&tm, &t);
#else
  localtime_r(&t, &tm);
#endif
  auto us = duration_cast<microseconds>(now.time_since_epoch()).count() % 1000000;
  char name[128];
  std::snprintf(name, sizeof(name), "recording-%04d%02d%02d-%02d%02d%02d-%06lld.mp4", tm.tm_year + 1900, tm.tm_mon + 1,
                tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, (long long)us);

  fs::create_directories(config_.recordingsDir);
  currentPath_ = (fs::path(config_.recordingsDir) / name).string();

  obs_data_t* s = obs_data_create();
  obs_data_set_string(s, "path", currentPath_.c_str());
  obs_data_set_string(s, "muxer_settings", "movflags=frag_keyframe+empty_moov");

  output_ = obs_output_create("ffmpeg_muxer", "recording", s, nullptr);
  obs_data_release(s);
  if (!output_) {
    obs_encoder_release(videoEncoder_);
    videoEncoder_ = nullptr;
    for (auto* e : audioEncoders_)
      obs_encoder_release(e);
    audioEncoders_.clear();
    events_.emit("error", {{"code", "ENCODER_FAIL"}, {"message", "Could not create recording output"}});
    return false;
  }

  obs_output_set_video_encoder(output_, videoEncoder_);
  for (size_t track = 0; track < audioEncoders_.size(); track++)
    obs_output_set_audio_encoder(output_, audioEncoders_[track], track);
  // Encoded outputs refuse obs_output_set_media; wire the encoders directly.
  obs_encoder_set_video(videoEncoder_, obs_get_video());

  signal_handler_t* sh = obs_output_get_signal_handler(output_);
  signal_handler_connect(sh, "stop", onOutputStop, this);

  if (!obs_output_start(output_)) {
    events_.emit("error", {{"code", "ENCODER_FAIL"}, {"message", "Recording failed to start"}});
    obs_output_release(output_);
    output_ = nullptr;
    obs_encoder_release(videoEncoder_);
    videoEncoder_ = nullptr;
    for (auto* e : audioEncoders_)
      obs_encoder_release(e);
    audioEncoders_.clear();
    return false;
  }

  active_.store(true);
  events_.emit("recording.state", {{"active", true}, {"path", currentPath_}});
  return true;
}

void Recorder::stop()
{
  if (!active_.load())
    return;
  if (output_)
    obs_output_stop(output_);
  // The "stop" signal (onOutputStop) flips active_ and emits the state event
  // once the muxer finalizes.
}

void Recorder::stopAndWait(int timeoutMs)
{
  stop();
  if (!active_.load())
    return;
  auto deadline = steady_clock::now() + milliseconds(timeoutMs);
  while (active_.load() && steady_clock::now() < deadline)
    std::this_thread::sleep_for(milliseconds(50));
}

} // namespace clipforge
