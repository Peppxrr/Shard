// ffmpeg.ts — spawns the bundled ffmpeg/ffprobe; serves remux, thumbnails,
// probing, and the export pipeline.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { app } from "electron";
import { existsSync, mkdirSync, statSync } from "node:fs";

export function ffmpegBin(): string {
  const packaged = path.join(process.resourcesPath ?? "", "core-bin");
  return existsSync(packaged) ? packaged : path.join(app.getAppPath(), "resources", "core-bin");
}

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number | null;
  sizeBytes: number;
}

export function ffprobe(file: string): ProbeResult {
  const exe = path.join(ffmpegBin(), "ffprobe.exe");
  const out = runSync(exe, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "format=duration:stream=width,height,r_frame_rate",
    "-of", "json",
    file,
  ]);
  const j = JSON.parse(out);
  const format = j.format ?? {};
  const stream = (j.streams ?? [])[0] ?? {};
  const fps = parseRate(stream.r_frame_rate);
  return {
    durationSec: Number(format.duration ?? 0),
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
    fps,
    sizeBytes: fileSize(file),
  };
}

function parseRate(rate: unknown): number | null {
  if (typeof rate !== "string") return null;
  const [n, d] = rate.split("/");
  const den = Number(d);
  return den ? Number(n) / den : null;
}

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function runSync(exe: string, args: string[]): string {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync(exe, args, { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(exe)} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// ffmpeg helpers used by the library importer --------------------------------

// Remux any container to mp4 (H.264+AAC passthrough assumed; stream copy).
export function remuxToMp4(src: string, dst: string): void {
  const exe = path.join(ffmpegBin(), "ffmpeg.exe");
  const r = spawnSync(exe, ["-y", "-i", src, "-c", "copy", "-movflags", "+faststart", dst], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`remux failed: ${r.stderr}`);
}

// Thumbnail at 1 s, width <= 320, into `<dir>/<base>.jpg`.
export function makeThumbnail(src: string, dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const base = path.basename(src, path.extname(src));
  const out = path.join(dir, `${base}.jpg`);
  const exe = path.join(ffmpegBin(), "ffmpeg.exe");
  const r = spawnSync(exe, ["-y", "-ss", "1", "-i", src, "-vframes", "1", "-vf", "scale=320:-2", "-q:v", "4", out], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  return existsSync(out) ? out : null;
}

// List the audio streams of a file (multi-track recordings have one per source).
export function probeAudioTracks(file: string): { index: number; codec: string }[] {
  const exe = path.join(ffmpegBin(), "ffprobe.exe");
  const out = runSync(exe, [
    "-v", "error",
    "-select_streams", "a",
    "-show_entries", "stream=index,codec_name",
    "-of", "json",
    file,
  ]);
  const j = JSON.parse(out);
  return ((j.streams ?? []) as { index: number; codec_name: string }[]).map((s) => ({
    index: Number(s.index),
    codec: String(s.codec_name ?? "aac"),
  }));
}

export { spawnSync };
