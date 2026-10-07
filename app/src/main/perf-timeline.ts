// Per-session record of the core's perf.stats samples (once per second): a
// bounded in-memory window for the UI and a JSONL file per app session for
// diagnostics bundles. Older session files are pruned like developer-console
// logs.
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { PerfSample } from "../shared/contracts";

const MAX_MEMORY_SAMPLES = 3600; // one hour at 1 Hz
const MAX_SESSION_FILES = 5;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export class PerfTimeline {
  private samples: PerfSample[] = [];
  private stream: WriteStream | null = null;
  readonly directory: string;
  readonly sessionPath: string;

  constructor(logsDirectory: string) {
    this.directory = join(logsDirectory, "perf");
    const started = new Date().toISOString().replace(/[:.]/g, "-");
    this.sessionPath = join(this.directory, `perf-${started}-${process.pid}.jsonl`);
    try {
      mkdirSync(this.directory, { recursive: true });
      this.prune();
      this.stream = createWriteStream(this.sessionPath, { flags: "wx" });
      this.stream.on("error", () => { this.stream = null; });
    } catch {
      this.stream = null; // Diagnostics only; never block capture on logging.
    }
  }

  add(sample: PerfSample): void {
    this.samples.push(sample);
    if (this.samples.length > MAX_MEMORY_SAMPLES) this.samples.splice(0, this.samples.length - MAX_MEMORY_SAMPLES);
    this.stream?.write(`${JSON.stringify(sample)}\n`);
  }

  recent(): PerfSample[] {
    return this.samples.slice();
  }

  // Completes pending writes so a bundle copies a whole-record file.
  flush(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (this.stream) this.stream.write("", () => resolve());
    else resolve();
    return promise;
  }

  // Previous sessions' files, newest first.
  priorSessions(): string[] {
    try {
      return readdirSync(this.directory)
        .filter(name => name.startsWith("perf-") && name.endsWith(".jsonl"))
        .map(name => join(this.directory, name))
        .filter(file => file !== this.sessionPath)
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    } catch {
      return [];
    }
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }

  private prune(): void {
    const files = readdirSync(this.directory)
      .filter(name => name.startsWith("perf-") && name.endsWith(".jsonl"))
      .map(name => {
        const file = join(this.directory, name);
        const stat = statSync(file);
        return { file, size: stat.size, modified: stat.mtimeMs };
      })
      .sort((a, b) => b.modified - a.modified);
    let total = 0;
    files.forEach((entry, index) => {
      total += entry.size;
      // Keep room for this session's file among the retained ones.
      if (index >= MAX_SESSION_FILES - 1 || total > MAX_TOTAL_BYTES) {
        try { unlinkSync(entry.file); } catch { /* in use by another instance */ }
      }
    });
  }
}
