import { spawn as nativeSpawn, spawnSync as nativeSpawnSync, type ChildProcess } from "node:child_process";

export async function bounded<T>(label: string, operation: Promise<T>, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Track owned handles, never process names. `close` also covers spawn failure
// and waits for stdio handles; kill() returning true does not prove exit.
export class OwnedProcesses {
  private children = new Map<ChildProcess, { executable: string; closed: Promise<void>; terminate: boolean }>();
  private stopped = false;
  private log: (message: string) => void = () => {};
  setLogger(log: (message: string) => void): void { this.log = log; }
  get size(): number { return this.children.size; }
  assertRunning(): void { if (this.stopped) throw new Error("Shard is preparing to shut down; new child processes are disabled"); }
  pause(): void { this.stopped = true; }
  resume(): void { this.stopped = false; }
  awaitOnly(child: ChildProcess): void {
    const entry = this.children.get(child);
    if (entry) entry.terminate = false;
  }
  track(child: ChildProcess, executable: string): void {
    const closed = new Promise<void>(resolve => {
      child.once("close", (code, signal) => {
        this.children.delete(child);
        this.log(`Child exited: ${executable} (pid ${child.pid ?? "unstarted"}, code ${code}, signal ${signal ?? "none"})`);
        resolve();
      });
    });
    this.children.set(child, { executable, closed, terminate: true });
  }
  async stop(milliseconds = 5000): Promise<void> {
    this.pause();
    const children = [...this.children.entries()];
    for (const [child, { executable, terminate }] of children) {
      // The core supervisor owns a native Job Object. Its control pipe must
      // terminate and drain that tree; killing this handle loses exit proof.
      if (!terminate) continue;
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue;
      this.log(`Stopping child: ${executable} (pid ${child.pid})`);
      child.kill("SIGKILL");
    }
    await bounded(`Child process shutdown (${children.map(([, entry]) => entry.executable).join(", ")})`,
      Promise.all(children.map(([, entry]) => entry.closed)), milliseconds);
    if (this.children.size) throw new Error("Child processes remain alive; refusing installer handoff");
  }
}

export const ownedProcesses = new OwnedProcesses();
// Every app-owned bundled spawn must use these wrappers. Sound fallback is
// tracked too because PowerShell can read an installed sound asset.
export const spawn: typeof nativeSpawn = ((...args: Parameters<typeof nativeSpawn>) => {
  ownedProcesses.assertRunning();
  const child = nativeSpawn(...args);
  ownedProcesses.track(child, args[0]);
  return child;
}) as typeof nativeSpawn;
// Synchronous children cannot survive the call or overlap preparation.
// Reject new synchronous work during shutdown as well.
export const spawnSync: typeof nativeSpawnSync = ((file: string, args: string[], options: object = {}) => {
  ownedProcesses.assertRunning();
  return nativeSpawnSync(file, args, options);
}) as typeof nativeSpawnSync;
