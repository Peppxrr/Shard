import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import type { ClipRecord } from "../../shared/contracts";
import { mediaFileUrl } from "../editor/VideoPreview";
import { Button, Icon } from "./ui";

export function ClipRename({ clip, onRenamed, mediaRef, disabled = false }: {
  clip: ClipRecord;
  onRenamed: (clip: ClipRecord) => void;
  mediaRef?: RefObject<HTMLVideoElement | null>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);
  useEffect(() => {
    if (!busy && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      rootRef.current?.querySelector<HTMLElement>(open ? "input" : "button")?.focus();
    }
  }, [busy, open]);

  const save = async () => {
    if (busy || disabled || !name.trim()) return;
    setBusy(true); setError("");
    const video = mediaRef?.current;
    const position = video?.currentTime ?? 0;
    const paused = video?.paused ?? true;
    const rate = video?.playbackRate ?? 1;
    // Release the Windows media handle before moving the file. Restore the
    // same playback position on both success and failure, preserving edits.
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      cleanupRef.current?.();
      const restore = () => {
        video.currentTime = Math.min(position, video.duration || position);
        video.playbackRate = rate;
        if (!paused) void video.play().catch(() => {});
        else video.pause();
        cleanupRef.current = null;
      };
      video.addEventListener("loadedmetadata", restore, { once: true });
      cleanupRef.current = () => video.removeEventListener("loadedmetadata", restore);
    }
    try {
      const renamed = await window.shard.renameClip(clip.id, name);
      flushSync(() => onRenamed(renamed));
      // A same-name request may not trigger a React src update.
      if (video && !video.getAttribute("src")) { video.src = mediaFileUrl(renamed.path); video.load(); }
      setOpen(false);
    } catch (reason) {
      if (video) { video.src = mediaFileUrl(clip.path); video.load(); }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { restoreFocusRef.current = true; setBusy(false); }
  };

  return <div ref={rootRef} data-shard-component="clip-rename" data-shard-state={busy ? "saving" : open ? "editing" : "idle"} className="clip-rename">
    {open ? <form data-shard-slot="rename-form" className="clip-rename__form" onSubmit={(event) => { event.preventDefault(); void save(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); if (!busy) setOpen(false); } }}>
      <label htmlFor={inputId}>File name</label>
      <div data-shard-slot="rename-input" className="clip-rename__input">
        <input id={inputId} autoFocus value={name} disabled={busy} maxLength={180} onChange={(event) => setName(event.target.value)} />
        <span>.mp4</span>
      </div>
      <div data-shard-slot="rename-actions" className="clip-rename__actions">
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={disabled || !name.trim()}>Save name</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      {error && <p data-shard-slot="rename-error" className="clip-rename__error" role="alert">{error}</p>}
    </form> : <Button size="sm" variant="ghost" disabled={disabled} icon={<Icon name="edit" size={14} />}
      onClick={() => { setName((clip.path.split(/[\\/]/).pop() ?? "").replace(/\.mp4$/i, "")); setError(""); setOpen(true); }}>Rename</Button>}
  </div>;
}
