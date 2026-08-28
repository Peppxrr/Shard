// preload.ts — narrow contextBridge surface (window.shard).
import { contextBridge, ipcRenderer } from "electron";
import type {
  ThemeMeta,
  AudioTrackInfo,
  ShardApi,
  ClipRecord,
  DevConsoleLine,
  EditorExportProject,
  ExportProgress,
  Settings,
  WaveformData,
} from "../shared/contracts";

const api: ShardApi = {
  invoke: (method: string, params?: Record<string, unknown>) =>
    ipcRenderer.invoke("core:invoke", method, params ?? {}),

  listMonitorsFallback: () => ipcRenderer.invoke("monitors:list"),

  onCoreEvent: (cb) => {
    const listener = (_e: unknown, type: string, params: Record<string, unknown>) => cb(type, params);
    ipcRenderer.on("core:event", listener);
    return () => ipcRenderer.removeListener("core:event", listener);
  },

  getSettings: () => ipcRenderer.invoke("settings:get") as Promise<Settings>,
  setSettings: (s: Settings) => ipcRenderer.invoke("settings:set", s) as Promise<void>,
  pickClipsFolder: (currentPath: string) => ipcRenderer.invoke("storage:pickFolder", currentPath) as Promise<string | null>,
  getDefaultClipsFolder: () => ipcRenderer.invoke("storage:defaultFolder") as Promise<string>,

  listClips: () => ipcRenderer.invoke("library:list") as Promise<ClipRecord[]>,
  deleteClip: (id: string) => ipcRenderer.invoke("library:delete", id) as Promise<void>,
  setProtected: (id: string, prot: boolean) => ipcRenderer.invoke("library:protect", id, prot) as Promise<void>,
  probeTracks: (clipId: string) => ipcRenderer.invoke("editor:probe", clipId) as Promise<AudioTrackInfo[]>,
  prepareAudioPreview: (clipId: string, streamIndex: number) =>
    ipcRenderer.invoke("editor:audio-preview", clipId, streamIndex) as Promise<string>,
  generateWaveform: (clipId: string, streamIndex: number, points: number) =>
    ipcRenderer.invoke("editor:waveform", clipId, streamIndex, points) as Promise<WaveformData>,
  generateTimelineFrames: (clipId: string, count: number) =>
    ipcRenderer.invoke("editor:timeline-frames", clipId, count) as Promise<string[]>,
  onLibraryChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("library:changed", listener);
    return () => ipcRenderer.removeListener("library:changed", listener);
  },
  revealInExplorer: (p: string) => ipcRenderer.send("shell:reveal", p),
  openClip: (p: string) => ipcRenderer.send("shell:open", p),
  startDrag: (p: string, iconPath?: string) => ipcRenderer.send("drag:start", p, iconPath),

  startExport: (clipId: string, project: EditorExportProject) =>
    ipcRenderer.invoke("export:start", clipId, project) as Promise<void>,
  cancelExport: () => ipcRenderer.invoke("export:cancel") as Promise<void>,
  onExport: (cb) => {
    const listener = (_e: unknown, p: ExportProgress) => cb(p);
    ipcRenderer.on("export:progress", listener);
    return () => ipcRenderer.removeListener("export:progress", listener);
  },
  version: () => ipcRenderer.invoke("app:version") as Promise<string>,
  restartApp: () => ipcRenderer.invoke("app:restart") as Promise<void>,
  windowControlsSupported: process.platform === "win32",
  minimizeWindow: () => ipcRenderer.invoke("window:minimize") as Promise<void>,
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggleMaximize") as Promise<boolean>,
  closeWindow: () => ipcRenderer.invoke("window:close") as Promise<void>,
  isWindowMaximized: () => ipcRenderer.invoke("window:isMaximized") as Promise<boolean>,
  onWindowMaximized: (cb) => {
    const listener = (_e: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on("window:maximized", listener);
    return () => ipcRenderer.removeListener("window:maximized", listener);
  },
  suspendHotkeys: () => ipcRenderer.invoke("hotkeys:suspend") as Promise<void>,
  resumeHotkeys: () => ipcRenderer.invoke("hotkeys:resume") as Promise<void>,
  listProcesses: () => ipcRenderer.invoke("processes:list") as Promise<Array<{ exe: string; pid: number; title: string }>>,

  onToast: (cb) => {
    const listener = (_e: unknown, message: string) => cb(message);
    ipcRenderer.on("toast", listener);
    return () => ipcRenderer.removeListener("toast", listener);
  },

  onDevConsoleLine: (cb) => {
    const listener = (_e: unknown, line: DevConsoleLine) => cb(line);
    ipcRenderer.on("devconsole:line", listener);
    return () => ipcRenderer.removeListener("devconsole:line", listener);
  },
  toggleDevConsole: () => ipcRenderer.invoke("devconsole:toggle") as Promise<boolean>,

  // Clip sound — custom sound picker and preview
  onPlayClipSound: (cb) => {
    const listener = (_e: unknown, data: { path: string; volume: number }) => cb(data);
    ipcRenderer.on("play-clip-sound", listener);
    return () => ipcRenderer.removeListener("play-clip-sound", listener);
  },
  pickClipSound: () => ipcRenderer.invoke("clipSound:pick") as Promise<string | null>,
  previewClipSound: (p: string, v: number) => ipcRenderer.invoke("clipSound:preview", p, v) as Promise<void>,
  getClipSoundDefaultPath: () => ipcRenderer.invoke("clipSound:getDefaultPath") as Promise<string>,

  // Themes — renderer calls main to list/read custom themes (builtin are local)
  listCustomThemes: () => ipcRenderer.invoke("themes:listCustom") as Promise<ThemeMeta[]>,
  readTheme: (id: string) => ipcRenderer.invoke("themes:readTheme", id) as Promise<{ css: string; dir: string } | null>,
  readCustomCss: () => ipcRenderer.invoke("themes:readCustomCss") as Promise<{ css: string; dir: string } | null>,
  getThemesDir: () => ipcRenderer.invoke("themes:getDir") as Promise<string>,
  openThemesFolder: () => ipcRenderer.invoke("themes:openFolder") as Promise<void>,
};

contextBridge.exposeInMainWorld("shard", api);

// Dedicated themes bridge — themeManager prefers this, but ShardApi also exposes the same
// methods for convenience. Keeping both avoids breaking older custom theme docs.
const themesApi = {
  listCustom: () => ipcRenderer.invoke("themes:listCustom") as Promise<ThemeMeta[]>,
  readTheme: (id: string) => ipcRenderer.invoke("themes:readTheme", id) as Promise<{ css: string; dir: string } | null>,
  readCustomCss: () => ipcRenderer.invoke("themes:readCustomCss") as Promise<{ css: string; dir: string } | null>,
  getThemesDir: () => ipcRenderer.invoke("themes:getDir") as Promise<string>,
  openThemesFolder: () => ipcRenderer.invoke("themes:openFolder") as Promise<void>,
  listCustomThemes: () => ipcRenderer.invoke("themes:listCustom") as Promise<ThemeMeta[]>,
  getThemesDirSync: () => ipcRenderer.invoke("themes:getDir") as Promise<string>,
};
contextBridge.exposeInMainWorld("shardThemes", themesApi);
