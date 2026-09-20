import { app, BrowserWindow, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { autoUpdater } from "electron-updater";
import { UpdateController } from "./update-controller";
import { UpdateCache, UpdatePreferencesFile, versionAtLeast } from "./update-storage";
import { createUpdateLog } from "./update-log";
import type { DevConsoleLine } from "../shared/contracts";

const CHECK_INTERVAL = 12 * 60 * 60 * 1000;

export function registerUpdater(options: {
  window: () => BrowserWindow | null;
  prepareInstall: () => Promise<string | null>;
  installFailed: () => void;
  log: (line: DevConsoleLine) => void;
}) {
  const portable = !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
  const supported = app.isPackaged && process.platform === "win32";
  const installed = supported && !portable && existsSync(path.join(path.dirname(app.getPath("exe")), "Uninstall Shard.exe"));
  const preferences = new UpdatePreferencesFile(path.join(app.getPath("userData"), "updates.json"));
  const logger = createUpdateLog(path.join(app.getPath("userData"), "logs"), options.log);
  // Do not carry the installer's inherited presentation flag into later updates.
  delete process.env.SHARD_UPDATE_ON_LAUNCH;
  // This stable cache name is checked against packaged app-update.yml.
  const cache = new UpdateCache(path.join(process.env.LOCALAPPDATA || path.join(app.getPath("appData"), "../Local"), "shard-updater"), logger.info);
  let splash: BrowserWindow | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  let startupInstall = false;
  const controller = new UpdateController({
    currentVersion: app.getVersion(), mode: !supported ? "disabled" : installed ? "installed" : "portable",
    disabledMessage: !app.isPackaged ? "Updates are disabled in development builds." : !supported ? "In-app updates are currently available on Windows only." : undefined,
    backend: supported ? autoUpdater : null,
    ...preferences.value,
    saveChoice: choice => preferences.save({ ...preferences.value, ...choice }),
    log: logger.info,
    beforeDownload: () => cache.preserveBaseline(),
    afterDownload: () => cache.restoreBaseline(),
    beforeInstall: async () => {
      // Consume the next-launch choice before execution, avoiding automatic
      // installer loops if Windows blocks or interrupts installation.
      preferences.save({ ...preferences.value, scheduledVersion: undefined, attemptedVersion: controller.getState().version });
      if (startupInstall) process.env.SHARD_UPDATE_ON_LAUNCH = "1";
      await logger.flush();
    },
    publish: state => {
      const win = options.window();
      if (win && !win.isDestroyed()) win.webContents.send("updates:state", state);
      if (splash && !splash.isDestroyed()) {
        const message = state.status === "installing" ? "Installing update…" : state.status === "downloading" ? "Verifying your downloaded update…" : "Preparing your update…";
        void splash.webContents.executeJavaScript(`document.getElementById('status').textContent = ${JSON.stringify(message)}`).catch(() => {});
      }
    },
    prepareInstall: options.prepareInstall,
    installFailed: () => { delete process.env.SHARD_UPDATE_ON_LAUNCH; options.installFailed(); },
    openExternal: url => shell.openExternal(url),
  });
  if (supported) autoUpdater.logger = {
    ...logger,
    error: (...values: unknown[]) => {
      logger.error(...values);
      if (values.some(value => /fallback to full download/i.test(String(value)))) controller.useFullDownload();
    },
  };
  const actions = {
    "updates:state": () => controller.getState(),
    "updates:check": () => controller.check(),
    "updates:download": () => controller.download(),
    "updates:install": () => controller.install(),
    "updates:schedule": () => controller.schedule(),
    "updates:unschedule": () => controller.unschedule(),
    "updates:dismiss": () => controller.dismiss(),
    "updates:release": () => controller.openRelease(),
  };
  for (const [channel, action] of Object.entries(actions)) {
    ipcMain.handle(channel, event => {
      const win = options.window();
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
        throw new Error("Update request is not allowed from this window.");
      return action();
    });
  }

  return {
    // Before opening the library or starting capture. A regular launch never
    // waits for network; only an explicitly scheduled update does.
    async beforeLaunch(): Promise<boolean> {
      logger.info(`Starting Shard ${app.getVersion()} (${controller.getState().mode})`);
      if (!installed) return false;
      try {
        let cleaned = await cache.recover(app.getVersion());
        const installerLog = path.join(app.getPath("userData"), "logs", "install.log");
        const installText = await readFile(installerLog, "utf8").catch(() => "");
        if (installText) {
          logger.info(`Last installer activity:\n${installText.slice(-4000).trim()}`);
          if (installText.length > 128 * 1024) await rename(installerLog, `${installerLog}.1`).catch(logger.warn);
        }
        const attempted = preferences.value.attemptedVersion;
        if (attempted) {
          // NSIS starts the new app just before its own process exits. Give
          // Windows a bounded chance to release pending files/cache handles.
          if (versionAtLeast(app.getVersion(), attempted) && !cleaned) {
            for (let retry = 0; retry < 3 && !cleaned; retry++) {
              await new Promise(resolve => setTimeout(resolve, 500));
              cleaned = await cache.recover(app.getVersion());
            }
          }
          logger.info(versionAtLeast(app.getVersion(), attempted) ? `Update ${attempted} installed successfully` : `Previous installation of ${attempted} did not complete; continuing without retrying automatically`);
          preferences.save({ ...preferences.value, attemptedVersion: undefined });
        }
        const scheduled = preferences.value.scheduledVersion;
        if (!scheduled) return false;
        if (versionAtLeast(app.getVersion(), scheduled)) { controller.unschedule(); return false; }
        splash = createUpdateSplash();
        // Recheck trusted release metadata, then let electron-updater verify
        // cached bytes against SHA-512. Never execute a persisted path.
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const checked = await Promise.race([
          controller.check(true).then(() => true),
          new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), 12000); }),
        ]);
        clearTimeout(timeout);
        if (!checked || controller.getState().version !== scheduled || controller.getState().status !== "available") {
          logger.info("Scheduled update could not be confirmed; continuing startup and retaining the next-launch choice");
          return false;
        }
        if (!await cache.verifyPending(scheduled)) {
          logger.warn("Scheduled download is missing or damaged; download it again in Settings");
          controller.unschedule();
          return false;
        }
        await controller.download();
        if (controller.getState().status !== "downloaded") return false;
        startupInstall = true;
        await controller.install();
        return controller.getState().status === "installing";
      } catch (error) { logger.error("Startup update failed; continuing normal startup", error); return false; }
      finally { startupInstall = false; splash?.destroy(); splash = null; }
    },
    startChecks(): void {
      if (!supported || interval) return;
      if (!controller.getState().lastCheckedAt) void controller.check(true);
      interval = setInterval(() => void controller.check(true), CHECK_INTERVAL);
      interval.unref();
    },
    async stop(): Promise<void> { clearInterval(interval); await logger.flush(); },
  };
}

function createUpdateSplash(): BrowserWindow {
  const win = new BrowserWindow({ width: 420, height: 228, frame: false, resizable: false, show: false,
    title: "Updating Shard", backgroundColor: "#12151c",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.once("ready-to-show", () => win.show());
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Updating Shard</title>
    <style>body{margin:0;padding:32px;background:#12151c;color:#edf0f7;font:14px 'Segoe UI',sans-serif;border:1px solid #272d38;height:226px;box-sizing:border-box}header{font-size:22px;font-weight:650;letter-spacing:-.5px}header span{color:#74a8ff}p{color:#b1bacf;margin:20px 0 16px}progress{width:100%;height:5px;accent-color:#74a8ff}small{display:block;color:#929db1;margin-top:14px;font-size:12px}</style>
    <header><span>◆</span> Shard</header><p id="status" role="status">Preparing your update…</p><progress aria-label="Updating Shard"></progress><small>Shard will open as soon as the update is ready.</small>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}
