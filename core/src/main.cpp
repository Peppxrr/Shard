// Shard core: embeds OBS's libobs and exposes capture, replay ring,
// recording, game detection, and a JSON-RPC WebSocket server.
//
// Version string lives here (placeholder rename point, see README).

#include "app.h"
#include "config.h"
#include "encoders.h"
#include "game_system.h"
#include "log.h"
#include "perf_monitor.h"
#include "system_info.h"
#include "recorder.h"
#include "replay_ring.h"
#include "jsonrpc.h"
#include "platform/platform.h"
#include "platform/global_shortcuts.h"
#include "platform/window_system.h"
#include "server.h"
#include "sources.h"

#include <obs.h>
#include <util/platform.h>
#include <util/base.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

namespace shard {

namespace fs = std::filesystem;

using namespace std::chrono;

namespace {

struct LogSession {
  LogSession() { logStart(); }
  ~LogSession() { logStop(); }
};

struct CliOptions {
  std::string configDir;
  std::string coreBinDir;
  int port = 0;
  bool selftest = false;
  std::string selftestOut;
  std::string gamesPath;
  // "task" when the Recording priority scheduled task launched this core.
  std::string launchMode = "normal";
};

CliOptions parseArgs(int argc, char** argv)
{
  CliOptions o;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    auto need = [&](const char* name) -> std::string {
      if (i + 1 >= argc) {
        logFormat("missing value for %s", name);
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
    else if (a == "--launch-mode")
      o.launchMode = need("--launch-mode") == "task" ? "task" : "normal";
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
    logFormat("selftest: error %s: %s", params.value("code", std::string()).c_str(),
                 params.value("message", std::string()).c_str());
  }
}

int runSelftest(CliOptions& opt, Config& config, Events& events, App& app, SourceManager& sources,
                EncoderManager& encoders, ReplayRing& ring, PerfMonitor& perf)
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
  perf.start();

  if (!ring.start()) {
    logLine("SELFTEST {\"ok\":false,\"reason\":\"ring start failed\"}");
    sources.stopWatchdog();
    return 1;
  }

  // Warm the ring for 10 s.
  logLine("selftest: warming ring 10 s...");
  std::this_thread::sleep_for(seconds(10));

  ring.save(3);

  // Wait up to 30 s for the mux to complete.
  auto deadline = steady_clock::now() + seconds(30);
  while (!st.done.load() && steady_clock::now() < deadline)
    std::this_thread::sleep_for(milliseconds(100));

  if (!st.done.load() || !st.ok) {
    logLine("SELFTEST {\"ok\":false,\"reason\":\"no clip.saved within timeout\"}");
    sources.stopWatchdog();
    ring.stop();
    return 1;
  }

  std::printf("SELFTEST {\"ok\":true,\"path\":\"%s\",\"durationSec\":%.2f}\n", st.path.c_str(), st.actualSec);
  std::fflush(stdout);

  // Order matters: stop the watchdog before the ring so the capture-activity
  // callback can never touch the ring during teardown, then release sources
  // before obs_shutdown.
  perf.stop();
  sources.stopWatchdog();
  ring.stop();
  sources.releaseAll();
  app.shutdown();
  return 0;
}

} // namespace

int main(int argc, char** argv)
{
  // Before logging/OBS: Windows DPI awareness (WGC) and elevated DLL search
  // hardening; Linux parent-death and termination signals.
  platform::initCoreProcess();
  // Asynchronous diagnostic log: libobs threads only enqueue, so a slow
  // stderr reader can never stall rendering, audio or encoding. Keeps all OBS
  // levels and long messages while stdout carries only the PORT handshake.
  LogSession logSession;
  base_set_log_handler(logObs, nullptr);
  CliOptions opt = parseArgs(argc, argv);
  if (opt.configDir.empty()) {
    logLine("shardcore: --config-dir is required");
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
    logFormat("shardcore: %s", app.lastError().c_str());
    return 2;
  }
  platform::startWindowSystem();
  // Pairs every early return (selftest, exit 3/4); the normal path also stops
  // it explicitly right after games.stop(). stopWindowSystem is idempotent.
  struct WindowSystemGuard {
    ~WindowSystemGuard() { platform::stopWindowSystem(); }
  } windowSystemGuard;

  EncoderManager encoders(config);
  const std::string preferredEncoder = encoders.resolveVideoEncoderId(config.video.encoder);
  logFormat("[startup][info] capture_mode=%s encoder_requested=%s encoder_preferred=%s video_preset=%s"
            " fps=%d bitrate_kbps=%d replay_max_seconds=%d replay_max_mb=%d launch=%s",
            config.capture.mode.c_str(), config.video.encoder.c_str(), preferredEncoder.c_str(),
            config.video.preset.c_str(), config.video.fps, encoders.effectiveBitrateKbps(),
            config.replay.maxSeconds, config.replay.maxMb, opt.launchMode.c_str());
  SourceManager sources(app, config, events);
  ReplayRing ring(app, config, events, encoders);
  Recorder recorder(app, config, events, encoders);
  GameSystem games(config, events, sources, recorder);
  // Declared after its users so it is destroyed (and its sampler joined)
  // before them on early returns.
  PerfMonitor perf(app, config, events, sources);
  perf.setLaunchMode(opt.launchMode);
  ring.setPerfMonitor(&perf);
  recorder.setPerfMonitor(&perf);

  // Buffer only while something is being captured; the watchdog's activity
  // signal drives the ring's start/stop lifecycle using the configured grace.
  sources.setCaptureActivityCb([&ring](bool active) { ring.setCaptureActive(active); });

  if (opt.selftest)
    return runSelftest(opt, config, events, app, sources, encoders, ring, perf);

  sources.applyVideoSource();
  sources.applyAudioSources();
  perf.start();

  // Game-only startup has no subject until a game is detected. Avoid showing
  // a briefly counting buffer of empty video before the first real capture.
  if (sources.subject().kind != SourceManager::Subject::Kind::None && !ring.start()) {
    logLine("shardcore: replay ring failed to start");
    return 3;
  }
  sources.startWatchdog();

  Rpc rpc(app, config, events, sources, encoders, ring, recorder, games, perf);
  Server server(config, rpc);

  // Route core events to all connected RPC clients. A single process-wide
  // server pointer suffices (one core process, one server).
  static Server* g_server = nullptr;
  events.sink = [](void*, const char* type, const nlohmann::json& params) {
    if (g_server)
      g_server->broadcast(type, params);
  };
  g_server = &server;

  // Desktop global shortcuts (Linux KDE); bound by the app via hotkeys.bind.
  platform::startGlobalShortcuts([&events](const std::string& id) { events.emit("hotkey.pressed", {{"id", id}}); });
  struct GlobalShortcutsGuard {
    ~GlobalShortcutsGuard() { platform::stopGlobalShortcuts(); }
  } globalShortcutsGuard;

  if (!server.start()) {
    logLine("shardcore: failed to start RPC server");
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

  // Run until the app (or the OS) asks for shutdown.
  while (!rpc.shutdownRequested() && !platform::terminationRequested()) {
    rpc.updateCaptureGeometry();
    std::this_thread::sleep_for(milliseconds(100));
  }

  // Ordered shutdown.
  logLine("shardcore: shutdown requested");
  games.stop();
  platform::stopWindowSystem();
  platform::stopGlobalShortcuts();
  statsRun.store(false);
  statsThread.join();
  recorder.prepareVideoReset();
  perf.stop();
  // Stop the watchdog before the ring so its capture-activity callback can
  // never touch the ring during teardown.
  sources.stopWatchdog();
  ring.stop();
  sources.releaseAll();
  server.stop();
  app.shutdown();
  return 0;
}

} // namespace shard

int main(int argc, char** argv)
{
  // Platform-only modes that replace the core (Windows: Recording priority
  // helpers and the process-tree supervisor parent).
  if (const auto code = shard::platform::runPreCoreEntry(argc, argv))
    return *code;
  return shard::main(argc, argv);
}
