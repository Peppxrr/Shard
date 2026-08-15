#pragma once

#include "config.h"

#include <obs.h>

#include <memory>
#include <string>

namespace clipforge {

struct Events {
  // Called from arbitrary threads. Implementations must be thread-safe.
  using Sink = void (*)(void* ctx, const char* type, const nlohmann::json& params);
  void* sinkCtx = nullptr;
  Sink sink = nullptr;

  void emit(const char* type, const nlohmann::json& params = nlohmann::json::object()) const
  {
    if (sink)
      sink(sinkCtx, type, params);
  }
};

// Owns the libobs context: startup, video/audio reset, the main scene,
// and ordered shutdown. Single-threaded use after startup (OBS calls the
// various callbacks on its own threads).
class App {
public:
  App(Config& config, Events& events);
  ~App();

  App(const App&) = delete;
  App& operator=(const App&) = delete;

  bool init();          // obs_startup + modules + video/audio + scene
  void shutdown();      // obs_shutdown (must be called before process exit)

  obs_scene_t* scene() const { return scene_; }
  bool ok() const { return ok_; }
  const std::string& lastError() const { return lastError_; }

  uint32_t baseWidth() const { return baseWidth_; }
  uint32_t baseHeight() const { return baseHeight_; }

private:
  bool startup();
  bool resetVideo();
  bool resetAudio();

  Config& config_;
  Events& events_;
  bool ok_ = false;
  bool shutdownDone_ = false;
  std::string lastError_;
  obs_scene_t* scene_ = nullptr;
  uint32_t baseWidth_ = 1920;
  uint32_t baseHeight_ = 1080;
};

} // namespace clipforge
