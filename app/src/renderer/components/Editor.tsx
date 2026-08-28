import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExportProgress, WaveformData } from "../../shared/contracts";
import type { ClipRecord } from "../../shared/contracts";
import { Button, Icon, Modal } from "./ui";
import { Timeline } from "../editor/Timeline";
import { VideoPreview, formatEditorTime, mediaFileUrl } from "../editor/VideoPreview";
import {
  commitHistory,
  createEditorState,
  createHistory,
  deleteAudioSegment,
  deleteAudioTrack,
  deleteSegment,
  editedDuration,
  redoHistory,
  resetEditorState,
  resultToSourceTime,
  segmentAtTime,
  sourceToResultTime,
  splitSegment,
  trimSegment,
  trimSegmentToPlayhead,
  undoHistory,
  updateAudioTrack,
  type EditorAudioTrack,
  type EditorHistory,
  type EditorState,
} from "../editor/model";

interface Props {
  clip: ClipRecord;
  onClose: () => void;
  onExport: () => void;
}

export function Editor({ clip, onClose, onExport }: Props) {
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
  const [sourceTime, setSourceTime] = useState(0);
  const [visualPlayhead, setVisualPlayhead] = useState(0);
  const timelineScrubbingRef = useRef(false);
  const mediaDurationAppliedRef = useRef(false);
  const mediaDurationRef = useRef(mediaDuration);
  useEffect(() => {
    mediaDurationRef.current = mediaDuration;
  }, [mediaDuration]);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [loadingMedia, setLoadingMedia] = useState(true);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exporting, setExporting] = useState(false);
  const state = history.present;
  const outputDuration = editedDuration(state.segments);
  const resultTime = sourceToResultTime(state.segments, sourceTime);
  const clipName = clip.path.split(/[\\/]/).pop() ?? "Clip";
  const externalAudioReady = state.audioTracks.length > 0
    && state.audioTracks.every((track) => audioPreviewPaths.has(track.streamIndex));

  // Reset on clip change — authoritative duration resets to fallback until media loads
  useEffect(() => {
    setMediaDuration(fallbackDuration);
    mediaDurationAppliedRef.current = false;
    setSourceTime(0);
    setVisualPlayhead(0);
    timelineScrubbingRef.current = false;
  }, [clip.id, fallbackDuration]);

  useEffect(() => {
    let disposed = false;
    setLoadingMedia(true);
    setMediaError(null);
    setWaveforms(new Map());
    setFilmstrip([]);
    setAudioPreviewPaths(new Map());
    setSourceTime(0);
    setVisualPlayhead(0);
    timelineScrubbingRef.current = false;
    setZoom(1);
    setHistory(createHistory(createEditorState(fallbackDuration, [])));

    window.shard.generateTimelineFrames(clip.id, 36).then((frames) => {
      if (!disposed) setFilmstrip(frames);
    }).catch(() => {
      // The timeline remains usable when thumbnail extraction is unavailable.
    });
    window.shard.probeTracks(clip.id).then((tracks) => {
      if (disposed) return;
      const effectiveDuration = mediaDurationRef.current !== fallbackDuration ? mediaDurationRef.current : fallbackDuration;
      if (effectiveDuration !== fallbackDuration) mediaDurationAppliedRef.current = true;
      setHistory(createHistory(createEditorState(effectiveDuration, tracks)));
      setLoadingMedia(false);
      for (const track of tracks) {
        window.shard.prepareAudioPreview(clip.id, track.streamIndex).then((previewPath) => {
          if (disposed) return;
          setAudioPreviewPaths((current) => {
            const next = new Map(current);
            next.set(track.streamIndex, previewPath);
            return next;
          });
        }).catch((error: unknown) => {
          if (!disposed) setMediaError(`Live preview for ${track.name} is unavailable: ${errorMessage(error)}`);
        });
        window.shard.generateWaveform(clip.id, track.streamIndex, 2400).then((waveform) => {
          if (disposed) return;
          setWaveforms((current) => {
            const next = new Map(current);
            next.set(track.streamIndex, waveform);
            return next;
          });
        }).catch((error: unknown) => {
          if (!disposed) setMediaError(`Waveform for ${track.name} is unavailable: ${errorMessage(error)}`);
        });
      }
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
      unsubscribe();
    };
  }, [clip.id, fallbackDuration]);


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
    // No user edits yet and duration differs — recreate initial state with authoritative duration
    // preserving discovered audio tracks
    const currentTracks = history.present.audioTracks;
    // Convert EditorAudioTrack back to AudioTrackInfo shape for createEditorState
    const trackInfos = currentTracks.map((t) => ({
      streamIndex: t.streamIndex,
      name: t.name,
      codec: t.codec,
      kind: t.kind,
      channels: t.channels,
    }));
    setHistory(createHistory(createEditorState(mediaDuration, trackInfos as any)));
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

  const synchronizePreviewAudio = useCallback((forceSeek = false, shouldPlay?: boolean) => {
    const video = videoRef.current;
    if (!video || !externalAudioReady) return;
    for (const track of state.audioTracks) {
      const audio = audioRefs.current.get(track.streamIndex);
      if (!audio) continue;
      if (forceSeek || Math.abs(audio.currentTime - video.currentTime) > 0.12) audio.currentTime = video.currentTime;
      audio.volume = Math.min(1, Math.max(0, volume * track.volume));
      audio.muted = muted || track.muted;
      const play = shouldPlay ?? !video.paused;
      if (play && audio.paused) void audio.play().catch(() => {});
      else if (!play && !audio.paused) audio.pause();
    }
  }, [externalAudioReady, muted, state.audioTracks, volume]);

  const seekSource = useCallback((requestedTime: number) => {
    const segments = history.present.segments;
    if (!segments.length) return;
    const clamped = Math.max(0, Math.min(duration, requestedTime));
    const containing = segmentAtTime(segments, clamped);
    const target = containing?.sourceStart !== undefined
      ? clamped
      : (segments.find((segment) => segment.sourceStart > clamped)?.sourceStart ?? segments.at(-1)!.sourceEnd);
    if (videoRef.current) {
      videoRef.current.currentTime = target;
      synchronizePreviewAudio(true, !videoRef.current.paused);
    }
    setSourceTime(target);
    if (!timelineScrubbingRef.current) {
      setVisualPlayhead(target);
    }
  }, [duration, history.present.segments, synchronizePreviewAudio]);

  /** Seek by RESULT time (player seek bar, arrow keys). Converts to source. */
  const seekResult = useCallback((time: number) => {
    seekSource(resultToSourceTime(history.present.segments, Math.max(0, Math.min(outputDuration, time))));
  }, [history.present.segments, outputDuration, seekSource]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    const segments = history.present.segments;
    if (!video || !segments.length) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    const active = segmentAtTime(segments, video.currentTime);
    if (!active || video.currentTime >= segments.at(-1)!.sourceEnd - 0.01) {
      video.currentTime = segments[0].sourceStart;
      setSourceTime(segments[0].sourceStart);
      if (!timelineScrubbingRef.current) setVisualPlayhead(segments[0].sourceStart);
    }
    video.play().catch((error: unknown) => setMediaError(`Playback failed: ${errorMessage(error)}`));
  }, [history.present.segments]);

  const synchronizePlayback = useCallback(() => {
    const video = videoRef.current;
    const segments = history.present.segments;
    if (!video || !segments.length) return;
    const time = video.currentTime;
    const active = segmentAtTime(segments, time);
    if (!active) {
      const next = segments.find((segment) => segment.sourceStart > time);
      if (next && !video.paused) {
        video.currentTime = next.sourceStart;
        setSourceTime(next.sourceStart);
        if (!timelineScrubbingRef.current) setVisualPlayhead(next.sourceStart);
        synchronizePreviewAudio(true, true);
        return;
      }
      if (time >= segments.at(-1)!.sourceEnd - 0.001) {
        video.pause();
        video.currentTime = segments.at(-1)!.sourceEnd;
        synchronizePreviewAudio(true, false);
      }
    }
    synchronizePreviewAudio(false);
    setSourceTime(video.currentTime);
    if (!timelineScrubbingRef.current) {
      setVisualPlayhead(video.currentTime);
    }
  }, [history.present.segments, synchronizePreviewAudio]);

  const handlePlayingChange = useCallback((nextPlaying: boolean) => {
    setPlaying(nextPlaying);
    synchronizePreviewAudio(true, nextPlaying);
  }, [synchronizePreviewAudio]);

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

  const splitAtPlayhead = useCallback(() => {
    commit((current) => {
      const selected = segmentAtTime(current.segments, sourceTime)?.id ?? current.selectedSegmentId;
      return splitSegment(current, selected, sourceTime);
    });
  }, [commit, sourceTime]);

  const deleteSelected = useCallback(() => {
    commit((current) => deleteSegment(current, current.selectedSegmentId));
  }, [commit]);

  const undo = useCallback(() => setHistory((current) => undoHistory(current)), []);
  const redo = useCallback(() => setHistory((current) => redoHistory(current)), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && key === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if (event.ctrlKey && key === "y") {
        event.preventDefault();
        redo();
      } else if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const frameStep = 1 / Math.max(1, clip.fps ?? 30);
        const delta = (event.shiftKey ? frameStep : 5) * (event.key === "ArrowLeft" ? -1 : 1);
        seekResult(resultTime + delta);
      } else if (key === "s") {
        event.preventDefault();
        splitAtPlayhead();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clip.fps, deleteSelected, redo, resultTime, seekResult, splitAtPlayhead, togglePlayback, undo]);

  const startExport = () => {
    if (!state.segments.length || exporting) return;
    setExporting(true);
    setExportProgress({ clipId: clip.id, phase: "Queued", percent: 0, elapsedSec: 0, totalSec: outputDuration });
    onExport();
    void window.shard.startExport(clip.id, {
      segments: state.segments.map((segment) => ({ start: segment.sourceStart, end: segment.sourceEnd, id: segment.id })),
      audioTracks: state.audioTracks.map(({ streamIndex, name, included, muted: trackMuted, volume: trackVolume, excludedSegments }) => ({
        streamIndex,
        name,
        included,
        muted: trackMuted,
        volume: trackVolume,
        excludedSegmentIds: excludedSegments ?? [],
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

  return (
    <Modal open onClose={onClose} closeOnBackdrop={false} size="full">
      <div className="editor-workspace">
        <header className="editor-header">
          <Button variant="ghost" size="sm" icon={<Icon name="back" size={15} />} onClick={onClose}>Library</Button>
          <div className="editor-header__title">
            <strong title={clipName}>{clipName}</strong>
            <span>{clip.game ?? "Untagged"} · {formatEditorTime(duration)} source</span>
          </div>
          <div className="editor-header__meta num">{formatEditorTime(outputDuration, true)} output</div>
          <Button variant="primary" size="sm" icon={<Icon name="export" size={15} />} onClick={startExport} disabled={exporting || loadingMedia || !state.segments.length}>
            {exporting ? "Exporting…" : "Export clip"}
          </Button>
        </header>

        <main className="editor-main">
          <VideoPreview
            videoRef={videoRef}
            sourcePath={clip.path}
            playing={playing}
            muted={muted}
            nativeMuted={externalAudioReady}
            volume={volume}
            resultTime={resultTime}
            resultDuration={outputDuration}
            onTogglePlayback={togglePlayback}
            onSeekResult={seekResult}
            onMutedChange={changePlayerMuted}
            onVolumeChange={changePlayerVolume}
            onTimeUpdate={synchronizePlayback}
            onSeeked={synchronizePlayback}
            onPlayingChange={handlePlayingChange}
            onMediaError={setMediaError}
            onLoadedMetadata={handleLoadedMetadata}
          />
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

          {loadingMedia ? (
            <div className="editor-loading"><span className="spin" />Inspecting media streams…</div>
          ) : (
            <Timeline
              state={state}
              waveforms={waveforms}
              filmstrip={filmstrip}
              playhead={visualPlayhead}
              zoom={zoom}
              canUndo={history.past.length > 0}
              canRedo={history.future.length > 0}
              onZoomChange={setZoom}
              onScrub={(visualTime, playbackTime) => {
                timelineScrubbingRef.current = true;
                setVisualPlayhead(visualTime);
                seekSource(playbackTime);
              }}
              onScrubEnd={(visualTime, playbackTime) => {
                setVisualPlayhead(visualTime);
                seekSource(playbackTime);
                timelineScrubbingRef.current = false;
              }}
              onSelectSegment={(segmentId) => setHistory((current) => ({ ...current, present: { ...current.present, selectedSegmentId: segmentId } }))}
              onSplit={splitAtPlayhead}
              onDelete={deleteSelected}
              onTrim={(segmentId, edge, time) => commit((current) => trimSegment(current, segmentId, edge, time))}
              onTrimToPlayhead={() => commit((current) => current.selectedSegmentId ? trimSegmentToPlayhead(current, current.selectedSegmentId, sourceTime) : current)}
              onReset={() => commit(resetEditorState)}
              onUndo={undo}
              onRedo={redo}
              onTrackChange={(streamIndex: number, change: Partial<Pick<EditorAudioTrack, "included" | "muted" | "volume">>) => commit((current) => updateAudioTrack(current, streamIndex, change))}
              onDeleteAudioTrack={(streamIndex: number) => commit((current) => deleteAudioTrack(current, streamIndex))}
              onDeleteAudioSegment={(streamIndex: number, segmentId: string) => commit((current) => deleteAudioSegment(current, streamIndex, segmentId))}
            />
          )}
        </main>

        {(mediaError || exportProgress) && (
          <footer className="editor-status">
            {mediaError && <div className="editor-notice is-error"><Icon name="bell" size={15} /><span>{mediaError}</span><button onClick={() => setMediaError(null)} aria-label="Dismiss error"><Icon name="x" size={14} /></button></div>}
            {exportProgress && (
              <div className={`editor-export${exportProgress.error ? " is-error" : ""}${exportProgress.result ? " is-complete" : ""}`}>
                <div className="editor-export__copy">
                  <strong>{exportProgress.error ? "Export failed" : exportProgress.result ? "Export complete" : exportProgress.phase}</strong>
                  <span className="num">
                    {exportProgress.result
                      ? `${exportProgress.result.sizeMb} MB${exportProgress.result.overTarget ? " · over target" : ""}`
                      : exportProgress.error
                        ? exportProgress.error
                        : `${formatEditorTime(exportProgress.elapsedSec ?? 0)} / ${formatEditorTime(exportProgress.totalSec ?? outputDuration)}`}
                  </span>
                </div>
                {!exportProgress.done && <div className="editor-export__track"><span style={{ width: `${Math.max(0, Math.min(100, exportProgress.percent))}%` }} /></div>}
                {!exportProgress.done && <span className="editor-export__percent num">{Math.round(exportProgress.percent)}%</span>}
                {!exportProgress.done && <Button size="sm" onClick={() => void window.shard.cancelExport()}>Cancel</Button>}
                {exportProgress.result && <><Button size="sm" onClick={() => window.shard.openClip(exportProgress.result!.path)}>Open</Button><Button size="sm" icon={<Icon name="folderOpen" size={14} />} onClick={() => window.shard.revealInExplorer(exportProgress.result!.path)}>Reveal</Button></>}
              </div>
            )}
          </footer>
        )}
      </div>
    </Modal>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
