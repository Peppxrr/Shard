#pragma once

#include <obs.h>
#include <util/pipe.h>

#include <string>

namespace clipforge {

// Wire protocol shared with the obs-ffmpeg-mux helper (see
// vendor/obs-studio/plugins/obs-ffmpeg/ffmpeg-mux/ffmpeg-mux.h).
enum ffm_packet_type { FFM_PACKET_VIDEO, FFM_PACKET_AUDIO, FFM_PACKET_CHANGE_FILE };

struct ffm_packet_info {
  int64_t pts;
  int64_t dts;
  uint32_t size;
  uint32_t index;
  enum ffm_packet_type type;
  bool keyframe;
};

// Streams encoded packets to the obs-ffmpeg-mux subprocess, which muxes them
// into a container. Ported from the replay-buffer save path of
// plugins/obs-ffmpeg/obs-ffmpeg-mux.c. Packets must arrive in dts order with
// timestamps already offset to start at 0 (the ring does that).
class FfmpegMuxWriter {
public:
  FfmpegMuxWriter(obs_output_t* output, const std::string& helperDir);
  ~FfmpegMuxWriter();

  FfmpegMuxWriter(const FfmpegMuxWriter&) = delete;
  FfmpegMuxWriter& operator=(const FfmpegMuxWriter&) = delete;

  // Spawn the helper for `path` (container chosen by extension) with the
  // given ffmpeg muxer settings (e.g. "-movflags +faststart").
  bool start(const std::string& path, const std::string& muxerSettings);

  // Write video + audio codec extradata headers (must precede any packet).
  bool sendHeaders();

  // Write one packet. pts/dts are used verbatim.
  bool writePacket(struct encoder_packet* pkt);

  // Flush + close the pipe; the helper writes the trailer and finalizes.
  void close();

  bool ok() const { return pipe_ != nullptr; }
  const std::string& lastError() const { return lastError_; }

private:
  bool buildCommand(os_process_args_t** args, const std::string& path, const std::string& muxerSettings);

  obs_output_t* output_;
  std::string helperDir_;
  os_process_pipe_t* pipe_ = nullptr;
  std::string lastError_;
};

} // namespace clipforge
