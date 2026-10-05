import type { ClipRecord, StorageSettings, StorageStatus } from "./contracts";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_RETAINED_CLIPS = 5;
// Fraction of the target that bounds unattended cleanup. Videos at least this
// large are kept separately, and an overage larger than this pauses cleanup
// until the user confirms it (a lowered target, a bulk import, or re-enabling).
export const REVIEW_FRACTION = 0.25;
const GIB = 1024 ** 3;

type PolicySettings = Pick<StorageSettings, "autoCleanup" | "limitGb" | "deleteEdited">;

// Videos at least this large never count toward the target and are never
// removed automatically, so one long replay cannot evict many short clips.
export function largeVideoBytes(settings: Pick<StorageSettings, "limitGb">): number {
  return Number.isFinite(settings.limitGb) && settings.limitGb > 0 ? settings.limitGb * GIB * REVIEW_FRACTION : 0;
}

// Recordings, favorites, large videos, and (unless opted in) editor exports
// have a manual lifecycle.
export function isAutoManagedClip(clip: ClipRecord, settings: Pick<StorageSettings, "limitGb" | "deleteEdited">): boolean {
  return clip.protected === 0 && (clip.source === "clip" || (clip.source === "edited" && settings.deleteEdited))
    && Number.isFinite(clip.sizeBytes) && clip.sizeBytes >= 0 && clip.sizeBytes < largeVideoBytes(settings);
}

export type StorageClip = ClipRecord & { importedAt: number };
export interface StoragePlan { status: StorageStatus; ids: string[] }

// Oldest-first plan to bring managed clips back under the target. `approved`
// is the user's explicit confirmation for an overage above the review bound.
export function planStorageCleanup(clips: StorageClip[], settings: PolicySettings, now: number, approved = false): StoragePlan {
  const limitBytes = settings.autoCleanup && Number.isFinite(settings.limitGb) && settings.limitGb > 0 ? settings.limitGb * GIB : 0;
  const managed = clips.filter(clip => isAutoManagedClip(clip, settings));
  const managedBytes = managed.reduce((sum, clip) => sum + clip.sizeBytes, 0);
  const totalBytes = clips.reduce((sum, clip) => sum + Math.max(0, clip.sizeBytes || 0), 0);
  const status: StorageStatus = { totalBytes, managedBytes, keptBytes: totalBytes - managedBytes, limitBytes,
    reclaimBytes: 0, reclaimCount: 0, reason: limitBytes ? "within-target" : "disabled" };
  if (!limitBytes || managedBytes <= limitBytes) return { status, ids: [] };
  // Arrival and capture time both gate removal: imports keep old capture times.
  const settled = (clip: StorageClip) => Number.isFinite(clip.importedAt) && clip.importedAt <= now - DAY_MS && clip.createdAt <= now - DAY_MS;
  const candidates = managed.filter(settled).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, managed.length - MIN_RETAINED_CLIPS));
  const ids: string[] = [];
  let remaining = managedBytes;
  for (const clip of candidates) {
    if (remaining <= limitBytes) break;
    ids.push(clip.id);
    remaining -= clip.sizeBytes;
  }
  status.reclaimBytes = managedBytes - remaining;
  status.reclaimCount = ids.length;
  if (!ids.length) {
    status.reason = managed.some(clip => !settled(clip)) ? "recent" : "minimum";
    return { status, ids };
  }
  // Ordinary growth is cleared as it arrives. A large overage means the target
  // or library changed sharply, so nothing is removed without confirmation.
  if (!approved && managedBytes - limitBytes > limitBytes * REVIEW_FRACTION) {
    status.reason = "needs-review";
    return { status, ids: [] };
  }
  status.reason = "cleaning";
  return { status, ids };
}
