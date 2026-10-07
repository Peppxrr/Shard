import { useEffect, useState, type CSSProperties } from "react";
import type { StorageSettings, StorageStatus } from "../../shared/contracts";
import { MIN_RETAINED_CLIPS } from "../../shared/storage-policy";
import { Button, Confirm } from "./ui";
import { fmtSize } from "./LibraryPage";

export function storageMeterStyle(pct: number): CSSProperties {
  const usage = Math.max(0, Math.min(100, pct));
  const warning = Math.min(100, usage / 75 * 100);
  const danger = Math.max(0, Math.min(100, (usage - 75) / 15 * 100));
  return {
    width: `${usage}%`,
    "--_storage-color": `color-mix(in srgb, color-mix(in srgb, var(--accent), var(--warn) ${warning}%), var(--danger) ${danger}%)`,
  } as CSSProperties;
}

// Live cleanup status for saved settings, or a preview of unsaved `draft` values.
export function useStorageStatus(draft?: StorageSettings): { status: StorageStatus | null; failed: boolean } {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const draftKey = draft ? `${draft.autoCleanup}:${draft.limitGb}:${draft.deleteEdited}` : "";
  useEffect(() => {
    let alive = true;
    let revision = 0;
    const update = (next: StorageStatus) => { if (alive) { setStatus(next); setFailed(false); } };
    const refresh = () => {
      const request = ++revision;
      void window.shard.getStorageStatus(draft).then(next => { if (request === revision) update(next); })
        .catch(() => { if (alive && request === revision) setFailed(true); });
    };
    // Pushed statuses describe saved settings; a draft preview re-plans instead.
    const unsubscribeStatus = window.shard.onStorageStatus(next => { if (draft) refresh(); else { revision++; update(next); } });
    const unsubscribeLibrary = window.shard.onLibraryChanged(refresh);
    refresh();
    return () => { alive = false; unsubscribeStatus(); unsubscribeLibrary(); };
  }, [draftKey]);
  return { status, failed };
}

export function StorageSummary({ draft }: { draft?: StorageSettings }) {
  const { status, failed } = useStorageStatus(draft);
  const [confirming, setConfirming] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState("");
  if (!status) return <div data-shard-component="storage-summary" data-shard-state="loading" className="storage-summary">
    <p className="storage-summary__detail">{failed ? "Storage usage is unavailable. Try again shortly." : "Checking storage…"}</p>
  </div>;

  const enabled = status.limitBytes > 0;
  const pct = enabled ? Math.min(100, status.managedBytes / status.limitBytes * 100) : 0;
  const removal = `${status.reclaimCount === 1 ? "oldest clip" : `${status.reclaimCount} oldest clips`} (${fmtSize(status.reclaimBytes)})`;
  const notice = {
    disabled: "", "within-target": "",
    cleaning: draft ? `Saving will delete the ${removal}.` : `Deleting the ${removal}…`,
    "needs-review": draft ? `Getting under this limit means deleting the ${removal}. You’ll be asked first.`
      : `Cleanup is paused. Getting under the limit means deleting the ${removal}.`,
    recent: "Over the limit. Clips from the last 24 hours are kept until they’re a day old.",
    minimum: `Over the limit. Your ${MIN_RETAINED_CLIPS} newest clips are always kept.`,
    busy: "Over the limit. Some clips are in use, so cleanup will try again shortly.",
  }[status.reason];
  const cleanUp = async () => {
    setConfirming(false);
    setCleaning(true);
    setError("");
    try { await window.shard.cleanUpStorage(status.reclaimBytes); }
    catch { setError("Cleanup failed. Try again."); }
    finally { setCleaning(false); }
  };

  return <div data-shard-component="storage-summary" data-shard-state={status.reason} className="storage-summary">
    <div data-shard-slot="storage-usage" className="storage-summary__figures num">
      <span>{enabled ? <><strong>{fmtSize(status.managedBytes)}</strong> of {fmtSize(status.limitBytes)}</> : <><strong>{fmtSize(status.totalBytes)}</strong> in your library</>}</span>
      {enabled && status.keptBytes > 0 && <span className="storage-summary__detail" title="Favorites, recordings, and large videos">{fmtSize(status.keptBytes)} kept separately</span>}
    </div>
    {enabled && <div className="meter"><div className="meter__track"><div className={`meter__fill ${pct >= 90 ? "is-over" : pct >= 75 ? "is-warn" : ""}`} style={storageMeterStyle(pct)} /></div></div>}
    {notice && <div data-shard-slot="storage-notice" className="storage-summary__notice" role="status">
      <span>{error || notice}</span>
      {status.reason === "needs-review" && !draft && <Button size="sm" variant="danger" disabled={cleaning} onClick={() => setConfirming(true)}>
        {cleaning ? "Cleaning up…" : "Clean up now"}
      </Button>}
    </div>}
    <Confirm open={confirming} destructive title={`Delete ${status.reclaimCount} ${status.reclaimCount === 1 ? "clip" : "clips"}?`} confirmLabel="Delete clips"
      message={`The ${removal} will be permanently deleted to get under your ${fmtSize(status.limitBytes)} limit. Favorites, recordings, and large videos are kept.`}
      onConfirm={() => void cleanUp()} onCancel={() => setConfirming(false)} />
  </div>;
}
