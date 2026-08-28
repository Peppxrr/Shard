// sound.ts — clip-saved sound with custom file and volume support.
//
// Uses the bundled "Clip Sound.wav" from app/src/renderer/assets as the default
// (21KB, 48kHz mono PCM). Users can pick any wav/mp3/ogg/flac/m4a via the Audio
// settings. Volume is 0..1. Playback is low-latency: tries renderer Audio first
// (via win.webContents.send), falls back to PowerShell SoundPlayer (fast) with
// MediaPlayer only when volume !=1. Fire-and-forget, never throws.
import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getSettings } from "./settings";

let pendingRendererWin: BrowserWindow | null = null;
export function setSoundWindow(win: BrowserWindow | null) { pendingRendererWin = win; }

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
