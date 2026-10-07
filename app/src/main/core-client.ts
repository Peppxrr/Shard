// core-client.ts — spawns shardcore.exe from resources/core-bin, parses the
// PORT line, and speaks WebSocket JSON-RPC with reconnect+backoff. Core crash
// -> restart up to 5 times, then surface a fatal error state.
import { type ChildProcess } from "node:child_process";
import { spawn, bounded, ownedProcesses } from "./bundled-processes";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import { app } from "electron";
import type { Settings } from "../shared/contracts";
import { classifyDevConsoleSeverity, type DevConsoleStream } from "../shared/dev-console";
import { coreGamePayload, gamesJsonPath, getSettings, seedGamesJson } from "./settings";
import { CoreLineDecoder } from "./core-line-decoder";

const MAX_RESTARTS = 5;
// shardcore --priority-bridge exits with this code when the elevated task is
// unusable; the core is then started normally right away.
const PRIORITY_FALLBACK_EXIT = 124;

export interface CoreClientOptions {
  // Start through the Recording priority bridge (elevated core) when true.
  priorityLaunch?: () => boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class CoreClient extends EventEmitter {
  private readonly options: CoreClientOptions;
  // A failed elevated start falls back to the normal core until the next
  // explicit restart (e.g. after Recording priority is re-enabled).
  private priorityUnavailable = false;
  launchMode: "normal" | "priority" = "normal";
  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private restarts = 0;
  private shuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private lastPort?: number;
  helperExitUnconfirmed = false;
  supervised = false;
  get hasProcess(): boolean { return this.proc !== null; }
  ready = false;

  constructor(options: CoreClientOptions = {}) {
    super();
    this.options = options;
  }

  // Ordered stop and start, e.g. to switch between normal and elevated cores.
  async restart(): Promise<void> {
    await this.shutdown();
    this.restarts = 0;
    this.priorityUnavailable = false;
    await this.start();
  }

  get coreBinDir(): string {
    // Dev runner override (scripts/dev.ps1 stages the Debug core here); the
    // packaged app and the e2e/selftest runners never set it.
    if (process.env.CF_CORE_BIN) return process.env.CF_CORE_BIN;
    // Packaged: resources/core-bin; dev: app/resources/core-bin
    const packaged = path.join(process.resourcesPath ?? "", "core-bin");
    const dev = path.join(app.getAppPath(), "resources", "core-bin");
    return existsSync(packaged) ? packaged : dev;
  }

  // Paths every core launch uses; the Recording priority task bakes in the
  // same values, so they must stay identical.
  get launchPaths(): { bin: string; configDir: string; games: string } {
    return { bin: this.coreBinDir, configDir: path.join(app.getPath("userData"), "core"), games: gamesJsonPath() };
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.proc) {
      if (!this.shuttingDown) return Promise.resolve();
      // A timed-out shutdown must not leave the surviving core permanently
      // disconnected, or spawn another core alongside it.
      this.shuttingDown = false;
      this.shutdownPromise = null;
      if (this.lastPort) this.connect(this.lastPort);
      return Promise.resolve();
    }
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.supervised = false;
    this.starting = seedGamesJson().then(() => { if (!this.shuttingDown) this.spawnCore(); })
      .finally(() => { this.starting = null; });
    return this.starting;
  }

  private spawnCore(): void {
    this.reconnectTimer = null;
    if (this.shuttingDown || this.proc) return;
    const { bin, configDir, games } = this.launchPaths;
    const exe = path.join(bin, "shardcore.exe");
    const args = ["--config-dir", configDir, "--core-bin", bin, "--games", games, "--port", "0"];
    const priority = process.platform === "win32" && !this.priorityUnavailable && (this.options.priorityLaunch?.() ?? false);
    this.launchMode = priority ? "priority" : "normal";
    this.emit("log", "core", `Spawning ${exe}${priority ? " through the Recording priority task" : ""} with registry ${games}`);

    this.supervised = false;
    this.lastPort = undefined;
    this.proc = spawn(exe, priority ? ["--priority-bridge", ...args] : args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    if (process.platform === "win32") ownedProcesses.awaitOnly(this.proc);
    const proc = this.proc;
    const stdout = new CoreLineDecoder(line => {
      if (line === "SUPERVISOR READY") this.supervised = true;
      if (line.startsWith("PRIORITY FALLBACK ")) this.emit("priority-fallback", line.slice("PRIORITY FALLBACK ".length).trim());
      this.emitCoreOutput(line, "stdout");
      // Keep the first stdout PORT line visible while still consuming it as
      // the WebSocket handshake value.
      if (line.startsWith("PORT ")) {
        const port = Number(line.slice(5).trim());
        if (port > 0 && !this.shuttingDown) this.connect(port);
      }
    });
    const stderr = new CoreLineDecoder(line => {
      process.stderr.write(`[core] ${line}\n`);
      this.emitCoreOutput(line, "stderr");
    });
    const stdoutStream = this.proc.stdout;
    const stderrStream = this.proc.stderr;
    stdoutStream?.on("data", (buf: Buffer) => stdout.push(buf));
    stderrStream?.on("data", (buf: Buffer) => stderr.push(buf));
    stdoutStream?.on("error", error => {
      this.emit("log", "core", `Core stdout stream error: ${error.message}`, { stream: "stdout", severity: "error" });
    });
    stderrStream?.on("error", error => {
      this.emit("log", "core", `Core stderr stream error: ${error.message}`, { stream: "stderr", severity: "error" });
    });
    this.proc.on("error", error => {
      const text = `Core process error: ${error.message}`;
      process.stderr.write(`[core] ${text}\n`);
      this.emit("log", "core", text, { stream: "stderr", severity: "error" });
    });
    // `close` follows the stdio streams, so finish() sees every last byte.
    // This also covers spawn failures, where Node emits `error` and `close`
    // without an `exit` event.
    this.proc.on("close", (code, signal) => {
      if (process.platform === "win32" && code === 125) this.helperExitUnconfirmed = true;
      if (this.proc === proc) this.proc = null;
      stdout.finish();
      stderr.finish();
      this.ws?.close();
      this.ws = null;
      this.ready = false;
      if (this.shuttingDown) return;
      if (priority && code === PRIORITY_FALLBACK_EXIT) {
        // Not a crash: the elevated task is unavailable. Start normally now.
        this.priorityUnavailable = true;
        this.spawnCore();
        return;
      }
      this.emit("core-exited", code, signal);
      if (this.restarts < MAX_RESTARTS) {
        this.restarts++;
        this.reconnectTimer = setTimeout(() => this.spawnCore(), 1500 * this.restarts);
      } else {
        this.emit("fatal", `Core crashed ${MAX_RESTARTS} times. Restart the app.`);
      }
    });
  }

  private emitCoreOutput(text: string, stream: DevConsoleStream): void {
    this.emit("log", "core", text, {
      stream,
      severity: classifyDevConsoleSeverity(text, stream),
    });
  }

  private connect(port: number): void {
    if (this.shuttingDown) return;
    this.lastPort = port;
    this.ws?.close();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.shuttingDown || this.ws !== ws) { ws.close(); return; }
      this.restarts = 0;
      this.ready = true;
      this.emit("ready");
      // Push current settings so the core applies them on (re)connect.
      this.applySettings(getSettings());
    });
    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws) return;
      let msg: { id?: number; method?: string; params?: unknown; error?: { code: number; message: string }; result?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          this.emit("log", "rpc", `RPC error ${msg.error.code}: ${msg.error.message}`);
          p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        }
        else p.resolve(msg.result);
      } else if (msg.method) {
        this.emit("event", msg.method, msg.params ?? {});
      }
    });
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ready = false;
    });
    ws.addEventListener("error", () => {
      if (this.ws !== ws) return;
      // Reconnect loop handled by the core-exit path; a WS error without a
      // core exit means the core is up but the socket failed — retry.
      if (!this.shuttingDown && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (this.ws) this.connect(port);
        }, 1000);
      }
    });
  }

  invoke(method: string, params: Record<string, unknown> = {}, timeoutMs = 20000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.emit("log", "rpc", `RPC rejected (core not connected): ${method}`);
        reject(new Error("core not connected"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.emit("log", "rpc", `RPC timeout: ${method}`);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async applySettings(s: Settings): Promise<void> {
    if (!this.ready) return;
    try {
      await this.invoke("config.set", {
        ...this.settingsSlice(s),
      });
    } catch (e) {
      this.emit("event", "error", { message: `config.set failed: ${(e as Error).message}` });
    }
  }

  private settingsSlice(s: Settings): Record<string, unknown> {
    return {
      capture: s.capture,
      video: s.video,
      replay: s.replay,
      game: coreGamePayload(s).game,
      audio: { sources: s.audio.sources },
      storage: { limitGb: s.storage.limitGb, clipsDir: s.storage.clipsDir },
    };
  }

  shutdown(rpcTimeout = 20000): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.shutdownPromise = this.stopCore(rpcTimeout).catch(error => {
      this.shutdownPromise = null; // A failed wait can be retried against the same handle.
      throw error;
    });
    return this.shutdownPromise;
  }

  private async stopCore(rpcTimeout: number): Promise<void> {
    await this.starting;
    const proc = this.proc;
    // Attach before the RPC: the core may exit before replying to shutdown.
    let onClose: (() => void) | undefined;
    const closed = proc ? new Promise<void>(resolve => {
      onClose = resolve;
      proc.once("close", onClose);
    }) : Promise.resolve();
    try {
      if (proc) {
        if (this.ready) await this.invoke("shutdown", {}, rpcTimeout).catch(() => {});
        try { await bounded("Capture core graceful shutdown", closed, 3000); }
        catch {
          // The Windows supervisor terminates its Job Object, then waits for
          // ALL native descendants before exiting. Do not kill the supervisor.
          if (process.platform === "win32" && this.supervised) {
            if (!proc.stdin || proc.stdin.destroyed) throw new Error("Capture supervisor control pipe is unavailable");
            proc.stdin.on("error", () => {});
            proc.stdin.write("terminate\n");
          } else proc.kill("SIGKILL");
          await bounded("Capture core and bundled helper exit", closed, 8000);
        }
        if (process.platform === "win32" && proc.exitCode === 125) {
          this.helperExitUnconfirmed = true;
          throw new Error("Capture supervisor could not confirm bundled helper exit; refusing installation");
        }
      }
    } finally {
      if (proc && onClose) proc.removeListener("close", onClose);
      this.ready = false;
      this.ws?.close();
      this.ws = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Capture core shut down"));
      }
      this.pending.clear();
    }
  }
}
