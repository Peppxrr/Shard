import { spawn } from "./bundled-processes";
import { runEditorPreparation } from "./editor-preparation";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

type Subscriber = {
  update: (frames: string[]) => void; foreground: boolean; count: number; level: number;
  resolve: (frames: string[]) => void; reject: (error: unknown) => void; detach: () => void;
};
type Job = {
  file: string; directory: string; duration: number; frames: string[]; subscribers: Set<Subscriber>;
  controller: AbortController; running: boolean; initializing: boolean; drained: Promise<void>; drain: () => void;
};
type Options = { maxBytes?: number; onProcessStart?: () => void; onCacheScan?: () => void };
type CacheEntry = { directory: string; modified: number; bytes: number };
// Dyadic positions are stable across zoom levels. Every level contains the
// previous one; breadth-first order fills the whole timeline before its gaps.
const SAMPLE_ORDER = [0];
for (let spacing = 32; spacing >= 1; spacing /= 2) {
  for (let index = spacing; index < 64; index += spacing * 2) SAMPLE_ORDER.push(index);
}
const CACHE_VERSION = "sparse-batch-v2";

export class TimelinePreviews {
  private jobs = new Map<string, Job>();
  private stopped = false;
  private warmups = new Set<string>();
  private removals = new Map<string, Promise<void>>();
  private sourceChecks = new Map<string, Set<{ deleted: boolean }>>();
  private maintenance: Promise<void> = Promise.resolve();
  private cacheIndex = new Map<string, CacheEntry>();
  private cacheIndexed = false;
  private root: string;
  private maxBytes: number;
  private executable: string;
  private options: Options;

  constructor(root: string, executable: string, options: Options = {}) {
    this.root = path.resolve(root);
    this.executable = executable;
    this.options = options;
    this.maxBytes = options.maxBytes ?? 96 * 1024 * 1024;
    if (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0) throw new Error("Invalid preview cache budget");
  }

  async generate(file: string, duration: number, count: number, update = (_frames: string[]) => {},
    signal?: AbortSignal, foreground = true): Promise<string[]> {
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(count)) throw new Error("Invalid timeline request");
    file = path.resolve(file);
    count = Math.max(8, Math.min(48, Math.round(count)));
    const level = 2 ** Math.ceil(Math.log2(count));
    const identity = this.fileKey(file);
    signal?.throwIfAborted();
    if (this.stopped) throw new Error("Preview service stopped");
    if (this.removals.has(identity)) throw new Error("Source clip deleted");
    // Track only pending identity reads, rather than retaining deleted sources.
    let checks = this.sourceChecks.get(identity);
    if (!checks) this.sourceChecks.set(identity, checks = new Set());
    const check = { deleted: false };
    checks.add(check);
    const stat = await fs.stat(file).finally(() => {
      checks.delete(check);
      if (!checks.size) this.sourceChecks.delete(identity);
    });
    signal?.throwIfAborted();
    if (this.stopped) throw new Error("Preview service stopped");
    if (this.removals.has(identity) || check.deleted) throw new Error("Source clip deleted");
    const key = `${identity}-${hash(`${stat.mtimeMs}:${stat.size}:${duration}:${CACHE_VERSION}`)}`;
    let job = this.jobs.get(key);
    if (job?.controller.signal.aborted) {
      await job.drained;
      return this.generate(file, duration, count, update, signal, foreground);
    }
    if (!job) {
      const completion = Promise.withResolvers<void>();
      job = { file, directory: path.join(this.root, key), duration, frames: Array(64).fill(""),
        subscribers: new Set(), controller: new AbortController(), running: false, initializing: true,
        drained: completion.promise, drain: completion.resolve };
      this.jobs.set(key, job);
      const current = job;
      void this.initialize(current).catch(error => this.fail(current, error)).finally(() => {
        current.initializing = false;
        this.pump(current);
      });
    }
    const current = job;
    return new Promise((resolve, reject) => {
      const abort = () => {
        subscriber.detach(); reject(new Error("Timeline preview cancelled"));
        if (!current.subscribers.size) this.fail(current, new Error("Timeline preview cancelled"));
      };
      const subscriber: Subscriber = { update, foreground, count, level, resolve, reject,
        detach: () => { current.subscribers.delete(subscriber); signal?.removeEventListener("abort", abort); } };
      current.subscribers.add(subscriber);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      this.publish(current); this.pump(current);
    });
  }

  warm(file: string, duration: number): void {
    if (this.warmups.size >= 2 || this.warmups.has(file)) return;
    this.warmups.add(file);
    void this.generate(file, duration, 8, undefined, undefined, false).catch(() => {})
      .finally(() => this.warmups.delete(file));
  }

  async remove(file: string): Promise<void> {
    file = path.resolve(file);
    const identity = this.fileKey(file);
    const existing = this.removals.get(identity);
    if (existing) return existing;
    // A stat already in flight must not recreate previews after removal ends.
    for (const check of this.sourceChecks.get(identity) ?? []) check.deleted = true;
    const removal = this.removeSource(file);
    this.removals.set(identity, removal);
    try { await removal; } finally { this.removals.delete(identity); }
  }

  private async removeSource(file: string): Promise<void> {
    const active = [...this.jobs.values()].filter(job => this.fileKey(job.file) === this.fileKey(file));
    for (const job of active) this.fail(job, new Error("Source clip deleted"));
    await Promise.all(active.map(job => job.drained));
    await this.maintain(async () => {
      await this.indexCache();
      const prefixes = this.prefixes(file);
      for (const directory of this.cacheIndex.keys()) {
        if (prefixes.some(prefix => path.basename(directory).startsWith(prefix))) await this.removeDirectory(directory);
      }
    });
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) this.fail(job, new Error("Preview service stopped"));
    await Promise.all(jobs.map(job => job.drained));
    await this.maintenance;
  }

  resume(): void { this.stopped = false; }
  private fileKey(file: string): string {
    const absolute = path.resolve(file);
    return hash(process.platform === "win32" ? absolute.toLowerCase() : absolute);
  }
  private output(job: Job, index: number): string { return path.join(job.directory, `frame-${String(index).padStart(3, "0")}.jpg`); }
  private prefixes(file: string): string[] {
    // Pre-v2 caches hashed case-sensitive paths, including on Windows.
    return [...new Set([this.fileKey(file), hash(path.resolve(file))])].map(key => `${key}-`);
  }

  private async initialize(job: Job): Promise<void> {
    // Changed source identities replace old formats and count-specific sets.
    const stale = [...this.jobs.values()].filter(other => other !== job && this.fileKey(other.file) === this.fileKey(job.file));
    for (const other of stale) this.fail(other, new Error("Source clip changed"));
    await Promise.all(stale.map(other => other.drained));
    await this.maintain(async () => {
      await fs.mkdir(this.root, { recursive: true });
      job.controller.signal.throwIfAborted();
      await this.indexCache();
      const prefixes = this.prefixes(job.file);
      for (const directory of this.cacheIndex.keys()) {
        if (prefixes.some(prefix => path.basename(directory).startsWith(prefix)) && directory !== job.directory) {
          await this.removeDirectory(directory);
        }
      }
      await fs.mkdir(job.directory, { recursive: true });
      // Only atomic frame-NNN.jpg commits count as cache hits after a crash.
      for (const name of await fs.readdir(job.directory)) {
        if (name.includes(".tmp.")) await fs.unlink(path.join(job.directory, name)).catch(() => {});
      }
      await fs.utimes(job.directory, new Date(), new Date());
      const files = await this.refreshDirectory(job.directory);
      for (let index = 0; index < job.frames.length; index++) {
        const output = this.output(job, index);
        if (files.get(path.basename(output))) job.frames[index] = output;
      }
      await this.prune();
    });
    job.controller.signal.throwIfAborted(); this.publish(job);
  }

  private pump(job: Job): void {
    if (job.initializing || job.running) return;
    if (job.controller.signal.aborted) { this.finish(job); return; }
    for (const subscriber of [...job.subscribers]) {
      if (SAMPLE_ORDER.slice(0, subscriber.level).every(index => job.frames[index])) {
        subscriber.detach(); subscriber.resolve(this.renderFrames(job, subscriber));
      }
    }
    if (!job.subscribers.size) { this.finish(job); return; }
    const level = Math.max(...[...job.subscribers].map(subscriber => subscriber.level));
    const indices = SAMPLE_ORDER.slice(0, level).filter(index => !job.frames[index]).slice(0, 4);
    const coarse = indices.some(index => SAMPLE_ORDER.indexOf(index) < 8);
    job.running = true;
    // A foreground open can promote already queued background work.
    void runEditorPreparation(() => [...job.subscribers].some(subscriber => subscriber.foreground)
      ? (coarse ? "filmstrip-coarse" : "filmstrip-detail") : "background",
      job.controller.signal, () => this.extract(job, indices, coarse)).then(() => this.publish(job), error => this.fail(job, error))
      .finally(() => { job.running = false; this.pump(job); });
  }

  private renderFrames(job: Job, subscriber: Subscriber): string[] {
    const spacing = 64 / subscriber.level;
    return Array.from({ length: subscriber.count }, (_, index) =>
      job.frames[Math.floor(index * subscriber.level / subscriber.count) * spacing]);
  }

  private async extract(job: Job, indices: number[], coarse: boolean): Promise<void> {
    const temporary = indices.map(index => `${this.output(job, index)}.${randomUUID()}.tmp.jpg`);
    const args = ["-y", "-v", "error", "-filter_threads", "1", "-filter_complex_threads", "1"];
    for (const index of indices) {
      const time = Math.max(0, Math.min(job.duration - 0.1, index * job.duration / 64));
      // AV1 accurate seeks can decode a whole GOP. Coarse samples may use the
      // preceding keyframe (normally 2 seconds apart); detail remains accurate.
      args.push("-ss", time.toFixed(6), "-threads", "1");
      if (coarse && job.duration >= 16) args.push("-noaccurate_seek", "-skip_frame", "nokey");
      args.push("-i", job.file);
    }
    for (let input = 0; input < indices.length; input++) {
      args.push("-map", `${input}:v:0`, "-an", "-sn", "-dn", "-threads", "1",
        "-vf", "scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2:color=black",
        "-frames:v", "1", "-q:v", "5", "-update", "1", temporary[input]);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
        this.options.onProcessStart?.();
        let stderr = "";
        let spawnError: Error | undefined;
        const abort = () => { child.kill(); };
        const timer = setTimeout(abort, 30000);
        job.controller.signal.addEventListener("abort", abort, { once: true });
        if (job.controller.signal.aborted) abort();
        child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2048); });
        child.once("error", error => { spawnError = error; });
        child.once("close", code => {
          clearTimeout(timer); job.controller.signal.removeEventListener("abort", abort);
          if (code === 0 && !job.controller.signal.aborted && !spawnError) resolve();
          else reject(spawnError ?? new Error(`Timeline preview failed: ${stderr || code}`));
        });
      });
      job.controller.signal.throwIfAborted();
      // Temporary JPEGs count toward admission too. Active clips are never
      // evicted, so refuse another commit if they already consume the budget.
      // Overshoot is limited to this one small, four-image batch until cleanup.
      await this.maintain(async () => {
        // Only this directory can gain bytes: preparation has one process slot.
        await this.refreshDirectory(job.directory);
        if (await this.prune() > this.maxBytes) throw new Error("Timeline preview cache budget exhausted");
      });
      for (let index = 0; index < indices.length; index++) {
        if (!(await fs.stat(temporary[index])).size) throw new Error("Empty timeline frame");
        job.controller.signal.throwIfAborted();
        await fs.rename(temporary[index], this.output(job, indices[index]));
        job.frames[indices[index]] = this.output(job, indices[index]);
      }
      const accessed = new Date();
      await fs.utimes(job.directory, accessed, accessed);
    } finally {
      await Promise.all(temporary.map(file => fs.unlink(file).catch(() => {})));
      // Renames preserve bytes; cancellation can remove uncommitted files.
      await this.maintain(async () => { await this.refreshDirectory(job.directory); });
    }
  }

  private publish(job: Job): void {
    for (const subscriber of [...job.subscribers]) {
      try { subscriber.update(this.renderFrames(job, subscriber)); } catch { /* Closed renderer. */ }
    }
  }
  private fail(job: Job, error: unknown): void {
    job.controller.abort();
    for (const subscriber of [...job.subscribers]) { subscriber.detach(); subscriber.reject(error); }
    if (!job.running && !job.initializing) this.finish(job);
  }
  private finish(job: Job): void {
    for (const [key, current] of this.jobs) if (current === job) this.jobs.delete(key);
    job.drain(); void this.maintain(async () => { await this.prune(); }).catch(() => {});
  }
  private maintain(task: () => Promise<void>): Promise<void> {
    const next = this.maintenance.then(task);
    this.maintenance = next.catch(() => {}); return next;
  }
  private async removeDirectory(directory: string): Promise<void> {
    await fs.rm(directory, { recursive: true, force: true });
    this.cacheIndex.delete(directory);
  }
  private async refreshDirectory(directory: string): Promise<Map<string, number>> {
    const stat = await fs.stat(directory).catch(() => null);
    if (!stat) { this.cacheIndex.delete(directory); return new Map(); }
    const files = await fs.readdir(directory);
    const sizes = await Promise.all(files.map(async file =>
      [file, await fs.stat(path.join(directory, file)).then(stat => stat.size, () => 0)] as const));
    this.cacheIndex.set(directory, { directory, modified: stat.mtimeMs, bytes: sizes.reduce((sum, [, size]) => sum + size, 0) });
    return new Map(sizes);
  }
  private async indexCache(): Promise<void> {
    if (this.cacheIndexed) return;
    // This service exclusively owns the root. Read actual disk sizes once,
    // then update only directories it changes; cache hits never stat the library.
    this.options.onCacheScan?.();
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter(entry => entry.isDirectory()).map(entry => this.refreshDirectory(path.join(this.root, entry.name))));
    this.cacheIndexed = true;
  }
  private async prune(): Promise<number> {
    await this.indexCache();
    const candidates = [...this.cacheIndex.values()].sort((a, b) => a.modified - b.modified);
    let bytes = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
    // Active reads/writes survive eviction. Batch admission checks the remaining
    // bytes; completing a job also schedules a sweep after releasing protection.
    for (const candidate of candidates) {
      if ([...this.jobs.values()].some(job => job.directory === candidate.directory)) continue;
      // Cancelled/failed first batches must not leave unlimited empty directories.
      if (bytes <= this.maxBytes && candidate.bytes > 0) continue;
      await this.removeDirectory(candidate.directory); bytes -= candidate.bytes;
    }
    return bytes;
  }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
