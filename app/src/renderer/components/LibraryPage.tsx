import { useEffect, useMemo, useState } from "react";
import type { ClipRecord } from "../../shared/contracts";

interface Props {
  clips: ClipRecord[];
  onOpenEditor: (c: ClipRecord) => void;
}

type SortKey = "newest" | "oldest" | "duration" | "size" | "game" | "favorites";

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
      <div className="filters">
        <input
          className="search"
          type="search"
          placeholder="Search clips…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={gameFilter} onChange={(e) => setGameFilter(e.target.value)}>
          <option value="all">All games</option>
          {games.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
          <option value="all">All sources</option>
          <option value="clip">Clips</option>
          <option value="recording">Recordings</option>
          <option value="edited">Edited</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="favorites">Favorites first</option>
          <option value="duration">Longest first</option>
          <option value="size">Largest first</option>
          <option value="game">By game</option>
        </select>
        <span className="count">{filtered.length} clips</span>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <h2>No clips yet</h2>
          <p>Press F8 to save the last minute, or F9 for the last 5 minutes.</p>
        </div>
      ) : (
        <div className="grid">
          {filtered.map((c) => (
            <ClipCard key={c.id} clip={c} onOpen={() => setSelected(c)} onEdit={() => onOpenEditor(c)} />
          ))}
        </div>
      )}

      {selected && <Viewer clip={selected} onClose={() => setSelected(null)} />}
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
    <div className="card" onClick={onOpen}>
      <div
        className="thumb"
        draggable
        title="Click to play · drag to share (Discord/Explorer)"
        onDragStart={(e) => {
          e.preventDefault();
          window.clipforge.startDrag(clip.path, clip.thumb || undefined);
        }}
      >
        {clip.thumb ? <img src={`file://${clip.thumb}`} alt="" /> : <div className="no-thumb" />}
        {isFav && <span className="badge protected">★</span>}
        {clip.source === "edited" && <span className="badge edited">✂ Edited</span>}
        <span className="badge source">{clip.source}</span>
        <span className="badge dur">{fmtDuration(clip.durationMs)}</span>
      </div>
      <div className="card-meta">
        <div className="card-title">{clip.game ?? "Untagged"}</div>
        <div className="card-sub">
          {relativeDate(clip.createdAt)} · {fmtSize(clip.sizeBytes)}
        </div>
        <div className="card-time">{fmtDateTime(clip.createdAt)}</div>
        <div className="card-actions" onClick={(e) => e.stopPropagation()}>
          <button title="Edit" onClick={onEdit}>✂</button>
          <button
            title={isFav ? "Unfavorite" : "Favorite (keep from auto-delete)"}
            className={isFav ? "fav active" : "fav"}
            onClick={() => void window.clipforge.setProtected(clip.id, !isFav)}
          >
            {isFav ? "★" : "☆"}
          </button>
          <button title="Reveal in Explorer" onClick={() => window.clipforge.revealInExplorer(clip.path)}>📁</button>
          {confirming ? (
            <>
              <button className="danger" onClick={() => void window.clipforge.deleteClip(clip.id)}>Yes</button>
              <button onClick={() => setConfirming(false)}>No</button>
            </>
          ) : (
            <button title="Delete" onClick={() => setConfirming(true)}>🗑</button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Viewer({ clip, onClose }: { clip: ClipRecord; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body viewer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{clip.game ?? "Untagged"}</strong>
          <button onClick={onClose}>×</button>
        </div>
        <VideoPlayer src={`file://${clip.path}`} loop />
        <div className="modal-foot">
          <button onClick={() => window.clipforge.revealInExplorer(clip.path)}>Reveal in Explorer</button>
          <button onClick={() => void window.clipforge.startExport(clip.id)}>Export…</button>
        </div>
      </div>
    </div>
  );
}

// Plain <video> with space/arrows/fullscreen — Chromium plays our mp4s natively.
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
