#include "encoders.h"

#include <obs-module.h>
#include <graphics/graphics.h>

#include <algorithm>
#include <cctype>
#include <cstring>

namespace shard {

namespace {

struct EncoderCatalogEntry {
  const char* id;
  const char* label;
  const char* codec;
  const char* vendor;
  bool hardware;
};

constexpr EncoderCatalogEntry kEncoderCatalog[] = {
    {"obs_x264", "x264 H.264 (CPU)", "h264", "cpu", false},
    {"obs_x265", "x265 HEVC (CPU)", "hevc", "cpu", false},
    {"obs_nvenc_h264_tex", "NVIDIA NVENC H.264", "h264", "nvidia", true},
    {"obs_nvenc_hevc_tex", "NVIDIA NVENC HEVC", "hevc", "nvidia", true},
    {"obs_nvenc_av1_tex", "NVIDIA NVENC AV1", "av1", "nvidia", true},
    {"h264_texture_amf", "AMD AMF H.264", "h264", "amd", true},
    {"h265_texture_amf", "AMD AMF HEVC", "hevc", "amd", true},
    {"av1_texture_amf", "AMD AMF AV1", "av1", "amd", true},
    {"obs_qsv11_v2", "Intel Quick Sync H.264", "h264", "intel", true},
    {"obs_qsv11_hevc", "Intel Quick Sync HEVC", "hevc", "intel", true},
    {"obs_qsv11_av1", "Intel Quick Sync AV1", "av1", "intel", true},
};

bool encoderIdExists(const char* id)
{
  const char* eid = nullptr;
  for (size_t i = 0; obs_enum_encoder_types(i, &eid); i++) {
    if (eid && std::strcmp(eid, id) == 0)
      return true;
  }
  return false;
}

std::string activeGpuVendor()
{
  std::string name;
  obs_enter_graphics();
  if (const char* device = gs_get_device_name())
    name = device;
  obs_leave_graphics();
  std::transform(name.begin(), name.end(), name.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (name.find("nvidia") != std::string::npos)
    return "nvidia";
  if (name.find("amd") != std::string::npos || name.find("radeon") != std::string::npos)
    return "amd";
  if (name.find("intel") != std::string::npos)
    return "intel";
  return {};
}

void appendIfAvailable(std::vector<std::string>& out, const char* id)
{
  if (!encoderIdExists(id) || std::find(out.begin(), out.end(), id) != out.end())
    return;
  out.emplace_back(id);
}

} // namespace

EncoderManager::EncoderManager(const Config& config) : config_(config) {}

std::vector<VideoEncoderInfo> EncoderManager::availableVideoEncoders() const
{
  std::vector<VideoEncoderInfo> out;
  for (const auto& entry : kEncoderCatalog) {
    if (!encoderIdExists(entry.id))
      continue;
    out.push_back({entry.id, entry.label, entry.codec, entry.vendor, entry.hardware});
  }
  return out;
}

std::vector<std::string> EncoderManager::videoEncoderCandidates(const std::string& requested) const
{
  std::vector<std::string> out;
  if (!requested.empty() && requested != "auto") {
    appendIfAvailable(out, requested.c_str());
    if (requested == "obs_nvenc_h264_tex")
      appendIfAvailable(out, "obs_nvenc_h264_soft");
    else if (requested == "obs_nvenc_hevc_tex")
      appendIfAvailable(out, "obs_nvenc_hevc_soft");
    else if (requested == "obs_nvenc_av1_tex")
      appendIfAvailable(out, "obs_nvenc_av1_soft");
    appendIfAvailable(out, "obs_x264");
    return out;
  }

  const std::string primaryVendor = activeGpuVendor();
  for (const auto& entry : kEncoderCatalog)
    if (entry.hardware && std::strcmp(entry.codec, "h264") == 0 && primaryVendor == entry.vendor)
      appendIfAvailable(out, entry.id);

  // Multi-GPU systems can expose more than one working H.264 encoder. Prefer
  // the OBS graphics-device vendor, then try the other probed hardware before
  // the guaranteed CPU fallback.
  for (const auto& entry : kEncoderCatalog)
    if (entry.hardware && std::strcmp(entry.codec, "h264") == 0)
      appendIfAvailable(out, entry.id);
  appendIfAvailable(out, "obs_x264");
  return out;
}

std::string EncoderManager::resolveVideoEncoderId(const std::string& requested) const
{
  const auto candidates = videoEncoderCandidates(requested);
  return candidates.empty() ? "obs_x264" : candidates.front();
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

obs_data_t* EncoderManager::videoSettings(const std::string& encoderId) const
{
  const auto& v = config_.video;
  const int bitrate = effectiveBitrateKbps();
  const std::string id = encoderId.empty() ? resolveVideoEncoderId(v.encoder) : encoderId;

  obs_data_t* s = obs_data_create();
  obs_data_set_int(s, "bitrate", bitrate);
  obs_data_set_int(s, "keyint_sec", 2); // short GOP: clips always start on a keyframe
  obs_data_set_string(s, "rate_control", "CBR");

  if (id == "obs_x264") {
    obs_data_set_string(s, "preset", v.x264Preset.empty() ? "veryfast" : v.x264Preset.c_str());
    obs_data_set_string(s, "profile", "high");
  } else if (id == "obs_x265") {
    obs_data_set_string(s, "preset", "veryfast");
  } else if (id.find("nvenc") != std::string::npos) {
    // Single-pass NVENC keeps the capture path light enough to coexist with
    // games already saturating the GPU. Texture encoders avoid a GPU->CPU copy.
    obs_data_set_string(s, "preset", "p3");
    obs_data_set_string(s, "preset2", "p3");
    obs_data_set_string(s, "tune", "ll");
    obs_data_set_string(s, "multipass", "disabled");
    obs_data_set_string(s, "profile", id.find("h264") != std::string::npos ? "high" : "main");
    obs_data_set_bool(s, "adaptive_quantization", false);
    obs_data_set_bool(s, "psycho_aq", false);
    obs_data_set_bool(s, "lookahead", false);
    obs_data_set_int(s, "bf", 2);
  } else if (id.find("_amf") != std::string::npos) {
    obs_data_set_string(s, "preset", id.find("av1") != std::string::npos ? "balanced" : "quality");
    obs_data_set_string(s, "profile", id.find("h264") != std::string::npos ? "high" : "main");
  } else if (id.find("qsv") != std::string::npos) {
    obs_data_set_string(s, "profile", id.find("h264") != std::string::npos ? "high" : "main");
    obs_data_set_string(s, "target_usage", "TU4");
  }
  return s;
}

obs_data_t* EncoderManager::audioSettings() const
{
  obs_data_t* s = obs_data_create();
  obs_data_set_int(s, "bitrate", 160);
  return s;
}

} // namespace shard
