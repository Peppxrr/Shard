// export.ts — the size-fit export pipeline (plan step 24):
// retained segments -> concat trim -> two-pass encode at a bitrate that fits
// targetMb; verify; correction passes scaled by target/actual; resolution
// ladder for `auto`. One job at a time, cancelable, progress events.
import { spawn, ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ClipRecord, ExportProgress, ExportResult, ExportSettings } from "../shared/contracts";
import { ffmpegBin, ffprobe } from "./ffmpeg";
import { editorDir } from "./library";

export interface Segment {
  start: number;
  end: number;
}

const MAX_RUNS = 3;

export class ExportManager extends EventEmitter {
  private current: ChildProcess | null = null;
  private cancelled = false;

  get busy(): boolean {
    return this.current !== null;
  }

  async export(
    clip: ClipRecord, segments: Segment[], settings: ExportSettings, audioTracks: number[] = [0],
  ): Promise<{ ok: boolean; cancelled?: boolean }> {
    if (this.current) {
      this.emitDone({ clipId: clip.id, error: "An export is already running" });
      return { ok: false };
    }
    this.cancelled = false;

    const outDir = editorDir();
    await fs.mkdir(outDir, { recursive: true }).catch(() => {});
    const base = path.basename(clip.path, path.extname(clip.path));
    const outFile = path.join(outDir, `${base}-edited.mp4`);
    const passLog = path.join(outDir, `${base}-2pass`);

    const totalDur = segments.reduce((s, seg) => s + (seg.end - seg.start), 0);
    if (totalDur <= 0) {
      this.emitDone({ clipId: clip.id, error: "No retained segments to export" });
      return { ok: false };
    }

    const sourceRes = { w: clip.width ?? 1920, h: clip.height ?? 1080 };
    const fps = clip.fps ?? 30;
    const { w, h } = pickResolution(settings.resolution, totalDur, sourceRes);

    const targetBytes = settings.targetMb * 1024 * 1024;
    let bitrate = Math.max(100, Math.round((targetBytes * 8 * 0.9) / totalDur / 1000)); // kbps

    this.emit("progress", { clipId: clip.id, phase: "encoding", percent: 0 } satisfies ExportProgress);

    let actualMb = 0;
    let runs = 0;
    let droppedRes = false;
    let lastErr: unknown = null;

    while (runs < MAX_RUNS) {
      runs++;
      try {
        await this.runPasses(clip, segments, outFile, passLog, w, h, fps, bitrate, settings, totalDur, audioTracks);
      } catch (e) {
        lastErr = e;
        break;
      }
      if (this.cancelled) break;

      actualMb = (await fs.stat(outFile).catch(() => ({ size: 0 }))).size / (1024 * 1024);
      if (actualMb <= settings.targetMb) break;

      // Over target: scale bitrate by the ratio and retry.
      const ratio = settings.targetMb / actualMb;
      const nextBitrate = Math.max(100, Math.round(bitrate * ratio));
      if (nextBitrate >= bitrate - 1) {
        // Bitrate won't shrink enough: drop one resolution step, once.
        if (!droppedRes && (w > 640 || h > 360)) {
          droppedRes = true;
          const { w: w2, h: h2 } = dropRes(w, h);
          this.emit("progress", { clipId: clip.id, phase: "dropping resolution", percent: 85 } satisfies ExportProgress);
          bitrate = Math.round(nextBitrate * 0.8);
          continue;
        }
        break;
      }
      bitrate = nextBitrate;
      this.emit("progress", { clipId: clip.id, phase: "correction pass", percent: 80 } satisfies ExportProgress);
    }

    // Clean pass logs.
    await Promise.all([fs.unlink(`${passLog}-0.log`).catch(() => {}), fs.unlink(`${passLog}-1.log`).catch(() => {})]);

    if (this.cancelled) {
      await fs.unlink(outFile).catch(() => {});
      this.emitDone({ clipId: clip.id, error: "Export cancelled" });
      return { ok: false, cancelled: true };
    }
    if (actualMb === 0 && lastErr) {
      this.emitDone({ clipId: clip.id, error: `Export failed: ${(lastErr as Error).message}` });
      return { ok: false };
    }

    this.emitDone({
      clipId: clip.id,
      result: {
        path: outFile,
        sizeMb: Math.round(actualMb * 100) / 100,
        overTarget: actualMb > settings.targetMb,
      },
    });
    return { ok: true };
  }

  private emitDone(p: { clipId: string; error?: string; result?: ExportResult }): void {
    this.emit("progress", {
      clipId: p.clipId,
      phase: "done",
      percent: 100,
      done: true,
      error: p.error,
      result: p.result,
    } satisfies ExportProgress);
  }

  cancel(): void {
    this.cancelled = true;
    this.current?.kill("SIGKILL");
  }

  private async runPasses(
    clip: ClipRecord, segments: Segment[], outFile: string, passLog: string,
    w: number, h: number, fps: number, bitrateKbps: number, settings: ExportSettings, totalDur: number,
    audioTracks: number[],
  ): Promise<void> {
    const filter = buildFilter(segments, audioTracks);
    const videoCodec = settings.codec === "h265" ? "libx265" : "libx264";
    const maps = audioTracks.length ? ["-map", "[v]", ...audioTracks.map((_, i) => ["-map", `[a${i}]`]).flat()] : ["-map", "[v]", "-an"];
    const baseArgs = [
      "-y", "-i", clip.path,
      "-progress", "pipe:1",
      "-nostats",
      "-filter_complex", filter,
      ...maps,
      "-c:v", videoCodec,
      "-b:v", `${bitrateKbps}k`,
      "-maxrate", `${bitrateKbps}k`,
      "-bufsize", `${bitrateKbps * 2}k`,
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      "-c:a", "aac", "-b:a", `${settings.audioBitrateKbps}k`,
      "-movflags", "+faststart",
    ];
    // Pass 1 (stats only; no media output)
    await this.spawnWithProgress([
      ...baseArgs, "-pass", "1", "-passlogfile", passLog, "-an", "-f", "mp4", "NUL",
    ], clip.id, "pass 1", totalDur);
    if (this.cancelled) return;
    // Pass 2
    await this.spawnWithProgress([
      ...baseArgs, "-pass", "2", "-passlogfile", passLog, outFile,
    ], clip.id, "pass 2", totalDur);
  }

  private spawnWithProgress(args: string[], clipId: string, phase: string, totalDur: number): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const exe = path.join(ffmpegBin(), "ffmpeg.exe");
    const child = spawn(exe, args, { windowsHide: true });
    this.current = child;
    let outUs = 0;
    let buf = "";

    // ffmpeg -progress pipe:1 emits `out_time_ms=<usec>` key/value blocks
    // on stdout; the value may span chunks, so keep a bounded tail buffer
    // and re-scan it.
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      if (buf.length > 65536) buf = buf.slice(-4096);
      const matches = buf.match(/out_time_ms=(\d+)/g);
      if (matches) outUs = Number(matches[matches.length - 1].split("=")[1]);
      if (this.cancelled) return;
      const frac = totalDur > 0 ? outUs / 1e6 / totalDur : 0;
      const percent = phase === "pass 1" ? Math.min(50, frac * 50) : Math.min(100, 50 + frac * 50);
      this.emit("progress", { clipId, phase, percent } satisfies ExportProgress);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      this.current = null;
      if (this.cancelled) return resolve();
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${phase} failed with code ${code}`));
    });
    return promise;
  }
}

function buildFilter(segments: Segment[], audioTracks: number[]): string {
  const parts: string[] = [];
  const vin: string[] = [];
  segments.forEach((seg, i) => {
    parts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`);
    vin.push(`[v${i}]`);
  });
  const audioOuts: string[] = [];
  const allIn = [...vin];
  let n = segments.length;
  audioTracks.forEach((t, ti) => {
    segments.forEach((seg, i) => {
      parts.push(`[0:a:${t}]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[at${ti}_${i}]`);
      allIn.push(`[at${ti}_${i}]`);
      n++;
    });
    audioOuts.push(`[a${ti}]`);
  });
  // One concat: video segments + each selected track's segments -> [v][a0][a1]...
  parts.push(`${allIn.join("")}concat=n=${n}:v=1:a=${audioTracks.length}[v]${audioOuts.join("")}`);
  return parts.join(";");
}

function pickResolution(mode: string, totalDur: number, source: { w: number; h: number }): { w: number; h: number } {
  const ladder = [
    { dur: 60, w: 1920, h: 1080 },
    { dur: 180, w: 1280, h: 720 },
    { dur: 600, w: 854, h: 480 },
    { dur: Infinity, w: 640, h: 360 },
  ];
  let target = { w: 1920, h: 1080 };
  if (mode === "auto") {
    target = ladder.find((l) => totalDur <= l.dur) ?? ladder[ladder.length - 1];
  } else if (mode !== "source") {
    const m = mode.match(/^(\d+)p$/);
    if (m) {
      const h = Number(m[1]);
      target = { w: Math.round((h * 16) / 9), h };
    }
  } else {
    target = source;
  }
  // Never upscale.
  const scale = Math.min(1, target.w / source.w, target.h / source.h);
  const w = Math.max(2, Math.round(source.w * scale));
  const h = Math.max(2, Math.round(source.h * scale));
  return { w: w % 2 ? w - 1 : w, h: h % 2 ? h - 1 : h };
}

function dropRes(w: number, h: number): { w: number; h: number } {
  return pickResolution(h >= 1080 ? "720p" : h >= 720 ? "480p" : "360p", 0, { w, h });
}
