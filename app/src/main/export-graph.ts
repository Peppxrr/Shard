import type { AudioTrackInfo, EditorExportProject, EditorTimelineClip } from "../shared/contracts";

// Clip edges closer than this are float noise from the renderer, not overlap.
const OVERLAP_TOLERANCE_SEC = 0.0005;
// Gaps shorter than this are not worth a filler input.
const MIN_GAP_SEC = 0.001;
const MIN_CLIP_SEC = 0.01;
const SOURCE_END_SLACK_SEC = 0.05;

export interface ExportAudioTrack {
  streamIndex: number;
  audioIndex: number;
  name: string;
  included: boolean;
  muted: boolean;
  volume: number;
  clips: EditorTimelineClip[];
}

export interface ExportAudioOutput {
  name: string;
  bitRateKbps: number;
}

export interface ExportGraph {
  filter: string;
  maps: string[];
  audioOutputs: ExportAudioOutput[];
}

type TimelinePiece = { kind: "gap"; duration: number } | { kind: "clip"; clip: EditorTimelineClip };

export function resolveExportAudioTracks(
  available: readonly AudioTrackInfo[],
  requested: EditorExportProject["audioTracks"],
  sourceDuration: number,
): ExportAudioTrack[] {
  if (!Array.isArray(requested)) throw new Error("The export audio selection is invalid");

  const availableByStream = new Map<number, AudioTrackInfo>();
  for (const track of available) {
    if (!Number.isInteger(track.streamIndex) || track.streamIndex < 0) {
      throw new Error(`The source contains an invalid audio stream index: ${track.streamIndex}`);
    }
    if (availableByStream.has(track.streamIndex)) {
      throw new Error(`The source contains audio stream ${track.streamIndex} more than once`);
    }
    availableByStream.set(track.streamIndex, track);
  }

  const seen = new Set<number>();
  return requested.filter((track) => track.included).map((track) => {
    if (!Number.isInteger(track.streamIndex)) {
      throw new Error(`Audio stream ${track.streamIndex} is invalid`);
    }
    const source = availableByStream.get(track.streamIndex);
    if (!source) throw new Error(`Audio stream ${track.streamIndex} does not exist in the source clip`);
    if (seen.has(track.streamIndex)) throw new Error(`Audio stream ${track.streamIndex} was selected more than once`);
    seen.add(track.streamIndex);

    const name = String(track.name || source.name || `Audio ${source.audioIndex + 1}`).slice(0, 128);
    return {
      streamIndex: source.streamIndex,
      audioIndex: source.audioIndex,
      name,
      included: true,
      muted: Boolean(track.muted),
      volume: clamp(track.volume, 0, 2),
      clips: validateTimelineClips(track.clips, sourceDuration, `Audio track "${name}"`),
    };
  });
}

// Returns the clips sorted by timeline position with source ends clamped to
// the source duration. Overlap within float tolerance is trimmed off the
// earlier clip; real overlap is rejected.
export function validateTimelineClips(
  clips: readonly EditorTimelineClip[],
  sourceDuration: number,
  label: string,
): EditorTimelineClip[] {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error("The source clip has an invalid duration");
  if (!Array.isArray(clips)) throw new Error(`${label} clips are invalid`);

  const normalized = clips.map((clip, index) => {
    const timelineStart = Number(clip?.timelineStart);
    const sourceStart = Number(clip?.sourceStart);
    const sourceEnd = Number(clip?.sourceEnd);
    if (!Number.isFinite(timelineStart) || !Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd)) {
      throw new Error(`${label} clip ${index + 1} has invalid timestamps`);
    }
    if (timelineStart < 0) throw new Error(`${label} clip ${index + 1} starts before the timeline`);
    if (sourceStart < 0 || sourceEnd > sourceDuration + SOURCE_END_SLACK_SEC) {
      throw new Error(`${label} clip ${index + 1} is outside the source clip`);
    }
    const end = Math.min(sourceEnd, sourceDuration);
    if (end - sourceStart < MIN_CLIP_SEC) throw new Error(`${label} clip ${index + 1} is too short`);
    return { timelineStart, sourceStart, sourceEnd: end };
  }).sort((a, b) => a.timelineStart - b.timelineStart);

  for (let index = 1; index < normalized.length; index++) {
    const previous = normalized[index - 1];
    const overlap = clipEnd(previous) - normalized[index].timelineStart;
    if (overlap > OVERLAP_TOLERANCE_SEC) throw new Error(`${label} clips overlap on the timeline`);
    if (overlap > 0) previous.sourceEnd -= overlap;
  }
  return normalized;
}

// Output length: the latest clip end across the video track and every
// included audio track. Gaps before it render as black/silence.
export function exportTimelineDuration(
  videoClips: readonly EditorTimelineClip[],
  audioTracks: readonly { included: boolean; clips: readonly EditorTimelineClip[] }[],
): number {
  let duration = 0;
  for (const clip of videoClips) duration = Math.max(duration, clipEnd(clip));
  for (const track of audioTracks) {
    if (!track.included) continue;
    for (const clip of track.clips) duration = Math.max(duration, clipEnd(clip));
  }
  if (!(duration > 0)) throw new Error("The edited timeline has no clips to export");
  return duration;
}

// Exported MP4s are delivery files, not editing containers. Collapse every
// selected editor track into one stereo AAC stream; source-track separation
// remains available only in the original clip and editor.
export function buildExportAudioOutputs(tracks: readonly ExportAudioTrack[]): ExportAudioOutput[] {
  return tracks.length ? [{ name: "Audio Mix", bitRateKbps: 192 }] : [];
}

export function buildExportGraph(
  videoClips: readonly EditorTimelineClip[],
  tracks: readonly ExportAudioTrack[],
  width: number,
  height: number,
  fps: number,
): ExportGraph {
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 2) {
    throw new Error("The export resolution is invalid");
  }
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("The export frame rate is invalid");

  const audioTracks = tracks.filter((track) => track.included);
  const duration = exportTimelineDuration(videoClips, audioTracks);
  const audioOutputs = buildExportAudioOutputs(audioTracks);
  const filters: string[] = [];

  // The dimensions already follow the source ratio. Scale each piece directly
  // to the codec-aligned size; padding would bake rounding slivers into the file.
  const size = `${width}x${height}`;
  const videoPieces = timelinePieces(videoClips, duration);
  videoPieces.forEach((piece, index) => {
    filters.push(piece.kind === "gap"
      ? `color=c=black:s=${size}:r=${ffmpegNumber(fps)}:d=${ffmpegNumber(piece.duration)},setsar=1[vp${index}]`
      : `[0:v:0]trim=start=${ffmpegNumber(piece.clip.sourceStart)}:end=${ffmpegNumber(piece.clip.sourceEnd)},` +
        `setpts=PTS-STARTPTS,scale=${width}:${height},setsar=1[vp${index}]`);
  });
  filters.push(`${videoPieces.map((_, index) => `[vp${index}]`).join("")}concat=n=${videoPieces.length}:v=1:a=0[v]`);

  const audioFormat = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
  audioTracks.forEach((track, audioIndex) => {
    const pieces = timelinePieces(track.clips, duration);
    pieces.forEach((piece, index) => {
      const label = `[a${audioIndex}_${index}]`;
      if (piece.kind === "gap") {
        filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${ffmpegNumber(piece.duration)},${audioFormat}${label}`);
        return;
      }
      const { sourceStart, sourceEnd } = piece.clip;
      // Pad short source reads so later pieces keep their timeline position.
      filters.push(
        `[0:${track.streamIndex}]atrim=start=${ffmpegNumber(sourceStart)}:end=${ffmpegNumber(sourceEnd)},` +
        `asetpts=PTS-STARTPTS,${audioFormat},apad=whole_dur=${ffmpegNumber(sourceEnd - sourceStart)}${label}`,
      );
    });
    const volume = track.muted ? 0 : clamp(track.volume, 0, 2);
    filters.push(
      `${pieces.map((_, index) => `[a${audioIndex}_${index}]`).join("")}concat=n=${pieces.length}:v=0:a=1,` +
      `volume=${ffmpegNumber(volume)}[am${audioIndex}]`,
    );
  });
  if (audioTracks.length === 1) {
    filters.push("[am0]anull[amix]");
  } else if (audioTracks.length > 1) {
    const mixInputs = audioTracks.map((_, index) => `[am${index}]`).join("");
    filters.push(
      `${mixInputs}amix=inputs=${audioTracks.length}:duration=longest:dropout_transition=0:normalize=0,` +
      "alimiter=limit=0.95[amix]",
    );
  }

  const maps = ["-map", "[v]"];
  if (audioOutputs.length) maps.push("-map", "[amix]");
  else maps.push("-an");

  return { filter: filters.join(";"), maps, audioOutputs };
}

// Splits one track into consecutive clip and filler pieces covering 0..duration.
function timelinePieces(clips: readonly EditorTimelineClip[], duration: number): TimelinePiece[] {
  const pieces: TimelinePiece[] = [];
  let cursor = 0;
  for (const clip of clips) {
    const gap = clip.timelineStart - cursor;
    if (gap >= MIN_GAP_SEC) pieces.push({ kind: "gap", duration: gap });
    pieces.push({ kind: "clip", clip });
    cursor = clipEnd(clip);
  }
  const tail = duration - cursor;
  if (tail >= MIN_GAP_SEC) pieces.push({ kind: "gap", duration: tail });
  return pieces;
}

function clipEnd(clip: EditorTimelineClip): number {
  return clip.timelineStart + clip.sourceEnd - clip.sourceStart;
}

function ffmpegNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("FFmpeg filter received a non-finite number");
  return Number(value.toFixed(6)).toString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 1));
}
