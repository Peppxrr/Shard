// Recording priority: an opt-in Windows scheduled task that starts only the
// native core elevated, so libobs can raise its own GPU priority. The task
// and its administrators-only runtime copy are managed by shardcore's
// --priority-task helper (core/src/priority_task.*); the UI never elevates.
import { EventEmitter } from "node:events";
import path from "node:path";
import { spawn } from "./bundled-processes";
import type { RecordingPriorityStatus } from "../shared/contracts";

interface HelperResult {
  code: number | null;
  report: Record<string, unknown> | null;
}

// Plain-English reasons for the bridge's "PRIORITY FALLBACK <reason>".
const FALLBACK_MESSAGES: Record<string, string> = {
  not_installed: "Recording priority isn't set up on this PC. Turn it off and on again.",
  runtime_changed: "Shard was updated. Turn Recording priority on again to update the elevated capture core.",
  runtime_copy_missing: "The elevated copy of the capture core is missing. Turn Recording priority on again.",
  runtime_copy_invalid: "The elevated copy of the capture core is damaged. Turn Recording priority on again.",
  profile_changed: "Recording priority was set up for a different Shard profile. Turn it on again.",
  task_target_changed: "Recording priority was set up for a different Shard install. Turn it on again.",
};

export function priorityFallbackMessage(reason: string): string {
  return FALLBACK_MESSAGES[reason] ??
    "Windows couldn't start the elevated capture core, so Shard is recording normally. Export diagnostics if this keeps happening.";
}

export interface RecordingPriorityOptions {
  // Identical to the core launch (CoreClient.launchPaths).
  launchPaths: () => { bin: string; configDir: string; games: string };
  enabled: () => boolean;
  coreSession: () => { elevated: boolean; gpuPriority: RecordingPriorityStatus["gpuPriority"] } | null;
  parentWindow: () => string | null;
}

export class RecordingPriority extends EventEmitter {
  private busy = false;
  private installed = false;
  private current = false;
  private message: string | null = null;

  constructor(private readonly options: RecordingPriorityOptions) {
    super();
  }

  status(): RecordingPriorityStatus {
    const session = this.options.coreSession();
    return {
      enabled: this.options.enabled(),
      supported: process.platform === "win32",
      installed: this.installed,
      current: this.current,
      coreElevated: session?.elevated ?? false,
      gpuPriority: session?.gpuPriority ?? "unknown",
      busy: this.busy,
      message: this.message,
    };
  }

  async refresh(): Promise<RecordingPriorityStatus> {
    if (process.platform !== "win32") return this.status();
    const { report } = await this.run("status");
    if (report) {
      this.installed = report.installed === true;
      this.current = report.current === true;
    }
    return this.publish();
  }

  noteFallback(reason: string): void {
    this.message = priorityFallbackMessage(reason);
    this.current = false;
    this.publish();
  }

  noteMessage(message: string | null): void {
    this.message = message;
    this.publish();
  }

  // Registers the task (one UAC prompt). Resolves false when declined/failed.
  async install(): Promise<boolean> {
    return this.change("install");
  }

  // Removes the task and its runtime copy (UAC only if anything exists).
  async uninstall(): Promise<boolean> {
    return this.change("uninstall");
  }

  private async change(mode: "install" | "uninstall"): Promise<boolean> {
    if (this.busy) throw new Error("Recording priority is already being changed");
    this.busy = true;
    this.publish();
    try {
      const { code, report } = await this.run(mode);
      const ok = code === 0 && report?.ok === true;
      this.message = ok ? null : typeof report?.error === "string" ? report.error : "Recording priority could not be changed.";
      const status = report?.status;
      if (ok && mode === "install" && status && typeof status === "object") {
        this.installed = (status as Record<string, unknown>).installed === true;
        this.current = (status as Record<string, unknown>).current === true;
      } else if (ok && mode === "uninstall") {
        this.installed = false;
        this.current = false;
      }
      return ok;
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  private publish(): RecordingPriorityStatus {
    const status = this.status();
    this.emit("status", status);
    return status;
  }

  private run(mode: "status" | "install" | "uninstall"): Promise<HelperResult> {
    const { bin, configDir, games } = this.options.launchPaths();
    const args = ["--priority-task", mode, "--config-dir", configDir, "--core-bin", bin, "--games", games];
    const parent = this.options.parentWindow();
    if (parent) args.push("--parent-window", parent);
    const { promise, resolve } = Promise.withResolvers<HelperResult>();
    let stdout = "";
    const child = spawn(path.join(bin, "shardcore.exe"), args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.once("error", () => resolve({ code: null, report: null }));
    child.once("close", code => {
      const line = stdout.split(/\r?\n/).find(text => text.startsWith("PRIORITY {"));
      let report: Record<string, unknown> | null = null;
      if (line) {
        try {
          const parsed: unknown = JSON.parse(line.slice("PRIORITY ".length));
          if (parsed && typeof parsed === "object") report = parsed as Record<string, unknown>; // validated per field above
        } catch { report = null; }
      }
      resolve({ code, report });
    });
    return promise;
  }
}
