#include "replay_ring.h"

#include "mux.h"
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
  int64_t latest_ingest_us = 0;
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
  const auto now = steady_clock::now();
  if (active) {
    sawActivity_ = true;
    inactiveSince_ = steady_clock::time_point{};
    if (!active_.load())
      startLocked();
  } else if (!active_.load()) {
    // Already idle; keep the timer clear so a later stop gets a fresh window.
    inactiveSince_ = steady_clock::time_point{};
  } else if (!sawActivity_) {
    // Eagerly started (boot or config restart) but the watchdog has never
    // seen healthy capture: nothing valuable is buffered, so stop now rather
    // than buffering dead frames through the grace period.
    stopLocked();
  } else {
    if (inactiveSince_ == steady_clock::time_point{}) {
      inactiveSince_ = now;
    } else if (now - inactiveSince_ >= seconds(15)) {
      // Safety margin elapsed: stop buffering and free the RAM.
      stopLocked();
    }
  }
}

bool ReplayRing::startLocked()
{
  if (active_.load())
    return true;
  sawActivity_ = false;

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
    if (startWithVideoEncoderLocked(videoId))
      return true;
    std::fprintf(stderr, "[encoder] replay ring rejected %s; trying fallback\n", videoId.c_str());
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

  // A previous stop() (restart) leaves this false; re-arm before the worker.
  saveThreadRun_.store(true);
  saveThread_ = std::thread([this] { saveWorker(); });

  if (!obs_output_start(output_)) {
    stopLocked();
    return false;
  }

  std::fprintf(stderr, "[encoder] replay ring using %s\n", videoId.c_str());
  active_.store(true);
  return true;
}

void ReplayRing::stopLocked()
{
  if (saveThreadRun_.exchange(false)) {
    saveCv_.notify_all();
    if (saveThread_.joinable())
      saveThread_.join();
  }

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

void ReplayRing::save(int durationSec)
{
  SaveRequest request;
  request.durationSec = durationSec;
  {
    std::lock_guard<std::mutex> lifecycleLock(lifecycleMtx_);
    if (ring_) {
      std::lock_guard<std::mutex> ringLock(ring_->mtx);
      if (!ring_->packets.empty()) {
        const int64_t nowUs = duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count();
        const int64_t elapsedUs = std::max<int64_t>(0, nowUs - ring_->latest_ingest_us);
        request.endTimeUs = ring_->latest_time + elapsedUs;
      }
    }
  }
  {
    std::lock_guard<std::mutex> lock(saveMtx_);
    saveQueue_.push_back(request);
    std::fprintf(stderr, "save: queued %d at %lld (depth %zu)\n", durationSec,
                 (long long)request.endTimeUs, saveQueue_.size());
    std::fflush(stderr);
  }
  saveCv_.notify_one();
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

  r->latest_ingest_us = duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count();
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
  std::fprintf(stderr, "save: worker started\n");
  std::fflush(stderr);
  for (;;) {
    SaveRequest request;
    request.durationSec = -1;
    {
      std::unique_lock<std::mutex> lock(saveMtx_);
      saveCv_.wait(lock, [&] { return !saveThreadRun_.load() || !saveQueue_.empty(); });
      if (!saveThreadRun_.load() && saveQueue_.empty())
        break;
      if (!saveQueue_.empty()) {
        request = saveQueue_.front();
        saveQueue_.pop_front();
      }
    }
    if (request.durationSec < 0)
      continue;

    if (!active_.load() || muxing_.load()) {
      std::fprintf(stderr, "save: DROPPED request (active=%d muxing=%d)\n", active_.load() ? 1 : 0, muxing_.load() ? 1 : 0);
      std::fflush(stderr);
      continue; // ring not running; drop the request
    }

    std::vector<encoder_packet> packets;
    std::string path;
    double actualSec = 0;
    if (!snapshotSave(request, packets, path, actualSec)) {
      events_.emit("error", {{"code", "ENCODER_FAIL"}, {"message", "Replay ring save failed (ring empty?)"}});
      continue;
    }

    bool success = false;
    std::string error;
    std::fprintf(stderr, "save: snapshot %zu packets -> %s\n", packets.size(), path.c_str());
    std::fflush(stderr);
    muxing_.store(true);
    muxToFile(packets, path, success, error);
    muxing_.store(false);
    std::fprintf(stderr, "save: mux %s (success=%d err=%s)\n", path.c_str(), success ? 1 : 0, error.c_str());
    std::fflush(stderr);

    for (auto& p : packets)
      obs_encoder_packet_release(&p);

    if (success) {
      events_.emit("clip.saved", {{"path", path}, {"requestedSec", request.durationSec}, {"actualSec", actualSec}});
    } else {
      events_.emit("error", {{"code", "ENCODER_FAIL"}, {"message", "Save failed: " + error + " (" + path + ")"}});
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

bool ReplayRing::snapshotSave(const SaveRequest& request, std::vector<encoder_packet>& out, std::string& path, double& actualSec)
{
  if (!ring_ || request.endTimeUs <= 0)
    return false;
  Ring* r = ring_;
  std::unique_lock<std::mutex> lock(r->mtx);
  if (r->packets.empty())
    return false;

  // Encoder callbacks trail capture by a small, variable pipeline delay.
  // save() maps the hotkey's steady-clock moment onto the media timeline; wait
  // briefly for that frame/audio to arrive instead of cutting at the latest
  // packet that happened to be encoded when the key was pressed.
  r->packetCv.wait_for(lock, milliseconds(2000), [&] {
    return !r->active || r->latest_time >= request.endTimeUs;
  });
  const int64_t end_time = std::min(request.endTimeUs, r->latest_time);
  const int64_t start_time = request.durationSec > 0
      ? end_time - (int64_t)request.durationSec * 1000000LL
      : r->packets.front().dts_usec;
  const size_t n = r->packets.size();
  size_t begin = 0;
  if (request.durationSec > 0) {
    while (begin < n && r->packets[begin].dts_usec < start_time)
      begin++;
    // Include the preceding video keyframe as decode-only preroll. Its
    // timestamp remains negative, so the MP4 edit list presents exactly the
    // requested interval without losing the newest seconds.
    while (begin > 0) {
      const auto& p = r->packets[begin - 1];
      if (p.type == OBS_ENCODER_VIDEO && p.keyframe)
        break;
      begin--;
    }
    if (begin > 0 && r->packets[begin - 1].type == OBS_ENCODER_VIDEO && r->packets[begin - 1].keyframe)
      begin--;
  }
  if (begin >= n)
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
  const int64_t first_dts = r->packets[begin].dts_usec;
  const int64_t presentation_start = request.durationSec > 0 ? std::max(start_time, first_dts) : first_dts;

  out.clear();
  out.reserve(n - begin);
  bool videoEndReached = false;
  for (size_t i = begin; i < n; i++) {
    const auto& pkt = r->packets[i];
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
