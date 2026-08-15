// hotkeys.ts — globalShortcut registration per settings entry.
//
// Windows notes: RegisterHotKey-based shortcuts are system-wide, but
// registration can transiently fail (key held by a dying process, system
// sleep/lock, hidden window quirks). We re-apply on a timer and whenever the
// window regains focus/show, so keys recover without an app restart.
import { globalShortcut, BrowserWindow } from "electron";
import type { CoreClient } from "./core-client";
import type { Settings } from "../shared/contracts";

export interface HotkeyStatus {
  id: string;
  accelerator: string;
  ok: boolean;
  error?: string;
}

export class HotkeyManager {
  private registered = new Map<string, string>(); // id -> accelerator
  private statuses = new Map<string, HotkeyStatus>();
  private current: Settings | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private core: CoreClient) {}

  // Periodic + focus-driven re-apply. apply() skips unchanged, healthy
  // registrations, so this only retries failed/missing ones.
  attachWindow(win: BrowserWindow): void {
    const reapply = () => { if (this.current) this.apply(this.current); };
    win.on("focus", reapply);
    win.on("show", reapply);
    if (!this.retryTimer) this.retryTimer = setInterval(reapply, 15000);
  }

  apply(settings: Settings): HotkeyStatus[] {
    this.current = settings;
    // Unregister everything that changed or disappeared.
    const next = new Set(settings.hotkeys.map((h) => h.id));
    for (const [id, acc] of this.registered) {
      if (!next.has(id)) {
        globalShortcut.unregister(acc);
        this.registered.delete(id);
        this.statuses.delete(id);
      }
    }

    for (const h of settings.hotkeys) {
      const prev = this.registered.get(h.id);
      if (prev === h.accelerator && this.statuses.get(h.id)?.ok) continue;
      if (prev && prev !== h.accelerator) globalShortcut.unregister(prev);

      let ok = false;
      let error: string | undefined;
      try {
        ok = globalShortcut.register(h.accelerator, () => this.trigger(h.id, h.action, h.durationSec));
        if (!ok) error = "Registration failed (key in use by another app?)";
      } catch (e) {
        error = (e as Error).message;
      }
      this.registered.set(h.id, h.accelerator);
      this.statuses.set(h.id, { id: h.id, accelerator: h.accelerator, ok, error });
    }
    return [...this.statuses.values()];
  }

  status(id: string): HotkeyStatus | undefined {
    return this.statuses.get(id);
  }

  private trigger(id: string, action: string, durationSec?: number): void {
    if (action === "save_clip") {
      this.core.invoke("clip.save", { durationSec: durationSec ?? 60 }).catch(() => {});
    } else if (action === "toggle_record") {
      this.core.invoke("state.get").then((st) => {
        const recording = (st as { recording?: { active?: boolean } }).recording?.active;
        if (recording) this.core.invoke("recording.stop").catch(() => {});
        else this.core.invoke("recording.start").catch(() => {});
      }).catch(() => {});
    }
  }

  dispose(): void {
    globalShortcut.unregisterAll();
    this.registered.clear();
    this.statuses.clear();
  }
}
