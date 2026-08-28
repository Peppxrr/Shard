import type { AudioTrackInfo } from "../../shared/contracts";

export interface TimelineSegment {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  sourceMin: number;
  sourceMax: number;
}

export interface EditorAudioTrack extends AudioTrackInfo {
  included: boolean;
  muted: boolean;
  volume: number;
  excludedSegments?: string[];
}

export interface EditorState {
  duration: number;
  segments: TimelineSegment[];
  audioTracks: EditorAudioTrack[];
  selectedSegmentId: string | null;
  revision: number;
}

export interface EditorHistory {
  past: EditorState[];
  present: EditorState;
  future: EditorState[];
}

export const MIN_SEGMENT_DURATION = 0.05;
const EPSILON = 0.000001;

export function createEditorState(duration: number, tracks: AudioTrackInfo[]): EditorState {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const segment = safeDuration > 0
    ? { id: "segment-0", sourceStart: 0, sourceEnd: safeDuration, sourceMin: 0, sourceMax: safeDuration }
    : null;
  return {
    duration: safeDuration,
    segments: segment ? [segment] : [],
    audioTracks: tracks.map((track) => ({ ...track, included: true, muted: false, volume: 1, excludedSegments: [] })),
    selectedSegmentId: segment?.id ?? null,
    revision: 0,
  };
}

export function createHistory(state: EditorState): EditorHistory {
  return { past: [], present: state, future: [] };
}

export function commitHistory(history: EditorHistory, next: EditorState): EditorHistory {
  if (next === history.present || editorStatesEqual(next, history.present)) return history;
  return {
    past: [...history.past.slice(-99), history.present],
    present: next,
    future: [],
  };
}

export function undoHistory(history: EditorHistory): EditorHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, 100),
  };
}

export function redoHistory(history: EditorHistory): EditorHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past.slice(-99), history.present],
    present: next,
    future: history.future.slice(1),
  };
}

export function splitSegment(state: EditorState, segmentId: string | null, sourceTime: number): EditorState {
  if (!segmentId || !Number.isFinite(sourceTime)) return state;
  const index = state.segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) return state;
  const segment = state.segments[index];
  if (sourceTime - segment.sourceStart < MIN_SEGMENT_DURATION
    || segment.sourceEnd - sourceTime < MIN_SEGMENT_DURATION) return state;

  const revision = state.revision + 1;
  const left: TimelineSegment = {
    id: `${segment.id}-L${revision}`,
    sourceStart: segment.sourceStart,
    sourceEnd: sourceTime,
    sourceMin: segment.sourceMin,
    sourceMax: sourceTime,
  };
  const right: TimelineSegment = {
    id: `${segment.id}-R${revision}`,
    sourceStart: sourceTime,
    sourceEnd: segment.sourceEnd,
    sourceMin: sourceTime,
    sourceMax: segment.sourceMax,
  };
  const audioTracks = state.audioTracks.map((track) => {
    const excluded = track.excludedSegments ?? [];
    if (!excluded.includes(segmentId)) return track;
    // This track had the original segment excluded (deleted) — propagate to both new segments
    return { ...track, excludedSegments: [...excluded.filter((id) => id !== segmentId), left.id, right.id] };
  });
  return {
    ...state,
    revision,
    segments: [...state.segments.slice(0, index), left, right, ...state.segments.slice(index + 1)],
    selectedSegmentId: right.id,
    audioTracks,
  };
}

export function deleteSegment(state: EditorState, segmentId: string | null): EditorState {
  if (!segmentId) return state;
  const index = state.segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) return state;
  const segments = state.segments.filter((segment) => segment.id !== segmentId);
  const selected = segments[Math.min(index, segments.length - 1)] ?? null;
  const audioTracks = state.audioTracks.map((track) => {
    const excluded = track.excludedSegments ?? [];
    if (!excluded.includes(segmentId)) return track;
    return { ...track, excludedSegments: excluded.filter((id) => id !== segmentId) };
  });
  return {
    ...state,
    revision: state.revision + 1,
    segments,
    selectedSegmentId: selected?.id ?? null,
    audioTracks,
  };
}

export function trimSegment(
  state: EditorState,
  segmentId: string,
  edge: "start" | "end",
  sourceTime: number,
): EditorState {
  if (!Number.isFinite(sourceTime)) return state;
  const index = state.segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) return state;
  const segment = state.segments[index];
  const clamped = edge === "start"
    ? clamp(sourceTime, segment.sourceMin, segment.sourceEnd - MIN_SEGMENT_DURATION)
    : clamp(sourceTime, segment.sourceStart + MIN_SEGMENT_DURATION, segment.sourceMax);
  if (Math.abs(clamped - (edge === "start" ? segment.sourceStart : segment.sourceEnd)) < EPSILON) return state;
  const next = { ...segment, [edge === "start" ? "sourceStart" : "sourceEnd"]: clamped };
  return {
    ...state,
    revision: state.revision + 1,
    segments: state.segments.map((value, i) => i === index ? next : value),
  };
}

export function trimSegmentToPlayhead(state: EditorState, segmentId: string, sourceTime: number): EditorState {
  const segment = state.segments.find((value) => value.id === segmentId);
  if (!segment || sourceTime <= segment.sourceStart || sourceTime >= segment.sourceEnd) return state;
  const distanceFromStart = sourceTime - segment.sourceStart;
  const distanceFromEnd = segment.sourceEnd - sourceTime;
  return trimSegment(state, segmentId, distanceFromStart <= distanceFromEnd ? "start" : "end", sourceTime);
}

export function updateAudioTrack(
  state: EditorState,
  streamIndex: number,
  change: Partial<Pick<EditorAudioTrack, "included" | "muted" | "volume">>,
): EditorState {
  let changed = false;
  const audioTracks = state.audioTracks.map((track) => {
    if (track.streamIndex !== streamIndex) return track;
    const next = {
      ...track,
      ...change,
      volume: change.volume === undefined ? track.volume : clamp(change.volume, 0, 2),
    };
    changed = changed || next.included !== track.included || next.muted !== track.muted || next.volume !== track.volume;
    return next;
  });
  return changed ? { ...state, revision: state.revision + 1, audioTracks } : state;
}

export function deleteAudioTrack(state: EditorState, streamIndex: number): EditorState {
  if (!state.audioTracks.some((t) => t.streamIndex === streamIndex)) return state;
  return {
    ...state,
    revision: state.revision + 1,
    audioTracks: state.audioTracks.filter((t) => t.streamIndex !== streamIndex),
  };
}

export function deleteAudioSegment(state: EditorState, streamIndex: number, segmentId: string): EditorState {
  const idx = state.audioTracks.findIndex((t) => t.streamIndex === streamIndex);
  if (idx < 0) return state;
  const track = state.audioTracks[idx];
  const excluded = track.excludedSegments ?? [];
  if (excluded.includes(segmentId)) return state;
  // If this is the only segment, delete entire track instead (individual track deletion)
  if (state.segments.length <= 1) {
    return deleteAudioTrack(state, streamIndex);
  }
  const nextTrack = { ...track, excludedSegments: [...excluded, segmentId] };
  const audioTracks = state.audioTracks.map((t, i) => i === idx ? nextTrack : t);
  return { ...state, revision: state.revision + 1, audioTracks };
}

export function resetEditorState(state: EditorState): EditorState {
  const reset = createEditorState(state.duration, state.audioTracks);
  return { ...reset, revision: state.revision + 1 };
}

export function editedDuration(segments: TimelineSegment[]): number {
  return segments.reduce((total, segment) => total + Math.max(0, segment.sourceEnd - segment.sourceStart), 0);
}

export function sourceToResultTime(segments: TimelineSegment[], sourceTime: number): number {
  let result = 0;
  for (const segment of segments) {
    if (sourceTime < segment.sourceStart) return result;
    if (sourceTime <= segment.sourceEnd) return result + sourceTime - segment.sourceStart;
    result += segment.sourceEnd - segment.sourceStart;
  }
  return result;
}

/**
 * RESULT time -> SOURCE time. Note: at a cut boundary the two source edges
 * (end of segment N, start of segment N+1) share ONE result instant; this
 * inverse deliberately resolves to the EARLIER edge (end of the previous
 * retained range). Interior points round-trip exactly.
 */
export function resultToSourceTime(segments: TimelineSegment[], resultTime: number): number {
  let remaining = Math.max(0, resultTime);
  for (const segment of segments) {
    const segmentDuration = segment.sourceEnd - segment.sourceStart;
    if (remaining <= segmentDuration) return segment.sourceStart + remaining;
    remaining -= segmentDuration;
  }
  return segments.at(-1)?.sourceEnd ?? 0;
}

export function segmentAtTime(segments: TimelineSegment[], sourceTime: number): TimelineSegment | null {
  return segments.find((segment) => sourceTime >= segment.sourceStart - EPSILON && sourceTime <= segment.sourceEnd + EPSILON) ?? null;
}

export function nextSegmentAfter(segments: TimelineSegment[], sourceTime: number): TimelineSegment | null {
  return segments.find((segment) => segment.sourceStart > sourceTime + EPSILON) ?? null;
}

export function pixelsPerSecond(duration: number, viewportWidth: number, zoom: number): number {
  if (duration <= 0 || viewportWidth <= 0) return 1;
  return Math.max(1, (viewportWidth / duration) * clamp(zoom, 1, 16));
}

export function timeToPixel(time: number, pxPerSecond: number, scrollOffset = 0): number {
  return time * pxPerSecond - scrollOffset;
}

export function pixelToTime(pixel: number, pxPerSecond: number, scrollOffset = 0): number {
  return pxPerSecond > 0 ? Math.max(0, (pixel + scrollOffset) / pxPerSecond) : 0;
}

/**
 * Canonical timeline coordinate system. One instance is created per Timeline
 * render; every pointer interaction (scrubbing, trimming, context menus,
 * playhead drag) must convert through it — never through per-element
 * `getBoundingClientRect` walks.
 *
 * Coordinates:
 * - `clientXToTime`: viewport X -> source seconds on the timeline content
 *   (accounts for label column, scroll position, zoom). Clamped to [0, duration].
 * - `timeToContentX` / `contentXToTime`: content-space pixels <-> seconds,
 *   independent of scrolling. All rows share this origin.
 */
export interface TimelineGeometry {
  duration: number;
  pxPerSecond: number;
  viewportWidth(): number;
  /** Viewport client X -> clamped source time. The single authoritative pointer conversion. */
  clientXToTime(clientX: number): number;
  /** Source time -> pixel offset within the timeline content (ignores scroll). */
  timeToContentX(time: number): number;
  /** Content-space pixel -> unclamped time (>= 0). */
  contentXToTime(x: number): number;
}

export function createTimelineGeometry(
  surfaceRect: () => DOMRect | null,
  duration: number,
  pxPerSecond: number,
): TimelineGeometry {
  const contentXToTime = (x: number) => pixelToTime(x, pxPerSecond);
  return {
    duration,
    pxPerSecond,
    viewportWidth: () => surfaceRect()?.width ?? 0,
    clientXToTime(clientX: number): number {
      const rect = surfaceRect();
      if (!rect) return 0;
      // The surfaces are in-flow content that scrolls with the timeline, so
      // their rect.left ALREADY includes -scrollLeft (and sits after the
      // sticky label column). clientX - rect.left is therefore the exact
      // content X of the pointer — no separate scroll term, or it would be
      // counted twice and the seek would drift worse the further you zoom.
      const raw = contentXToTime(clientX - rect.left);
      return clamp(raw, 0, Math.max(0, duration));
    },
    timeToContentX(time: number): number {
      return time * pxPerSecond;
    },
    contentXToTime,
  };
}
/** Round-trip invariant used by dev assertions and tests. */
export function geometryRoundTrip(time: number, pxPerSecond: number): number {
  return pixelToTime(timeToPixel(time, pxPerSecond), pxPerSecond);
}

export function chooseRulerStep(pxPerSecond: number): number {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return candidates.find((step) => step * pxPerSecond >= 72) ?? 600;
}

function editorStatesEqual(a: EditorState, b: EditorState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
