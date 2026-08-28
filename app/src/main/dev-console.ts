// dev-console.ts — Developer Console: a separate window streaming core
// stderr, RPC failures, and key core events live. Toggled by the
// app.developerConsole setting; the renderer shows a bottom-right indicator
// while enabled. The console window reuses the renderer bundle (loaded with
// the #console hash, which renders the DevConsole component instead of App).
import { BrowserWindow } from "electron";
import { join as joinPath } from "node:path";
import type { DevConsoleLine } from "../shared/contracts";

export class DevConsole {
  private win: BrowserWindow | null = null;

  get open(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  // Returns the new open state.
  toggle(): boolean {
    if (this.open) {
      this.close();
      return false;
    }
    this.openWindow();
    return true;
  }

  private openWindow(): void {
    if (this.open) return;
    this.win = new BrowserWindow({
      width: 780,
      height: 440,
      minWidth: 520,
      minHeight: 240,
      title: "Shard Developer Console",
      backgroundColor: "#0b0e14",
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: joinPath(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.win.once("ready-to-show", () => this.win?.show());
    this.win.on("closed", () => { this.win = null; });
    if (process.env.VITE_DEV_SERVER_URL) {
      void this.win.loadURL(process.env.VITE_DEV_SERVER_URL + "#console");
    } else {
      void this.win.loadFile(joinPath(__dirname, "../../renderer/index.html"), { hash: "console" });
    }
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  // Feed one line; no-op while the console is closed.
  feed(line: DevConsoleLine): void {
    if (!this.open) return;
    this.win?.webContents.send("devconsole:line", line);
  }
}
