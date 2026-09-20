// dev-console.ts — Developer Console: a separate window streaming core
// stderr, RPC failures, and key core events live. Toggled by the
// app.developerConsole setting; the renderer shows a bottom-right indicator
// while enabled. The console window reuses the renderer bundle (loaded with
// the #console hash, which renders the DevConsole component instead of App).
import { BrowserWindow, ipcMain } from "electron";
import { join as joinPath } from "node:path";
import type { DevConsoleLine } from "../shared/contracts";

export class DevConsole {
  private win: BrowserWindow | null = null;
  private history: DevConsoleLine[] = [];
  private sequence = 0;

  constructor() {
    ipcMain.handle("devconsole:history", event => {
      if (!this.win || event.sender !== this.win.webContents || event.senderFrame !== this.win.webContents.mainFrame)
        throw new Error("Console history is only available in the developer console.");
      return this.history;
    });
  }

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

  // A bounded buffer retains updater/startup diagnostics before the console opens.
  feed(line: DevConsoleLine): void {
    line = { ...line, id: ++this.sequence };
    this.history.push(line);
    if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
    if (!this.open) return;
    this.win?.webContents.send("devconsole:line", line);
  }
}
