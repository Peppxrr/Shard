// libobs color-level contract for Shard's fixed Rec.709 SDR canvas.
//
// HDR sources (scRGB FP16 game/hook captures and Rec.2100 PQ 10-bit captures)
// are tonemapped into the SDR canvas by libobs. Those conversions read the SDR
// white level and HDR nominal peak through obs_get_video_*_level(). libobs
// zero-initializes both fields and the OBS frontend is what normally calls
// obs_set_video_levels(); Shard embeds libobs directly, so without this call
// every 80/white and 10000/white multiplier is infinite and HDR sources turn
// into solid white (or NaN/black on some GPUs) instead of tone-mapped SDR.
#pragma once

#include <obs.h>

namespace shard {

// Match the OBS Studio defaults (Settings > Advanced).
constexpr float kSdrWhiteLevelNits = 300.0f;
constexpr float kHdrNominalPeakLevelNits = 1000.0f;

// Must run after a successful obs_reset_video (libobs asserts on graphics).
inline void applyVideoColorLevels()
{
  obs_set_video_levels(kSdrWhiteLevelNits, kHdrNominalPeakLevelNits);
}

} // namespace shard
