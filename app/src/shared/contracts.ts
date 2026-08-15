// ClipForge cross-language contract: the single definition of settings JSON,
// RPC methods/events, and the hotkey schema. Mirrors core/src/config.h and the
// core's JSON-RPC handlers exactly. Keep both in sync.

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type CaptureMode = "auto" | "screen" | "game";
export type AudioSourceKind = "input" | "output" | "process";
export type EncoderChoice = "auto" | "obs_x264" | "obs_nvenc_h264_tex" | "obs_nvenc_av1_tex";
export type VideoPreset = "low" | "medium" | "high" | "custom";
export type NotificationStyle = "overlay" | "windows" | "off";

export interface AudioSourceConfig {
  id: string; // WASAPI device id, or "default"; ignored for "process"
  name: string;
  kind: AudioSourceKind;
  window?: string; // "::<exe>" descriptor for kind === "process"
  gain: number; // 0..1
  enabled: boolean;
}

export interface CaptureSettings {
  mode: CaptureMode;
  monitor: number;
}

export interface VideoSettings {
  encoder: EncoderChoice;
  preset: VideoPreset;
  custom: boolean;
  bitrateKbps: number; // custom / explicit override (0 = preset-derived)
  fps: number;
  width: number;
  height: number;
  x264Preset: string;
}

export interface ReplaySettings {
  maxSeconds: number; // time cap of the RAM ring (600)
  maxMb: number; // byte cap of the RAM ring (2048)
}

export interface GameSettings {
  autoRecord: boolean;
  gamesPath: string;
  graceSeconds: number;
}

export interface HotkeyEntry {
  id: string;
  label: string;
  accelerator: string; // Electron accelerator, e.g. "F8"
  action: "save_clip" | "toggle_record";
  durationSec?: number; // for save_clip
}

export interface ExportSettings {
  targetMb: number; // default 10 (Discord free cap)
  codec: "h264" | "h265";
  resolution: "auto" | "source" | "1080p" | "720p" | "480p" | "360p";
  audioBitrateKbps: number;
}

export interface StorageSettings {
  limitGb: number;
  // Base directory for clip storage. The app creates `clips/` and `editor/`
  // inside it; empty = default (userData).
  clipsDir: string;
}

export interface AppSettings {
  // How clip-saved feedback is delivered.
  //   overlay  -> in-app toast (always visible when the window is)
  //   windows  -> Windows notification when the window is hidden/unfocused
  //   off      -> no notification
  notificationStyle: NotificationStyle;
  startWithWindows: boolean;
}

export interface Settings {
  capture: CaptureSettings;
  video: VideoSettings;
  replay: ReplaySettings;
  game: GameSettings;
  audio: { sources: AudioSourceConfig[] };
  storage: StorageSettings;
  app: AppSettings;
  hotkeys: HotkeyEntry[];
  export: ExportSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  capture: { mode: "auto", monitor: 0 },
  video: { encoder: "auto", preset: "medium", custom: false, bitrateKbps: 0, fps: 60, width: 1920, height: 1080, x264Preset: "veryfast" },
  replay: { maxSeconds: 600, maxMb: 2048 },
  game: { autoRecord: false, gamesPath: "", graceSeconds: 30 },
  audio: { sources: [] },
  storage: { limitGb: 20, clipsDir: "" },
  app: { notificationStyle: "overlay", startWithWindows: false },
  hotkeys: [
    { id: "save_60", label: "Save last minute", accelerator: "F8", action: "save_clip", durationSec: 60 },
    { id: "save_300", label: "Save last 5 minutes", accelerator: "F9", action: "save_clip", durationSec: 300 },
    { id: "record", label: "Toggle recording", accelerator: "F10", action: "toggle_record" },
  ],
  export: { targetMb: 10, codec: "h264", resolution: "auto", audioBitrateKbps: 128 },
};

// ---------------------------------------------------------------------------
// Core RPC (mirrors core/src/rpc.cpp dispatch)
// ---------------------------------------------------------------------------

export type RpcMethod =
  | "config.set"
  | "state.get"
  | "recording.start"
  | "recording.stop"
  | "clip.save"
  | "audio.listDevices"
  | "game.listKnown"
  | "game.addKnown"
  | "game.removeKnown"
  | "shutdown";

export interface CoreState {
  capture: CaptureSettings & {
    // What is currently being captured ("monitor" = desktop, "game" = a
    // game window, "none" = nothing).
    subject: { kind: "monitor" | "game" | "none"; name: string | null };
  };
  video: VideoSettings;
  replay: ReplaySettings;
  game: GameSettings;
  audio: { sources: AudioSourceConfig[] };
  ring: { active: boolean; secondsBuffered: number; mbUsed: number };
  recording: { active: boolean; path: string };
  foreground: { exe: string; name: string | null; known: boolean };
  storage: { limitGb: number; clipsDir: string };
  dirs: { clips: string; recordings: string };
  version: string;
}

export interface CoreEvent {
  type: "ready" | "game.changed" | "clip.saved" | "recording.state" | "ring.stats" | "error" | "capture.subject";
  params: Record<string, unknown>;
}

export interface AudioDeviceInfo {
  id: string;
  name: string;
  isInput: boolean;
  isVoicemeeter: boolean;
}

// ---------------------------------------------------------------------------
// Library (renderer <-> main IPC)
// ---------------------------------------------------------------------------

export interface ClipRecord {
  id: string;
  path: string;
  thumb: string;
  game: string | null;
  createdAt: number;
  durationMs: number;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  protected: number;
  source: "clip" | "recording" | "edited";
}

// One audio stream inside a clip/recording (multi-track recordings expose one
// entry per source track).
export interface AudioTrackInfo {
  index: number;
  codec: string;
}

export interface ExportResult {
  path: string;
  sizeMb: number;
  overTarget: boolean;
}

export interface ExportProgress {
  clipId: string;
  phase: string;
  percent: number;
  done?: boolean;
  error?: string;
  result?: ExportResult;
}

// ---------------------------------------------------------------------------
// Renderer bridge surface (window.clipforge, provided by preload.ts)
// ---------------------------------------------------------------------------

export interface ClipforgeApi {
  // core RPC passthrough
  invoke(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onCoreEvent(cb: (type: string, params: Record<string, unknown>) => void): () => void;
  // settings
  getSettings(): Promise<Settings>;
  setSettings(s: Settings): Promise<void>;
  // library
  listClips(): Promise<ClipRecord[]>;
  deleteClip(id: string): Promise<void>;
  setProtected(id: string, prot: boolean): Promise<void>;
  probeTracks(path: string): Promise<AudioTrackInfo[]>;
  onLibraryChanged(cb: () => void): () => void;
  revealInExplorer(path: string): void;
  openClip(path: string): void;
  // drag & drop (Windows: drag a clip file out of the window, e.g. into Discord)
  startDrag(path: string, iconPath?: string): void;
  // export
  startExport(clipId: string, segments?: { start: number; end: number }[], audioTracks?: number[]): Promise<void>;
  cancelExport(): Promise<void>;
  onExport(cb: (p: ExportProgress) => void): () => void;
  // misc
  version(): Promise<string>;
  onToast(cb: (message: string) => void): () => void;
}
