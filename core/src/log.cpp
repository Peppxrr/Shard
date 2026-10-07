#include "log.h"

#include <util/base.h>

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <thread>
#include <utility>

namespace shard {

namespace {

// Bounded so a reader that stops draining stderr costs memory, not capture.
constexpr size_t kMaxQueuedBytes = 4 * 1024 * 1024;

struct LogState {
  std::mutex mutex;
  std::condition_variable cv;
  std::deque<std::string> lines;
  size_t bytes = 0;
  uint64_t dropped = 0;
  bool running = false;
  bool stopping = false;
  std::thread writer;

  std::mutex factsMutex;
  ObsLogFacts facts;
};

// Intentionally leaked: libobs and late static destructors may still log,
// and a joinable std::thread must never be destroyed implicitly.
LogState& state()
{
  static LogState* instance = new LogState();
  return *instance;
}

thread_local std::vector<std::string>* tlsCapture = nullptr;

void writeLine(const std::string& line)
{
  std::fwrite(line.data(), 1, line.size(), stderr);
  std::fputc('\n', stderr);
}

void writerLoop()
{
  auto& s = state();
  std::deque<std::string> batch;
  for (;;) {
    uint64_t dropped = 0;
    {
      std::unique_lock<std::mutex> lock(s.mutex);
      s.cv.wait(lock, [&] { return s.stopping || !s.lines.empty(); });
      if (s.lines.empty() && s.stopping)
        break;
      batch.swap(s.lines);
      s.bytes = 0;
      dropped = std::exchange(s.dropped, 0);
    }
    if (dropped)
      std::fprintf(stderr, "[log][warn] dropped %llu diagnostic lines while stderr was not being read\n",
                   static_cast<unsigned long long>(dropped));
    for (const auto& line : batch)
      writeLine(line);
    std::fflush(stderr);
    batch.clear();
  }
}

std::string vformat(const char* format, va_list args)
{
  va_list measure;
  va_copy(measure, args);
  const int length = std::vsnprintf(nullptr, 0, format, measure);
  va_end(measure);
  if (length < 0)
    return "[log][error] could not format diagnostic message";
  std::string text(static_cast<size_t>(length), '\0');
  va_list write;
  va_copy(write, args);
  std::vsnprintf(text.data(), text.size() + 1, format, write);
  va_end(write);
  return text;
}

const char* obsLevelName(int level)
{
  switch (level) {
    case LOG_ERROR: return "error";
    case LOG_WARNING: return "warn";
    case LOG_INFO: return "info";
    case LOG_DEBUG: return "debug";
    default: return "unknown";
  }
}

uint64_t steadyMs()
{
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count());
}

void observeObsMessage(const std::string& message)
{
  auto& s = state();
  if (message.find("D3D11 GPU priority setup success") != std::string::npos) {
    std::lock_guard<std::mutex> lock(s.factsMutex);
    s.facts.gpuPriority = GpuPriorityResult::Success;
    return;
  }
  if (message.find("D3D11 GPU priority setup failed") != std::string::npos) {
    std::lock_guard<std::mutex> lock(s.factsMutex);
    s.facts.gpuPriority = GpuPriorityResult::Failed;
    return;
  }
  // "[game-capture: 'name'] d3d11 shared texture capture successful" is the
  // hook's own report; game-capture.c follows with the transport it opened.
  if (message.rfind("[game-capture: ", 0) != 0)
    return;
  const size_t close = message.find("] ");
  if (close == std::string::npos)
    return;
  const std::string tail = message.substr(close + 2);
  static constexpr const char* kApis[] = {"d3d8", "d3d9", "d3d10", "d3d11", "d3d12", "gl", "vulkan"};
  std::lock_guard<std::mutex> lock(s.factsMutex);
  if (tail == "shared texture capture successful") {
    s.facts.hookMode = "shared_texture";
    s.facts.hookEventMs = steadyMs();
  } else if (tail == "memory capture successful") {
    s.facts.hookMode = "shared_memory";
    s.facts.hookEventMs = steadyMs();
  } else if (tail == "capture stopped") {
    s.facts.hookMode.clear();
    s.facts.hookEventMs = steadyMs();
  } else if (tail.size() > 18 && tail.compare(tail.size() - 18, 18, "capture successful") == 0) {
    for (const char* api : kApis) {
      const size_t length = std::strlen(api);
      if (tail.compare(0, length, api) == 0 && tail.size() > length && tail[length] == ' ') {
        s.facts.hookApi = api;
        break;
      }
    }
  }
}

} // namespace

void logStart()
{
  auto& s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  if (s.running)
    return;
  s.stopping = false;
  s.running = true;
  s.writer = std::thread(writerLoop);
}

void logStop()
{
  auto& s = state();
  {
    std::lock_guard<std::mutex> lock(s.mutex);
    if (!s.running || s.stopping)
      return;
    s.stopping = true;
  }
  s.cv.notify_all();
  s.writer.join();
  std::lock_guard<std::mutex> lock(s.mutex);
  s.running = false;
  s.stopping = false;
}

void logLine(std::string line)
{
  if (!line.empty() && line.back() == '\n')
    line.pop_back();
  auto& s = state();
  {
    std::lock_guard<std::mutex> lock(s.mutex);
    if (!s.running || s.stopping) {
      // Before startup or during final teardown: keep ordering, write now.
      writeLine(line);
      std::fflush(stderr);
      return;
    }
    if (s.bytes + line.size() + 1 > kMaxQueuedBytes) {
      ++s.dropped;
      return;
    }
    s.bytes += line.size() + 1;
    s.lines.push_back(std::move(line));
  }
  s.cv.notify_one();
}

void logFormat(const char* format, ...)
{
  va_list args;
  va_start(args, format);
  std::string text = vformat(format, args);
  va_end(args);
  logLine(std::move(text));
}

void logObs(int level, const char* format, va_list args, void*)
{
  std::string message = vformat(format, args);
  if (tlsCapture)
    tlsCapture->push_back(message);
  observeObsMessage(message);
  std::string line;
  line.reserve(message.size() + 16);
  line += "[obs][";
  line += obsLevelName(level);
  line += "] ";
  line += message;
  logLine(std::move(line));
}

ObsLogFacts obsLogFacts()
{
  auto& s = state();
  std::lock_guard<std::mutex> lock(s.factsMutex);
  return s.facts;
}

const char* gpuPriorityName(GpuPriorityResult result)
{
  switch (result) {
    case GpuPriorityResult::Success: return "set";
    case GpuPriorityResult::Failed: return "failed";
    default: return "unknown";
  }
}

ObsLogCapture::ObsLogCapture() : previous_(tlsCapture)
{
  tlsCapture = &messages_;
}

ObsLogCapture::~ObsLogCapture()
{
  tlsCapture = previous_;
}

bool ObsLogCapture::contains(const char* text) const
{
  for (const auto& message : messages_)
    if (message.find(text) != std::string::npos)
      return true;
  return false;
}

} // namespace shard
