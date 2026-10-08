import type { EditorTimelineClip } from "./contracts";

export interface TimelineExportRange {
  start: number;
  end: number;
  duration: number;
}

/** Occupied bounds across video and included audio, preserving all inner gaps. */
export function timelineExportRange(
  videoClips: readonly EditorTimelineClip[],
  audioTracks: readonly { included: boolean; clips: readonly EditorTimelineClip[] }[],
): TimelineExportRange {
  let start = Infinity;
  let end = 0;
  const include = (clip: EditorTimelineClip) => {
    const clipEnd = clip.timelineStart + clip.sourceEnd - clip.sourceStart;
    if (!Number.isFinite(clip.timelineStart) || !Number.isFinite(clipEnd) || clipEnd <= clip.timelineStart) return;
    start = Math.min(start, clip.timelineStart);
    end = Math.max(end, clipEnd);
  };
  videoClips.forEach(include);
  for (const track of audioTracks) {
    if (track.included) track.clips.forEach(include);
  }
  return Number.isFinite(start) ? { start, end, duration: end - start } : { start: 0, end: 0, duration: 0 };
}
