// main.ts — Electron main process: core lifecycle, settings, hotkeys, library,
// storage watchdog, exports, tray, IPC.
import { app, BrowserWindow, dialog, ipcMain, screen, shell, Notification, Tray, Menu, nativeImage } from "electron";
import type { NativeImage } from "electron";
import { join as joinPath } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import type { Dirent } from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { CoreClient } from "./core-client";
import { loadSettings, getSettings, saveSettings, seedGamesJson } from "./settings";
import { HotkeyManager } from "./hotkeys";
import { Library, clipsDir } from "./library";
import { StorageWatchdog } from "./storage";
import { ExportManager } from "./export";
import { ffprobe, remuxToMp4, probeAudioTracks, prepareAudioPreview, generateWaveform, generateTimelineFrames } from "./ffmpeg";
import { SaveOverlay } from "./overlay";
import { getDefaultSoundPath, playClipSound, previewClipSound, setSoundWindow } from "./sound";
import { DevConsole } from "./dev-console";
import type { AudioSourceConfig, AudioTrackInfo, ClipRecord, DevConsoleLine, EditorExportProject, ExportProgress, Settings } from "../shared/contracts";

const execFileAsync = promisify(execFile);

function appIcon(): NativeImage {
  const candidates = [
    joinPath(process.resourcesPath ?? "", "icon.png"),
    joinPath(app.getAppPath(), "build", "icon-256.png"),
  ];
  for (const c of candidates) {
    const img = nativeImage.createFromPath(c);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}
// ----------------------------------------------------------------- processes --
export interface ProcessEntry { exe: string; pid: number; title: string }

async function listProcesses(): Promise<ProcessEntry[]> {
  // Try PowerShell first (rich window titles), fall back to tasklist.
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-Process | Where-Object { $_.ProcessName } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress",
    ], { windowsHide: true, timeout: 8000, maxBuffer: 10 * 1024 * 1024 });
    const raw = String(stdout || "").trim();
    if (raw) {
      const parsedUnknown: unknown = JSON.parse(raw);
      const arrUnknown: unknown[] = Array.isArray(parsedUnknown) ? parsedUnknown : [parsedUnknown];
      const map = new Map<string, ProcessEntry>();
      for (const entry of arrUnknown) {
        if (!entry || typeof entry !== "object" || !("ProcessName" in entry)) continue;
        const entryRec = entry as unknown as Record<string, unknown>; // external JSON validated via `in`
        const procNameUnknown: unknown = entryRec["ProcessName"];
        if (typeof procNameUnknown !== "string" || !procNameUnknown.trim()) continue;
        const exe = procNameUnknown.toLowerCase().endsWith(".exe") ? procNameUnknown.toLowerCase() : procNameUnknown.toLowerCase() + ".exe";
        if (map.has(exe)) continue;
        const pidRaw: unknown = entryRec["Id"];
        const pid = typeof pidRaw === "number" ? pidRaw : Number(pidRaw) || 0;
        const titleRaw: unknown = entryRec["MainWindowTitle"];
        const title = typeof titleRaw === "string" ? titleRaw.trim() : String(titleRaw ?? "").trim();
        map.set(exe, { exe, pid, title });
      }
      const list = [...map.values()].sort((a, b) => a.exe.localeCompare(b.exe));
      if (list.length) return list;
    }
  } catch {}
  try {
    const { stdout } = await execFileAsync("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, timeout: 5000 });
    const lines = String(stdout || "").split(/\r?\n/).filter((l) => l.trim());
    const map = new Map<string, ProcessEntry>();
    for (const line of lines) {
      // CSV: "Image Name","PID","Session Name","Session#","Mem Usage"
      const m = line.match(/^"([^"]+)","([^"]+)"/);
      if (!m) continue;
      const exe = m[1].trim().toLowerCase();
      if (!exe || map.has(exe)) continue;
      const pid = Number(m[2].replace(/[^0-9]/g, "")) || 0;
      map.set(exe, { exe, pid, title: "" });
    }
    return [...map.values()].sort((a, b) => a.exe.localeCompare(b.exe));
  } catch {}
  return [];
}





// ----------------------------------------------------------------- themes ----

function themesDir(): string {
  return path.join(app.getPath("userData"), "Themes");
}

function sanitizeThemeId(id: string): string {
  const s = String(id ?? "").trim().toLowerCase();
  if (!s) return "default";
  return s.replace(/[^a-z0-9-_]/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function parseThemeMeta(css: string, fallbackId: string): { id: string; name: string; author?: string; version?: string; description?: string } {
  try {
    const m = css.match(/\/\*\*([\s\S]*?)\*\//);
    if (!m) return { id: sanitizeThemeId(fallbackId), name: fallbackId };
    const block = m[1];
    const get = (key: string): string | undefined => {
      const re = new RegExp(`@${key}\\s+([^\\n*]+)`, "i");
      const hit = block.match(re);
      return hit?.[1]?.trim();
    };
    const name = get("name") || fallbackId;
    const out: any = { id: sanitizeThemeId(fallbackId), name };
    const author = get("author");
    const version = get("version");
    const description = get("description");
    if (author) out.author = author;
    if (version) out.version = version;
    if (description) out.description = description;
    return out;
  } catch {
    return { id: sanitizeThemeId(fallbackId), name: fallbackId };
  }
}

async function listCustomThemes(): Promise<Array<{ id: string; name: string; author?: string; version?: string; description?: string; kind: "custom" }>> {
  const dir = themesDir();
  try {
    await fsPromises.mkdir(dir, { recursive: true });
  } catch {}
  let entries: string[] = [];
  try {
    entries = await fsPromises.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ id: string; name: string; author?: string; version?: string; description?: string; kind: "custom" }> = [];
  for (const name of entries) {
    // Skip files like Goob.png at top-level, custom.css, etc. Only folders with theme.css
    const full = path.join(dir, name);
    try {
      const stat = await fsPromises.stat(full);
      if (!stat.isDirectory()) continue;
      const cssPath = path.join(full, "theme.css");
      await fsPromises.access(cssPath);
      const css = await fsPromises.readFile(cssPath, "utf8");
      const meta = parseThemeMeta(css, name);
      out.push({ ...meta, id: sanitizeThemeId(name), kind: "custom" });
    } catch {
      // missing theme.css, unreadable, malformed — skip but log
      // console.debug is not spammy
    }
  }
  return out;
}

async function readThemeCss(id: string): Promise<{ css: string; dir: string } | null> {
  const safe = sanitizeThemeId(id);
  let entries: Dirent[];
  try {
    entries = await fsPromises.readdir(themesDir(), { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && sanitizeThemeId(entry.name) === safe)
    .sort((a, b) => {
      const aExact = a.name.toLowerCase() === safe;
      const bExact = b.name.toLowerCase() === safe;
      if (aExact !== bExact) return aExact ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  for (const candidate of candidates) {
    const dir = path.join(themesDir(), candidate.name);
    try {
      const css = await fsPromises.readFile(path.join(dir, "theme.css"), "utf8");
      return { css, dir };
    } catch {}
  }
  return null;
}


async function readCustomCss(): Promise<{ css: string; dir: string } | null> {
  const p = path.join(themesDir(), "custom.css");
  try {
    const css = await fsPromises.readFile(p, "utf8");
    return { css, dir: themesDir() };
  } catch {
    return null;
  }
}

let win: BrowserWindow | null = null;
let core: CoreClient;
let hotkeys: HotkeyManager;
let library: Library;
let storage: StorageWatchdog;
let exporter: ExportManager;
let tray: Tray | null = null;
let quitting = false;
let coreFatal: string | null = null;
const overlay = new SaveOverlay();
const devConsole = new DevConsole();
const editorProbeCache = new Map<string, { path: string; tracks: AudioTrackInfo[] }>();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  main().catch((e) => {
    console.error("shard main failed:", e);
    app.exit(1);
  });
}

async function main(): Promise<void> {
  // Hardware acceleration must be decided before Chromium initializes (before
  // whenReady). Electron's app.disableHardwareAcceleration() is no-op after.
  // Read the persisted JSON synchronously; missing => default true (enabled).
  try {
    const candidate = path.join(app.getPath("userData"), "settings.json");
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { app?: { hardwareAcceleration?: unknown } };
      if (parsed.app?.hardwareAcceleration === false) {
        app.disableHardwareAcceleration();
      }
    }
  } catch {
    // Corrupt/missing file => keep enabled
  }

  await app.whenReady();
  app.setAppUserModelId("com.shard.app");

  migrateLegacyUserData();
  await loadSettings();

  const userData = app.getPath("userData");
  await seedGamesJson();

  library = new Library(userData);
  await library.reconcile(clipsDir());
  storage = new StorageWatchdog(library);
  storage.start();

  exporter = new ExportManager();
  exporter.on("progress", (p: ExportProgress) => {
    win?.webContents.send("export:progress", p);
    if (p.done && p.result) {
      // Edited exports land in the library as source "edited" (never auto-deleted).
      const src = library.get(p.clipId);
      library.importMp4(p.result.path, "edited", src?.game ?? null);
      win?.webContents.send("library:changed");
      toast(`Export ready: ${path.basename(p.result.path)} (${p.result.sizeMb} MB)`);
      void storage.check();
    }
  });
  storage.on("deleted", ({ count, limitGb }) => {
    toast(`Deleted ${count} old clips to stay under your ${limitGb} GB limit`);
  });

  core = new CoreClient();
  core.on("event", onCoreEvent);
  core.on("core-exited", (code: number | null) => {
    devConsole.feed({ t: Date.now(), level: "app", text: `Core exited (code ${code})` });
  });
  core.on("log", (level: "core" | "rpc", text: string) => {
    devConsole.feed({ t: Date.now(), level, text });
  });
  core.on("fatal", (msg: string) => {
    coreFatal = msg;
    toast(msg);
    devConsole.feed({ t: Date.now(), level: "app", text: `FATAL: ${msg}` });
  });

  hotkeys = new HotkeyManager(core, (msg) => toast(msg));

  createWindow();
  registerIpc();
  setupTray();
  applyAppSettings(getSettings());
  // Restore the developer console window when the setting was left enabled.
  if (getSettings().app.developerConsole && !devConsole.open) devConsole.toggle();

  await core.start();
  hotkeys.apply(getSettings());
}

// The ClipForge → Shard rename changed the packaged userData dir
// (%APPDATA%\ClipForge → %APPDATA%\Shard), which silently orphaned every
// saved setting on Start-menu launches. On first run under the new name,
// carry the old profile over (settings, games.json, library.db, thumbs, core
// config). No-op once the new dir has been initialized.
function migrateLegacyUserData(): void {
  const userData = app.getPath("userData");
  if (existsSync(path.join(userData, "settings.json"))) return;
  const appData = app.getPath("appData");
  for (const legacy of ["Shard", "ClipForge", "clipforge"]) {
    if (path.basename(userData).toLowerCase() === legacy.toLowerCase()) continue;
    const legacyDir = path.join(appData, legacy);
    if (!existsSync(legacyDir)) continue;
    try {
      for (const entry of readdirSync(legacyDir)) {
        const to = path.join(userData, entry);
        if (!existsSync(to)) cpSync(path.join(legacyDir, entry), to, { recursive: true });
      }
      return;
    } catch (e) {
      console.error(`legacy userData migration from ${legacyDir} failed:`, e);
    }
  }
}

// ---------------------------------------------------------------- window ----

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: "Shard",
    backgroundColor: "#07090f",
    icon: appIcon(),
    show: false,
    autoHideMenuBar: true,
    frame: process.platform !== "win32",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.on("maximize", () => win?.webContents.send("window:maximized", true));
  win.on("unmaximize", () => win?.webContents.send("window:maximized", false));
  setSoundWindow(win);
  win.on("close", (e) => {
    if (!quitting && getSettings().app.minimizeToTray) {
      e.preventDefault();
      win?.hide(); // close-to-tray
    }
  });
  win.on("closed", () => { win = null; setSoundWindow(null); }); // full close is supported (tray setting off)

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }
}

// ------------------------------------------------------------------ IPC ----

function registerIpc(): void {
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:set", (_e, s: Settings) => applySettings(s));
  ipcMain.handle("storage:defaultFolder", () => app.getPath("userData"));
  ipcMain.handle("storage:pickFolder", async (_e, currentPath: string) => {
    const current = String(currentPath ?? "").trim();
    const options: Electron.OpenDialogOptions = {
      title: "Choose clips folder",
      defaultPath: current && existsSync(current) ? current : app.getPath("userData"),
      properties: ["openDirectory", "createDirectory"],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("core:invoke", async (_e, method: string, params?: Record<string, unknown>) => {
    return core.invoke(method, params ?? {});
  });

  ipcMain.handle("library:list", () => library.list());
  ipcMain.handle("library:delete", (_e, id: string) => {
    library.delete(id);
    void storage.check();
    win?.webContents.send("library:changed");
  });
  ipcMain.handle("library:protect", (_e, id: string, prot: boolean) => {
    library.setProtected(id, prot);
    win?.webContents.send("library:changed");
  });
  ipcMain.handle("editor:probe", (_e, clipId: string) => probeClipTracks(clipId));
  ipcMain.handle("editor:waveform", (_e, clipId: string, streamIndex: number, points: number) => {
    const clip = library.get(clipId);
    if (!clip) throw new Error("The source clip is no longer in the library");
    const tracks = probeClipTracks(clipId);
    if (!tracks.some((track) => track.streamIndex === streamIndex)) throw new Error("The requested audio stream does not exist");
    return generateWaveform(clip.path, streamIndex, clip.durationMs / 1000, points);
  });
  ipcMain.handle("editor:timeline-frames", (_e, clipId: string, count: number) => {
    const clip = library.get(clipId);
    if (!clip) throw new Error("The source clip is no longer in the library");
    return generateTimelineFrames(clip.path, clip.durationMs / 1000, count);
  });
  ipcMain.handle("editor:audio-preview", (_e, clipId: string, streamIndex: number) => {
    const clip = library.get(clipId);
    if (!clip) throw new Error("The source clip is no longer in the library");
    const tracks = probeClipTracks(clipId);
    if (!tracks.some((track) => track.streamIndex === streamIndex)) throw new Error("The requested audio stream does not exist");
    return prepareAudioPreview(clip.path, streamIndex);
  });

  // Windows drag-out: renderer dragstart hands us the file + icon; Electron's
  // webContents.startDrag hands the native drag to Explorer/Discord/etc.
  ipcMain.on("drag:start", (_e, filePath: string, iconPath?: string) => {
    if (!win) return;
    const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    win.webContents.startDrag({ file: filePath, icon: icon.isEmpty() ? nativeImage.createEmpty() : icon });
  });

  ipcMain.handle("export:start", (_e, clipId: string, project: EditorExportProject) => doExport(clipId, project));
  ipcMain.handle("export:cancel", () => exporter.cancel());

  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:restart", () => {
    quitting = true;
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle("window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle("window:toggleMaximize", (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target) return false;
    if (target.isMaximized()) target.unmaximize();
    else target.maximize();
    return target.isMaximized();
  });
  ipcMain.handle("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle("window:isMaximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
  // Monitor enumeration that does not depend on the core: the capture
  // settings stay usable while shardcore is still spawning (or unreachable).
  // Primary-first order matches the core's EnumDisplayMonitors result in the
  // common case, so saved indexes line up once the core takes over.
  ipcMain.handle("monitors:list", () => {
    const primaryId = screen.getPrimaryDisplay().id;
    return [...screen.getAllDisplays()]
      .sort((a, b) => Number(b.id === primaryId) - Number(a.id === primaryId))
      .map((d, i) => ({ index: i, name: d.label || `Display ${i + 1}`, width: d.size.width, height: d.size.height, primary: d.id === primaryId }));
  });
  ipcMain.handle("hotkeys:suspend", () => hotkeys.suspend());
  ipcMain.handle("hotkeys:resume", () => hotkeys.resume());
  ipcMain.handle("devconsole:toggle", () => devConsole.toggle());
  ipcMain.handle("processes:list", async () => listProcesses());




  // Clip sound: custom file picker + preview + default path
  ipcMain.handle("clipSound:pick", async () => {
    const res = await dialog.showOpenDialog(win ?? undefined as unknown as Electron.BrowserWindow, {
      title: "Choose clip sound",
      properties: ["openFile"],
      filters: [
        { name: "Audio", extensions: ["wav", "mp3", "ogg", "flac", "m4a", "wma", "aac"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });
  ipcMain.handle("clipSound:preview", async (_e, p: string, v: number) => {
    await previewClipSound(String(p ?? ""), Number(v));
  });
  ipcMain.handle("clipSound:getDefaultPath", async () => getDefaultSoundPath());

  // Themes — custom theme discovery + CSS reading, mild FS access via IPC.
  ipcMain.handle("themes:listCustom", async () => listCustomThemes());
  ipcMain.handle("themes:readTheme", async (_e, id: string) => readThemeCss(String(id)));
  ipcMain.handle("themes:readCustomCss", async () => readCustomCss());
  ipcMain.handle("themes:getDir", () => themesDir());
  ipcMain.handle("themes:openFolder", async () => {
    const dir = themesDir();
    try { await fsPromises.mkdir(dir, { recursive: true }); } catch {}
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });

  ipcMain.on("shell:reveal", (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.on("shell:open", (_e, p: string) => shell.openPath(p).catch(() => {}));
}

async function doExport(clipId: string, project: EditorExportProject): Promise<void> {
  const clip = library.get(clipId);
  if (!clip) throw new Error("The source clip is no longer in the library");
  if (!project || !Array.isArray(project.segments) || !Array.isArray(project.audioTracks)) {
    throw new Error("The editor project is malformed");
  }
  await exporter.export(clip, project, getSettings().export);
}

function probeClipTracks(clipId: string): AudioTrackInfo[] {
  const clip = library.get(clipId);
  if (!clip) throw new Error("The source clip is no longer in the library");
  const cached = editorProbeCache.get(clipId);
  if (cached?.path === clip.path) return cached.tracks;
  const probed = probeAudioTracks(clip.path);
  // Configured rows keep stable mix indexes while disabled so live toggles do
  // not restart the ring. Use the same stable row order when naming streams.
  const configuredSources = getSettings().audio.sources.slice(0, 5);
  const sourceTracks = clip.source !== "edited" && probed.length > 1 ? probed.slice(1) : probed;
  const tracks = sourceTracks.map((track, index) => identifyAudioTrack(track, configuredSources[index], sourceTracks.length));
  editorProbeCache.set(clipId, { path: clip.path, tracks });
  return tracks;
}

function identifyAudioTrack(track: AudioTrackInfo, source: AudioSourceConfig | undefined, trackCount: number): AudioTrackInfo {
  if (source) {
    return {
      ...track,
      name: source.name.trim() || (source.kind === "input" ? "Microphone" : source.kind === "output" ? "System audio" : "Application audio"),
      kind: source.kind,
    };
  }
  if (trackCount === 1 && track.name.startsWith("Audio ")) return { ...track, name: "System audio", kind: "output" };
  return track;
}

// ------------------------------------------------------------- settings ----

function applyAppSettings(s: Settings): void {
  app.setLoginItemSettings({
    openAtLogin: s.app.startWithWindows,
    path: process.execPath,
  });
}

async function applySettings(s: Settings): Promise<void> {
  await saveSettings(s);
  const statuses = hotkeys.apply(s);
  for (const st of statuses) {
    if (!st.ok) toast(`Hotkey ${st.accelerator} failed to register: ${st.error ?? "key in use"}`);
  }
  applyAppSettings(s);
  // Developer console follows the setting: open when enabled, close when off.
  if (s.app.developerConsole && !devConsole.open) devConsole.toggle();
  if (!s.app.developerConsole && devConsole.open) devConsole.close();
  core.applySettings(s);
  void storage.check();
}

// --------------------------------------------------------------- events ----

function onCoreEvent(type: string, params: Record<string, unknown>): void {
  win?.webContents.send("core:event", type, params);
  devConsole.feed({ t: Date.now(), level: "event", text: `${type} ${JSON.stringify(params)}` });

  switch (type) {
    case "clip.saved": {
      const p = params as { path: string; requestedSec: number; actualSec: number };
      void importClip(p.path);
      const label = savedLabel(p.requestedSec);
      const style = getSettings().app.notificationStyle;
      if (style === "overlay") {
        // On-screen popup (top-left, slides in/out) — visible even over games.
        overlay.show(label);
      } else if (style === "windows") {
        const windowHidden = !win || win.isMinimized() || !win.isFocused();
        if (windowHidden) new Notification({ title: "Shard", body: label }).show();
        else toast(label);
      }
      // "off": no feedback.
      // Clip sound is now handled in renderer (App.tsx onCoreEvent) for low latency + volume/custom support.
      // Main fallback only if window not available — renderer will play via preloaded Audio.
      if (getSettings().app.clipSound && (!win || win.isDestroyed())) playClipSound();
      break;
    }
    case "recording.state": {
      const p = params as { active: boolean; path: string };
      if (!p.active && p.path) void finalizeRecording(p.path);
      const style = getSettings().app.notificationStyle;
      if (style === "overlay") overlay.showRecording(p.active);
      else if (style === "windows" && (!win || win.isMinimized() || !win.isFocused()))
        new Notification({ title: "Shard", body: p.active ? "Recording started" : "Recording stopped" }).show();
      break;
    }
    case "game.changed": {
      const p = params as { known: boolean; name: string | null; exe: string };
      // Keep game identity for clip tagging. Capture-subject notifications are
      // the single user-facing popup, so detection never doubles it.
      lastGame = p.known ? p.name : null;
      break;
    }
    case "capture.subject": {
      const p = params as { kind: string; name: string | null };
      if (p.kind === "game" && p.name) {
        const style = getSettings().app.notificationStyle;
        // Throttle capture switched spam (same game within 5s)
        const now = Date.now();
        if (p.name !== lastCaptureGame || now - lastCaptureAt > 5000) {
          lastCaptureGame = p.name;
          lastCaptureAt = now;
          if (style === "overlay") overlay.showCapture(p.name);
          else if (style === "windows" && (!win || win.isMinimized() || !win.isFocused()))
            new Notification({ title: "Shard", body: `Switched capture to ${p.name}` }).show();
        }
      }
      break;
    }
    case "error": {
      const p = params as { message: string };
      toast(p.message);
      break;
    }
  }
}

let lastGame: string | null = null;
let lastCaptureGame: string | null = null;
let lastCaptureAt = 0;


async function importClip(file: string): Promise<void> {
  // Core produces mp4 directly (verify with ffprobe; remux if it somehow is
  // not mp4 — e.g. muxer misbehaved). Async to avoid blocking main thread on ffprobe/thumbnail.
  const game = lastGame;
  const final = file;
  if (!file.toLowerCase().endsWith(".mp4")) {
    const fixed = file.replace(/\.\w+$/, ".mp4");
    try { remuxToMp4(file, fixed); } catch {}
    try { existsSync(file) && unlinkSync(file); } catch {}
  }
  try {
    const rec = await library.importMp4Async(final, "clip", game);
    win?.webContents.send("library:added", rec);
    win?.webContents.send("library:changed");
  } catch (e) {
    console.error("[importClip] failed", e);
    // Fallback: still notify library changed so UI can refresh
    win?.webContents.send("library:changed");
  }
  void storage.check();
}

async function finalizeRecording(mp4: string): Promise<void> {
  // The core now records fragmented mp4 directly; just probe + import (async).
  try {
    const rec = await library.importMp4Async(mp4, "recording", lastGame);
    win?.webContents.send("library:added", rec);
    toast("Recording saved to library");
    void storage.check();
  } catch (e) {
    toast(`Recording import failed: ${(e as Error).message}`);
  }
}

function savedLabel(durationSec: number): string {
  if (durationSec === 30) return "Saved last 30 seconds";
  if (durationSec === 60) return "Saved last minute";
  if (durationSec === 300) return "Saved last 5 minutes";
  if (durationSec >= 60) return `Saved last ${Math.round(durationSec / 60)} minutes`;
  return `Saved last ${durationSec} seconds`;
}

function toast(message: string): void {
  win?.webContents.send("toast", message);
}

// ----------------------------------------------------------------- tray ----

function setupTray(): void {
  const icon = appIcon();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Shard");
  const menu = Menu.buildFromTemplate([
    { label: "Open Shard", click: () => { win?.show(); win?.focus(); } },
    { label: "Toggle recording", click: () => toggleRecording() },
    { type: "separator" },
    { label: "Quit", click: () => void quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => { win?.show(); win?.focus(); });
}

async function toggleRecording(): Promise<void> {
  const st = (await core.invoke("state.get")) as { recording?: { active?: boolean } };
  if (st.recording?.active) await core.invoke("recording.stop");
  else await core.invoke("recording.start");
}

async function quit(): Promise<void> {
  quitting = true;
  hotkeys.dispose();
  storage.stop();
  overlay.destroy();
  devConsole.close();
  await core.shutdown();
  library.close();
  app.quit();
}

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => {
  // With close-to-tray the window is only hidden, so this only fires when the
  // window really closed (setting off or Quit): shut down fully.
  if (!getSettings().app.minimizeToTray) void quit();
});
app.on("quit", () => {
  if (!quitting) {
    void core?.shutdown();
    library?.close();
  }
});

