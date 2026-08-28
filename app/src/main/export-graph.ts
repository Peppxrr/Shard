import type { AudioTrackInfo, EditorExportProject } from "../shared/contracts";

export interface ExportSegment {
  start: number;
  end: number;
  id?: string;
}

export interface ExportAudioTrack {
  streamIndex: number;
  audioIndex: number;
  name: string;
  included: boolean;
  muted: boolean;
  volume: number;
  excludedSegmentIds?: string[];
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

export function resolveExportAudioTracks(
  available: readonly AudioTrackInfo[],
  requested: EditorExportProject["audioTracks"],
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

    return {
      streamIndex: source.streamIndex,
      audioIndex: source.audioIndex,
      name: String(track.name || source.name || `Audio ${source.audioIndex + 1}`).slice(0, 128),
      included: true,
      muted: Boolean(track.muted),
      volume: clamp(track.volume, 0, 2),
      excludedSegmentIds: Array.isArray(track.excludedSegmentIds)
        ? track.excludedSegmentIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  });
}

// Exported MP4s are delivery files, not editing containers. Collapse every
// selected editor track into one stereo AAC stream; source-track separation
// remains available only in the original clip and editor.
export function buildExportAudioOutputs(tracks: readonly ExportAudioTrack[]): ExportAudioOutput[] {
  return tracks.length ? [{ name: "Audio Mix", bitRateKbps: 192 }] : [];
}

export function buildExportGraph(
  segments: ExportSegment[],
  tracks: ExportAudioTrack[],
  width: number,
  height: number,
): ExportGraph {
  if (!segments.length) throw new Error("The edited timeline has no retained segments");
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 2) {
    throw new Error("The export resolution is invalid");
  }

  const audioTracks = tracks.filter((track) => track.included);
  const audioOutputs = buildExportAudioOutputs(audioTracks);
  const filters: string[] = [];
  const concatInputs: string[] = [];
  segments.forEach((segment, segmentIndex) => {
    const start = ffmpegNumber(segment.start);
    const end = ffmpegNumber(segment.end);
    const dur = ffmpegNumber(segment.end - segment.start);
    filters.push(`[0:v:0]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${segmentIndex}]`);
    concatInputs.push(`[v${segmentIndex}]`);

    audioTracks.forEach((track, audioIndex) => {
      const volume = track.muted ? 0 : clamp(track.volume, 0, 2);
      const isExcluded = track.excludedSegmentIds?.includes(segment.id ?? String(segmentIndex)) ?? false;
      if (isExcluded) {
        // Generate silence of same duration for this track's segment (keeps overall duration aligned)
        filters.push(`anullsrc=r=48000:cl=stereo:d=${dur},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${ffmpegNumber(volume)}[a${audioIndex}_${segmentIndex}]`);
      } else {
        const sel = track.streamIndex;
        filters.push(
          `[0:${sel}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,volume=${ffmpegNumber(volume)}[a${audioIndex}_${segmentIndex}]`,
        );
      }
      concatInputs.push(`[a${audioIndex}_${segmentIndex}]`);
    });
  });

  const concatAudioOutputs = audioTracks.map((_, index) => `[act${index}]`).join("");
  filters.push(
    `${concatInputs.join("")}concat=n=${segments.length}:v=1:a=${audioTracks.length}[vc]${concatAudioOutputs}`,
  );
  audioTracks.forEach((_, index) => {
    filters.push(
      `[act${index}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[am${index}]`,
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
  filters.push(
    `[vc]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v]`,
  );

  const maps = ["-map", "[v]"];
  if (audioOutputs.length) maps.push("-map", "[amix]");
  else maps.push("-an");

  return { filter: filters.join(";"), maps, audioOutputs };
}

export function validateExportSegments(segments: ExportSegment[], duration: number): ExportSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("The source clip has an invalid duration");
  if (!Array.isArray(segments) || !segments.length) throw new Error("No retained timeline segments were provided");

  let previousEnd = -1;
  return segments.map((segment, index) => {
    const start = Number(segment.start);
    const end = Number(segment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`Timeline segment ${index + 1} has invalid timestamps`);
    }
    if (start < 0 || end > duration + 0.05 || end - start < 0.01) {
      throw new Error(`Timeline segment ${index + 1} is outside the source clip`);
    }
    if (start < previousEnd - 0.000001) {
      throw new Error("Timeline segments must be ordered and non-overlapping");
    }
    previousEnd = end;
    return { start, end: Math.min(end, duration), id: segment.id };
  });
}

function ffmpegNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("FFmpeg filter received a non-finite number");
  return Number(value.toFixed(6)).toString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 1));
}
