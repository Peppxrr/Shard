import { useEffect, useMemo, useState } from "react";
import type { ClipRecord } from "../../shared/contracts";
import { Icon, IconButton, Button, EmptyState, Modal } from "./ui";

interface Props {
  clips: ClipRecord[];
  onOpenEditor: (c: ClipRecord) => void;
}

type SortKey = "newest" | "oldest" | "duration" | "size" | "game" | "favorites";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "favorites", label: "Favorites first" },
  { value: "duration", label: "Longest first" },
  { value: "size", label: "Largest first" },
  { value: "game", label: "By game" },
];

export function LibraryPage({ clips, onOpenEditor }: Props) {
  const [gameFilter, setGameFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [selected, setSelected] = useState<ClipRecord | null>(null);

  const games = useMemo(() => {
    const set = new Set<string>();
    clips.forEach((c) => c.game && set.add(c.game));
    return [...set].sort();
  }, [clips]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = clips.filter((c) => {
      const dateStr = fmtDateTime(c.createdAt).toLowerCase();
      return (
        (gameFilter === "all" || c.game === gameFilter) &&
        (sourceFilter === "all" || c.source === sourceFilter) &&
        (!q || (c.game ?? "").toLowerCase().includes(q) || pathBase(c.path).toLowerCase().includes(q) ||
          dateStr.includes(q))
      );
    });
    switch (sort) {
      case "oldest":
        return out.sort((a, b) => a.createdAt - b.createdAt);
      case "duration":
        return out.sort((a, b) => b.durationMs - a.durationMs);
      case "size":
        return out.sort((a, b) => b.sizeBytes - a.sizeBytes);
      case "game":
        return out.sort((a, b) => (a.game ?? "").localeCompare(b.game ?? ""));
      case "favorites":
        return out.sort((a, b) => b.protected - a.protected || b.createdAt - a.createdAt);
      default: // newest
        return out.sort((a, b) => b.createdAt - a.createdAt);
    }
  }, [clips, gameFilter, sourceFilter, search, sort]);

  return (
    <div className="library">
      <div className="toolbar">
        <label className="search">
          <Icon name="search" size={15} />
          <input type="search" placeholder="Search clips…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <select className="select" value={gameFilter} onChange={(e) => setGameFilter(e.target.value)}>
          <option value="all">All games</option>
          {games.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
        <select className="select" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
          <option value="all">All sources</option>
          <option value="clip">Clips</option>
          <option value="recording">Recordings</option>
          <option value="edited">Edited</option>
        </select>
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <span className="spacer" />
        <span className="chip num">{filtered.length} {filtered.length === 1 ? "clip" : "clips"}</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Icon name="aperture" size={30} />}
          title="No clips yet"
        >
          Hit your <strong>Save clip</strong> hotkey to pull a replay from the buffer.
        </EmptyState>
      ) : (
        <div className="grid">
          {filtered.map((c) => (
            <ClipCard key={c.id} clip={c} onOpen={() => setSelected(c)} onEdit={() => onOpenEditor(c)} />
          ))}
        </div>
      )}

      {selected && <Viewer clip={selected} onClose={() => setSelected(null)} onEdit={() => { const c = selected; setSelected(null); onOpenEditor(c); }} />}
    </div>
  );
}

function pathBase(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function ClipCard({ clip, onOpen, onEdit }: { clip: ClipRecord; onOpen: () => void; onEdit: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const isFav = clip.protected === 1;
  return (
    <div className="clip card--hover" onClick={onOpen}>
      <div
        className="clip__thumb"
        draggable
        title="Click to play · drag to share"
        onDragStart={(e) => {
          e.preventDefault();
          window.clipforge.startDrag(clip.path, clip.thumb || undefined);
        }}
      >
        {clip.thumb ? <img className="clip__img" src={`file://${clip.thumb}`} alt="" /> : <div className="clip__nothumb"><Icon name="aperture" size={26} /></div>}
        <div className="clip__tags">
          {isFav && <span className="badge badge--fav"><Icon name="star" size={11} /></span>}
          {clip.source === "edited" && <span className="badge badge--edited">Edited</span>}
        </div>
        <span className="badge badge--type">{clip.source}</span>
        <span className="badge badge--dur num">{fmtDuration(clip.durationMs)}</span>
      </div>
      <div className="clip__meta">
        <div className="clip__title">{clip.game ?? "Untagged"}</div>
        <div className="clip__sub">{relativeDate(clip.createdAt)} · {fmtSize(clip.sizeBytes)}</div>
        <div className="clip__time mono">{fmtDateTime(clip.createdAt)}</div>
        <div className="clip__actions" onClick={(e) => e.stopPropagation()}>
          <IconButton size="sm" label="Edit" onClick={onEdit}><Icon name="scissor" size={15} /></IconButton>
          <IconButton size="sm" label={isFav ? "Unfavorite" : "Favorite — keep from auto-delete"} active={isFav}
            className={isFav ? "is-fav" : ""} onClick={() => void window.clipforge.setProtected(clip.id, !isFav)}>
            <Icon name="star" size={15} />
          </IconButton>
          <IconButton size="sm" label="Reveal in Explorer" onClick={() => window.clipforge.revealInExplorer(clip.path)}><Icon name="folderOpen" size={15} /></IconButton>
          {confirming ? (
            <span className="confirm-inline">
              <Button size="sm" variant="danger" onClick={() => void window.clipforge.deleteClip(clip.id)}>Delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            </span>
          ) : (
            <IconButton size="sm" label="Delete" variant="danger" onClick={() => setConfirming(true)}><Icon name="trash" size={15} /></IconButton>
          )}
        </div>
      </div>
    </div>
  );
}

// Viewer modal — reuses the shared Modal. Preserves reveal + one-click export; Edit opens the trim editor.
export function Viewer({ clip, onClose, onEdit }: { clip: ClipRecord; onClose: () => void; onEdit?: () => void }) {
  return (
    <Modal open onClose={onClose} size="lg" title={clip.game ?? "Untagged"}
      sub={<>{relativeDate(clip.createdAt)} · {fmtSize(clip.sizeBytes)} · {fmtDuration(clip.durationMs)}</>}
      foot={<>
        <Button icon={<Icon name="folderOpen" size={15} />} onClick={() => window.clipforge.revealInExplorer(clip.path)}>Reveal in Explorer</Button>
        <span className="spacer" />
        {onEdit && <Button icon={<Icon name="scissor" size={15} />} onClick={onEdit}>Edit</Button>}
        <Button variant="primary" icon={<Icon name="link" size={15} />} onClick={() => { void window.clipforge.startExport(clip.id); onClose(); }}>Export</Button>
      </>}>
      <VideoPlayer src={`file://${clip.path}`} loop />
    </Modal>
  );
}

// Plain <video> with space/arrows — Chromium plays our mp4s natively.
export function VideoPlayer({ src, loop = false }: { src: string; loop?: boolean }) {
  return (
    <video
      src={src}
      controls
      autoPlay
      loop={loop}
      className="player"
      onKeyDown={(e) => {
        const v = e.currentTarget;
        if (e.key === " ") { e.preventDefault(); v.paused ? v.play() : v.pause(); }
        if (e.key === "ArrowRight") v.currentTime = Math.min(v.duration, v.currentTime + 5);
        if (e.key === "ArrowLeft") v.currentTime = Math.max(0, v.currentTime - 5);
      }}
    />
  );
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// "just now" / "5m ago" / "3h ago"; after 24 h fall back to a date.
export function relativeDate(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return fmtDate(ts);
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const withYear = d.getFullYear() !== new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    year: withYear ? "numeric" : undefined,
    month: "short",
    day: "numeric",
  });
}

// Full date + time used for the per-clip tag (auto-tagged with the game).
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}