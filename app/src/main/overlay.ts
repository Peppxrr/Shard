// overlay.ts — on-screen notification popup (Shard design).
//
// Frameless, transparent, always-on-top window pinned to the top-left of the
// primary display work area. Non-focusable and click-through, so it never
// steals focus from a game or blocks input. The window is measured from its
// rendered text before display, DPI-aware, and kept inside the work area.
//
// Supports: clip saved, recording started/stopped, capture switched.
import { BrowserWindow, screen } from "electron";
import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getSettings } from "./settings";

const MARGIN = 18;
const HOLD_MS = 2200;
const OUT_MS = 300;
const LIFE_MS = HOLD_MS + OUT_MS; // 2500 — destroy exactly when out ends, no ghost linger
const MAX_WIDTH = 560;
const HEIGHT = 78;
const PADDING_X = 20;

type OverlayKind = "clip" | "recording" | "capture";

export class SaveOverlay {
  private win: BrowserWindow | null = null;
  private timer: NodeJS.Timeout | null = null;

  show(label: string, kind: OverlayKind = "clip"): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const wa = screen.getPrimaryDisplay().workArea;
    // Start wide enough to measure natural content, then shrink to the exact
    // rendered overlay width before showing it.
    const initialW = Math.min(MAX_WIDTH, Math.max(1, wa.width - MARGIN * 2));
    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({
        x: wa.x + MARGIN,
        y: wa.y + MARGIN,
        width: initialW,
        height: HEIGHT,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        focusable: false,
        show: false,
        hasShadow: false,
        webPreferences: { contextIsolation: true, sandbox: false },
      });
      this.win.setAlwaysOnTop(true, "screen-saver");
      this.win.setIgnoreMouseEvents(true);
    } else {
      // Reuse window but reposition to stay inside workArea (multi-monitor safe)
      this.win.setBounds({ x: wa.x + MARGIN, y: wa.y + MARGIN, width: initialW, height: HEIGHT });
    }

    // Theme-aware overlay: pull current theme to tint accent/bg
    let themeId = "default";
    try { themeId = (getSettings() as any)?.appearance?.theme ?? "default"; } catch {}
    const url = "data:text/html;charset=utf-8," + encodeURIComponent(overlayHtml(kind, String(themeId))) + "#" + encodeURIComponent(label);
    void this.win.loadURL(url).then(async () => {
      const win = this.win;
      if (!win || win.isDestroyed()) return;
      const measured = await win.webContents.executeJavaScript(
        "Math.ceil(document.querySelector('.ov')?.getBoundingClientRect().width ?? document.body.scrollWidth)",
      );
      if (win !== this.win || win.isDestroyed()) return;
      const width = Math.min(initialW, Math.max(1, Number(measured) || initialW));
      win.setBounds({ x: wa.x + MARGIN, y: wa.y + MARGIN, width, height: HEIGHT });
      win.showInactive();
    }).catch(() => {});

    this.timer = setTimeout(() => this.destroy(), LIFE_MS);
  }

  // Convenience for specific events
  showRecording(active: boolean): void {
    this.show(active ? "Recording started" : "Recording stopped", "recording");
  }
  showCapture(name: string): void {
    this.show(`Switched capture to ${name}`, "capture");
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.hide(); } catch {}
      const w = this.win;
      this.win = null;
      // Destroy on next tick to avoid ghosting from lingering compositor frame
      setImmediate(() => { try { if (!w.isDestroyed()) w.destroy(); } catch {} });
      return;
    }
    this.win = null;
  }
}

function getThemePalette(themeId: string): { clip: string; capture: string; bg: string; border: string } {
  const id = String(themeId || "default").toLowerCase().replace(/[^a-z0-9-_]/g, "-") || "default";
  // Built-in accents
  const builtin: Record<string, { accent: string; bg: string; border: string }> = {
    default: { accent: "#6ea8ff", bg: "rgba(14, 19, 32, .96)", border: "rgba(110,168,255,.45)" },
    oled:    { accent: "#6ea8ff", bg: "rgba(10, 10, 12, .97)", border: "rgba(110,168,255,.40)" },
    midnight:{ accent: "#4f8cff", bg: "rgba(10, 16, 32, .96)", border: "rgba(79,140,255,.42)" },
    goob:    { accent: "#9b6bff", bg: "rgba(18, 16, 30, .96)", border: "rgba(155,107,255,.45)" },
  };
  if (builtin[id]) return { clip: builtin[id].accent, capture: builtin[id].accent, bg: builtin[id].bg, border: builtin[id].border };
  // Custom: try to read Themes/<id>/theme.css for --accent
  try {
    const p = path.join(app.getPath("userData"), "Themes", id, "theme.css");
    if (existsSync(p)) {
      const css = readFileSync(p, "utf8");
      const m = css.match(/--accent\s*:\s*([^;\n}]+)/);
      let accent = m?.[1]?.trim();
      if (accent) {
        // Normalize if it's a hex or rgb
        if (/^#[0-9a-fA-F]{3,8}$/.test(accent) || accent.startsWith("rgb") || accent.startsWith("hsl")) {
          // Derive bg/border with alpha
          // Simple: use accent for border with .45, bg as dark with accent tint
          return { clip: accent, capture: accent, bg: "rgba(18, 16, 30, .96)", border: accent + "73" };
        }
      }
      // Also check --accent-grad fallback? Extract first hex in grad
      const grad = css.match(/--accent-grad\s*:\s*linear-gradient[^;]*?(#[0-9a-fA-F]{6})/);
      if (grad?.[1]) return { clip: grad[1], capture: grad[1], bg: "rgba(18, 16, 30, .96)", border: grad[1] + "73" };
    }
  } catch {}
  return { clip: "#6ea8ff", capture: "#7c83ff", bg: "rgba(14, 19, 32, .96)", border: "rgba(110,168,255,.45)" };
}

function overlayHtml(kind: OverlayKind, themeId: string = "default"): string {
  const pal = getThemePalette(themeId);
  const theme: Record<OverlayKind, { accent: string; bg: string; border: string; icon: string }> = {
    clip: { accent: pal.clip, bg: pal.bg, border: pal.border, icon: "save" },
    recording: { accent: "#ff4d57", bg: "rgba(28, 14, 18, .96)", border: "rgba(255,77,87,.40)", icon: "disc" },
    capture: { accent: pal.capture, bg: pal.bg, border: pal.border, icon: "monitor" },
  };
  const t = theme[kind] ?? theme.clip;
  const iconSvg = (() => {
    switch (t.icon) {
      case "save":
        return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
      case "disc":
        return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>`;
      case "monitor":
        return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
      default:
        return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    }
  })();

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: transparent; overflow: hidden; border-radius: 14px; margin: 0; }
  html { background: transparent; }
  body { -webkit-app-region: no-drag; }
  .ov {
    display: inline-flex; align-items: center; gap: 14px;
    width: max-content; height: 100vh;
    overflow: hidden;
    contain: paint;
    isolation: isolate;
    min-height: ${HEIGHT}px; padding: 12px ${PADDING_X}px;
    background: ${t.bg};
    border: 1px solid ${t.border};
    border-left: 4px solid ${t.accent};
    border-radius: 14px;
    color: #eaf2ff; font: 600 15.5px/1.45 "Segoe UI", system-ui, sans-serif;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.035);
    transform: translateX(-110%);
    opacity: 0;
    will-change: transform, opacity;
    animation: ovIn .26s cubic-bezier(.2,.9,.25,1.15) forwards, ovOut ${OUT_MS}ms ease-in ${HOLD_MS}ms forwards;
    max-width: ${MAX_WIDTH}px;
    white-space: nowrap;
  }
  .ov .ic { width: 22px; height: 22px; flex: 0 0 auto; display: grid; place-items: center; color: ${t.accent}; filter: drop-shadow(0 0 6px ${t.accent}66); }
  .ov #t { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; letter-spacing: .01em; }
  @keyframes ovIn { to { transform: translateX(0); opacity: 1; } }
  @keyframes ovOut { to { transform: translateX(-110%); opacity: 0; box-shadow: none; } }
  @media (prefers-color-scheme: dark) { .ov { color: #eaf2ff; } }
</style></head><body>
  <div class="ov"><span class="ic">${iconSvg}</span><span id="t"></span></div>
  <script>document.getElementById("t").textContent = decodeURIComponent(location.hash.slice(1));</script>
</body></html>`;
}
