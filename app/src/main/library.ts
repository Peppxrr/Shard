// library.ts — better-sqlite3 clip database + import pipeline.
// Everything stored is mp4 (H.264+AAC, yuv420p, faststart) so Chromium plays
// it natively; mkv never enters the library.
import Database from "better-sqlite3";
import { app } from "electron";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClipRecord } from "../shared/contracts";
import { ffprobe, ffprobeAsync, makeThumbnail, makeThumbnailAsync, remuxToMp4 } from "./ffmpeg";
import { getSettings } from "./settings";

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
  };
}

export class Library extends EventEmitter {
  private db: Database.Database;
  private thumbsDir: string;

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

  delete(id: string): void {
    const row = this.get(id);
    if (!row) return;
    this.db.prepare("DELETE FROM clips WHERE id = ?").run(id);
    // File deletion is best-effort (may be locked by the viewer).
    fs.unlink(row.path).catch(() => {});
    if (row.thumb) fs.unlink(row.thumb).catch(() => {});
  }

  setProtected(id: string, prot: boolean): void {
    this.db.prepare("UPDATE clips SET protected = ? WHERE id = ?").run(prot ? 1 : 0, id);
  }

  totalBytes(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(size_bytes),0) AS s FROM clips").get() as { s: number };
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
  async importMp4Async(file: string, source: "clip" | "recording" | "edited", game: string | null = null): Promise<ClipRecord> {
    const probe = await ffprobeAsync(file);
    let thumb: string | null = null;
    try { thumb = await makeThumbnailAsync(file, this.thumbsDir); } catch {}
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
    return rec;
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
        this.delete(r.id);
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
