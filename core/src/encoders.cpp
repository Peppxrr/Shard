#include "encoders.h"

#include <obs-module.h>

#include <cstring>

namespace clipforge {

namespace {

constexpr const char* const kNvencIds[] = {"obs_nvenc_h264_tex", "obs_nvenc_h264_soft", nullptr};

bool encoderIdExists(const char* id)
{
  const char* eid = nullptr;
  for (size_t i = 0; obs_enum_encoder_types(i, &eid); i++) {
    if (eid && std::strcmp(eid, id) == 0)
      return true;
  }
  return false;
}

} // namespace

EncoderManager::EncoderManager(const Config& config) : config_(config) {}

std::string EncoderManager::resolveVideoEncoderId(const std::string& requested) const
{
  if (!requested.empty() && requested != "auto") {
    if (encoderIdExists(requested.c_str()))
      return requested;
    // Requested encoder unavailable -> fall back to x264 (never hard-fail).
    return "obs_x264";
  }

  for (const char* const* id = kNvencIds; *id; id++) {
    if (encoderIdExists(*id))
      return *id;
  }
  return "obs_x264";
}

int EncoderManager::effectiveBitrateKbps() const
{
  const auto& v = config_.video;
  if (v.preset == "low")
    return 4000;
  if (v.preset == "high")
    return 16000;
  if (v.preset == "custom")
    return v.bitrateKbps;
  return 8000; // medium (default)
}

void EncoderManager::effectiveVideoParams(int baseW, int baseH, int& width, int& height, int& fps,
                                          int& bitrateKbps) const
{
  const auto& v = config_.video;
  fps = v.fps;

  if (v.preset == "low") {
    width = baseW > 1280 ? 1280 : baseW;
    height = baseH > 720 ? 720 : baseH;
    fps = fps > 30 ? 30 : fps;
    bitrateKbps = 4000;
  } else if (v.preset == "high") {
    width = baseW;
    height = baseH;
    bitrateKbps = 16000;
  } else if (v.preset == "custom") {
    width = v.width;
    height = v.height;
    bitrateKbps = v.bitrateKbps;
  } else { // medium (default)
    width = baseW;
    height = baseH;
    bitrateKbps = 8000;
  }
}

obs_data_t* EncoderManager::videoSettings() const
{
  const auto& v = config_.video;
  const int bitrate = effectiveBitrateKbps();

  obs_data_t* s = obs_data_create();
  obs_data_set_int(s, "bitrate", bitrate);
  obs_data_set_int(s, "keyint_sec", 2); // short GOP: clips always start on a keyframe
  obs_data_set_string(s, "rate_control", "CBR");

  const std::string id = resolveVideoEncoderId(v.encoder);
  if (id == "obs_x264") {
    obs_data_set_string(s, "preset", v.x264Preset.empty() ? "veryfast" : v.x264Preset.c_str());
    obs_data_set_string(s, "profile", "high");
  } else if (id.find("av1") != std::string::npos) {
    obs_data_set_string(s, "preset", "p3");
    obs_data_set_string(s, "preset2", "p3");
    obs_data_set_string(s, "multipass", "disabled");
    obs_data_set_bool(s, "adaptive_quantization", false);
    obs_data_set_bool(s, "psycho_aq", false);
    obs_data_set_bool(s, "lookahead", false);
  } else if (id.find("nvenc") != std::string::npos) {
    // Single-pass NVENC keeps the capture path light enough to coexist with
    // games already saturating the GPU. Texture encoders avoid a GPU->CPU copy.
    obs_data_set_string(s, "preset", "p3");
    obs_data_set_string(s, "preset2", "p3");
    obs_data_set_string(s, "tune", "ll");
    obs_data_set_string(s, "multipass", "disabled");
    obs_data_set_string(s, "profile", id.find("hevc") != std::string::npos ? "main" : "high");
    obs_data_set_bool(s, "adaptive_quantization", false);
    obs_data_set_bool(s, "psycho_aq", false);
    obs_data_set_bool(s, "lookahead", false);
    obs_data_set_int(s, "bf", 2);
  }
  return s;
}

obs_data_t* EncoderManager::audioSettings() const
{
  obs_data_t* s = obs_data_create();
  obs_data_set_int(s, "bitrate", 160);
  return s;
}

} // namespace clipforge
