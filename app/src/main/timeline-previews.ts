import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

type Subscriber = { update: (frames: string[]) => void; foreground: boolean };
type Job = {
  file: string; directory: string; duration: number; frames: string[]; pending: number[];
  subscribers: Set<Subscriber>; controller: AbortController; running: number; ready: boolean; initializing: boolean; error?: unknown;
  promise: Promise<string[]>; resolve: (frames: string[]) => void; reject: (error: unknown) => void;
};

// Only two small, single-threaded decoders run at once, even during bulk import.
// Each request seeks to its sample instead of decoding the entire recording.
// Foreground work takes priority between frames; imports never block editor open.
export class TimelinePreviews {
  private jobs = new Map<string, Job>();
  private running = 0;
  private stopped = false;
  private warmups = new Set<string>();
  private root: string;
  private executable: string;

  constructor(root: string, executable: string) {
    this.root = path.resolve(root);
    this.executable = executable;
  }

  async generate(file: string, duration: number, count: number, update = (_frames: string[]) => {},
    signal?: AbortSignal, foreground = true): Promise<string[]> {
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(count)) throw new Error("Invalid timeline request");
    count = Math.max(8, Math.min(48, Math.round(count)));
    signal?.throwIfAborted();
    if (this.stopped) throw new Error("Preview service stopped");
    const stat = await fs.stat(file);
    signal?.throwIfAborted();
    if (this.stopped) throw new Error("Preview service stopped");
    const key = `${this.fileKey(file)}-${hash(`${stat.mtimeMs}:${stat.size}:${duration}:${count}:seek-v1`)}`;
    let job = this.jobs.get(key);
    if (job?.controller.signal.aborted) {
      await job.promise.catch(() => {});
      return this.generate(file, duration, count, update, signal, foreground);
    }
    if (!job) {
      const completion = Promise.withResolvers<string[]>();
      job = { file, directory: path.join(this.root, key), duration, frames: Array(count).fill(""),
        pending: [], subscribers: new Set(), controller: new AbortController(), running: 0, ready: false, initializing: true,
        ...completion };
      this.jobs.set(key, job);
      const current = job;
      // Handle completion even if every caller cancels before initialization ends.
      void job.promise.then(() => this.finish(key, current), () => this.finish(key, current));
      void this.initialize(job).catch((error) => this.fail(current, error)).finally(() => {
        current.initializing = false;
        this.settle(current);
      });
    }
    const current = job;
    return new Promise((resolve, reject) => {
      const subscriber = { update, foreground };
      current.subscribers.add(subscriber);
      const detach = () => {
        current.subscribers.delete(subscriber);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        detach();
        reject(new Error("Timeline preview cancelled"));
        if (!current.subscribers.size) this.fail(current, new Error("Timeline preview cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      try { update([...current.frames]); } catch { /* Closed renderer. */ }
      void current.promise.then((frames) => { detach(); resolve(frames); }, (error) => { detach(); reject(error); });
      this.pump();
    });
  }

  warm(file: string, duration: number): void {
    // A burst of imports must not queue an entire library or evict all warm clips.
    if (this.warmups.size >= 2 || this.warmups.has(file)) return;
    this.warmups.add(file);
    void this.generate(file, duration, 12, undefined, undefined, false)
      .catch(() => {}).finally(() => this.warmups.delete(file));
  }

  async remove(file: string): Promise<void> {
    const active = [...this.jobs.values()].filter((job) => job.file === file);
    for (const job of active) this.fail(job, new Error("Source clip deleted"));
    // Child close/temporary-file cleanup finishes before removing the directory.
    await Promise.allSettled(active.map((job) => job.promise));
    const prefix = `${this.fileKey(file)}-`;
    const entries = await fs.readdir(this.root).catch(() => [] as string[]);
    await Promise.all(entries.filter((name) => name.startsWith(prefix)).map((name) =>
      fs.rm(path.join(this.root, name), { recursive: true, force: true }).catch(() => {})));
  }

  dispose(): void {
    this.stopped = true;
    for (const job of this.jobs.values()) this.fail(job, new Error("Preview service stopped"));
  }

  private fileKey(file: string): string { return hash(path.resolve(file)); }

  private async initialize(job: Job): Promise<void> {
    await fs.mkdir(job.directory, { recursive: true });
    job.controller.signal.throwIfAborted();
    await Promise.all(job.frames.map(async (_, index) => {
      const output = this.output(job, index);
      if ((await fs.stat(output).catch(() => null))?.size) job.frames[index] = output;
    }));
    job.controller.signal.throwIfAborted();
    // Fill across the whole timeline early, then fill the gaps.
    const order = [0];
    const intervals = [[1, job.frames.length]];
    while (intervals.length) {
      const [start, end] = intervals.shift()!;
      if (start >= end) continue;
      const middle = Math.floor((start + end) / 2);
      order.push(middle);
      intervals.push([start, middle], [middle + 1, end]);
    }
    job.pending = order.filter((index) => !job.frames[index]);
    this.publish(job);
    await fs.utimes(job.directory, new Date(), new Date()).catch(() => {});
    if (!job.pending.length) return;
    job.ready = true;
    this.pump();
  }

  private pump(): void {
    while (this.running < 2) {
      const candidates = [...this.jobs.values()].filter((job) => job.ready && job.pending.length && !job.controller.signal.aborted);
      const job = candidates.find((candidate) => [...candidate.subscribers].some((sub) => sub.foreground)) ?? candidates[0];
      if (!job) return;
      const index = job.pending.shift()!;
      this.running++; job.running++;
      void this.extract(job, index).then(() => {
        job.frames[index] = this.output(job, index);
        this.publish(job);
      }, (error) => this.fail(job, error)).finally(() => {
        this.running--; job.running--;
        this.settle(job);
        this.pump();
      });
    }
  }

  private output(job: Job, index: number): string { return path.join(job.directory, `frame-${String(index).padStart(3, "0")}.jpg`); }

  private async extract(job: Job, index: number): Promise<void> {
    const output = this.output(job, index);
    const temporary = `${output}.${randomUUID()}.tmp.jpg`;
    const time = Math.max(0, Math.min(job.duration - 0.1, (index + 0.5) * job.duration / job.frames.length));
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.executable, [
          "-y", "-v", "error", "-threads", "1", "-filter_threads", "1",
          "-ss", time.toFixed(6), "-i", job.file, "-map", "0:v:0", "-an", "-sn", "-dn",
          "-vf", "scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2:color=black",
          "-frames:v", "1", "-q:v", "5", "-update", "1", temporary,
        ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        const abort = () => { child.kill(); };
        const timer = setTimeout(abort, 15000);
        job.controller.signal.addEventListener("abort", abort, { once: true });
        if (job.controller.signal.aborted) abort();
        child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2048); });
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(timer);
          job.controller.signal.removeEventListener("abort", abort);
          if (code === 0 && !job.controller.signal.aborted) resolve();
          else reject(new Error(`Timeline preview failed: ${stderr || code}`));
        });
      });
      job.controller.signal.throwIfAborted();
      if (!(await fs.stat(temporary)).size) throw new Error("Empty timeline frame");
      await fs.rename(temporary, output);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  private publish(job: Job): void {
    for (const subscriber of job.subscribers) {
      try { subscriber.update([...job.frames]); } catch { /* Closed renderer. */ }
    }
  }

  private fail(job: Job, error: unknown): void {
    if (!job.controller.signal.aborted) job.error = error;
    job.controller.abort();
    job.pending = [];
    this.settle(job);
  }

  private settle(job: Job): void {
    if (job.initializing || job.running || job.pending.length) return;
    if (job.controller.signal.aborted) job.reject(job.error);
    else job.resolve([...job.frames]);
  }

  private finish(key: string, job: Job): void {
    if (this.jobs.get(key) === job) this.jobs.delete(key);
    void this.prune().catch(() => {});
  }

  private async prune(): Promise<void> {
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const candidates = (await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const directory = path.join(this.root, entry.name);
      const stat = await fs.stat(directory).catch(() => null);
      return stat ? { directory, modified: stat.mtimeMs } : null;
    }))).filter((entry) => entry !== null).sort((a, b) => b.modified - a.modified);
    if (candidates.length <= 32) return;
    for (const candidate of candidates.slice(24)) {
      if ([...this.jobs.values()].some((job) => job.directory === candidate.directory)) continue;
      await fs.rm(candidate.directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
