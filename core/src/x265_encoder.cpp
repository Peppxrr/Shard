#include "x265_encoder.h"

#include <obs-module.h>
#include <x265.h>

#include <algorithm>
#include <cstring>
#include <string>
#include <vector>

namespace clipforge {

namespace {

struct X265Encoder {
  obs_encoder_t* encoder = nullptr;
  x265_param* params = nullptr;
  x265_encoder* context = nullptr;
  x265_picture* input = nullptr;
  x265_picture* output = nullptr;
  std::vector<uint8_t> packetData;
  std::vector<uint8_t> extraData;
};

const char* x265Name(void*)
{
  return "x265 / HEVC (CPU)";
}

void x265VideoInfo(void*, video_scale_info* info)
{
  info->format = VIDEO_FORMAT_I420;
}

void x265Defaults(obs_data_t* settings)
{
  obs_data_set_default_int(settings, "bitrate", 8000);
  obs_data_set_default_int(settings, "keyint_sec", 2);
}

void x265Destroy(void* data)
{
  auto* encoder = static_cast<X265Encoder*>(data);
  if (!encoder)
    return;
  if (encoder->context)
    x265_encoder_close(encoder->context);
  if (encoder->input)
    x265_picture_free(encoder->input);
  if (encoder->output)
    x265_picture_free(encoder->output);
  if (encoder->params)
    x265_param_free(encoder->params);
  delete encoder;
}

bool appendNals(std::vector<uint8_t>& destination, const x265_nal* nals, uint32_t count)
{
  size_t total = 0;
  for (uint32_t index = 0; index < count; index++)
    total += nals[index].sizeBytes;
  if (!total)
    return false;

  destination.clear();
  destination.reserve(total);
  for (uint32_t index = 0; index < count; index++)
    destination.insert(destination.end(), nals[index].payload, nals[index].payload + nals[index].sizeBytes);
  return true;
}

void* x265Create(obs_data_t* settings, obs_encoder_t* obsEncoder)
{
  auto* encoder = new X265Encoder;
  encoder->encoder = obsEncoder;
  encoder->params = x265_param_alloc();
  encoder->input = x265_picture_alloc();
  encoder->output = x265_picture_alloc();
  if (!encoder->params || !encoder->input || !encoder->output) {
    obs_encoder_set_last_error(obsEncoder, "Could not allocate the x265 encoder");
    x265Destroy(encoder);
    return nullptr;
  }

  if (x265_param_default_preset(encoder->params, "veryfast", "zerolatency") < 0) {
    obs_encoder_set_last_error(obsEncoder, "Could not apply the x265 veryfast preset");
    x265Destroy(encoder);
    return nullptr;
  }

  video_t* video = obs_encoder_video(obsEncoder);
  const video_output_info* outputInfo = video_output_get_info(video);
  const int bitrateKbps = std::max(100, static_cast<int>(obs_data_get_int(settings, "bitrate")));
  const int keyintSec = std::max(1, static_cast<int>(obs_data_get_int(settings, "keyint_sec")));
  const int fps = std::max(1, static_cast<int>(outputInfo->fps_num / outputInfo->fps_den));

  x265_param* params = encoder->params;
  params->sourceWidth = static_cast<int>(obs_encoder_get_width(obsEncoder));
  params->sourceHeight = static_cast<int>(obs_encoder_get_height(obsEncoder));
  params->internalCsp = X265_CSP_I420;
  params->fpsNum = outputInfo->fps_num;
  params->fpsDenom = outputInfo->fps_den;
  params->keyframeMax = keyintSec * fps;
  params->keyframeMin = params->keyframeMax;
  params->bOpenGOP = 0;
  params->bRepeatHeaders = 0;
  params->bAnnexB = 1;
  params->bEnablePsnr = 0;
  params->bEnableSsim = 0;
  params->logLevel = X265_LOG_WARNING;
  params->rc.rateControlMode = X265_RC_ABR;
  params->rc.bitrate = bitrateKbps;
  params->rc.vbvMaxBitrate = bitrateKbps;
  params->rc.vbvBufferSize = bitrateKbps * 2;
  params->rc.bStrictCbr = 1;

  if (x265_param_apply_profile(params, "main") < 0) {
    obs_encoder_set_last_error(obsEncoder, "The x265 main profile is unavailable");
    x265Destroy(encoder);
    return nullptr;
  }

  encoder->context = x265_encoder_open(params);
  if (!encoder->context) {
    obs_encoder_set_last_error(obsEncoder, "Could not start the x265 encoder");
    x265Destroy(encoder);
    return nullptr;
  }

  x265_picture_init(params, encoder->input);
  x265_picture_init(params, encoder->output);

  x265_nal* headers = nullptr;
  uint32_t headerCount = 0;
  if (x265_encoder_headers(encoder->context, &headers, &headerCount) < 0 ||
      !appendNals(encoder->extraData, headers, headerCount)) {
    obs_encoder_set_last_error(obsEncoder, "x265 did not produce HEVC headers");
    x265Destroy(encoder);
    return nullptr;
  }

  blog(LOG_INFO, "[x265 encoder: '%s'] %dx%d %u/%u fps, %d kbps, keyint %d s, preset veryfast",
       obs_encoder_get_name(obsEncoder), params->sourceWidth, params->sourceHeight, outputInfo->fps_num,
       outputInfo->fps_den, bitrateKbps, keyintSec);
  return encoder;
}

bool x265Encode(void* data, encoder_frame* source, encoder_packet* packet, bool* receivedPacket)
{
  auto* encoder = static_cast<X265Encoder*>(data);
  *receivedPacket = false;

  encoder->input->planes[0] = source->data[0];
  encoder->input->planes[1] = source->data[1];
  encoder->input->planes[2] = source->data[2];
  encoder->input->stride[0] = static_cast<int>(source->linesize[0]);
  encoder->input->stride[1] = static_cast<int>(source->linesize[1]);
  encoder->input->stride[2] = static_cast<int>(source->linesize[2]);
  encoder->input->pts = source->pts;
  encoder->input->sliceType = X265_TYPE_AUTO;

  x265_nal* nals = nullptr;
  uint32_t nalCount = 0;
  const int result = x265_encoder_encode(encoder->context, &nals, &nalCount, encoder->input, encoder->output);
  if (result < 0) {
    blog(LOG_ERROR, "[x265 encoder: '%s'] encode failed", obs_encoder_get_name(encoder->encoder));
    return false;
  }
  if (result == 0 || !appendNals(encoder->packetData, nals, nalCount))
    return true;

  packet->pts = encoder->output->pts;
  packet->dts = encoder->output->dts;
  packet->data = encoder->packetData.data();
  packet->size = encoder->packetData.size();
  packet->type = OBS_ENCODER_VIDEO;
  packet->keyframe = IS_X265_TYPE_I(encoder->output->sliceType);
  *receivedPacket = true;
  return true;
}

bool x265ExtraData(void* data, uint8_t** extraData, size_t* size)
{
  auto* encoder = static_cast<X265Encoder*>(data);
  *extraData = encoder->extraData.data();
  *size = encoder->extraData.size();
  return !encoder->extraData.empty();
}

} // namespace

void registerX265Encoder()
{
  const char* id = nullptr;
  for (size_t index = 0; obs_enum_encoder_types(index, &id); index++) {
    if (id && std::strcmp(id, "obs_x265") == 0)
      return;
  }

  static obs_encoder_info info = {};
  info.id = "obs_x265";
  info.type = OBS_ENCODER_VIDEO;
  info.codec = "hevc";
  info.get_name = x265Name;
  info.create = x265Create;
  info.destroy = x265Destroy;
  info.encode = x265Encode;
  info.get_defaults = x265Defaults;
  info.get_extra_data = x265ExtraData;
  info.get_video_info = x265VideoInfo;
  obs_register_encoder(&info);
}

} // namespace clipforge
