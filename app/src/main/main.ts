// main.ts — Electron main process: core lifecycle, settings, hotkeys, library,
// storage watchdog, exports, tray, IPC.
import { app, BrowserWindow, ipcMain, shell, Notification, Tray, Menu, nativeImage } from "electron";
import type { NativeImage } from "electron";
import { join as joinPath } from "node:path";

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
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { CoreClient } from "./core-client";
import { loadSettings, getSettings, saveSettings, seedGamesJson } from "./settings";
import { HotkeyManager } from "./hotkeys";
import { Library, clipsDir } from "./library";
import { StorageWatchdog } from "./storage";
import { ExportManager } from "./export";
import { ffprobe, remuxToMp4, probeAudioTracks } from "./ffmpeg";
import type { ClipRecord, ExportProgress, Settings } from "../shared/contracts";



let win: BrowserWindow | null = null;
let core: CoreClient;
let hotkeys: HotkeyManager;
let library: Library;
let storage: StorageWatchdog;
let exporter: ExportManager;
let tray: Tray | null = null;
let quitting = false;
let coreFatal: string | null = null;
const pendingSegments = new Map<string, { start: number; end: number }[]>();
const pendingTracks = new Map<string, number[]>();

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
    console.error("clipforge main failed:", e);
    app.exit(1);
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  app.setAppUserModelId("com.shard.app");

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
  core.on("fatal", (msg: string) => {
    coreFatal = msg;
    toast(msg);
  });

  hotkeys = new HotkeyManager(core);

  createWindow();
  registerIpc();
  setupTray();
  applyAppSettings(getSettings());

  await core.start();
  hotkeys.apply(getSettings());
}

// ---------------------------------------------------------------- window ----

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: "Shard",
    backgroundColor: "#0f1115",
    icon: appIcon(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide(); // close-to-tray
    }
  });

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
  ipcMain.handle("library:tracks", (_e, filePath: string) => probeAudioTracks(filePath));

  // Windows drag-out: renderer dragstart hands us the file + icon; Electron's
  // webContents.startDrag hands the native drag to Explorer/Discord/etc.
  ipcMain.on("drag:start", (_e, filePath: string, iconPath?: string) => {
    if (!win) return;
    const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    win.webContents.startDrag({ file: filePath, icon: icon.isEmpty() ? nativeImage.createEmpty() : icon });
  });

  ipcMain.handle("export:start", (_e, clipId: string) => doExport(clipId));
  ipcMain.handle("export:cancel", () => exporter.cancel());
  // The editor sends its retained segments before starting an export.
  ipcMain.on("export:segments", (_e, clipId: string, segments: { start: number; end: number }[], tracks?: number[]) => {
    pendingSegments.set(clipId, segments);
    pendingTracks.set(clipId, tracks ?? [0]);
  });

  ipcMain.handle("app:version", () => app.getVersion());

  ipcMain.on("shell:reveal", (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.on("shell:open", (_e, p: string) => shell.openPath(p).catch(() => {}));
}

async function doExport(clipId: string): Promise<void> {
  const clip = library.get(clipId);
  if (!clip) throw new Error("clip not found");
  // Default: whole clip (the editor sends retained segments first).
  const segs = (pendingSegments.get(clipId) ?? [{ start: 0, end: clip.durationMs / 1000 }]);
  const tracks = pendingTracks.get(clipId) ?? [0];
  pendingSegments.delete(clipId);
  pendingTracks.delete(clipId);
  await exporter.export(clip, segs, getSettings().export, tracks);
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
  core.applySettings(s);
  void storage.check();
}

// --------------------------------------------------------------- events ----

function onCoreEvent(type: string, params: Record<string, unknown>): void {
  win?.webContents.send("core:event", type, params);

  switch (type) {
    case "clip.saved": {
      const p = params as { path: string; requestedSec: number; actualSec: number };
      importClip(p.path);
      const label = savedLabel(p.requestedSec);
      const style = getSettings().app.notificationStyle;
      const windowHidden = !win || win.isMinimized() || !win.isFocused();
      if (style === "overlay") {
        toast(label);
      } else if (style === "windows") {
        if (windowHidden) new Notification({ title: "Shard", body: label }).show();
        else toast(label);
      }
      // "off": no feedback.
      break;
    }
    case "recording.state": {
      const p = params as { active: boolean; path: string };
      if (!p.active && p.path) void finalizeRecording(p.path);
      break;
    }
    case "game.changed": {
      const p = params as { known: boolean; name: string | null; exe: string };
      lastGame = p.known ? p.name : null;
      if (p.known && p.name) toast(`🎮 Detected: ${p.name}`);
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

function importClip(file: string): void {
  // Core produces mp4 directly (verify with ffprobe; remux if it somehow is
  // not mp4 — e.g. muxer misbehaved).
  const game = lastGame;
  const final = file;
  if (!file.toLowerCase().endsWith(".mp4")) {
    const fixed = file.replace(/\.\w+$/, ".mp4");
    remuxToMp4(file, fixed);
    existsSync(file) && unlinkSync(file);
  }
  const rec = library.importMp4(final, "clip", game);
  win?.webContents.send("library:added", rec);
  void storage.check();
}

async function finalizeRecording(mp4: string): Promise<void> {
  // The core now records fragmented mp4 directly; just probe + import.
  try {
    const rec = library.importMp4(mp4, "recording", lastGame);
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
  await core.shutdown();
  library.close();
  app.quit();
}

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => {
  // Keep running in tray.
});
app.on("quit", () => {
  if (!quitting) {
    void core?.shutdown();
    library?.close();
  }
});

