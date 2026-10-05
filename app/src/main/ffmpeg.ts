// ffmpeg.ts — spawns the bundled ffmpeg/ffprobe; serves remux, thumbnails,
// probing, and the export pipeline.
import { spawn, spawnSync } from "./bundled-processes";
import path from "node:path";
import { TimelinePreviews } from "./timeline-previews";
import { runEditorPreparation } from "./editor-preparation";
import { decodeWaveform, encodeWaveform, type WaveformStorage } from "./waveform-cache";
import { app } from "electron";
import { existsSync, mkdirSync, statSync, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
    const child = spawn(exe, ["-y", "-ss", "1", "-i", src, "-vframes", "1", "-vf", "scale=320:-2", "-q:v", "4", out], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code === 0 && existsSync(out)) resolve(out);
      else resolve(null);
    });
  });
}

function runSync(exe: string, args: string[]): string {
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

type EditorJob = { source: string; controller: AbortController; promise: Promise<unknown>; users: number };
const editorJobs = new Map<string, EditorJob>();
let editorPreviewsStopped = false;
const editorJobsBySource = new Map<string, Set<Promise<unknown>>>();
const removingEditorSources = new Set<string>();
let legacyAudioMigration: Promise<void> | undefined;
const MAX_AUDIO_PREVIEW_FILES = 32;
const AUDIO_PREVIEW_PRUNE_TO = 24;

// Extract a single source stream to a small seekable file so the renderer can
// mix individual tracks during preview. Paths are derived and never supplied
// by the renderer.
export function prepareAudioPreview(file: string, streamIndex: number, signal?: AbortSignal): Promise<string> {
  const source = editorSourceKey(file);
  if (removingEditorSources.has(source)) return Promise.reject(new Error("Editor media is being removed"));
  if (!Number.isInteger(streamIndex) || streamIndex < 0) return Promise.reject(new Error("Invalid audio stream"));
  const stat = statSync(file);
  const contentKey = createHash("sha256").update(`${source}\u0000${stat.mtimeMs}\u0000${stat.size}\u0000${streamIndex}:audio-v2`).digest("hex").slice(0, 24);
  const sourceHash = editorSourceHash(source);
  const key = `${sourceHash}-${contentKey}`;
  return sharedEditorJob(`audio:${key}`, source, signal, async (controller) => {
    await migrateLegacyAudioPreviews();
    return extractAudioPreview(file, streamIndex, key, controller);
  });
}

async function extractAudioPreview(file: string, streamIndex: number, key: string, signal: AbortSignal): Promise<string> {
  const directory = audioPreviewDirectory();
  const output = path.join(directory, `${key}.m4a`);
  await fs.mkdir(directory, { recursive: true });
  await pruneAudioPreviewDirectory(directory, key);
  signal.throwIfAborted();
  try {
    const stat = await fs.stat(output);
    if (stat.size > 0) {
      const now = new Date();
      await fs.utimes(output, now, now);
      signal.throwIfAborted();
      return output;
    }
  } catch {
    // Cache miss.
  }

  return runEditorPreparation("audio", signal, async () => {
    const temporary = `${output}.${randomUUID()}.tmp.m4a`;
    try {
      const executable = path.join(ffmpegBin(), "ffmpeg.exe");
      const child = spawn(executable, [
        "-y", "-v", "error", "-threads", "1", "-filter_threads", "1",
        "-i", file, "-map", `0:${streamIndex}`, "-vn",
        "-af", "aresample=async=1:first_pts=0",
        "-c:a", "aac", "-b:a", "192k", "-threads", "1",
        "-movflags", "+faststart", temporary,
      ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      let stderr = "";
      let spawnError: Error | undefined;
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-32768);
      });
      const abort = () => { child.kill(); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.once("error", (error) => { spawnError = error; });
      child.once("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (code === 0 && !signal.aborted && !spawnError) resolve();
        else reject(spawnError ?? new Error(`Audio preview failed (ffmpeg ${code}): ${stderr.trim() || "no diagnostic output"}`));
      });
      await promise;
      signal.throwIfAborted();
      if (!(await fs.stat(temporary)).size) throw new Error("Empty audio preview");
      await fs.rename(temporary, output);
      return output;
    } finally { await fs.unlink(temporary).catch(() => {}); }
  });
}
function audioPreviewDirectory(): string { return path.join(app.getPath("temp"), "shard-editor-audio"); }
function editorSourceHash(source: string): string { return createHash("sha256").update(source).digest("hex").slice(0, 32); }
function migrateLegacyAudioPreviews(): Promise<void> {
  return legacyAudioMigration ??= (async () => {
    const directory = audioPreviewDirectory();
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.isFile() && (/^[a-f0-9]{24}\.m4a$/i.test(entry.name) || entry.name.endsWith(".tmp.m4a")))
      .map((entry) => fs.unlink(path.join(directory, entry.name)).catch(() => {})));
  })();
}
async function pruneAudioPreviewDirectory(directory: string, keepKey: string): Promise<void> {
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".m4a") && !entry.name.endsWith(".tmp.m4a")
      && entry.name !== `${keepKey}.m4a` && !editorJobs.has(`audio:${entry.name.slice(0, -4)}`));
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
  storage?: WaveformStorage,
  signal?: AbortSignal,
): Promise<WaveformData> {
  const source = editorSourceKey(file);
  if (removingEditorSources.has(source)) return Promise.reject(new Error("Editor media is being removed"));
  if (!Number.isInteger(streamIndex) || streamIndex < 0) return Promise.reject(new Error("Invalid audio stream"));
  if (!Number.isFinite(duration) || duration <= 0) return Promise.reject(new Error("Invalid clip duration"));
  if (!Number.isFinite(requestedPoints)) return Promise.reject(new Error("Invalid waveform points"));
  const points = Math.max(128, Math.min(8000, Math.round(requestedPoints)));
  const stat = statSync(file);
  const cacheKey = `${source}\u0000${stat.mtimeMs}:${stat.size}:${streamIndex}:${points}:${duration}:WF01`;
  signal?.throwIfAborted();
  if (editorPreviewsStopped) return Promise.reject(new Error("Editor preparation stopped"));
  const cached = waveformCache.get(cacheKey);
  if (cached) {
    waveformCache.delete(cacheKey);
    waveformCache.set(cacheKey, cached);
    // Populate the library store even when a prior caller only used memory.
    storage?.put(cacheKey, encodeWaveform(cached));
    return Promise.resolve(cached);
  }
  const persisted = storage?.get(cacheKey);
  const restored = persisted && decodeWaveform(persisted);
  if (restored && restored.duration === duration && restored.peaks.length === points) {
    rememberWaveform(cacheKey, restored);
    return Promise.resolve(restored);
  }
  return sharedEditorJob(`waveform:${cacheKey}`, source, signal, (controller) =>
    runEditorPreparation("waveform", controller, () => extractWaveform(file, streamIndex, duration, points, cacheKey, controller)))
    .then((result) => { storage?.put(cacheKey, encodeWaveform(result)); return result; });
}

function extractWaveform(file: string, streamIndex: number, duration: number, points: number, cacheKey: string, signal: AbortSignal): Promise<WaveformData> {
  const exe = path.join(ffmpegBin(), "ffmpeg.exe");
  const child = spawn(exe, [
    "-v", "error", "-threads", "1", "-filter_threads", "1",
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
  let spawnError: Error | undefined;

  child.stdout.on("data", (chunk: Buffer) => {
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const completeBytes = data.length - (data.length % 4);
    for (let offset = 0; offset < completeBytes; offset += 4) {
      const value = Math.abs(data.readFloatLE(offset));
      const bin = Math.min(points - 1, Math.floor(sampleIndex / samplesPerBin));
      if (Number.isFinite(value) && value > peaks[bin]) peaks[bin] = value;
      sampleIndex++;
    }
    // Copy only the <=3 leftover bytes, without retaining a decoded PCM chunk.
    pending = completeBytes === data.length ? Buffer.alloc(0) : Buffer.from(data.subarray(completeBytes));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-32768);
  });

  const { promise, resolve, reject } = Promise.withResolvers<WaveformData>();
  const abort = () => { child.kill(); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  child.once("error", (error) => { spawnError = error; });
  child.once("close", (code) => {
    signal.removeEventListener("abort", abort);
    if (code !== 0 || signal.aborted || spawnError) {
      reject(spawnError ?? new Error(`Waveform generation failed (ffmpeg ${code}): ${stderr.trim() || "no diagnostic output"}`));
      return;
    }
    const result = { duration, peaks: Array.from(peaks, (value) => Math.min(1, Number(value.toFixed(4)))) };
    rememberWaveform(cacheKey, result);
    resolve(result);
  });
  return promise;
}

function rememberWaveform(key: string, waveform: WaveformData): void {
  waveformCache.set(key, waveform);
  while (waveformCache.size > MAX_WAVEFORM_CACHE_ENTRIES) waveformCache.delete(waveformCache.keys().next().value!);
}

// One decoder per source/stream/version, with independent caller cancellation.
// An immediate reopen waits for an abandoned decoder to close before replacing it.
async function sharedEditorJob<T>(key: string, source: string, signal: AbortSignal | undefined,
  task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (editorPreviewsStopped || removingEditorSources.has(source)) throw new Error("Editor preparation stopped");
  let job = editorJobs.get(key);
  if (job?.controller.signal.aborted) {
    await job.promise.catch(() => {});
    return sharedEditorJob(key, source, signal, task);
  }
  if (!job) {
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => task(controller.signal));
    job = { source, controller, promise, users: 0 };
    editorJobs.set(key, job);
    trackEditorJob(source, promise);
    void promise.finally(() => { if (editorJobs.get(key)?.promise === promise) editorJobs.delete(key); }).catch(() => {});
  }
  const current = job;
  current.users++;
  return new Promise<T>((resolve, reject) => {
    let attached = true;
    const detach = () => {
      if (!attached) return false;
      attached = false;
      signal?.removeEventListener("abort", abort);
      current.users--;
      return true;
    };
    const abort = () => {
      if (!detach()) return;
      reject(new Error("Editor preparation cancelled"));
      if (!current.users) current.controller.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    void current.promise.then((value) => { if (detach()) resolve(value as T); }, (error) => { if (detach()) reject(error); });
  });
}

function editorSourceKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function trackEditorJob(source: string, promise: Promise<unknown>): void {
  let jobs = editorJobsBySource.get(source);
  if (!jobs) editorJobsBySource.set(source, jobs = new Set());
  jobs.add(promise);
  void promise.finally(() => {
    jobs!.delete(promise);
    if (!jobs!.size) editorJobsBySource.delete(source);
  }).catch(() => {});
}

// Remove every editor cache associated with this source. The source is blocked
// while in-flight decoders drain so they cannot recreate files after cleanup.
export async function removeEditorMedia(file: string): Promise<void> {
  const source = editorSourceKey(file);
  removingEditorSources.add(source);
  try {
    for (const job of editorJobs.values()) if (job.source === source) job.controller.abort();
    await editorTimelinePreviews().remove(file);
    while (editorJobsBySource.get(source)?.size) {
      await Promise.allSettled([...editorJobsBySource.get(source)!]);
    }

    for (const key of waveformCache.keys()) {
      if (editorSourceKey(key.split("\u0000", 1)[0]) === source) waveformCache.delete(key);
    }
    await migrateLegacyAudioPreviews();
    const directory = audioPreviewDirectory();
    const prefix = `${editorSourceHash(source)}-`;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".m4a"))
      .map((entry) => fs.unlink(path.join(directory, entry.name)).catch(() => {})));
  } finally {
    removingEditorSources.delete(source);
  }
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

export async function stopEditorPreviews(): Promise<void> {
  editorPreviewsStopped = true;
  const jobs = [...editorJobs.values()];
  for (const job of jobs) job.controller.abort();
  await Promise.allSettled([timelinePreviews?.dispose(), ...jobs.map((job) => job.promise)]);
}
export function resumeEditorPreviews(): void { editorPreviewsStopped = false; timelinePreviews?.resume(); exportEncoderProbe = null; }
