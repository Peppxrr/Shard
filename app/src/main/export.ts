// export.ts — non-destructive editor export with explicit stream mapping,
// real FFmpeg progress, cancellation, size correction, and output verification.
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ClipRecord, EditorExportProject, ExportProgress, ExportResult, ExportSettings } from "../shared/contracts";
import { ffmpegBin, ffprobeAsync, listExportEncoders, probeAudioTracks } from "./ffmpeg";
import { buildVideoEncoderArgs, pickExportResolution as pickResolution } from "./export-video";
import { editorDir } from "./library";
import {
  buildExportAudioOutputs,
  buildExportGraph,
  validateExportSegments,
  resolveExportAudioTracks,
  type ExportAudioTrack,
  type ExportSegment,
} from "./export-graph";

const MAX_RUNS = 6;
const MAX_FFMPEG_DIAGNOSTIC = 128 * 1024;

export class ExportManager extends EventEmitter {
  private current: ChildProcess | null = null;
  private active = false;
  private cancelled = false;

  get busy(): boolean {
    return this.active;
  }

  async export(
    clip: ClipRecord,
    project: EditorExportProject,
    settings: ExportSettings,
  ): Promise<{ ok: boolean; cancelled?: boolean }> {
    if (this.active) {
      this.emitDone({ clipId: clip.id, error: "An export is already running" });
      return { ok: false };
    }
    this.active = true;
    this.cancelled = false;
    let outFile: string | null = null;

    try {
      await fs.access(clip.path);
      const segments = validateExportSegments(project.segments, clip.durationMs / 1000);
      const tracks = resolveExportAudioTracks(await probeAudioTracks(clip.path), project.audioTracks);
      const totalDur = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
      if (totalDur <= 0) throw new Error("No retained timeline segments to export");

      const outDir = editorDir();
      await fs.mkdir(outDir, { recursive: true });
      const base = path.basename(clip.path, path.extname(clip.path));
      outFile = await availableOutputPath(outDir, `${base}-edited`, ".mp4");

      const sourceProbe = await ffprobeAsync(clip.path);
      const sourceRes = { w: sourceProbe.width || clip.width || 1920, h: sourceProbe.height || clip.height || 1080 };
      const fps = sourceProbe.fps && sourceProbe.fps > 0 ? sourceProbe.fps : (clip.fps || 30);
      let resolution = pickResolution(settings.resolution, sourceRes);
      if (!Number.isFinite(settings.targetMb) || settings.targetMb <= 0)
        throw new Error("Export target size must be greater than zero");
      const targetBytes = Math.floor(settings.targetMb * 1024 * 1024);
      const audioKbps = buildExportAudioOutputs(tracks).reduce((sum, output) => sum + output.bitRateKbps, 0);
      const targetTotalKbps = (targetBytes * 8 * 0.90) / totalDur / 1000;
      let bitrate = Math.max(100, Math.round(targetTotalKbps - audioKbps));
      let actualBytes = 0;
      let actualMb = 0;
      let previousBytes: number | null = null;
      let runs = 0;
      const supportedEncoders = await listExportEncoders();
      let videoEncoder = settings.encoder === "auto"
        ? (supportedEncoders.find((encoder) => encoder.preferred)?.id ?? "libx264")
        : (supportedEncoders.find((encoder) => encoder.id === settings.encoder)?.id ?? "libx264");
      let usedAutoFallback = false;

      console.info("[editor][export] starting", {
        input: clip.path,
        output: outFile,
        streams: tracks.map((track) => ({ streamIndex: track.streamIndex, name: track.name, muted: track.muted, volume: track.volume })),
        segments,
        totalDurationSec: totalDur,
        targetMb: settings.targetMb,
        encoder: settings.encoder,
      });
      this.emitProgress(clip.id, "Preparing export", 0, 0, totalDur);

      while (runs < MAX_RUNS) {
        runs++;
        try {
          await this.runSinglePass(
            clip,
            segments,
            tracks,
            outFile,
            resolution.w,
            resolution.h,
            fps,
            bitrate,
            videoEncoder,
            totalDur,
            runs,
          );
        } catch (error) {
          if (settings.encoder === "auto" && videoEncoder !== "libx264" && !usedAutoFallback) {
            console.warn("[editor][export] hardware encoder failed; retrying with x264", { videoEncoder, error });
            usedAutoFallback = true;
            videoEncoder = "libx264";
            runs--;
            await fs.unlink(outFile).catch(() => {});
            this.emitProgress(clip.id, "Falling back to x264", 0, 0, totalDur);
            continue;
          }
          throw error;
        }
        if (this.cancelled) break;

        const stat = await fs.stat(outFile);
        actualBytes = stat.size;
        actualMb = actualBytes / (1024 * 1024);
        const outputProbe = await ffprobeAsync(outFile);
        const durationError = Math.abs(outputProbe.durationSec - totalDur);
        if (durationError > Math.max(0.35, 2 / fps)) {
          throw new Error(
            `Export verification failed: expected ${totalDur.toFixed(3)}s, received ${outputProbe.durationSec.toFixed(3)}s`,
          );
        }
        if (actualBytes <= targetBytes) break;

        const ratio = targetBytes / actualBytes;
        // The quality pass did not target `bitrate`. Start fitting at the full
        // budget; only scale a bitrate that an earlier fitting pass actually used.
        const nextBitrate = runs === 1 ? bitrate : Math.max(100, Math.floor(bitrate * ratio * 0.96));
        const stalled = previousBytes !== null && actualBytes >= previousBytes * 0.95;
        previousBytes = actualBytes;
        if (runs > 1 && (stalled || nextBitrate >= bitrate - 1) && (resolution.w > 640 || resolution.h > 360)) {
          resolution = dropRes(resolution.w, resolution.h);
          bitrate = Math.max(100, Math.min(nextBitrate, Math.floor(bitrate * 0.80)));
          this.emitProgress(clip.id, "Reducing resolution", 0, 0, totalDur);
          continue;
        }
        bitrate = nextBitrate;
        this.emitProgress(clip.id, "Correcting file size", 0, 0, totalDur);
      }

      if (this.cancelled) {
        await fs.unlink(outFile).catch(() => {});
        this.emitDone({ clipId: clip.id, error: "Export cancelled" });
        return { ok: false, cancelled: true };
      }

      if (actualMb <= 0) throw new Error("FFmpeg produced an empty output file");
      if (actualBytes > targetBytes) {
        throw new Error(
          `Could not fit the export under ${settings.targetMb} MB after ${MAX_RUNS} attempts (smallest was ${actualMb.toFixed(2)} MB)`,
        );
      }
      this.emitDone({
        clipId: clip.id,
        result: {
          path: outFile,
          sizeMb: Math.round(actualMb * 100) / 100,
          overTarget: false,
        },
      });
      console.info("[editor][export] complete", { output: outFile, sizeMb: actualMb, durationSec: totalDur });
      return { ok: true };
    } catch (error) {
      if (outFile) await fs.unlink(outFile).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      console.error("[editor][export] failed", { input: clip.path, output: outFile, error: message });
      this.emitDone({ clipId: clip.id, error: `Export failed: ${message}` });
      return { ok: false };
    } finally {
      this.current = null;
      this.active = false;
    }
  }

  cancel(): void {
    if (!this.active) return;
    this.cancelled = true;
    this.current?.kill("SIGKILL");
  }

  private async runSinglePass(
    clip: ClipRecord,
    segments: ExportSegment[],
    tracks: ExportAudioTrack[],
    outFile: string,
    width: number,
    height: number,
    fps: number,
    bitrateKbps: number,
    videoEncoder: string,
    totalDur: number,
    attempt: number,
  ): Promise<void> {
    const graph = buildExportGraph(segments, tracks, width, height);
    const videoArgs = buildVideoEncoderArgs(videoEncoder, bitrateKbps, fps, attempt === 1);
    const metadataArgs = graph.audioOutputs.flatMap((output, index) => [
      `-metadata:s:a:${index}`, `title=${output.name}`,
    ]);
    const audioArgs = graph.audioOutputs.flatMap((output, index) => [
      `-c:a:${index}`, "aac",
      `-b:a:${index}`, `${output.bitRateKbps}k`,
      `-disposition:a:${index}`, index === 0 ? "default" : "0",
    ]);
    // Single-pass: no passlog, much faster
    await this.spawnWithProgress(
      [
        "-y",
        "-i",
        clip.path,
        "-progress",
        "pipe:1",
        "-nostats",
        "-filter_complex",
        graph.filter,
        ...graph.maps,
        ...videoArgs,
        ...audioArgs,
        ...metadataArgs,
        "-movflags",
        "+faststart",
        outFile,
      ],
      clip.id,
      attempt === 1 ? "Encoding" : `Encoding · retry ${attempt}`,
      totalDur,
      0,
      100,
    );
  }

  private spawnWithProgress(
    args: string[],
    clipId: string,
    phase: string,
    totalDur: number,
    percentStart: number,
    percentEnd: number,
  ): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const exe = path.join(ffmpegBin(), "ffmpeg.exe");
    console.info("[editor][ffmpeg] spawn", { executable: exe, arguments: args });
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.current = child;
    let stdoutBuffer = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      let elapsed = 0;
      for (const line of lines) {
        const match = /^(?:out_time_us|out_time_ms)=(\d+)$/.exec(line);
        if (match) elapsed = Number(match[1]) / 1e6;
      }
      if (!elapsed || this.cancelled) return;
      const fraction = totalDur > 0 ? Math.min(1, elapsed / totalDur) : 0;
      this.emitProgress(
        clipId,
        phase,
        percentStart + fraction * (percentEnd - percentStart),
        Math.min(totalDur, elapsed),
        totalDur,
      );
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = `${stderr}${data.toString("utf8")}`.slice(-MAX_FFMPEG_DIAGNOSTIC);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (this.current === child) this.current = null;
      if (this.cancelled) {
        resolve();
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const diagnostic = stderr.trim() || "FFmpeg returned no diagnostic output";
      console.error("[editor][ffmpeg] process failed", { phase, exitCode: code, stderr: diagnostic });
      reject(new Error(`FFmpeg ${phase} failed with code ${code}: ${diagnostic}`));
    });
    return promise;
  }

  private emitProgress(clipId: string, phase: string, percent: number, elapsedSec: number, totalSec: number): void {
    this.emit("progress", {
      clipId,
      phase,
      percent: Math.max(0, Math.min(100, percent)),
      elapsedSec,
      totalSec,
    } satisfies ExportProgress);
  }

  private emitDone(payload: { clipId: string; error?: string; result?: ExportResult }): void {
    this.emit("progress", {
      clipId: payload.clipId,
      phase: "done",
      percent: 100,
      elapsedSec: undefined,
      totalSec: undefined,
      done: true,
      error: payload.error,
      result: payload.result,
    } satisfies ExportProgress);
  }
}

async function availableOutputPath(directory: string, base: string, extension: string): Promise<string> {
  for (let suffix = 1; suffix < 10000; suffix++) {
    const candidate = path.join(directory, `${base}${suffix === 1 ? "" : `-${suffix}`}${extension}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("Could not allocate a unique export filename");
}

async function cleanupPassLogs(passLog: string): Promise<void> {
  await Promise.all([
    `${passLog}-0.log`,
    `${passLog}-0.log.mbtree`,
    `${passLog}-0.log.cutree`,
    `${passLog}.log`,
    `${passLog}.cutree`,
  ].map((file) => fs.unlink(file).catch(() => {})));
}

function dropRes(width: number, height: number): { w: number; h: number } {
  return pickResolution(height >= 1080 ? "720p" : height >= 720 ? "480p" : "360p", { w: width, h: height });
}
