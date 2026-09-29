// library.ts — better-sqlite3 clip database + import pipeline.
// Everything stored is mp4 (H.264+AAC, yuv420p, faststart) so Chromium plays
// it natively; mkv never enters the library.
import Database from "better-sqlite3";
import { app } from "electron";
import { constants as fsConstants, promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClipRecord } from "../shared/contracts";
import { ffprobe, ffprobeAsync, makeThumbnail, makeThumbnailAsync, remuxToMp4, editorTimelinePreviews } from "./ffmpeg";
import { getSettings } from "./settings";
import {
  copyMp4ToUniquePath,
  sourceFingerprint,
  validateClipBasename,
  type ImportSourceFingerprint,
  type MedalImportMetadata,
} from "./library-import";

export interface ClipImportMetadata {
  createdAt?: number;
  fingerprint?: ImportSourceFingerprint;
}

// SQLite columns are snake_case; the renderer contract is camelCase.
function toClipRecord(r: Record<string, unknown>): ClipRecord {
  return {
    id: String(r.id),
    path: String(r.path),
    thumb: (r.thumb as string) ?? "",
    game: (r.game as string) ?? null,
    createdAt: Number(r.created_at),
    durationMs: Number(r.duration_ms),
    sizeBytes: Number(r.size_bytes),
    width: r.width === null ? null : Number(r.width),
    height: r.height === null ? null : Number(r.height),
    fps: r.fps === null ? null : Number(r.fps),
    protected: Number(r.protected),
    source: (r.source as "clip" | "recording" | "edited") ?? "clip",
    ...(r.import_source_path ? { importedFrom: "medal" as const } : {}),
  };
}

export class Library extends EventEmitter {
  private db: Database.Database;
  private thumbsDir: string;
  private busyPaths = new Set<string>();

  constructor(userData: string) {
    super();
    this.db = new Database(path.join(userData, "library.db"));
    this.db.pragma("journal_mode = WAL");
    this.thumbsDir = path.join(userData, "thumbs");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clips(
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        thumb TEXT,
        game TEXT,
        created_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        width INTEGER, height INTEGER, fps REAL,
        protected INTEGER DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'clip'
      );
    `);
    const columns = new Set((this.db.pragma("table_info(clips)") as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("import_source_path")) this.db.exec("ALTER TABLE clips ADD COLUMN import_source_path TEXT");
    if (!columns.has("import_source_size")) this.db.exec("ALTER TABLE clips ADD COLUMN import_source_size INTEGER");
    if (!columns.has("import_source_mtime")) this.db.exec("ALTER TABLE clips ADD COLUMN import_source_mtime REAL");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_clips_import_source ON clips(import_source_path, import_source_size, import_source_mtime)");
  }

  tryLockPath(file: string): (() => void) | null {
    const key = pathKey(file);
    if (this.busyPaths.has(key)) return null;
    this.busyPaths.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busyPaths.delete(key);
    };
  }

  list(): ClipRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM clips ORDER BY created_at DESC")
      .all() as unknown as Record<string, unknown>[];
    return rows.map(toClipRecord);
  }

  get(id: string): ClipRecord | undefined {
    const row = this.db.prepare("SELECT * FROM clips WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toClipRecord(row) : undefined;
  }

  async delete(id: string): Promise<void> {
    const row = this.get(id);
    if (!row) return;
    const release = this.tryLockPath(row.path);
    if (!release) throw new Error("This clip is being used by another operation");
    try {
      this.db.prepare("DELETE FROM clips WHERE id = ?").run(id);
      await editorTimelinePreviews().remove(row.path).catch(() => {});
      await fs.unlink(row.path).catch(() => {});
      if (row.thumb) await fs.unlink(row.thumb).catch(() => {});
    } finally {
      release();
    }
  }

  async deleteForStorage(id: string): Promise<void> {
    const row = this.get(id);
    if (!row) return;
    const release = this.tryLockPath(row.path);
    if (!release) throw new Error("This clip is being used by another operation");
    try {
      try {
        await fs.unlink(row.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.db.prepare("DELETE FROM clips WHERE id = ?").run(id);
      await editorTimelinePreviews().remove(row.path).catch(() => {});
      if (row.thumb) await fs.unlink(row.thumb).catch(() => {});
    } finally {
      release();
    }
  }

  setProtected(id: string, prot: boolean): void {
    this.db.prepare("UPDATE clips SET protected = ? WHERE id = ?").run(prot ? 1 : 0, id);
  }

  autoDeleteBytes(includeEdited: boolean): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(size_bytes),0) AS s FROM clips WHERE protected = 0 AND (? = 1 OR source != 'edited')")
      .get(includeEdited ? 1 : 0) as { s: number };
    return row.s;
  }

  oldestUnprotected(includeEdited: boolean): ClipRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM clips
         WHERE protected = 0 AND (? = 1 OR source != 'edited')
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(includeEdited ? 1 : 0) as Record<string, unknown> | undefined;
    return row ? toClipRecord(row) : undefined;
  }

  // Import an mp4 already in the library format. `game` tags the clip.
  async importMp4Async(file: string, source: "clip" | "recording" | "edited", game: string | null = null, metadata: ClipImportMetadata = {}): Promise<ClipRecord> {
    const probe = await ffprobeAsync(file);
    let thumb: string | null = null;
    try { thumb = await makeThumbnailAsync(file, this.thumbsDir); } catch {}
    const rec: ClipRecord = {
      id: randomUUID(),
      path: file,
      thumb: thumb ?? "",
      game,
      createdAt: Number.isFinite(metadata.createdAt) ? metadata.createdAt! : Date.now(),
      durationMs: Math.round(probe.durationSec * 1000),
      sizeBytes: probe.sizeBytes,
      width: probe.width || null,
      height: probe.height || null,
      fps: probe.fps,
      protected: 0,
      source,
      ...(metadata.fingerprint ? { importedFrom: "medal" as const } : {}),
    };
    try {
      this.db
        .prepare(
          `INSERT INTO clips (id, path, thumb, game, created_at, duration_ms, size_bytes, width, height, fps, protected, source,
             import_source_path, import_source_size, import_source_mtime)
           VALUES (@id, @path, @thumb, @game, @createdAt, @durationMs, @sizeBytes, @width, @height, @fps, @protected, @source,
             @importSourcePath, @importSourceSize, @importSourceMtime)`
        )
        .run({
          ...rec,
          importSourcePath: metadata.fingerprint?.path ?? null,
          importSourceSize: metadata.fingerprint?.size ?? null,
          importSourceMtime: metadata.fingerprint?.mtimeMs ?? null,
        });
    } catch (error) {
      if (thumb) await fs.unlink(thumb).catch(() => {});
      throw error;
    }
    this.emit("added", rec);
    editorTimelinePreviews().warm(file, probe.durationSec);
    return rec;
  }

  async importCopiedMp4Async(
    sourceFile: string,
    destinationDirectory: string,
    source: "clip" | "edited",
    metadata: MedalImportMetadata,
  ): Promise<{ record: ClipRecord; duplicate: boolean }> {
    const sourcePath = path.resolve(sourceFile);
    const sourceStat = await fs.lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("Source is not a regular MP4 file");
    if (path.extname(sourcePath).toLowerCase() !== ".mp4") throw new Error("Source file is not an MP4");
    const fingerprint = sourceFingerprint(sourcePath, sourceStat.size, sourceStat.mtimeMs);
    const duplicate = await this.findSurvivingImport(fingerprint);
    if (duplicate) return { record: duplicate, duplicate: true };

    const destination = await copyMp4ToUniquePath(sourcePath, destinationDirectory);
    const release = this.tryLockPath(destination);
    if (!release) {
      await fs.unlink(destination).catch(() => {});
      throw new Error("The managed destination is busy");
    }
    try {
      const afterCopy = await fs.stat(sourcePath);
      if (afterCopy.size !== sourceStat.size || afterCopy.mtimeMs !== sourceStat.mtimeMs) {
        throw new Error("Source file changed during import");
      }
      const record = await this.importMp4Async(destination, source, metadata.game, {
        createdAt: metadata.createdAt,
        fingerprint,
      });
      return { record, duplicate: false };
    } catch (error) {
      await fs.unlink(destination).catch(() => {});
      throw error;
    } finally {
      release();
    }
  }

  async renameClip(id: string, name: string): Promise<ClipRecord> {
    const current = this.get(id);
    if (!current) throw new Error("The clip is no longer in the library");
    const baseName = validateClipBasename(name);
    const oldPath = current.path;
    const newPath = path.join(path.dirname(oldPath), `${baseName}.mp4`);
    if (oldPath === newPath) return current;
    const release = this.tryLockPath(oldPath);
    if (!release) throw new Error("This clip is being used by another operation");
    const lockNew = pathKey(oldPath) === pathKey(newPath) ? null : this.tryLockPath(newPath);
    if (pathKey(oldPath) !== pathKey(newPath) && !lockNew) {
      release();
      throw new Error("The destination filename is being changed");
    }

    const caseOnly = pathKey(oldPath) === pathKey(newPath);
    let filePath = oldPath;
    try {
      if (caseOnly) {
        const caseTemp = path.join(path.dirname(oldPath), `.${randomUUID()}.rename.mp4`);
        await renameWithRetry(oldPath, caseTemp);
        filePath = caseTemp;
        try {
          await renameWithRetry(caseTemp, newPath);
          filePath = newPath;
        } catch (renameError) {
          try {
            await renameWithRetry(caseTemp, oldPath);
            filePath = oldPath;
          } catch (restoreError) {
            this.tryUpdatePath(id, caseTemp);
            throw new Error(`Rename failed; the clip is preserved at ${caseTemp}. ${errorMessage(restoreError)}`);
          }
          throw renameError;
        }
      } else {
        // link() gives an exclusive destination even on platforms where rename()
        // replaces an existing file. Fall back to exclusive copy on filesystems
        // that do not support hard links.
        try {
          await fs.link(oldPath, newPath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EEXIST") throw new Error("A clip with that filename already exists");
          if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(code ?? "")) throw error;
          try {
            await fs.copyFile(oldPath, newPath, fsConstants.COPYFILE_EXCL);
          } catch (copyError) {
            if ((copyError as NodeJS.ErrnoException).code === "EEXIST")
              throw new Error("A clip with that filename already exists");
            throw copyError;
          }
        }
        try {
          await retryFileOperation(() => fs.unlink(oldPath));
        } catch (error) {
          // If unlink reports a failure, retain the new link/copy whenever the
          // source path is no longer present. This keeps at least one valid file.
          const originalStillExists = await fs.stat(oldPath).then(() => true, () => false);
          if (originalStillExists) await fs.unlink(newPath).catch(() => {});
          else {
            filePath = newPath;
            this.tryUpdatePath(id, newPath);
            throw new Error(`The old filename could not be removed; the clip is preserved at ${newPath}. ${errorMessage(error)}`);
          }
          throw error;
        }
        filePath = newPath;
      }

      try {
        this.updatePath(id, newPath);
      } catch (databaseError) {
        if (caseOnly) {
          const rollbackTemp = path.join(path.dirname(oldPath), `.${randomUUID()}.rollback.mp4`);
          try {
            await renameWithRetry(newPath, rollbackTemp);
            filePath = rollbackTemp;
            await renameWithRetry(rollbackTemp, oldPath);
            filePath = oldPath;
          } catch (restoreError) {
            this.tryUpdatePath(id, filePath);
            throw new Error(`Library update failed; the clip is preserved at ${filePath}. ${errorMessage(restoreError)}`);
          }
        } else {
          let restored = false;
          try {
            await fs.link(newPath, oldPath);
            restored = true;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EEXIST") {
              try {
                await fs.copyFile(newPath, oldPath, fsConstants.COPYFILE_EXCL);
                restored = true;
              } catch {}
            }
          }
          if (restored) {
            filePath = oldPath;
            await fs.unlink(newPath).catch(() => {});
          } else {
            this.tryUpdatePath(id, newPath);
            throw new Error(`Library update failed; the clip is preserved at ${newPath}. ${errorMessage(databaseError)}`);
          }
        }
        throw databaseError;
      }
      await editorTimelinePreviews().remove(oldPath).catch(() => {});
      const updated = this.get(id);
      if (!updated) throw new Error("The renamed clip could not be loaded");
      return updated;
    } finally {
      lockNew?.();
      release();
    }
  }

  private updatePath(id: string, file: string): void {
    const update = this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE clips SET path = ? WHERE id = ?").run(file, id);
      if (changed.changes !== 1) throw new Error("The clip record changed during rename");
    });
    update();
  }

  private tryUpdatePath(id: string, file: string): void {
    try { this.updatePath(id, file); } catch {}
  }

  private async findSurvivingImport(fingerprint: ImportSourceFingerprint): Promise<ClipRecord | undefined> {
    const rows = this.db.prepare(
      `SELECT * FROM clips WHERE import_source_path = ? AND import_source_size = ? AND import_source_mtime = ? ORDER BY created_at DESC`,
    ).all(fingerprint.path, fingerprint.size, fingerprint.mtimeMs) as unknown as Record<string, unknown>[];
    for (const row of rows) {
      const record = toClipRecord(row);
      // A rename temporarily moves the file while keeping its row in SQLite.
      // It remains the surviving duplicate and must never be purged here.
      if (this.busyPaths.has(pathKey(record.path))) return record;
      try {
        const stat = await fs.stat(record.path);
        if (stat.isFile()) return record;
      } catch {}
      if (this.busyPaths.has(pathKey(record.path))) return record;
      this.db.prepare("DELETE FROM clips WHERE id = ?").run(record.id);
      if (record.thumb) await fs.unlink(record.thumb).catch(() => {});
    }
    return undefined;
  }

  // Sync wrapper kept for legacy callers
  importMp4(file: string, source: "clip" | "recording" | "edited", game: string | null = null): ClipRecord {
    const probe = ffprobe(file);
    const thumb = makeThumbnail(file, this.thumbsDir);
    const rec: ClipRecord = {
      id: randomUUID(),
      path: file,
      thumb: thumb ?? "",
      game,
      createdAt: Date.now(),
      durationMs: Math.round(probe.durationSec * 1000),
      sizeBytes: probe.sizeBytes,
      width: probe.width || null,
      height: probe.height || null,
      fps: probe.fps,
      protected: 0,
      source,
    };
    this.db
      .prepare(
        `INSERT INTO clips (id, path, thumb, game, created_at, duration_ms, size_bytes, width, height, fps, protected, source)
         VALUES (@id, @path, @thumb, @game, @createdAt, @durationMs, @sizeBytes, @width, @height, @fps, @protected, @source)`
      )
      .run(rec);
    this.emit("added", rec);
    editorTimelinePreviews().warm(file, probe.durationSec);
    return rec;
  }

  // Reconcile DB <-> disk: delete DB rows whose file vanished; delete files
  // without a DB row (orphans in the clips dir).
  async reconcile(clipsDir: string): Promise<void> {
    const rows = this.list();
    const keep = new Set<string>();
    for (const r of rows) {
      try {
        await fs.access(r.path);
        keep.add(r.path);
      } catch {
        await this.delete(r.id);
      }
    }
    try {
      const entries = await fs.readdir(clipsDir);
      for (const name of entries) {
        if (!name.toLowerCase().endsWith(".mp4")) continue;
        const full = path.join(clipsDir, name);
        if (!keep.has(full)) await fs.unlink(full).catch(() => {});
      }
    } catch {
      /* dir may not exist yet */
    }
  }

  close(): void {
    this.db.close();
  }
}

// Storage layout: a user-chosen base dir (settings.storage.clipsDir, default
// "" = userData) gets `clips/`, `editor/` and `recordings/` subfolders. The
// app creates the subfolders on demand.
function storageBaseDir(): string {
  const base = getSettings().storage.clipsDir.trim();
  return base || app.getPath("userData");
}
export function clipsDir(): string {
  return path.join(storageBaseDir(), "clips");
}
export function recordingsDir(): string {
  return path.join(storageBaseDir(), "recordings");
}
export function editorDir(): string {
  return path.join(storageBaseDir(), "editor");
}
export { getSettings };

function pathKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function retryFileOperation(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 3 || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

function renameWithRetry(from: string, to: string): Promise<void> {
  return retryFileOperation(() => fs.rename(from, to));
}
