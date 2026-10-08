import { useEffect, useState } from "react";
import type { ClipRecord, ExportProgress } from "../../shared/contracts";
import { mediaFileUrl } from "../editor/VideoPreview";
import { Button, Icon, Modal } from "./ui";

const normalizePath = (path: string) => path.replace(/\\/g, "/").toLowerCase();

export function ExportResultDialog({ progress, onClose, onLibrary, onOpen }: {
  progress: ExportProgress;
  onClose: () => void;
  onLibrary: () => void;
  onOpen: (path: string) => void;
}) {
  const result = progress.result;
  const [record, setRecord] = useState<ClipRecord | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const filename = result?.path.split(/[\\/]/).pop() ?? "Exported clip";

  useEffect(() => {
    if (!result) return;
    let disposed = false;
    const refresh = () => {
      void window.shard.listClips().then((clips) => {
        if (!disposed) setRecord(clips.find((clip) => normalizePath(clip.path) === normalizePath(result.path)) ?? null);
      }).catch(() => { /* The file can still be opened or shared while indexing finishes. */ });
    };
    const stop = window.shard.onLibraryChanged(refresh);
    refresh();
    return () => { disposed = true; stop(); };
  }, [result?.path]);

  // Dismiss this dialog before Escape reaches the editor underneath it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const deleteExport = async () => {
    if (!result || deleting) return;
    setDeleting(true);
    setActionError(null);
    try {
      const clip = record ?? (await window.shard.listClips()).find((candidate) => normalizePath(candidate.path) === normalizePath(result.path));
      if (!clip) throw new Error("The export is still being added to the library. Try again in a moment.");
      await window.shard.deleteClip(clip.id);
      onClose();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally { setDeleting(false); }
  };

  return (
    <Modal open variant="export-result" onClose={onClose}
      title={<span className="export-result__heading"><span className="export-result__status" data-error={!!progress.error}><Icon name={progress.error ? "x" : "check"} size={18} /></span>{progress.error ? "Export failed" : "Export complete"}</span>}
      sub={progress.error ? "Your edit is still here. You can try exporting again." : "Ready to watch or share."}>
      <div data-shard-slot="editor-export" data-shard-state={progress.error ? "error" : "complete"} className="export-result">
        {result && !progress.error && <>
          <button type="button" data-shard-slot="export-thumbnail" className="export-result__thumbnail" draggable
            aria-label={`Open ${filename}`} title="Click to play · drag to Discord or another app"
            onClick={() => onOpen(result.path)} onDragStart={(event) => {
              event.preventDefault();
              window.shard.startDrag(result.path, record?.thumb || undefined);
            }}>
            {record?.thumb ? <img src={mediaFileUrl(record.thumb)} alt="" draggable={false} />
              : <video src={mediaFileUrl(result.path)} preload="metadata" muted playsInline aria-hidden="true" />}
            <span className="export-result__play" aria-hidden="true"><Icon name="play" size={24} /></span>
          </button>
          <div data-shard-slot="export-file" className="export-result__file">
            <strong title={filename}>{filename}</strong>
            <span className="num">{result.sizeMb} MB{result.overTarget && <span className="export-result__warning"> · Above target size</span>}</span>
            <small>Drag the thumbnail to share the video file.</small>
          </div>
        </>}
        {(actionError || progress.error) && <p data-shard-slot="export-error" className="export-result__error" role="alert">{actionError ?? progress.error}</p>}
        <div data-shard-slot="export-actions" className="export-result__actions">
          {result && !progress.error && <Button variant="primary" icon={<Icon name="play" size={15} />} onClick={() => onOpen(result.path)}>Open clip</Button>}
          <Button variant="ghost" icon={<Icon name="back" size={15} />} onClick={onLibrary}>Library</Button>
          {result && !progress.error && <div className="export-result__file-actions">
            <Button size="sm" variant="ghost" icon={<Icon name="folderOpen" size={15} />} onClick={() => window.shard.revealInExplorer(result.path)}>Show in folder</Button>
            <Button size="sm" variant="ghost" className="export-result__delete" icon={<Icon name="trash" size={15} />} loading={deleting} onClick={() => void deleteExport()}>Delete</Button>
          </div>}
        </div>
      </div>
    </Modal>
  );
}
