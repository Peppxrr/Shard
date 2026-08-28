// hotkeys.ts — non-exclusive low-level keyboard observer (Windows).
//
// Previous implementation used Electron's globalShortcut (RegisterHotKey) which is
// exclusive — if another app registers the same hotkey, registration fails with
// "already in use" and merely observing a key consumes it. The new architecture
// uses a low-level keyboard hook (WH_KEYBOARD_LL via uiohook-napi) that is
// non-exclusive: it observes keys without blocking them, so overlapping app
// shortcuts continue to work where technically possible. The hook is
// installed once, runs even when Shard is unfocused, only processes configured
// combinations, never logs or stores keys, and falls back to globalShortcut if
// the native hook cannot be loaded.
//
// Requirements preserved: unfocused hotkeys work, rebind UI (suspend/resume),
// settings persistence, Linux-ready (fallback).
import { globalShortcut, BrowserWindow } from "electron";
import type { CoreClient } from "./core-client";
import type { Settings } from "../shared/contracts";

// Try to load the non-exclusive observer. If it fails (no prebuild, permission),
// we fall back to the exclusive globalShortcut path so the app still functions.
let uIOhook: any = null;
let UiohookKey: any = null;
let hookAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("uiohook-napi") as { uIOhook: any; UiohookKey: any };
  uIOhook = mod.uIOhook;
  UiohookKey = mod.UiohookKey;
  hookAvailable = !!uIOhook;
} catch {
  hookAvailable = false;
}

export interface HotkeyStatus {
  id: string;
  accelerator: string;
  ok: boolean;
  error?: string;
}

export class HotkeyManager {
  private registered = new Map<string, string>(); // id -> accelerator (fallback path)
  private statuses = new Map<string, HotkeyStatus>();
  private current: Settings | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private suspended = false;
  private useHook = false;
  private hookStarted = false;
  private hookListenerAttached = false;

  constructor(private core: CoreClient, private onError?: (message: string) => void) {
    this.useHook = hookAvailable;
    if (this.useHook) {
      try {
        // Hook is non-exclusive; we start it once and observe without consuming keys.
        // We handle suspend by temporarily detaching the listener logic.
        this.ensureHook();
      } catch {
        this.useHook = false;
      }
    }
  }

  private ensureHook(): void {
    if (!this.useHook || this.hookStarted || !uIOhook) return;
    if (!this.hookListenerAttached) {
      uIOhook.on("keydown", (e: { keycode: number; altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }) => {
        if (this.suspended) return;
        if (!this.current) return;
        for (const h of this.current.hotkeys) {
          if (!h.accelerator) continue;
          const spec = this.parseAccelerator(h.accelerator);
          if (!spec) continue;
          if (spec.keycode !== e.keycode) continue;
          if (!!spec.ctrl !== !!e.ctrlKey) continue;
          if (!!spec.alt !== !!e.altKey) continue;
          if (!!spec.shift !== !!e.shiftKey) continue;
          if (!!spec.meta !== !!e.metaKey) continue;
          // Matched — trigger without consuming the key (observer only).
          this.trigger(h.id, h.action, h.durationSec);
          break; // one hotkey per keydown
        }
      });
      this.hookListenerAttached = true;
    }
    try {
      uIOhook.start();
      this.hookStarted = true;
    } catch (e) {
      // If hook fails to start (e.g., permission), fall back to globalShortcut.
      this.useHook = false;
      this.hookStarted = false;
    }
  }

  private parseAccelerator(acc: string): { keycode: number; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean } | null {
    if (!UiohookKey) return null;
    const parts = acc.split("+").map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    const keyPart = parts[parts.length - 1];
    let ctrl = false, alt = false, shift = false, meta = false;
    for (let i = 0; i < parts.length - 1; i++) {
      const m = parts[i].toLowerCase();
      if (m === "ctrl" || m === "control") ctrl = true;
      else if (m === "alt") alt = true;
      else if (m === "shift") shift = true;
      else if (m === "super" || m === "meta" || m === "cmd" || m === "command" || m === "win") meta = true;
    }
    // Map key name to UiohookKey value.
    const lookup = (name: string): number | undefined => {
      const n = name.toLowerCase();
      // F-keys
      if (/^f\d+$/.test(n)) {
        const k = n.toUpperCase();
        return UiohookKey[k as keyof typeof UiohookKey];
      }
      if (n === "space") return UiohookKey.Space;
      if (n === "enter" || n === "return") return UiohookKey.Enter;
      if (n === "escape" || n === "esc") return UiohookKey.Escape;
      if (n === "tab") return UiohookKey.Tab;
      if (n === "backspace") return UiohookKey.Backspace;
      if (n.length === 1) {
        const upper = name.toUpperCase();
        if (upper >= "A" && upper <= "Z") return UiohookKey[upper as keyof typeof UiohookKey];
        if (upper >= "0" && upper <= "9") return UiohookKey[upper as keyof typeof UiohookKey];
      }
      // Fallback: try direct lookup (e.g., "Delete", "Insert")
      const direct = UiohookKey[name] ?? UiohookKey[name.toUpperCase()] ?? UiohookKey[name.charAt(0).toUpperCase() + name.slice(1)];
      return direct;
    };
    const keycode = lookup(keyPart);
    if (keycode === undefined) return null;
    return { keycode, ctrl, alt, shift, meta };
  }

  // Periodic + focus-driven re-apply for fallback path. With the hook we don't
  // need re-apply, but we keep the timer so that fallback registrations self-heal.
  attachWindow(win: BrowserWindow): void {
    const reapply = () => { if (this.current) this.apply(this.current); };
    win.on("focus", reapply);
    win.on("show", reapply);
    if (!this.retryTimer) this.retryTimer = setInterval(reapply, 15000);
  }

  suspend(): void {
    this.suspended = true;
    if (this.useHook) {
      // Hook stays running but we stop processing matches (non-exclusive, so rebind input receives keys)
      return;
    }
    globalShortcut.unregisterAll();
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.useHook) {
      // Hook already running; no need to clear registered map
      if (this.current) this.apply(this.current);
      return;
    }
    this.registered.clear();
    if (this.current) this.apply(this.current);
  }

  apply(settings: Settings): HotkeyStatus[] {
    this.current = settings;
    if (this.suspended) return [...this.statuses.values()];

    if (this.useHook) {
      // Non-exclusive observer: always "ok" (no registration exclusivity), just validate parse.
      this.statuses.clear();
      for (const h of settings.hotkeys) {
        const spec = h.accelerator ? this.parseAccelerator(h.accelerator) : null;
        const ok = !!h.accelerator && !!spec;
        const error = ok ? undefined : h.accelerator ? "Unrecognized key (will be ignored)" : "No accelerator";
        // For empty accelerator, we still report ok false but don't error loudly
        this.statuses.set(h.id, { id: h.id, accelerator: h.accelerator, ok: ok || !h.accelerator, error: ok || !h.accelerator ? undefined : error });
      }
      return [...this.statuses.values()];
    }

    // Fallback: exclusive globalShortcut
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
      // A duration of 0 is the UI's "no value" state (the field resets to 0
      // when blurred empty) — fall back to the 60 s default instead of
      // asking the core to save the whole ring.
      const secs = durationSec && durationSec > 0 ? durationSec : 60;
      this.core.invoke("clip.save", { durationSec: secs }).catch((e) => {
        this.onError?.(`Save clip failed: ${(e as Error).message}`);
      });
    } else if (action === "toggle_record") {
      this.core.invoke("state.get").then((st) => {
        const recording = (st as { recording?: { active?: boolean } }).recording?.active;
        if (recording) this.core.invoke("recording.stop").catch((e) => this.onError?.(`Recording stop failed: ${(e as Error).message}`));
        else this.core.invoke("recording.start").catch((e) => this.onError?.(`Recording start failed: ${(e as Error).message}`));
      }).catch((e) => {
        this.onError?.(`Recording toggle failed: ${(e as Error).message}`);
      });
    }
  }

  dispose(): void {
    this.suspended = false;
    if (this.useHook && uIOhook && this.hookStarted) {
      try { uIOhook.stop(); } catch {}
      this.hookStarted = false;
    }
    globalShortcut.unregisterAll();
    this.registered.clear();
    this.statuses.clear();
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
