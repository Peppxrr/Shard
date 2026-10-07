#include "jsonrpc.h"

#include "log.h"

#include <algorithm>
#include <atomic>

namespace shard {

namespace {

// Canvas ownership follows the visible subject identity. A game keeps its
// identity across session PID changes; switching games or desktop <-> game
// does not.
std::string captureSubjectKey(const SourceManager::Subject& subject)
{
  switch (subject.kind) {
    case SourceManager::Subject::Kind::Monitor: return "monitor";
    case SourceManager::Subject::Kind::Window: return "game:" + subject.name;
    default: return {};
  }
}

} // namespace

Rpc::Rpc(App& app, Config& config, Events& events, SourceManager& sources, EncoderManager& encoders,
         ReplayRing& ring, Recorder& recorder, GameSystem& games, PerfMonitor& perf)
    : app_(app), config_(config), events_(events), sources_(sources), encoders_(encoders), ring_(ring),
      recorder_(recorder), games_(games), perf_(perf)
{
}

nlohmann::json Rpc::buildState() const
{
  std::lock_guard<std::recursive_mutex> lock(dispatchMutex_);
  int secs = 0;
  double mb = 0;
  ring_.getStats(secs, mb);

  const auto subj = sources_.subject();
  nlohmann::json subject = {{"kind", "none"}, {"name", nullptr}};
  if (subj.kind == SourceManager::Subject::Kind::Monitor) {
    subject = {{"kind", "monitor"}, {"name", subj.name}};
  } else if (subj.kind == SourceManager::Subject::Kind::Window) {
    subject = {{"kind", "game"}, {"name", subj.name}};
  }

  return {
      {"capture", {{"mode", config_.capture.mode}, {"monitor", config_.capture.monitor}, {"subject", subject}}},
      {"video", config_.video.toJson()},
      {"replay", config_.replay.toJson()},
      {"game", config_.game.toJson()},
      {"audio", {{"sources", [this] {
                    nlohmann::json arr = nlohmann::json::array();
                    for (const auto& s : config_.audioSources)
                      arr.push_back(s.toJson());
                    return arr;
                  }()}}},
      {"ring", {{"active", ring_.active()}, {"secondsBuffered", secs}, {"mbUsed", mb}}},
      {"recording", {{"active", recorder_.active()}, {"path", recorder_.currentPath()}}},
      {"foreground",
       {{"exe", games_.currentExe()},
        {"name", games_.currentKnown() ? nlohmann::json(games_.currentName()) : nlohmann::json(nullptr)},
        {"known", games_.currentKnown()},
        {"pid", games_.currentPid()}}},
      {"sessions", games_.sessionsJson()},
      {"storage", {{"limitGb", config_.storageLimitGb}, {"clipsDir", config_.clipsBaseDir}}},
      {"dirs", {{"clips", config_.clipsDir}, {"recordings", config_.recordingsDir}}},
      {"perf", perf_.stateJson()},
      {"version", SHARD_VERSION},
  };
}

std::string Rpc::handle(const std::string& requestText)
{
  std::lock_guard<std::recursive_mutex> lock(dispatchMutex_);
  nlohmann::json req;
  try {
    req = nlohmann::json::parse(requestText);
  } catch (...) {
    return nlohmann::json({{"jsonrpc", "2.0"}, {"id", nullptr}, {"error", {{"code", -32700}, {"message", "Parse error"}}}})
        .dump();
  }

  if (!req.is_object() || !req.contains("method"))
    return nlohmann::json({{"jsonrpc", "2.0"}, {"id", nullptr},
                           {"error", {{"code", -32600}, {"message", "Invalid Request"}}}})
        .dump();

  const bool isNotification = !req.contains("id");
  nlohmann::json response = nlohmann::json({{"jsonrpc", "2.0"}});
  if (!isNotification)
    response["id"] = req["id"];

  nlohmann::json result;
  try {
    result = dispatch(req);
  } catch (const std::exception& e) {
    response["error"] = {{"code", -32603}, {"message", std::string("Internal error: ") + e.what()}};
    return response.dump();
  }

  if (result.contains("error")) {
    response["error"] = result["error"];
  } else {
    response["result"] = result.value("result", nlohmann::json(nullptr));
  }
  return response.dump();
}

nlohmann::json Rpc::dispatch(const nlohmann::json& req)
{
  const std::string method = req["method"];
  const nlohmann::json params = req.contains("params") && req["params"].is_object() ? req["params"]
                                                                                     : nlohmann::json::object();

  if (method == "config.set")
    return {{"result", methodConfigSet(params)}};
  if (method == "state.get")
    return {{"result", buildState()}};
  if (method == "recording.start")
    return {{"result", methodRecordingStart()}};
  if (method == "recording.stop")
    return {{"result", methodRecordingStop()}};
  if (method == "clip.save") {
    if (!params.contains("durationSec") || !params["durationSec"].is_number())
      return {{"error", {{"code", -32602}, {"message", "clip.save requires durationSec"}}}};
    return {{"result", methodClipSave(params)}};
  }
  if (method == "audio.listDevices")
    return {{"result", sources_.listDevices()}};
  if (method == "capture.listMonitors")
    return {{"result", sources_.listMonitors()}};
  if (method == "video.listEncoders") {
    nlohmann::json encoders = nlohmann::json::array();
    for (const auto& encoder : encoders_.availableVideoEncoders()) {
      encoders.push_back({{"id", encoder.id},
                          {"label", encoder.label},
                          {"codec", encoder.codec},
                          {"vendor", encoder.vendor},
                          {"hardware", encoder.hardware}});
    }
    return {{"result", encoders}};
  }
  // ---- game registry / detection ----
  if (method == "game.listKnown")
    return {{"result", games_.listKnown()}};
  if (method == "game.addKnown") {
    if (!params.contains("exe") || !params.contains("name"))
      return {{"error", {{"code", -32602}, {"message", "game.addKnown requires exe and name"}}}};
    return {{"result", games_.addKnown(params["exe"], params["name"])}};
  }
  if (method == "game.removeKnown") {
    if (!params.contains("exe"))
      return {{"error", {{"code", -32602}, {"message", "game.removeKnown requires exe"}}}};
    return {{"result", games_.removeKnown(params["exe"])}};
  }
  if (method == "game.listGames")
    return {{"result", games_.listGames()}};
  if (method == "game.addUserGame")
    return {{"result", games_.addUserGame(params)}};
  if (method == "game.removeUserGame") {
    if (!params.contains("id"))
      return {{"error", {{"code", -32602}, {"message", "game.removeUserGame requires id"}}}};
    return {{"result", games_.removeUserGame(params["id"])}};
  }
  if (method == "game.removeDiscovered") {
    if (!params.contains("id"))
      return {{"error", {{"code", -32602}, {"message", "game.removeDiscovered requires id"}}}};
    return {{"result", games_.removeDiscovered(params["id"])}};
  }
  if (method == "game.updateUserGame")
    return {{"result", games_.updateUserGame(params)}};
  if (method == "game.ignoreExe") {
    if (!params.contains("exe"))
      return {{"error", {{"code", -32602}, {"message", "game.ignoreExe requires exe"}}}};
    return {{"result", games_.ignoreExe(params["exe"])}};
  }
  if (method == "game.unignoreExe") {
    if (!params.contains("exe"))
      return {{"error", {{"code", -32602}, {"message", "game.unignoreExe requires exe"}}}};
    return {{"result", games_.unignoreExe(params["exe"])}};
  }
  if (method == "game.listIgnored")
    return {{"result", games_.listIgnored()}};
  if (method == "game.sessions")
    return {{"result", games_.sessions()}};
  if (method == "game.detectExplain")
    return {{"result", games_.detectExplain(params)}};
  if (method == "shutdown") {
    markShutdown();
    return {{"result", true}};
  }

  return {{"error", {{"code", -32601}, {"message", "Method not found: " + method}}}};
}

nlohmann::json Rpc::methodConfigSet(const nlohmann::json& params)
{
  const bool monitorChanged =
      params.contains("capture") && params["capture"].contains("monitor") &&
      params["capture"]["monitor"].is_number_integer() &&
      params["capture"]["monitor"].get<int>() != config_.capture.monitor;
  const size_t oldAudioTrackCount = 1 + std::min<size_t>(config_.audioSources.size(), 5);
  // Detect resolution/fps changes before applying (they need obs_reset_video).
  bool resChanged = false;
  if (params.contains("video")) {
    const auto& v = params["video"];
    const auto& cur = config_.video;
    int oldW = 0, oldH = 0, oldFps = 0, oldBr = 0;
    EncoderManager(config_).effectiveVideoParams(app_.baseWidth(), app_.baseHeight(), oldW, oldH, oldFps, oldBr);
    VideoSettings next = cur;
    next.applyPartial(v);
    Config nextConfig = config_;
    nextConfig.video = next;
    int newW = 0, newH = 0, newFps = 0, newBr = 0;
    EncoderManager(nextConfig).effectiveVideoParams(app_.baseWidth(), app_.baseHeight(), newW, newH, newFps, newBr);
    (void)oldBr;
    (void)newBr;
    resChanged = (oldW != newW) || (oldH != newH) || (oldFps != newFps);
  }

  auto touched = config_.applyPartial(params);
  const size_t newAudioTrackCount = 1 + std::min<size_t>(config_.audioSources.size(), 5);
  const bool audioTrackCountChanged = oldAudioTrackCount != newAudioTrackCount;
  config_.save();
  const bool fullRestart = resChanged || monitorChanged;
  if (fullRestart)
    restartVideoPipeline();

  for (const auto& key : touched) {
    if (key == "capture") {
      if (!fullRestart)
        sources_.applyVideoSource();
      // A concrete monitor/game subject is capture-active while its backend
      // acquires the first frame. Keep the eager ring alive across that warmup
      // instead of exposing a false inactive state immediately after config.set.
      if (sources_.subject().kind != SourceManager::Subject::Kind::None)
        ring_.start();
    } else if (key == "audio") {
      if (!fullRestart) {
        sources_.applyAudioSources();
        // Enabled/gain changes only replace the live source mix. Preserve the
        // ring and an active recording; a structural row-count change still
        // needs fresh output track bindings.
        if (audioTrackCountChanged)
          restartCaptureOutputs();
      }
    } else if (key == "video") {
      if (!fullRestart)
        restartCaptureOutputs();
    } else if (key == "replay") {
      ring_.updateCaps();
    } else if (key == "game") {
      games_.onConfigChanged();
    }
  }

  return {{"applied", touched}, {"state", buildState()}};
}

void Rpc::restartCaptureOutputs()
{
  const bool wasRecording = recorder_.active();
  ring_.restart();
  if (wasRecording) {
    recorder_.stop();
    recorder_.start();
  }
}

void Rpc::restartVideoPipeline()
{
  preservedCaptureSize_ = {};
  canvasOwner_.reset();
  // Resolution/fps/monitor changes need obs_reset_video, which requires every
  // output and source stopped and released. Stop the watchdog first so its
  // activity callback cannot restart the ring during the reset.
  const auto captureSize = sources_.subject().kind == SourceManager::Subject::Kind::Window
      ? sources_.captureSize() : CaptureSize{};
  const CaptureSize previousCanvas{app_.baseWidth(), app_.baseHeight()};
  sources_.stopWatchdog();
  auto recordingLock = recorder_.lockLifecycle();
  const bool wasRecording = recorder_.active();
  if (!recorder_.prepareVideoReset()) {
    sources_.startWatchdog();
    events_.emit("error", {{"code", "CAPTURE_INIT_FAILED"}, {"message", "Recording did not stop in time to resize video"}});
    return;
  }
  ring_.stop();
  sources_.releaseAll();

  if (!app_.resetVideo(captureSize.width, captureSize.height)) {
    events_.emit("error", {{"code", "CAPTURE_INIT_FAILED"}, {"message", app_.lastError()}});
    // A failed automatic reset must not permanently stop capture monitoring.
    // Attempt the last accepted canvas once; the watchdog's retained cooldown
    // governs subsequent recovery if the driver is still unavailable.
    const bool restored = app_.resetVideo(previousCanvas.width, previousCanvas.height);
    logFormat("[capture-pipeline][warn] reset_failed previous_canvas_restored=%s error=\"%s\"\n",
                 restored ? "true" : "false", app_.lastError().c_str());
  }

  sources_.applyVideoSource();
  sources_.applyAudioSources();
  const bool ringStarted = obs_get_video() && ring_.start();
  if (!ringStarted)
    events_.emit("error", {{"code", "ENCODER_FAIL"}, {"message", "Replay ring failed to restart"}});
  if (wasRecording && ringStarted)
    recorder_.start();
  sources_.startWatchdog();
  logFormat("[capture-pipeline][info] video_mix_available=%s replay_started=%s recording_resumed=%s\n",
               obs_get_video() ? "true" : "false", ringStarted ? "true" : "false",
               wasRecording && recorder_.active() ? "true" : "false");
}

void Rpc::updateCaptureGeometry()
{
  std::lock_guard<std::recursive_mutex> lock(dispatchMutex_);
  if (shutdownRequested()) return;
  if (sources_.consumeVideoRecoveryRequest()) {
    // SourceManager has exhausted conservative source/scene recovery. This
    // thread owns output lifecycle and can safely join the watchdog first.
    restartVideoPipeline();
    captureSizeStability_.reset();
    return;
  }
  const auto subject = sources_.subject();
  const std::string subjectKey = captureSubjectKey(subject);
  if (subjectKey != lastSubjectKey_) {
    // The 1.5 s stability gate applies to the new subject's own geometry.
    lastSubjectKey_ = subjectKey;
    captureSizeStability_.reset();
    preservedCaptureSize_ = {};
  }
  const bool ownsCanvas = canvasOwner_.update(subjectKey, ring_.active());
  const auto size = sources_.captureSize();
  const bool sizeStable = captureSizeStability_.ready(size, duration_ms_now());
  if (!size.valid() || (size.width == app_.baseWidth() && size.height == app_.baseHeight())) {
    preservedCaptureSize_ = {};
    return;
  }
  if (!sizeStable) return;
  if (!ownsCanvas) {
    // A swap must not discard the buffered history of the previous subject.
    // The watchdog already fits the new subject inside the current canvas.
    if (size != preservedCaptureSize_) {
      logFormat("[capture-geometry][info] source=%ux%u canvas=%ux%u subject=\"%s\" canvas_subject=\"%s\" replay_preserved=true reason=subject_switch\n",
                   size.width, size.height, app_.baseWidth(), app_.baseHeight(), subjectKey.c_str(),
                   canvasOwner_.owner().c_str());
      preservedCaptureSize_ = size;
    }
    return;
  }

  int width = 0, height = 0, fps = 0, bitrate = 0;
  encoders_.effectiveVideoParams(size.width, size.height, width, height, fps, bitrate);
  obs_video_info current{};
  if (obs_get_video_info(&current) && captureCanPreserveVideo(size,
      {app_.baseWidth(), app_.baseHeight()}, {uint32_t(width), uint32_t(height)},
      {current.output_width, current.output_height}, uint32_t(fps), current.fps_num, current.fps_den)) {
    // The watchdog already fits each source to the live canvas. Resetting
    // OBS here would clear real replay packets and split recording despite
    // producing exactly the same encoded size, aspect ratio and cadence.
    if (size != preservedCaptureSize_) {
      logFormat("[capture-geometry][info] source=%ux%u canvas=%ux%u output=%ux%u fps=%u/%u replay_preserved=true reason=compatible_source_resize\n",
                   size.width, size.height, app_.baseWidth(), app_.baseHeight(),
                   current.output_width, current.output_height, current.fps_num, current.fps_den);
      preservedCaptureSize_ = size;
    }
    return;
  }
  preservedCaptureSize_ = {};
  logFormat("[capture-geometry][info] source=%ux%u previous_canvas=%ux%u previous_output=%ux%u output=%dx%d fps=%d replay_preserved=false reason=video_format_or_aspect_change\n",
               size.width, size.height, app_.baseWidth(), app_.baseHeight(),
               current.output_width, current.output_height, width, height, fps);

  sources_.stopWatchdog();
  auto recordingLock = recorder_.lockLifecycle();
  const bool wasRecording = recorder_.active();
  if (!recorder_.prepareVideoReset()) {
    sources_.startWatchdog();
    captureSizeStability_.reset();
    events_.emit("error", {{"code", "CAPTURE_INIT_FAILED"}, {"message", "Recording did not stop in time to resize capture"}});
    return;
  }
  ring_.stop();
  // OBS retains its graphics device and live sources when resetting video.
  // Do not reinject a working hook just to change the encoded dimensions.
  const bool resized = sources_.resizeCanvas(size);
  if (!resized)
    events_.emit("error", {{"code", "CAPTURE_INIT_FAILED"}, {"message", app_.lastError()}});
  const bool started = ring_.start();
  if (wasRecording && started) recorder_.start();
  sources_.startWatchdog();
  captureSizeStability_.reset();
  logFormat("capture: canvas %ux%u, resized=%s; replay buffer restarted%s\n",
               size.width, size.height, resized ? "true" : "false", wasRecording ? ", recording continued in new file" : "");
}

nlohmann::json Rpc::methodRecordingStart()
{
  bool ok = recorder_.start();
  return {{"ok", ok}, {"active", recorder_.active()}};
}

nlohmann::json Rpc::methodRecordingStop()
{
  recorder_.stop();
  return {{"ok", true}, {"active", recorder_.active()}};
}

nlohmann::json Rpc::methodClipSave(const nlohmann::json& params)
{
  int durationSec = params["durationSec"];
  if (durationSec < 0)
    durationSec = 0;
  ring_.save(durationSec);
  return {{"ok", true}, {"queued", true}};
}

} // namespace shard
