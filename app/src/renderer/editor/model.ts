import type { AudioTrackInfo } from "../../shared/contracts";
import { timelineExportRange } from "../../shared/timeline-export";

/**
 * A clip placed on the output timeline: source range [sourceStart,
 * sourceEnd) shown from timelineStart. Clips on one track never overlap;
 * uncovered timeline time is black video / silent audio.
 */
export interface TimelineClip {
  id: string;
  /** Editing link only; never changes a clip's timeline/source coordinates. */
  groupId?: string;
  /** Audio-only splits keep their video trim association without joining movement groups. */
  trimGroupId?: string;
  timelineStart: number;
  sourceStart: number;
  sourceEnd: number;
  /** Non-destructive video trim over the audio's independently chosen range. */
  audioTrim?: { base: ClipRange; start?: number; end?: number };
}

type ClipRange = Pick<TimelineClip, "timelineStart" | "sourceStart" | "sourceEnd">;
const clipRange = ({ timelineStart, sourceStart, sourceEnd }: TimelineClip): ClipRange => ({ timelineStart, sourceStart, sourceEnd });

export interface EditorAudioTrack extends AudioTrackInfo {
  included: boolean;
  muted: boolean;
  volume: number;
  /** The track's own clips once audio is separated; empty while linked. */
  clips: TimelineClip[];
}

/** `"video"` or an audio stream index. */
export type ClipTrack = "video" | number;

export interface ClipSelection {
  track: ClipTrack;
  clipId: string;
}

export interface EditorState {
  /** Source media duration. */
  duration: number;
  videoClips: TimelineClip[];
  /** Linked audio follows the video clips; separated tracks own their clips. */
  audioLinked: boolean;
  audioTracks: EditorAudioTrack[];
  selection: ClipSelection | null;
  revision: number;
}

export interface EditorHistory {
  past: EditorState[];
  present: EditorState;
  future: EditorState[];
}

export const MIN_CLIP_DURATION = 0.05;
const EPSILON = 0.000001;

export function clipEnd(clip: TimelineClip): number {
  return clip.timelineStart + clip.sourceEnd - clip.sourceStart;
}

export function createEditorState(duration: number, tracks: AudioTrackInfo[]): EditorState {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const clip = safeDuration > 0 ? { id: "clip-0", groupId: "group-0", trimGroupId: "group-0", timelineStart: 0, sourceStart: 0, sourceEnd: safeDuration } : null;
  return {
    duration: safeDuration,
    videoClips: clip ? [clip] : [],
    audioLinked: true,
    audioTracks: tracks.map((track) => ({ ...track, included: true, muted: false, volume: 1, clips: [] })),
    selection: clip ? { track: "video", clipId: clip.id } : null,
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

/** While audio is linked, every audio edit is a video edit. */
export function owningTrack(state: EditorState, track: ClipTrack): ClipTrack {
  return state.audioLinked ? "video" : track;
}

export function trackClips(state: EditorState, track: ClipTrack): TimelineClip[] {
  const clips = rawTrackClips(state, track);
  return clips.some(clip => clip.sourceEnd - clip.sourceStart <= EPSILON) ? clips.filter(clip => clip.sourceEnd - clip.sourceStart > EPSILON) : clips;
}

/** Retain fully cropped audio internally so extending the video can restore it. */
function rawTrackClips(state: EditorState, track: ClipTrack): TimelineClip[] {
  if (owningTrack(state, track) === "video") return state.videoClips;
  return state.audioTracks.find((candidate) => candidate.streamIndex === track)?.clips ?? [];
}

function withTrackClips(state: EditorState, track: ClipTrack, clips: TimelineClip[], selection = state.selection): EditorState {
  const owner = owningTrack(state, track);
  const sorted = [...clips].sort((a, b) => a.timelineStart - b.timelineStart);
  const revision = state.revision + 1;
  if (owner === "video") return { ...state, videoClips: sorted, selection, revision };
  return {
    ...state,
    audioTracks: state.audioTracks.map((candidate) => candidate.streamIndex === owner ? { ...candidate, clips: sorted } : candidate),
    selection,
    revision,
  };
}

/** The clip covering `time` (half-open: a clip's end belongs to what follows). */
export function clipAt(clips: TimelineClip[], time: number): TimelineClip | null {
  return clips.find((clip) => time >= clip.timelineStart - EPSILON && time < clipEnd(clip) - EPSILON) ?? null;
}

/** Free timeline space around a clip on its own track. */
function clipBounds(clips: TimelineClip[], clip: TimelineClip): { min: number; max: number } {
  let min = 0;
  let max = Infinity;
  for (const other of clips) {
    if (other.id === clip.id) continue;
    if (other.sourceEnd - other.sourceStart <= EPSILON) continue;
    if (other.timelineStart < clip.timelineStart) min = Math.max(min, clipEnd(other));
    else max = Math.min(max, other.timelineStart);
  }
  return { min, max };
}

export function splitClip(state: EditorState, track: ClipTrack, time: number): EditorState {
  if (!Number.isFinite(time)) return state;
  const clips = rawTrackClips(state, track);
  const clip = clipAt(clips, time);
  if (!clip) return state;
  const revision = state.revision + 1;
  const pieces = splitPieces(clip, time, revision);
  if (!pieces) return state;
  const owner = owningTrack(state, track);
  if (owner === "video") for (const piece of pieces) piece.trimGroupId = piece.groupId;
  return withTrackClips(state, owner, clips.flatMap((value) => value.id === clip.id ? pieces : [value]), { track: owner, clipId: pieces[1].id });
}

function splitPieces(clip: TimelineClip, time: number, revision: number): [TimelineClip, TimelineClip] | null {
  if (time - clip.timelineStart < MIN_CLIP_DURATION || clipEnd(clip) - time < MIN_CLIP_DURATION) return null;
  const sourceSplit = clip.sourceStart + (time - clip.timelineStart);
  const left: TimelineClip = { ...clip, id: `${clip.id}-L${revision}`, groupId: `${clip.id}-L${revision}`, sourceEnd: sourceSplit };
  const right: TimelineClip = { ...clip, id: `${clip.id}-R${revision}`, groupId: `${clip.id}-R${revision}`, timelineStart: time, sourceStart: sourceSplit };
  if (clip.audioTrim) {
    const baseSplit = clip.audioTrim.base.sourceStart + time - clip.audioTrim.base.timelineStart;
    left.audioTrim = { ...clip.audioTrim, base: { ...clip.audioTrim.base, sourceEnd: baseSplit }, end: time };
    right.audioTrim = { ...clip.audioTrim, base: { ...clip.audioTrim.base, timelineStart: time, sourceStart: baseSplit }, start: time };
  }
  return [left, right];
}

/**
 * Razor through every track at `time`: the video clip and, once audio is
 * separated, each audio track's clip under the playhead. Keeps the
 * selection on the selected track (its right-hand piece).
 */
export function splitAllTracks(state: EditorState, time: number): EditorState {
  let next = splitClip(state, "video", time);
  if (!state.audioLinked) for (const track of state.audioTracks) next = splitClip(next, track.streamIndex, time);
  if (next === state) return state;
  const focus = owningTrack(next, state.selection?.track ?? "video");
  const clip = clipAt(trackClips(next, focus), time);
  return { ...next, selection: clip ? { track: focus, clipId: clip.id } : state.selection };
}

/** Removes the clip and leaves its time empty (black/silent) until filled. */
export function deleteClip(state: EditorState, track: ClipTrack, clipId: string): EditorState {
  const clips = rawTrackClips(state, track);
  const index = clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return state;
  const remaining = clips.filter((clip) => clip.id !== clipId);
  const neighbour = remaining[Math.min(index, remaining.length - 1)];
  const owner = owningTrack(state, track);
  return withTrackClips(state, owner, remaining, neighbour ? { track: owner, clipId: neighbour.id } : null);
}

/**
 * Moves one edge to timeline `time`. The opposite edge stays put; the edge
 * stops at the source media bounds, the neighbouring clips, and the
 * minimum clip length.
 */
export function trimClip(state: EditorState, track: ClipTrack, clipId: string, edge: "start" | "end", time: number, selectedOnly = false): EditorState {
  if (!Number.isFinite(time)) return state;
  // An explicit audio edit always edits audio, even if rows have not been separated yet.
  if (typeof track === "number" && state.audioLinked) {
    const base = separateAudio(state);
    const next = trimClip(base, track, `${clipId}-a${track}`, edge, time, true);
    return next === base ? state : next;
  }
  if (selectedOnly && state.audioLinked) {
    const base = separateAudio(state);
    const next = trimClip(base, track, clipId, edge, time, true);
    return next === base ? state : next;
  }
  const clips = rawTrackClips(state, track);
  const clip = clips.find((value) => value.id === clipId);
  if (!clip) return state;
  const { min, max } = clipBounds(clips, clip);
  const manual = typeof track === "number" && clip.audioTrim ? { ...clip, ...clip.audioTrim.base } : clip;
  let next: TimelineClip;
  if (edge === "start") {
    const start = clamp(time, Math.max(min, manual.timelineStart - manual.sourceStart), clipEnd(clip) - MIN_CLIP_DURATION);
    next = { ...manual, timelineStart: start, sourceStart: Math.max(0, manual.sourceStart + start - manual.timelineStart) };
  } else {
    const end = clamp(time, clip.timelineStart + MIN_CLIP_DURATION, Math.min(max, manual.timelineStart + state.duration - manual.sourceStart));
    next = { ...manual, sourceEnd: Math.min(state.duration, manual.sourceStart + end - manual.timelineStart) };
  }
  const boundary = edge === "start" ? next.timelineStart : clipEnd(next);
  const previousBoundary = edge === "start" ? clip.timelineStart : clipEnd(clip);
  if (Math.abs(boundary - previousBoundary) < EPSILON) return state;
  if (typeof track === "number" && clip.audioTrim) {
    next.audioTrim = { ...clip.audioTrim, base: clipRange(next), [edge]: undefined };
    next = applyAudioTrim(next, min, max);
  }
  if (JSON.stringify(next) === JSON.stringify(clip)) return state;
  if (track === "video" && !selectedOnly && state.audioLinked && state.audioTracks.length) {
    next.audioTrim = { ...(clip.audioTrim ?? { base: clipRange(clip) }), [edge]: boundary };
  }
  let result = withTrackClips(state, track, clips.map((value) => value.id === clipId ? next : value));
  if (track !== "video" || selectedOnly || state.audioLinked) return result;
  // Separated rows still follow video trims; their own manual limits are never overwritten.
  for (const audio of state.audioTracks) {
    const audioClips = audio.clips.map(value => {
      const trimGroup = clip.trimGroupId ?? clip.groupId;
      if (!trimGroup || (value.trimGroupId ?? value.groupId) !== trimGroup) return value;
      const bounds = clipBounds(audio.clips, value);
      return applyAudioTrim({ ...value, audioTrim: { ...(value.audioTrim ?? { base: clipRange(value) }), [edge]: boundary } }, bounds.min, bounds.max);
    });
    result = withTrackClips(result, audio.streamIndex, audioClips);
  }
  return result;
}

function applyAudioTrim(clip: TimelineClip, min = 0, max = Infinity): TimelineClip {
  const trim = clip.audioTrim;
  if (!trim) return clip;
  const base = trim.base;
  const baseEnd = base.timelineStart + base.sourceEnd - base.sourceStart;
  const start = Math.min(baseEnd, Math.max(base.timelineStart, trim.start ?? -Infinity, min));
  const end = Math.max(start, Math.min(baseEnd, trim.end ?? Infinity, max));
  return { ...clip, timelineStart: start, sourceStart: base.sourceStart + start - base.timelineStart, sourceEnd: base.sourceStart + (end - start < MIN_CLIP_DURATION ? start : end) - base.timelineStart };
}

function shiftClip(clip: TimelineClip, delta: number): TimelineClip {
  return { ...clip, timelineStart: clip.timelineStart + delta, ...(clip.audioTrim ? { audioTrim: {
    ...clip.audioTrim,
    base: { ...clip.audioTrim.base, timelineStart: clip.audioTrim.base.timelineStart + delta },
    start: clip.audioTrim.start === undefined ? undefined : clip.audioTrim.start + delta,
    end: clip.audioTrim.end === undefined ? undefined : clip.audioTrim.end + delta,
  } } : {}) };
}

export function trimClipToPlayhead(state: EditorState, track: ClipTrack, clipId: string, time: number, selectedOnly = false): EditorState {
  const clip = trackClips(state, track).find((value) => value.id === clipId);
  if (!clip || time <= clip.timelineStart || time >= clipEnd(clip)) return state;
  return trimClip(state, track, clipId, time - clip.timelineStart <= clipEnd(clip) - time ? "start" : "end", time, selectedOnly);
}

/** Slides a clip within the free space between its neighbours. */
export function moveClip(state: EditorState, track: ClipTrack, clipId: string, timelineStart: number): EditorState {
  if (!Number.isFinite(timelineStart)) return state;
  const clips = rawTrackClips(state, track);
  const clip = clips.find((value) => value.id === clipId);
  if (!clip) return state;
  const { min, max } = clipBounds(clips, clip);
  const start = clamp(timelineStart, min, max - (clip.sourceEnd - clip.sourceStart));
  if (Math.abs(start - clip.timelineStart) < EPSILON) return state;
  return withTrackClips(state, track, clips.map((value) => value.id === clipId ? shiftClip(clip, start - clip.timelineStart) : value));
}

/** Members of this editing group, with separated audio retaining its own placement. */
export function linkedClips(state: EditorState, track: ClipTrack, clipId: string): Array<ClipSelection & { clip: TimelineClip }> {
  const owner = owningTrack(state, track);
  const selected = trackClips(state, owner).find(clip => clip.id === clipId);
  if (!selected) return [];
  const members: Array<ClipSelection & { clip: TimelineClip }> = [];
  const add = (clipsTrack: ClipTrack) => {
    for (const clip of rawTrackClips(state, clipsTrack)) {
      if ((clipsTrack === owner && clip.id === clipId) || (selected.groupId && clip.groupId === selected.groupId)) {
        members.push({ track: clipsTrack, clipId: clip.id, clip });
      }
    }
  };
  add("video");
  if (!state.audioLinked) for (const audio of state.audioTracks) add(audio.streamIndex);
  return members;
}

/** Move a group by one bounded delta so offsets cannot drift at neighbouring clips or zero. */
export function moveLinkedClips(state: EditorState, track: ClipTrack, clipId: string, timelineStart: number, selectedOnly = false): EditorState {
  if (!Number.isFinite(timelineStart)) return state;
  if (selectedOnly) {
    const base = separateAudio(state);
    const next = moveClip(base, track, clipId, timelineStart);
    return next === base ? state : next;
  }
  const members = linkedClips(state, track, clipId);
  const selected = members.find(member => member.track === owningTrack(state, track) && member.clipId === clipId);
  if (!selected) return state;
  let minDelta = -Infinity;
  let maxDelta = Infinity;
  for (const member of members) {
    const peers = new Set(members.filter(other => other.track === member.track).map(other => other.clipId));
    const { min, max } = clipBounds(rawTrackClips(state, member.track).filter(clip => clip.id === member.clipId || !peers.has(clip.id)), member.clip);
    minDelta = Math.max(minDelta, min - member.clip.timelineStart);
    maxDelta = Math.min(maxDelta, max - clipEnd(member.clip));
  }
  const delta = clamp(timelineStart - selected.clip.timelineStart, minDelta, maxDelta);
  if (Math.abs(delta) < EPSILON) return state;
  let next = state;
  for (const clipsTrack of new Set(members.map(member => member.track))) {
    const ids = new Set(members.filter(member => member.track === clipsTrack).map(member => member.clipId));
    next = withTrackClips(next, clipsTrack, rawTrackClips(next, clipsTrack).map(clip => ids.has(clip.id) ? shiftClip(clip, delta) : clip));
  }
  return next;
}

/** S cuts the group at timeline time; Alt+S cuts only the selected clip. */
export function splitLinkedClips(state: EditorState, time: number, selectedOnly = false, selection = state.selection): EditorState {
  if (!Number.isFinite(time)) return state;
  if (selectedOnly) {
    if (!selection) return state;
    const clip = clipAt(trackClips(state, selection.track), time);
    if (clip?.id !== selection.clipId) return state;
    const base = separateAudio(state);
    const next = splitClip(base, selection.track, time);
    return next === base ? state : next;
  }
  const focus = selection?.track ?? "video";
  const anchor = clipAt(trackClips(state, focus), time);
  if (!anchor) return state;
  const members = linkedClips(state, focus, anchor.id);
  const cuts = new Map(members.map(member => [member.clipId, splitPieces(member.clip, time, state.revision + 1)]));
  if (![...cuts.values()].some(Boolean)) return state;
  let next = state;
  const group = `${anchor.groupId ?? anchor.id}-cut${state.revision + 1}`;
  for (const clipsTrack of new Set(members.map(member => member.track))) {
    const ids = new Set(members.filter(member => member.track === clipsTrack).map(member => member.clipId));
    next = withTrackClips(next, clipsTrack, rawTrackClips(state, clipsTrack).flatMap(clip => {
      if (!ids.has(clip.id)) return [clip];
      return (cuts.get(clip.id) ?? [clip]).map(piece => {
        const groupId = `${group}-${piece.timelineStart >= time - EPSILON ? "right" : "left"}`;
        return { ...piece, groupId, trimGroupId: groupId };
      });
    }));
  }
  const right = clipAt(trackClips(next, focus), time);
  return { ...next, selection: right ? { track: owningTrack(next, focus), clipId: right.id } : selection };
}

/** Gives every audio track its own copy of the video clips to edit independently. */
export function separateAudio(state: EditorState): EditorState {
  if (!state.audioLinked) return state;
  return {
    ...state,
    audioLinked: false,
    revision: state.revision + 1,
    audioTracks: state.audioTracks.map((track) => ({
      ...track,
      clips: state.videoClips.map((clip) => applyAudioTrim({ ...clip, id: `${clip.id}-a${track.streamIndex}` })),
    })),
    videoClips: state.videoClips.map(({ audioTrim, ...clip }) => clip),
  };
}

/** Audio follows the video clips again; separate audio edits are discarded. */
export function linkAudio(state: EditorState): EditorState {
  if (state.audioLinked) return state;
  return {
    ...state,
    audioLinked: true,
    revision: state.revision + 1,
    audioTracks: state.audioTracks.map((track) => ({ ...track, clips: [] })),
    selection: state.selection?.track === "video" ? state.selection : null,
  };
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
  if (!state.audioTracks.some((track) => track.streamIndex === streamIndex)) return state;
  return {
    ...state,
    revision: state.revision + 1,
    audioTracks: state.audioTracks.filter((track) => track.streamIndex !== streamIndex),
    selection: state.selection?.track === streamIndex ? null : state.selection,
  };
}

export function resetEditorState(state: EditorState): EditorState {
  return { ...createEditorState(state.duration, state.audioTracks), revision: state.revision + 1 };
}

/** Timeline end for transport/geometry; export length omits empty outer time. */
export function outputDuration(state: EditorState): number {
  let end = 0;
  for (const clip of state.videoClips) end = Math.max(end, clipEnd(clip));
  if (!state.audioLinked) {
    for (const track of state.audioTracks) {
      if (track.included) for (const clip of trackClips(state, track.streamIndex)) end = Math.max(end, clipEnd(clip));
    }
  }
  return end;
}

/** Export bounds differ from timeline coordinates: only outer empty time is discarded. */
export function exportRange(state: EditorState) {
  return timelineExportRange(state.videoClips, state.audioTracks.map(track => ({ ...track, clips: trackClips(state, track.streamIndex) })));
}

/** Every clip edge on every track, plus 0 and the playhead, except the dragged clip's own edges. */
export function snapTargets(state: EditorState, track: ClipTrack, clipId: string, playhead: number, group = false): number[] {
  const owner = owningTrack(state, track);
  const moving = group ? linkedClips(state, track, clipId) : [{ track: owner, clipId }];
  const targets = [0, playhead, exportRange(state).start];
  const add = (clips: TimelineClip[], clipsTrack: ClipTrack) => {
    for (const clip of clips) {
      if (moving.some(member => member.track === clipsTrack && member.clipId === clip.id)) continue;
      targets.push(clip.timelineStart, clipEnd(clip));
    }
  };
  add(state.videoClips, "video");
  if (!state.audioLinked) for (const audio of state.audioTracks) add(trackClips(state, audio.streamIndex), audio.streamIndex);
  return targets;
}

/**
 * Pulls the closest of `edges` onto the nearest target within `threshold`
 * seconds. `offset` is added to the dragged value; `target` is the time it
 * locked to (null when nothing was close enough).
 */
export function snapOffset(edges: number[], targets: number[], threshold: number): { offset: number; target: number | null } {
  let best: { offset: number; target: number | null } = { offset: 0, target: null };
  let bestDistance = threshold;
  for (const edge of edges) {
    for (const target of targets) {
      const distance = Math.abs(target - edge);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = { offset: target - edge, target };
      }
    }
  }
  return best;
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
 * - `clientXToTime`: viewport X -> timeline seconds on the content
 *   (accounts for label column, scroll position, zoom). Clamped to [0, duration].
 * - `timeToContentX` / `contentXToTime`: content-space pixels <-> seconds,
 *   independent of scrolling. All rows share this origin.
 */
export interface TimelineGeometry {
  duration: number;
  pxPerSecond: number;
  viewportWidth(): number;
  /** Viewport client X -> clamped timeline time. The single authoritative pointer conversion. */
  clientXToTime(clientX: number): number;
  /** Timeline time -> pixel offset within the timeline content (ignores scroll). */
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

export function chooseRulerStep(pxPerSecond: number): number {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return candidates.find((step) => step * pxPerSecond >= 72) ?? 600;
}

export function createRulerTicks(duration: number, pxPerSecond: number): Array<{ time: number; label: string | null }> {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(pxPerSecond) || pxPerSecond <= 0) return [];
  const major = chooseRulerStep(pxPerSecond);
  const divisions = major === 2 || major === 120 ? 4 : 5;
  const minor = major / divisions;
  return Array.from({ length: Math.floor((duration + 0.000001) / minor) + 1 }, (_, index) => {
    const time = Math.round(index * minor * 1e6) / 1e6;
    return { time, label: index % divisions === 0 ? formatRulerTime(time, major) : null };
  });
}

export function formatRulerTime(time: number, step: number): string {
  const precision = step >= 1 ? 0 : step === 0.25 ? 2 : 1;
  const scale = 10 ** precision;
  const units = Math.max(0, Math.round(time * scale));
  const seconds = Math.floor(units / scale);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const whole = `${hours ? `${hours}:` : ""}${hours ? String(minutes).padStart(2, "0") : minutes}:${String(seconds % 60).padStart(2, "0")}`;
  return precision ? `${whole}.${String(units % scale).padStart(precision, "0")}` : whole;
}

// Keep the timeline time beneath an anchor pixel fixed while zoom changes width.
export function zoomScrollOffset(scroll: number, anchor: number, oldPx: number, newPx: number, viewport: number, duration: number): number {
  const time = (scroll + anchor) / oldPx;
  return clamp(time * newPx - anchor, 0, Math.max(0, duration * newPx - viewport));
}

function editorStatesEqual(a: EditorState, b: EditorState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
