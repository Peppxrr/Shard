// Main-owned developer console window, retained history, and complete
// per-session output log. The renderer gets text and narrow operations only.
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, type WriteStream } from "node:fs";
import { basename, dirname, join as joinPath, normalize, resolve } from "node:path";
import { format } from "node:util";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { DevConsoleLine } from "../shared/contracts";
import { classifyDevConsoleSeverity } from "../shared/dev-console";

const MAX_HISTORY_LINES = 20_000;
const MAX_PRIOR_SESSIONS = 5;
const MAX_PRIOR_SESSION_BYTES = 100 * 1024 * 1024;
const OVERFLOW_NOTICE_EVERY = 1_000;

interface PriorLog {
  path: string;
  size: number;
  modified: number;
}

function prunePriorSessionLogs(directory: string): void {
  let priorLogs: PriorLog[];
  try {
    priorLogs = readdirSync(directory)
      .filter(name => /^dev-console-.*\.jsonl$/i.test(name))
      .map(name => {
        const filePath = joinPath(directory, name);
        const stat = statSync(filePath);
        return stat.isFile() ? { path: filePath, size: stat.size, modified: stat.mtimeMs } : null;
      })
      .filter((entry): entry is PriorLog => entry !== null)
      .sort((a, b) => b.modified - a.modified);
  } catch {
    return;
  }

  let totalBytes = priorLogs.reduce((sum, entry) => sum + entry.size, 0);
  const skipped: PriorLog[] = [];
  while (priorLogs.length > 0 &&
         (priorLogs.length + skipped.length > MAX_PRIOR_SESSIONS || totalBytes > MAX_PRIOR_SESSION_BYTES)) {
    const oldest = priorLogs.pop()!;
    try {
      unlinkSync(oldest.path);
      totalBytes -= oldest.size;
    } catch {
      // An in-use/locked log stays in place; continue pruning any other older
      // file rather than preventing the console from starting.
      skipped.push(oldest);
    }
  }
}

function normalizedPath(filePath: string): string {
  const value = normalize(resolve(filePath));
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function isSameFile(left: string, right: string): boolean {
  if (normalizedPath(left) === normalizedPath(right)) return true;
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    if (leftStat.ino !== 0 && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) return true;
  } catch {
    // The selected destination may not exist yet.
  }
  try {
    return normalizedPath(realpathSync.native(left)) === normalizedPath(realpathSync.native(right));
  } catch {
    return false;
  }
}

export class DevConsole {
  private win: BrowserWindow | null = null;
  private history: DevConsoleLine[] = [];
  private sequence = 0;
  private dropped = 0;
  private lastOverflowNotice = 0;
  private logStream: WriteStream | null = null;
  private sessionLogPath: string | null = null;
  private sessionLogBytes = 0;
  private logFailure: Error | null = null;

  constructor() {
    this.startSessionLog();

    ipcMain.handle("devconsole:history", event => {
      this.assertConsoleRequest(event);
      return this.historySnapshot();
    });
    ipcMain.handle("devconsole:clear", event => {
      this.assertConsoleRequest(event);
      this.history = [];
      this.dropped = 0;
      this.lastOverflowNotice = 0;
      return this.sequence;
    });
    ipcMain.handle("devconsole:export", async event => {
      this.assertConsoleRequest(event);
      return this.exportSessionLog();
    });

    if (this.logFailure) {
      this.feed({
        t: Date.now(),
        level: "app",
        severity: "error",
        text: `Full-session logging is unavailable: ${this.logFailure.message}`,
      });
    }

    this.captureApplicationConsole();
    app.once("will-quit", () => this.logStream?.end());
  }

  get open(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  // The current session log up to its last complete record, for bundles.
  async sessionSnapshot(): Promise<{ path: string; bytes: number } | null> {
    if (!this.sessionLogPath) return null;
    try {
      return { path: this.sessionLogPath, bytes: await this.flushSessionLog() };
    } catch {
      return null;
    }
  }

  // Earlier sessions' logs, newest first (each app launch writes one).
  priorSessionLogs(): string[] {
    if (!this.sessionLogPath) return [];
    const directory = dirname(this.sessionLogPath);
    try {
      return readdirSync(directory)
        .filter(name => /^dev-console-.*\.jsonl$/i.test(name))
        .map(name => joinPath(directory, name))
        .filter(file => !isSameFile(file, this.sessionLogPath!))
        .map(file => ({ file, modified: statSync(file).mtimeMs }))
        .sort((a, b) => b.modified - a.modified)
        .map(entry => entry.file);
    } catch {
      return [];
    }
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
      width: 980,
      height: 620,
      minWidth: 560,
      minHeight: 320,
      title: "Shard Developer Console",
      backgroundColor: "#0b0d12",
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

  // Bounded in-memory history serves the live UI; every accepted line is also
  // written to the current session's JSONL file for complete export.
  feed(line: DevConsoleLine): void {
    line = {
      ...line,
      id: ++this.sequence,
      severity: line.severity ?? classifyDevConsoleSeverity(line.text, line.stream),
    };
    if (this.logStream && !this.logFailure) {
      try {
        const record = `${JSON.stringify(line)}\n`;
        this.logStream.write(record);
        this.sessionLogBytes += Buffer.byteLength(record, "utf8");
      } catch (error) {
        this.handleLogFailure(error);
      }
    }

    this.history.push(line);
    if (this.history.length > MAX_HISTORY_LINES) {
      const excess = this.history.length - MAX_HISTORY_LINES;
      this.history.splice(0, excess);
      this.dropped += excess;
    }
    if (!this.open) return;
    this.win?.webContents.send("devconsole:line", line);
    if (this.dropped > 0 && (this.dropped === 1 || this.dropped - this.lastOverflowNotice >= OVERFLOW_NOTICE_EVERY)) {
      this.lastOverflowNotice = this.dropped;
      this.win?.webContents.send("devconsole:line", this.overflowNotice());
    }
  }

  private startSessionLog(): void {
    try {
      const directory = joinPath(app.getPath("userData"), "logs", "developer-console");
      mkdirSync(directory, { recursive: true });
      prunePriorSessionLogs(directory);
      const started = new Date().toISOString().replace(/[:.]/g, "-");
      const path = joinPath(directory, `dev-console-${started}-${process.pid}.jsonl`);
      this.logStream = createWriteStream(path, { flags: "wx" });
      this.sessionLogPath = path;
      this.logStream.on("error", error => this.handleLogFailure(error));
    } catch (error) {
      this.logFailure = error instanceof Error ? error : new Error(String(error));
    }
  }

  private captureApplicationConsole(): void {
    const levels = [
      ["log", "info"],
      ["debug", "debug"],
      ["info", "info"],
      ["warn", "warn"],
      ["error", "error"],
    ] as const;
    for (const [method, severity] of levels) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        original(...args);
        try {
          this.feed({ t: Date.now(), level: "app", severity, text: format(...args) });
        } catch {
          // Logging must never change the behavior of the original console call.
        }
      };
    }
  }

  private handleLogFailure(value: unknown): void {
    if (this.logFailure) return;
    this.logFailure = value instanceof Error ? value : new Error(String(value));
    this.logStream = null;
    // Keep the warning in memory and broadcast it, without trying to write the
    // failure report back to the stream that just failed.
    const line: DevConsoleLine = {
      id: ++this.sequence,
      t: Date.now(),
      level: "app",
      severity: "error",
      text: `Full-session logging stopped; export is incomplete: ${this.logFailure.message}`,
    };
    this.history.push(line);
    if (this.history.length > MAX_HISTORY_LINES) {
      this.history.splice(0, this.history.length - MAX_HISTORY_LINES);
      this.dropped++;
    }
    if (this.open) this.win?.webContents.send("devconsole:line", line);
  }

  private assertConsoleRequest(event: Electron.IpcMainInvokeEvent): void {
    if (!this.win || event.sender !== this.win.webContents || event.senderFrame !== this.win.webContents.mainFrame) {
      throw new Error("This operation is only available in the developer console.");
    }
  }

  private historySnapshot(): DevConsoleLine[] {
    return this.dropped > 0 ? [this.overflowNotice(), ...this.history] : this.history;
  }

  private overflowNotice(): DevConsoleLine {
    return {
      id: 0,
      t: this.history[0]?.t ?? Date.now(),
      level: "app",
      severity: "warn",
      text: `The in-memory history limit removed ${this.dropped.toLocaleString()} older lines. Export the full session log to include all output since launch.`,
    };
  }

  private async flushSessionLog(): Promise<number> {
    if (this.logFailure) throw new Error(`The full-session log is incomplete: ${this.logFailure.message}`);
    const stream = this.logStream;
    if (!stream || !this.sessionLogPath) throw new Error("Full-session logging is unavailable.");
    // Every feed call enqueues exactly one complete JSONL record. Snapshot the
    // accepted byte count before placing the flush barrier so later writes can
    // never move the export boundary, even if the OS has already written part
    // of a later chunk when the barrier callback runs.
    const snapshotBytes = this.sessionLogBytes;
    return new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => stream.removeListener("error", onError);
      stream.once("error", onError);
      stream.write("", error => {
        cleanup();
        if (error) reject(error);
        else if (this.logFailure) reject(this.logFailure);
        else resolve(snapshotBytes);
      });
    });
  }

  private async exportSessionLog(): Promise<string | null> {
    const started = new Date().toISOString().replace(/[:.]/g, "-");
    const defaultPath = joinPath(app.getPath("documents"), `Shard-developer-console-${started}.jsonl`);
    const options = {
      title: "Export full developer console session",
      defaultPath,
      buttonLabel: "Export log",
      filters: [{ name: "JSON Lines log", extensions: ["jsonl"] }],
    };
    const owner = this.win && !this.win.isDestroyed() ? this.win : null;
    if (!owner) throw new Error("The developer console window was closed before export completed.");
    const result = await dialog.showSaveDialog(owner, options);
    if (result.canceled || !result.filePath) return null;
    try {
      const source = this.sessionLogPath!;
      if (!source) throw new Error("Full-session logging is unavailable.");
      if (isSameFile(source, result.filePath)) {
        throw new Error("Choose a different file so the active developer console session remains intact.");
      }

      // Wait until the save dialog has returned so output generated while it
      // was open is included. The size is captured at a complete record
      // boundary; later appends cannot extend this export snapshot.
      const size = await this.flushSessionLog();
      const destination = resolve(result.filePath);
      const temporary = joinPath(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
      try {
        if (size === 0) {
          await new Promise<void>((resolveEmpty, reject) => {
            const target = createWriteStream(temporary, { flags: "wx" });
            target.once("error", reject);
            target.end(resolveEmpty);
          });
        } else {
          await pipeline(
            createReadStream(source, { start: 0, end: size - 1 }),
            createWriteStream(temporary, { flags: "wx" }),
          );
        }
        renameSync(temporary, destination);
      } catch (error) {
        try { unlinkSync(temporary); } catch { /* no temp file remains */ }
        throw error;
      }
      return result.filePath;
    } catch (error) {
      throw new Error(`Could not export the full-session log: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
