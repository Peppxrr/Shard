// Quality determines ordinary export size. The user's MB setting is a ceiling;
// bitrate fitting is only needed when a quality encode exceeds that ceiling.
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
    args.push(...(quality
      ? ["-crf", encoder === "libsvtav1" ? "30" : "23"]
      : rate));
  }
  return args;
}
