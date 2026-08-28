#pragma once

#include "config.h"

#include <obs.h>

#include <string>

namespace clipforge {

// Builds encoder settings and creates encoder instances. Encoders are created
// per capture session: the replay ring owns the primary instance, manual
// recording gets its own instance with identical settings (OBS allows only
// sequential sharing of one encoder across outputs).
class EncoderManager {
public:
  explicit EncoderManager(const Config& config);

  // Resolve "auto" -> concrete encoder id ("obs_x264" unless NVENC exists).
  std::string resolveVideoEncoderId(const std::string& requested) const;

  // Fully-populated settings for the configured preset (obs_data_t).
  obs_data_t* videoSettings() const;
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

} // namespace clipforge
