// settings.ts — settings.json in userData; defaults in code; schema in
// src/shared/contracts.ts. Settings UI writes here, then pushes the relevant
// slice to the core via config.set (no full-app restart needed).
import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "../shared/contracts";

let settings: Settings = structuredClone(DEFAULT_SETTINGS);
let settingsPath = "";

export function settingsFile(): string {
  return settingsPath;
}

export async function loadSettings(): Promise<Settings> {
  settingsPath = path.join(app.getPath("userData"), "settings.json");
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    settings = normalizeSettings(deepMerge(structuredClone(DEFAULT_SETTINGS), parsed));
  } catch {
    // First run or corrupt file: defaults.
  }
  return structuredClone(settings);
}

export function getSettings(): Settings {
  return structuredClone(settings);
}

export async function saveSettings(next: Settings): Promise<void> {
  settings = next;
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

// Core-facing slices (config.set payloads).
export function coreAudioPayload(s: Settings) {
  return { audio: { sources: s.audio.sources } };
}
export function coreCapturePayload(s: Settings) {
  return { capture: s.capture };
}
export function coreVideoPayload(s: Settings) {
  return { video: s.video };
}
export function coreReplayPayload(s: Settings) {
  return { replay: s.replay };
}
export function coreGamePayload(s: Settings) {
  return { game: { ...s.game, gamesPath: gamesJsonPath() } };
}
export function coreStoragePayload(s: Settings) {
  return { storage: { limitGb: s.storage.limitGb, clipsDir: s.storage.clipsDir } };
}

function normalizeSettings(next: Settings): Settings {
  // Migrate clipSound volume/path if missing
  if (typeof (next.app as unknown as Record<string, unknown>).clipSoundVolume !== "number" || !Number.isFinite((next.app as unknown as Record<string, unknown>).clipSoundVolume as number)) (next.app as unknown as Record<string, unknown>).clipSoundVolume = 0.8;
  else (next.app as unknown as Record<string, unknown>).clipSoundVolume = Math.min(1, Math.max(0, Number((next.app as unknown as Record<string, unknown>).clipSoundVolume)));
  if (typeof (next.app as unknown as Record<string, unknown>).clipSoundPath !== "string") (next.app as unknown as Record<string, unknown>).clipSoundPath = "";
  else (next.app as unknown as Record<string, unknown>).clipSoundPath = String((next.app as unknown as Record<string, unknown>).clipSoundPath).slice(0, 1024);
  // Migrate appearance.theme if missing
  if (!(next as unknown as Record<string, unknown>).appearance || typeof ((next as unknown as Record<string, unknown>).appearance as Record<string, unknown>).theme !== "string") {
    (next as unknown as Record<string, unknown>).appearance = { theme: "default" };
  } else {
    ((next as unknown as Record<string, unknown>).appearance as Record<string, unknown>).theme = String(((next as unknown as Record<string, unknown>).appearance as Record<string, unknown>).theme).trim().toLowerCase().replace(/[^a-z0-9-_]/g,"-") || "default";
  }
  // Backwards compat: hardwareAcceleration defaults to true when missing (older installs)
  if (typeof (next.app as unknown as Record<string, unknown>).hardwareAcceleration !== "boolean") (next.app as unknown as Record<string, unknown>).hardwareAcceleration = true;
  if ((next.export.resolution as string) === "auto") next.export.resolution = "source";
  delete (next.game as unknown as Record<string, unknown>).gamesPath;
  delete (next.game as unknown as Record<string, unknown>).launchers;
  delete (next.export as unknown as Record<string, unknown>).audioBitrateKbps;
  next.hotkeys = next.hotkeys.map((hotkey) => {
    if (hotkey.action !== "save_clip" || hotkey.durationUnit) return hotkey;
    const duration = hotkey.durationSec ?? 60;
    return { ...hotkey, durationUnit: duration >= 60 && duration % 60 === 0 ? "min" : "sec" };
  });
  return next;
}

// The game registry lives in games.json and is owned by the core. The app only
// guarantees that the current schema exists at the path passed on the core's
// initial command line.
export function gamesJsonPath(): string {
  return path.join(app.getPath("userData"), "games.json");
}

export async function seedGamesJson(): Promise<void> {
  const dest = gamesJsonPath();
  try {
    await fs.access(dest);
    return;
  } catch {
    /* not present yet */
  }
  // v9 persists only explicit user mappings, ignored executables, and
  // processes that passed the current structural classifier.
  await fs.writeFile(dest, JSON.stringify({ version: 9, user: [], discovered: [], ignoredExes: [] }), "utf8");
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined) continue;
    const baseV = (base as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && baseV && typeof baseV === "object" && !Array.isArray(baseV)) {
      out[k] = deepMerge(baseV as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
