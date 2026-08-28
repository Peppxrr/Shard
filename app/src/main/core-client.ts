// core-client.ts — spawns shardcore.exe from resources/core-bin, parses the
// PORT line, and speaks WebSocket JSON-RPC with reconnect+backoff. Core crash
// -> restart up to 5 times, then surface a fatal error state.
import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import { app } from "electron";
import type { Settings } from "../shared/contracts";
import { coreGamePayload, gamesJsonPath, getSettings, seedGamesJson } from "./settings";

const MAX_RESTARTS = 5;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class CoreClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private restarts = 0;
  private shuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stderrBuf = "";
  ready = false;

  get coreBinDir(): string {
    // Dev runner override (scripts/dev.ps1 stages the Debug core here); the
    // packaged app and the e2e/selftest runners never set it.
    if (process.env.CF_CORE_BIN) return process.env.CF_CORE_BIN;
    // Packaged: resources/core-bin; dev: app/resources/core-bin
    const packaged = path.join(process.resourcesPath ?? "", "core-bin");
    const dev = path.join(app.getAppPath(), "resources", "core-bin");
    return existsSync(packaged) ? packaged : dev;
  }

  async start(): Promise<void> {
    await seedGamesJson();
    this.spawnCore();
  }

  private spawnCore(): void {
    const bin = this.coreBinDir;
    const exe = path.join(bin, "shardcore.exe");
    const configDir = path.join(app.getPath("userData"), "core");
    const games = gamesJsonPath();
    const args = ["--config-dir", configDir, "--core-bin", bin, "--games", games, "--port", "0"];
    this.emit("log", "core", `Spawning ${exe} with registry ${games}`);

    this.proc = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc.stdout?.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith("PORT ")) {
          const port = Number(line.slice(5).trim());
          if (port > 0) this.connect(port);
        }
      }
    });
    this.proc.stderr?.on("data", (buf: Buffer) => {
      // Line-buffer: chunks can split mid-line. Lines are forwarded to
      // process.stderr (as before) and re-emitted for the developer console.
      const text = this.stderrBuf + buf.toString("utf8");
      this.stderrBuf = "";
      const lines = text.split(/\r?\n/);
      this.stderrBuf = lines.pop() ?? "";
      for (const line of lines) {
        process.stderr.write(`[core] ${line}\n`);
        this.emit("log", "core", line);
      }
    });
    this.proc.on("exit", (code) => {
      this.ws?.close();
      this.ws = null;
      this.ready = false;
      if (this.shuttingDown) return;
      this.emit("core-exited", code);
      if (this.restarts < MAX_RESTARTS) {
        this.restarts++;
        this.reconnectTimer = setTimeout(() => this.spawnCore(), 1500 * this.restarts);
      } else {
        this.emit("fatal", `Core crashed ${MAX_RESTARTS} times. Restart the app.`);
      }
    });
  }

  private connect(port: number): void {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.restarts = 0;
      this.ready = true;
      this.emit("ready");
      // Push current settings so the core applies them on (re)connect.
      this.applySettings(getSettings());
    });
    ws.addEventListener("message", (ev) => {
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
      this.ready = false;
    });
    ws.addEventListener("error", () => {
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

  invoke(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
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
      }, 20000);
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

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    try {
      await this.invoke("shutdown");
    } catch {
      /* core already gone */
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.proc && !this.proc.killed) {
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          this.proc?.kill("SIGKILL");
          res();
        }, 3000);
        this.proc?.once("exit", () => {
          clearTimeout(t);
          res();
        });
      });
    }
    this.ws?.close();
  }
}

