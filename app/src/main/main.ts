// main.ts — Electron main process: core lifecycle, settings, hotkeys, library,
// storage watchdog, exports, tray, IPC.
import { app, autoUpdater as electronAutoUpdater, protocol, BrowserWindow, dialog, ipcMain, screen, shell, Notification, Tray, Menu, nativeImage } from "electron";
import type { NativeImage } from "electron";
import { join as joinPath } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, readdirSync, readFileSync, unlinkSync, promises as fs } from "node:fs";
import path from "node:path";
import { ThemeStore } from "./themes";
import { CoreClient } from "./core-client";
import { loadSettings, getSettings, saveSettings, seedGamesJson } from "./settings";
import { HotkeyManager } from "./hotkeys";
import { Library, clipsDir, editorDir } from "./library";
import { medalImportMetadata, scanMp4Tree } from "./library-import";
import { StorageWatchdog } from "./storage";
import { ExportManager } from "./export";
import { ffprobe, listExportEncoders, remuxToMp4, probeAudioTracks, prepareAudioPreview, generateWaveform, editorTimelinePreviews, stopEditorPreviews, resumeEditorPreviews } from "./ffmpeg";
import { SaveOverlay } from "./overlay";
import { getDefaultSoundPath, playClipSound, previewClipSound, setSoundWindow } from "./sound";
import { DevConsole } from "./dev-console";
import { copyPlaybackReport } from "./playback-diagnostics";
import { registerUpdater } from "./updater";
import { ShutdownLifecycle } from "./shutdown-lifecycle";
import { bounded, ownedProcesses } from "./bundled-processes";
import type { AudioSourceConfig, AudioTrackInfo, ClipRecord, DevConsoleLine, EditorExportProject, ExportProgress, Settings, LibraryImportKind, LibraryImportResult } from "../shared/contracts";

const execFileAsync = promisify(execFile);

// Optional local review profile. Set before the instance lock, so development
// can run beside the installed app without sharing settings or the database.
if (!app.isPackaged && process.env.SHARD_DEV_USER_DATA) {
  app.setPath("userData", path.resolve(process.env.SHARD_DEV_USER_DATA));
}

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





// Registered before app readiness; local theme assets also work on Vite's HTTP origin.
protocol.registerSchemesAsPrivileged([{ scheme: "shard-theme", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let themes: ThemeStore;

let win: BrowserWindow | null = null;
let core: CoreClient;
let hotkeys: HotkeyManager;
let library: Library;
let storage: StorageWatchdog;
let libraryImportActive = false;
let exporter: ExportManager;
let tray: Tray | null = null;
let quitting = false;
let applicationStarted = false;
let servicesStoppedForUpdate = false;
let libraryClosedForUpdate = false;
let updater: ReturnType<typeof registerUpdater> | undefined;
let coreFatal: string | null = null;
const overlay = new SaveOverlay();
const devConsole = new DevConsole();
const editorProbeCache = new Map<string, { path: string; tracks: Promise<AudioTrackInfo[]> }>();
const timelineRequests = new Map<string, AbortController>();

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
  if (!shutdown.acceptingWork) return;
  app.setAppUserModelId("com.shard.app");

  migrateLegacyUserData();
  await loadSettings();
  if (!shutdown.acceptingWork) return;
  themes = new ThemeStore(path.join(app.getPath("userData"), "Themes"), app.getVersion(), () => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("themes:changed");
  });
  protocol.handle("shard-theme", async request => {
    try {
      const resource = await themes.resource(request.url);
      return new Response(resource.data as Uint8Array<ArrayBuffer>, { headers: {
        "Content-Type": resource.mime, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      } });
    } catch { return new Response("Theme resource unavailable", { status: 404 }); }
  });
  await trackJob(themes.startWatching()).catch(error => console.warn("[themes] Watch failed", error));
  if (!shutdown.acceptingWork) { themes.close(); return; }

  updater = registerUpdater({
    window: () => win,
    prepareInstall: () => shutdown.prepareUpdate(),
    installFailed: () => shutdown.recoverUpdate(),
    log: line => devConsole.feed(line),
  });
  if (await updater.beforeLaunch()) return;
  if (!shutdown.acceptingWork) return;

  const userData = app.getPath("userData");
  await seedGamesJson();
  if (!shutdown.acceptingWork) return;

  library = new Library(userData);
  await trackJob(library.reconcile(clipsDir()));
  if (!shutdown.acceptingWork) return;
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
  core.on("core-exited", (code: number | null, signal?: string | null) => {
    devConsole.feed({ t: Date.now(), level: "app", severity: code === 0 && !signal ? "info" : "error",
      text: `Core exited (code ${code}, signal ${signal ?? "none"})` });
  });
  core.on("log", (level: "core" | "rpc", text: string, metadata?: Pick<DevConsoleLine, "stream" | "severity">) => {
    devConsole.feed({ t: Date.now(), level, text, ...metadata });
  });
  core.on("fatal", (msg: string) => {
    coreFatal = msg;
    toast(msg);
    devConsole.feed({ t: Date.now(), level: "app", text: `FATAL: ${msg}` });
  });

  hotkeys = new HotkeyManager(core, (msg) => toast(msg));

  createWindow();
  applicationStarted = true;
  registerIpc();
  setupTray();
  applyAppSettings(getSettings());
  // Restore the developer console window when the setting was left enabled.
  if (getSettings().app.developerConsole && !devConsole.open) devConsole.toggle();

  updater.startChecks();
  await core.start();
  if (!shutdown.acceptingWork) return;
  hotkeys.apply(getSettings());
}

// Import profiles from the former app name on first launch so existing
// settings and clips remain available after upgrading.
function migrateLegacyUserData(): void {
  if (!app.isPackaged && process.env.SHARD_DEV_USER_DATA) return;
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
  win.webContents.on("console-message", details => {
    const severity = details.level === "error" ? "error" : details.level === "warning" ? "warn" : details.level === "debug" ? "debug" : "info";
    devConsole.feed({ t: Date.now(), level: "app", severity,
      text: `[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})` });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    devConsole.feed({ t: Date.now(), level: "app", severity: "error", text: `Renderer process exited: ${details.reason}; code=${details.exitCode}` });
  });
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
  const handle: typeof ipcMain.handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
    if (!shutdown.acceptingWork) throw new Error("Shard is shutting down; try again after update recovery");
    return trackJob(Promise.resolve().then(() => {
      if (!shutdown.acceptingWork) throw new Error("Shard is shutting down");
      return listener(event, ...args);
    }));
  });
  handle("settings:get", () => getSettings());
  handle("settings:set", (_e, s: Settings) => applySettings(s));
  handle("storage:defaultFolder", () => app.getPath("userData"));
  handle("storage:pickFolder", async (_e, currentPath: string) => {
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

  handle("core:invoke", async (_e, method: string, params?: Record<string, unknown>) => {
    return core.invoke(method, params ?? {});
  });

  handle("library:list", () => library.list());
  handle("library:delete", async (_e, id: string) => {
    await library.delete(id);
    void storage.check();
    win?.webContents.send("library:changed");
  });
  handle("library:rename", async (_e, id: string, name: string) => {
    if (typeof id !== "string" || typeof name !== "string") throw new Error("Invalid clip name");
    try { return await library.renameClip(id, name); }
    finally { editorProbeCache.delete(id); win?.webContents.send("library:changed"); }
  });
  handle("library:importMedalFolder", async (_e, kind: LibraryImportKind): Promise<LibraryImportResult> => {
    if (kind !== "clips" && kind !== "edited") throw new Error("Unknown import type");
    if (libraryImportActive) throw new Error("A library import is already running");
    libraryImportActive = true;
    const result: LibraryImportResult = { cancelled: false, imported: 0, skipped: 0, errors: [] };
    try {
      const options: Electron.OpenDialogOptions = {
        title: kind === "clips" ? "Choose your Medal Clips folder" : "Choose your Medal editor exports folder",
        defaultPath: kind === "clips" ? "C:\\Medal\\Clips" : "C:\\Medal\\Video-Editor\\exports",
        properties: ["openDirectory"], buttonLabel: "Import videos",
      };
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths[0]) return { ...result, cancelled: true };
      if (!shutdown.acceptingWork) return { ...result, cancelled: true };
      const folder = picked.filePaths[0];
      win?.webContents.send("library:import-progress", { completed: 0, total: 0, currentName: path.basename(folder) });
      const scan = await scanMp4Tree(folder);
      result.skipped = scan.skipped;
      result.errors = scan.errors;
      const destination = kind === "clips" ? clipsDir() : editorDir();
      for (let i = 0; i < scan.files.length; i++) {
        if (!shutdown.acceptingWork) return { ...result, cancelled: true };
        const file = scan.files[i];
        win?.webContents.send("library:import-progress", { completed: i, total: scan.files.length, currentName: path.basename(file) });
        try {
          const stat = await fs.stat(file);
          const metadata = kind === "clips" ? medalImportMetadata(folder, file, stat.mtimeMs) : { game: null, createdAt: stat.mtimeMs };
          const imported = await library.importCopiedMp4Async(file, destination, kind === "clips" ? "clip" : "edited", metadata);
          if (imported.duplicate) result.skipped++;
          else { result.imported++; win?.webContents.send("library:changed"); }
        } catch (error) { result.errors.push(`${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      win?.webContents.send("library:import-progress", { completed: scan.files.length, total: scan.files.length, currentName: "" });
      return result;
    } finally { libraryImportActive = false; void storage.check(); }
  });
  handle("library:protect", (_e, id: string, prot: boolean) => {
    library.setProtected(id, prot);
    win?.webContents.send("library:changed");
    void storage.check();
  });
  handle("editor:probe", (_e, clipId: string) => probeClipTracks(clipId));
  handle("editor:waveform", async (_e, clipId: string, streamIndex: number, points: number) => {
    const clip = library.get(clipId);
    if (!clip) throw new Error("The source clip is no longer in the library");
    const tracks = await probeClipTracks(clipId);
    if (!tracks.some((track) => track.streamIndex === streamIndex)) throw new Error("The requested audio stream does not exist");
    return generateWaveform(clip.path, streamIndex, clip.durationMs / 1000, points);
  });
  handle("editor:timeline-frames", async (event, clipId: string, count: number, requestId: string) => {
    const clip = library.get(clipId);
    if (!clip) throw new Error("The source clip is no longer in the library");
    if (typeof requestId !== "string" || requestId.length > 128) throw new Error("Invalid preview request");
    const key = `${event.sender.id}:${requestId}`;
    timelineRequests.get(key)?.abort();
    const controller = new AbortController();
    timelineRequests.set(key, controller);
    const closed = () => controller.abort();
    event.sender.once("destroyed", closed);
    try {
      return await editorTimelinePreviews().generate(clip.path, clip.durationMs / 1000, count, (frames) => {
        if (!event.sender.isDestroyed() && !controller.signal.aborted)
          event.sender.send("editor:timeline-progress", { requestId, frames });
      }, controller.signal);
    } finally {
      event.sender.removeListener("destroyed", closed);
      if (timelineRequests.get(key) === controller) timelineRequests.delete(key);
    }
  });
  ipcMain.on("editor:timeline-cancel", (event, requestId: string) => {
    timelineRequests.get(`${event.sender.id}:${requestId}`)?.abort();
  });
  handle("editor:audio-preview", async (_e, clipId: string, streamIndex: number) => {
    const clip = library.get(clipId);
    if (!clip) throw new Error("The source clip is no longer in the library");
    const tracks = await probeClipTracks(clipId);
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

  handle("export:start", (_e, clipId: string, project: EditorExportProject) => doExport(clipId, project));
  handle("export:cancel", () => exporter.cancel());
  handle("export:listEncoders", () => listExportEncoders());
  handle("app:version", () => app.getVersion());
  handle("playback:copy-report", (event, sampleJson: string) => copyPlaybackReport(event.sender, sampleJson));
  handle("app:restart", () => {
    quitting = true;
    app.relaunch();
    app.exit(0);
  });
  handle("window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  handle("window:toggleMaximize", (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target) return false;
    if (target.isMaximized()) target.unmaximize();
    else target.maximize();
    return target.isMaximized();
  });
  handle("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  handle("window:isMaximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
  // Monitor enumeration that does not depend on the core: the capture
  // settings stay usable while shardcore is still spawning (or unreachable).
  // Primary-first order matches the core's EnumDisplayMonitors result in the
  // common case, so saved indexes line up once the core takes over.
  handle("monitors:list", () => {
    const primaryId = screen.getPrimaryDisplay().id;
    return [...screen.getAllDisplays()]
      .sort((a, b) => Number(b.id === primaryId) - Number(a.id === primaryId))
      .map((d, i) => ({ index: i, name: d.label || `Display ${i + 1}`, width: d.size.width, height: d.size.height, primary: d.id === primaryId }));
  });
  handle("hotkeys:suspend", () => hotkeys.suspend());
  handle("hotkeys:resume", () => hotkeys.resume());
  handle("devconsole:toggle", () => devConsole.toggle());
  handle("processes:list", async () => listProcesses());




  // Clip sound: custom file picker + preview + default path
  handle("clipSound:pick", async () => {
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
  handle("clipSound:preview", async (_e, p: string, v: number) => {
    await previewClipSound(String(p ?? ""), Number(v));
  });
  handle("clipSound:getDefaultPath", async () => getDefaultSoundPath());

  handle("themes:listCustom", () => themes.list());
  handle("themes:readTheme", (_e, id: string) => themes.read(String(id)));
  handle("themes:readCustomCss", () => themes.customCss());
  handle("themes:setValues", async (event, id: string, values) => {
    const saved = await themes.saveValues(String(id), values);
    for (const window of BrowserWindow.getAllWindows()) if (window.webContents.id !== event.sender.id) window.webContents.send("themes:changed");
    return saved;
  });
  handle("themes:refresh", () => themes.refresh());
  handle("themes:getDir", () => themes.dir);
  handle("themes:openFolder", async () => {
    const err = await shell.openPath(themes.dir);
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
  const release = library.tryLockPath(clip.path);
  if (!release) throw new Error("This clip is being renamed or deleted. Try again in a moment.");
  try { await exporter.export(clip, project, getSettings().export); }
  finally { release(); }
}

function probeClipTracks(clipId: string): Promise<AudioTrackInfo[]> {
  const clip = library.get(clipId);
  if (!clip) throw new Error("The source clip is no longer in the library");
  const cached = editorProbeCache.get(clipId);
  if (cached?.path === clip.path) return cached.tracks;
  const pending = probeAudioTracks(clip.path).then((probed) => {
    // Configured rows keep stable mix indexes while disabled so live toggles do
    // not restart the ring. Use the same stable row order when naming streams.
    const configuredSources = getSettings().audio.sources.slice(0, 5);
    const nativeCapture = clip.source !== "edited" && clip.importedFrom !== "medal";
    const sourceTracks = nativeCapture && probed.length > 1 ? probed.slice(1) : probed;
    const tracks = sourceTracks.map((track, index) => identifyAudioTrack(track, nativeCapture ? configuredSources[index] : undefined, sourceTracks.length));
    return tracks;
  });
  editorProbeCache.set(clipId, { path: clip.path, tracks: pending });
  void pending.catch(() => editorProbeCache.delete(clipId));
  return pending;
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
  if (!app.isPackaged && process.env.SHARD_DEV_USER_DATA) return;
  app.setLoginItemSettings({
    openAtLogin: s.app.startWithWindows,
    path: process.execPath,
  });
}

async function applySettings(s: Settings): Promise<void> {
  await saveSettings(s);
  if (!shutdown.acceptingWork) return;
  const statuses = hotkeys.apply(s);
  for (const st of statuses) {
    if (!st.ok) toast(`Hotkey ${st.accelerator} failed to register: ${st.error ?? "key in use"}`);
  }
  applyAppSettings(s);
  // Developer console follows the setting: open when enabled, close when off.
  if (s.app.developerConsole && !devConsole.open) devConsole.toggle();
  if (!s.app.developerConsole && devConsole.open) devConsole.close();
  await core.applySettings(s);
  void storage.check();
}

// --------------------------------------------------------------- events ----

function onCoreEvent(type: string, params: Record<string, unknown>): void {
  if (servicesStoppedForUpdate) return;
  win?.webContents.send("core:event", type, params);
  devConsole.feed({ t: Date.now(), level: "event", text: `${type} ${JSON.stringify(params)}` });

  switch (type) {
    case "clip.saved": {
      const p = params as { path: string; requestedSec: number; actualSec: number };
      void trackJob(importClip(p.path));
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
      if (!p.active && p.path) void trackJob(finalizeRecording(p.path));
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
  if (!shutdown.acceptingWork) return;
  const st = (await core.invoke("state.get")) as { recording?: { active?: boolean } };
  if (!shutdown.acceptingWork) return;
  if (st.recording?.active) await core.invoke("recording.stop");
  else await core.invoke("recording.start");
}

async function quit(): Promise<void> {
  app.quit();
}

const jobs = new Set<Promise<unknown>>();
function trackJob<T>(job: Promise<T>): Promise<T> {
  jobs.add(job);
  void job.then(() => jobs.delete(job), () => jobs.delete(job));
  return job;
}
function updateLog(message: string): void {
  updater?.log(message);
}
const shutdown = new ShutdownLifecycle({
  guard: async () => {
    // Gate IPC immediately, and suspend hotkeys so a state.get continuation
    // cannot start a recording while the guard is awaiting its own state.get.
    hotkeys?.suspend();
    let reason: string | null = null;
    try {
      if (exporter?.busy) reason = "Wait for your export to finish before restarting.";
      else if (core?.ready) {
        const state = await core.invoke("state.get", {}, 3000) as { recording?: { active?: boolean } };
        if (state.recording?.active) reason = "Stop your recording before restarting to update.";
      }
      if (!reason && core?.helperExitUnconfirmed)
        throw new Error("A previous capture helper shutdown was not confirmed; restart Shard before installing");
      if (!reason && core?.hasProcess && process.platform === "win32" && !core.supervised)
        throw new Error("Capture supervisor is unavailable; cannot confirm bundled helper exit before installation");
      if (!reason && core?.hasProcess && !core.ready)
        throw new Error("Capture core is disconnected; cannot confirm recording state before installation");
      return reason;
    } catch (error) {
      // If a connected core cannot answer, do not guess that recording is idle.
      throw new Error(`Could not confirm recording state: ${String(error)}`);
    } finally { if (reason) hotkeys?.resume(); }
  },
  cleanup: async update => {
    quitting = true;
    if (update) servicesStoppedForUpdate = true;
    updateLog((update ? "Update" : "Normal") + " shutdown: stopping watchers and hotkeys");
    themes?.close();
    hotkeys?.dispose();
    const storageStopped = storage?.stop();
    exporter?.cancel();
    for (const controller of timelineRequests.values()) controller.abort();
    // Normal quit must still let the core finalize a recording/clip first.
    // Update quit blocks all subsequent spawns before stopping the core.
    if (update) ownedProcesses.pause();
    updateLog("Shutdown: waiting for capture core and its native helpers");
    const errors: unknown[] = [];
    await core?.shutdown(update ? 3000 : 20000).catch(error => errors.push(error));
    if (!update) await bounded("Final recording/import jobs", Promise.allSettled([...jobs]), 15000).catch(error => errors.push(error));
    ownedProcesses.pause();
    updateLog("Shutdown: cancelling bundled media children");
    const previewsStopped = stopEditorPreviews();
    const childrenStopped = ownedProcesses.stop();
    const settled = await Promise.allSettled([childrenStopped, bounded("Timeline preview shutdown", previewsStopped),
      bounded("Storage watchdog shutdown", Promise.resolve(storageStopped))]);
    for (const result of settled) if (result.status === "rejected") errors.push(result.reason);
    updateLog("Shutdown: draining active application jobs");
    await bounded("Application background jobs", Promise.allSettled([...jobs]));
    // No IPC or core event can create new jobs now; all DB users have settled.
    library?.close();
    if (update) libraryClosedForUpdate = !!library;
    editorProbeCache.clear();
    timelineRequests.clear();
    setSoundWindow(null);
    overlay.destroy();
    devConsole.close();
    for (const window of BrowserWindow.getAllWindows()) {
      if (window !== win && !window.isDestroyed()) window.destroy();
    }
    updateLog("Shutdown: database and auxiliary windows closed");
    await bounded("Updater log flush", Promise.resolve(updater?.stop()));
    if (errors.length) throw new AggregateError(errors, "Shutdown could not confirm all subsystem exits");
  },
  recover: async () => {
    // Resume even after partial cleanup (e.g. failed recording-state query).
    ownedProcesses.resume();
    resumeEditorPreviews();
    quitting = false;
    if (servicesStoppedForUpdate) {
      if (libraryClosedForUpdate) {
        library = new Library(app.getPath("userData"));
        storage = new StorageWatchdog(library);
        storage.on("deleted", ({ count, limitGb }) => toast("Deleted " + count + " old clips to stay under your " + limitGb + " GB limit"));
        libraryClosedForUpdate = false;
      }
      await themes?.startWatching().catch(error => updateLog(`Theme watcher recovery failed: ${String(error)}`));
      if (applicationStarted) {
        storage?.start();
        setSoundWindow(win);
        if (!win || win.isDestroyed()) createWindow();
        if (getSettings().app.developerConsole && !devConsole.open) devConsole.toggle();
        await core?.start().catch(error => updateLog(`Capture core recovery failed: ${String(error)}`));
      }
      servicesStoppedForUpdate = false;
    }
    hotkeys?.resume();
    if (applicationStarted) hotkeys?.apply(getSettings());
    updater?.startChecks();
  },
  quit: () => app.quit(),
  log: updateLog,
});
ownedProcesses.setLogger(updateLog);
electronAutoUpdater.on("before-quit-for-update", () => shutdown.beforeUpdaterQuit());
app.on("before-quit", event => {
  quitting = true;
  shutdown.beforeQuit(event);
  if (shutdown.acceptingWork) quitting = false;
});
app.on("window-all-closed", () => {
  // With close-to-tray the window is only hidden, so this only fires when the
  // window really closed (setting off or Quit): shut down fully.
  if (applicationStarted && !quitting && !getSettings().app.minimizeToTray) void quit();
});
app.on("quit", () => {
  if (!quitting) {
    void core?.shutdown();
    library?.close();
  }
});

