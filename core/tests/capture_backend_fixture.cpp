// GPU integration fixture for the real SourceManager. Synthetic sources keep
// nonzero dimensions while the hook paints black, reproducing the failure
// without changing or injecting the official signed OBS hook payload.
#include "sources.h"
#include "video_levels.h"
#include <windows.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <vector>

namespace {
std::atomic<bool> hookContent{false};
std::atomic<bool> windowContent{false};
std::atomic<bool> hookAnimated{false};
std::atomic<bool> windowAnimated{false};
std::atomic<bool> windowSized{true};
std::atomic<int> hookCreates{0};
std::atomic<int> outputColor{0};
std::atomic<int> centerRed{-1};
gs_texture_t* hdrTexture = nullptr;
struct Source { bool hook; };
bool realCaptureProperties = false;
std::atomic<int> invalidCaptureSettings{0};
void checkSettings(obs_data_t* settings, bool hook)
{
  if (hook ? obs_data_has_user_value(settings, "force_sdr") : !obs_data_get_bool(settings, "force_sdr"))
    ++invalidCaptureSettings;
}
void pause(DWORD milliseconds)
{
  const auto deadline = GetTickCount64() + milliseconds;
  do {
    MSG message;
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    Sleep(10);
  } while (GetTickCount64() < deadline);
}
void render(void* data, gs_effect_t*)
{
  const bool hook = static_cast<Source*>(data)->hook;
  struct vec4 color = {0, 0, 0, 1};
  if (hook ? hookContent.load() : windowContent.load()) {
    if (hook) color.x = 1; else color.y = 1;
    if (hook ? hookAnimated.load() : windowAnimated.load())
      color.z = static_cast<float>((GetTickCount64() / 250) % 5) / 20.0f;
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
  info.create = hook ? +[](obs_data_t* s, obs_source_t*) -> void* {
                         checkSettings(s, true); ++hookCreates; return new Source{true}; }
                     : +[](obs_data_t* s, obs_source_t*) -> void* {
                         checkSettings(s, false); return new Source{false}; };
  info.update = [](void* p, obs_data_t* s) { checkSettings(s, static_cast<Source*>(p)->hook); };
  info.destroy = [](void* p) { delete static_cast<Source*>(p); };
  info.get_width = [](void* p) -> uint32_t {
    return static_cast<Source*>(p)->hook || windowSized.load() ? 640 : 0;
  };
  info.get_height = [](void*) -> uint32_t { return 360; };
  info.video_render = render;
  obs_register_source(&info);
}
void frame(void*, video_data* data)
{
  const uint8_t* p = data->data[0] + 36 * data->linesize[0] + 64 * 4;
  centerRed = p[0];
  outputColor = (p[0] > 200 || p[2] > 200) ? 1 : p[1] > 200 ? 2 : 0;
}
void renderHdr(void*, gs_effect_t*)
{
  if (!hdrTexture) {
    std::vector<float> pixels(128 * 72 * 4, 1.0f);
    const uint8_t* data[1] = {reinterpret_cast<const uint8_t*>(pixels.data())};
    hdrTexture = gs_texture_create(128, 72, GS_RGBA16F, 1, data, 0);
  }
  if (!hdrTexture) return;
  gs_effect_t* effect = obs_get_base_effect(OBS_EFFECT_DEFAULT);
  gs_effect_set_texture(gs_effect_get_param_by_name(effect, "image"), hdrTexture);
  while (gs_effect_loop(effect, "Draw")) gs_draw_sprite(hdrTexture, 0, 0, 0);
}
enum gs_color_space hdrColorSpace(void*, size_t, const enum gs_color_space*)
{
  return GS_CS_709_SCRGB;
}
void registerHdrSource()
{
  obs_source_info info = {};
  info.id = "hdr_capture_fixture";
  info.type = OBS_SOURCE_TYPE_INPUT;
  info.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW;
  info.get_name = [](void*) { return "HDR tonemap fixture"; };
  info.create = [](obs_data_t*, obs_source_t*) -> void* { return new Source{false}; };
  info.destroy = [](void* p) { delete static_cast<Source*>(p); };
  info.get_width = [](void*) -> uint32_t { return 128; };
  info.get_height = [](void*) -> uint32_t { return 72; };
  info.video_render = renderHdr;
  info.video_get_color_space = hdrColorSpace;
  obs_register_source(&info);
}
bool waitColor(int expected, int seconds)
{
  for (int i = 0; i < seconds * 10; ++i) {
    if (outputColor == expected) return true;
    pause(100);
  }
  return false;
}
void require(bool value, const char* description);
void testHdrTonemap(shard::App& app)
{
  require(obs_get_video_sdr_white_level() == shard::kSdrWhiteLevelNits,
          "SDR white level is initialized for HDR tonemapping");
  require(obs_get_video_hdr_nominal_peak_level() == shard::kHdrNominalPeakLevelNits,
          "HDR nominal peak is initialized for HDR tonemapping");
  obs_scene_t* scene = obs_scene_create("hdr-fixture");
  require(scene != nullptr, "create HDR fixture scene");
  obs_set_output_source(0, obs_scene_get_source(scene));
  obs_source_t* source = obs_source_create("hdr_capture_fixture", "hdr-capture", nullptr, nullptr);
  require(source != nullptr, "create HDR fixture source");
  obs_sceneitem_t* item = obs_scene_add(scene, source);
  obs_source_release(source);
  require(item != nullptr, "add HDR fixture item");
  obs_sceneitem_crop crop = {};
  crop.right = 1; // Force the intermediate color-managed item texture.
  obs_sceneitem_set_crop(item, &crop);
  centerRed = -1;
  obs_add_raw_video_callback(nullptr, frame, nullptr);
  for (int i = 0; i < 30 && centerRed < 0; ++i) pause(100);
  obs_remove_raw_video_callback(frame, nullptr);
  require(centerRed >= 30 && centerRed <= 220,
          "scRGB HDR source is tone-mapped into the SDR canvas instead of saturating");
  obs_set_output_source(0, obs_scene_get_source(app.scene()));
  obs_scene_release(scene);
  obs_enter_graphics();
  gs_texture_destroy(hdrTexture);
  hdrTexture = nullptr;
  obs_leave_graphics();
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
// Exercise the real SourceManager paths without waiting minutes for outage
// escalation. The synthetic sources also inspect every create/update payload.
struct SourceManagerCaptureTestAccess {
  static void requireSdr(obs_source_t* source) {
    require(source != nullptr, "WGC source exists");
    auto* settings = obs_source_get_settings(source);
    require(obs_data_get_bool(settings, "force_sdr"), "WGC requests an SDR surface");
    obs_data_release(settings);
  }
  static void windowLifecycle(SourceManager& sources) {
    std::lock_guard<std::mutex> lock(sources.sourceMutex_);
    requireSdr(sources.windowSource_);
    // A retry must reassert the product constraint even if stored state drifts.
    auto* settings = obs_source_get_settings(sources.windowSource_);
    obs_data_set_bool(settings, "force_sdr", false);
    obs_data_release(settings);
    sources.retryWindowCaptureLocked();
    requireSdr(sources.windowSource_);
    sources.recreateWindowCaptureLocked();
    requireSdr(sources.windowSource_);
  }
  static void windowMonitor(SourceManager& sources, HWND window) {
    std::lock_guard<std::mutex> lock(sources.sourceMutex_);
    sources.refreshCaptureDisplayLocked(duration_ms_now());
    require(sources.captureDisplay_.monitor == reinterpret_cast<uintptr_t>(
                MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST)),
            "display diagnostics select the live target HWND monitor");
    const std::string diagnostics = sources.colorDiagnosticsLocked();
    require(diagnostics.find("wgc_force_sdr=true") != std::string::npos &&
                diagnostics.find("hook_rgb10a2_space=srgb") != std::string::npos &&
                diagnostics.find("output_color_space=Rec709/SDR") != std::string::npos,
            "display diagnostics report actual SDR settings");
  }
  static void monitorRetry(SourceManager& sources) {
    std::lock_guard<std::mutex> lock(sources.sourceMutex_);
    requireSdr(sources.monitorSource_);
    auto* settings = obs_source_get_settings(sources.monitorSource_);
    obs_data_set_bool(settings, "force_sdr", false);
    obs_data_release(settings);
    sources.retryMonitorCaptureLocked();
    requireSdr(sources.monitorSource_);
  }
  static void hdrHookColorSpace(SourceManager& sources) {
    std::lock_guard<std::mutex> lock(sources.sourceMutex_);
    const auto space = [&] {
      auto* settings = obs_source_get_settings(sources.gameSource_);
      const std::string value = settings ? obs_data_get_string(settings, "rgb10a2_space") : "";
      obs_data_release(settings);
      return value;
    };
    require(space() == "srgb", "Game Capture starts in the SDR 10-bit color space");
    sources.captureDisplay_.hdr = true;
    sources.applyHookColorSpaceLocked();
    require(space() == "2100pq", "HDR displays promote 10-bit Game Capture to Rec.2100 PQ");
    sources.captureDisplay_.hdr = false;
    sources.applyHookColorSpaceLocked();
    require(space() == "srgb", "returning to SDR restores the sRGB 10-bit hint");
  }
};

App::App(Config& config, Events& events) : config_(config), events_(events) {}
App::~App() { shutdown(); }
bool App::init()
{
  if (realCaptureProperties && !AddDllDirectory(std::filesystem::u8path(config_.coreBinDir).c_str())) return false;
  const auto moduleConfig = std::filesystem::temp_directory_path() /
      ("shard-wgc-properties-" + std::to_string(GetCurrentProcessId()));
  const std::string moduleConfigString = moduleConfig.string();
  if (realCaptureProperties) std::filesystem::create_directories(moduleConfig);
  if (!obs_startup("en-US", realCaptureProperties ? moduleConfigString.c_str() : nullptr, nullptr)) return false;
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
  applyVideoColorLevels();
  if (realCaptureProperties) {
    obs_add_module_path((config_.coreBinDir + "/obs-plugins/64bit").c_str(),
                        (config_.coreBinDir + "/data/obs-plugins/%module%").c_str());
    obs_load_all_modules();
    obs_post_load_modules();
  } else {
    registerSource("game_capture", true);
    registerSource("window_capture", false);
    registerSource("monitor_capture", false);
    registerHdrSource();
  }
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
  if (obs_reset_video(&info) != OBS_VIDEO_SUCCESS) return false;
  applyVideoColorLevels();
  return true;
}
}

int main(int argc, char** argv)
{
  if (argc != 2 && argc != 3) return 2;
  realCaptureProperties = argc == 3 && std::string(argv[2]) == "--check-wgc-properties";
  shard::Config config;
  config.coreBinDir = argv[1];
  config.capture.mode = "game";
  shard::Events events;
  shard::App app(config, events);
  require(app.init(), "initialize D3D11 fixture");
  if (realCaptureProperties) {
    // Validate the installed/staged win-capture module, not only vendored code.
    for (const char* id : {"window_capture", "monitor_capture"}) {
      auto* properties = obs_get_source_properties(id);
      auto* property = properties ? obs_properties_get(properties, "force_sdr") : nullptr;
      require(property && obs_property_get_type(property) == OBS_PROPERTY_BOOL,
              "staged WGC source exposes boolean force_sdr");
      obs_properties_destroy(properties);
    }
    shard::SourceManager sources(app, config, events);
    sources.applyVideoSource();
    auto* window = obs_get_source_by_name("game-window");
    auto* monitor = obs_get_source_by_name("monitor-capture");
    shard::SourceManagerCaptureTestAccess::requireSdr(window);
    shard::SourceManagerCaptureTestAccess::requireSdr(monitor);
    obs_source_release(window);
    obs_source_release(monitor);
    std::puts("PASS: staged OBS WGC SDR properties");
    return 0;
  }
  // A real non-minimized target is needed to exercise the production recovery
  // eligibility gate; the controlled textures still avoid any hook injection.
  WNDCLASSW wc{};
  wc.lpfnWndProc = DefWindowProcW;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"ShardCaptureRecoveryFixture";
  require(RegisterClassW(&wc) != 0, "register recovery target window");
  HWND target = CreateWindowExW(WS_EX_NOACTIVATE, wc.lpszClassName, L"Shard capture fixture",
                                WS_POPUP | WS_VISIBLE, 0, 0, 640, 360, nullptr, nullptr, wc.hInstance, nullptr);
  require(target != nullptr, "create live recovery target window");
  {
    shard::SourceManager sources(app, config, events);
    sources.applyVideoSource();
    sources.setGameSubject("cs2.exe", "Synthetic CS2", "Shard capture fixture",
                           "ShardCaptureRecoveryFixture", GetCurrentProcessId());
    shard::SourceManagerCaptureTestAccess::windowLifecycle(sources);
    shard::SourceManagerCaptureTestAccess::hdrHookColorSpace(sources);
    // A title-only change keeps the live target; a complete video-source
    // rebuild retargets it. Both must leave SDR asserted.
    sources.setGameSubject("cs2.exe", "Synthetic CS2", "Retarget fixture",
                           "ShardCaptureRecoveryFixture", GetCurrentProcessId());
    shard::SourceManagerCaptureTestAccess::windowLifecycle(sources);
    sources.applyVideoSource();
    shard::SourceManagerCaptureTestAccess::windowLifecycle(sources);
    config.capture.mode = "screen";
    sources.applyVideoSource();
    shard::SourceManagerCaptureTestAccess::monitorRetry(sources);
    sources.applyVideoSource();
    shard::SourceManagerCaptureTestAccess::monitorRetry(sources);
  }
  config.capture.mode = "game";
  hookCreates = 0;
  require(invalidCaptureSettings == 0, "all WGC lifecycle payloads force SDR and hook payloads are unchanged");
  {
    shard::SourceManager sources(app, config, events);
    sources.applyVideoSource();
    sources.setGameSubject("cs2.exe", "Synthetic CS2", "Shard capture fixture",
                           "ShardCaptureRecoveryFixture", GetCurrentProcessId());
    shard::SourceManagerCaptureTestAccess::windowMonitor(sources, target);
    sources.startWatchdog();
    obs_add_raw_video_callback(nullptr, frame, nullptr);
    pause(4500);
    require(outputColor == 0 && hookCreates == 1, "both-black loading screen does not trigger recovery");
    windowContent = true;
    windowAnimated = true;
    require(waitColor(2, 7), "nonzero-sized black hook gives way to actual WGC output");
    // Keep the hook broken long enough to exercise recreation, not just order.
    const auto deadline = GetTickCount64() + 18000;
    while (hookCreates == 1 && GetTickCount64() < deadline) pause(100);
    require(hookCreates > 1, "black acquired hook is recreated without restarting the app");
    require(waitColor(2, 2), "WGC stays on top after hook recreation");
    hookContent = true;
    require(waitColor(1, 7), "recovered hook becomes visible after sustained good samples");
    require(waitColor(2, 38), "content-but-frozen hook yields to changing WGC");
    windowAnimated = false;
    const int frozenCreates = hookCreates.load();
    pause(17000);
    require(outputColor == 2 && hookCreates == frozenCreates,
            "static fallback after a proven freeze does not repeatedly recreate the hook");
    windowAnimated = true;
    hookAnimated = true;
    require(waitColor(1, 7), "fingerprint movement restores the recovered hook");
    const int healthyCreates = hookCreates.load();
    windowSized = false;
    pause(4000);
    require(outputColor == 1 && hookCreates == healthyCreates,
            "missing WGC dimensions do not discard healthy hook observations");
    windowSized = true;
    pause(1500);
    obs_set_output_source(0, nullptr);
    require(waitColor(0, 3), "unbound composed video is black while source pixels exist");
    require(waitColor(1, 23), "downstream black scene is repaired by rebinding the output");
    require(hookCreates == healthyCreates, "composition recovery preserves the healthy hook");
    hookAnimated = windowAnimated = false;
    pause(5000);
    require(outputColor == 1 && hookCreates == healthyCreates, "static healthy content preserves capture");
    obs_remove_raw_video_callback(frame, nullptr);
    sources.stopWatchdog();
  }
  require(invalidCaptureSettings == 0, "watchdog recovery preserves SDR WGC settings");
  testHdrTonemap(app);
  DestroyWindow(target);
  std::puts("PASS: capture backend GPU integration");
}
