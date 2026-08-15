#include "mux.h"

#include <obs-module.h>

#include <filesystem>

namespace clipforge {

namespace fs = std::filesystem;

// Stable libavutil enum values (AVOption ABI — unchanged for decades).
namespace av {
enum class Pri { BT709 = 1, SMPTE170M = 6, BT2020 = 9 };
enum class Trc { BT709 = 1, SMPTE170M = 6, IEC61966_2_1 = 13, SMPTE2084 = 16, ARIB_STD_B67 = 18 };
enum class Spc { BT709 = 1, SMPTE170M = 6, BT2020_NCL = 9 };
enum class Range { JPEG = 1, MPEG = 2 };
enum class Chroma { UNSPECIFIED = 0, LEFT = 2, CENTER = 3, TOPLEFT = 5 };
} // namespace av

namespace {

const char* helperExeName()
{
#ifdef _WIN32
  return "obs-ffmpeg-mux.exe";
#else
  return "obs-ffmpeg-mux";
#endif
}

} // namespace

FfmpegMuxWriter::FfmpegMuxWriter(obs_output_t* output, const std::string& helperDir)
    : output_(output), helperDir_(helperDir)
{
}

FfmpegMuxWriter::~FfmpegMuxWriter()
{
  close();
}

bool FfmpegMuxWriter::buildCommand(os_process_args_t** args, const std::string& path,
                                   const std::string& muxerSettings)
{
  obs_encoder_t* vencoder = obs_output_get_video_encoder(output_);
  obs_encoder_t* aencoders[MAX_AUDIO_MIXES] = {nullptr};
  int num_tracks = 0;
  for (;;) {
    obs_encoder_t* a = obs_output_get_audio_encoder(output_, num_tracks);
    if (!a)
      break;
    aencoders[num_tracks] = a;
    num_tracks++;
  }

  fs::path exe = fs::path(helperDir_) / helperExeName();
  if (!fs::exists(exe)) {
    lastError_ = "ffmpeg-mux helper not found: " + exe.string();
    return false;
  }

  *args = os_process_args_create(exe.string().c_str());
  os_process_args_add_arg(*args, path.c_str());
  os_process_args_add_argf(*args, "%d", vencoder ? 1 : 0);
  os_process_args_add_argf(*args, "%d", num_tracks);

  if (vencoder) {
    obs_data_t* settings = obs_encoder_get_settings(vencoder);
    int bitrate = (int)obs_data_get_int(settings, "bitrate");
    obs_data_release(settings);

    video_t* video = obs_get_video();
    const struct video_output_info* info = video ? video_output_get_info(video) : nullptr;

    // Our pipeline is always NV12 / 709 partial.
    int pri = (int)av::Pri::BT709;
    int trc = (int)av::Trc::BT709;
    int spc = (int)av::Spc::BT709;
    int range = (int)av::Range::MPEG;
    int chroma = (int)av::Chroma::LEFT;
    if (info) {
      switch (info->colorspace) {
      case VIDEO_CS_601:
        pri = (int)av::Pri::SMPTE170M;
        trc = (int)av::Trc::SMPTE170M;
        spc = (int)av::Spc::SMPTE170M;
        break;
      case VIDEO_CS_SRGB:
        trc = (int)av::Trc::IEC61966_2_1;
        break;
      case VIDEO_CS_2100_PQ:
        pri = (int)av::Pri::BT2020;
        trc = (int)av::Trc::SMPTE2084;
        spc = (int)av::Spc::BT2020_NCL;
        chroma = (int)av::Chroma::TOPLEFT;
        break;
      case VIDEO_CS_2100_HLG:
        pri = (int)av::Pri::BT2020;
        trc = (int)av::Trc::ARIB_STD_B67;
        spc = (int)av::Spc::BT2020_NCL;
        chroma = (int)av::Chroma::TOPLEFT;
        break;
      case VIDEO_CS_DEFAULT:
      case VIDEO_CS_709:
      default:
        break;
      }
      range = (info->range == VIDEO_RANGE_FULL) ? (int)av::Range::JPEG : (int)av::Range::MPEG;
    }

    os_process_args_add_arg(*args, obs_encoder_get_codec(vencoder));
    os_process_args_add_argf(*args, "%d", bitrate);
    os_process_args_add_argf(*args, "%d", (int)obs_output_get_width(output_));
    os_process_args_add_argf(*args, "%d", (int)obs_output_get_height(output_));
    os_process_args_add_argf(*args, "%d", pri);
    os_process_args_add_argf(*args, "%d", trc);
    os_process_args_add_argf(*args, "%d", spc);
    os_process_args_add_argf(*args, "%d", range);
    os_process_args_add_argf(*args, "%d", chroma);
    os_process_args_add_argf(*args, "%d", 0); // max_luminance (SDR)
    os_process_args_add_argf(*args, "%d", info ? (int)info->fps_num : 60);
    os_process_args_add_argf(*args, "%d", info ? (int)info->fps_den : 1);
    os_process_args_add_argf(*args, "%d", 0); // codec_tag
  }

  if (num_tracks) {
    os_process_args_add_arg(*args, obs_encoder_get_codec(aencoders[0]));
    for (int i = 0; i < num_tracks; i++) {
      obs_encoder_t* a = aencoders[i];
      obs_data_t* settings = obs_encoder_get_settings(a);
      int bitrate = (int)obs_data_get_int(settings, "bitrate");
      obs_data_release(settings);

      os_process_args_add_arg(*args, obs_encoder_get_name(a));
      os_process_args_add_argf(*args, "%d", bitrate);
      os_process_args_add_argf(*args, "%d", (int)obs_encoder_get_sample_rate(a));
      os_process_args_add_argf(*args, "%d", (int)obs_encoder_get_frame_size(a));
      os_process_args_add_argf(*args, "%d", (int)obs_encoder_get_priming_samples(a));
      audio_t* audio = obs_get_audio();
      os_process_args_add_argf(*args, "%d", (int)(audio ? audio_output_get_channels(audio) : 2));
    }
  }

  // stream key (unused for local files)
  os_process_args_add_arg(*args, "");
  // muxer settings
  os_process_args_add_arg(*args, muxerSettings.empty() ? "" : muxerSettings.c_str());
  return true;
}

bool FfmpegMuxWriter::start(const std::string& path, const std::string& muxerSettings)
{
  if (pipe_)
    close();

  os_process_args_t* args = nullptr;
  if (!buildCommand(&args, path, muxerSettings))
    return false;

  pipe_ = os_process_pipe_create2(args, "w");
  os_process_args_destroy(args);

  if (!pipe_) {
    lastError_ = "Failed to create ffmpeg-mux helper process";
    return false;
  }
  return true;
}

bool FfmpegMuxWriter::sendHeaders()
{
  obs_encoder_t* vencoder = obs_output_get_video_encoder(output_);
  if (vencoder) {
    struct encoder_packet pkt = {};
    pkt.type = OBS_ENCODER_VIDEO;
    pkt.timebase_num = 1;
    pkt.timebase_den = 1;
    if (!obs_encoder_get_extra_data(vencoder, &pkt.data, &pkt.size))
      return false;
    if (!writePacket(&pkt))
      return false;
  }

  for (size_t idx = 0;; idx++) {
    obs_encoder_t* aencoder = obs_output_get_audio_encoder(output_, idx);
    if (!aencoder)
      break;
    struct encoder_packet pkt = {};
    pkt.type = OBS_ENCODER_AUDIO;
    pkt.timebase_num = 1;
    pkt.timebase_den = 1;
    pkt.track_idx = idx;
    if (!obs_encoder_get_extra_data(aencoder, &pkt.data, &pkt.size))
      return false;
    if (!writePacket(&pkt))
      return false;
  }
  return true;
}

bool FfmpegMuxWriter::writePacket(struct encoder_packet* packet)
{
  bool is_video = packet->type == OBS_ENCODER_VIDEO;

  struct ffm_packet_info info = {};
  info.pts = packet->pts;
  info.dts = packet->dts;
  info.size = (uint32_t)packet->size;
  info.index = (int)packet->track_idx;
  info.type = is_video ? FFM_PACKET_VIDEO : FFM_PACKET_AUDIO;
  info.keyframe = packet->keyframe;

  size_t ret = os_process_pipe_write(pipe_, (const uint8_t*)&info, sizeof(info));
  if (ret != sizeof(info)) {
    lastError_ = "ffmpeg-mux pipe write failed (info)";
    return false;
  }
  ret = os_process_pipe_write(pipe_, packet->data, packet->size);
  if (ret != packet->size) {
    lastError_ = "ffmpeg-mux pipe write failed (data)";
    return false;
  }
  return true;
}

void FfmpegMuxWriter::close()
{
  if (pipe_) {
    os_process_pipe_destroy(pipe_);
    pipe_ = nullptr;
  }
}

} // namespace clipforge
