import { app, ipcMain, shell, type BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { autoUpdater } from "electron-updater";
import { UpdateController } from "./update-controller";

export function registerUpdater(options: {
  window: () => BrowserWindow | null;
  prepareInstall: () => Promise<string | null>;
  installFailed: () => void;
}): void {
  const portable = !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
  const supported = app.isPackaged && process.platform === "win32";
  // An extracted win-unpacked directory is not an NSIS installation either.
  const installed = supported && !portable && existsSync(path.join(path.dirname(app.getPath("exe")), "Uninstall Shard.exe"));
  const controller = new UpdateController({
    currentVersion: app.getVersion(), mode: !supported ? "disabled" : installed ? "installed" : "portable",
    disabledMessage: !app.isPackaged ? "Updates are disabled in development builds." : !supported ? "In-app updates are currently available on Windows only." : undefined,
    backend: supported ? autoUpdater : null,
    publish: state => {
      const win = options.window();
      if (win && !win.isDestroyed()) win.webContents.send("updates:state", state);
    },
    prepareInstall: options.prepareInstall, installFailed: options.installFailed,
    openExternal: url => shell.openExternal(url),
  });
  const actions = {
    "updates:state": () => controller.getState(),
    "updates:check": () => controller.check(),
    "updates:download": () => controller.download(),
    "updates:install": () => controller.install(),
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
}
