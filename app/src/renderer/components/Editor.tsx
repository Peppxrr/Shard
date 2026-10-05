import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { ExportProgress, WaveformData } from "../../shared/contracts";
import type { ClipRecord } from "../../shared/contracts";
import { Button, Icon, IconButton, Modal, Toggle } from "./ui";
import { ClipRename } from "./ClipRename";
import { AUDIO_KIND_LABEL, Timeline, audioTrackColorStyle, volumeSliderStyle } from "../editor/Timeline";
import { VideoPreview, formatEditorTime, mediaFileUrl } from "../editor/VideoPreview";
import { usePlayerAudio } from "../editor/usePlayerAudio";
import {
  clipAt,
  clipEnd,
  commitHistory,
  createEditorState,
  createHistory,
  deleteAudioTrack,
  deleteClip,
  outputDuration,
  redoHistory,
  splitAllTracks,
  splitClip,
  trackClips,
  undoHistory,
  updateAudioTrack,
  type ClipSelection,
  type EditorAudioTrack,
  type EditorHistory,
  type EditorState,
  type TimelineClip,
} from "../editor/model";

const TIMELINE_HEIGHT_KEY = "shard:editorTimelineHeight";
const MIN_TIMELINE_HEIGHT = 150;
const MIN_STAGE_HEIGHT = 220;

const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"],
  ["S", "Split every track at the playhead"],
  ["Shift+S", "Split only the selected clip"],
  ["Del", "Delete the selected clip"],
  ["Shift (while dragging)", "Turn off snapping"],
  ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
  ["← / →", "Back / forward 5 s"],
  ["Shift+← / →", "One frame"],
  ["Ctrl+scroll", "Zoom timeline"],
];

const NOOP = () => {};

function exportClip({ timelineStart, sourceStart, sourceEnd }: TimelineClip) {
  return { timelineStart, sourceStart, sourceEnd };
}

interface Props {
  clip: ClipRecord;
  onClose: () => void;
  onExport: () => void;
  /** Leave the editor and show this exported file in the library viewer. */
  onOpenExport: (path: string) => void;
}

export function Editor({ clip: originalClip, onClose, onExport, onOpenExport }: Props) {
  const [renamedClip, setRenamedClip] = useState<ClipRecord | null>(null);
  const clip = renamedClip?.id === originalClip.id ? renamedClip : originalClip;
  const fallbackDuration = Math.max(0, clip.durationMs / 1000);
  const [mediaDuration, setMediaDuration] = useState(fallbackDuration);
  const duration = mediaDuration;
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRefs = useRef<Map<number, HTMLAudioElement>>(new Map());
  const initialState = useMemo(() => createEditorState(duration, []), [duration]);
  const [history, setHistory] = useState<EditorHistory>(() => createHistory(initialState));
  const [waveforms, setWaveforms] = useState<Map<number, WaveformData>>(() => new Map());
  const [filmstrip, setFilmstrip] = useState<string[]>([]);
  const [audioPreviewPaths, setAudioPreviewPaths] = useState<Map<number, string>>(() => new Map());
  /** Playhead in timeline seconds; the ref is the clock the transport reads. */
  const [time, setTime] = useState(0);
  const timeRef = useRef(0);
  /** True while the playhead sits in empty video time (the preview shows black). */
  const [blank, setBlank] = useState(false);
  const scrubbingRef = useRef(false);
  const mediaDurationAppliedRef = useRef(false);
  const mediaDurationRef = useRef(mediaDuration);
  useEffect(() => {
    mediaDurationRef.current = mediaDuration;
  }, [mediaDuration]);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  /** Video clip the media element is currently positioned in (null in a gap). */
  const activeVideoClipRef = useRef<string | null>(null);
  const { volume, setVolume, muted, setMuted } = usePlayerAudio("editor");
  const [zoom, setZoom] = useState(1);
  const [loadingMedia, setLoadingMedia] = useState(true);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exporting, setExporting] = useState(false);
  const state = history.present;
  const stateRef = useRef(state);
  stateRef.current = state;
  const totalDuration = outputDuration(state);
  const clipName = clip.path.split(/[\\/]/).pop() ?? "Clip";
  const externalAudioReady = state.audioTracks.length > 0
    && state.audioTracks.every((track) => audioPreviewPaths.has(track.streamIndex));

  // Reset on clip change — authoritative duration resets to fallback until media loads
  useEffect(() => {
    setMediaDuration(fallbackDuration);
    mediaDurationAppliedRef.current = false;
    timeRef.current = 0;
    setTime(0);
    scrubbingRef.current = false;
  }, [clip.id, fallbackDuration]);

  useEffect(() => {
    let disposed = false;
    const preparationId = crypto.randomUUID();
    setLoadingMedia(true);
    setMediaError(null);
    setWaveforms(new Map());
    setFilmstrip([]);
    setAudioPreviewPaths(new Map());
    timeRef.current = 0;
    setTime(0);
    activeVideoClipRef.current = null;
    scrubbingRef.current = false;
    setZoom(1);
    setHistory(createHistory(createEditorState(fallbackDuration, [])));

    window.shard.probeTracks(clip.id).then((tracks) => {
      if (disposed) return;
      const effectiveDuration = mediaDurationRef.current !== fallbackDuration ? mediaDurationRef.current : fallbackDuration;
      if (effectiveDuration !== fallbackDuration) mediaDurationAppliedRef.current = true;
      setHistory(createHistory(createEditorState(effectiveDuration, tracks)));
      setLoadingMedia(false);
      // Queue all tiny waveforms before any full-track AAC transcodes. Main
      // bounds decoder concurrency; each waveform is displayed as it finishes.
      const prepareTracks = async () => {
        await Promise.all(tracks.map(async (track) => {
          try {
            const waveform = await window.shard.generateWaveform(clip.id, track.streamIndex, 2400, preparationId);
            if (disposed) return;
            setWaveforms((current) => new Map(current).set(track.streamIndex, waveform));
          } catch (error) {
            if (!disposed) setMediaError(`Waveform for ${track.name} is unavailable: ${errorMessage(error)}`);
          }
        }));
        for (const track of tracks) {
          if (disposed) return;
          try {
            const previewPath = await window.shard.prepareAudioPreview(clip.id, track.streamIndex, preparationId);
            if (disposed) return;
            setAudioPreviewPaths((current) => new Map(current).set(track.streamIndex, previewPath));
          } catch (error) {
            if (!disposed) setMediaError(`Live preview for ${track.name} is unavailable: ${errorMessage(error)}`);
          }
        }
      };
      void prepareTracks();
    }).catch((error: unknown) => {
      if (disposed) return;
      setLoadingMedia(false);
      setMediaError(`Media inspection failed: ${errorMessage(error)}`);
    });

    const unsubscribe = window.shard.onExport((progress) => {
      if (progress.clipId !== clip.id || disposed) return;
      setExportProgress(progress);
      if (progress.done) setExporting(false);
    });
    return () => {
      disposed = true;
      window.shard.cancelEditorPreparation(preparationId);
      unsubscribe();
    };
  }, [clip.id, fallbackDuration]);


  // Twelve samples cover the normal overview; zooming requests more detail
  // without restarting playback, track preparation, or the edit history.
  const previewCount = Math.min(48, Math.max(12, Math.ceil(zoom * 12)));
  useEffect(() => {
    let disposed = false;
    const requestId = crypto.randomUUID();
    const unsubscribe = window.shard.onTimelineFrames((progress) => {
      if (!disposed && progress.requestId === requestId && progress.frames.some(Boolean)) setFilmstrip(progress.frames);
    });
    const timer = window.setTimeout(() => {
      void window.shard.generateTimelineFrames(clip.id, previewCount, requestId).then((frames) => {
        if (!disposed) setFilmstrip(frames);
      }).catch(() => { /* Editing remains available if thumbnail extraction fails. */ });
    }, previewCount === 12 ? 0 : 150);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unsubscribe();
      window.shard.cancelTimelineFrames(requestId);
    };
  }, [clip.id, previewCount]);


  // When actual video metadata arrives, upgrade the editor duration exactly once per clip
  // before user edits begin. This keeps the single duration authority (mediaDuration)
  // aligned with the timeline geometry.
  useEffect(() => {
    if (mediaDuration === fallbackDuration) return;
    if (mediaDurationAppliedRef.current) return;
    if (history.past.length > 0) {
      mediaDurationAppliedRef.current = true;
      return;
    }
    if (history.present.duration === mediaDuration) {
      mediaDurationAppliedRef.current = true;
      return;
    }
    // No user edits yet and duration differs — recreate initial state with
    // authoritative duration, preserving discovered audio tracks.
    setHistory(createHistory(createEditorState(mediaDuration, history.present.audioTracks)));
    mediaDurationAppliedRef.current = true;
  }, [mediaDuration, fallbackDuration, history]);

  // Development diagnostics: durations should be approximately identical
  useEffect(() => {
    if (!waveforms.size) return;
    if (videoRef.current?.duration === undefined) return;
    // Only log when we have everything
    const videoDuration = videoRef.current?.duration;
    const editorDuration = state.duration;
    // eslint-disable-next-line no-console
    console.debug("[editor-duration]", {
      clipRecordDuration: clip.durationMs / 1000,
      videoDuration,
      editorDuration,
      waveforms: [...waveforms.entries()].map(([streamIndex, waveform]) => ({
        streamIndex,
        duration: waveform.duration,
      })),
    });
    const durations = [videoDuration, editorDuration, ...[...waveforms.values()].map((w) => w.duration)].filter((d): d is number => typeof d === "number" && Number.isFinite(d));
    const max = Math.max(...durations);
    const min = Math.min(...durations);
    if (max - min > 0.05) {
      // eslint-disable-next-line no-console
      console.warn("[editor-duration] duration mismatch", {
        clipRecordDuration: clip.durationMs / 1000,
        videoDuration,
        editorDuration,
        waveforms: [...waveforms.entries()].map(([streamIndex, waveform]) => ({
          streamIndex,
          duration: waveform.duration,
        })),
        delta: max - min,
      });
    }
  }, [clip.durationMs, state.duration, waveforms]);

  const commit = useCallback((change: (current: EditorState) => EditorState) => {
    setHistory((current) => commitHistory(current, change(current.present)));
  }, []);

  // ------------------------------------------------------------------
  // Transport. The timeline clock is authoritative: inside a video clip
  // the media element supplies it (so picture and playhead never drift);
  // in empty time it advances in real time while the preview shows black.
  // Each audio element is positioned by its own track's clips.
  // ------------------------------------------------------------------
  const audioSettingsRef = useRef({ externalAudioReady, muted, volume });
  audioSettingsRef.current = { externalAudioReady, muted, volume };

  const syncAudio = useCallback((timelineTime: number, play: boolean, forceSeek: boolean) => {
    const settings = audioSettingsRef.current;
    if (!settings.externalAudioReady) return;
    const current = stateRef.current;
    const rate = videoRef.current?.playbackRate || 1;
    for (const track of current.audioTracks) {
      const audio = audioRefs.current.get(track.streamIndex);
      if (!audio) continue;
      audio.playbackRate = rate;
      audio.preservesPitch = true;
      audio.volume = Math.min(1, Math.max(0, settings.volume * track.volume));
      audio.muted = settings.muted || track.muted || !track.included;
      const clip = clipAt(trackClips(current, track.streamIndex), timelineTime);
      if (!clip) {
        if (!audio.paused) audio.pause();
        continue;
      }
      const source = clip.sourceStart + timelineTime - clip.timelineStart;
      if (forceSeek || Math.abs(audio.currentTime - source) > 0.12) audio.currentTime = source;
      if (play && audio.paused) void audio.play().catch(() => {});
      else if (!play && !audio.paused) audio.pause();
    }
  }, []);

  /** Positions the media element for timeline `timelineTime`: its clip's frame, or black in a gap. */
  const placeVideo = useCallback((timelineTime: number, play: boolean) => {
    const video = videoRef.current;
    if (!video) return;
    const clips = stateRef.current.videoClips;
    // Parked exactly on a clip's end (e.g. after playback stops) shows its last frame.
    const clip = clipAt(clips, timelineTime) ?? (play ? null : clips.find((value) => Math.abs(clipEnd(value) - timelineTime) < 0.0005) ?? null);
    if (!clip) {
      activeVideoClipRef.current = null;
      if (!video.paused) video.pause();
      setBlank(true);
      return;
    }
    const source = Math.min(clip.sourceEnd, clip.sourceStart + timelineTime - clip.timelineStart);
    if (!play || activeVideoClipRef.current !== clip.id || Math.abs(video.currentTime - source) > 0.05) video.currentTime = source;
    activeVideoClipRef.current = clip.id;
    setBlank(false);
    if (play && video.paused) void video.play().catch((error: unknown) => setMediaError(`Playback failed: ${errorMessage(error)}`));
    else if (!play && !video.paused) video.pause();
  }, []);

  const publishTime = useCallback((timelineTime: number) => {
    timeRef.current = timelineTime;
    setTime(timelineTime);
  }, []);

  const seekTimeline = useCallback((requested: number) => {
    const timelineTime = Math.max(0, requested);
    publishTime(timelineTime);
    placeVideo(timelineTime, playingRef.current);
    syncAudio(timelineTime, playingRef.current, true);
  }, [placeVideo, publishTime, syncAudio]);

  const pausePlayback = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    videoRef.current?.pause();
    syncAudio(timeRef.current, false, false);
  }, [syncAudio]);

  const startPlayback = useCallback(() => {
    const end = outputDuration(stateRef.current);
    if (end <= 0) return;
    const from = timeRef.current >= end - 0.01 ? 0 : timeRef.current;
    playingRef.current = true;
    setPlaying(true);
    publishTime(from);
    placeVideo(from, true);
    syncAudio(from, true, true);
  }, [placeVideo, publishTime, syncAudio]);

  const exportingRef = useRef(false);
  exportingRef.current = exporting;
  const togglePlayback = useCallback(() => {
    // The preview shows encoding progress while an export runs.
    if (exportingRef.current) return;
    if (playingRef.current) pausePlayback();
    else startPlayback();
  }, [pausePlayback, startPlayback]);

  // While encoding, the playhead and picture follow the encoder through the
  // edited timeline. Playback is paused, so no audio plays.
  useEffect(() => {
    if (!exporting || !exportProgress || exportProgress.done || exportProgress.elapsedSec === undefined) return;
    if (playingRef.current) pausePlayback();
    seekTimeline(Math.min(exportProgress.elapsedSec, outputDuration(stateRef.current)));
  }, [exporting, exportProgress, pausePlayback, seekTimeline]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    let lastPublish = -Infinity;
    const tick = (now: number) => {
      const video = videoRef.current;
      const current = stateRef.current;
      const elapsed = Math.max(0, (now - last) / 1000) * (video?.playbackRate || 1);
      last = now;
      let timelineTime = timeRef.current;
      const active = activeVideoClipRef.current ? current.videoClips.find((clip) => clip.id === activeVideoClipRef.current) : undefined;
      if (active && video) {
        if (!video.seeking) timelineTime = active.timelineStart + video.currentTime - active.sourceStart;
        if (video.ended || video.currentTime >= active.sourceEnd - 0.001) timelineTime = Math.max(timelineTime, clipEnd(active));
      } else {
        timelineTime += elapsed;
      }
      const end = outputDuration(current);
      if (timelineTime >= end) {
        publishTime(end);
        pausePlayback();
        placeVideo(end, false);
        return;
      }
      if ((clipAt(current.videoClips, timelineTime)?.id ?? null) !== activeVideoClipRef.current) placeVideo(timelineTime, true);
      syncAudio(timelineTime, true, false);
      timeRef.current = timelineTime;
      if (now - lastPublish >= 33) {
        setTime(timelineTime);
        lastPublish = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [pausePlayback, placeVideo, playing, publishTime, syncAudio]);

  // Edits change what sits under the playhead; volume/mute changes apply now.
  useEffect(() => {
    if (scrubbingRef.current) return;
    placeVideo(timeRef.current, playingRef.current);
    syncAudio(timeRef.current, playingRef.current, true);
  }, [state.videoClips, state.audioTracks, state.audioLinked, placeVideo, syncAudio]);
  useEffect(() => {
    syncAudio(timeRef.current, playingRef.current, false);
  }, [externalAudioReady, muted, volume, syncAudio]);

  // Keep the cursor responsive while the decoder catches up. Coalesce pointer
  // movement to the latest target instead of restarting an in-flight seek.
  const scrubSeekRef = useRef<{ frame: number; target: number | null; resume: boolean }>({ frame: 0, target: null, resume: false });
  const flushScrubSeek = useCallback(() => {
    const pending = scrubSeekRef.current;
    pending.frame = 0;
    if (!scrubbingRef.current || pending.target === null) return;
    if (!videoRef.current?.seeking) {
      placeVideo(pending.target, false);
      pending.target = null;
    } else {
      pending.frame = requestAnimationFrame(flushScrubSeek);
    }
  }, [placeVideo]);
  const handleScrub = useCallback((timelineTime: number) => {
    const pending = scrubSeekRef.current;
    if (!scrubbingRef.current) {
      pending.resume = playingRef.current;
      if (playingRef.current) pausePlayback();
      scrubbingRef.current = true;
    }
    publishTime(timelineTime);
    pending.target = timelineTime;
    if (!pending.frame) pending.frame = requestAnimationFrame(flushScrubSeek);
  }, [flushScrubSeek, pausePlayback, publishTime]);
  const handleScrubEnd = useCallback((timelineTime: number) => {
    const pending = scrubSeekRef.current;
    cancelAnimationFrame(pending.frame);
    pending.frame = 0;
    pending.target = null;
    scrubbingRef.current = false;
    seekTimeline(timelineTime);
    if (pending.resume) startPlayback();
    pending.resume = false;
  }, [seekTimeline, startPlayback]);
  useEffect(() => () => {
    cancelAnimationFrame(scrubSeekRef.current.frame);
    scrubSeekRef.current = { frame: 0, target: null, resume: false };
    scrubbingRef.current = false;
    playingRef.current = false;
  }, [clip.id]);

  const handleLoadedMetadata = useCallback(() => {
    const actualDuration = videoRef.current?.duration;
    if (
      actualDuration !== undefined &&
      Number.isFinite(actualDuration) &&
      actualDuration > 0
    ) {
      setMediaDuration(actualDuration);
    }
  }, []);

  /** S razors through every track; Shift+S splits only the selected clip's track. */
  const splitAtPlayhead = useCallback((selectedOnly: boolean) => {
    commit((current) => selectedOnly && current.selection
      ? splitClip(current, current.selection.track, timeRef.current)
      : splitAllTracks(current, timeRef.current));
  }, [commit]);

  const deleteSelected = useCallback(() => {
    commit((current) => current.selection ? deleteClip(current, current.selection.track, current.selection.clipId) : current);
  }, [commit]);

  const undo = useCallback(() => setHistory((current) => undoHistory(current)), []);
  const redo = useCallback(() => setHistory((current) => redoHistory(current)), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]") || target?.closest('[role="listbox"]')) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && key === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if (event.ctrlKey && key === "y") {
        event.preventDefault();
        redo();
      } else if (event.code === "Space") {
        if (target?.closest("button")) return;
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const frameStep = 1 / Math.max(1, clip.fps ?? 30);
        const delta = (event.shiftKey ? frameStep : 5) * (event.key === "ArrowLeft" ? -1 : 1);
        seekTimeline(Math.min(outputDuration(stateRef.current), timeRef.current + delta));
      } else if (key === "s") {
        event.preventDefault();
        splitAtPlayhead(event.shiftKey);
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clip.fps, deleteSelected, redo, seekTimeline, splitAtPlayhead, togglePlayback, undo]);

  const startExport = () => {
    if (totalDuration <= 0 || exporting) return;
    setExporting(true);
    setExportProgress({ clipId: clip.id, phase: "Queued", percent: 0, elapsedSec: 0, totalSec: totalDuration });
    onExport();
    void window.shard.startExport(clip.id, {
      videoClips: state.videoClips.map(exportClip),
      audioTracks: state.audioTracks.map((track) => ({
        streamIndex: track.streamIndex,
        name: track.name,
        included: track.included,
        muted: track.muted,
        volume: track.volume,
        clips: trackClips(state, track.streamIndex).map(exportClip),
      })),
    }).catch((error: unknown) => {
      setExporting(false);
      setExportProgress({ clipId: clip.id, phase: "done", percent: 100, done: true, error: errorMessage(error) });
    });
  };

  const changePlayerVolume = (nextVolume: number) => {
    const safeVolume = Math.max(0, Math.min(1, nextVolume));
    setVolume(safeVolume);
    if (videoRef.current) videoRef.current.volume = safeVolume;
    if (safeVolume > 0 && muted) {
      setMuted(false);
      if (videoRef.current) videoRef.current.muted = false;
    }
  };

  const changePlayerMuted = (nextMuted: boolean) => {
    setMuted(nextMuted);
    if (videoRef.current) videoRef.current.muted = nextMuted;
  };

  // The timeline keeps its natural height until the user drags the divider;
  // the stage always gets the remaining space.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [timelineHeight, setTimelineHeight] = useState<number | null>(() => {
    try { const saved = Number(localStorage.getItem(TIMELINE_HEIGHT_KEY)); return saved > 0 ? saved : null; } catch { return null; }
  });
  const clampTimelineHeight = (height: number) => {
    const available = bodyRef.current?.clientHeight ?? 600;
    return Math.round(Math.max(MIN_TIMELINE_HEIGHT, Math.min(available - MIN_STAGE_HEIGHT, height)));
  };
  const storeTimelineHeight = (height: number | null) => {
    setTimelineHeight(height);
    try {
      if (height === null) localStorage.removeItem(TIMELINE_HEIGHT_KEY);
      else localStorage.setItem(TIMELINE_HEIGHT_KEY, String(height));
    } catch { /* Layout preference only. */ }
  };
  const currentTimelineHeight = () => bodyRef.current?.querySelector<HTMLElement>(".timeline, .editor-loading")?.offsetHeight ?? MIN_TIMELINE_HEIGHT;
  const startTimelineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = currentTimelineHeight();
    let latest = startHeight;
    const move = (moveEvent: PointerEvent) => {
      latest = clampTimelineHeight(startHeight + startY - moveEvent.clientY);
      setTimelineHeight(latest);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      storeTimelineHeight(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const resizeTimelineWithKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    storeTimelineHeight(clampTimelineHeight(currentTimelineHeight() + (event.key === "ArrowUp" ? 24 : -24)));
  };

  const selection = state.selection;
  const selectedTrackClips = selection ? trackClips(state, selection.track) : [];
  const selectedIndex = selection ? selectedTrackClips.findIndex((value) => value.id === selection.clipId) : -1;
  const selectedClip = selectedIndex >= 0 ? selectedTrackClips[selectedIndex] : null;
  const selectedTrackName = !selection || selection.track === "video"
    ? "Video"
    : state.audioTracks.find((track) => track.streamIndex === selection.track)?.name ?? "Audio";
  const encodingStatus = exporting && exportProgress && !exportProgress.done
    ? `${exportProgress.phase} · ${Math.round(exportProgress.percent)}%`
    : undefined;
  // Only a finished export opens the dialog; cancelling just ends quietly.
  const finishedExport = exportProgress?.done && exportProgress.error !== "Export cancelled" ? exportProgress : null;
  const [exportActionError, setExportActionError] = useState<string | null>(null);
  const dismissExport = useCallback(() => {
    setExportProgress(null);
    setExportActionError(null);
  }, []);
  // Escape closes the dialog without reaching the editor's own Escape-to-close.
  useEffect(() => {
    if (!finishedExport) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      dismissExport();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dismissExport, finishedExport]);
  /** The export is indexed by the library's folder watcher; find it by path, then delete it like any clip. */
  const deleteExport = async (filePath: string) => {
    const normalize = (value: string) => value.replace(/\\/g, "/").toLowerCase();
    for (let attempt = 0; attempt < 10; attempt++) {
      const record = (await window.shard.listClips()).find((candidate) => normalize(candidate.path) === normalize(filePath));
      if (record) {
        try {
          await window.shard.deleteClip(record.id);
          dismissExport();
        } catch (error) {
          setExportActionError(`Could not delete the export: ${errorMessage(error)}`);
        }
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
    }
    setExportActionError("The export is not in the library yet. Try again in a moment.");
  };

  return (
    <Modal open onClose={onClose} closeOnBackdrop={false} size="full">
      <div data-shard-page="editor" data-playing={playing} className="editor editor-workspace">
        <header data-shard-slot="toolbar" className="editor-header">
          <Button variant="ghost" size="sm" icon={<Icon name="back" size={15} />} onClick={onClose}>Library</Button>
          <span className="editor-header__divider" aria-hidden="true" />
          <div className="editor-header__title">
            <strong title={clipName}>{clipName}</strong>
            <span>{clip.game ?? "Untagged"} · {formatEditorTime(duration)}</span>
          </div>
          <div data-shard-slot="editor-rename" className="editor-header__rename">
            <ClipRename clip={clip} onRenamed={setRenamedClip} mediaRef={videoRef} disabled={exporting || loadingMedia} />
          </div>
          {exporting ? (
            <Button size="sm" icon={<Icon name="x" size={15} />} onClick={() => void window.shard.cancelExport()}>Cancel export</Button>
          ) : (
            <Button variant="primary" size="sm" icon={<Icon name="export" size={15} />} onClick={startExport} disabled={loadingMedia || totalDuration <= 0}>Export clip</Button>
          )}
        </header>

        <div ref={bodyRef} data-shard-slot="editor-body" className="editor-body" data-timeline-size={timelineHeight === null ? "auto" : "custom"}
          style={timelineHeight === null ? undefined : { "--editor-timeline-h": `${timelineHeight}px` } as CSSProperties}>
          <div data-shard-slot="editor-stage" className="editor-stage">
            <VideoPreview
              videoRef={videoRef}
              sourcePath={clip.path}
              posterPath={clip.thumb}
              compact
              playing={playing}
              blank={blank}
              statusText={encodingStatus}
              muted={muted}
              nativeMuted={externalAudioReady || !state.audioLinked}
              volume={volume}
              resultTime={time}
              resultDuration={totalDuration}
              onTogglePlayback={togglePlayback}
              onSeekResult={seekTimeline}
              onMutedChange={changePlayerMuted}
              onVolumeChange={changePlayerVolume}
              onTimeUpdate={NOOP}
              onSeeked={NOOP}
              onPlayingChange={NOOP}
              onMediaError={setMediaError}
              onLoadedMetadata={handleLoadedMetadata}
              onPlaybackRateChange={() => syncAudio(timeRef.current, playingRef.current, true)}
            />
          </div>

          <aside data-shard-slot="editor-inspector" className="editor-inspector" aria-label="Edit details">
            {mediaError && <div className="editor-notice is-error" role="alert"><Icon name="bell" size={15} /><span>{mediaError}</span><button type="button" onClick={() => setMediaError(null)} aria-label="Dismiss error"><Icon name="x" size={14} /></button></div>}

            <section data-shard-slot="editor-output" className="editor-panel">
              <h3 className="editor-panel__title">Output</h3>
              <div className="editor-output">
                <strong className="num">{formatEditorTime(totalDuration, true)}</strong>
              </div>
              <dl className="editor-facts">
                {clip.width && clip.height ? <div><dt>Resolution</dt><dd className="num">{clip.width}×{clip.height}</dd></div> : null}
                {clip.fps ? <div><dt>Frame rate</dt><dd className="num">{Math.round(clip.fps)} fps</dd></div> : null}
              </dl>
            </section>

            <section data-shard-slot="editor-selection" className="editor-panel">
              <h3 className="editor-panel__title">Selection</h3>
              {selectedClip ? (
                <dl className="editor-facts">
                  <div><dt>Track</dt><dd>{selectedTrackName}</dd></div>
                  <div><dt>Clip</dt><dd className="num">{selectedIndex + 1} of {selectedTrackClips.length}</dd></div>
                  <div><dt>Starts</dt><dd className="num">{formatEditorTime(selectedClip.timelineStart, true)}</dd></div>
                  <div><dt>Ends</dt><dd className="num">{formatEditorTime(clipEnd(selectedClip), true)}</dd></div>
                  <div><dt>Length</dt><dd className="num">{formatEditorTime(selectedClip.sourceEnd - selectedClip.sourceStart, true)}</dd></div>
                </dl>
              ) : <p className="editor-panel__empty">Click a clip on the timeline to select it.</p>}
            </section>

            <section data-shard-slot="editor-mixer" className="editor-panel">
              <h3 className="editor-panel__title">Audio</h3>
              {state.audioTracks.length ? state.audioTracks.map((track) => (
                <div key={track.streamIndex} data-shard-component="mixer-track" data-muted={track.muted} data-included={track.included} className="editor-mixer__track" style={audioTrackColorStyle(track)}>
                  <div className="editor-mixer__head">
                    <IconButton size="sm" label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`} active={track.muted}
                      onClick={() => commit((current) => updateAudioTrack(current, track.streamIndex, { muted: !track.muted }))}>
                      <Icon name={track.muted ? "volumeOff" : "speaker"} size={14} />
                    </IconButton>
                    <span className="editor-mixer__name"><strong title={track.name}>{track.name}</strong><small>{AUDIO_KIND_LABEL[track.kind]} · {track.channels || "?"} ch</small></span>
                    <label className="editor-mixer__include" title="Include in export">
                      <span className="sr">Include {track.name} in export</span>
                      <Toggle checked={track.included} onChange={(included) => commit((current) => updateAudioTrack(current, track.streamIndex, { included }))} />
                    </label>
                  </div>
                  <label className="editor-mixer__volume">
                    <span className="sr">{track.name} volume</span>
                    <input className="volume-slider" type="range" min={0} max={2} step={0.05} value={track.volume} disabled={!track.included}
                      style={volumeSliderStyle(track.volume, 2)}
                      onChange={(event) => commit((current) => updateAudioTrack(current, track.streamIndex, { volume: Number(event.target.value) }))} />
                    <span className="num">{Math.round(track.volume * 100)}%</span>
                  </label>
                </div>
              )) : <p className="editor-panel__empty">{loadingMedia ? "Inspecting audio streams…" : "This clip has no audio. Exports are video only."}</p>}
              {state.audioTracks.length > 0 && <p className="editor-panel__hint">{state.audioLinked ? "Right-click the video track and choose Separate audio tracks to trim, move, or remove audio on its own." : "Audio tracks have their own clips. Collapsing them only hides the rows; Relink audio to video makes audio follow the video clips again."}</p>}
            </section>

            <details data-shard-slot="editor-shortcuts" className="editor-panel editor-shortcuts">
              <summary className="editor-panel__title">Keyboard shortcuts</summary>
              <dl>{SHORTCUTS.map(([keys, action]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{action}</dd></div>)}</dl>
            </details>
          </aside>

          <div data-shard-slot="timeline-resize" className="editor-resize" role="separator" aria-orientation="horizontal" aria-label="Resize timeline"
            tabIndex={0} title="Drag to resize · double-click to reset" onPointerDown={startTimelineResize} onKeyDown={resizeTimelineWithKeys}
            onDoubleClick={() => storeTimelineHeight(null)} />

          {loadingMedia ? (
            <div className="editor-loading"><span className="spin" />Inspecting media streams…</div>
          ) : (
            <Timeline
              state={state}
              waveforms={waveforms}
              filmstrip={filmstrip}
              playhead={time}
              zoom={zoom}
              canUndo={history.past.length > 0}
              canRedo={history.future.length > 0}
              onZoomChange={setZoom}
              onScrub={handleScrub}
              onScrubEnd={handleScrubEnd}
              onSelect={(next: ClipSelection | null) => setHistory((current) => ({ ...current, present: { ...current.present, selection: next } }))}
              onCommit={commit}
              onUndo={undo}
              onRedo={redo}
              onTrackChange={(streamIndex: number, change: Partial<Pick<EditorAudioTrack, "included" | "muted" | "volume">>) => commit((current) => updateAudioTrack(current, streamIndex, change))}
              onDeleteAudioTrack={(streamIndex: number) => commit((current) => deleteAudioTrack(current, streamIndex))}
            />
          )}

          <div className="editor-audio-previews" aria-hidden="true">
            {state.audioTracks.map((track) => {
              const previewPath = audioPreviewPaths.get(track.streamIndex);
              return previewPath ? (
                <audio
                  key={track.streamIndex}
                  ref={(element) => {
                    if (element) audioRefs.current.set(track.streamIndex, element);
                    else audioRefs.current.delete(track.streamIndex);
                  }}
                  src={mediaFileUrl(previewPath)}
                  preload="auto"
                />
              ) : null;
            })}
          </div>
        </div>

        {finishedExport && (
          <div className="editor-export-dialog" onMouseDown={dismissExport}>
            <div data-shard-slot="editor-export" className={`editor-export-dialog__panel${finishedExport.error ? " is-error" : ""}`}
              role="dialog" aria-modal="true" aria-label={finishedExport.error ? "Export failed" : "Export complete"} onMouseDown={(event) => event.stopPropagation()}>
              <IconButton size="sm" className="editor-export-dialog__close" label="Close" onClick={dismissExport}><Icon name="x" size={15} /></IconButton>
              <div className="editor-export-dialog__copy">
                <strong>{finishedExport.error ? "Export failed" : "Export complete"}</strong>
                <span className="num">{exportActionError ?? finishedExport.error ?? `${finishedExport.result?.sizeMb} MB${finishedExport.result?.overTarget ? " · over target" : ""}`}</span>
              </div>
              <div className="editor-export-dialog__actions">
                {finishedExport.result && <>
                  <Button size="sm" variant="primary" onClick={() => onOpenExport(finishedExport.result!.path)}>Open</Button>
                  <IconButton size="sm" label="Show in folder" onClick={() => window.shard.revealInExplorer(finishedExport.result!.path)}><Icon name="folderOpen" size={15} /></IconButton>
                  <IconButton size="sm" variant="danger" label="Delete export" onClick={() => void deleteExport(finishedExport.result!.path)}><Icon name="trash" size={15} /></IconButton>
                </>}
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
