#include "jsonrpc.h"

#include <atomic>

namespace clipforge {

Rpc::Rpc(App& app, Config& config, Events& events, SourceManager& sources, EncoderManager& encoders,
         ReplayRing& ring, Recorder& recorder, GameDetect& games)
    : app_(app), config_(config), events_(events), sources_(sources), encoders_(encoders), ring_(ring),
      recorder_(recorder), games_(games)
{
}

nlohmann::json Rpc::buildState() const
{
  int secs = 0;
  double mb = 0;
  ring_.getStats(secs, mb);

  const auto subj = sources_.subject();
  nlohmann::json subject = {{"kind", "none"}, {"name", nullptr}};
  if (subj.kind == SourceManager::Subject::Kind::Monitor) {
    subject = {{"kind", "monitor"}, {"name", "Desktop"}};
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
      {"foreground", {{"exe", games_.currentExe()}, {"name", games_.currentName()}, {"known", games_.currentKnown()}}},
      {"storage", {{"limitGb", config_.storageLimitGb}, {"clipsDir", config_.clipsBaseDir}}},
      {"dirs", {{"clips", config_.clipsDir}, {"recordings", config_.recordingsDir}}},
      {"version", CLIPFORGE_VERSION},
  };
}

std::string Rpc::handle(const std::string& requestText)
{
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
  if (method == "shutdown") {
    markShutdown();
    return {{"result", true}};
  }

  return {{"error", {{"code", -32601}, {"message", "Method not found: " + method}}}};
}

nlohmann::json Rpc::methodConfigSet(const nlohmann::json& params)
{
  // Detect resolution/fps changes before applying (they need obs_reset_video).
  bool resChanged = false;
  if (params.contains("video")) {
    const auto& v = params["video"];
    const auto& cur = config_.video;
    int oldW = 0, oldH = 0, oldFps = 0, oldBr = 0;
    EncoderManager(config_).effectiveVideoParams(app_.baseWidth(), app_.baseHeight(), oldW, oldH, oldFps, oldBr);
    VideoSettings next = cur;
    next.applyPartial(v);
    int newW = 0, newH = 0, newFps = 0, newBr = 0;
    EncoderManager(config_).effectiveVideoParams(app_.baseWidth(), app_.baseHeight(), newW, newH, newFps, newBr);
    (void)oldBr;
    (void)newBr;
    resChanged = (oldW != newW) || (oldH != newH) || (oldFps != newFps);
  }

  auto touched = config_.applyPartial(params);
  config_.save();

  for (const auto& key : touched) {
    if (key == "capture")
      sources_.applyVideoSource();
    else if (key == "audio")
      sources_.applyAudioSources();
    else if (key == "video") {
      if (resChanged)
        restartVideoPipeline();
      else
        restartCaptureOutputs();
    } else if (key == "replay")
      ring_.updateCaps();
    else if (key == "game")
      games_.reload();
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
  // Resolution/fps changes need obs_reset_video, which requires every output
  // and source stopped and released. Order: recording -> ring -> sources ->
  // obs teardown -> re-init -> re-apply -> restart.
  const bool wasRecording = recorder_.active();
  recorder_.stopAndWait();
  ring_.stop();
  sources_.releaseAll();

  app_.shutdown();
  app_.init();

  sources_.applyVideoSource();
  sources_.applyAudioSources();
  ring_.start();
  if (wasRecording)
    recorder_.start();
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

} // namespace clipforge
