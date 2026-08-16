#pragma once

#include "app.h"
#include "config.h"
#include "game_system.h"
#include "recorder.h"
#include "replay_ring.h"
#include "sources.h"

#include <nlohmann/json.hpp>

#include <string>

namespace clipforge {

// JSON-RPC 2.0 dispatch. handle() is thread-safe (server calls it from
// connection threads); every method is executed inline on the caller thread.
// Unknown method -> -32601; malformed params -> -32602.
class Rpc {
public:
  Rpc(App& app, Config& config, Events& events, SourceManager& sources, EncoderManager& encoders,
      ReplayRing& ring, Recorder& recorder, GameSystem& games);

  // Full JSON-RPC request text -> response text ("" for notifications).
  std::string handle(const std::string& requestText);

  // state.get payload (also used internally for ready).
  nlohmann::json buildState() const;

  bool shutdownRequested() const { return shutdownRequested_.load(); }
  void markShutdown() { shutdownRequested_.store(true); }

private:
  nlohmann::json dispatch(const nlohmann::json& req);
  nlohmann::json methodConfigSet(const nlohmann::json& params);
  nlohmann::json methodRecordingStart();
  nlohmann::json methodRecordingStop();
  nlohmann::json methodClipSave(const nlohmann::json& params);

  // Restart ring (and recording) after encoder/video setting changes.
  void restartCaptureOutputs();
  // Restart everything when the video output resolution/fps changed.
  void restartVideoPipeline();

  App& app_;
  Config& config_;
  Events& events_;
  SourceManager& sources_;
  EncoderManager& encoders_;
  ReplayRing& ring_;
  Recorder& recorder_;
  GameSystem& games_;

  std::atomic<bool> shutdownRequested_{false};
};

} // namespace clipforge
