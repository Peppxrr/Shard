// Linux has no process-loopback capture API comparable to WASAPI's; isolated
// App rows are therefore unsupported and the controller adds no sources
// (audio_isolation.h keeps the routing decisions platform-neutral).
#include "audio_isolation_capture.h"

namespace shard {

struct AudioIsolationController::Impl {};

bool processLoopbackSupported()
{
  return false;
}

void registerProcessLoopbackSource() {}

AudioIsolationController::AudioIsolationController() = default;
AudioIsolationController::~AudioIsolationController() = default;
void AudioIsolationController::start(obs_scene_t*, std::vector<IsolationRow>, std::vector<std::string>) {}
void AudioIsolationController::stop() {}

} // namespace shard
