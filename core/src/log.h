#pragma once

#include <cstdarg>
#include <cstdint>
#include <string>
#include <vector>

namespace shard {

// Diagnostic log on stderr (stdout carries only the PORT handshake). Every
// caller, including libobs' graphics, audio and encoder threads, only formats
// and enqueues. A dedicated writer drains the queue, so a slow or stalled
// reader of the stderr pipe can never block capture or encoding. When the
// bounded queue is full, lines are dropped and the drop count is reported.
void logStart();
// Drains queued lines and joins the writer. Safe to call more than once.
void logStop();
void logLine(std::string line);
// printf-style; distinct from <cmath>'s logf.
void logFormat(const char* format, ...);
// base_set_log_handler callback for libobs.
void logObs(int level, const char* format, va_list args, void* param);

enum class GpuPriorityResult { Unknown, Success, Failed };

// Facts that only libobs knows and reports through its log.
struct ObsLogFacts {
  // libobs-d3d11 reports whether it could raise the process GPU scheduling
  // priority while creating the device (needs administrator rights).
  GpuPriorityResult gpuPriority = GpuPriorityResult::Unknown;
  // Last Game Capture hook result, e.g. api="d3d11" mode="shared_texture".
  std::string hookApi;
  std::string hookMode;
  uint64_t hookEventMs = 0;
};
ObsLogFacts obsLogFacts();
const char* gpuPriorityName(GpuPriorityResult result);

// Collects libobs messages logged on the constructing thread while alive.
// Encoder plugins initialize synchronously inside obs_output_start, so this
// observes texture-path fallbacks for exactly that start attempt.
class ObsLogCapture {
public:
  ObsLogCapture();
  ~ObsLogCapture();
  ObsLogCapture(const ObsLogCapture&) = delete;
  ObsLogCapture& operator=(const ObsLogCapture&) = delete;

  const std::vector<std::string>& messages() const { return messages_; }
  bool contains(const char* text) const;

private:
  std::vector<std::string> messages_;
  std::vector<std::string>* previous_ = nullptr;
};

} // namespace shard
