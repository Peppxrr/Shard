// hotkeys.ts — non-exclusive low-level keyboard observer (Windows); on Linux
// (Wayland) the core's desktop shortcut binding, else Electron's portal path.
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
// Wayland gives no client global keyboard input, so uiohook would load but see
// nothing. On Linux the core registers the hotkeys with the desktop's shortcut
// service (KDE kglobalaccel: `hotkeys.bind`, `hotkey.pressed` events). Where the
// core reports no support, Electron's globalShortcut goes through the XDG
// GlobalShortcuts portal, with the collision rules below.
//
// Requirements preserved: unfocused hotkeys work, rebind UI (suspend/resume),
// settings persistence.
import { app, globalShortcut, BrowserWindow } from "electron";
import type { CoreClient } from "./core-client";
import type { HotkeyBindResult, HotkeyStatus, Settings } from "../shared/contracts";

// Try to load the non-exclusive observer. If it fails (no prebuild, permission),
// we fall back to the exclusive globalShortcut path so the app still functions.
let uIOhook: any = null;
let UiohookKey: any = null;
let hookAvailable = false;
if (process.platform !== "linux") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("uiohook-napi") as { uIOhook: any; UiohookKey: any };
    uIOhook = mod.uIOhook;
    UiohookKey = mod.UiohookKey;
    hookAvailable = !!uIOhook;
  } catch {
    hookAvailable = false;
  }
}

// Must run before app readiness: Chromium reads enable-features at startup.
// Merged with any features already requested on the command line.
export function enableGlobalShortcutsPortal(): void {
  if (process.platform !== "linux") return;
  const features = app.commandLine.getSwitchValue("enable-features");
  app.commandLine.appendSwitch("enable-features", features ? `${features},GlobalShortcutsPortal` : "GlobalShortcutsPortal");
}

// electron/electron#52223: on the Wayland portal path Electron names each
// portal shortcut after Chromium's extension-command string for the
// accelerator. That string is empty for keys outside the extension grammar
// (F-keys, Escape, most punctuation, numpad) and for accelerators without
// Ctrl or Alt, so all such hotkeys would share one portal shortcut: only the
// last would bind, running the last callback. They are reported instead.
const PORTAL_KEYS = /^([A-Z0-9,.]|Comma|Period|Up|Down|Left|Right|Home|End|PageUp|PageDown|Space|Tab|Insert|Delete)$/i;
const PORTAL_MEDIA_KEYS = /^(MediaNextTrack|MediaPreviousTrack|MediaPlayPause|MediaStop)$/i;
const PORTAL_COLLAPSE_ERROR = "On Wayland, global hotkeys need Ctrl or Alt with a letter, number or arrow key (F-keys are not supported)";

function portalCollapses(accelerator: string): boolean {
  const parts = accelerator.split("+");
  const key = parts.pop() ?? "";
  if (PORTAL_MEDIA_KEYS.test(key)) return false;
  const ctrlOrAlt = parts.some(part => /^(ctrl|control|alt|commandorcontrol|cmdorctrl)$/i.test(part));
  return !ctrlOrAlt || !PORTAL_KEYS.test(key);
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
  // Linux: the core binds through the desktop's shortcut service (KDE
  // kglobalaccel) when it reports support; otherwise Electron's portal path.
  // Decided again after every core (re)connect.
  private linuxBackend: "unknown" | "core" | "portal" = "unknown";
  private boundKey: string | null = null; // last binding set sent to the core
  private reportedKey = "";

  constructor(private core: CoreClient, private onError?: (message: string) => void,
    private onLinuxStatus?: (statuses: HotkeyStatus[]) => void) {
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
    if (process.platform === "linux") {
      core.on("ready", () => {
        this.linuxBackend = "unknown";
        this.boundKey = null;
        this.syncLinux();
      });
      core.on("event", (type: string, params: Record<string, unknown>) => {
        if (type !== "hotkey.pressed" || this.linuxBackend !== "core") return;
        const hotkey = this.current?.hotkeys.find(h => h.id === params.id);
        if (hotkey) this.trigger(hotkey.id, hotkey.action, hotkey.durationSec);
      });
    }
  }

  // For diagnostics: which mechanism observes the configured hotkeys.
  get backend(): string {
    if (this.useHook) return "keyboard hook";
    if (process.platform !== "linux") return "globalShortcut";
    return this.linuxBackend === "core" ? "desktop global shortcuts via the core"
      : this.linuxBackend === "portal" ? "globalShortcut via GlobalShortcuts portal" : "pending";
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

  suspend(): Promise<void> | void {
    this.suspended = true;
    if (this.useHook) {
      // Hook stays running but we stop processing matches (non-exclusive, so rebind input receives keys)
      return;
    }
    globalShortcut.unregisterAll();
    // Desktop shortcuts would swallow the keys the editor is listening for.
    if (process.platform === "linux" && this.linuxBackend !== "portal" && this.core.ready) {
      this.boundKey = "[]";
      return this.core.invoke("hotkeys.bind", { bindings: [] }).then(() => {}, () => {});
    }
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (!this.retryTimer && this.current)
      this.retryTimer = setInterval(() => { if (this.current) this.apply(this.current); }, 15000);
    if (this.useHook) {
      // Hook already running; no need to clear registered map
      if (this.current) this.apply(this.current);
      return;
    }
    this.registered.clear();
    if (this.current) this.apply(this.current);
  }

  // Linux results arrive asynchronously through onLinuxStatus; the returned
  // list is the current state.
  apply(settings: Settings): HotkeyStatus[] {
    this.current = settings;
    if (this.suspended) return [...this.statuses.values()];
    if (process.platform === "linux") {
      this.syncLinux();
      return [...this.statuses.values()];
    }
    this.ensureHook();

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

    this.registerShortcuts(settings);
    return [...this.statuses.values()];
  }

  private syncLinux(): void {
    const settings = this.current;
    if (!settings || this.suspended) return;
    if (this.linuxBackend === "portal") {
      this.registerShortcuts(settings);
      this.reportLinux();
      return;
    }
    if (!this.core.ready) return; // the core's "ready" syncs again
    const bindings = settings.hotkeys.filter(h => h.accelerator).map(h => ({
      id: h.id, accelerator: h.accelerator,
      description: h.label.trim() || (h.action === "save_clip" ? "Save clip" : "Toggle recording"),
    }));
    const key = JSON.stringify(bindings);
    if (key === this.boundKey) return;
    this.boundKey = key;
    this.core.invoke("hotkeys.bind", { bindings }).then(raw => {
      if (this.boundKey !== key) return; // superseded (suspend or another binding set)
      const result = raw as HotkeyBindResult;
      if (!result.supported) return this.usePortal();
      this.linuxBackend = "core";
      for (const accelerator of this.registered.values()) globalShortcut.unregister(accelerator);
      this.registered.clear();
      this.statuses.clear();
      for (const h of settings.hotkeys) {
        const entry = result.results.find(r => r.id === h.id);
        const ok = !h.accelerator || entry?.ok === true;
        this.statuses.set(h.id, { id: h.id, accelerator: h.accelerator, ok, error: ok ? undefined : entry?.error ?? "Not registered" });
      }
      this.reportLinux();
    }, (error: Error) => {
      if (this.boundKey !== key) return;
      this.boundKey = null; // retried on the next apply or reconnect
      // Cores without hotkeys.bind keep Electron's portal path.
      if (error.message.startsWith("Method not found")) this.usePortal();
    });
  }

  private usePortal(): void {
    this.linuxBackend = "portal";
    this.boundKey = null;
    this.syncLinux();
  }

  private reportLinux(): void {
    const statuses = [...this.statuses.values()];
    const key = JSON.stringify(statuses);
    if (key === this.reportedKey) return;
    this.reportedKey = key;
    this.onLinuxStatus?.(statuses);
  }

  // Exclusive Electron globalShortcut registrations (Windows fallback, Linux portal path).
  private registerShortcuts(settings: Settings): void {
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
      if (process.platform === "linux" && h.accelerator && portalCollapses(h.accelerator)) {
        // Never bind it: it would replace another hotkey's portal shortcut.
        if (prev) globalShortcut.unregister(prev);
        this.registered.delete(h.id);
        this.statuses.set(h.id, { id: h.id, accelerator: h.accelerator, ok: false, error: PORTAL_COLLAPSE_ERROR });
        continue;
      }
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
  }

  statusList(): HotkeyStatus[] {
    return [...this.statuses.values()];
  }

  private trigger(id: string, action: string, durationSec?: number): void {
    if (this.suspended) return;
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
        if (this.suspended) return;
        const recording = (st as { recording?: { active?: boolean } }).recording?.active;
        if (recording) this.core.invoke("recording.stop").catch((e) => this.onError?.(`Recording stop failed: ${(e as Error).message}`));
        else this.core.invoke("recording.start").catch((e) => this.onError?.(`Recording start failed: ${(e as Error).message}`));
      }).catch((e) => {
        this.onError?.(`Recording toggle failed: ${(e as Error).message}`);
      });
    }
  }

  dispose(): void {
    this.suspended = true;
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
