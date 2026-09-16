// ffmpeg.ts — spawns the bundled ffmpeg/ffprobe; serves remux, thumbnails,
// probing, and the export pipeline.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { TimelinePreviews } from "./timeline-previews";
import { app } from "electron";
import { existsSync, mkdirSync, statSync, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import type { AudioTrackInfo, ExportEncoderInfo, WaveformData } from "../shared/contracts";

export function ffmpegBin(): string {
  const packaged = path.join(process.resourcesPath ?? "", "core-bin");
  return existsSync(packaged) ? packaged : path.join(app.getAppPath(), "resources", "core-bin");
}

const EXPORT_CPU_ENCODERS: Omit<ExportEncoderInfo, "preferred">[] = [
  { id: "libx264", label: "x264 H.264 (CPU)", codec: "h264", vendor: "cpu", hardware: false },
  { id: "libx265", label: "x265 HEVC (CPU)", codec: "hevc", vendor: "cpu", hardware: false },
  { id: "libsvtav1", label: "SVT-AV1 (CPU)", codec: "av1", vendor: "cpu", hardware: false },
];

const EXPORT_GPU_ENCODERS: Omit<ExportEncoderInfo, "preferred">[] = [
  { id: "h264_nvenc", label: "NVIDIA NVENC H.264", codec: "h264", vendor: "nvidia", hardware: true },
  { id: "hevc_nvenc", label: "NVIDIA NVENC HEVC", codec: "hevc", vendor: "nvidia", hardware: true },
  { id: "av1_nvenc", label: "NVIDIA NVENC AV1", codec: "av1", vendor: "nvidia", hardware: true },
  { id: "h264_amf", label: "AMD AMF H.264", codec: "h264", vendor: "amd", hardware: true },
  { id: "hevc_amf", label: "AMD AMF HEVC", codec: "hevc", vendor: "amd", hardware: true },
  { id: "av1_amf", label: "AMD AMF AV1", codec: "av1", vendor: "amd", hardware: true },
  { id: "h264_qsv", label: "Intel Quick Sync H.264", codec: "h264", vendor: "intel", hardware: true },
  { id: "hevc_qsv", label: "Intel Quick Sync HEVC", codec: "hevc", vendor: "intel", hardware: true },
  { id: "av1_qsv", label: "Intel Quick Sync AV1", codec: "av1", vendor: "intel", hardware: true },
];

let exportEncoderProbe: Promise<ExportEncoderInfo[]> | null = null;

// Hardware encoder names in `ffmpeg -encoders` only mean the build contains a
// wrapper. A one-frame encode proves the installed driver/GPU can initialize
// it. The result is cached for the lifetime of the app.
export function listExportEncoders(): Promise<ExportEncoderInfo[]> {
  exportEncoderProbe ??= detectExportEncoders();
  return exportEncoderProbe;
}

async function detectExportEncoders(): Promise<ExportEncoderInfo[]> {
  const preferredVendor = await activeGpuVendor();
  const detected: Omit<ExportEncoderInfo, "preferred">[] = [];
  for (const encoder of EXPORT_GPU_ENCODERS) {
    if (await probeExportEncoder(encoder.id))
      detected.push(encoder);
  }
  const codecOrder = { h264: 0, hevc: 1, av1: 2 } as const;
  detected.sort((a, b) => {
    const aPrimary = a.vendor === preferredVendor ? 0 : 1;
    const bPrimary = b.vendor === preferredVendor ? 0 : 1;
    return aPrimary - bPrimary || a.vendor.localeCompare(b.vendor) || codecOrder[a.codec] - codecOrder[b.codec];
  });
  const preferred = detected.find((encoder) => encoder.vendor === preferredVendor && encoder.codec === "h264")
    ?? detected.find((encoder) => encoder.codec === "h264")
    ?? EXPORT_CPU_ENCODERS[0];
  return [...detected, ...EXPORT_CPU_ENCODERS].map((encoder) => ({
    ...encoder,
    preferred: encoder.id === preferred.id,
  }));
}

async function activeGpuVendor(): Promise<ExportEncoderInfo["vendor"] | ""> {
  try {
    const info = await app.getGPUInfo("basic") as unknown as { gpuDevice?: Array<{ active?: boolean; vendorId?: number | string }> };
    const device = info.gpuDevice?.find((entry) => entry.active) ?? info.gpuDevice?.[0];
    const id = typeof device?.vendorId === "string" ? Number.parseInt(device.vendorId, 16) : Number(device?.vendorId);
    if (id === 0x10de) return "nvidia";
    if (id === 0x1002 || id === 0x1022) return "amd";
    if (id === 0x8086) return "intel";
  } catch {}
  return "";
}

function probeExportEncoder(encoder: ExportEncoderInfo["id"]): Promise<boolean> {
  const exe = path.join(ffmpegBin(), "ffmpeg.exe");
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const child = spawn(exe, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=size=256x256:rate=1",
    "-frames:v", "1", "-an", "-c:v", encoder, "-f", "null", "-",
  ], { windowsHide: true, stdio: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  child.once("error", () => {
    clearTimeout(timer);
    resolve(false);
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve(code === 0);
  });
  return promise;
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


export async function ffprobeAsync(file: string): Promise<ProbeResult> {
  const exe = path.join(ffmpegBin(), "ffprobe.exe");
  const out = await runAsync(exe, [
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

function runAsync(exe: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(exe)} failed: ${stderr || stdout}`));
    });
  });
}

export async function makeThumbnailAsync(src: string, dir: string): Promise<string | null> {
  try { await fs.mkdir(dir, { recursive: true }); } catch { return null; }
  const base = path.basename(src, path.extname(src));
  const out = path.join(dir, `${base}.jpg`);
  const exe = path.join(ffmpegBin(), "ffmpeg.exe");
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const child = spawn(exe, ["-y", "-ss", "1", "-i", src, "-vframes", "1", "-vf", "scale=320:-2", "-q:v", "4", out], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code === 0 && existsSync(out)) resolve(out);
      else resolve(null);
    });
  });
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
// `-map 0` is required to preserve ALL audio tracks — without it FFmpeg's
// default stream selection keeps only one stream per type, collapsing 4+
// track recordings to a single track.
export function remuxToMp4(src: string, dst: string): void {
  const exe = path.join(ffmpegBin(), "ffmpeg.exe");
  const r = spawnSync(exe, ["-y", "-i", src, "-map", "0", "-c", "copy", "-movflags", "+faststart", dst], {
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

// List every audio stream with both its absolute stream index and its
// audio-relative index. Export uses the absolute index to avoid FFmpeg's
// `a:N` selector ambiguity when video and subtitle streams are present.
export async function probeAudioTracks(file: string): Promise<AudioTrackInfo[]> {
  const exe = path.join(ffmpegBin(), "ffprobe.exe");
  const out = await runAsync(exe, [
    "-v", "error",
    "-select_streams", "a",
    "-show_entries", "stream=index,codec_name,channels,sample_rate,bit_rate:stream_tags=title,name,handler_name,language",
    "-of", "json",
    file,
  ]);
  const j = JSON.parse(out);
  type Stream = {
    index: number;
    codec_name?: string;
    channels?: number;
    sample_rate?: string;
    bit_rate?: string;
    tags?: { title?: string; name?: string; handler_name?: string; language?: string };
  };
  return ((j.streams ?? []) as Stream[]).map((stream, audioIndex) => {
    const name = audioTrackName(stream.tags, audioIndex);
    return {
      streamIndex: Number(stream.index),
      audioIndex,
      codec: String(stream.codec_name ?? "unknown"),
      name,
      kind: /^(?:Playback Mix|(?:ring|rec)-audio-0)$/i.test(name) ? "mix" : "unknown",
      channels: Number(stream.channels ?? 0),
      sampleRate: Number(stream.sample_rate ?? 0),
      bitRate: Number(stream.bit_rate ?? 0),
    };
  });
}

const audioPreviewCache = new Map<string, Promise<string>>();
const MAX_AUDIO_PREVIEW_FILES = 32;
const AUDIO_PREVIEW_PRUNE_TO = 24;

// Extract a single source stream to a small seekable file so the renderer can
// mix individual tracks during preview. Paths are derived and never supplied
// by the renderer.
export function prepareAudioPreview(file: string, streamIndex: number): Promise<string> {
  if (!Number.isInteger(streamIndex) || streamIndex < 0) return Promise.reject(new Error("Invalid audio stream"));
  const modified = statSync(file).mtimeMs;
  const key = createHash("sha256").update(`${file}\u0000${modified}\u0000${streamIndex}`).digest("hex").slice(0, 24);
  const cached = audioPreviewCache.get(key);
  if (cached) return cached;
  const pending = extractAudioPreview(file, streamIndex, key);
  audioPreviewCache.set(key, pending);
  void pending.then(
    () => audioPreviewCache.delete(key),
    () => audioPreviewCache.delete(key),
  );
  return pending;
}

async function extractAudioPreview(file: string, streamIndex: number, key: string): Promise<string> {
  const directory = path.join(app.getPath("temp"), "shard-editor-audio");
  const output = path.join(directory, `${key}.m4a`);
  await fs.mkdir(directory, { recursive: true });
  await pruneAudioPreviewDirectory(directory, key);
  try {
    const stat = await fs.stat(output);
    if (stat.size > 0) {
      const now = new Date();
      await fs.utimes(output, now, now);
      return output;
    }
  } catch {
    // Cache miss.
  }

  const executable = path.join(ffmpegBin(), "ffmpeg.exe");
  const child = spawn(executable, [
    "-y", "-v", "error",
    "-i", file,
    "-map", `0:${streamIndex}`,
    "-vn",
    "-af", "aresample=async=1:first_pts=0",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    output,
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-32768);
  });
  child.once("error", reject);
  child.once("close", (code) => {
    if (code === 0) {
      resolve(output);
      return;
    }
    void fs.unlink(output).catch(() => {});
    reject(new Error(`Audio preview failed (ffmpeg ${code}): ${stderr.trim() || "no diagnostic output"}`));
  });
  return promise;
}
async function pruneAudioPreviewDirectory(directory: string, keepKey: string): Promise<void> {
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".m4a") && entry.name !== `${keepKey}.m4a`);
  if (entries.length < MAX_AUDIO_PREVIEW_FILES) return;
  const stats = await Promise.all(entries.map(async (entry) => {
    const candidatePath = path.join(directory, entry.name);
    try {
      return { path: candidatePath, modified: (await fs.stat(candidatePath)).mtimeMs };
    } catch {
      return null;
    }
  }));
  const candidates: Array<{ path: string; modified: number }> = [];
  for (const stat of stats) {
    if (stat) candidates.push(stat);
  }
  candidates.sort((a, b) => a.modified - b.modified);
  await Promise.all(candidates.slice(0, Math.max(0, candidates.length - AUDIO_PREVIEW_PRUNE_TO)).map((candidate) =>
    fs.unlink(candidate.path).catch(() => {}),
  ));
}


const waveformCache = new Map<string, WaveformData>();
const WAVEFORM_SAMPLE_RATE = 4000;
const MAX_WAVEFORM_CACHE_ENTRIES = 24;

// Decode once in the main process and retain only downsampled peak bins.
// Raw PCM is consumed incrementally, never accumulated in renderer state.
export function generateWaveform(
  file: string,
  streamIndex: number,
  duration: number,
  requestedPoints: number,
): Promise<WaveformData> {
  if (!Number.isInteger(streamIndex) || streamIndex < 0) return Promise.reject(new Error("Invalid audio stream"));
  if (!Number.isFinite(duration) || duration <= 0) return Promise.reject(new Error("Invalid clip duration"));
  const points = Math.max(128, Math.min(8000, Math.round(requestedPoints)));
  const modified = statSync(file).mtimeMs;
  const cacheKey = `${file}\u0000${modified}\u0000${streamIndex}\u0000${points}`;
  const cached = waveformCache.get(cacheKey);
  if (cached) {
    waveformCache.delete(cacheKey);
    waveformCache.set(cacheKey, cached);
    return Promise.resolve(cached);
  }

  const exe = path.join(ffmpegBin(), "ffmpeg.exe");
  const child = spawn(exe, [
    "-v", "error",
    "-i", file,
    "-map", `0:${streamIndex}`,
    "-vn",
    "-af", `aresample=${WAVEFORM_SAMPLE_RATE}:async=1:first_pts=0`,
    "-t", String(duration),
    "-ac", "1",
    "-f", "f32le",
    "pipe:1",
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

  const peaks = new Float32Array(points);
  const samplesPerBin = Math.max(1, (duration * WAVEFORM_SAMPLE_RATE) / points);
  let sampleIndex = 0;
  let pending: Buffer = Buffer.alloc(0);
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const completeBytes = data.length - (data.length % 4);
    for (let offset = 0; offset < completeBytes; offset += 4) {
      const value = Math.abs(data.readFloatLE(offset));
      const bin = Math.min(points - 1, Math.floor(sampleIndex / samplesPerBin));
      if (Number.isFinite(value) && value > peaks[bin]) peaks[bin] = value;
      sampleIndex++;
    }
    pending = completeBytes === data.length ? Buffer.alloc(0) : data.subarray(completeBytes);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-32768);
  });

  const { promise, resolve, reject } = Promise.withResolvers<WaveformData>();
  child.once("error", reject);
  child.once("close", (code) => {
    if (code !== 0) {
      reject(new Error(`Waveform generation failed (ffmpeg ${code}): ${stderr.trim() || "no diagnostic output"}`));
      return;
    }
    const result = { duration, peaks: Array.from(peaks, (value) => Math.min(1, Number(value.toFixed(4)))) };
    waveformCache.set(cacheKey, result);
    while (waveformCache.size > MAX_WAVEFORM_CACHE_ENTRIES) {
      const oldest = waveformCache.keys().next().value as string | undefined;
      if (!oldest) break;
      waveformCache.delete(oldest);
    }
    resolve(result);
  });
  return promise;
}

let timelinePreviews: TimelinePreviews | undefined;
export function editorTimelinePreviews(): TimelinePreviews {
  return timelinePreviews ??= new TimelinePreviews(
    path.join(app.getPath("temp"), "shard-editor-frames"), path.join(ffmpegBin(), "ffmpeg.exe"));
}

function audioTrackName(tags: { title?: string; name?: string; handler_name?: string; language?: string } | undefined, index: number): string {
  const title = tags?.title?.trim();
  if (title) return title;
  const name = tags?.name?.trim();
  if (name) return name;
  const handler = tags?.handler_name?.trim();
  if (handler && !/^(soundhandler|audiohandler)$/i.test(handler)) return handler;
  const language = tags?.language?.trim();
  return language && language.toLowerCase() !== "und" ? `Audio ${index + 1} · ${language}` : `Audio ${index + 1}`;
}

export { spawnSync };
