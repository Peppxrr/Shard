#include "replay_ring.h"

#include "log.h"
#include "mux.h"
#include "perf_monitor.h"
#include "priority_task.h"
#include "replay_timing.h"

#include <obs-av1.h>
#include <cmath>
#include <obs-module.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <vector>

namespace shard {

namespace fs = std::filesystem;

using namespace std::chrono;

struct ReplayRing::Ring {
  obs_output_t* output = nullptr;
  ReplayRing* owner = nullptr; // set by ReplayRing::start via the live registry
  std::mutex mtx;
  std::condition_variable packetCv;
  std::deque<struct encoder_packet> packets;
  int64_t cur_size = 0;
  int64_t cur_time = 0;
  int64_t latest_time = 0;
  // Newest video timestamp. Video can trail audio by seconds while a
  // starved encoder works through libobs' backlog.
  int64_t latest_video_time = 0;
  int64_t latest_ingest_us = 0;
  // Smallest (arrival steady time - dts) seen for video this output session:
  // the pipeline delay without a backlog. Packets arrive later than this
  // while a starved encoder works through libobs' queue, and libobs' output
  // interleaver then holds audio back as well, so "newest packet + time since
  // it arrived" no longer describes the present.
  int64_t video_delivery_offset_us = INT64_MAX;
  int keyframes = 0;
  int64_t max_size = 0; // bytes
  int64_t max_time = 0; // usec
  bool active = false;
};

namespace {

// ringCreate runs inside obs_output_create, before ReplayRing::start can
// attach the owner. New Ring* land here; start() claims the one matching its
// output. ringDestroy erases defensively.
std::mutex g_liveRingsMtx;
constexpr int64_t kDecodePrerollUs = 2000000LL;
std::vector<ReplayRing::Ring*> g_liveRings;

} // namespace

// ---------------------------------------------------------------------------
// Output type registration ("shard_ring")
// ---------------------------------------------------------------------------

const char* ReplayRing::ringGetName(void* /*type*/)
{
  return "Shard Replay Ring";
}

void* ReplayRing::ringCreate(obs_data_t* /*settings*/, obs_output_t* output)
{
  auto* r = new Ring();
  r->output = output;
  {
    std::lock_guard<std::mutex> lock(g_liveRingsMtx);
    g_liveRings.push_back(r);
  }
  return r;
}

void ReplayRing::ringDestroy(void* data)
{
  auto* r = static_cast<Ring*>(data);
  if (!r)
    return;
  {
    std::lock_guard<std::mutex> lock(g_liveRingsMtx);
    auto it = std::find(g_liveRings.begin(), g_liveRings.end(), r);
    if (it != g_liveRings.end())
      g_liveRings.erase(it);
  }
  for (auto& p : r->packets)
    obs_encoder_packet_release(&p);
  r->packets.clear();
  delete r;
}

bool ReplayRing::ringStart(void* data)
{
  auto* r = static_cast<Ring*>(data);
  if (!r)
    return false;

  if (!obs_output_can_begin_data_capture(r->output, 0))
    return false;
  if (!obs_output_initialize_encoders(r->output, 0))
    return false;

  obs_data_t* s = obs_output_get_settings(r->output);
  int64_t max_time_sec = obs_data_get_int(s, "max_time_sec");
  int64_t max_size_mb = obs_data_get_int(s, "max_size_mb");
  obs_data_release(s);

  {
    std::lock_guard<std::mutex> lock(r->mtx);
    // Retain one GOP beyond the user-visible history so exact-duration saves
    // have a preceding decode keyframe without sacrificing requested seconds.
    r->max_time = max_time_sec * 1000000LL + kDecodePrerollUs;
    r->max_size = max_size_mb * (1024 * 1024);
    r->cur_size = 0;
    r->cur_time = 0;
    r->latest_time = 0;
    r->latest_video_time = 0;
    r->video_delivery_offset_us = INT64_MAX;
    r->latest_ingest_us = 0;
    r->keyframes = 0;
    r->active = true;
  }

  obs_output_begin_data_capture(r->output, 0);
  return true;
}

void ReplayRing::ringStop(void* data, uint64_t /*ts*/)
{
  auto* r = static_cast<Ring*>(data);
  if (!r)
    return;
  {
    std::lock_guard<std::mutex> lock(r->mtx);
    r->active = false;
  }
  r->packetCv.notify_all();
  obs_output_end_data_capture(r->output);
}

void ReplayRing::ringDefaults(obs_data_t* s)
{
  obs_data_set_default_int(s, "max_time_sec", 600);
  obs_data_set_default_int(s, "max_size_mb", 2048);
}

void ReplayRing::ringData(void* data, struct encoder_packet* packet)
{
  auto* r = static_cast<Ring*>(data);
  if (!r || !r->owner)
    return;
  r->owner->ingestPacket(r, packet);
}

// ---------------------------------------------------------------------------
// ReplayRing
// ---------------------------------------------------------------------------

ReplayRing::ReplayRing(App& app, Config& config, Events& events, EncoderManager& encoders)
    : app_(app), config_(config), events_(events), encoders_(encoders)
{
}

ReplayRing::~ReplayRing()
{
  stop();
}

bool ReplayRing::start()
{
  std::lock_guard<std::mutex> lock(lifecycleMtx_);
  return startLocked();
}

void ReplayRing::stop()
{
  std::lock_guard<std::mutex> lock(lifecycleMtx_);
  stopLocked();
}

void ReplayRing::restart()
{
  std::lock_guard<std::mutex> lock(lifecycleMtx_);
  stopLocked();
  startLocked();
}

void ReplayRing::setCaptureActive(bool active)
{
  std::lock_guard<std::mutex> lock(lifecycleMtx_);
  if (active && !active_.load()) startLocked();
  const auto nowMs = duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
  if (activityGrace_.shouldStop(active, active_.load(), nowMs)) {
    logFormat("[replay-ring][info] action=stop reason=capture_inactive grace_ms=15000 history_cleared=true\n");
    stopLocked();
  }
}

bool ReplayRing::startLocked()
{
  if (active_.load())
    return true;
  activityGrace_.reset();

  static bool registered = false;
  if (!registered) {
    struct obs_output_info ring = {};
    ring.id = "shard_ring";
    ring.flags = OBS_OUTPUT_AV | OBS_OUTPUT_ENCODED | OBS_OUTPUT_MULTI_TRACK;
    ring.get_name = ringGetName;
    ring.create = ringCreate;
    ring.destroy = ringDestroy;
    ring.start = ringStart;
    ring.stop = ringStop;
    ring.encoded_packet = ringData;
    ring.get_defaults = ringDefaults;
    obs_register_output(&ring);
    registered = true;
  }

  const auto candidates = encoders_.videoEncoderCandidates(config_.video.encoder);
  for (const auto& videoId : candidates) {
    if (startWithVideoEncoderLocked(videoId)) {
      logFormat("[encoder][info] replay ring using %s\n", videoId.c_str());
      return true;
    }
    logFormat("[encoder] replay ring rejected %s; trying fallback\n", videoId.c_str());
  }
  events_.emit("error", {{"code", "ENCODER_FAIL"}, {"message", "No supported video encoder could start the replay ring"}});
  return false;
}

bool ReplayRing::startWithVideoEncoderLocked(const std::string& videoId)
{
  obs_data_t* videoSettings = encoders_.videoSettings(videoId);
  videoEncoder_ = obs_video_encoder_create(videoId.c_str(), "ring-video", videoSettings, nullptr);
  obs_data_release(videoSettings);
  if (!videoEncoder_)
    return false;

  const char* codec = obs_encoder_get_codec(videoEncoder_);
  videoCodec_ = codec ? codec : "";

  // Allocate one encoder for each configured row, even while that row is
  // disabled. Its stable mix can then be silenced/re-enabled live without
  // restarting this output and discarding the replay buffer.
  const int audioTracks = 1 + std::min(static_cast<int>(config_.audioSources.size()), 5);
  for (int track = 0; track < audioTracks; track++) {
    char name[32];
    std::snprintf(name, sizeof(name), "ring-audio-%d", track);
    obs_data_t* audioSettings = encoders_.audioSettings();
    obs_encoder_t* aenc = obs_audio_encoder_create("ffmpeg_aac", name, audioSettings, track, nullptr);
    obs_data_release(audioSettings);
    if (!aenc) {
      stopLocked();
      return false;
    }
    obs_encoder_set_audio(aenc, obs_get_audio());
    audioEncoders_.push_back(aenc);
  }

  obs_data_t* s = obs_data_create();
  obs_data_set_int(s, "max_time_sec", config_.replay.maxSeconds);
  obs_data_set_int(s, "max_size_mb", config_.replay.maxMb);

  output_ = obs_output_create("shard_ring", "replay-ring", s, nullptr);
  obs_data_release(s);
  if (!output_) {
    stopLocked();
    return false;
  }

  // Claim the Ring instance created by ringCreate for this output.
  {
    std::lock_guard<std::mutex> lock(g_liveRingsMtx);
    for (auto it = g_liveRings.begin(); it != g_liveRings.end(); ++it) {
      if ((*it)->output == output_) {
        ring_ = *it;
        g_liveRings.erase(it);
        break;
      }
    }
  }
  if (!ring_) {
    stopLocked();
    return false;
  }
  ring_->owner = this;

  obs_output_set_video_encoder(output_, videoEncoder_);
  for (size_t track = 0; track < audioEncoders_.size(); track++)
    obs_output_set_audio_encoder(output_, audioEncoders_[track], (size_t)track);
  // Encoded outputs refuse obs_output_set_media; attach the global media to
  // the encoders directly (same pattern as the OBS frontend).
  obs_encoder_set_video(videoEncoder_, obs_get_video());

  // The worker waits for requests; they are accepted only once the output
  // has started (saves_.accept() below).
  saves_.begin();
  saveThread_ = std::thread([this] { saveWorker(); });

  // Encoder plugins initialize inside obs_output_start; capture their
  // messages to see whether a texture encoder fell back to system memory.
  ObsLogCapture startLog;
  if (!obs_output_start(output_)) {
    stopLocked();
    return false;
  }

  logFormat("[encoder] replay ring using %s\n", videoId.c_str());
  if (perf_)
    perf_->outputStarted(inspectVideoEncoderPath("replay", videoEncoder_, startLog.messages()));
  active_.store(true);
  saves_.accept();
  return true;
}

void ReplayRing::stopLocked()
{
  // Stops acceptance and lets the worker finish every accepted request (with
  // the ring still intact) before the output is torn down.
  saves_.close();
  if (saveThread_.joinable())
    saveThread_.join();

  ring_ = nullptr; // released together with output_ below (ringDestroy frees it)

  if (output_) {
    if (obs_output_active(output_))
      obs_output_stop(output_);
    obs_output_release(output_);
    output_ = nullptr;
  }
  if (videoEncoder_) {
    obs_encoder_release(videoEncoder_);
    videoEncoder_ = nullptr;
  }
  for (auto* e : audioEncoders_) {
    obs_encoder_release(e);
  }
  audioEncoders_.clear();
  active_.store(false);
}
void ReplayRing::updateCaps()
{
  std::lock_guard<std::mutex> lifecycleLock(lifecycleMtx_);
  if (!ring_)
    return;
  std::lock_guard<std::mutex> ringLock(ring_->mtx);
  ring_->max_time = (int64_t)config_.replay.maxSeconds * 1000000LL + kDecodePrerollUs;
  ring_->max_size = (int64_t)config_.replay.maxMb * 1024 * 1024;
  while (!ring_->packets.empty() && ring_->keyframes > 2 &&
         ((ring_->max_size > 0 && ring_->cur_size > ring_->max_size) ||
          (ring_->max_time > 0 && ring_->latest_time - ring_->cur_time > ring_->max_time))) {
    purge(ring_);
  }
}

void ReplayRing::getStats(int& secondsBuffered, double& mbUsed) const
{
  secondsBuffered = 0;
  mbUsed = 0;
  std::lock_guard<std::mutex> lifecycleLock(lifecycleMtx_);
  if (!ring_)
    return;
  std::lock_guard<std::mutex> lock(ring_->mtx);
  if (ring_->packets.empty())
    return;
  const int64_t first = ring_->packets.front().dts_usec;
  const int64_t last = ring_->latest_time;
  const int measured = static_cast<int>(std::llround((last - first) / 1000000.0));
  secondsBuffered = std::min(config_.replay.maxSeconds, measured);
  mbUsed = (double)ring_->cur_size / (1024.0 * 1024.0);
}

uint64_t ReplayRing::save(int durationSec)
{
  SaveRequest request;
  request.durationSec = durationSec;
  request.requestSteadyUs = PerfMonitor::nowUs();
  {
    std::lock_guard<std::mutex> lifecycleLock(lifecycleMtx_);
    if (ring_) {
      std::lock_guard<std::mutex> ringLock(ring_->mtx);
      if (!ring_->packets.empty()) {
        const int64_t nowUs = static_cast<int64_t>(request.requestSteadyUs);
        if (ring_->video_delivery_offset_us != INT64_MAX) {
          request.endTimeUs = nowUs - ring_->video_delivery_offset_us;
        } else {
          const int64_t elapsedUs = std::max<int64_t>(0, nowUs - ring_->latest_ingest_us);
          request.endTimeUs = ring_->latest_time + elapsedUs;
        }
      }
    }
  }
  // Accepted only while the ring is active and its worker runs; a rejected
  // request is never queued. "clip.queued" is emitted inside the queue's lock,
  // before the worker can report this request's result.
  const uint64_t id = saves_.submit(request, [&](const SaveRequest& queued, size_t depth) {
    logFormat("save: queued request=%llu %d at %lld (depth %zu)\n", static_cast<unsigned long long>(queued.id),
              durationSec, (long long)queued.endTimeUs, depth);
    events_.emit("clip.queued", {{"request", queued.id}, {"requestedSec", durationSec}, {"depth", depth}});
  });
  if (!id)
    logFormat("save: REJECTED %d (replay buffer not running)\n", durationSec);
  return id;
}

// ---------------------------------------------------------------------------
// Packet ingestion (encoder thread)
// ---------------------------------------------------------------------------

void ReplayRing::ingestPacket(Ring* r, struct encoder_packet* packet)
{
  if (!packet) {
    // encoder failure
    events_.emit("error", {{"code", "ENCODER_FAIL"}, {"message", "Replay ring encoder failed"}});
    return;
  }

  std::lock_guard<std::mutex> lock(r->mtx);
  if (!r->active)
    return;

  // Purge over caps (byte cap then time cap), keeping >= 2 keyframes so the
  // ring always starts on a keyframe and never thrashes.
  if (r->max_size > 0 && !r->packets.empty() && r->keyframes > 2) {
    while (replayCanPurge(r->packets.empty(), r->keyframes) &&
           r->cur_size + (int64_t)packet->size > r->max_size)
      purge(r);
  }
  if (!r->packets.empty() && r->keyframes > 2) {
    const int64_t latestWithPacket = std::max(r->latest_time, packet->dts_usec);
    while (replayCanPurge(r->packets.empty(), r->keyframes) &&
           latestWithPacket - r->cur_time > r->max_time)
      purge(r);
  }

  struct encoder_packet pkt;
  obs_encoder_packet_ref(&pkt, packet);

  // NVENC AV1 reports keyframes as non-IDR picture types, so the encoder's
  // keyframe flag is never set; parse the OBU stream instead. Without this
  // the ring never purges (whole buffer saved) and snapshots start mid-GOP
  // (undecodable clips).
  if (pkt.type == OBS_ENCODER_VIDEO && videoCodec_ == "av1")
    pkt.keyframe = obs_av1_keyframe(pkt.data, pkt.size);

  if (r->packets.empty())
    r->cur_time = pkt.dts_usec;
  r->cur_size += pkt.size;
  r->latest_time = std::max(r->latest_time, pkt.dts_usec);
  if (pkt.type == OBS_ENCODER_VIDEO)
    r->latest_video_time = std::max(r->latest_video_time, pkt.dts_usec);

  r->latest_ingest_us = duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count();
  if (pkt.type == OBS_ENCODER_VIDEO)
    r->video_delivery_offset_us = std::min(r->video_delivery_offset_us, r->latest_ingest_us - pkt.dts_usec);
  r->packetCv.notify_all();
  r->packets.push_back(pkt);
  if (pkt.type == OBS_ENCODER_VIDEO && pkt.keyframe)
    r->keyframes++;
}

void ReplayRing::purge(Ring* r)
{
  // Encoder callbacks own their output's Ring until OBS finishes stopping it.
  // Never follow owner->ring_ here: teardown clears it and a restart may replace
  // it while an old callback is still draining.
  // Purge the front packet; if it was a keyframe, keep purging until the
  // next keyframe so the ring always opens on a keyframe.
  if (!purgeFront(r))
    return;
  while (!r->packets.empty()) {
    const auto& front = r->packets.front();
    if (front.type == OBS_ENCODER_VIDEO && front.keyframe)
      return;
    purgeFront(r);
  }
}

bool ReplayRing::purgeFront(Ring* r)
{
  if (!r || r->packets.empty())
    return false;

  auto& pkt = r->packets.front();
  bool keyframe = pkt.type == OBS_ENCODER_VIDEO && pkt.keyframe;
  if (keyframe)
    r->keyframes--;

  int64_t removed = pkt.size;
  r->cur_size -= removed;
  if (r->cur_size < 0)
    r->cur_size = 0;

  obs_encoder_packet_release(&pkt);
  r->packets.pop_front();

  if (r->packets.empty()) {
    r->cur_size = 0;
    r->latest_time = 0;
    r->latest_video_time = 0;
    r->cur_time = 0;
    r->latest_ingest_us = 0;
  } else {
    r->cur_time = r->packets.front().dts_usec;
  }
  return keyframe;
}

// ---------------------------------------------------------------------------
// Save worker (serialized)
// ---------------------------------------------------------------------------

void ReplayRing::saveWorker()
{
  logFormat("save: worker started\n");
  while (const auto next = saves_.next()) {
    const SaveRequest& request = *next;

    if (!active_.load() || muxing_.load()) {
      logFormat("save: DROPPED request (active=%d muxing=%d)\n", active_.load() ? 1 : 0, muxing_.load() ? 1 : 0);
      // Defensive: stopLocked() drains accepted requests while the ring is
      // still active. Still end the request without a user-facing error.
      events_.emit("clip.dropped", {{"request", request.id}});
      continue;
    }

    // An elevated core (Recording priority) writes only where the user's own
    // non-elevated account could, so the RPC-configurable folder cannot be
    // used to create files in protected locations.
    if (!interactiveUserCanWrite(config_.clipsDir.c_str())) {
      logFormat("save: REFUSED clips folder not writable by the interactive user: %s", config_.clipsDir.c_str());
      events_.emit("error", {{"code", "STORAGE_DENIED"}, {"request", request.id},
                             {"message", "Your Windows account can't write to the clips folder: " + config_.clipsDir}});
      continue;
    }

    std::vector<encoder_packet> packets;
    std::string path;
    double actualSec = 0;
    uint64_t startSteadyUs = 0, endSteadyUs = 0;
    if (!snapshotSave(request, packets, path, actualSec, startSteadyUs, endSteadyUs)) {
      events_.emit("error", {{"code", "ENCODER_FAIL"}, {"request", request.id}, {"message", "Replay ring save failed (ring empty?)"}});
      continue;
    }

    bool success = false;
    std::string error;
    logFormat("save: snapshot %zu packets -> %s\n", packets.size(), path.c_str());
    muxing_.store(true);
    muxToFile(packets, path, success, error);
    muxing_.store(false);
    logFormat("save: mux %s (success=%d err=%s)\n", path.c_str(), success ? 1 : 0, error.c_str());

    for (auto& p : packets)
      obs_encoder_packet_release(&p);

    if (success) {
      nlohmann::json saved = {{"request", request.id}, {"path", path}, {"requestedSec", request.durationSec}, {"actualSec", actualSec}};
      // Where libobs lost frames inside this clip (render lag / encoder
      // skips), as seconds from the clip's first presented frame.
      if (perf_) {
        nlohmann::json lag = perf_->lagJson(startSteadyUs, endSteadyUs);
        if (!lag.is_null()) {
          logFormat("save: lag %s frames=%u lagged=%u skipped=%u segments=%zu cause=%s", path.c_str(),
                    lag.value("frames", 0u), lag.value("lagged", 0u), lag.value("skipped", 0u),
                    lag["segments"].size(), lag.value("cause", std::string("ok")).c_str());
          saved["lag"] = std::move(lag);
        }
      }
      events_.emit("clip.saved", saved);
    } else {
      events_.emit("error", {{"code", "ENCODER_FAIL"}, {"request", request.id}, {"message", "Save failed: " + error + " (" + path + ")"}});
    }
  }
}

void ReplayRing::muxToFile(const std::vector<encoder_packet>& packets, const std::string& path, bool& success,
                           std::string& error)
{
  FfmpegMuxWriter writer(output_, config_.coreBinDir);
  if (!writer.start(path, "-movflags frag_keyframe+empty_moov use_editlist=1")) {
    error = writer.lastError();
    success = false;
    return;
  }
  if (!writer.sendHeaders()) {
    error = "failed to write codec headers";
    writer.close();
    success = false;
    return;
  }
  for (const auto& p : packets) {
    if (!writer.writePacket(const_cast<encoder_packet*>(&p))) {
      error = writer.lastError();
      writer.close();
      success = false;
      return;
    }
  }
  writer.close();
  success = true;
}

bool ReplayRing::snapshotSave(const SaveRequest& request, std::vector<encoder_packet>& out, std::string& path, double& actualSec,
                              uint64_t& startSteadyUs, uint64_t& endSteadyUs)
{
  if (!ring_ || request.endTimeUs <= 0)
    return false;
  Ring* r = ring_;
  std::unique_lock<std::mutex> lock(r->mtx);
  if (r->packets.empty())
    return false;

  // Encoder callbacks trail capture by a small, variable pipeline delay.
  // save() maps the hotkey's steady-clock moment onto the media timeline; wait
  // for that frame/audio to arrive instead of cutting at the latest packet
  // that happened to be encoded when the key was pressed. When a GPU-starved
  // texture encoder has fallen behind, libobs encodes the queued frames once
  // it catches up while audio stays current: keep waiting as long as video is
  // still arriving, so the clip contains the requested moment.
  constexpr auto kMaxEncoderCatchUp = seconds(30);
  constexpr auto kNoVideoProgress = seconds(2);
  const auto waitStart = steady_clock::now();
  auto lastProgress = waitStart;
  int64_t observedVideo = r->latest_video_time;
  while (r->active && (r->latest_time < request.endTimeUs || r->latest_video_time < request.endTimeUs)) {
    const auto now = steady_clock::now();
    if (now - waitStart >= kMaxEncoderCatchUp || now - lastProgress >= kNoVideoProgress)
      break;
    r->packetCv.wait_for(lock, milliseconds(100));
    if (r->latest_video_time != observedVideo) {
      observedVideo = r->latest_video_time;
      lastProgress = steady_clock::now();
    }
  }
  const int64_t waitedMs = duration_cast<milliseconds>(steady_clock::now() - waitStart).count();
  // Never end after the newest video: audio over a frozen or missing picture
  // is worse than a slightly shorter clip.
  const int64_t newestVideo = r->latest_video_time > 0 ? r->latest_video_time : r->latest_time;
  const int64_t end_time = std::min({request.endTimeUs, r->latest_time, newestVideo});
  if (waitedMs >= 1000 || request.endTimeUs - end_time >= 500000)
    logFormat("save: video encoder catch-up waited_ms=%lld clip_end_short_ms=%lld",
              static_cast<long long>(waitedMs), static_cast<long long>((request.endTimeUs - end_time) / 1000));
  const int64_t start_time = request.durationSec > 0
      ? end_time - (int64_t)request.durationSec * 1000000LL
      : r->packets.front().dts_usec;
  const size_t n = r->packets.size();
  // Select by each stream's own timestamps, not deque position: after a
  // backlog, video arrives seconds after audio of the same moment. Video
  // starts at the newest keyframe presented at or before the start (decode-
  // only preroll; its timestamp stays negative so the MP4 edit list presents
  // exactly the requested interval) or at the first keyframe after it.
  size_t keyframe = n;
  for (size_t i = 0; i < n; ++i) {
    const auto& p = r->packets[i];
    if (p.type != OBS_ENCODER_VIDEO || !p.keyframe)
      continue;
    const bool beforeStart = request.durationSec > 0 && replayRescale(p.pts, p.timebase_den, 1000000) <= start_time;
    if (keyframe == n || beforeStart)
      keyframe = i;
    if (!beforeStart)
      break;
  }
  if (keyframe >= n)
    return false;

  // obs-ffmpeg-mux interprets pts/dts in each stream timebase. Normalize to a
  // shared presentation start, retaining negative keyframe preroll, then
  // convert back to the stream timebase.
  const struct video_output_info* voi = video_output_get_info(obs_get_video());
  const int64_t videoTb = voi ? voi->fps_num : 60;
  audio_t* obsAudio = obs_get_audio();
  const int64_t audioTb = obsAudio ? audio_output_get_sample_rate(obsAudio) : 48000;

  const int64_t audioPacketUs = !audioEncoders_.empty()
      ? (int64_t)obs_encoder_get_frame_size(audioEncoders_.front()) * 1000000 / audioTb
      : 0;
  const int64_t first_dts = r->packets[keyframe].dts_usec;
  const int64_t presentation_start = request.durationSec > 0 ? std::max(start_time, first_dts) : first_dts;

  out.clear();
  out.reserve(n);
  bool videoEndReached = false;
  for (size_t i = 0; i < n; i++) {
    const auto& pkt = r->packets[i];
    if (pkt.type == OBS_ENCODER_VIDEO ? i < keyframe : pkt.dts_usec < first_dts)
      continue;
    if (pkt.type == OBS_ENCODER_VIDEO) {
      // Decode order can put a future reference frame before earlier B-frames.
      // End at the last complete reference group inside the requested interval;
      // dropping only that future P-frame leaves undecodable dependent B-frames.
      // Audio still reaches the requested endpoint (video may end a few frames
      // earlier, according to the encoder's reorder depth).
      if (replayRescale(pkt.pts, pkt.timebase_den, 1000000) >= end_time)
        videoEndReached = true;
      if (videoEndReached)
        continue;
    }
    if (pkt.dts_usec >= end_time)
      continue;
    if (pkt.type == OBS_ENCODER_AUDIO && audioPacketUs > 0 && pkt.dts_usec + audioPacketUs > end_time) {
      const int64_t overshoot = pkt.dts_usec + audioPacketUs - end_time;
      const int64_t undershoot = end_time - pkt.dts_usec;
      if (overshoot > undershoot)
        continue;
    }
    encoder_packet p;
    obs_encoder_packet_ref(&p, const_cast<encoder_packet*>(&pkt));

    // Preserve encoder decode/presentation ordering and real timing gaps.
    // Rebuilding slots from rounded microseconds caused duplicate DTS, and
    // assigning PTS=DTS discarded the B-frame composition offsets.
    const int64_t targetTb = p.type == OBS_ENCODER_VIDEO ? videoTb : audioTb;
    const auto timing = replayTimestamps(p.pts, p.dts, p.timebase_den, targetTb, presentation_start);
    p.pts = timing.pts;
    p.dts = timing.dts;
    p.dts_usec = replayRescale(p.dts, targetTb, 1000000);
    p.timebase_den = (uint32_t)targetTb;
    out.push_back(p);
  }

  // No filesystem work while blocking OBS's encoder callbacks.
  lock.unlock();

  actualSec = (end_time - presentation_start) / 1000000.0;
  if (actualSec < 0)
    actualSec = 0;
  // save() mapped the request's steady-clock moment to request.endTimeUs on
  // the media timeline; apply the same offset to the clip's actual bounds.
  endSteadyUs = request.requestSteadyUs - static_cast<uint64_t>(std::max<int64_t>(0, request.endTimeUs - end_time));
  startSteadyUs = endSteadyUs - static_cast<uint64_t>(std::max<int64_t>(0, end_time - presentation_start));

  // Unique filename: clip-YYYYMMDD-HHMMSS-<microsec>.mp4
  auto now = system_clock::now();
  std::time_t t = system_clock::to_time_t(now);
  std::tm tm{};
#ifdef _WIN32
  localtime_s(&tm, &t);
#else
  localtime_r(&t, &tm);
#endif
  auto us = duration_cast<microseconds>(now.time_since_epoch()).count() % 1000000;
  char name[128];
  std::snprintf(name, sizeof(name), "clip-%04d%02d%02d-%02d%02d%02d-%06lld.mp4", tm.tm_year + 1900, tm.tm_mon + 1,
                tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, (long long)us);

  fs::create_directories(config_.clipsDir);
  path = (fs::path(config_.clipsDir) / name).string();
  return true;
}

} // namespace shard
