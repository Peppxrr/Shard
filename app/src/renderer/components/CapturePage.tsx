import { KeyCaps } from "./HotkeyControls";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClipRecord, CoreState, PerfSample, Settings } from "../../shared/contracts";
import { fmtDuration, fmtSize, relativeDate, Viewer } from "./LibraryPage";
import { Button, Card, EmptyState, Icon, Segmented, StatusDot } from "./ui";
import { mediaFileUrl } from "../editor/VideoPreview";
import { StorageSummary } from "./StorageSummary";
import { ClipSaveTracker } from "../../shared/clip-saves";

interface Props {
  settings: Settings;
  clips: ClipRecord[];
}

const MODE_LABEL: Record<string, string> = {
  auto: "Auto",
  screen: "Desktop",
  game: "Game only",
};
const ENC_LABEL: Record<string, string> = {
  auto: "Automatic",
  obs_x264: "x264 (CPU)",
  obs_x265: "x265 / HEVC (CPU)",
  obs_nvenc_h264_tex: "NVENC H.264",
  obs_nvenc_hevc_tex: "NVENC HEVC",
  obs_nvenc_av1_tex: "NVENC AV1",
};
const PRESET_LABEL: Record<string, string> = {
  low: "Low · 720p30 · 4 Mbps",
  medium: "Medium · native · 8 Mbps",
  high: "High · native · 16 Mbps",
  custom: "Custom",
};
type Dur = "30" | "60" | "120" | "300";
// Spinner failsafe only: no clip-save event at all for this long, far beyond any normal save.
const CLIP_SAVE_STALL_MS = 5 * 60 * 1000;

interface Subject { kind: "monitor" | "game" | "none"; name: string | null }

export function CapturePage({ settings, clips }: Props) {
  const [ringSeconds, setRingSeconds] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [subject, setSubject] = useState<Subject | null>(null);
  // Accepted saves stay pending until their terminal core event; a save can
  // take well over 30 s (encoder catch-up, then muxing and disk I/O).
  const [clipSaves] = useState(() => new ClipSaveTracker());
  const [pendingSaves, setPendingSaves] = useState(0);
  const [requesting, setRequesting] = useState(0); // clip.save calls awaiting their reply
  const stallTimer = useRef<number | undefined>(undefined);
  const saving = requesting > 0 || pendingSaves > 0;
  const [dur, setDur] = useState<Dur>("60");
  const [recent, setRecent] = useState<ClipRecord | null>(null);
  const [perf, setPerf] = useState<PerfSample | null>(null);
  const recentGrid = useRef<HTMLDivElement>(null);
  // Failsafe only, for a lost core connection that never reports a result or
  // restarts: no clip-save event for this long ends the spinner.
  const syncSaves = () => {
    setPendingSaves(clipSaves.size);
    window.clearTimeout(stallTimer.current);
    stallTimer.current = clipSaves.size
      ? window.setTimeout(() => { clipSaves.clear(); setPendingSaves(0); }, CLIP_SAVE_STALL_MS)
      : undefined;
  };
  useEffect(() => () => window.clearTimeout(stallTimer.current), []);
  const [recentCapacity, setRecentCapacity] = useState(0);
  const hasClips = clips.length > 0;

  useLayoutEffect(() => {
    const grid = recentGrid.current;
    if (!grid) return;
    const measure = () => {
      const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
      setRecentCapacity(Math.max(1, columns) * 2);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [hasClips]);

  useEffect(() => {
    const loadState = () => {
      void window.shard.invoke("state.get").then((result) => {
        const st = result as CoreState;
        setRingSeconds(st.ring.secondsBuffered);
        setRecording(st.recording.active);
        setSubject(st.capture.subject);
        setPerf(st.perf?.latest ?? null);
      }).catch(() => {});
    };
    loadState();
    return window.shard.onCoreEvent((type, params) => {
      if (type === "ready") loadState();
      else if (type === "ring.stats") setRingSeconds((params as { secondsBuffered: number }).secondsBuffered);
      else if (type === "recording.state") setRecording((params as { active: boolean }).active);
      else if (type === "capture.subject") setSubject(params as unknown as Subject);
      else if (type === "perf.stats") setPerf(params as unknown as PerfSample); // core contract shape
      // Hotkey saves show the spinner too.
      if (clipSaves.apply(type, params)) syncSaves();
    });
  }, []);

  const v = settings.video;
  const capturing = subject && subject.kind !== "none";
  const dotState = recording ? "rec" : capturing ? "live" : "idle";
  const stateTitle = recording
    ? "Recording"
    : capturing
      ? subject?.kind === "game" ? "Capturing game" : "Capturing desktop"
      : "Nothing captured";
  const resLabel = v.width && v.height ? `${v.width}×${v.height}` : "—";

  const saveClip = () => {
    setRequesting(count => count + 1);
    void window.shard.invoke("clip.save", { durationSec: Number(dur) })
      .then(result => { clipSaves.queued((result as { request?: number } | null)?.request); syncSaves(); })
      .catch(() => {})
      .finally(() => setRequesting(count => count - 1));
  };
  const toggleRecord = () => {
    void window.shard.invoke(recording ? "recording.stop" : "recording.start").catch(() => {});
  };

  const lastClips = [...clips].sort((a, b) => b.createdAt - a.createdAt).slice(0, recentCapacity);

  return (
    <div data-shard-page="capture" data-shard-state={recording ? "recording" : capturing ? "capturing" : "idle"} data-saving={saving} className="capture">
      <header className="page__head">
        <h1 className="page__title">Capture</h1>
        <p className="dim page__sub">Keep the moments worth saving.</p>
      </header>
      <section data-shard-slot="capture-primary" className="capture__primary">
        <div data-shard-component="capture-hero" className="capture__hero">
          <div className="capture__hero-main">
            <span className="eyebrow">Replay buffer</span>
            <div className="capture__identity">
              <h2 className="capture__title"><StatusDot state={dotState} /> {stateTitle}</h2>
              <p className="capture__subject">
                {subject?.kind === "game" ? subject.name
                  : subject?.kind === "monitor" ? (subject.name ?? "Desktop")
                  : "Waiting for a game or desktop…"}
              </p>
            </div>
            <p className="capture__meta num dim">
              {MODE_LABEL[settings.capture.mode]} · {v.fps} FPS · {resLabel} · {settings.replay.maxSeconds}s buffer
              {perf?.active && perf.cause !== "ok" && (
                <span data-shard-component="perf-hint" data-shard-state={perf.cause} role="status" className="perf-hint"
                  title={`${perf.lostPct}% of frames lost in the last 5 s. ${perf.hint ?? ""}${perf.gpu.available ? ` GPU 3D ${Math.round(perf.gpu.engine3d ?? 0)}% · Video encoder ${Math.round(perf.gpu.videoEncode ?? 0)}%.` : ""}`}>
                  · Dropping frames ({perf.lostPct}%)
                </span>
              )}
            </p>
          </div>
          <div className="capture__ring">
            <div className="capture__ring-num num">{ringSeconds === null ? "—" : Math.floor(ringSeconds)}</div>
            <div className="eyebrow" style={{ marginTop: 2 }}>sec buffered</div>
            {recording && <span className="chip chip--rec"><span className="dot dot--rec" /> REC</span>}
          </div>
        </div>
        <div data-shard-slot="capture-actions" className="capture__actions">
          <div className="capture__save">
            <Segmented<Dur>
              value={dur}
              onChange={setDur}
              options={[{ value: "30", label: "30s" }, { value: "60", label: "60s" }, { value: "120", label: "2m" }, { value: "300", label: "5m" }]}
            />
            <Button data-shard-component="capture-button" data-shard-state={saving ? "saving" : "ready"} variant="primary" icon={<Icon name="save" size={16} />} loading={saving} onClick={saveClip}>Save clip</Button>
          </div>
          <Button data-shard-component="record-button" data-shard-state={recording ? "recording" : "idle"} variant={recording ? "danger" : "soft"}
            icon={recording ? <Icon name="stop" size={16} /> : <Icon name="record" size={16} />}
            onClick={toggleRecord}>
            {recording ? "Stop recording" : "Start recording"}
          </Button>
        </div>
      </section>

      <div data-shard-component="utility-rail" data-shard-slot="capture-summary" className="capture__grid utility-rail">
        <Card title="Hotkeys" icon={<Icon name="key" size={16} />}>
          <ul className="hotkey-list">
            {settings.hotkeys.map((h) => (
              <li key={h.id} className="hotkey-list__row">
                <span className="hotkey-list__label">{h.label || "Untitled"}</span>
                <span className="capture-shortcut" aria-label={h.accelerator || "Not assigned"}><KeyCaps value={h.accelerator} /></span>
              </li>
            ))}
            {settings.hotkeys.length === 0 && <li className="dim">No hotkeys configured.</li>}
          </ul>
        </Card>

        <Card title="Encoder & quality" icon={<Icon name="monitor" size={16} />}>
          <ul className="kv">
            <li><span>Encoder</span><span>{ENC_LABEL[v.encoder] ?? v.encoder}</span></li>
            <li><span>Preset</span><span>{PRESET_LABEL[v.preset] ?? v.preset}</span></li>
            {v.custom && <li><span>Bitrate</span><span className="num">{v.bitrateKbps} kbps</span></li>}
            <li><span>Frame rate</span><span className="num">{v.fps} fps</span></li>
            <li><span>Resolution</span><span className="num">{resLabel}</span></li>
            <li><span>Export target</span><span className="num">{settings.export.targetMb} MB</span></li>
          </ul>
        </Card>

        <Card title="Storage" icon={<Icon name="hardDrive" size={16} />}>
          <StorageSummary />
        </Card>
      </div>

      {hasClips ? (
        <section data-shard-slot="capture-recent" className="capture__recent">
          <h2 className="card__title"><Icon name="film" size={16} />Recent</h2>
          <div className="recents" ref={recentGrid}>
            {lastClips.map((c) => (
              <button key={c.id} className="recent" onClick={() => setRecent(c)} title={c.game ?? "Untagged"}>
                <div className="recent__thumb">
                  {c.thumb ? <img src={mediaFileUrl(c.thumb)} alt="" /> : <div className="recent__nothumb"><Icon name="film" size={20} /></div>}
                  {c.protected === 1 && <span className="badge badge--fav"><Icon name="star" size={10} /></span>}
                  <span className="badge badge--dur num">{fmtDuration(c.durationMs)}</span>
                </div>
                <div className="recent__meta">
                  <div className="recent__title">{c.game ?? "Untagged"}</div>
                  <div className="dim">{relativeDate(c.createdAt)} · {fmtSize(c.sizeBytes)}</div>
                </div>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <section data-shard-slot="capture-recent" className="capture__recent">
          <EmptyState icon={<Icon name="film" size={28} />} title="No clips captured yet">
            Your saved clips and recordings will appear here.
          </EmptyState>
        </section>
      )}

      {recent && <Viewer clip={recent} onClose={() => setRecent(null)} />}

    </div>
  );
}
