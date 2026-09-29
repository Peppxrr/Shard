import { useEffect, useState } from "react";
import type { LibraryImportProgress, LibraryImportResult } from "../../shared/contracts";
import { Button, Icon, Modal } from "./ui";

export function MedalImport({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<LibraryImportProgress | null>(null);
  const [result, setResult] = useState<LibraryImportResult | null>(null);
  const [error, setError] = useState("");
  useEffect(() => window.shard.onLibraryImportProgress(setProgress), []);
  const start = async (kind: "clips" | "edited") => {
    setBusy(true); setProgress(null); setResult(null); setError("");
    try { setResult(await window.shard.importMedalFolder(kind)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <Modal open size="sm" variant="medal-import" title="Import from Medal" sub="Bring your clips into your Shard library."
    onClose={busy ? undefined : onClose} closeOnBackdrop={!busy}>
    <div data-shard-component="medal-import" data-shard-state={busy ? "importing" : result ? "complete" : "idle"} className="medal-import">
      <p data-shard-slot="import-description">Choose a Medal folder. Shard copies its MP4 videos and keeps the originals in place. Files already imported are skipped.</p>
      <div data-shard-slot="import-options" className="medal-import__options">
        <Button block disabled={busy} icon={<Icon name="folderOpen" size={18} />} onClick={() => void start("clips")}>
          <span><strong>Clips</strong><small>Keep the game and capture date from Medal</small></span><Icon name="plus" size={16} />
        </Button>
        <Button block disabled={busy} icon={<Icon name="scissor" size={18} />} onClick={() => void start("edited")}>
          <span><strong>Editor exports</strong><small>Add as Edited Clips with an unknown game</small></span><Icon name="plus" size={16} />
        </Button>
      </div>
      {busy && <div data-shard-slot="import-progress" className="medal-import__progress" role="status" aria-live="polite">
        <span>{progress ? progress.total > 0 ? `Importing ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}` : "Scanning the selected folder…" : "Choose a folder to continue…"}</span>
        {progress && <><progress max={Math.max(1, progress.total)} value={progress.total > 0 ? progress.completed : undefined} aria-label="Import progress" /><small title={progress.currentName}>{progress.currentName}</small></>}
      </div>}
      {result && !result.cancelled && <div data-shard-slot="import-result" className="medal-import__result" role="status">
        <strong>{result.imported} {result.imported === 1 ? "clip" : "clips"} imported</strong>
        <span>{result.skipped} skipped · {result.errors.length} failed</span>
        {result.errors.length > 0 && <details><summary>View errors</summary><ul>{result.errors.map((message, index) => <li key={index}>{message}</li>)}</ul></details>}
      </div>}
      {error && <p data-shard-slot="import-error" className="clip-rename__error" role="alert">{error}</p>}
      <div data-shard-slot="import-actions" className="medal-import__actions"><Button disabled={busy} onClick={onClose}>{result && !result.cancelled ? "Done" : "Close"}</Button></div>
    </div>
  </Modal>;
}
