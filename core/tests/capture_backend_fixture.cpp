// GPU integration fixture for the real SourceManager. Synthetic sources keep
// nonzero dimensions while the hook paints black, reproducing the failure
// without changing or injecting the official signed OBS hook payload.
#include "sources.h"
#include <windows.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>

namespace {
std::atomic<bool> hookContent{false};
std::atomic<bool> windowContent{false};
std::atomic<int> hookCreates{0};
std::atomic<int> outputColor{0};
struct Source { bool hook; };
void render(void* data, gs_effect_t*)
{
  const bool hook = static_cast<Source*>(data)->hook;
  struct vec4 color = {0, 0, 0, 1};
  if (hook ? hookContent.load() : windowContent.load()) {
    if (hook) color.x = 1; else color.y = 1;
  }
  auto* effect = obs_get_base_effect(OBS_EFFECT_SOLID);
  gs_effect_set_vec4(gs_effect_get_param_by_name(effect, "color"), &color);
  while (gs_effect_loop(effect, "Solid")) gs_draw_sprite(nullptr, 0, 640, 360);
}
void registerSource(const char* id, bool hook)
{
  obs_source_info info = {};
  info.id = id;
  info.type = OBS_SOURCE_TYPE_INPUT;
  info.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW;
  info.get_name = [](void*) { return "Capture recovery fixture"; };
  info.create = hook ? +[](obs_data_t*, obs_source_t*) -> void* { ++hookCreates; return new Source{true}; }
                     : +[](obs_data_t*, obs_source_t*) -> void* { return new Source{false}; };
  info.destroy = [](void* p) { delete static_cast<Source*>(p); };
  info.get_width = [](void*) -> uint32_t { return 640; };
  info.get_height = [](void*) -> uint32_t { return 360; };
  info.video_render = render;
  obs_register_source(&info);
}
void frame(void*, video_data* data)
{
  const uint8_t* p = data->data[0] + 36 * data->linesize[0] + 64 * 4;
  outputColor = (p[0] > 200 || p[2] > 200) ? 1 : p[1] > 200 ? 2 : 0;
}
bool waitColor(int expected, int seconds)
{
  for (int i = 0; i < seconds * 10; ++i) {
    if (outputColor == expected) return true;
    Sleep(100);
  }
  return false;
}
void require(bool value, const char* description)
{
  if (!value) { std::fprintf(stderr, "FAIL: %s\n", description); std::exit(1); }
  std::printf("PASS: %s\n", description);
}
}

// Test-only App bootstrap: use real libobs/D3D11 and the production source
// manager, but register controlled sources instead of loading capture modules.
namespace shard {
App::App(Config& config, Events& events) : config_(config), events_(events) {}
App::~App() { shutdown(); }
bool App::init()
{
  if (!obs_startup("en-US", nullptr, nullptr)) return false;
  obs_add_data_path((config_.coreBinDir + "/data/libobs/").c_str());
  obs_video_info info = {};
  const std::string graphicsModule = config_.coreBinDir + "/libobs-d3d11.dll";
  info.graphics_module = graphicsModule.c_str();
  info.fps_num = 30; info.fps_den = 1;
  info.base_width = info.output_width = baseWidth_ = 128;
  info.base_height = info.output_height = baseHeight_ = 72;
  info.output_format = VIDEO_FORMAT_RGBA;
  info.colorspace = VIDEO_CS_709;
  info.range = VIDEO_RANGE_FULL;
  if (obs_reset_video(&info) != OBS_VIDEO_SUCCESS) return false;
  registerSource("game_capture", true);
  registerSource("window_capture", false);
  registerSource("monitor_capture", false);
  scene_ = obs_scene_create("fixture");
  obs_set_output_source(0, obs_scene_get_source(scene_));
  return true;
}
void App::shutdown()
{
  if (shutdownDone_) return;
  shutdownDone_ = true;
  obs_set_output_source(0, nullptr);
  if (scene_) obs_scene_release(scene_);
  obs_shutdown();
}
std::vector<MonitorInfo> App::monitors() const { return {}; }
bool App::resetVideo(uint32_t width, uint32_t height)
{
  obs_video_info info = {};
  obs_get_video_info(&info);
  info.base_width = info.output_width = baseWidth_ = width;
  info.base_height = info.output_height = baseHeight_ = height;
  return obs_reset_video(&info) == OBS_VIDEO_SUCCESS;
}
}

int main(int argc, char** argv)
{
  if (argc != 2) return 2;
  shard::Config config;
  config.coreBinDir = argv[1];
  config.capture.mode = "game";
  shard::Events events;
  shard::App app(config, events);
  require(app.init(), "initialize D3D11 fixture");
  {
    shard::SourceManager sources(app, config, events);
    sources.applyVideoSource();
    sources.setGameSubject("cs2.exe", "Synthetic CS2", "", "", GetCurrentProcessId());
    sources.startWatchdog();
    obs_add_raw_video_callback(nullptr, frame, nullptr);
    Sleep(4500);
    require(outputColor == 0 && hookCreates == 1, "both-black loading screen does not trigger recovery");
    windowContent = true;
    require(waitColor(2, 7), "nonzero-sized black hook gives way to actual WGC output");
    // Keep the hook broken long enough to exercise recreation, not just order.
    const auto deadline = GetTickCount64() + 18000;
    while (hookCreates == 1 && GetTickCount64() < deadline) Sleep(100);
    require(hookCreates > 1, "black acquired hook is recreated without restarting the app");
    require(waitColor(2, 2), "WGC stays on top after hook recreation");
    hookContent = true;
    require(waitColor(1, 7), "recovered hook becomes visible after sustained good samples");
    obs_remove_raw_video_callback(frame, nullptr);
    sources.stopWatchdog();
  }
  std::puts("PASS: capture backend GPU integration");
}
