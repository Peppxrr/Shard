// storage.ts — watchdog: after every clip save/import/export and every 5 min,
// compare DB size against the limit; delete oldest unprotected clips until
// under 0.9 * limit (hysteresis). Locked files are skipped and retried next
// cycle. Exports never count toward the limit.
import { EventEmitter } from "node:events";
import type { Library } from "./library";
import { getSettings } from "./settings";

export class StorageWatchdog extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private checks = new Set<Promise<number>>();
  private locked = new Set<string>();

  constructor(private library: Library) {
    super();
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.check().catch(() => {}), 5 * 60 * 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.checks]);
  }

  // Returns the number of clips deleted.
  check(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    const check = this.runCheck();
    this.checks.add(check);
    void check.then(() => this.checks.delete(check), () => this.checks.delete(check));
    return check;
  }

  private async runCheck(): Promise<number> {
    this.locked.clear(); // retry everything locked last cycle
    const settings = getSettings().storage;
    const limitBytes = settings.limitGb * 1024 * 1024 * 1024;
    if (limitBytes <= 0) return 0;

    let used = this.library.autoDeleteBytes(settings.deleteEdited);
    let deleted = 0;
    const target = limitBytes * 0.9;

    while (!this.stopped && used > target) {
      const oldest = this.library.oldestUnprotected(settings.deleteEdited);
      if (!oldest) break;
      if (this.locked.has(oldest.path)) break; // tried this cycle, still locked

      try {
        await this.library.deleteForStorage(oldest.id);
        used = this.library.autoDeleteBytes(settings.deleteEdited);
        deleted++;
      } catch {
        // Locked (viewer/editor holds it): skip it this cycle, retry next.
        this.locked.add(oldest.path);
        break;
      }
    }
    if (deleted > 0) {
      this.emit("deleted", { count: deleted, limitGb: getSettings().storage.limitGb });
    }
    return deleted;
  }
}
