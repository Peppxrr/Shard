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
    settings = deepMerge(structuredClone(DEFAULT_SETTINGS), parsed);
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
  return { game: { ...s.game, gamesPath: s.game.gamesPath || gamesJsonPath() } };
}
export function coreStoragePayload(s: Settings) {
  return { storage: { limitGb: s.storage.limitGb, clipsDir: s.storage.clipsDir } };
}

// The game registry lives in games.json and is owned by the core (which
// migrates legacy v1 lists and writes v2). The app only guarantees the file
// exists so the core has a writable target.
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
  // v2 registry schema; built-in games ship inside the core, so an empty
  // registry is complete.
  await fs.writeFile(dest, JSON.stringify({ version: 2, user: [], discovered: [], ignoredExes: [] }), "utf8");
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
