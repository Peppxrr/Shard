// storage.ts — watchdog: after every clip save/import/export and every 5 min,
// compare DB size against the limit; delete oldest unprotected clips until
// under 0.9 * limit (hysteresis). Locked files are skipped and retried next
// cycle. Exports never count toward the limit.
import { promises as fs } from "node:fs";
import { EventEmitter } from "node:events";
import type { Library } from "./library";
import { getSettings } from "./settings";

export class StorageWatchdog extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private locked = new Set<string>();

  constructor(private library: Library) {
    super();
  }

  start(): void {
    this.timer = setInterval(() => this.check().catch(() => {}), 5 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Returns the number of clips deleted.
  async check(): Promise<number> {
    this.locked.clear(); // retry everything locked last cycle
    const limitBytes = getSettings().storage.limitGb * 1024 * 1024 * 1024;
    if (limitBytes <= 0) return 0;

    let used = this.library.totalBytes();
    let deleted = 0;
    const target = limitBytes * 0.9;

    while (used > target) {
      const oldest = this.library.oldestUnprotected();
      if (!oldest) break;
      if (this.locked.has(oldest.path)) break; // tried this cycle, still locked

      try {
        await fs.unlink(oldest.path);
        if (oldest.thumb) await fs.unlink(oldest.thumb).catch(() => {});
        this.library.delete(oldest.id);
        used = this.library.totalBytes();
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
