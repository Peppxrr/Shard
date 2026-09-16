#pragma once

#include "config.h"

#include <obs.h>

#include <string>

#include <vector>

namespace shard {
struct VideoEncoderInfo {
  std::string id;
  std::string label;
  std::string codec;
  std::string vendor;
  bool hardware = false;
};


// Builds encoder settings and creates encoder instances. Encoders are created
// per capture session: the replay ring owns the primary instance, manual
// recording gets its own instance with identical settings (OBS allows only
// sequential sharing of one encoder across outputs).
class EncoderManager {
public:
  explicit EncoderManager(const Config& config);

  // The OBS modules perform their hardware capability probes once while
  // loading. This exposes only encoders that survived those probes.
  std::vector<VideoEncoderInfo> availableVideoEncoders() const;
  std::vector<std::string> videoEncoderCandidates(const std::string& requested) const;
  std::string resolveVideoEncoderId(const std::string& requested) const;

  // Fully-populated settings for a concrete encoder id.
  obs_data_t* videoSettings(const std::string& encoderId = {}) const;
  obs_data_t* audioSettings() const;

  // Effective output size/fps for the configured preset.
  // Effective output video params. baseW/baseH = the monitor's native
  // resolution: medium/high capture at native resolution (no downscale),
  // low stays 720p30, custom uses the explicit settings.
  void effectiveVideoParams(int baseW, int baseH, int& width, int& height, int& fps, int& bitrateKbps) const;
  // Bitrate only (independent of resolution): low 4M / medium 8M / high 16M / custom.
  int effectiveBitrateKbps() const;

private:
  const Config& config_;
};

} // namespace shard
