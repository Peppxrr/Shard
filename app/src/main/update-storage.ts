// Own only Shard's updater cache. Never touch the installation or user clips.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { copyFile, lstat, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

export interface UpdatePreferences {
  dismissedVersion?: string;
  scheduledVersion?: string;
  attemptedVersion?: string;
}
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function versionAtLeast(current: string, other: string): boolean {
  if (!versionPattern.test(current) || !versionPattern.test(other)) return false;
  const a = current.split(".").map(Number), b = other.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

export class UpdatePreferencesFile {
  value: UpdatePreferences = {};
  private file: string;
  constructor(file: string) {
    this.file = file;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      for (const key of ["dismissedVersion", "scheduledVersion", "attemptedVersion"] as const)
        if (typeof data[key] === "string" && versionPattern.test(data[key])) this.value[key] = data[key];
    } catch { /* First launch or an incomplete old preference file. */ }
  }
  save(next: UpdatePreferences): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(next), "utf8");
    renameSync(`${this.file}.tmp`, this.file);
    this.value = { ...next };
  }
}

export async function sha512(file: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

export class UpdateCache {
  readonly root: string;
  private log: (message: string) => void;
  constructor(root: string, log: (message: string) => void) { this.root = root; this.log = log; }
  private file(name: string): string { return path.join(this.root, name); }

  private async safe(): Promise<void> {
    // Refuse junctions/symlinks, including a redirected pending directory.
    for (const name of ["", "pending"]) {
      const info = await lstat(this.file(name)).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("Unsafe updater cache directory");
    }
  }

  async pending(): Promise<{ version: string; sha512: string; fileName: string } | null> {
    await this.safe();
    try {
      const data = JSON.parse(await readFile(this.file("pending/update-info.json"), "utf8"));
      const match = typeof data.fileName === "string" && /^Shard-Setup-(\d+\.\d+\.\d+)\.exe$/.exec(data.fileName);
      if (!match || !versionPattern.test(match[1]) || !/^[A-Za-z0-9+/]{86}==$/.test(data.sha512)) return null;
      return { version: match[1], fileName: data.fileName, sha512: data.sha512 };
    } catch { return null; }
  }

  async verifyPending(version: string): Promise<boolean> {
    const pending = await this.pending();
    if (!pending || pending.version !== version) return false;
    try { return await sha512(this.file(`pending/${pending.fileName}`)) === pending.sha512; }
    catch { return false; }
  }

  async recover(currentVersion: string): Promise<boolean> {
    await this.safe();
    const pending = await this.pending();
    if (pending && versionAtLeast(currentVersion, pending.version)) {
      // NSIS copies its own bytes to installer.exe. Confirm that install really
      // finished before retiring the pending download or promoting its map.
      const installedHash = await sha512(this.file("installer.exe")).catch(() => null);
      if (installedHash === pending.sha512) {
        if (existsSync(this.file("pending/current.blockmap")))
          await copyFile(this.file("pending/current.blockmap"), this.file("current.blockmap"));
        else await rm(this.file("current.blockmap"), { force: true }); // fetch the matching map next time
        await this.clearPending();
        await rm(this.file("baseline.blockmap"), { force: true });
        this.log(`Installation of ${pending.version} confirmed; removed pending installer, retained differential baseline`);
        return true;
      }
    }
    if (existsSync(this.file("baseline.blockmap"))) {
      await copyFile(this.file("baseline.blockmap"), this.file("current.blockmap"));
      await rm(this.file("baseline.blockmap"), { force: true });
      this.log("Restored the installed version's block map after an interrupted download");
    } else if (pending && !versionAtLeast(currentVersion, pending.version)) {
      // Legacy updater may already have promoted the new map, while the old
      // installer is still installed. Fetch the old map from its release.
      await rm(this.file("current.blockmap"), { force: true });
      this.log("Discarded an unpaired legacy block map; the next download will fetch the installed version's map");
    }
    return false;
  }

  async preserveBaseline(): Promise<void> {
    await this.safe();
    if (existsSync(this.file("current.blockmap")))
      await copyFile(this.file("current.blockmap"), this.file("baseline.blockmap"));
  }

  async restoreBaseline(): Promise<void> {
    await this.safe();
    if (existsSync(this.file("baseline.blockmap"))) {
      await copyFile(this.file("baseline.blockmap"), this.file("current.blockmap"));
      await rm(this.file("baseline.blockmap"), { force: true });
    } else {
      // No old local map: let the provider fetch it instead of leaving the new
      // pending map paired with the old installer.
      await rm(this.file("current.blockmap"), { force: true });
    }
  }

  private async clearPending(): Promise<void> {
    await this.safe();
    // Only flat files written by electron-updater; no recursive deletion.
    for (const entry of await readdir(this.file("pending"), { withFileTypes: true })) {
      if (entry.isFile() && /^(?:(?:temp-)?Shard-Setup-[\w.-]+\.exe|current\.blockmap|update-info\.json)$/.test(entry.name))
        await rm(this.file(`pending/${entry.name}`), { force: true });
    }
  }
}
