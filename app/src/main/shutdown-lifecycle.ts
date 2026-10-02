type Operations = {
  guard: () => Promise<string | null>;
  cleanup: (update: boolean) => Promise<void>;
  recover: () => Promise<void>;
  quit: () => void;
  log: (message: string) => void;
};

type Phase = "running" | "preparing-update" | "update-ready" | "normal-quit" | "stopped" | "recovering";

// Shared by before-quit and update preparation; injected operations keep the
// handoff independently testable without launching Electron or an installer.
export class ShutdownLifecycle {
  private phase: Phase = "running";
  private preparation?: Promise<string | null>;
  private cleanup?: Promise<void>;
  private recovery?: Promise<void>;
  private quitRequested = false;
  private updaterQuit = false;
  private operations: Operations;
  constructor(operations: Operations) { this.operations = operations; }
  get acceptingWork(): boolean { return this.phase === "running"; }
  get updateReady(): boolean { return this.phase === "update-ready"; }

  prepareUpdate(): Promise<string | null> {
    if (this.preparation) return this.preparation;
    if (this.updateReady) return Promise.resolve(null);
    if (!this.acceptingWork) return Promise.reject(new Error("Application shutdown is already in progress"));
    this.phase = "preparing-update";
    this.operations.log("Update shutdown started");
    this.preparation = (async () => {
      const reason = await this.operations.guard();
      if (reason) {
        this.phase = "running";
        if (this.quitRequested) this.operations.quit();
        return reason;
      }
      this.cleanup = this.operations.cleanup(true);
      await this.cleanup;
      this.phase = "update-ready";
      this.operations.log("Update shutdown complete; ready for updater-driven quit");
      return null;
    })().catch(error => {
      this.operations.log(`Update preparation failed: ${String(error)}`);
      throw error;
    }).finally(() => { this.preparation = undefined; });
    return this.preparation;
  }

  beforeUpdaterQuit(): void { this.updaterQuit = true; }

  beforeQuit(event: { preventDefault(): void }): void {
    if (this.updaterQuit) {
      this.updaterQuit = false;
      if (!this.updateReady) {
        // electron-updater can queue app.quit before its spawn error arrives.
        // Suppress that obsolete handoff without scheduling a normal quit.
        event.preventDefault();
        return;
      }
    }
    if (this.updateReady || this.phase === "stopped") return;
    event.preventDefault();
    this.quitRequested = true;
    if (!this.acceptingWork) return;
    this.phase = "normal-quit";
    this.cleanup = this.operations.cleanup(false);
    void this.cleanup.catch(error => this.operations.log(`Normal shutdown failed: ${String(error)}`)).finally(() => {
      this.phase = "stopped";
      this.operations.quit();
    });
  }

  recoverUpdate(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.phase === "running" || this.phase === "normal-quit" || this.phase === "stopped") return Promise.resolve();
    this.phase = "recovering"; // Revoke the updater bypass before any await.
    this.recovery = (async () => {
      await this.preparation?.catch(() => {});
      await this.cleanup?.catch(() => {});
      try { await this.operations.recover(); }
      finally { this.cleanup = undefined; this.phase = "running"; }
      this.operations.log("Runtime services restored after failed update handoff");
      if (this.quitRequested) this.operations.quit();
    })().finally(() => { this.recovery = undefined; });
    return this.recovery;
  }
}
