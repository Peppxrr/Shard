// ClipForge core: embeds OBS's libobs and exposes capture, replay ring,
// recording, game detection, and a JSON-RPC WebSocket server.
//
// Version string lives here (placeholder rename point, see README).

#include "app.h"
#include "config.h"
#include "encoders.h"
#include "game_system.h"
#include "recorder.h"
#include "replay_ring.h"
#include "jsonrpc.h"
#include "server.h"
#include "sources.h"

#include <obs.h>
#include <util/platform.h>
#include <util/base.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <thread>

namespace clipforge {

namespace fs = std::filesystem;

using namespace std::chrono;

namespace {

// The process must be DPI-aware for WGC window capture to work: from an
// unaware process on a scaled monitor, GetClientRect returns the *virtualized*
// (logical) client size while the WGC frame surface is physical, so the
// captured texture comes out 1/scale too small and the fit transform upscales
// it — window capture looks "zoomed in". Desktop (monitor) capture is
// unaffected because it has no per-window DPI involvement. OBS Studio ships
// DPI-aware; the core (no manifest) must opt in at startup, before any
// window is created. Per-monitor-aware-v2 (physical pixels on every monitor),
// falling back to system-aware on older systems.
void setProcessDpiAware()
{
#ifdef _WIN32
  typedef BOOL(WINAPI * PFN_SetProcessDpiAwarenessContext)(HANDLE);
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (user32) {
    PFN_SetProcessDpiAwarenessContext setCtx =
        (PFN_SetProcessDpiAwarenessContext)GetProcAddress(user32, "SetProcessDpiAwarenessContext");
    if (setCtx && setCtx((HANDLE)-4)) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
      return;
  }
  SetProcessDPIAware();
#endif
}

void gameCaptureDiagnosticLog(int, const char* format, va_list args, void*)
{
  char message[4096];
  const int written = std::vsnprintf(message, sizeof(message), format, args);
  if (written > 0 && std::strstr(message, "[GC]")) {
    std::fprintf(stderr, "%s\n", message);
    std::fflush(stderr);
  }
}

bool gameCaptureDiagnosticsEnabled()
{
  const char* value = std::getenv("SHARD_GAME_CAPTURE_DIAGNOSTICS");
  return value && *value && std::strcmp(value, "0") != 0;
}

struct CliOptions {
  std::string configDir;
  std::string coreBinDir;
  int port = 0;
  bool selftest = false;
  std::string selftestOut;
  std::string gamesPath;
};

CliOptions parseArgs(int argc, char** argv)
{
  CliOptions o;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    auto need = [&](const char* name) -> std::string {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "missing value for %s\n", name);
        std::exit(2);
      }
      return argv[++i];
    };
    if (a == "--config-dir")
      o.configDir = need("--config-dir");
    else if (a == "--core-bin")
      o.coreBinDir = need("--core-bin");
    else if (a == "--port")
      o.port = std::atoi(need("--port").c_str());
    else if (a == "--games")
      o.gamesPath = need("--games");
    else if (a == "--selftest")
      o.selftest = true;
    else if (a == "--out")
      o.selftestOut = need("--out");
    else if (a == "--help" || a == "-h") {
      std::printf(
          "shardcore [--config-dir <dir>] [--core-bin <dir>] [--port <n>] [--games <games.json>] [--selftest --out "
          "<dir>]\n");
      std::exit(0);
    }
  }
  return o;
}

std::string executableDir(const std::string& argv0)
{
  fs::path p = fs::absolute(argv0);
  return p.parent_path().string();
}

struct SelftestState {
  std::atomic<bool> done{false};
  bool ok = false;
  std::string path;
  double actualSec = 0;
};

void selftestSink(void* ctx, const char* type, const nlohmann::json& params)
{
  auto* st = static_cast<SelftestState*>(ctx);
  if (std::strcmp(type, "clip.saved") == 0) {
    st->path = params.value("path", std::string());
    st->actualSec = params.value("actualSec", 0.0);
    st->ok = !st->path.empty();
    st->done.store(true);
  } else if (std::strcmp(type, "error") == 0) {
    std::fprintf(stderr, "selftest: error %s: %s\n", params.value("code", std::string()).c_str(),
                 params.value("message", std::string()).c_str());
  }
}

int runSelftest(CliOptions& opt, Config& config, Events& events, App& app, SourceManager& sources,
                EncoderManager& encoders, ReplayRing& ring)
{
  SelftestState st;
  events.sinkCtx = &st;
  events.sink = selftestSink;

  // Deterministic: WGC monitor capture of the primary display.
  config.capture.mode = "screen";
  config.capture.monitor = 0;
  if (!opt.selftestOut.empty()) {
    fs::create_directories(opt.selftestOut);
    config.clipsDir = opt.selftestOut;
  }

  sources.applyVideoSource();
  sources.applyAudioSources();
  sources.startWatchdog();

  if (!ring.start()) {
    std::fprintf(stderr, "SELFTEST {\"ok\":false,\"reason\":\"ring start failed\"}\n");
    sources.stopWatchdog();
    return 1;
  }

  // Warm the ring for 10 s.
  std::fprintf(stderr, "selftest: warming ring 10 s...\n");
  std::this_thread::sleep_for(seconds(10));

  ring.save(3);

  // Wait up to 30 s for the mux to complete.
  auto deadline = steady_clock::now() + seconds(30);
  while (!st.done.load() && steady_clock::now() < deadline)
    std::this_thread::sleep_for(milliseconds(100));

  if (!st.done.load() || !st.ok) {
    std::fprintf(stderr, "SELFTEST {\"ok\":false,\"reason\":\"no clip.saved within timeout\"}\n");
    sources.stopWatchdog();
    ring.stop();
    return 1;
  }

  std::printf("SELFTEST {\"ok\":true,\"path\":\"%s\",\"durationSec\":%.2f}\n", st.path.c_str(), st.actualSec);
  std::fflush(stdout);

  // Order matters: stop the watchdog before the ring so the capture-activity
  // callback can never touch the ring during teardown, then release sources
  // before obs_shutdown.
  sources.stopWatchdog();
  ring.stop();
  sources.releaseAll();
  app.shutdown();
  return 0;
}

} // namespace

int main(int argc, char** argv)
{
  setProcessDpiAware(); // before any window/obs_startup: WGC needs DPI awareness
  CliOptions opt = parseArgs(argc, argv);
  if (gameCaptureDiagnosticsEnabled())
    base_set_log_handler(gameCaptureDiagnosticLog, nullptr);
  if (opt.configDir.empty()) {
    std::fprintf(stderr, "shardcore: --config-dir is required\n");
    return 2;
  }
  if (opt.coreBinDir.empty())
    opt.coreBinDir = executableDir(argv[0]);

  Config config = Config::load(opt.configDir, opt.coreBinDir);
  config.port = opt.port;
  if (!opt.gamesPath.empty())
    config.game.gamesPath = opt.gamesPath;

  // libobs resolves its core data ("default.effect" etc.) via
  // "../../data/libobs" relative to the process CWD (see obs-windows.c).
  // Mirror OBS's layout: run from <coreBin>/obs-plugins/64bit so that path
  // lands on <coreBin>/data/libobs.
  {
    fs::path bin64 = fs::path(opt.coreBinDir) / "obs-plugins" / "64bit";
    if (fs::exists(bin64))
      os_chdir(bin64.string().c_str());
  }

  Events events;
  App app(config, events);
  if (!app.init()) {
    std::fprintf(stderr, "shardcore: %s\n", app.lastError().c_str());
    return 2;
  }

  EncoderManager encoders(config);
  SourceManager sources(app, config, events);
  ReplayRing ring(app, config, events, encoders);
  Recorder recorder(app, config, events, encoders);
  GameSystem games(config, events, sources, recorder);

  // Buffer only while something is being captured; the watchdog's activity
  // signal drives the ring's start/stop (15 s grace) lifecycle.
  sources.setCaptureActivityCb([&ring](bool active) { ring.setCaptureActive(active); });

  if (opt.selftest)
    return runSelftest(opt, config, events, app, sources, encoders, ring);

  sources.applyVideoSource();
  sources.applyAudioSources();
  sources.startWatchdog();

  if (!ring.start()) {
    std::fprintf(stderr, "shardcore: replay ring failed to start\n");
    sources.stopWatchdog();
    return 3;
  }

  Rpc rpc(app, config, events, sources, encoders, ring, recorder, games);
  Server server(config, rpc);

  // Route core events to all connected RPC clients. A single process-wide
  // server pointer suffices (one core process, one server).
  static Server* g_server = nullptr;
  events.sink = [](void*, const char* type, const nlohmann::json& params) {
    if (g_server)
      g_server->broadcast(type, params);
  };
  g_server = &server;

  if (!server.start()) {
    std::fprintf(stderr, "shardcore: failed to start RPC server\n");
    sources.stopWatchdog();
    return 4;
  }

  // ring.stats throttled to 1/s.
  std::atomic<bool> statsRun{true};
  std::thread statsThread([&] {
    while (statsRun.load()) {
      std::this_thread::sleep_for(seconds(1));
      int secs = 0;
      double mb = 0;
      ring.getStats(secs, mb);
      events.emit("ring.stats", {{"secondsBuffered", secs}, {"mbUsed", mb}});
    }
  });

  games.start();

  // Run until the app asks for shutdown.
  while (!rpc.shutdownRequested())
    std::this_thread::sleep_for(milliseconds(100));

  // Ordered shutdown.
  std::fprintf(stderr, "shardcore: shutdown requested\n");
  games.stop();
  statsRun.store(false);
  statsThread.join();
  recorder.stopAndWait();
  // Stop the watchdog before the ring so its capture-activity callback can
  // never touch the ring during teardown.
  sources.stopWatchdog();
  ring.stop();
  sources.releaseAll();
  server.stop();
  app.shutdown();
  return 0;
}

} // namespace clipforge

int main(int argc, char** argv)
{
  return clipforge::main(argc, argv);
}
