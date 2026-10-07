#include "perf_monitor.h"

#include "log.h"
#include "sources.h"
#include "system_info.h"

#include <cctype>
#include <chrono>
#include <cmath>
#include <cstring>
#include <shared_mutex>
#include <sstream>

namespace shard {

namespace {

using namespace std::chrono;

constexpr auto kSliceInterval = milliseconds(250);
constexpr int kSlicesPerSecond = 4;
// Classification window: long enough to ignore one late frame, short enough
// that the hint follows the game's load.
constexpr size_t kWindowSlices = 5 * kSlicesPerSecond;
// Two hours of 250 ms slices covers the longest replay buffer and typical
// recordings; older history is dropped.
constexpr size_t kMaxSlices = 2 * 3600 * kSlicesPerSecond;
constexpr uint64_t kHeartbeatUs = 30ull * 1000 * 1000;
// One classification window: start-up losses must roll out before a cause
// is reported.
constexpr uint64_t kOutputWarmupUs = kWindowSlices * 250000ull;

int64_t unixMs()
{
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

double rounded(double value, double scale = 10.0)
{
  return std::round(value * scale) / scale;
}

const char* scaleName(enum obs_scale_type type)
{
  switch (type) {
    case OBS_SCALE_POINT: return "point";
    case OBS_SCALE_BICUBIC: return "bicubic";
    case OBS_SCALE_BILINEAR: return "bilinear";
    case OBS_SCALE_LANCZOS: return "lanczos";
    case OBS_SCALE_AREA: return "area";
    default: return "disabled";
  }
}

bool containsInsensitive(const std::string& text, const char* needle)
{
  const size_t length = std::strlen(needle);
  if (length > text.size())
    return false;
  for (size_t i = 0; i + length <= text.size(); ++i) {
    size_t j = 0;
    while (j < length && std::tolower(static_cast<unsigned char>(text[i + j])) == needle[j])
      ++j;
    if (j == length)
      return true;
  }
  return false;
}

nlohmann::json pathJson(const VideoEncoderPath& path)
{
  if (path.encoderId.empty())
    return nullptr;
  nlohmann::json settings = nlohmann::json::parse(path.settingsJson, nullptr, false);
  return {{"encoder", path.encoderId},
          {"zeroCopy", path.zeroCopy},
          {"textureCapable", path.textureCapable},
          {"nv12Texture", path.nv12Texture},
          {"gpuScaling", path.gpuScaling},
          {"fellBack", path.fellBack},
          {"reason", path.reason},
          {"settings", settings.is_discarded() ? nlohmann::json(nullptr) : settings}};
}

WindowTotals totalsOf(const std::deque<FrameSlice>& slices, size_t count)
{
  WindowTotals totals;
  const size_t first = slices.size() > count ? slices.size() - count : 0;
  for (size_t i = first; i < slices.size(); ++i)
    addSlice(totals, slices[i]);
  return totals;
}

double percentOf(uint32_t part, uint32_t whole)
{
  return whole ? rounded(100.0 * part / whole, 100.0) : 0.0;
}

} // namespace

VideoEncoderPath inspectVideoEncoderPath(const char* output, obs_encoder_t* encoder,
                                         const std::vector<std::string>& startMessages)
{
  VideoEncoderPath path;
  path.output = output;
  if (!encoder) {
    path.reason = "no_encoder";
    return path;
  }
  const char* id = obs_encoder_get_id(encoder);
  path.encoderId = id ? id : "";
  path.textureCapable = (obs_get_encoder_caps(path.encoderId.c_str()) & OBS_ENCODER_CAP_PASS_TEXTURE) != 0;
  path.nv12Texture = obs_encoder_video_tex_active(encoder, VIDEO_FORMAT_NV12);
  path.gpuScaling = obs_encoder_scaling_enabled(encoder);
  // Hardware plugins reroute to their system-memory variant without changing
  // the public encoder id; their own start-up message is the only evidence.
  for (const auto& message : startMessages) {
    if (containsInsensitive(message, "falling back") || containsInsensitive(message, "fallback")) {
      path.fellBack = true;
      break;
    }
  }
  if (!path.textureCapable)
    path.reason = "encoder_reads_system_memory";
  else if (path.fellBack)
    path.reason = "encoder_fell_back_to_system_memory";
  else if (!path.nv12Texture)
    path.reason = "nv12_texture_sharing_unavailable";
  else if (path.gpuScaling)
    path.reason = "encoder_side_scaling";
  path.zeroCopy = path.textureCapable && path.nv12Texture && !path.gpuScaling && !path.fellBack;
  if (obs_data_t* settings = obs_encoder_get_settings(encoder)) {
    if (const char* json = obs_data_get_json(settings))
      path.settingsJson = json;
    obs_data_release(settings);
  }
  return path;
}

PerfMonitor::PerfMonitor(App& app, Config& config, Events& events, SourceManager& sources)
    : app_(app), config_(config), events_(events), sources_(sources), elevated_(processElevated()),
      hags_(hagsEnabled(app.graphicsAdapter().luid))
{
}

PerfMonitor::~PerfMonitor()
{
  stop();
}

uint64_t PerfMonitor::nowUs()
{
  return static_cast<uint64_t>(duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count());
}

void PerfMonitor::start()
{
  std::lock_guard<std::mutex> lock(wakeMutex_);
  if (running_)
    return;
  // Open synchronously so the first session log already knows whether GPU
  // engine counters are available.
  if (!gpu_.isOpen()) {
    const uint64_t openedAt = nowUs();
    const bool ok = gpu_.open();
    {
      std::lock_guard<std::mutex> state(mutex_);
      gpuCountersAvailable_ = ok;
      gpuCountersError_ = gpu_.lastError();
    }
    if (ok)
      logFormat("[perf][info] gpu_engine_counters=available source=\"\\GPU Engine(*)\\Utilization Percentage\" open_ms=%llu",
                static_cast<unsigned long long>((nowUs() - openedAt) / 1000));
    else
      logFormat("[perf][warn] gpu_engine_counters=unavailable error=\"%s\"", gpu_.lastError().c_str());
  }
  running_ = true;
  thread_ = std::thread([this] { run(); });
}

void PerfMonitor::stop()
{
  {
    std::lock_guard<std::mutex> lock(wakeMutex_);
    if (!running_)
      return;
    running_ = false;
  }
  wake_.notify_all();
  if (thread_.joinable())
    thread_.join();
}

void PerfMonitor::setLaunchMode(std::string mode)
{
  std::lock_guard<std::mutex> lock(mutex_);
  launchMode_ = std::move(mode);
}

void PerfMonitor::outputStarted(const VideoEncoderPath& path)
{
  std::ostringstream line;
  line << "[encoder][" << (path.zeroCopy ? "info" : "warn") << "] output=" << path.output
       << " encoder=" << path.encoderId << " zero_copy=" << (path.zeroCopy ? "true" : "false")
       << " texture_capable=" << (path.textureCapable ? "true" : "false")
       << " nv12_texture=" << (path.nv12Texture ? "true" : "false")
       << " encoder_scaling=" << (path.gpuScaling ? "true" : "false")
       << " plugin_fallback=" << (path.fellBack ? "true" : "false");
  if (!path.reason.empty())
    line << " reason=" << path.reason;
  logLine(line.str());
  logFormat("[encoder][info] output=%s settings=%s", path.output.c_str(), path.settingsJson.c_str());

  std::lock_guard<std::mutex> lock(mutex_);
  if (path.output == "replay") {
    replayPath_ = path;
    texturePath_.store(path.zeroCopy);
  } else {
    recordingPath_ = path;
    if (replayPath_.encoderId.empty())
      texturePath_.store(path.zeroCopy);
  }
  logSessionLocked(path.output == "replay" ? "replay_started" : "recording_started");
  // Encoder sessions are created under the graphics lock while an output
  // starts, which costs a few render deadlines. Still recorded per clip, but
  // not reported as a cause.
  warmupUntilUs_ = nowUs() + kOutputWarmupUs;
}

std::vector<uint32_t> PerfMonitor::targetPids() const
{
  const auto subject = sources_.subject();
  if (subject.kind == SourceManager::Subject::Kind::Window && subject.pid)
    return {subject.pid};
  return {};
}

bool PerfMonitor::readCounters(FrameCounters& counters)
{
  // obs_reset_video replaces the video output; never read it mid-reset.
  std::shared_lock<std::shared_mutex> lock(app_.videoMutex(), std::try_to_lock);
  if (!lock)
    return false;
  video_t* video = obs_get_video();
  if (!video)
    return false;
  counters.rendered = obs_get_total_frames();
  counters.lagged = obs_get_lagged_frames();
  counters.encoded = video_output_get_total_frames(video);
  counters.skipped = video_output_get_skipped_frames(video);
  return true;
}

nlohmann::json PerfMonitor::sessionJsonLocked() const
{
  const auto& adapter = app_.graphicsAdapter();
  const auto facts = obsLogFacts();
  const auto& hags = hags_;
  const auto capture = sources_.captureStatus();
  obs_video_info ovi{};
  const bool haveVideo = obs_get_video_info(&ovi);
  nlohmann::json video = nullptr;
  if (haveVideo) {
    video = {{"base", std::to_string(ovi.base_width) + "x" + std::to_string(ovi.base_height)},
             {"output", std::to_string(ovi.output_width) + "x" + std::to_string(ovi.output_height)},
             {"fps", ovi.fps_den ? double(ovi.fps_num) / ovi.fps_den : 0.0},
             {"rescaled", ovi.base_width != ovi.output_width || ovi.base_height != ovi.output_height},
             {"scale", scaleName(ovi.scale_type)},
             {"format", ovi.output_format == VIDEO_FORMAT_NV12 ? "NV12" : "other"}};
  }
  return {
      {"elevated", elevated_},
      {"launch", launchMode_},
      {"gpuPriority", gpuPriorityName(facts.gpuPriority)},
      {"processPriority", processPriorityClassName()},
      {"hags", hags ? nlohmann::json(*hags) : nlohmann::json(nullptr)},
      {"adapter",
       {{"name", adapter.name},
        {"vendor", gpuVendorName(adapter.vendorId)},
        {"driver", formatDriverVersion(adapter.driverVersion, adapter.vendorId)}}},
      {"capture",
       {{"subject", capture.subject},
        {"name", capture.name},
        {"pid", capture.pid},
        {"method", capture.method},
        {"reason", capture.reason},
        {"hookApi", facts.hookApi.empty() ? nlohmann::json(nullptr) : nlohmann::json(facts.hookApi)},
        {"hookMode", facts.hookMode.empty() ? nlohmann::json(nullptr) : nlohmann::json(facts.hookMode)},
        {"hookSize", std::to_string(capture.hookWidth) + "x" + std::to_string(capture.hookHeight)}}},
      {"video", video},
      {"encoders", {{"replay", pathJson(replayPath_)}, {"recording", pathJson(recordingPath_)}}},
      {"gpuCounters", {{"available", gpuCountersAvailable_}, {"error", gpuCountersError_}}},
  };
}

void PerfMonitor::logSessionLocked(const char* reason)
{
  const nlohmann::json session = sessionJsonLocked();
  const auto& capture = session["capture"];
  const auto& video = session["video"];
  const auto& replay = session["encoders"][replayPath_.encoderId.empty() ? "recording" : "replay"];
  std::ostringstream line;
  const auto text = [](const nlohmann::json& value) {
    return value.is_null() ? std::string("unknown") : value.is_string() ? value.get<std::string>() : value.dump();
  };
  line << "[perf-session][info] reason=" << reason << " elevated=" << text(session["elevated"])
       << " launch=" << text(session["launch"]) << " gpu_priority=" << text(session["gpuPriority"])
       << " cpu_priority_class=" << text(session["processPriority"])
       << " hags=" << (session["hags"].is_null() ? "unknown" : session["hags"].get<bool>() ? "on" : "off")
       << " gpu=\"" << text(session["adapter"]["name"]) << "\" vendor=" << text(session["adapter"]["vendor"])
       << " driver=\"" << text(session["adapter"]["driver"]) << "\""
       << " capture_method=" << text(capture["method"]) << " capture_reason=" << text(capture["reason"])
       << " subject=" << text(capture["subject"]) << " subject_name=\"" << text(capture["name"]) << "\""
       << " pid=" << text(capture["pid"]) << " hook_api=" << text(capture["hookApi"])
       << " hook_mode=" << text(capture["hookMode"]) << " hook_size=" << text(capture["hookSize"]);
  if (!video.is_null())
    line << " base=" << text(video["base"]) << " output=" << text(video["output"]) << " fps=" << text(video["fps"])
         << " rescaled=" << text(video["rescaled"]) << " scale=" << text(video["scale"])
         << " format=" << text(video["format"]);
  if (!replay.is_null())
    line << " encoder=" << text(replay["encoder"]) << " zero_copy=" << text(replay["zeroCopy"]);
  line << " gpu_engine_counters=" << (gpuCountersAvailable_ ? "available" : "unavailable");
  logLine(line.str());
}

nlohmann::json PerfMonitor::lagJson(uint64_t startUs, uint64_t endUs) const
{
  std::lock_guard<std::mutex> lock(mutex_);
  if (slices_.empty() || endUs <= startUs || slices_.front().startUs > startUs + 1000000)
    return nullptr;
  const ClipLag lag = clipLagFromSlices(slices_, startUs, endUs);
  nlohmann::json segments = nlohmann::json::array();
  for (const auto& segment : lag.segments)
    segments.push_back({{"start", rounded(segment.start, 100.0)},
                        {"end", rounded(segment.end, 100.0)},
                        {"lagged", segment.lagged},
                        {"skipped", segment.stalled},
                        {"cause", perfCauseName(segment.cause)}});
  // "skipped": frames dropped because the encoder queue was full (they show
  // as repeated frames in the file), at the time they were lost.
  return {{"frames", lag.frames},
          {"lagged", lag.lagged},
          {"skipped", lag.stalled},
          {"cause", perfCauseName(lag.cause)},
          {"segments", segments}};
}

nlohmann::json PerfMonitor::stateJson() const
{
  std::lock_guard<std::mutex> lock(mutex_);
  return {{"session", sessionJsonLocked()}, {"latest", latest_}};
}

void PerfMonitor::run()
{
  const bool gpuOk = gpu_.isOpen();
  bool sampleTimed = false;

  FrameCounters previous;
  bool havePrevious = false;
  uint64_t previousUs = nowUs();
  uint32_t backlog = 0;
  uint64_t lastHeartbeatUs = nowUs();
  int tick = 0;

  for (;;) {
    {
      std::unique_lock<std::mutex> lock(wakeMutex_);
      wake_.wait_for(lock, kSliceInterval, [this] { return !running_; });
      if (!running_)
        break;
    }
    const uint64_t now = nowUs();
    FrameCounters current;
    if (!readCounters(current)) {
      havePrevious = false; // video reset: counters restart
      backlog = 0;
      continue;
    }
    const bool texturePath = texturePath_.load();
    if (havePrevious) {
      const FrameSlice slice = frameSlice(previous, current, texturePath, backlog, obs_video_active(), previousUs, now);
      backlog = slice.backlog;
      std::lock_guard<std::mutex> lock(mutex_);
      slices_.push_back(slice);
      while (slices_.size() > kMaxSlices)
        slices_.pop_front();
    }
    previous = current;
    previousUs = now;
    havePrevious = true;
    if (++tick % kSlicesPerSecond != 0)
      continue;

    const std::vector<uint32_t> pids = targetPids();
    const uint64_t sampleStartUs = nowUs();
    const GpuEngineSample gpuSample = gpuOk ? gpu_.sample(app_.graphicsAdapter().luid, pids) : GpuEngineSample{};
    if (gpuOk && !sampleTimed) {
      // PDH expands one instance per process and engine; record its cost once.
      logFormat("[perf][info] gpu_engine_counters first_sample_ms=%.1f",
                (nowUs() - sampleStartUs) / 1000.0);
      sampleTimed = true;
    }
    const bool outputsActive = obs_video_active();
    const bool priorityActive = obsLogFacts().gpuPriority == GpuPriorityResult::Success;
    const double fps = obs_get_active_fps();
    const double frameTimeMs = obs_get_average_frame_time_ns() / 1e6;
    const bool gameTarget = !pids.empty();

    std::lock_guard<std::mutex> lock(mutex_);
    // PDH utilization covers exactly the last second: attribute it to that
    // second's slices so losses are judged by the load when they happened.
    for (size_t i = slices_.size() > kSlicesPerSecond ? slices_.size() - kSlicesPerSecond : 0; i < slices_.size(); ++i) {
      slices_[i].engine3d = gpuSample.available ? gpuSample.engine3d : -1;
      slices_[i].videoEncode = gpuSample.available ? gpuSample.videoEncode : -1;
    }
    const WindowTotals second = totalsOf(slices_, kSlicesPerSecond);
    const WindowTotals window = totalsOf(slices_, kWindowSlices);
    const PerfCause cause = outputsActive && now >= warmupUntilUs_ ? classifyWithBacklog(window, cause_, texturePath)
                                                                   : PerfCause::Ok;
    const bool catchingUp = cause == PerfCause::GpuStarved && window.backlog >= encoderQueueFrames(texturePath) &&
                            gpuSample.available && gpuSample.engine3d < kGpuBusyPercent;
    const std::string hint = perfCauseHint(cause, priorityActive, catchingUp);
    const double backlogMs = fps > 0 ? rounded(window.backlog * 1000.0 / fps, 1.0) : 0.0;
    nlohmann::json gpuJson = {{"available", gpuSample.available}};
    if (gpuSample.available) {
      gpuJson["engine3d"] = rounded(gpuSample.engine3d);
      gpuJson["videoEncode"] = rounded(gpuSample.videoEncode);
      gpuJson["copy"] = rounded(gpuSample.copy);
      gpuJson["game3d"] = gameTarget ? nlohmann::json(rounded(gpuSample.target3d)) : nlohmann::json(nullptr);
      gpuJson["shard3d"] = rounded(gpuSample.self3d);
      gpuJson["shardEncode"] = rounded(gpuSample.selfEncode);
      gpuJson["top3dPid"] = gpuSample.top3dPid;
      gpuJson["top3d"] = rounded(gpuSample.top3d);
    }
    latest_ = {{"t", unixMs()},
               {"active", outputsActive},
               {"fps", rounded(fps, 100.0)},
               {"frameTimeMs", rounded(frameTimeMs, 100.0)},
               {"rendered", second.rendered},
               {"lagged", second.lagged},
               {"encoded", second.encoded},
               {"skipped", second.repeated},
               {"stalled", second.stalled},
               {"backlogMs", backlogMs},
               {"renderLagPct", percentOf(window.lagged, window.rendered)},
               {"lostPct", percentOf(window.lagged + window.stalled, window.rendered)},
               {"encoderSkipPct", percentOf(window.repeated, window.encoded)},
               {"gpu", gpuJson},
               {"cause", perfCauseName(cause)},
               {"hint", hint.empty() ? nlohmann::json(nullptr) : nlohmann::json(hint)}};
    events_.emit("perf.stats", latest_);

    const auto gpuText = [&] {
      std::ostringstream text;
      if (!gpuSample.available)
        return std::string(" gpu_engines=unavailable");
      text << " gpu_3d=" << rounded(gpuSample.engine3d) << " gpu_encode=" << rounded(gpuSample.videoEncode)
           << " game_3d=" << (gameTarget ? std::to_string(int(gpuSample.target3d + 0.5)) : std::string("n/a"))
           << " shard_3d=" << rounded(gpuSample.self3d) << " top_3d_pid=" << gpuSample.top3dPid
           << " top_3d=" << rounded(gpuSample.top3d);
      return text.str();
    };
    if (cause != cause_) {
      std::ostringstream line;
      if (cause == PerfCause::Ok) {
        line << "[perf][info] cause=ok previous=" << perfCauseName(cause_)
             << " duration_ms=" << (now - causeSinceUs_) / 1000;
      } else {
        line << "[perf][warn] cause=" << perfCauseName(cause) << " previous=" << perfCauseName(cause_);
      }
      line << " render_lag_pct=" << percentOf(window.lagged, window.rendered)
           << " lost_pct=" << percentOf(window.lagged + window.stalled, window.rendered)
           << " encoder_skip_pct=" << percentOf(window.repeated, window.encoded) << " backlog_ms=" << backlogMs
           << " fps=" << rounded(fps, 100.0) << " frame_time_ms=" << rounded(frameTimeMs, 100.0) << gpuText();
      if (!hint.empty())
        line << " hint=\"" << hint << "\"";
      logLine(line.str());
      cause_ = cause;
      causeSinceUs_ = now;
    }
    if (outputsActive && now - lastHeartbeatUs >= kHeartbeatUs) {
      const WindowTotals heartbeat = totalsOf(slices_, kHeartbeatUs / 250000);
      std::ostringstream line;
      line << "[perf][info] heartbeat window_s=30 rendered=" << heartbeat.rendered
           << " lagged=" << heartbeat.lagged << " stalled=" << heartbeat.stalled << " encoded=" << heartbeat.encoded
           << " repeated=" << heartbeat.repeated << " backlog_ms=" << backlogMs << " cause=" << perfCauseName(cause)
           << " fps=" << rounded(fps, 100.0) << " frame_time_ms=" << rounded(frameTimeMs, 100.0) << gpuText();
      logLine(line.str());
      lastHeartbeatUs = now;
    }
  }
}

} // namespace shard
