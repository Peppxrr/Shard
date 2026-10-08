import type { ThemeMeta, ThemeDocument } from "./themes";
export type { ThemeMeta } from "./themes";
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
  | "obs_nvenc_av1_tex"
  | "h264_texture_amf"
  | "h265_texture_amf"
  | "av1_texture_amf"
  | "obs_qsv11_v2"
  | "obs_qsv11_hevc"
  | "obs_qsv11_av1";
export type ExportEncoderChoice =
  | "auto"
  | "libx264"
  | "libx265"
  | "libsvtav1"
  | "h264_nvenc"
  | "hevc_nvenc"
  | "av1_nvenc"
  | "h264_amf"
  | "hevc_amf"
  | "av1_amf"
  | "h264_qsv"
  | "hevc_qsv"
  | "av1_qsv";
export type VideoPreset = "low" | "medium" | "high" | "custom";
export type NotificationStyle = "overlay" | "windows" | "off";

export interface AudioSourceConfig {
  id: string; // WASAPI device id, or "default"; ignored for "process"
  name: string;
  kind: AudioSourceKind;
  window?: string; // "::<exe>" descriptor for kind === "process"
  gain: number; // 0..2
  enabled: boolean;
  // kind === "process" only. True: the app is captured on its own track and
  // removed from every Desktop audio track (core: audio_isolation.h). Missing
  // in settings written before this existed, which keeps the old duplicate
  // capture; new App audio rows default to true.
  excludeFromDesktop?: boolean;
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
  encoder: ExportEncoderChoice;
  resolution: "source" | "1080p" | "720p" | "480p" | "360p";
}

export interface StorageSettings {
  // Remove the oldest ordinary clips when they exceed `limitGb`. Recordings,
  // favorites, large videos, and (by default) edited exports are kept.
  autoCleanup: boolean;
  limitGb: number;
  // Base directory for clip storage. The app creates `clips/`, `recordings/`, and `editor/`
  // inside it; empty = default (userData).
  clipsDir: string;
  deleteEdited: boolean;
}

// Electron library policy/status; not a core configuration or RPC setting.
export interface StorageStatus {
  totalBytes: number;
  managedBytes: number;
  keptBytes: number;
  limitBytes: number;
  // Oldest-first removals needed to get back under the target.
  reclaimBytes: number;
  reclaimCount: number;
  reason: "disabled" | "within-target" | "cleaning" | "recent" | "minimum" | "needs-review" | "busy";
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
  // Recording priority: start the native capture core elevated through a
  // Windows scheduled task (UAC prompt when enabling, and again after capture
  // core updates), so libobs can raise its GPU priority. Off by default; under
  // full GPU load it trades a little game performance for smooth recording.
  recordingPriority: boolean;
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
  appearance: { theme: "default" },
  capture: { mode: "auto", monitor: 0 },
  video: { encoder: "auto", preset: "medium", custom: false, bitrateKbps: 0, fps: 60, width: 1920, height: 1080, x264Preset: "veryfast" },
  replay: { maxSeconds: 600, maxMb: 2048 },
  game: {
    autoRecord: false,
    graceSeconds: 30,
    verboseDetection: false,
  },
  audio: { sources: [] },
  storage: { autoCleanup: true, limitGb: 20, clipsDir: "", deleteEdited: false },
  app: { notificationStyle: "overlay", startWithWindows: false, minimizeToTray: true, clipSound: true, clipSoundVolume: 0.8, clipSoundPath: "", developerConsole: false, hardwareAcceleration: true, recordingPriority: false },
  export: { targetMb: 10, encoder: "auto", resolution: "source" },
  hotkeys: [
    { id: "save_60", label: "Save last minute", accelerator: "F8", action: "save_clip", durationSec: 60, durationUnit: "min" },
    { id: "save_300", label: "Save last 5 minutes", accelerator: "F9", action: "save_clip", durationSec: 300, durationUnit: "min" },
    { id: "record", label: "Toggle recording", accelerator: "F10", action: "toggle_record" },
  ],
};

// ---------------------------------------------------------------------------
// Core RPC (mirrors core/src/rpc.cpp dispatch)
// ---------------------------------------------------------------------------

export interface VideoEncoderInfo {
  id: Exclude<EncoderChoice, "auto">;
  label: string;
  codec: "h264" | "hevc" | "av1";
  vendor: "cpu" | "nvidia" | "amd" | "intel";
  hardware: boolean;
}
export interface ExportEncoderInfo {
  id: Exclude<ExportEncoderChoice, "auto">;
  label: string;
  codec: "h264" | "hevc" | "av1";
  vendor: "cpu" | "nvidia" | "amd" | "intel";
  hardware: boolean;
  preferred: boolean;
}


export type RpcMethod =
  | "config.set"
  | "state.get"
  | "recording.start"
  | "recording.stop"
  | "clip.save"
  | "audio.listDevices"
  | "capture.listMonitors"
  | "video.listEncoders"
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
  perf: { session: PerfSession; latest: PerfSample | null };
  version: string;
}

export interface CoreEvent {
  // clip.queued {request, requestedSec, depth}: a save was accepted (before muxing);
  // clip.saved/error carry the same `request` id; clip.dropped {request}: the ring stopped first.
  type: "ready" | "game.changed" | "game.session" | "clip.queued" | "clip.saved" | "clip.dropped" | "recording.state" | "ring.stats" | "perf.stats" | "error" | "capture.subject";
  params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Frame pacing diagnostics (core/src/perf_monitor.*, perf_analysis.h)
// ---------------------------------------------------------------------------

// Why recording lost frames:
//   gpu_starved        libobs missed render deadlines while the GPU's 3D engine was saturated
//   render_stall       libobs missed render deadlines although the 3D engine had headroom
//   encoder_overloaded frames rendered on time but the encoder could not take them
export type PerfCause = "ok" | "gpu_starved" | "render_stall" | "encoder_overloaded";

// GPU engine utilization (percent) of the capture adapter from the
// "\GPU Engine(*)\Utilization Percentage" counters. Engine values are the
// busiest engine of that type; process values are per-process 3D time.
export interface PerfGpuSample {
  available: boolean;
  engine3d?: number;
  videoEncode?: number;
  copy?: number;
  game3d?: number | null; // capture subject's processes; null when capturing the desktop
  shard3d?: number;
  shardEncode?: number;
  top3dPid?: number;
  top3d?: number;
}

// `perf.stats` event, once per second. Frame counts cover the last second;
// percentages and `cause` cover the last five seconds.
export interface PerfSample {
  t: number; // epoch ms
  active: boolean; // an output (replay buffer/recording) is encoding
  fps: number;
  frameTimeMs: number; // libobs average render time per frame
  rendered: number; // obs_get_total_frames delta (includes lagged)
  lagged: number; // obs_get_lagged_frames delta: render deadlines missed
  encoded: number; // video_output_get_total_frames delta
  skipped: number; // repeated frames encoded beyond render lag (libobs "skipped", counted when encoded)
  stalled: number; // new frames dropped because the encoder queue was full (counted when lost)
  backlogMs: number; // frames rendered but not yet encoded, in milliseconds of video
  renderLagPct: number;
  lostPct: number; // (lagged + stalled) / rendered over the last five seconds
  encoderSkipPct: number;
  gpu: PerfGpuSample;
  cause: PerfCause;
  hint: string | null; // plain-English guidance while frames are being lost
}

export interface PerfEncoderPath {
  encoder: string;
  zeroCopy: boolean; // NV12 textures go straight from the libobs mix to the encoder
  textureCapable: boolean;
  nv12Texture: boolean;
  gpuScaling: boolean;
  fellBack: boolean;
  reason: string;
  settings: Record<string, unknown> | null;
}

export type CaptureMethod = "game_capture" | "wgc_window" | "wgc_monitor" | "none";

// Logged as [perf-session] whenever an output starts.
export interface PerfSession {
  elevated: boolean;
  launch: "normal" | "task";
  gpuPriority: "set" | "failed" | "unknown"; // libobs-d3d11 GPU scheduling priority result
  processPriority: string; // CPU priority class (never changed by Shard)
  hags: boolean | null;
  adapter: { name: string; vendor: string; driver: string };
  capture: {
    subject: "monitor" | "game" | "none";
    name: string;
    pid: number;
    method: CaptureMethod;
    reason: string;
    hookApi: string | null;
    hookMode: "shared_texture" | "shared_memory" | null;
    hookSize: string;
  };
  video: { base: string; output: string; fps: number; rescaled: boolean; scale: string; format: string } | null;
  encoders: { replay: PerfEncoderPath | null; recording: PerfEncoderPath | null };
  gpuCounters: { available: boolean; error: string };
}

// Where frames were lost inside a saved clip or recording (seconds from its
// first presented frame). Carried by `clip.saved` / `recording.state`.
export interface ClipLagSegment {
  start: number;
  end: number;
  lagged: number;
  skipped: number;
  cause: PerfCause;
}

export interface ClipLagInfo {
  frames: number;
  lagged: number;
  skipped: number;
  cause: PerfCause;
  segments: ClipLagSegment[];
}

// Recording priority (Electron main; core: priority_task.*).
export interface RecordingPriorityStatus {
  enabled: boolean; // the user's setting
  supported: boolean; // Windows with a core that has the priority launcher
  installed: boolean; // scheduled task registered
  current: boolean; // task and its protected runtime copy match this install
  coreElevated: boolean; // the running core is elevated
  gpuPriority: "set" | "failed" | "unknown"; // libobs result; only "set" + elevated means active
  gpuVendor: string | null; // running core's adapter vendor ("intel": libobs skips GPU priority); null = no core reported yet
  busy: boolean; // install/remove in progress (UAC prompt may be open)
  message: string | null; // last error/fallback, plain English
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
  importedFrom?: "medal";
  // Frames libobs lost while this capture was recorded (null: unknown).
  lag?: ClipLagInfo | null;
}

export type LibraryImportKind = "clips" | "edited";

export interface LibraryImportResult {
  cancelled: boolean;
  imported: number;
  skipped: number;
  errors: string[];
}

export interface LibraryImportProgress {
  completed: number;
  total: number;
  currentName: string;
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

/**
 * One clip on the edited output timeline: source range [sourceStart,
 * sourceEnd) placed at timelineStart. Clips on one track never overlap;
 * timeline time not covered by a clip is black video / silent audio.
 */
export interface EditorTimelineClip {
  timelineStart: number;
  sourceStart: number;
  sourceEnd: number;
}

export interface EditorExportProject {
  videoClips: EditorTimelineClip[];
  audioTracks: {
    streamIndex: number;
    name: string;
    included: boolean;
    muted: boolean;
    volume: number;
    clips: EditorTimelineClip[];
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
  id?: number;
  t: number; // epoch ms
  level: "core" | "app" | "rpc" | "event" | "updates";
  text: string;
  severity?: "debug" | "info" | "warn" | "error";
  stream?: "stdout" | "stderr";
}

// ---------------------------------------------------------------------------
// Renderer bridge surface (window.shard, provided by preload.ts)
// ---------------------------------------------------------------------------

export type UpdateStatus = "disabled" | "idle" | "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "installing" | "error";
export interface UpdateState {
  revision: number;
  status: UpdateStatus;
  mode: "installed" | "portable" | "disabled";
  currentVersion: string;
  version?: string;
  releaseNotes?: string;
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number };
  message?: string;
  retry?: "check" | "download" | "install";
  dismissed?: boolean;
  installOnNextLaunch?: boolean;
  lastCheckedAt?: number;
  downloadKind?: "changes" | "full";
}

export interface ShardApi {
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<UpdateState>;
  scheduleUpdate(): Promise<UpdateState>;
  cancelScheduledUpdate(): Promise<UpdateState>;
  dismissUpdate(): Promise<UpdateState>;
  openUpdateRelease(): Promise<UpdateState>;
  onUpdateState(cb: (state: UpdateState) => void): () => void;
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
  // `draft` previews unsaved cleanup settings against the current library.
  getStorageStatus(draft?: StorageSettings): Promise<StorageStatus>;
  // Confirms a paused cleanup. Refused if it would now remove more than `maxBytes`.
  cleanUpStorage(maxBytes: number): Promise<number>;
  onStorageStatus(cb: (status: StorageStatus) => void): () => void;
  // library
  listClips(): Promise<ClipRecord[]>;
  renameClip(id: string, name: string): Promise<ClipRecord>;
  importMedalFolder(kind: LibraryImportKind): Promise<LibraryImportResult>;
  onLibraryImportProgress(cb: (progress: LibraryImportProgress) => void): () => void;
  deleteClip(id: string): Promise<void>;
  setProtected(id: string, prot: boolean): Promise<void>;
  probeTracks(clipId: string): Promise<AudioTrackInfo[]>;
  prepareAudioPreview(clipId: string, streamIndex: number, requestId?: string): Promise<string>;
  generateWaveform(clipId: string, streamIndex: number, points: number, requestId?: string): Promise<WaveformData>;
  cancelEditorPreparation(requestId: string): void;
  generateTimelineFrames(clipId: string, count: number, requestId: string): Promise<string[]>;
  onTimelineFrames(cb: (progress: { requestId: string; frames: string[] }) => void): () => void;
  cancelTimelineFrames(requestId: string): void;
  onLibraryChanged(cb: () => void): () => void;
  revealInExplorer(path: string): void;
  openClip(path: string): void;
  // drag & drop (Windows: drag a clip file out of the window, e.g. into Discord)
  startDrag(path: string, iconPath?: string): void;
  // export
  startExport(clipId: string, project: EditorExportProject): Promise<void>;
  cancelExport(): Promise<void>;
  listExportEncoders(): Promise<ExportEncoderInfo[]>;
  onExport(cb: (p: ExportProgress) => void): () => void;
  // misc
  version(): Promise<string>;
  copyPlaybackReport(sampleJson: string): Promise<void>;
  // One-click diagnostics bundle (zip: core/libobs log, perf timeline, system
  // info). Resolves to the saved path, or null when the dialog was cancelled.
  exportDiagnostics(): Promise<string | null>;
  // Recent perf.stats samples kept by the main process (newest last).
  getPerfTimeline(): Promise<PerfSample[]>;
  getRecordingPriority(): Promise<RecordingPriorityStatus>;
  // Enabling shows one UAC prompt; both directions restart the capture core.
  setRecordingPriority(enabled: boolean): Promise<RecordingPriorityStatus>;
  onRecordingPriority(cb: (status: RecordingPriorityStatus) => void): () => void;
  restartApp(): Promise<void>;
  onToast(cb: (message: string) => void): () => void;
  // Frameless Windows shell controls. Other platforms retain their native frame.
  windowControlsSupported: boolean;
  // Windows display language for dates and numbers (Chromium UI strings ship in en-US only).
  regionalLocale: string;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximized(cb: (maximized: boolean) => void): () => void;
  // developer console stream + window toggle (returns new open state)
  onDevConsoleLine(cb: (line: DevConsoleLine) => void): () => void;
  getDevConsoleHistory(): Promise<DevConsoleLine[]>;
  clearDevConsoleHistory(): Promise<number>;
  exportDevConsoleLog(): Promise<string | null>;
  toggleDevConsole(): Promise<boolean>;
  // Clip sound: pick custom file (dialog) and preview
  pickClipSound(): Promise<string | null>;
  previewClipSound(path: string, volume: number): Promise<void>;
  getClipSoundDefaultPath(): Promise<string>;
  onPlayClipSound(cb: (data: { path: string; volume: number }) => void): () => void;
  // Themes — custom themes live in %APPDATA%/Shard/Themes/<id>/theme.css
  listCustomThemes(): Promise<ThemeMeta[]>;
  readTheme(id: string): Promise<ThemeDocument | null>;
  readCustomCss(): Promise<string | null>;
  getThemesDir(): Promise<string>;
  openThemesFolder(): Promise<void>;
  // Temporarily release all global shortcuts so the rebind UI can capture
  // keys that are currently registered (e.g. restoring the F8/F9 defaults).
  suspendHotkeys(): Promise<void>;
  resumeHotkeys(): Promise<void>;
  listProcesses(): Promise<Array<{ exe: string; pid: number; title: string }>>;
}
