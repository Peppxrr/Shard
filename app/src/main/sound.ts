// sound.ts — clip-saved sound with custom file and volume support.
//
// Uses the bundled "Clip Sound.wav" from app/src/renderer/assets as the default
// (21KB, 48kHz mono PCM). Users can pick any wav/mp3/ogg/flac/m4a via the Audio
// settings. Volume is 0..1. Playback is low-latency: tries renderer Audio first
// (via win.webContents.send), falls back to PowerShell SoundPlayer (fast) with
// MediaPlayer only when volume !=1. Fire-and-forget, never throws.
import { app, BrowserWindow } from "electron";
import { spawn } from "./bundled-processes";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getSettings } from "./settings";

let pendingRendererWin: BrowserWindow | null = null;
export function setSoundWindow(win: BrowserWindow | null) { pendingRendererWin = win; }

// While the main window is unloaded (closed to tray), a hidden page with no
// preload plays clip sounds: low latency on every platform, without the main
// renderer's memory. The sound bytes are sent only when the file changes.
let soundHost: BrowserWindow | null = null;
let soundHostReady: Promise<void> | null = null;
let soundHostKey = "";

export function prepareSoundHost(): void {
  if (soundHost && !soundHost.isDestroyed()) return;
  const host = new BrowserWindow({
    show: false, width: 1, height: 1, frame: false, skipTaskbar: true, focusable: false,
    title: "Shard sound",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, autoplayPolicy: "no-user-gesture-required", backgroundThrottling: false },
  });
  soundHost = host;
  soundHostKey = "";
  host.on("closed", () => {
    if (soundHost !== host) return;
    soundHost = null;
    soundHostReady = null;
  });
  soundHostReady = host.loadURL("data:text/html;charset=utf-8,<!doctype html><title>Shard sound</title>").catch(() => {});
}

export function closeSoundHost(): void {
  const host = soundHost;
  soundHost = null;
  soundHostReady = null;
  soundHostKey = "";
  if (host && !host.isDestroyed()) host.destroy();
}

const SOUND_MIME: Record<string, string> = {
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg",
  ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac", ".webm": "audio/webm",
};

async function playInSoundHost(file: string, volume: number): Promise<boolean> {
  prepareSoundHost();
  const host = soundHost;
  if (!host) return false;
  await soundHostReady;
  if (host.isDestroyed()) return false;
  const stat = await fs.stat(file);
  const key = `${file}|${stat.size}|${stat.mtimeMs}`;
  let source = "";
  if (key !== soundHostKey) {
    const mime = SOUND_MIME[path.extname(file).toLowerCase()] ?? "audio/wav";
    source = `data:${mime};base64,${(await fs.readFile(file)).toString("base64")}`;
  }
  if (host.isDestroyed()) return false;
  const played = await host.webContents.executeJavaScript(`(() => {
    const source = ${JSON.stringify(source)};
    if (source) window.clipSound = new Audio(source);
    const audio = window.clipSound;
    if (!audio) return false;
    audio.pause(); audio.currentTime = 0; audio.volume = ${JSON.stringify(volume)};
    return audio.play().then(() => true, () => false);
  })()`, true) as boolean;
  if (played) soundHostKey = key;
  return played;
}

export function playClipSound(): void {
  const s = getSettings().app as unknown as { clipSound: boolean; clipSoundVolume: number; clipSoundPath: string };
  if (!s.clipSound) return;
  const vol = typeof s.clipSoundVolume === "number" ? Math.min(1, Math.max(0, s.clipSoundVolume)) : 0.8;
  const custom = typeof s.clipSoundPath === "string" ? s.clipSoundPath.trim() : "";
  void playSoundFile(custom || "", vol);
}

export async function previewClipSound(customPath: string, volume: number): Promise<void> {
  const vol = Math.min(1, Math.max(0, Number(volume) || 0.8));
  const p = String(customPath || "").trim();
  await playSoundFile(p, vol);
}

export async function getDefaultSoundPath(): Promise<string> {
  const p = await resolveDefaultWav();
  return p ?? "";
}

async function playSoundFile(customPath: string, volume: number): Promise<void> {
  const wav = await resolveSoundPath(customPath);
  if (!wav || !existsSync(wav)) return;
  const vol = Math.min(1, Math.max(0, volume));

  // Try renderer first for low latency (Audio element, supports volume, no powershell spawn)
  if (pendingRendererWin && !pendingRendererWin.isDestroyed()) {
    try {
      pendingRendererWin.webContents.send("play-clip-sound", { path: wav, volume: vol });
      // Also attempt main fallback after 100ms if renderer fails? No, just rely on renderer.
      // For safety, also do a fast main fallback if renderer is not visible? But renderer can play even when hidden.
      return;
    } catch {}
  }

  // Main window unloaded: the hidden sound page plays it.
  try {
    if (await playInSoundHost(wav, vol)) return;
  } catch {}
  if (process.platform !== "win32") return;

  // Fallback: fast powershell SoundPlayer (low latency). Use MediaPlayer only if volume !=1
  const psCmd = volume >= 0.99 && volume <= 1.01 ? buildFastSoundPlayerCommand(wav) : buildMediaPlayerCommand(wav, vol);
  // Fire-and-forget, do not await — powershell spawn is ~300ms but we don't block
  try {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCmd], {
      windowsHide: true,
      stdio: "ignore",
    });
    ps.on("error", () => {});
    // Don't wait for exit; let it run. Detach after 3s if still alive (should have finished)
    setTimeout(() => { try { ps.kill(); } catch {} }, 3000);
  } catch {}
}

function buildFastSoundPlayerCommand(wavPath: string): string {
  const esc = wavPath.replace(/'/g, "''");
  // Fast path: SoundPlayer.Play() is async and returns immediately, low latency (~200ms vs 500ms for MediaPlayer)
  return `try { (New-Object Media.SoundPlayer '${esc}').Play(); Start-Sleep -Milliseconds 800; } catch {}`.trim();
}

function buildMediaPlayerCommand(wavPath: string, volume: number): string {
  const esc = wavPath.replace(/'/g, "''");
  const v = volume.toFixed(3);
  // MediaPlayer supports volume but needs presentationCore (slower, ~400ms). Use only when needed.
  return `
Add-Type -AssemblyName presentationCore -ErrorAction SilentlyContinue;
try {
  \$p = New-Object System.Windows.Media.MediaPlayer; \$p.Volume = ${v}; \$p.Open([Uri]::new('${esc}')); \$p.Play(); Start-Sleep -Milliseconds 900;
} catch { try { (New-Object Media.SoundPlayer '${esc}').Play(); Start-Sleep -Milliseconds 800; } catch {} }
`.trim();
}

async function resolveSoundPath(customPath: string): Promise<string | null> {
  if (customPath) {
    const p = customPath.trim();
    if (p && existsSync(p)) return p;
  }
  return resolveDefaultWav();
}

async function resolveDefaultWav(): Promise<string | null> {
  const candidates: string[] = [];
  try { candidates.push(path.join(process.resourcesPath, "clip-sound.wav")); } catch {}
  try { candidates.push(path.join(process.resourcesPath, "Clip Sound.wav")); } catch {}
  try { candidates.push(path.join(app.getAppPath(), "src", "renderer", "assets", "Clip Sound.wav")); } catch {}
  try { candidates.push(path.join(app.getAppPath(), "dist", "renderer", "assets", "Clip Sound.wav")); } catch {}
  try { candidates.push(path.join(app.getAppPath(), "resources", "clip-sound.wav")); } catch {}
  try { candidates.push(path.join(app.getAppPath(), "resources", "Clip Sound.wav")); } catch {}
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  try {
    const src = path.join(app.getAppPath(), "src", "renderer", "assets", "Clip Sound.wav");
    if (existsSync(src)) {
      const dst = path.join(app.getPath("userData"), "clip-sound-default.wav");
      if (!existsSync(dst)) {
        const buf = await fs.readFile(src);
        await fs.writeFile(dst, buf);
      }
      if (existsSync(dst)) return dst;
      return src;
    }
  } catch {}
  return null;
}
