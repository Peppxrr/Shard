import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { WaveformData } from "../../shared/contracts";
import { Button, ContextMenu, Icon, IconButton } from "../components/ui";
import {
  createRulerTicks,
  zoomScrollOffset,
  createTimelineGeometry,
  editedDuration,
  pixelsPerSecond,
  segmentAtTime,
  timeToPixel,
  type EditorAudioTrack,
  type EditorState,
  type TimelineSegment,
} from "./model";
import { formatEditorTime, mediaFileUrl } from "./VideoPreview";

interface TimelineProps {
  state: EditorState;
  waveforms: Map<number, WaveformData>;
  filmstrip: string[];
  /** Visual playhead position in SOURCE seconds (may sit inside a deleted gap). */
  playhead: number;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  onZoomChange: (zoom: number) => void;
  /**
   * Scrub feedback. `visualTime` is the exact pointer position (source
   * timeline, gaps included); `playbackTime` is the nearest seekable source
   * time for the media preview. Called at pointer-down and every move.
   */
  onScrub: (visualTime: number, playbackTime: number) => void;
  /** Commit the scrubbed position into editor state (pointer-up / cancel). */
  onScrubEnd: (visualTime: number, playbackTime: number) => void;
  onSelectSegment: (segmentId: string) => void;
  onSplit: () => void;
  onDelete: () => void;
  onTrim: (segmentId: string, edge: "start" | "end", sourceTime: number) => void;
  onTrimToPlayhead: () => void;
  onReset: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onTrackChange: (streamIndex: number, change: Partial<Pick<EditorAudioTrack, "included" | "muted" | "volume">>) => void;
  onDeleteAudioTrack?: (streamIndex: number) => void;
  onDeleteAudioSegment?: (streamIndex: number, segmentId: string) => void;
}

interface MenuState {
  x: number;
  y: number;
  kind: "segment" | "audio";
  id: string | number;
  segmentId?: string;
}

export const LABEL_WIDTH = 164;
const AUDIO_KIND_LABEL: Record<EditorAudioTrack["kind"], string> = {
  input: "Microphone",
  output: "Output",
  process: "App audio",
  mix: "Mix",
  unknown: "Audio",
};

function nearestSeekableSourceTime(
  segments: TimelineSegment[],
  visualTime: number,
): number {
  if (!segments.length) return 0;

  const containing = segmentAtTime(segments, visualTime);
  if (containing) {
    return Math.max(
      containing.sourceStart,
      Math.min(containing.sourceEnd, visualTime),
    );
  }

  let previous: TimelineSegment | null = null;
  let next: TimelineSegment | null = null;

  for (const segment of segments) {
    if (segment.sourceEnd < visualTime) {
      previous = segment;
      continue;
    }

    if (segment.sourceStart > visualTime) {
      next = segment;
      break;
    }
  }

  if (!previous) {
    return next?.sourceStart ?? segments[0].sourceStart;
  }

  if (!next) {
    return previous.sourceEnd;
  }

  const previousDistance = visualTime - previous.sourceEnd;
  const nextDistance = next.sourceStart - visualTime;

  return previousDistance <= nextDistance
    ? previous.sourceEnd
    : next.sourceStart;
}
export function Timeline({
  state,
  waveforms,
  filmstrip,
  playhead,
  zoom,
  canUndo,
  canRedo,
  onZoomChange,
  onScrub,
  onScrubEnd,
  onSelectSegment,
  onSplit,
  onDelete,
  onTrim,
  onTrimToPlayhead,
  onReset,
  onUndo,
  onRedo,
  onTrackChange,
  onDeleteAudioTrack,
  onDeleteAudioSegment,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(800);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [activeAudio, setActiveAudio] = useState<number | null>(null);
  const [draftTrim, setDraftTrim] = useState<{ id: string; edge: "start" | "end"; time: number } | null>(null);

  const pxPerSecond = pixelsPerSecond(state.duration, Math.max(1, viewportWidth - LABEL_WIDTH), zoom);
  const timelineWidth = Math.max(viewportWidth - LABEL_WIDTH, state.duration * pxPerSecond);
  const rulerTicks = useMemo(() => createRulerTicks(state.duration, pxPerSecond), [state.duration, pxPerSecond]);

  // The canonical coordinate system: rect of any track surface — one
  // formula shared by scrubbing, trimming, menus, playhead. The surface
  // rect already carries scroll + label offset, so no other terms exist.
  const geometry = useMemo(
    () =>
      createTimelineGeometry(
        () => scrollRef.current?.querySelector<HTMLElement>(".timeline__surface")?.getBoundingClientRect() ?? null,
        state.duration,
        pxPerSecond,
      ),
    [state.duration, pxPerSecond],
  );
  const clientXToTimelineTime = useCallback(
    (clientX: number) => geometry.clientXToTime(clientX),
    [geometry],
  );

  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const updateWidth = () => setViewportWidth(host.clientWidth);
    const observer = new ResizeObserver(updateWidth);
    updateWidth();
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Development-only geometry assertion: verify rendered surface width matches calculated timelineWidth
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const id = requestAnimationFrame(() => {
      const surface = scrollRef.current?.querySelector<HTMLElement>(".timeline__surface");
      if (!surface) return;
      const renderedWidth = surface.getBoundingClientRect().width;
      if (Math.abs(renderedWidth - timelineWidth) > 1) {
        // eslint-disable-next-line no-console
        console.warn("[timeline-geometry] surface width mismatch", {
          renderedWidth,
          timelineWidth,
          pxPerSecond,
          duration: state.duration,
          zoom,
        });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [timelineWidth, pxPerSecond, state.duration, zoom]);

  // One capture owner for the ruler, tracks, and playhead. Only timeline
  // surfaces start a seek: labels, controls, and native scrollbars keep theirs.
  const [scrubbing, setScrubbing] = useState(false);
  const scrubRef = useRef<{ pointerId: number; visual: number; playback: number } | null>(null);
  const scrubCallbacks = useRef({ geometry, segments: state.segments, onScrub, onScrubEnd });
  scrubCallbacks.current = { geometry, segments: state.segments, onScrub, onScrubEnd };
  const finishScrub = useCallback(() => {
    const drag = scrubRef.current;
    if (!drag) return;
    scrubRef.current = null;
    setScrubbing(false);
    const host = scrollRef.current;
    if (host?.hasPointerCapture(drag.pointerId)) host.releasePointerCapture(drag.pointerId);
    scrubCallbacks.current.onScrubEnd(drag.visual, drag.playback);
  }, []);
  const moveScrub = useCallback((event: Pick<PointerEvent, "pointerId" | "clientX" | "buttons">) => {
    const drag = scrubRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!(event.buttons & 1)) { finishScrub(); return; }
    const current = scrubCallbacks.current;
    drag.visual = current.geometry.clientXToTime(event.clientX);
    drag.playback = nearestSeekableSourceTime(current.segments, drag.visual);
    current.onScrub(drag.visual, drag.playback);
  }, [finishScrub]);
  const beginScrub = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    const target = event.target as Element;
    const handle = target.closest(".timeline__playhead-handle");
    if (!handle && (!target.closest(".timeline__surface") || target.closest("button, input, select, textarea, [role=button]"))) return;
    // A fresh down also recovers if the OS swallowed a previous release.
    finishScrub();
    const segment = target.closest(".timeline-segment[data-segment-id]");
    if (segment) onSelectSegment(segment.getAttribute("data-segment-id")!);
    event.preventDefault();
    const visual = geometry.clientXToTime(event.clientX);
    const playback = nearestSeekableSourceTime(state.segments, visual);
    scrubRef.current = { pointerId: event.pointerId, visual, playback };
    setScrubbing(true);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window listeners remain a fallback. */ }
    onScrub(visual, playback);
  }, [finishScrub, geometry, onSelectSegment, onScrub, state.segments]);

  useEffect(() => {
    const end = (event: PointerEvent) => {
      const drag = scrubRef.current;
      if (drag?.pointerId !== event.pointerId) return;
      if (event.type === "pointerup") moveScrub({ pointerId: event.pointerId, clientX: event.clientX, buttons: 1 });
      finishScrub();
    };
    const hidden = () => { if (document.hidden) finishScrub(); };
    window.addEventListener("pointermove", moveScrub);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", finishScrub);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pointermove", moveScrub);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", finishScrub);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [finishScrub, moveScrub]);

  // A geometry change ends the gesture at its last valid source position;
  // old screen coordinates must never be applied to a new zoom level.
  useLayoutEffect(() => { finishScrub(); }, [pxPerSecond, finishScrub]);

  // ------------------------------------------------------------------
  // Trim drag: separate gesture. Owns the pointer via capture on the
  // handle button; updates draft state smoothly; commits once on up.
  // Keeps the exact grabbed point of the trim handle attached to the cursor
  // via pointerOffsetTime.
  // ------------------------------------------------------------------
  const trimDragRef = useRef<{
    active: boolean;
    segmentId: string;
    edge: "start" | "end";
    pointerOffsetTime: number;
  }>({
    active: false,
    segmentId: "",
    edge: "start",
    pointerOffsetTime: 0,
  });
  const beginTrim = useCallback(
    (segment: TimelineSegment, edge: "start" | "end", event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const pointerTime = clientXToTimelineTime(event.clientX);
      const edgeTime = edge === "start" ? segment.sourceStart : segment.sourceEnd;
      trimDragRef.current = {
        active: true,
        segmentId: segment.id,
        edge,
        pointerOffsetTime: pointerTime - edgeTime,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Ignore; see beginScrub.
      }
      setDraftTrim({ id: segment.id, edge, time: edgeTime });
    },
    [clientXToTimelineTime],
  );
  const moveTrim = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, id: string, edge: "start" | "end") => {
      const drag = trimDragRef.current;
      if (!drag.active || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const pointerTime = clientXToTimelineTime(event.clientX);
      const requestedEdgeTime = pointerTime - drag.pointerOffsetTime;
      setDraftTrim({ id, edge, time: requestedEdgeTime });
    },
    [clientXToTimelineTime],
  );
  const finishTrim = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, id: string, edge: "start" | "end") => {
      const drag = trimDragRef.current;
      if (!drag.active || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      trimDragRef.current = {
        active: false,
        segmentId: "",
        edge: "start",
        pointerOffsetTime: 0,
      };
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Implicit release.
      }
      const pointerTime = clientXToTimelineTime(event.clientX);
      const requestedEdgeTime = pointerTime - drag.pointerOffsetTime;
      onTrim(id, edge, requestedEdgeTime);
      setDraftTrim(null);
    },
    [clientXToTimelineTime, onTrim],
  );
  useEffect(() => () => {
    // Unmount safety: never leave stale gesture flags.
    scrubRef.current = null;
    trimDragRef.current = {
      active: false,
      segmentId: "",
      edge: "start",
      pointerOffsetTime: 0,
    };
  }, []);

  useLayoutEffect(() => {
    trimDragRef.current.active = false;
    setDraftTrim(null);
  }, [zoom]);

  const selectedSegment = state.segments.find((segment) => segment.id === state.selectedSegmentId) ?? null;
  const activeTrack = state.audioTracks.find((track) => track.streamIndex === activeAudio) ?? null;

  const cutGaps = useMemo(() => {
    const gaps: { start: number; end: number }[] = [];
    let cursor = 0;
    const sorted = [...state.segments].sort((a, b) => a.sourceStart - b.sourceStart);
    for (const segment of sorted) {
      if (segment.sourceStart > cursor) gaps.push({ start: cursor, end: Math.min(segment.sourceStart, state.duration) });
      cursor = Math.max(cursor, segment.sourceEnd);
    }
    if (cursor < state.duration) gaps.push({ start: cursor, end: state.duration });
    return gaps.filter((gap) => gap.end > gap.start);
  }, [state.segments, state.duration]);

  const pendingScroll = useRef<number | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const handleZoom = useCallback((nextZoom: number, clientX?: number) => {
    const clamped = Math.max(1, Math.min(16, nextZoom));
    if (clamped === zoomRef.current) return;
    finishScrub();
    const host = scrollRef.current;
    if (host) {
      const viewport = Math.max(1, host.clientWidth - LABEL_WIDTH);
      const oldPx = pixelsPerSecond(state.duration, viewport, zoomRef.current);
      const newPx = pixelsPerSecond(state.duration, viewport, clamped);
      const scrollLeft = pendingScroll.current ?? host.scrollLeft;
      const pointerOffset = clientX === undefined ? undefined : Math.max(0, Math.min(viewport, clientX - host.getBoundingClientRect().left - LABEL_WIDTH));
      const visiblePlayhead = playhead * oldPx - scrollLeft;
      const anchorOffset = pointerOffset ?? (visiblePlayhead >= 0 && visiblePlayhead <= viewport ? visiblePlayhead : viewport / 2);
      pendingScroll.current = zoomScrollOffset(scrollLeft, anchorOffset, oldPx, newPx, viewport, state.duration);
    }
    zoomRef.current = clamped;
    onZoomChange(clamped);
  }, [finishScrub, onZoomChange, playhead, state.duration]);
  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
  }, [zoom, timelineWidth]);
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault(); // Prevent Chromium page zoom; ordinary wheel still scrolls.
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1);
      handleZoom(zoomRef.current * Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.003), event.clientX);
    };
    host.addEventListener("wheel", wheel, { passive: false });
    return () => host.removeEventListener("wheel", wheel);
  }, [handleZoom]);
  const handleFit = () => {
    finishScrub();
    pendingScroll.current = zoomRef.current === 1 ? null : 0;
    zoomRef.current = 1;
    onZoomChange(1);
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  };

  return (
    <section className="timeline" aria-label="Clip timeline">
      <header className="timeline__toolbar">
        <div className="timeline__toolbar-group">
          <Button size="sm" icon={<Icon name="scissor" size={14} />} onClick={onSplit} disabled={!selectedSegment}>Split</Button>
          <Button size="sm" variant="danger" icon={<Icon name="trash" size={14} />} onClick={onDelete} disabled={!selectedSegment}>Delete</Button>
          <span className="timeline__divider" />
          <IconButton size="sm" label="Undo (Ctrl+Z)" onClick={onUndo} disabled={!canUndo}><Icon name="undo" size={15} /></IconButton>
          <IconButton size="sm" label="Redo (Ctrl+Y)" onClick={onRedo} disabled={!canRedo}><Icon name="redo" size={15} /></IconButton>
        </div>
        <div className="timeline__summary num">
          {state.segments.length} segment{state.segments.length === 1 ? "" : "s"} · {formatEditorTime(editedDuration(state.segments), true)}
        </div>
        <div className="timeline__toolbar-group">
          <IconButton size="sm" label="Zoom out" onClick={() => handleZoom(zoom / 1.4)} disabled={zoom <= 1}><Icon name="zoomOut" size={15} /></IconButton>
          <span className="timeline__zoom num">{Math.round(zoom * 100)}%</span>
          <IconButton size="sm" label="Zoom in" onClick={() => handleZoom(zoom * 1.4)} disabled={zoom >= 16}><Icon name="zoomIn" size={15} /></IconButton>
          <Button size="sm" variant="ghost" icon={<Icon name="fit" size={14} />} onClick={handleFit}>Fit</Button>
        </div>
      </header>

      <div
        className={`timeline__scroll${scrubbing ? " is-scrubbing" : ""}`}
        ref={scrollRef}
        onPointerDown={beginScrub}
        onLostPointerCapture={(event) => {
          if (event.target === event.currentTarget && scrubRef.current?.pointerId === event.pointerId) finishScrub();
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="timeline__content" style={{ width: LABEL_WIDTH + timelineWidth }}>
          <div className="timeline__row timeline__row--ruler">
            <div className="timeline__label timeline__label--ruler">SOURCE TIME</div>
            <div className="timeline__surface timeline__ruler" style={{ width: timelineWidth }}>
              {rulerTicks.map(({ time, label }) => (
                <span key={time} className={`timeline__tick${label === null ? " is-minor" : ""}`} style={{ left: timeToPixel(time, pxPerSecond) }}>
                  <i />
                  {label !== null && <b className="num">{label}</b>}
                </span>
              ))}
            </div>
          </div>

          <div className="timeline__row timeline__row--video">
            <div className="timeline__label">
              <Icon name="screen" size={15} />
              <span><strong>Video</strong><small>{state.segments.length ? "Edited source" : "No retained video"}</small></span>
            </div>
            <div className="timeline__surface timeline__video-track" style={{ width: timelineWidth }}>
              {filmstrip.length > 0 && (
                <span className="timeline__filmstrip">
                  {filmstrip.map((frame, index) => (
                    <span key={index} className="timeline__frame">
                      {frame && <img src={mediaFileUrl(frame)} alt="" draggable={false} />}
                    </span>
                  ))}
                </span>
              )}
              {cutGaps.map((gap, index) => (
                <span key={index} className="timeline__cut"
                  style={{ left: timeToPixel(gap.start, pxPerSecond), width: (gap.end - gap.start) * pxPerSecond }} />
              ))}
              {state.segments.map((segment, index) => {
                const draft = draftTrim?.id === segment.id ? draftTrim : null;
                const start = draft?.edge === "start" ? Math.max(segment.sourceMin, Math.min(draft.time, segment.sourceEnd - 0.05)) : segment.sourceStart;
                const end = draft?.edge === "end" ? Math.min(segment.sourceMax, Math.max(draft.time, segment.sourceStart + 0.05)) : segment.sourceEnd;
                const selected = segment.id === state.selectedSegmentId;
                return (
                  <div
                    key={segment.id}
                    data-segment-id={segment.id}
                    className={`timeline-segment${segment.id === state.selectedSegmentId ? " is-selected" : ""}`}
                    style={{ left: timeToPixel(start, pxPerSecond), width: Math.max(2, (end - start) * pxPerSecond) }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelectSegment(segment.id);
                      setMenu({ x: event.clientX, y: event.clientY, kind: "segment", id: segment.id });
                    }}
                  >
                    {selected && (
                      <button
                        className="timeline-segment__handle is-start"
                        aria-label="Trim segment start"
                        onPointerDown={(event) => beginTrim(segment, "start", event)}
                        onPointerMove={(event) => moveTrim(event, segment.id, "start")}
                        onPointerUp={(event) => finishTrim(event, segment.id, "start")}
                        onPointerCancel={() => { trimDragRef.current.active = false; setDraftTrim(null); }}
                        onLostPointerCapture={() => { trimDragRef.current.active = false; setDraftTrim(null); }}
                      />
                    )}
                    <span className="timeline-segment__index">{index + 1}</span>
                    <span className="timeline-segment__duration num">{formatEditorTime(end - start, true)}</span>
                    {selected && (
                      <button
                        className="timeline-segment__handle is-end"
                        aria-label="Trim segment end"
                        onPointerDown={(event) => beginTrim(segment, "end", event)}
                        onPointerMove={(event) => moveTrim(event, segment.id, "end")}
                        onPointerUp={(event) => finishTrim(event, segment.id, "end")}
                        onPointerCancel={() => { trimDragRef.current.active = false; setDraftTrim(null); }}
                        onLostPointerCapture={() => { trimDragRef.current.active = false; setDraftTrim(null); }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {state.audioTracks.map((track) => (
            <div key={track.streamIndex} className={`timeline__row timeline__row--audio${activeAudio === track.streamIndex ? " is-active" : ""}${track.muted ? " is-muted" : ""}${!track.included ? " is-excluded" : ""}`}>
              <div
                className="timeline__label timeline__audio-label"
                onClick={() => setActiveAudio(track.streamIndex)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setActiveAudio(track.streamIndex);
                  // Canonical conversion — the label sits OUTSIDE the
                  // surfaces, so only geometry knows the right time.
                  const t = clientXToTimelineTime(event.clientX);
                  const seg = segmentAtTime(state.segments, t);
                  setMenu({ x: event.clientX, y: event.clientY, kind: "audio", id: track.streamIndex, segmentId: seg?.id });
                }}
              >
                <IconButton size="sm" label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`} active={track.muted} onClick={(event) => { event.stopPropagation(); onTrackChange(track.streamIndex, { muted: !track.muted }); }}>
                  <Icon name={track.muted ? "volumeOff" : "speaker"} size={14} />
                </IconButton>
                <span className="timeline__track-name"><strong title={track.name}>{track.name}</strong><small>{AUDIO_KIND_LABEL[track.kind]} · {track.codec} · {track.channels || "?"} ch</small></span>
                <input
                  type="checkbox"
                  checked={track.included}
                  title="Include track in export"
                  aria-label={`Include ${track.name} in export`}
                  onChange={(event) => onTrackChange(track.streamIndex, { included: event.target.checked })}
                />
              </div>
              <div
                className="timeline__surface timeline__audio-track"
                style={{ width: timelineWidth }}
                data-stream-index={track.streamIndex}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setActiveAudio(track.streamIndex);
                  const t = clientXToTimelineTime(event.clientX);
                  const seg = segmentAtTime(state.segments, t);
                  if (seg) onSelectSegment(seg.id);
                  setMenu({ x: event.clientX, y: event.clientY, kind: "audio", id: track.streamIndex, segmentId: seg?.id });
                }}
              >
                {(() => {
                  const excluded = track.excludedSegments ?? [];
                  const effective = state.segments.filter((s) => !excluded.includes(s.id));
                  return (
                    <>
                      <Waveform waveform={waveforms.get(track.streamIndex)} muted={track.muted || !track.included} segments={effective} />
                      {effective.map((segment) => {
                        const isSelected = segment.id === state.selectedSegmentId;
                        return (
                          <span
                            key={segment.id}
                            className={`timeline__audio-kept${isSelected ? " is-selected" : ""}`}
                            style={{ left: timeToPixel(segment.sourceStart, pxPerSecond), width: (segment.sourceEnd - segment.sourceStart) * pxPerSecond }}
                          />
                        );
                      })}
                    </>
                  );
                })()}
              </div>
            </div>
          ))}

          {!state.audioTracks.length && (
            <div className="timeline__row timeline__row--empty">
              <div className="timeline__label"><Icon name="volumeOff" size={15} /><span><strong>No audio</strong><small>Video-only export</small></span></div>
              <div className="timeline__surface timeline__empty-audio" style={{ width: timelineWidth }}>This clip has no audio streams.</div>
            </div>
          )}

          {/* ONE global playhead spanning ruler + video + all audio rows.
              Positioned in content space; the surfaces start after the
              LABEL_WIDTH sticky column, so that offset is part of the
              transform — otherwise the playhead leads/trails the pointer
              by exactly the label width. */}
          <div
            className={`timeline__playhead${scrubbing ? " is-dragging" : ""}`}
            style={{ transform: `translateX(${LABEL_WIDTH + playhead * pxPerSecond}px)` }}
          >
            <span className="timeline__playhead-line" />
            <button
              type="button"
              className="timeline__playhead-handle"
              aria-label="Playhead — drag to reposition"
              title="Playhead — drag to reposition"
            />
          </div>
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.kind === "segment" ? (
            <>
              <button role="menuitem" onClick={() => { onSplit(); setMenu(null); }}><Icon name="scissor" size={14} />Split at playhead <kbd>S</kbd></button>
              <button role="menuitem" onClick={() => { onTrimToPlayhead(); setMenu(null); }}>Trim nearest edge to playhead</button>
              <button role="menuitem" className="is-danger" onClick={() => { onDelete(); setMenu(null); }}><Icon name="trash" size={14} />Delete segment <kbd>Del</kbd></button>
              <span className="editor-context__rule" />
              <button role="menuitem" onClick={() => { onReset(); setMenu(null); }}>Reset timeline</button>
            </>
          ) : activeTrack ? (
            <>
              <button role="menuitem" onClick={() => { onTrackChange(activeTrack.streamIndex, { muted: !activeTrack.muted }); setMenu(null); }}>{activeTrack.muted ? "Unmute track" : "Mute track"}</button>
              <button role="menuitem" onClick={() => { onTrackChange(activeTrack.streamIndex, { included: !activeTrack.included }); setMenu(null); }}>{activeTrack.included ? "Exclude from export" : "Include in export"}</button>
              <button role="menuitem" onClick={() => { onTrackChange(activeTrack.streamIndex, { volume: 1 }); setMenu(null); }}>Reset track volume</button>
              {state.segments.length <= 1 ? (
                <button role="menuitem" className="is-danger" onClick={() => { if (onDeleteAudioTrack) onDeleteAudioTrack(activeTrack.streamIndex); setMenu(null); }}><Icon name="trash" size={14} />Delete track</button>
              ) : (
                <button role="menuitem" className="is-danger" onClick={() => {
                  const targetId = menu.segmentId ?? state.selectedSegmentId;
                  if (targetId && onDeleteAudioSegment) {
                    onDeleteAudioSegment(activeTrack.streamIndex, targetId);
                  }
                  setMenu(null);
                }}><Icon name="trash" size={14} />Delete section</button>
              )}
              <label className="editor-context__volume">Volume <input className="volume-slider" type="range" min={0} max={2} step={0.05} value={activeTrack.volume} style={volumeSliderStyle(activeTrack.volume, 2)} onChange={(event) => onTrackChange(activeTrack.streamIndex, { volume: Number(event.target.value) })} /><span className="num">{Math.round(activeTrack.volume * 100)}%</span></label>
            </>
          ) : null}
        </ContextMenu>
      )}
    </section>
  );
}

function volumeSliderStyle(value: number, max: number): CSSProperties {
  return {
    "--range-progress": `${Math.max(0, Math.min(100, (value / max) * 100))}%`,
    "--range-color": value > 1 ? "var(--danger)" : "var(--accent)",
  } as CSSProperties;
}

const Waveform = memo(function Waveform({
  waveform,
  muted,
  segments,
}: {
  waveform?: WaveformData;
  muted: boolean;
  segments: TimelineSegment[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !waveform) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    const middle = height / 2;
    const step = waveform.peaks.length / width;
    const nonSilent = waveform.peaks.filter((peak) => peak > 0.0001).sort((a, b) => a - b);
    const referencePeak = nonSilent.length ? nonSilent[Math.floor((nonSilent.length - 1) * 0.95)] : 1;
    for (let x = 0; x < width; x++) {
      const start = Math.floor(x * step);
      const end = Math.max(start + 1, Math.floor((x + 1) * step));
      let peak = 0;
      for (let i = start; i < end && i < waveform.peaks.length; i++) peak = Math.max(peak, waveform.peaks[i]);
      const amplitude = Math.max(1, Math.min(1, peak / Math.max(0.0001, referencePeak)) * (middle - 2));
      const sourceTime = ((x + 0.5) / width) * waveform.duration;
      const kept = segments.some((segment) => sourceTime >= segment.sourceStart && sourceTime <= segment.sourceEnd);
      context.fillStyle = muted
        ? (kept ? "rgba(118, 127, 147, .42)" : "rgba(118, 127, 147, .10)")
        : (kept ? "rgba(91, 157, 255, .82)" : "rgba(91, 157, 255, .14)");
      context.fillRect(x, middle - amplitude, 1, amplitude * 2);
    }
  }, [muted, segments, waveform]);
  if (!waveform) return <span className="timeline__waveform-loading">Generating waveform…</span>;
  return <canvas ref={canvasRef} className="timeline__waveform" width={Math.min(4000, Math.max(800, waveform.peaks.length))} height={48} />;
});
