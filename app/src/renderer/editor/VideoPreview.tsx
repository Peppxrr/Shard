import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { Icon, IconButton } from "../components/ui";

interface VideoPreviewProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  sourcePath: string;
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
}

export function VideoPreview({
  videoRef,
  sourcePath,
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
}: VideoPreviewProps) {
  const safeDuration = Math.max(resultDuration, 0.001);

  const toggleFullscreen = async () => {
    const stage = videoRef.current?.closest(".editor-player") as HTMLElement | null;
    if (!stage) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stage.requestFullscreen();
  };

  return (
    <section className={["editor-player", className].filter(Boolean).join(" ")} aria-label="Video preview">
      <div className="editor-player__stage" onClick={onTogglePlayback}>
        <video
          ref={videoRef}
          className="editor-player__video"
          src={mediaFileUrl(sourcePath)}
          controls={false}
          playsInline
          autoPlay={autoPlay}
          loop={loop}
          muted={nativeMuted || muted}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onSeeked={onSeeked}
          onPlay={() => onPlayingChange(true)}
          onPause={() => onPlayingChange(false)}
          onError={(event) => {
            const code = event.currentTarget.error?.code;
            onMediaError(code ? `The clip could not be decoded (media error ${code}).` : "The clip could not be loaded.");
          }}
        />
        {!playing && (
          <span className="editor-player__big-play" aria-hidden="true">
            <Icon name="play" size={28} />
          </span>
        )}
      </div>

      <div className="editor-player__controls" onClick={(event) => event.stopPropagation()}>
        <IconButton label={playing ? "Pause (Space)" : "Play (Space)"} onClick={onTogglePlayback}>
          <Icon name={playing ? "pause" : "play"} size={18} />
        </IconButton>
        <span className="editor-player__time num">
          {formatEditorTime(resultTime)} <span>/</span> {formatEditorTime(resultDuration)}
        </span>
        <input
          className="editor-player__seek"
          type="range"
          min={0}
          max={safeDuration}
          step={0.001}
          value={Math.min(resultTime, safeDuration)}
          aria-label="Playback position"
          style={{ "--seek-progress": `${Math.min(100, (resultTime / safeDuration) * 100)}%` } as CSSProperties}
          onChange={(event) => onSeekResult(Number(event.target.value))}
        />
        <IconButton label={muted ? "Unmute" : "Mute"} active={muted} onClick={() => onMutedChange(!muted)}>
          <Icon name={muted || volume === 0 ? "volumeOff" : "volume"} size={18} />
        </IconButton>
        <input
          className="editor-player__volume volume-slider"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          aria-label="Volume"
          style={{
            "--range-progress": `${Math.max(0, Math.min(100, volume * 100))}%`,
            "--range-color": volume > 1 ? "var(--danger)" : "var(--accent)",
          } as CSSProperties}
          onChange={(event) => onVolumeChange(Number(event.target.value))}
        />
        <IconButton label="Fullscreen" onClick={() => void toggleFullscreen()}>
          <Icon name="maximize" size={17} />
        </IconButton>
      </div>
    </section>
  );
}

export function StandaloneVideoPlayer({ sourcePath, loop = true }: { sourcePath: string; loop?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
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
        onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
        onSeeked={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
        onPlayingChange={setPlaying}
        onLoadedMetadata={() => setDuration(videoRef.current?.duration ?? 0)}
        onMediaError={setError}
      />
      {error && <div className="viewer-player__error">{error}</div>}
    </>
  );
}

export function formatEditorTime(seconds: number, precise = false): string {
  const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  const base = hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
  return precise ? `${base}.${String(Math.floor((value % 1) * 1000)).padStart(3, "0")}` : base;
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
