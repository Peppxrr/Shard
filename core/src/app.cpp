#include "app.h"

#include "encoders.h"

#include <obs-module.h>

#include <filesystem>

#ifdef _WIN32
#include <windows.h>
#endif

namespace clipforge {

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

  if (!startup())
    return false;
  if (!resetVideo())
    return false;
  if (!resetAudio())
    return false;

  // Load plugins after the graphics device exists: win-capture decides WGC
  // support at module load via gs_get_device_type() == D3D11, and without a
  // context it falls back to BitBlt (black captures for GPU-rendered windows).
  obs_load_all_modules();

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

  if (!obs_startup("en-US", config_.configDir.c_str(), nullptr)) {
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
  std::string libobsData = (fs::path(config_.coreBinDir) / "data" / "libobs").string();
  obs_add_data_path(libobsData.c_str());

  return true;
}

bool App::resetVideo()
{
  struct obs_video_info ovi = {};
  ovi.graphics_module = "libobs-d3d11";
  ovi.adapter = 0;
  ovi.fps_den = 1;

  // Base resolution = primary display, so monitor_capture and game capture
  // never scale on the way in; the output resolution is the recorded one.
#ifdef _WIN32
  DEVMODEW dm = {};
  dm.dmSize = sizeof(dm);
  if (EnumDisplaySettingsW(nullptr, ENUM_CURRENT_SETTINGS, &dm)) {
    baseWidth_ = dm.dmPelsWidth ? dm.dmPelsWidth : 1920;
    baseHeight_ = dm.dmPelsHeight ? dm.dmPelsHeight : 1080;
  }
#endif
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

  int ret = obs_reset_video(&ovi);
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
}

} // namespace clipforge
