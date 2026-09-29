import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { ContextMenu, Icon, IconButton, ShardSelect } from "../components/ui";
import { measurePlayback } from "./playbackDiagnostics";
import { usePlayerAudio } from "./usePlayerAudio";

interface VideoPreviewProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  sourcePath: string;
  posterPath?: string;
  playing: boolean;
  muted: boolean;
  nativeMuted?: boolean;
  volume: number;
  resultTime: number;
  resultDuration: number;
  className?: string;
  autoPlay?: boolean;
  loop?: boolean;
  onTogglePlayback: () => void;
  onSeekResult: (time: number) => void;
  onMutedChange: (muted: boolean) => void;
  onVolumeChange: (volume: number) => void;
  onTimeUpdate: () => void;
  onSeeked: () => void;
  onPlayingChange: (playing: boolean) => void;
  onMediaError: (message: string) => void;
  onLoadedMetadata?: () => void;
  onPlaybackRateChange?: () => void;
}

export function VideoPreview({
  videoRef,
  sourcePath,
  posterPath,
  playing,
  muted,
  nativeMuted = false,
  volume,
  resultTime,
  resultDuration,
  className,
  autoPlay = false,
  loop = false,
  onTogglePlayback,
  onSeekResult,
  onMutedChange,
  onVolumeChange,
  onTimeUpdate,
  onSeeked,
  onPlayingChange,
  onMediaError,
  onLoadedMetadata,
  onPlaybackRateChange,
}: VideoPreviewProps) {
  const safeDuration = Math.max(resultDuration, 0.001);
  const playerRef = useRef<HTMLElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const hideControlsTimer = useRef<number | undefined>(undefined);
  const [fullscreen, setFullscreen] = useState(false);
  const [playbackRate, setPlaybackRate] = useState("1");
  const [controlsVisible, setControlsVisible] = useState(true);
  const [mediaState, setMediaState] = useState<"loading" | "ready" | "error">("loading");
  const previousPlayback = useRef({ playing, sourcePath });
  const [feedback, setFeedback] = useState<{ name: "play" | "pause"; sequence: number } | null>(null);
  const feedbackSequence = useRef(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [reportStatus, setReportStatus] = useState("");
  const reportAbort = useRef<AbortController | null>(null);
  const reportTimer = useRef<number | undefined>(undefined);
  const revealControls = useCallback(() => {
    if (document.fullscreenElement !== playerRef.current) return;
    setControlsVisible(true);
    window.clearTimeout(hideControlsTimer.current);
    hideControlsTimer.current = window.setTimeout(() => {
      const focusedControl = controlsRef.current?.contains(document.activeElement)
        && document.activeElement?.matches(":focus-visible");
      if (!focusedControl && !controlsRef.current?.querySelector(":popover-open")) setControlsVisible(false);
    }, playing ? 3200 : 5000);
  }, [playing]);

  useEffect(() => {
    const syncFullscreen = () => {
      const active = document.fullscreenElement === playerRef.current;
      setFullscreen(active);
      if (active) revealControls();
      else {
        window.clearTimeout(hideControlsTimer.current);
        setControlsVisible(true);
      }
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("keydown", revealControls);
    syncFullscreen();
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      document.removeEventListener("keydown", revealControls);
      window.clearTimeout(hideControlsTimer.current);
    };
  }, [revealControls]);
  // Apply the remembered level before autoplay, including newly mounted media.
  useLayoutEffect(() => {
    if (videoRef.current) videoRef.current.volume = Math.max(0, Math.min(1, volume));
  }, [videoRef, sourcePath, volume]);
  useLayoutEffect(() => {
    if (videoRef.current) {
      videoRef.current.defaultPlaybackRate = Number(playbackRate);
      videoRef.current.playbackRate = Number(playbackRate);
      videoRef.current.preservesPitch = true;
    }
  }, [videoRef, sourcePath, playbackRate]);
  useEffect(() => {
    setMediaState("loading");
    setMenu(null);
    setReportStatus("");
    return () => {
      reportAbort.current?.abort();
      reportAbort.current = null;
      window.clearTimeout(reportTimer.current);
    };
  }, [sourcePath]);

  const copyReport = async () => {
    setMenu(null);
    const video = videoRef.current;
    if (!video || reportAbort.current) return;
    const controller = new AbortController();
    reportAbort.current = controller;
    window.clearTimeout(reportTimer.current);
    setReportStatus("Measuring playback for 5 seconds — keep the video playing.");
    try {
      const sample = await measurePlayback(video, controller.signal);
      if (controller.signal.aborted) return;
      await window.shard.copyPlaybackReport(JSON.stringify(sample));
      if (!controller.signal.aborted) setReportStatus("Playback report copied.");
    } catch (error) {
      if (!controller.signal.aborted) setReportStatus(`Report failed: ${errorMessage(error)}`);
    } finally {
      if (!controller.signal.aborted) {
        reportAbort.current = null;
        reportTimer.current = window.setTimeout(() => setReportStatus(""), 5000);
      }
    }
  };

  useEffect(() => {
    const previous = previousPlayback.current;
    previousPlayback.current = { playing, sourcePath };
    if (previous.sourcePath !== sourcePath || videoRef.current?.ended) {
      setFeedback(null);
    } else if (previous.playing !== playing) {
      setFeedback({ name: playing ? "play" : "pause", sequence: ++feedbackSequence.current });
    }
  }, [playing, sourcePath, videoRef]);

  const toggleFullscreen = async () => {
    const stage = playerRef.current;
    if (!stage) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stage.requestFullscreen();
  };

  return (
    <section ref={playerRef} data-shard-component="player" data-shard-state={mediaState} data-playing={playing} data-fullscreen={fullscreen}
      data-controls-visible={controlsVisible} className={["editor-player", className].filter(Boolean).join(" ")}
      aria-label="Video preview" onPointerMove={revealControls} onPointerDownCapture={revealControls}>
      <div data-shard-slot="player-stage" className="editor-player__stage" onClick={onTogglePlayback}
        onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}>
        <video
          data-shard-slot="player-video"
          ref={videoRef}
          className="editor-player__video"
          src={mediaFileUrl(sourcePath)}
          poster={posterPath ? mediaFileUrl(posterPath) : undefined}
          preload="auto"
          controls={false}
          playsInline
          autoPlay={autoPlay}
          loop={loop}
          muted={nativeMuted || muted}
          onLoadedMetadata={onLoadedMetadata}
          onRateChange={onPlaybackRateChange}
          onLoadedData={() => setMediaState("ready")}
          onCanPlay={() => setMediaState("ready")}
          onWaiting={() => setMediaState("loading")}
          onTimeUpdate={onTimeUpdate}
          onSeeked={onSeeked}
          onPlay={() => onPlayingChange(true)}
          onPause={() => onPlayingChange(false)}
          onError={(event) => {
            setMediaState("error");
            const code = event.currentTarget.error?.code;
            onMediaError(code ? `The clip could not be decoded (media error ${code}).` : "The clip could not be loaded.");
          }}
        />
        {feedback && (
          <span
            data-shard-slot="player-feedback"
            key={feedback.sequence}
            className="editor-player__feedback"
            aria-hidden="true"
            onAnimationEnd={() => setFeedback(null)}
          >
            <Icon name={feedback.name} size={42} />
          </span>
        )}
        {mediaState === "loading" && <span data-shard-slot="player-loading" className="editor-player__loading" role="status"><span className="spin" aria-hidden="true" />Loading preview…</span>}
        {reportStatus && <span data-shard-slot="player-status" className="editor-player__report-status" role="status">{reportStatus}</span>}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
        <button type="button" role="menuitem" disabled={!!reportAbort.current} onClick={() => void copyReport()}
          onKeyDown={(event) => { if (event.key === "Escape") setMenu(null); }}>
          Copy playback diagnostics
        </button>
      </ContextMenu>}

      <div ref={controlsRef} data-shard-slot="player-controls" className="editor-player__controls"
        onClick={(event) => event.stopPropagation()}
        onFocusCapture={revealControls} onBlurCapture={revealControls}>
        <input
          data-shard-slot="player-seek"
          className="editor-player__seek"
          type="range"
          min={0}
          max={safeDuration}
          step={0.001}
          value={Math.min(resultTime, safeDuration)}
          aria-label="Playback position"
          disabled={mediaState === "error" || resultDuration <= 0}
          style={{ "--seek-progress": `${Math.min(100, (resultTime / safeDuration) * 100)}%` } as CSSProperties}
          onChange={(event) => onSeekResult(Number(event.target.value))}
        />
        <div data-shard-slot="player-transport" className="editor-player__controls-row">
          <IconButton label={playing ? "Pause (Space)" : "Play (Space)"} disabled={mediaState === "error"} onClick={onTogglePlayback}>
            <Icon name={playing ? "pause" : "play"} size={18} />
          </IconButton>
          <span data-shard-slot="player-time" className="editor-player__time num">
            {formatEditorTime(resultTime, true)} <span>/</span> {formatEditorTime(resultDuration)}
          </span>
          <span className="spacer" />
          <IconButton label={muted ? "Unmute" : "Mute"} active={muted} onClick={() => onMutedChange(!muted)}>
            <Icon name={muted || volume === 0 ? "volumeOff" : "volume"} size={18} />
          </IconButton>
          <input
            data-shard-slot="player-volume"
            className="editor-player__volume volume-slider"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            aria-label="Volume"
            style={{
              "--range-progress": `${Math.max(0, Math.min(100, volume * 100))}%`,
              "--range-color": "var(--accent)",
            } as CSSProperties}
            onChange={(event) => onVolumeChange(Number(event.target.value))}
          />
          <span data-shard-slot="player-speed" className="editor-player__speed" title="Preview playback speed">
            <ShardSelect ariaLabel="Playback speed" value={playbackRate} onChange={setPlaybackRate}
              options={["0.25", "0.5", "0.75", "1", "1.25", "1.5", "2"].map((value) => ({ value, label: `${value}×` }))} />
          </span>
          <IconButton label={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={() => void toggleFullscreen()}>
            <Icon name={fullscreen ? "restore" : "maximize"} size={17} />
          </IconButton>
        </div>
      </div>
    </section>
  );
}

export function StandaloneVideoPlayer({ sourcePath, posterPath, loop = true, mediaRef }: { sourcePath: string; posterPath?: string; loop?: boolean; mediaRef?: RefObject<HTMLVideoElement | null> }) {
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const videoRef = mediaRef ?? internalVideoRef;
  const [playing, setPlaying] = useState(false);
  const { volume, setVolume, muted, setMuted } = usePlayerAudio("preview");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [sourcePath]);

  const synchronizeTime = useCallback(() => {
    setCurrentTime(videoRef.current?.currentTime ?? 0);
  }, []);

  // Match the editor's 50 ms playback clock instead of waiting for the
  // browser's much less frequent timeupdate events. Read the actual media
  // position so buffering, looping, and playback-rate changes stay accurate.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let lastUpdate = -Infinity;
    const update = (now: number) => {
      if (now - lastUpdate >= 50 && !videoRef.current?.seeking) {
        synchronizeTime();
        lastUpdate = now;
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [playing, synchronizeTime]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch((reason: unknown) => setError(errorMessage(reason)));
    else video.pause();
  }, []);

  const seek = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(video.duration || duration, time));
    setCurrentTime(video.currentTime);
  }, [duration]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, button, [contenteditable=true]")) return;
      if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        seek((videoRef.current?.currentTime ?? 0) + (event.key === "ArrowRight" ? 5 : -5));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [seek, togglePlayback]);

  const changeVolume = (nextVolume: number) => {
    const safeVolume = Math.max(0, Math.min(1, nextVolume));
    setVolume(safeVolume);
    if (videoRef.current) videoRef.current.volume = safeVolume;
    if (safeVolume > 0 && muted) {
      setMuted(false);
      if (videoRef.current) videoRef.current.muted = false;
    }
  };

  const changeMuted = (nextMuted: boolean) => {
    setMuted(nextMuted);
    if (videoRef.current) videoRef.current.muted = nextMuted;
  };

  return (
    <>
      <VideoPreview
        videoRef={videoRef}
        sourcePath={sourcePath}
        posterPath={posterPath}
        className="viewer-player"
        playing={playing}
        muted={muted}
        volume={volume}
        resultTime={currentTime}
        resultDuration={duration}
        autoPlay
        loop={loop}
        onTogglePlayback={togglePlayback}
        onSeekResult={seek}
        onMutedChange={changeMuted}
        onVolumeChange={changeVolume}
        onTimeUpdate={synchronizeTime}
        onSeeked={synchronizeTime}
        onPlayingChange={(nextPlaying) => {
          synchronizeTime();
          setPlaying(nextPlaying);
        }}
        onLoadedMetadata={() => setDuration(videoRef.current?.duration ?? 0)}
        onMediaError={setError}
      />
      {error && <div data-shard-slot="player-error" className="viewer-player__error" role="alert">{error}</div>}
    </>
  );
}

export function formatEditorTime(seconds: number, precise = false): string {
  const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const milliseconds = Math.round(value * 1000);
  const whole = precise ? Math.floor(milliseconds / 1000) : Math.floor(value);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const secs = whole % 60;
  const base = hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
  return precise ? `${base}.${String(milliseconds % 1000).padStart(3, "0")}` : base;
}

export function mediaFileUrl(filePath: string): string {
  if (/^(?:https?|file|blob|data):/i.test(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, "/");
  const prefix = normalized.startsWith("/") ? "file://" : "file:///";
  return encodeURI(`${prefix}${normalized}`).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
