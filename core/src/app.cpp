#include "app.h"

#include "audio_isolation_capture.h"
#include "encoders.h"
#include "log.h"
#include "x265_encoder.h"

#include <obs-module.h>
#include <algorithm>

#include <filesystem>
#include <sstream>
#include <unordered_map>

namespace shard {

namespace fs = std::filesystem;

App::App(Config& config, Events& events) : config_(config), events_(events) {}

App::~App()
{
  shutdown();
}

bool App::init()
{
  ok_ = false;
  shutdownDone_ = false;
  graphicsAdapterSelected_ = false;

  if (!startup())
    return false;
  if (!resetVideo())
    return false;
  if (!resetAudio())
    return false;

  // Load plugins after the graphics device exists: win-capture decides WGC
  // support at module load via gs_get_device_type() == D3D11, and without a
  // context it falls back to BitBlt (black captures for GPU-rendered windows).
  platform::loadObsModules(config_.coreBinDir);
  registerX265Encoder();
  registerProcessLoopbackSource();

  scene_ = obs_scene_create("main");
  if (!scene_) {
    lastError_ = "obs_scene_create failed";
    return false;
  }

  // Render the scene into the main video mix. Without this the mix's view is
  // empty: render_main_texture clears to black and encodes black frames, and
  // scene audio sources are never activated (silent captures).
  obs_set_output_source(0, obs_scene_get_source(scene_));

  ok_ = true;
  return true;
}

bool App::startup()
{
  fs::create_directories(config_.configDir);

  if (!platform::prepareObs(lastError_))
    return false;
  if (!obs_startup("en-US", config_.configDir.c_str(), nullptr)) {
    platform::releaseObs();
    lastError_ = "obs_startup failed";
    return false;
  }

  // Module paths: obs_startup already registered the platform defaults
  // ("../../obs-plugins/64bit" + "../../data/obs-plugins/%module%", relative
  // to the CWD). The core chdirs into <coreBin>/obs-plugins/64bit before
  // this runs (see main.cpp), so those defaults resolve to the staged
  // runtime. Adding the same paths explicitly here would register every
  // module twice; at obs_shutdown libobs bfrees each registered type's id,
  // and duplicated registrations share the same module-static id pointer —
  // a double free that corrupts the heap on exit.
  // libobs core data (effects, locales): <coreBin>/data/libobs. libobs's own
  // data lookup resolves "../../data/libobs" relative to the CWD; we still
  // add it explicitly so it works regardless of where the process was started.
  // libobs concatenates path + file name, so the path needs a trailing separator.
  std::string libobsData = (fs::path(config_.coreBinDir) / "data" / "libobs" / "").string();
  obs_add_data_path(libobsData.c_str());

  return true;
}

std::vector<MonitorInfo> App::monitors() const
{
  std::vector<MonitorInfo> result = platform::listMonitors();
  if (result.empty())
    result.push_back(MonitorInfo{0, "", "Display 1", baseWidth_, baseHeight_, true});
  return result;
}

bool App::resetVideo(uint32_t captureWidth, uint32_t captureHeight)
{
  struct obs_video_info ovi = {};
  ovi.graphics_module = platform::graphicsModule();
  // obs_reset_video retains the existing graphics device. Keep the actual
  // adapter stable during canvas/output resets rather than claiming a new GPU.
  if (!graphicsAdapterSelected_) {
    graphicsAdapter_ = platform::selectGraphicsAdapter();
    graphicsAdapterSelected_ = true;
  }
  ovi.adapter = graphicsAdapter_.index;
  ovi.fps_den = 1;

  // Match the OBS canvas to the configured desktop monitor. This avoids a
  // full-frame GPU scale on multi-monitor systems with different resolutions.
  const auto displays = monitors();
  auto selected = std::find_if(displays.begin(), displays.end(),
                               [this](const MonitorInfo& display) { return display.index == config_.capture.monitor; });
  if (selected == displays.end())
    selected = std::find_if(displays.begin(), displays.end(),
                            [](const MonitorInfo& display) { return display.primary; });
  if (captureWidth && captureHeight) {
    baseWidth_ = captureWidth;
    baseHeight_ = captureHeight;
  } else if (selected != displays.end()) {
    baseWidth_ = selected->width ? selected->width : 1920;
    baseHeight_ = selected->height ? selected->height : 1080;
  }
  ovi.base_width = baseWidth_;
  ovi.base_height = baseHeight_;

  // Output size/fps follow the preset; medium/high capture at the monitor's
  // native resolution (no downscale).
  int effW = 0, effH = 0, effFps = 0, effBitrate = 0;
  EncoderManager(config_).effectiveVideoParams(baseWidth_, baseHeight_, effW, effH, effFps, effBitrate);
  ovi.output_width = effW;
  ovi.output_height = effH;
  ovi.fps_num = (uint32_t)effFps;
  ovi.fps_den = 1;

  ovi.output_format = VIDEO_FORMAT_NV12;
  ovi.gpu_conversion = true;
  ovi.colorspace = VIDEO_CS_709;
  ovi.range = VIDEO_RANGE_PARTIAL;
  ovi.scale_type = OBS_SCALE_BILINEAR;

  int ret = OBS_VIDEO_FAIL;
  {
    std::unique_lock<std::shared_mutex> lock(videoMutex_);
    ret = obs_reset_video(&ovi);
  }
  if (ret != OBS_VIDEO_SUCCESS) {
    lastError_ = "obs_reset_video failed: " + std::to_string(ret);
    return false;
  }
  return true;
}

bool App::resetAudio()
{
  struct obs_audio_info oai = {};
  oai.samples_per_sec = 48000;
  oai.speakers = SPEAKERS_STEREO;
  if (!obs_reset_audio(&oai)) {
    lastError_ = "obs_reset_audio failed";
    return false;
  }
  return true;
}

void App::shutdown()
{
  if (shutdownDone_)
    return;
  shutdownDone_ = true;
  if (!obs_initialized())
    return;

  if (scene_) {
    obs_set_output_source(0, nullptr); // release the view's ref before the scene
    obs_scene_release(scene_);
    scene_ = nullptr;
  }
  obs_shutdown();
  platform::releaseObs();
}

} // namespace shard
