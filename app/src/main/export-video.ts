// Quality determines ordinary export size. The user's MB setting is a ceiling;
// bitrate fitting is only needed when a quality encode exceeds that ceiling.
export function pickExportResolution(mode: string, source: { w: number; h: number }): { w: number; h: number } {
  const match = mode.match(/^(\d+)p$/);
  const targetHeight = match ? Math.max(2, Number(match[1])) : source.h;
  const scale = Math.min(1, targetHeight / source.h);
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  return { w: even(source.w * scale), h: even(source.h * scale) };
}

export function buildVideoEncoderArgs(
  encoder: string, bitrateKbps: number, fps: number, quality = true,
): string[] {
  const args = ["-c:v", encoder, "-pix_fmt", "yuv420p", "-r", String(fps), "-fps_mode", "cfr"];
  const rate = ["-b:v", `${bitrateKbps}k`, "-maxrate", `${bitrateKbps}k`, "-bufsize", `${bitrateKbps * 2}k`];
  if (encoder.endsWith("_nvenc")) {
    args.push("-preset", "p4", "-rc", "vbr");
    args.push(...(quality ? ["-cq", "23", "-b:v", "0", ...rate.slice(2)] : rate));
  } else if (encoder.endsWith("_amf")) {
    args.push("-quality", "balanced");
    args.push(...(quality
      ? ["-rc", "cqp", "-qp_i", "23", "-qp_p", "23", "-qp_b", "23"]
      : ["-rc", "vbr_peak", ...rate]));
  } else if (encoder.endsWith("_qsv")) {
    args.push("-preset", "medium", ...(quality ? ["-global_quality", "23"] : rate));
  } else {
    args.push("-preset", encoder === "libsvtav1" ? "8" : "veryfast");
    // Capped CRF, like NVENC's capped CQ: quality decides the size unless the
    // budget is lower, which avoids a whole second size-correction encode.
    args.push(...(quality
      ? ["-crf", encoder === "libsvtav1" ? "30" : "23", ...rate.slice(2)]
      : rate));
  }
  return args;
}

const HARDWARE_DECODED_CODECS = new Set(["h264", "hevc", "av1"]);

// Decodes the source on the GPU; frames are copied back for the CPU filter
// graph. Decoding is the slowest export stage for HEVC and AV1 captures.
// Unsupported profiles fall back to software inside FFmpeg; a hard failure
// (no usable device) makes the export retry without these arguments.
export function buildHardwareDecodeArgs(codec: string, platform: NodeJS.Platform = process.platform): string[] {
  if (!HARDWARE_DECODED_CODECS.has(codec)) return [];
  // Windows: D3D11VA works on every GPU vendor (auto picks CUDA first, which
  // was slower here). Elsewhere: VAAPI/NVDEC/Vulkan, whichever the FFmpeg has.
  const args = ["-hwaccel", platform === "win32" ? "d3d11va" : "auto"];
  // FFmpeg picks libdav1d for AV1 by default, which ignores -hwaccel; the
  // native decoder is the one that uses it.
  if (codec === "av1") args.push("-c:v", "av1");
  return args;
}
