import { THEME_CHANGE_EVENT } from "../themeManager";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { WaveformData } from "../../shared/contracts";
import { Button, ContextMenu, Icon, IconButton } from "../components/ui";
import {
  clipAt,
  clipEnd,
  createRulerTicks,
  createTimelineGeometry,
  deleteClip,
  linkAudio,
  moveClip,
  outputDuration,
  owningTrack,
  pixelsPerSecond,
  resetEditorState,
  separateAudio,
  snapOffset,
  snapTargets,
  splitAllTracks,
  splitClip,
  timeToPixel,
  trackClips,
  trimClip,
  trimClipToPlayhead,
  zoomScrollOffset,
  type ClipSelection,
  type ClipTrack,
  type EditorAudioTrack,
  type EditorState,
  type TimelineClip,
} from "./model";
import { formatEditorTime, mediaFileUrl } from "./VideoPreview";

interface TimelineProps {
  state: EditorState;
  waveforms: Map<number, WaveformData>;
  filmstrip: string[];
  /** Playhead position in timeline seconds. */
  playhead: number;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  onZoomChange: (zoom: number) => void;
  /** Live playhead feedback while the pointer scrubs (timeline seconds). */
  onScrub: (time: number) => void;
  /** Commit a playhead position (scrub release or a click on a clip). */
  onScrubEnd: (time: number) => void;
  onSelect: (selection: ClipSelection | null) => void;
  onCommit: (change: (current: EditorState) => EditorState) => void;
  onUndo: () => void;
  onRedo: () => void;
  onTrackChange: (streamIndex: number, change: Partial<Pick<EditorAudioTrack, "included" | "muted" | "volume">>) => void;
  onDeleteAudioTrack: (streamIndex: number) => void;
}

interface MenuState {
  x: number;
  y: number;
  kind: "clip" | "video" | "audio";
  track: ClipTrack;
  clipId?: string;
}

/** One pointer gesture on a clip: slide it, or drag one of its edges. */
interface ClipGesture {
  pointerId: number;
  track: ClipTrack;
  clipId: string;
  edge: "move" | "start" | "end";
  originX: number;
  originTime: number;
  /** Pointer distance from the grabbed edge, so the edge does not jump to the cursor. */
  grab: number;
  origin: TimelineClip;
  moved: boolean;
  targets: number[];
  lastClientX: number;
  /** Last requested clip start (move) or edge time (trim). */
  value: number | null;
}

export const LABEL_WIDTH = 128;
/** Edges within this many pixels lock together; Shift bypasses snapping. */
const SNAP_PX = 8;
/** Pointer travel before a press on a clip becomes a move instead of a click. */
const DRAG_START_PX = 3;
export const AUDIO_KIND_LABEL: Record<EditorAudioTrack["kind"], string> = {
  input: "Microphone",
  output: "Output",
  process: "App audio",
  mix: "Mix",
  unknown: "Audio",
};

/** Per-track palette (`--waveform-1` … `--waveform-6`), stable per audio stream. */
const TRACK_COLOR_FALLBACKS = ["#3fd0b0", "#f5b84a", "#f0729e", "#a991ff", "#8fd35a", "#ff9161"];
function trackColorSlot(track: Pick<EditorAudioTrack, "audioIndex">): number {
  const count = TRACK_COLOR_FALLBACKS.length;
  return ((track.audioIndex % count) + count) % count;
}
export function audioTrackColorStyle(track: Pick<EditorAudioTrack, "audioIndex">): CSSProperties {
  return { "--track-color": `var(--waveform-${trackColorSlot(track) + 1})` } as CSSProperties;
}

/**
 * The collapsed waveform in TIMELINE time: what the export mix contains at
 * each output instant, with every audio clip at its real position (linked
 * or separated). Muted/excluded tracks drop out and volume scales each
 * track. When nothing is audible every track is shown in the muted color
 * so the user still sees that audio exists.
 */
function mixTimeline(
  state: EditorState,
  waveforms: Map<number, WaveformData>,
): { peaks: number[]; binsPerSecond: number; muted: boolean; ranges: { start: number; end: number }[] } | null {
  const ready = state.audioTracks.filter((track) => waveforms.has(track.streamIndex));
  if (!ready.length) return null;
  const audible = ready.filter((track) => track.included && !track.muted && track.volume > 0);
  const sources = audible.length ? audible : ready;
  const binsPerSecond = Math.min(60, Math.max(...sources.map((track) => {
    const waveform = waveforms.get(track.streamIndex)!;
    return waveform.peaks.length / Math.max(0.000001, waveform.duration);
  })));
  // Where any contributing track has a clip, merged into disjoint ranges.
  const ranges: { start: number; end: number }[] = [];
  const spans = sources.flatMap((track) => trackClips(state, track.streamIndex).map((clip) => ({ start: clip.timelineStart, end: clipEnd(clip) })));
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const last = ranges.at(-1);
    if (last && span.start <= last.end + 0.0005) last.end = Math.max(last.end, span.end);
    else ranges.push({ ...span });
  }
  const length = ranges.at(-1)?.end ?? 0;
  const bins = Math.max(1, Math.ceil(length * binsPerSecond));
  const peaks = new Array<number>(bins).fill(0);
  const trackPeaks = new Float32Array(bins);
  for (const track of sources) {
    const waveform = waveforms.get(track.streamIndex)!;
    const scale = waveform.peaks.length / Math.max(0.000001, waveform.duration);
    trackPeaks.fill(0);
    for (const clip of trackClips(state, track.streamIndex)) {
      const end = clipEnd(clip);
      for (let bin = Math.floor(clip.timelineStart * binsPerSecond); bin < Math.min(bins, Math.ceil(end * binsPerSecond)); bin++) {
        const sourceFrom = clip.sourceStart + Math.max(bin / binsPerSecond, clip.timelineStart) - clip.timelineStart;
        const sourceTo = clip.sourceStart + Math.min((bin + 1) / binsPerSecond, end) - clip.timelineStart;
        if (sourceTo <= sourceFrom) continue;
        const first = Math.floor(sourceFrom * scale);
        const last = Math.min(waveform.peaks.length, Math.max(first + 1, Math.ceil(sourceTo * scale)));
        for (let index = first; index < last; index++) trackPeaks[bin] = Math.max(trackPeaks[bin], waveform.peaks[index]);
      }
    }
    const gain = audible.length ? track.volume : 1;
    for (let bin = 0; bin < bins; bin++) peaks[bin] += trackPeaks[bin] * gain;
  }
  return { peaks, binsPerSecond, muted: !audible.length, ranges };
}

/** 95th-percentile peak: one loudness reference per track so every clip of it is scaled alike. */
function referencePeak(peaks: number[]): number {
  const nonSilent = peaks.filter((peak) => peak > 0.0001).sort((a, b) => a - b);
  return nonSilent.length ? nonSilent[Math.floor((nonSilent.length - 1) * 0.95)] : 1;
}

/**
 * Cached source-range slices of a peaks array. Stable identities keep the
 * memoized canvases from repainting on every playhead frame.
 */
function usePeakSlices() {
  const cache = useRef(new WeakMap<number[], Map<string, number[]>>());
  return useCallback((peaks: number[], duration: number, start: number, end: number): number[] => {
    let slices = cache.current.get(peaks);
    if (!slices) {
      slices = new Map();
      cache.current.set(peaks, slices);
    }
    const key = `${start}:${end}`;
    let slice = slices.get(key);
    if (!slice) {
      // Exactly the requested range; time past the data reads as silence so
      // the canvas always spans its element without stretching.
      const scale = peaks.length / Math.max(0.000001, duration);
      const first = Math.max(0, Math.floor(start * scale));
      slice = Array.from({ length: Math.max(1, Math.ceil(end * scale) - first) }, (_, index) => peaks[first + index] ?? 0);
      if (slices.size > 256) slices.clear();
      slices.set(key, slice);
    }
    return slice;
  }, []);
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
  onSelect,
  onCommit,
  onUndo,
  onRedo,
  onTrackChange,
  onDeleteAudioTrack,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(800);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [activeAudio, setActiveAudio] = useState<number | null>(null);
  // Expanded separated audio rows (view only; never part of edit history).
  const [audioExpanded, setAudioExpanded] = useState(false);
  // While a clip is dragged the timeline renders this draft; the edit is
  // committed once on release. `guide` marks the time an edge snapped to.
  const [draft, setDraft] = useState<{ state: EditorState; clipId: string; moving: boolean; guide: number | null } | null>(null);
  const view = draft?.state ?? state;

  // Room after the last clip so a clip can be pushed later (leaving black
  // before it). Derived from committed state so the scale is stable mid-drag.
  const viewLength = useMemo(
    () => Math.max(state.duration, outputDuration(state)) + Math.max(1, state.duration * 0.1),
    [state],
  );
  const pxPerSecond = pixelsPerSecond(viewLength, Math.max(1, viewportWidth - LABEL_WIDTH), zoom);
  const timelineWidth = Math.max(viewportWidth - LABEL_WIDTH, viewLength * pxPerSecond);
  const rulerTicks = useMemo(() => createRulerTicks(viewLength, pxPerSecond), [viewLength, pxPerSecond]);

  // The canonical coordinate system: rect of any track surface — one
  // formula shared by scrubbing, dragging, menus, playhead. The surface
  // rect already carries scroll + label offset, so no other terms exist.
  const geometry = useMemo(
    () =>
      createTimelineGeometry(
        () => scrollRef.current?.querySelector<HTMLElement>(".timeline__surface")?.getBoundingClientRect() ?? null,
        viewLength,
        pxPerSecond,
      ),
    [viewLength, pxPerSecond],
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
        console.warn("[timeline-geometry] surface width mismatch", { renderedWidth, timelineWidth, pxPerSecond, viewLength, zoom });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [timelineWidth, pxPerSecond, viewLength, zoom]);

  // Latest values for window-level gesture listeners.
  const latest = useRef({ state, geometry, playhead, viewLength, onScrub, onScrubEnd, onCommit });
  latest.current = { state, geometry, playhead, viewLength, onScrub, onScrubEnd, onCommit };

  // ------------------------------------------------------------------
  // Scrubbing: the ruler, empty track space, and the playhead handle.
  // ------------------------------------------------------------------
  const [scrubbing, setScrubbing] = useState(false);
  const scrubRef = useRef<{ pointerId: number; time: number } | null>(null);
  const finishScrub = useCallback(() => {
    const drag = scrubRef.current;
    if (!drag) return;
    scrubRef.current = null;
    setScrubbing(false);
    const host = scrollRef.current;
    if (host?.hasPointerCapture(drag.pointerId)) host.releasePointerCapture(drag.pointerId);
    latest.current.onScrubEnd(drag.time);
  }, []);
  const moveScrub = useCallback((event: Pick<PointerEvent, "pointerId" | "clientX" | "buttons">) => {
    const drag = scrubRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!(event.buttons & 1)) { finishScrub(); return; }
    drag.time = latest.current.geometry.clientXToTime(event.clientX);
    latest.current.onScrub(drag.time);
  }, [finishScrub]);

  // ------------------------------------------------------------------
  // Clip gestures: press-drag on a clip body slides it; dragging a white
  // edge handle trims it. Edges snap to every other clip edge, the
  // playhead, and 0 unless Shift is held.
  // ------------------------------------------------------------------
  const clipGestureRef = useRef<ClipGesture | null>(null);
  const updateClipGesture = useCallback((clientX: number, bypassSnap: boolean) => {
    const gesture = clipGestureRef.current;
    if (!gesture) return;
    gesture.lastClientX = clientX;
    const { state: base, geometry: geo, viewLength: length } = latest.current;
    const time = geo.clientXToTime(clientX);
    const threshold = SNAP_PX / geo.pxPerSecond;
    const near = (a: number, b: number) => Math.abs(a - b) < 0.0005;
    if (gesture.edge === "move") {
      if (!gesture.moved) {
        if (Math.abs(clientX - gesture.originX) < DRAG_START_PX) return;
        gesture.moved = true;
      }
      const clipLength = gesture.origin.sourceEnd - gesture.origin.sourceStart;
      let start = gesture.origin.timelineStart + time - gesture.originTime;
      const snap = bypassSnap ? null : snapOffset([start, start + clipLength], gesture.targets, threshold);
      if (snap?.target != null) start += snap.offset;
      start = Math.max(0, Math.min(length - clipLength, start));
      gesture.value = start;
      const next = moveClip(base, gesture.track, gesture.clipId, start);
      const placed = trackClips(next, gesture.track).find((clip) => clip.id === gesture.clipId);
      const guide = snap?.target != null && placed && (near(placed.timelineStart, snap.target) || near(clipEnd(placed), snap.target)) ? snap.target : null;
      setDraft({ state: next, clipId: gesture.clipId, moving: true, guide });
    } else {
      let edgeTime = time - gesture.grab;
      const snap = bypassSnap ? null : snapOffset([edgeTime], gesture.targets, threshold);
      if (snap?.target != null) edgeTime = snap.target;
      gesture.value = edgeTime;
      const next = trimClip(base, gesture.track, gesture.clipId, gesture.edge, edgeTime);
      const placed = trackClips(next, gesture.track).find((clip) => clip.id === gesture.clipId);
      const landed = placed ? (gesture.edge === "start" ? placed.timelineStart : clipEnd(placed)) : NaN;
      setDraft({ state: next, clipId: gesture.clipId, moving: false, guide: snap?.target != null && near(landed, snap.target) ? snap.target : null });
    }
  }, []);
  const finishClipGesture = useCallback((commit: boolean) => {
    const gesture = clipGestureRef.current;
    if (!gesture) return;
    clipGestureRef.current = null;
    const host = scrollRef.current;
    if (host?.hasPointerCapture(gesture.pointerId)) host.releasePointerCapture(gesture.pointerId);
    setDraft(null);
    if (!commit) return;
    const { onCommit: commitEdit, onScrubEnd: seek } = latest.current;
    const value = gesture.value;
    if (gesture.edge === "move" && !gesture.moved) seek(gesture.originTime);
    else if (value !== null && gesture.edge === "move") commitEdit((current) => moveClip(current, gesture.track, gesture.clipId, value));
    else if (value !== null && gesture.edge !== "move") {
      const edge = gesture.edge;
      commitEdit((current) => trimClip(current, gesture.track, gesture.clipId, edge, value));
    }
  }, []);

  const beginPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    const target = event.target as Element;
    const clipElement = target.closest<HTMLElement>("[data-clip-id]");
    const handle = target.closest<HTMLElement>("[data-trim-edge]");
    if (clipElement && (handle || !target.closest("button, input, select, textarea, [role=button]"))) {
      const { state: current, geometry: geo, playhead: head } = latest.current;
      const trackValue = clipElement.dataset.clipTrack;
      const track: ClipTrack = trackValue === "video" ? "video" : Number(trackValue);
      const clipId = clipElement.dataset.clipId!;
      const origin = trackClips(current, track).find((clip) => clip.id === clipId);
      if (!origin) return;
      finishScrub();
      event.preventDefault();
      onSelect({ track: owningTrack(current, track), clipId });
      if (typeof track === "number") setActiveAudio(track);
      const edge = (handle?.dataset.trimEdge as "start" | "end" | undefined) ?? "move";
      const time = geo.clientXToTime(event.clientX);
      clipGestureRef.current = {
        pointerId: event.pointerId,
        track,
        clipId,
        edge,
        originX: event.clientX,
        originTime: time,
        grab: edge === "start" ? time - origin.timelineStart : edge === "end" ? time - clipEnd(origin) : 0,
        origin,
        moved: false,
        targets: snapTargets(current, track, clipId, head),
        lastClientX: event.clientX,
        value: null,
      };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window listeners remain a fallback. */ }
      if (edge !== "move") updateClipGesture(event.clientX, event.shiftKey);
      return;
    }
    const playheadHandle = target.closest(".timeline__playhead-handle");
    if (!playheadHandle && (!target.closest(".timeline__surface") || target.closest("button, input, select, textarea, [role=button]"))) return;
    // A fresh down also recovers if the OS swallowed a previous release.
    finishScrub();
    event.preventDefault();
    const time = geometry.clientXToTime(event.clientX);
    scrubRef.current = { pointerId: event.pointerId, time };
    setScrubbing(true);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window listeners remain a fallback. */ }
    onScrub(time);
  }, [finishScrub, geometry, onScrub, onSelect, updateClipGesture]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const gesture = clipGestureRef.current;
      if (gesture?.pointerId === event.pointerId) {
        if (!(event.buttons & 1)) finishClipGesture(true);
        else updateClipGesture(event.clientX, event.shiftKey);
        return;
      }
      moveScrub(event);
    };
    const end = (event: PointerEvent) => {
      if (clipGestureRef.current?.pointerId === event.pointerId) {
        if (event.type === "pointerup") updateClipGesture(event.clientX, event.shiftKey);
        finishClipGesture(event.type === "pointerup");
        return;
      }
      const drag = scrubRef.current;
      if (drag?.pointerId !== event.pointerId) return;
      if (event.type === "pointerup") moveScrub({ pointerId: event.pointerId, clientX: event.clientX, buttons: 1 });
      finishScrub();
    };
    // Pressing or releasing Shift mid-drag re-evaluates snapping in place.
    const shift = (event: KeyboardEvent) => {
      const gesture = clipGestureRef.current;
      if (gesture && event.key === "Shift") updateClipGesture(gesture.lastClientX, event.type === "keydown");
    };
    const blur = () => { finishScrub(); finishClipGesture(false); };
    const hidden = () => { if (document.hidden) blur(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", shift);
    window.addEventListener("keyup", shift);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", shift);
      window.removeEventListener("keyup", shift);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [finishClipGesture, finishScrub, moveScrub, updateClipGesture]);

  // A geometry change ends any gesture; old screen coordinates must never
  // be applied to a new zoom level.
  useLayoutEffect(() => { finishScrub(); finishClipGesture(false); }, [pxPerSecond, finishScrub, finishClipGesture]);
  useEffect(() => () => { scrubRef.current = null; clipGestureRef.current = null; }, []);

  const hasAudio = state.audioTracks.length > 0;
  const separated = hasAudio && !view.audioLinked;
  // Rows show only for separated audio the user has expanded. Collapsing is
  // purely a view change: clips keep their positions and stay separate.
  const showAudioRows = separated && audioExpanded;
  const showMix = hasAudio && !showAudioRows;
  const selection = view.selection;
  const selectedClip = selection ? trackClips(view, selection.track).find((clip) => clip.id === selection.clipId) ?? null : null;
  const canSplit = !!clipAt(view.videoClips, playhead) || (separated && view.audioTracks.some((track) => !!clipAt(track.clips, playhead)));

  // Collapsed audio draws one mixed waveform at the clips' real timeline
  // positions; expanded tracks draw their own.
  const audioMix = useMemo(() => (showMix ? mixTimeline(view, waveforms) : null), [showMix, view, waveforms]);
  const mixLength = audioMix ? audioMix.peaks.length / audioMix.binsPerSecond : 0;
  const mixReference = useMemo(() => (audioMix ? referencePeak(audioMix.peaks) : 1), [audioMix]);
  // Separated audio playing over empty video time, exactly where it plays.
  const audioOnly = useMemo(() => {
    if (!audioMix || view.audioLinked) return [];
    const result: { start: number; end: number }[] = [];
    for (const range of audioMix.ranges) {
      let cursor = range.start;
      for (const clip of view.videoClips) {
        const start = clip.timelineStart;
        const end = clipEnd(clip);
        if (end <= cursor || start >= range.end) continue;
        if (start > cursor) result.push({ start: cursor, end: start });
        cursor = Math.max(cursor, end);
      }
      if (cursor < range.end) result.push({ start: cursor, end: range.end });
    }
    return result.filter((range) => range.end - range.start > 0.01);
  }, [audioMix, view]);
  const trackReferences = useMemo(() => {
    const references = new Map<number, number>();
    for (const [streamIndex, waveform] of waveforms) references.set(streamIndex, referencePeak(waveform.peaks));
    return references;
  }, [waveforms]);
  const slicePeaks = usePeakSlices();
  const mixSlice = (start: number, end: number) => audioMix && (
    <WaveformCanvas peaks={slicePeaks(audioMix.peaks, mixLength, start, end)} reference={mixReference} colorToken="--waveform" muted={audioMix.muted} cssHeight={24} />
  );

  const separateTracks = () => {
    onCommit(separateAudio);
    setAudioExpanded(true);
    setMenu(null);
  };
  const toggleAudioRows = () => {
    const expand = !audioExpanded;
    setAudioExpanded(expand);
    if (!expand) {
      setActiveAudio(null);
      if (typeof selection?.track === "number") onSelect(null);
    }
    setMenu(null);
  };
  const relinkTracks = () => {
    onCommit(linkAudio);
    setActiveAudio(null);
    setMenu(null);
  };
  const audioLayoutItems = !hasAudio ? null : view.audioLinked ? (
    <button role="menuitem" title="Give every audio track its own clips to trim, move, and split" onClick={separateTracks}>
      <Icon name="link" size={14} />Separate audio tracks
    </button>
  ) : (
    <>
      <button role="menuitem" onClick={toggleAudioRows}><Icon name="chevronDown" size={14} />{audioExpanded ? "Collapse audio tracks" : "Expand audio tracks"}</button>
      <button role="menuitem" title="Audio goes back to following the video clips; separate audio edits are undone" onClick={relinkTracks}>
        <Icon name="link" size={14} />Relink audio to video
      </button>
    </>
  );
  const closeMenuThen = (action: () => void) => () => { action(); setMenu(null); };

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
      const oldPx = pixelsPerSecond(viewLength, viewport, zoomRef.current);
      const newPx = pixelsPerSecond(viewLength, viewport, clamped);
      const scrollLeft = pendingScroll.current ?? host.scrollLeft;
      const pointerOffset = clientX === undefined ? undefined : Math.max(0, Math.min(viewport, clientX - host.getBoundingClientRect().left - LABEL_WIDTH));
      const visiblePlayhead = playhead * oldPx - scrollLeft;
      const anchorOffset = pointerOffset ?? (visiblePlayhead >= 0 && visiblePlayhead <= viewport ? visiblePlayhead : viewport / 2);
      pendingScroll.current = zoomScrollOffset(scrollLeft, anchorOffset, oldPx, newPx, viewport, viewLength);
    }
    zoomRef.current = clamped;
    onZoomChange(clamped);
  }, [finishScrub, onZoomChange, playhead, viewLength]);
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

  const clipStyle = (clip: TimelineClip): CSSProperties => ({
    left: timeToPixel(clip.timelineStart, pxPerSecond),
    width: Math.max(2, (clip.sourceEnd - clip.sourceStart) * pxPerSecond),
  });
  const trimHandles = (label: string) => (
    <>
      <button type="button" className="timeline-segment__handle is-start" data-trim-edge="start" aria-label={`Trim ${label} start`} />
      <button type="button" className="timeline-segment__handle is-end" data-trim-edge="end" aria-label={`Trim ${label} end`} />
    </>
  );
  const frameDuration = filmstrip.length ? state.duration / filmstrip.length : 0;
  const openClipMenu = (event: React.MouseEvent, track: ClipTrack, clipId: string) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect({ track: owningTrack(view, track), clipId });
    if (typeof track === "number") setActiveAudio(track);
    setMenu({ x: event.clientX, y: event.clientY, kind: "clip", track, clipId });
  };
  const menuTrack = menu && typeof menu.track === "number" ? state.audioTracks.find((track) => track.streamIndex === menu.track) ?? null : null;
  const menuClip = menu?.clipId ? trackClips(state, menu.track).find((clip) => clip.id === menu.clipId) ?? null : null;

  return (
    <section data-shard-component="timeline" data-audio={!hasAudio ? "none" : separated ? "separate" : "linked"} data-audio-view={hasAudio ? (showAudioRows ? "expanded" : "collapsed") : undefined} className="timeline" aria-label="Clip timeline">
      <header data-shard-slot="toolbar" className="timeline__toolbar">
        <div className="timeline__toolbar-group">
          <IconButton size="sm" label="Undo (Ctrl+Z)" onClick={onUndo} disabled={!canUndo}><Icon name="undo" size={15} /></IconButton>
          <IconButton size="sm" label="Redo (Ctrl+Y)" onClick={onRedo} disabled={!canRedo}><Icon name="redo" size={15} /></IconButton>
        </div>
        <span className="timeline__divider" />
        <div className="timeline__toolbar-group">
          <Button size="sm" variant="ghost" icon={<Icon name="scissor" size={14} />} onClick={() => onCommit((current) => splitAllTracks(current, playhead))} disabled={!canSplit} title={separated ? "Split every track at the playhead (S) · Shift+S splits only the selected clip" : "Split at the playhead (S)"}>Split</Button>
          <Button size="sm" variant="ghost" icon={<Icon name="crosshair" size={14} />} onClick={() => selection && onCommit((current) => trimClipToPlayhead(current, selection.track, selection.clipId, playhead))} disabled={!selectedClip} title="Move the nearest edge of the selected clip to the playhead">Trim to playhead</Button>
          <Button size="sm" variant="ghost" className="timeline__delete" icon={<Icon name="trash" size={14} />} onClick={() => selection && onCommit((current) => deleteClip(current, selection.track, selection.clipId))} disabled={!selectedClip} title="Delete the selected clip (Del)">Delete</Button>
        </div>
        <span className="timeline__divider" />
        <Button size="sm" variant="ghost" icon={<Icon name="refresh" size={14} />} onClick={() => onCommit(resetEditorState)} disabled={!canUndo} title="Restore the full clip">Reset</Button>
        <span className="spacer" />
        <span className="timeline__hint">Drag clips to move · Shift disables snapping</span>
        <div className="timeline__toolbar-group timeline__zoom-group">
          <IconButton size="sm" label="Zoom out" onClick={() => handleZoom(zoom / 1.4)} disabled={zoom <= 1}><Icon name="zoomOut" size={15} /></IconButton>
          <span className="timeline__zoom num">{Math.round(zoom * 100)}%</span>
          <IconButton size="sm" label="Zoom in (Ctrl+scroll)" onClick={() => handleZoom(zoom * 1.4)} disabled={zoom >= 16}><Icon name="zoomIn" size={15} /></IconButton>
          <IconButton size="sm" label="Fit timeline" onClick={handleFit} disabled={zoom === 1}><Icon name="fit" size={14} /></IconButton>
        </div>
      </header>

      <div
        className={`timeline__scroll${scrubbing ? " is-scrubbing" : ""}${draft?.moving ? " is-moving" : ""}`}
        ref={scrollRef}
        onPointerDown={beginPointer}
        onLostPointerCapture={(event) => {
          if (event.target !== event.currentTarget) return;
          if (scrubRef.current?.pointerId === event.pointerId) finishScrub();
          if (clipGestureRef.current?.pointerId === event.pointerId) finishClipGesture(false);
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="timeline__content" style={{ width: LABEL_WIDTH + timelineWidth }}>
          <div className="timeline__row timeline__row--ruler">
            <div className="timeline__label timeline__label--ruler">Timeline</div>
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
            <div className="timeline__label timeline__video-label">
              {!hasAudio && <Icon name="film" size={14} />}
              <span>
                <strong>Video</strong>
                <small>{view.videoClips.length ? `${view.videoClips.length} clip${view.videoClips.length === 1 ? "" : "s"}` : "No clips"}</small>
              </span>
              {hasAudio && (view.audioLinked ? (
                <IconButton size="sm" label="Separate audio tracks" active onClick={separateTracks}>
                  <Icon name="link" size={14} />
                </IconButton>
              ) : (
                <IconButton size="sm" label={audioExpanded ? "Collapse audio tracks" : "Expand audio tracks"} active={audioExpanded} onClick={toggleAudioRows}>
                  <Icon name="chevronDown" size={14} />
                </IconButton>
              ))}
            </div>
            <div
              className="timeline__surface timeline__video-track"
              style={{ width: timelineWidth }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, kind: "video", track: "video" });
              }}
            >
              {audioOnly.map((range) => (
                <span key={range.start} data-shard-slot="timeline-audio-only" className="timeline__audio-only"
                  style={{ left: timeToPixel(range.start, pxPerSecond), width: (range.end - range.start) * pxPerSecond }}>
                  <span className="timeline__audio-only-label">Audio only</span>
                  <span data-shard-slot="timeline-audio-mix" className="timeline__audio-mix">{mixSlice(range.start, range.end)}</span>
                </span>
              ))}
              {view.videoClips.map((clip, index) => {
                const selected = selection?.track === "video" && selection.clipId === clip.id;
                const firstFrame = frameDuration ? Math.max(0, Math.floor(clip.sourceStart / frameDuration)) : 0;
                const lastFrame = frameDuration ? Math.min(filmstrip.length, Math.ceil(clip.sourceEnd / frameDuration)) : 0;
                return (
                  <div
                    key={clip.id}
                    data-clip-id={clip.id}
                    data-clip-track="video"
                    data-shard-component="timeline-segment"
                    data-selected={selected}
                    className={`timeline-segment${selected ? " is-selected" : ""}${draft?.clipId === clip.id ? " is-dragging" : ""}${menu?.clipId === clip.id ? " is-target" : ""}`}
                    style={clipStyle(clip)}
                    onContextMenu={(event) => openClipMenu(event, "video", clip.id)}
                  >
                    <span className="timeline-segment__frames" aria-hidden="true">
                      {filmstrip.slice(firstFrame, lastFrame).map((frame, offset) => (
                        <span key={firstFrame + offset} className="timeline__frame"
                          style={{ left: ((firstFrame + offset) * frameDuration - clip.sourceStart) * pxPerSecond, width: frameDuration * pxPerSecond }}>
                          {frame && <img src={mediaFileUrl(frame)} alt="" draggable={false} />}
                        </span>
                      ))}
                    </span>
                    {showMix && (
                      <span data-shard-slot="timeline-audio-mix" className="timeline__audio-mix">
                        {audioMix ? mixSlice(clip.timelineStart, clipEnd(clip)) : <span className="timeline__waveform-loading">Generating waveform…</span>}
                      </span>
                    )}
                    <span className="timeline-segment__index">{index + 1}</span>
                    <span className="timeline-segment__duration num">{formatEditorTime(clip.sourceEnd - clip.sourceStart, true)}</span>
                    {selected && trimHandles("video clip")}
                  </div>
                );
              })}
            </div>
          </div>

          {showAudioRows && view.audioTracks.map((track) => {
            const waveform = waveforms.get(track.streamIndex);
            const active = activeAudio === track.streamIndex || menu?.track === track.streamIndex;
            const openTrackMenu = (event: React.MouseEvent) => {
              event.preventDefault();
              event.stopPropagation();
              setActiveAudio(track.streamIndex);
              setMenu({ x: event.clientX, y: event.clientY, kind: "audio", track: track.streamIndex });
            };
            return (
              <div data-shard-component="audio-track" data-muted={track.muted} data-included={track.included} data-selected={active} key={track.streamIndex} style={audioTrackColorStyle(track)} className={`timeline__row timeline__row--audio${active ? " is-active" : ""}${track.muted ? " is-muted" : ""}${!track.included ? " is-excluded" : ""}`}>
                <div className="timeline__label timeline__audio-label" onClick={() => setActiveAudio(track.streamIndex)} onContextMenu={openTrackMenu}>
                  <IconButton size="sm" label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`} active={track.muted} onClick={(event) => { event.stopPropagation(); onTrackChange(track.streamIndex, { muted: !track.muted }); }}>
                    <Icon name={track.muted ? "volumeOff" : "speaker"} size={14} />
                  </IconButton>
                  <span className="timeline__track-name"><strong title={track.name}>{track.name}</strong><small>{track.included ? AUDIO_KIND_LABEL[track.kind] : "Not exported"}</small></span>
                </div>
                <div className="timeline__surface timeline__audio-track" style={{ width: timelineWidth }} data-stream-index={track.streamIndex} onContextMenu={openTrackMenu}>
                  {track.clips.map((clip) => {
                    const selected = selection?.track === track.streamIndex && selection.clipId === clip.id;
                    return (
                      <div
                        key={clip.id}
                        data-clip-id={clip.id}
                        data-clip-track={track.streamIndex}
                        data-shard-component="audio-clip"
                        data-selected={selected}
                        className={`timeline__audio-clip${selected ? " is-selected" : ""}${draft?.clipId === clip.id ? " is-dragging" : ""}${menu?.clipId === clip.id ? " is-target" : ""}`}
                        style={clipStyle(clip)}
                        onContextMenu={(event) => openClipMenu(event, track.streamIndex, clip.id)}
                      >
                        {waveform
                          ? <WaveformCanvas peaks={slicePeaks(waveform.peaks, waveform.duration, clip.sourceStart, clip.sourceEnd)} reference={trackReferences.get(track.streamIndex) ?? 1} colorToken={`--waveform-${trackColorSlot(track) + 1}`} muted={track.muted || !track.included} cssHeight={32} />
                          : <span className="timeline__waveform-loading">Generating waveform…</span>}
                        {selected && trimHandles(`${track.name} clip`)}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {!hasAudio && (
            <div className="timeline__row timeline__row--empty">
              <div className="timeline__label"><Icon name="volumeOff" size={14} /><span><strong>No audio</strong><small>Video only</small></span></div>
              <div className="timeline__surface timeline__empty-audio" style={{ width: timelineWidth }}>This clip has no audio streams.</div>
            </div>
          )}

          {draft?.guide != null && (
            <span data-shard-slot="timeline-snap-guide" className="timeline__snap-guide" style={{ transform: `translateX(${LABEL_WIDTH + draft.guide * pxPerSecond}px)` }} />
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
          {menuTrack && (
            <div className="editor-context__title" style={audioTrackColorStyle(menuTrack)}>
              <i aria-hidden="true" /><strong title={menuTrack.name}>{menuTrack.name}</strong><small>{AUDIO_KIND_LABEL[menuTrack.kind]}</small>
            </div>
          )}
          {menu.kind === "clip" && menuClip && (
            <>
              {separated ? (
                <>
                  <button role="menuitem" disabled={!canSplit} onClick={closeMenuThen(() => onCommit((current) => splitAllTracks(current, playhead)))}><Icon name="scissor" size={14} />Split all tracks at playhead <kbd>S</kbd></button>
                  <button role="menuitem" disabled={playhead <= menuClip.timelineStart || playhead >= clipEnd(menuClip)} onClick={closeMenuThen(() => onCommit((current) => splitClip(current, menu.track, playhead)))}><Icon name="scissor" size={14} />Split only this clip <kbd>Shift+S</kbd></button>
                </>
              ) : (
                <button role="menuitem" disabled={playhead <= menuClip.timelineStart || playhead >= clipEnd(menuClip)} onClick={closeMenuThen(() => onCommit((current) => splitAllTracks(current, playhead)))}><Icon name="scissor" size={14} />Split at playhead <kbd>S</kbd></button>
              )}
              <button role="menuitem" onClick={closeMenuThen(() => onCommit((current) => trimClipToPlayhead(current, menu.track, menuClip.id, playhead)))}>Trim nearest edge to playhead</button>
              <button role="menuitem" className="is-danger" onClick={closeMenuThen(() => onCommit((current) => deleteClip(current, menu.track, menuClip.id)))}><Icon name="trash" size={14} />Delete clip <kbd>Del</kbd></button>
              <span className="editor-context__rule" />
            </>
          )}
          {menuTrack && (
            <>
              <button role="menuitem" onClick={closeMenuThen(() => onTrackChange(menuTrack.streamIndex, { muted: !menuTrack.muted }))}>{menuTrack.muted ? "Unmute track" : "Mute track"}</button>
              <button role="menuitem" onClick={closeMenuThen(() => onTrackChange(menuTrack.streamIndex, { included: !menuTrack.included }))}>{menuTrack.included ? "Exclude from export" : "Include in export"}</button>
              <button role="menuitem" onClick={closeMenuThen(() => onTrackChange(menuTrack.streamIndex, { volume: 1 }))}>Reset track volume</button>
              <button role="menuitem" className="is-danger" onClick={closeMenuThen(() => onDeleteAudioTrack(menuTrack.streamIndex))}><Icon name="trash" size={14} />Delete track</button>
              <label className="editor-context__volume">Volume <input className="volume-slider" type="range" min={0} max={2} step={0.05} value={menuTrack.volume} style={volumeSliderStyle(menuTrack.volume, 2)} onChange={(event) => onTrackChange(menuTrack.streamIndex, { volume: Number(event.target.value) })} /><span className="num">{Math.round(menuTrack.volume * 100)}%</span></label>
              <span className="editor-context__rule" />
            </>
          )}
          {audioLayoutItems}
          {!menuTrack && <button role="menuitem" onClick={closeMenuThen(() => onCommit(resetEditorState))}>Reset timeline</button>}
        </ContextMenu>
      )}
    </section>
  );
}

export function volumeSliderStyle(value: number, max: number): CSSProperties {
  return {
    "--range-progress": `${Math.max(0, Math.min(100, (value / max) * 100))}%`,
    "--range-color": value > 1 ? "var(--danger)" : "var(--accent)",
  } as CSSProperties;
}

function waveformFallback(token: string, muted: boolean): string {
  if (muted) return "#767f93";
  const slot = Number(token.match(/^--waveform-(\d+)$/)?.[1] ?? 1) - 1;
  return TRACK_COLOR_FALLBACKS[slot] ?? TRACK_COLOR_FALLBACKS[0];
}

/**
 * Mirrored peak envelope: a translucent fill with a solid outline. Reads as
 * one shape rather than a field of same-colored bars, and the color token
 * identifies the track. `reference` is the track-wide loudness reference.
 */
const WaveformCanvas = memo(function WaveformCanvas({
  peaks,
  reference,
  colorToken,
  muted,
  cssHeight,
}: {
  peaks: number[];
  reference: number;
  colorToken: string;
  muted: boolean;
  cssHeight: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [themeRevision, setThemeRevision] = useState(0);
  useEffect(() => {
    const changed = () => setThemeRevision(value => value + 1);
    window.addEventListener(THEME_CHANGE_EVENT, changed);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, changed);
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks.length) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const token = muted ? "--waveform-muted" : colorToken;
    const color = getComputedStyle(canvas).getPropertyValue(token).trim() || waveformFallback(colorToken, muted);
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    const middle = height / 2;
    const step = peaks.length / width;
    const amplitudes = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const start = Math.floor(x * step);
      const end = Math.max(start + 1, Math.floor((x + 1) * step));
      let peak = 0;
      for (let i = start; i < end && i < peaks.length; i++) peak = Math.max(peak, peaks[i]);
      amplitudes[x] = Math.max(0.75, Math.min(1, peak / Math.max(0.0001, reference)) * (middle - 1.5));
    }
    const envelope = new Path2D();
    envelope.moveTo(0, middle - amplitudes[0]);
    for (let x = 1; x < width; x++) envelope.lineTo(x + 0.5, middle - amplitudes[x]);
    for (let x = width - 1; x >= 0; x--) envelope.lineTo(x + 0.5, middle + amplitudes[x]);
    envelope.closePath();
    context.fillStyle = color;
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.lineJoin = "round";
    context.globalAlpha = muted ? 0.26 : 0.42;
    context.fill(envelope);
    context.globalAlpha = muted ? 0.5 : 1;
    context.stroke(envelope);
    context.globalAlpha = 1;
  }, [colorToken, muted, peaks, reference, themeRevision]);
  const pixelHeight = Math.max(16, Math.round(cssHeight * (window.devicePixelRatio || 1)));
  return <canvas ref={canvasRef} className="timeline__waveform" width={Math.min(4000, Math.max(64, peaks.length))} height={pixelHeight} />;
});
