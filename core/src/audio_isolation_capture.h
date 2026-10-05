// Live side of per-application audio isolation (decisions: audio_isolation.h).
//
// `shard_process_loopback_capture` is a Shard-owned OBS audio source that
// captures one process tree with WASAPI process loopback
// (PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE), addressed by PID rather
// than by window, so tray-hidden and windowless helper processes work.
//
// AudioIsolationController owns those sources for the isolated App rows and
// the filtered Desktop rows. A single background thread reconciles a process
// snapshot plus the selected endpoints' audio sessions (~1 Hz, and immediately
// when a session is created) and adds/removes per-tree sources on the main
// scene. Sources only join or leave OBS mixes; encoders, the replay ring and
// recordings are never restarted by application or session churn.
#pragma once

#include "audio_isolation.h"

#include <obs.h>

#include <memory>
#include <string>
#include <vector>

namespace shard {

// Registers the process loopback source when the OS supports it (Windows 10
// 19041+, the same gate OBS uses for application audio capture).
void registerProcessLoopbackSource();
bool processLoopbackSupported();

struct IsolationRow {
  enum class Kind { App, Desktop };
  Kind kind = Kind::App;
  size_t configuredIndex = 0;
  std::string name;
  std::string exe;      // App rows: lowercase executable basename
  std::string deviceId; // Desktop rows: WASAPI render endpoint id or "default"
  float gain = 1.0f;
};

class AudioIsolationController {
public:
  AudioIsolationController();
  ~AudioIsolationController();

  AudioIsolationController(const AudioIsolationController&) = delete;
  AudioIsolationController& operator=(const AudioIsolationController&) = delete;

  // Replaces any running configuration. Sources appear on `scene` once the
  // background thread has resolved processes/sessions.
  void start(obs_scene_t* scene, std::vector<IsolationRow> rows, std::vector<std::string> isolatedExes);
  // Joins the thread and removes every source it created.
  void stop();

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace shard
