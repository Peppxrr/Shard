import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipRecord } from "../../shared/contracts";
import { Icon, IconButton, Button, EmptyState, Modal, ShardSelect } from "./ui";
import { mediaFileUrl, StandaloneVideoPlayer } from "../editor/VideoPreview";
import { ClipRename } from "./ClipRename";

interface Props {
  clips: ClipRecord[];
  onOpenEditor: (c: ClipRecord) => void;
  /** File path to open in the viewer once the library lists it (e.g. a fresh export). */
  openPath?: string | null;
  onOpenedPath?: () => void;
}

type SortKey = "newest" | "oldest" | "duration" | "size" | "game" | "favorites";
type SourceFilter = "all" | "favorites" | ClipRecord["source"];
const SOURCES: { value: SourceFilter; label: string }[] = [
  { value: "all", label: "All clips" },
  { value: "clip", label: "Clips" },
  { value: "recording", label: "Recordings" },
  { value: "edited", label: "Edits" },
  { value: "favorites", label: "Favorites" },
];
const SOURCE_NAMES = { clip: "Clip", recording: "Recording", edited: "Edited Clip" };

const SORTS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "favorites", label: "Favorites first" },
  { value: "duration", label: "Longest first" },
  { value: "size", label: "Largest first" },
  { value: "game", label: "By game" },
];

export function LibraryPage({ clips, onOpenEditor, openPath, onOpenedPath }: Props) {
  const [gameFilter, setGameFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = clips.find((clip) => clip.id === selectedId);
  // A fresh export reaches the list via the folder watcher; open it as soon as it appears.
  useEffect(() => {
    if (!openPath) return;
    const wanted = openPath.replace(/\\/g, "/").toLowerCase();
    const match = clips.find((clip) => clip.path.replace(/\\/g, "/").toLowerCase() === wanted);
    if (!match) return;
    setSelectedId(match.id);
    onOpenedPath?.();
  }, [clips, onOpenedPath, openPath]);
  const totalSize = useMemo(() => clips.reduce((total, clip) => total + clip.sizeBytes, 0), [clips]);
  const counts = useMemo(() => ({
    all: clips.length,
    clip: clips.filter((clip) => clip.source === "clip").length,
    recording: clips.filter((clip) => clip.source === "recording").length,
    edited: clips.filter((clip) => clip.source === "edited").length,
    favorites: clips.filter((clip) => clip.protected === 1).length,
  }), [clips]);

  const games = useMemo(() => {
    const set = new Set<string>();
    clips.forEach((c) => c.game && set.add(c.game));
    return [...set].sort();
  }, [clips]);
  const gameOptions = useMemo(() => games.map((game) => ({
    value: game,
    label: game.length > 28 ? `${game.slice(0, 27)}…` : game,
  })), [games]);
  const hasFilters = gameFilter !== "all" || sourceFilter !== "all" || !!search.trim();
  const resetFilters = () => {
    setGameFilter("all"); setSourceFilter("all"); setSearch("");
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = clips.filter((c) => {
      const dateStr = fmtDateTime(c.createdAt).toLowerCase();
      return (
        (gameFilter === "all" || c.game === gameFilter) &&
        (sourceFilter === "all" || (sourceFilter === "favorites" ? c.protected === 1 : c.source === sourceFilter)) &&
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
    <div data-shard-page="library" className="library">
      <header data-shard-slot="library-header" className="library__header">
        <div data-shard-slot="library-heading">
          <h1 className="page__title">Library</h1>
        </div>
        <div data-shard-slot="library-header-actions" className="library__header-actions">
          <div data-shard-slot="library-summary" className="library__summary">
            <Icon name="film" size={16} />
            <span><strong className="num">{clips.length}</strong> {clips.length === 1 ? "clip" : "clips"}</span>
            <span aria-hidden="true">·</span><span className="num">{fmtSize(totalSize)}</span>
          </div>
        </div>
      </header>
      <div data-shard-slot="library-navigation" className="library__navigation">
        <div data-shard-component="library-filters" className="library__sources" role="group" aria-label="Library tabs">
          {SOURCES.map((source) => <button key={source.value} type="button"
            data-shard-slot="library-source-filter" data-source={source.value}
            className="library__source" aria-pressed={sourceFilter === source.value} onClick={() => setSourceFilter(source.value)}>
            {source.label}<span data-shard-slot="library-filter-count" className="num">{counts[source.value]}</span>
          </button>)}
        </div>
      </div>
      <div data-shard-slot="toolbar" className="toolbar library__toolbar">
        <label data-shard-slot="library-search" className="search library__search">
          <Icon name="search" size={15} />
          <input type="search" aria-label="Search clips" placeholder="Search by game, date, or filename" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <ShardSelect
          ariaLabel="Filter by game" className="library__game-filter"
          value={gameFilter}
          onChange={setGameFilter}
          options={[{ value: "all", label: "All games" }, ...gameOptions]}
        />
        <ShardSelect
          ariaLabel="Sort clips" className="library__sort"
          value={sort}
          onChange={(v) => setSort(v as SortKey)}
          options={SORTS}
        />
        {hasFilters && <Button variant="ghost" size="sm" onClick={resetFilters}>Clear filters</Button>}
      </div>

      <div data-shard-slot="library-results">
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Icon name="film" size={30} />}
          title={clips.length ? "No matching clips" : "No clips yet"}
          action={hasFilters ? <Button onClick={resetFilters}>Clear filters</Button> : undefined}
        >
          {clips.length ? "Try another search or change your filters." : <>Use your <strong>Save clip</strong> hotkey to save a replay here.</>}
        </EmptyState>
      ) : (
        <div data-shard-slot="clip-grid" className="grid library__grid">
          {filtered.map((c) => (
            <ClipCard key={c.id} clip={c} onOpen={() => setSelectedId(c.id)} onEdit={() => onOpenEditor(c)} />
          ))}
        </div>
      )}
      </div>

      {selected && <Viewer clip={selected} onClose={() => setSelectedId(null)} onEdit={(clip) => { setSelectedId(null); onOpenEditor(clip); }} />}
    </div>
  );
}

function pathBase(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function ClipCard({ clip, onOpen, onEdit }: { clip: ClipRecord; onOpen: () => void; onEdit: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isFav = clip.protected === 1;
  const age = relativeAge(clip.createdAt);
  const runAction = async (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true); setError(null);
    try { await action(); setConfirming(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update this clip. Try again."); }
    finally { setPending(false); }
  };
  return (
    <article data-shard-component="clip" data-favorite={isFav} data-source={clip.source} className="clip" aria-busy={pending}>
      <button type="button"
        data-shard-slot="clip-thumbnail" className="clip__thumb" onClick={onOpen}
        aria-label={`Play ${clip.game ?? "untagged clip"}, ${fmtDateTime(clip.createdAt)}`}
        draggable
        title="Click to play · drag to share"
        onDragStart={(e) => {
          e.preventDefault();
          window.shard.startDrag(clip.path, clip.thumb || undefined);
        }}
      >
        {clip.thumb ? <img data-shard-slot="clip-image" className="clip__img" src={mediaFileUrl(clip.thumb)} alt="" draggable={false} /> : <span data-shard-slot="clip-placeholder" className="clip__nothumb"><Icon name="film" size={26} /></span>}
        <span data-shard-slot="clip-play" className="clip__play" aria-hidden="true"><Icon name="play" size={24} /></span>
        <span data-shard-slot="clip-source" className="clip__source">{SOURCE_NAMES[clip.source]}</span>
        <span data-shard-slot="clip-duration" className="badge badge--dur num">{fmtDuration(clip.durationMs)}</span>
      </button>
      <div data-shard-slot="clip-details" className="clip__meta">
        <div data-shard-slot="clip-heading" className="clip__heading">
          <button type="button" data-shard-slot="clip-title" className="clip__title" onClick={onOpen}>{clip.game ?? "Untagged"}</button>
          <IconButton size="sm" label={isFav ? "Unfavorite" : "Favorite — keep from auto-delete"} active={isFav} disabled={pending}
            className={isFav ? "is-fav" : ""} onClick={() => void runAction(() => window.shard.setProtected(clip.id, !isFav))}>
            <Icon name="star" size={15} />
          </IconButton>
        </div>
        <span data-shard-slot="clip-filename" className="clip__filename" title={pathBase(clip.path)}>{pathBase(clip.path)}</span>
        <div className="clip__metadata-line">
          <time data-shard-slot="clip-date" className="clip__time" title={age || undefined} dateTime={new Date(clip.createdAt).toISOString()}>{fmtDateTime(clip.createdAt)}</time>
          <span data-shard-slot="clip-size" className="clip__sub num">{fmtSize(clip.sizeBytes)}</span>
        </div>
      </div>
      <div data-shard-slot="clip-actions" className="clip__actions">
        {confirming ? (
          <div data-shard-slot="clip-delete-confirmation" className="clip__confirm">
            <span>Delete this clip?</span>
            <Button size="sm" variant="danger" loading={pending} onClick={() => void runAction(() => window.shard.deleteClip(clip.id))}>Delete</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        ) : <>
          <Button size="sm" variant="ghost" icon={<Icon name="scissor" size={14} />} onClick={onEdit}>Edit clip</Button>
          <span className="spacer" />
          <IconButton size="sm" label="Reveal in Explorer" onClick={() => window.shard.revealInExplorer(clip.path)}><Icon name="folderOpen" size={15} /></IconButton>
          <IconButton size="sm" label="Delete clip" disabled={pending} onClick={() => setConfirming(true)}><Icon name="trash" size={15} /></IconButton>
        </>}
      </div>
      {error && <p data-shard-slot="clip-error" className="clip__error" role="alert">{error}</p>}
    </article>
  );
}

// Viewer modal — reuses the shared Modal. Preserves reveal + one-click export; Edit opens the trim editor.
export function Viewer({ clip: originalClip, onClose, onEdit }: { clip: ClipRecord; onClose: () => void; onEdit?: (clip: ClipRecord) => void }) {
  const [renamedClip, setRenamedClip] = useState<ClipRecord | null>(null);
  const clip = renamedClip?.id === originalClip.id ? renamedClip : originalClip;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [preparingExport, setPreparingExport] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportWholeClip = async () => {
    if (preparingExport) return;
    setPreparingExport(true);
    setExportError(null);
    try {
      const tracks = await window.shard.probeTracks(clip.id);
      const wholeClip = [{ timelineStart: 0, sourceStart: 0, sourceEnd: clip.durationMs / 1000 }];
      void window.shard.startExport(clip.id, {
        videoClips: wholeClip,
        audioTracks: tracks.map((track) => ({
          streamIndex: track.streamIndex,
          name: track.name,
          included: true,
          muted: false,
          volume: 1,
          clips: wholeClip,
        })),
      }).catch((error: unknown) => console.error("[editor] quick export failed", error));
      onClose();
    } catch (error) {
      setExportError(`Could not prepare export: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPreparingExport(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="lg" variant="clip-viewer"
      title={clip.game ?? "Untagged"} sub={SOURCE_NAMES[clip.source]}>
      <div data-shard-component="clip-viewer" data-source={clip.source} className="clip-viewer">
        <div data-shard-slot="viewer-media" className="clip-viewer__media">
          <StandaloneVideoPlayer sourcePath={clip.path} posterPath={clip.thumb || undefined} loop mediaRef={videoRef} />
        </div>
        <aside data-shard-slot="viewer-details" className="clip-viewer__details" aria-label="Clip details">
          <h2 data-shard-slot="viewer-heading">Clip details</h2>
          <dl data-shard-slot="viewer-metadata" className="clip-viewer__metadata">
            <div data-shard-slot="viewer-date"><dt>Captured</dt><dd>{fmtDateTime(clip.createdAt)}</dd></div>
            <div data-shard-slot="viewer-duration"><dt>Duration</dt><dd className="num">{fmtDuration(clip.durationMs)}</dd></div>
            <div data-shard-slot="viewer-size"><dt>File size</dt><dd className="num">{fmtSize(clip.sizeBytes)}</dd></div>
            {!!clip.width && !!clip.height && <div data-shard-slot="viewer-resolution"><dt>Resolution</dt><dd className="num">{clip.width} × {clip.height}</dd></div>}
            {!!clip.fps && <div data-shard-slot="viewer-framerate"><dt>Frame rate</dt><dd className="num">{Number(clip.fps.toFixed(2))} fps</dd></div>}
          </dl>
          <div data-shard-slot="viewer-actions" className="clip-viewer__actions">
            {onEdit && <Button variant="primary" icon={<Icon name="scissor" size={15} />} onClick={() => onEdit(clip)}>Open in editor</Button>}
            <Button variant={onEdit ? "default" : "primary"} loading={preparingExport} icon={<Icon name="export" size={15} />} onClick={() => void exportWholeClip()}>Export clip</Button>
          </div>
          {exportError && <p data-shard-slot="viewer-error" className="viewer-player__error" role="alert">{exportError}</p>}
          <div data-shard-slot="viewer-file" className="clip-viewer__file">
            <span data-shard-slot="viewer-filename" title={pathBase(clip.path)}>{pathBase(clip.path)}</span>
            <ClipRename clip={clip} onRenamed={setRenamedClip} mediaRef={videoRef} disabled={preparingExport} />
            <Button variant="ghost" size="sm" icon={<Icon name="folderOpen" size={14} />} onClick={() => window.shard.revealInExplorer(clip.path)}>Show in folder</Button>
          </div>
        </aside>
      </div>
    </Modal>
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

// Short relative age while a clip is less than 24 hours old.
function relativeAge(ts: number): string | null {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return null;
}

// Capture's Recent area keeps a short date for older clips.
export function relativeDate(ts: number): string {
  return relativeAge(ts) ?? fmtDate(ts);
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
