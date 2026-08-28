// Shard cross-language contract: the single definition of settings JSON,
// RPC methods/events, and the hotkey schema. Mirrors core/src/config.h and the
// core's JSON-RPC handlers exactly. Keep both in sync.

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type CaptureMode = "auto" | "screen" | "game";
export type AudioSourceKind = "input" | "output" | "process";
export type EncoderChoice =
  | "auto"
  | "obs_x264"
  | "obs_x265"
  | "obs_nvenc_h264_tex"
  | "obs_nvenc_hevc_tex"
  | "obs_nvenc_av1_tex";
export type VideoPreset = "low" | "medium" | "high" | "custom";
export type NotificationStyle = "overlay" | "windows" | "off";

export interface AudioSourceConfig {
  id: string; // WASAPI device id, or "default"; ignored for "process"
  name: string;
  kind: AudioSourceKind;
  window?: string; // "::<exe>" descriptor for kind === "process"
  gain: number; // 0..2
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
  graceSeconds: number; // auto-record grace after the last game session ends
  verboseDetection: boolean; // structured [GameDetection] logs on core stderr
}

export interface HotkeyEntry {
  id: string;
  label: string;
  accelerator: string; // Electron accelerator, e.g. "F8"
  action: "save_clip" | "toggle_record";
  durationSec?: number; // for save_clip
  durationUnit?: "sec" | "min"; // persisted display unit for save_clip
}

export interface ExportSettings {
  targetMb: number; // default 10 (Discord free cap)
  codec: "h264" | "h265";
  resolution: "source" | "1080p" | "720p" | "480p" | "360p";
}

export interface StorageSettings {
  limitGb: number;
  // Base directory for clip storage. The app creates `clips/` and `editor/`
  // inside it; empty = default (userData).
  clipsDir: string;
  deleteEdited: boolean;
}

export interface AppSettings {
  // How clip-saved feedback is delivered.
  //   overlay  -> on-screen popup (always visible, top-left)
  //   windows  -> Windows notification when the window is hidden/unfocused
  //   off      -> no notification
  notificationStyle: NotificationStyle;
  startWithWindows: boolean;
  // Hide to tray on window close instead of quitting (tray Quit always exits).
  minimizeToTray: boolean;
  // Short, unobtrusive sound when a clip finishes saving.
  clipSound: boolean;
  // Volume for clip sound 0..1 (default 0.8). Added to allow per-user loudness control.
  clipSoundVolume: number;
  // Absolute path to custom clip sound (wav/mp3/ogg/flac/m4a). "" = bundled default (Clip Sound.wav).
  clipSoundPath: string;
  // Developer console: bottom-right indicator + separate streaming log window.
  developerConsole: boolean;
  // Hardware acceleration: when disabled, Electron/Chromium runs without GPU
  // compositing (app.disableHardwareAcceleration). Requires restart.
  // Defaults true for performance; some hybrid-GPU / driver bug systems need
  // it off to make WGC/game-capture reliable (Terraria etc).
  hardwareAcceleration: boolean;
}



export interface ThemeMeta {
  id: string;
  name: string;
  author?: string;
  version?: string;
  description?: string;
  kind: "builtin" | "custom";
}
export interface AppearanceSettings {
  // Selected theme id — builtin (default/oled/midnight) or custom folder name.
  // Persisted in settings.json and mirrored to localStorage for early paint.
  theme: string;
}

export interface Settings {
  appearance: AppearanceSettings;
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
  game: {
    autoRecord: false,
    graceSeconds: 30,
    verboseDetection: false,
  },
  audio: { sources: [] },
  storage: { limitGb: 20, clipsDir: "", deleteEdited: false },
  app: { notificationStyle: "overlay", startWithWindows: false, minimizeToTray: true, clipSound: true, clipSoundVolume: 0.8, clipSoundPath: "", developerConsole: false, hardwareAcceleration: true },
  appearance: { theme: "default" },
  hotkeys: [
    { id: "save_60", label: "Save last minute", accelerator: "F8", action: "save_clip", durationSec: 60, durationUnit: "min" },
    { id: "save_300", label: "Save last 5 minutes", accelerator: "F9", action: "save_clip", durationSec: 300, durationUnit: "min" },
    { id: "record", label: "Toggle recording", accelerator: "F10", action: "toggle_record" },
  ],
  export: { targetMb: 10, codec: "h264", resolution: "source" },
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
  | "capture.listMonitors"
  | "game.listKnown"
  | "game.addKnown"
  | "game.removeKnown"
  | "game.listGames"
  | "game.addUserGame"
  | "game.removeUserGame"
  | "game.removeDiscovered"
  | "game.updateUserGame"
  | "game.ignoreExe"
  | "game.unignoreExe"
  | "game.listIgnored"
  | "game.sessions"
  | "game.detectExplain"
  | "shutdown";

// Where a game definition comes from.
export type GameSource = "discovered" | "user";

export interface LauncherRef {
  type: string; // steam | epic | gog | ubisoft | ea | battlenet | riot | msstore
  id: string; // launcher-specific id (steam appid, epic appname, ...)
}

export interface GameInfo {
  id: string;
  name: string;
  source: GameSource;
  executables: string[];
  installPaths: string[];
  launchers: LauncherRef[];
  enabled: boolean;
  stale: boolean;
  emulator: boolean;
  productType?: string; // game | software | tool | dlc | unknown
  classification?: string; // confirmed-game | confirmed-non-game | unknown
}


export interface GameSessionInfo {
  gameId: string;
  name: string;
  exe: string;
  pid: number;
  pids: number[];
  startMs: number;
  confidence: number;
  launcher: string | null;
  emulator: boolean;
  primary: boolean;
}

export interface DetectionReason {
  signal: string;
  delta: number;
  note: string;
}

export interface DetectionExplain {
  exe: string;
  pid: number;
  score: number;
  decision: "DETECTED" | "CANDIDATE" | "IGNORED";
  gameId: string | null;
  gameName: string | null;
  reasons: DetectionReason[];
}

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
  foreground: { exe: string; name: string | null; known: boolean; pid: number };
  sessions: GameSessionInfo[];
  storage: { limitGb: number; clipsDir: string };
  dirs: { clips: string; recordings: string };
  version: string;
}

export interface CoreEvent {
  type: "ready" | "game.changed" | "game.session" | "clip.saved" | "recording.state" | "ring.stats" | "error" | "capture.subject";
  params: Record<string, unknown>;
}

export interface AudioDeviceInfo {
  id: string;
  name: string;
  isInput: boolean;
  isVoicemeeter: boolean;
}

export interface MonitorInfo {
  index: number;
  id?: string; // GDI device/instance id (core RPC only)
  name: string;
  width: number;
  height: number;
  primary: boolean;
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

// Media metadata and cached waveform peaks used by the editor. `streamIndex`
// is the absolute FFmpeg stream index, so export mapping stays explicit.
export interface AudioTrackInfo {
  streamIndex: number;
  audioIndex: number;
  codec: string;
  name: string;
  kind: AudioSourceKind | "mix" | "unknown";
  channels: number;
  sampleRate: number;
  bitRate: number;
}

export interface WaveformData {
  duration: number;
  peaks: number[];
}

export interface EditorExportProject {
  segments: { start: number; end: number; id?: string }[];
  audioTracks: {
    streamIndex: number;
    name: string;
    included: boolean;
    muted: boolean;
    volume: number;
    excludedSegmentIds?: string[];
  }[];
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
  elapsedSec?: number;
  totalSec?: number;
  done?: boolean;
  error?: string;
  result?: ExportResult;
}

// One line in the developer console stream.
export interface DevConsoleLine {
  t: number; // epoch ms
  level: "core" | "app" | "rpc" | "event";
  text: string;
}

// ---------------------------------------------------------------------------
// Renderer bridge surface (window.shard, provided by preload.ts)
// ---------------------------------------------------------------------------

export interface ShardApi {
  // core RPC passthrough
  invoke(method: string, params?: Record<string, unknown>): Promise<unknown>;
  // Electron-side display enumeration (no core needed) — settings fallback
  // while the core is still connecting.
  listMonitorsFallback(): Promise<MonitorInfo[]>;
  onCoreEvent(cb: (type: string, params: Record<string, unknown>) => void): () => void;
  // settings
  getSettings(): Promise<Settings>;
  setSettings(s: Settings): Promise<void>;
  pickClipsFolder(currentPath: string): Promise<string | null>;
  getDefaultClipsFolder(): Promise<string>;
  // library
  listClips(): Promise<ClipRecord[]>;
  deleteClip(id: string): Promise<void>;
  setProtected(id: string, prot: boolean): Promise<void>;
  probeTracks(clipId: string): Promise<AudioTrackInfo[]>;
  prepareAudioPreview(clipId: string, streamIndex: number): Promise<string>;
  generateWaveform(clipId: string, streamIndex: number, points: number): Promise<WaveformData>;
  generateTimelineFrames(clipId: string, count: number): Promise<string[]>;
  onLibraryChanged(cb: () => void): () => void;
  revealInExplorer(path: string): void;
  openClip(path: string): void;
  // drag & drop (Windows: drag a clip file out of the window, e.g. into Discord)
  startDrag(path: string, iconPath?: string): void;
  // export
  startExport(clipId: string, project: EditorExportProject): Promise<void>;
  cancelExport(): Promise<void>;
  onExport(cb: (p: ExportProgress) => void): () => void;
  // misc
  version(): Promise<string>;
  restartApp(): Promise<void>;
  onToast(cb: (message: string) => void): () => void;
  // Frameless Windows shell controls. Other platforms retain their native frame.
  windowControlsSupported: boolean;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximized(cb: (maximized: boolean) => void): () => void;
  // developer console stream + window toggle (returns new open state)
  onDevConsoleLine(cb: (line: DevConsoleLine) => void): () => void;
  toggleDevConsole(): Promise<boolean>;
  // Clip sound: pick custom file (dialog) and preview
  pickClipSound(): Promise<string | null>;
  previewClipSound(path: string, volume: number): Promise<void>;
  getClipSoundDefaultPath(): Promise<string>;
  onPlayClipSound(cb: (data: { path: string; volume: number }) => void): () => void;
  // Themes — custom themes live in %APPDATA%/Shard/Themes/<id>/theme.css
  listCustomThemes(): Promise<ThemeMeta[]>;
  readTheme(id: string): Promise<{ css: string; dir: string } | null>;
  readCustomCss(): Promise<{ css: string; dir: string } | null>;
  getThemesDir(): Promise<string>;
  openThemesFolder(): Promise<void>;
  // Temporarily release all global shortcuts so the rebind UI can capture
  // keys that are currently registered (e.g. restoring the F8/F9 defaults).
  suspendHotkeys(): Promise<void>;
  resumeHotkeys(): Promise<void>;
  listProcesses(): Promise<Array<{ exe: string; pid: number; title: string }>>;
}
