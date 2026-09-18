// Main-process state machine, with the updater/lifecycle injected for offline tests.
import type { AppUpdater, UpdateInfo, ProgressInfo } from "electron-updater";
import type { UpdateState } from "../shared/contracts";

export type UpdateBackend = Pick<AppUpdater, "on" | "autoDownload" | "autoInstallOnAppQuit" | "allowPrerelease" | "allowDowngrade" | "disableWebInstaller" | "checkForUpdates" | "downloadUpdate" | "quitAndInstall">;
const RELEASES = "https://github.com/Peppxrr/Shard/releases";

export class UpdateController {
  private state: UpdateState;
  private busy = false;
  private backend: UpdateBackend | null;
  private publish: (state: UpdateState) => void;
  private prepareInstall: () => Promise<string | null>;
  private installFailed: () => void;
  private openExternal: (url: string) => Promise<void>;

  constructor(options: {
    currentVersion: string; mode: UpdateState["mode"]; disabledMessage?: string;
    backend: UpdateBackend | null; publish: (state: UpdateState) => void;
    prepareInstall: () => Promise<string | null>; installFailed: () => void;
    openExternal: (url: string) => Promise<void>;
  }) {
    this.backend = options.backend;
    this.publish = options.publish;
    this.prepareInstall = options.prepareInstall;
    this.installFailed = options.installFailed;
    this.openExternal = options.openExternal;
    this.state = { revision: 0, status: options.mode === "disabled" ? "disabled" : "idle",
      mode: options.mode, currentVersion: options.currentVersion, message: options.disabledMessage };
    const updater = this.backend;
    if (!updater) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    // One set of listeners for the application's lifetime, never per Settings mount.
    updater.on("update-available", (info: UpdateInfo) => this.set({ status: "available", ...release(info) }));
    updater.on("update-not-available", () => this.set({ status: "up-to-date", version: undefined, releaseNotes: undefined }));
    updater.on("download-progress", (p: ProgressInfo) => {
      if (this.state.status !== "downloading") return;
      this.set({ progress: { percent: Math.max(0, Math.min(100, p.percent)), transferred: p.transferred,
        total: p.total, bytesPerSecond: p.bytesPerSecond } });
    });
    updater.on("update-downloaded", (info: UpdateInfo) => this.set({ status: "downloaded", ...release(info), progress: undefined }));
    updater.on("error", (error: Error) => this.fail(error));
  }

  getState(): UpdateState { return structuredClone(this.state); }

  private set(next: Partial<UpdateState>): void {
    this.state = { ...this.state, ...next, revision: this.state.revision + 1 };
    this.publish(this.getState());
  }

  private fail(error: unknown): void {
    console.error("[updates]", error);
    const retry = this.state.status === "installing" ? "install" :
      this.state.status === "downloading" ? "download" : this.state.retry ?? "check";
    if (retry === "install") this.installFailed();
    const code = (error as { code?: string })?.code;
    const message = retry === "install" ? "Could not start the installer. Try again or download Shard from the release page." :
      retry === "download" ? "Could not download or verify the update. Check your connection and free disk space, then try again." :
      code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" ? "The latest release does not include update information yet. You can check the release page or try again later." :
      "Could not check for updates. Check your connection and try again later.";
    this.set({ status: "error", retry, message, progress: undefined });
  }

  async check(): Promise<UpdateState> {
    if (!this.backend || this.busy || !["idle", "up-to-date", "available", "error"].includes(this.state.status) ||
      (this.state.status === "error" && this.state.retry !== "check")) return this.getState();
    this.busy = true;
    this.set({ status: "checking", message: undefined, retry: undefined, version: undefined, releaseNotes: undefined });
    try { await this.backend.checkForUpdates(); }
    catch (error) { this.fail(error); }
    finally { this.busy = false; }
    return this.getState();
  }

  async download(): Promise<UpdateState> {
    if (!this.backend || this.busy || this.state.mode !== "installed" ||
      !(this.state.status === "available" || (this.state.status === "error" && this.state.retry === "download"))) return this.getState();
    this.busy = true;
    this.set({ status: "downloading", message: undefined, retry: undefined, progress: undefined });
    try { await this.backend.downloadUpdate(); }
    catch (error) { this.fail(error); }
    finally { this.busy = false; }
    return this.getState();
  }

  async install(): Promise<UpdateState> {
    if (!this.backend || this.busy || this.state.mode !== "installed" ||
      !(this.state.status === "downloaded" || (this.state.status === "error" && this.state.retry === "install"))) return this.getState();
    this.busy = true;
    this.set({ status: "installing", message: undefined, retry: undefined });
    try {
      const reason = await this.prepareInstall();
      if (reason) this.set({ status: "downloaded", message: reason });
      else this.backend.quitAndInstall(false, true);
    } catch (error) { this.fail(error); }
    finally { this.busy = false; }
    return this.getState();
  }

  async openRelease(): Promise<UpdateState> {
    // No URL, path, or executable ever comes from the renderer.
    const version = this.state.version;
    const url = version && /^\d+\.\d+\.\d+$/.test(version) ? `${RELEASES}/tag/v${version}` : `${RELEASES}/latest`;
    try { await this.openExternal(url); }
    catch { this.set({ message: "Could not open your browser. Visit github.com/Peppxrr/Shard/releases." }); }
    return this.getState();
  }
}

function release(info: UpdateInfo): Pick<UpdateState, "version" | "releaseNotes"> {
  const notes = typeof info.releaseNotes === "string" ? info.releaseNotes :
    info.releaseNotes?.map(note => `${note.version}\n${note.note ?? ""}`).join("\n\n");
  // GitHub's feed may supply HTML. Render only bounded plain text in React.
  return { version: info.version, releaseNotes: notes?.replace(/<[^>]*>/g, "").slice(0, 12000) };
}
