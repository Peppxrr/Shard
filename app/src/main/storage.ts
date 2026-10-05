// Automatic cleanup for ordinary clips. Small overages are cleared oldest-first
// as they arrive; a large overage waits for the user's explicit confirmation.
import { EventEmitter } from "node:events";
import type { Library } from "./library";
import { getSettings } from "./settings";
import { planStorageCleanup } from "../shared/storage-policy";
import type { StorageSettings, StorageStatus } from "../shared/contracts";

export class StorageWatchdog extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private pending?: Promise<number>;

  constructor(private library: Library) {
    super();
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.check(), 5 * 60 * 1000);
    void this.check();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
  }

  // `settings` previews unsaved values; cleanup itself always uses saved ones.
  status(settings: StorageSettings = getSettings().storage): StorageStatus {
    return planStorageCleanup(this.library.storageSnapshot(), settings, Date.now()).status;
  }

  // Save/import/timer triggers share one pass, including its shutdown drain.
  check(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    return this.pending ?? this.enqueue();
  }

  // User confirmation for a paused cleanup. `maxBytes` is the amount they saw;
  // if the library has since grown the overage, nothing is removed.
  cleanUpNow(maxBytes: number): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    return this.enqueue(maxBytes);
  }

  private enqueue(approvedBytes?: number): Promise<number> {
    const pending = (this.pending ?? Promise.resolve(0))
      .then(() => this.stopped ? 0 : this.runPass(approvedBytes))
      .catch(error => {
        console.warn("[storage] Cleanup paused", error);
        return 0;
      });
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; });
    return pending;
  }

  private async runPass(approvedBytes?: number): Promise<number> {
    const settings = getSettings().storage;
    const approved = approvedBytes !== undefined;
    const plan = planStorageCleanup(this.library.storageSnapshot(), settings, Date.now(), approved);
    const ids = approved && plan.status.reclaimBytes > approvedBytes ? [] : plan.ids;
    let deleted = 0;
    let busy = false;
    for (const id of ids) {
      const current = getSettings().storage;
      if (this.stopped || current.autoCleanup !== settings.autoCleanup || current.limitGb !== settings.limitGb
        || current.deleteEdited !== settings.deleteEdited) break;
      try {
        // The library re-plans before each unlink; a changed plan ends the pass.
        if (!await this.library.deleteForStorage(id, settings, Date.now(), approved)) break;
        deleted++;
      } catch {
        // Stop rather than substituting newer files for a busy candidate.
        busy = true;
        break;
      }
    }
    if (deleted > 0) this.emit("deleted", { count: deleted });
    const status = this.status();
    if (busy && status.reason === "cleaning") status.reason = "busy";
    this.emit("status", status);
    return deleted;
  }
}
