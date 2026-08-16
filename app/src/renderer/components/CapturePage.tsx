import { useEffect, useState } from "react";
import type { ClipRecord, CoreState, Settings } from "../../shared/contracts";
import { fmtDuration, fmtSize, relativeDate, Viewer } from "./LibraryPage";
import { Button, Card, EmptyState, Icon, Segmented, StatusDot } from "./ui";

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
  auto: "Auto · NVENC→x264",
  obs_x264: "x264 (CPU)",
  obs_nvenc_h264_tex: "NVENC H.264",
  obs_nvenc_av1_tex: "NVENC AV1",
};
const PRESET_LABEL: Record<string, string> = {
  low: "Low · 720p30 · 4 Mbps",
  medium: "Medium · native · 8 Mbps",
  high: "High · native · 16 Mbps",
  custom: "Custom",
};
type Dur = "30" | "60" | "120" | "300";

interface Subject { kind: "monitor" | "game" | "none"; name: string | null }

export function CapturePage({ settings, clips }: Props) {
  const [ringSeconds, setRingSeconds] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [subject, setSubject] = useState<Subject | null>(null);
  const [saving, setSaving] = useState(false);
  const [dur, setDur] = useState<Dur>("60");
  const [recent, setRecent] = useState<ClipRecord | null>(null);

  useEffect(() => {
    (async () => {
      const st = (await window.clipforge.invoke("state.get")) as CoreState;
      setRingSeconds(st.ring.secondsBuffered);
      setRecording(st.recording.active);
      setSubject(st.capture.subject);
    })().catch(() => {});
    return window.clipforge.onCoreEvent((type, params) => {
      if (type === "ring.stats") setRingSeconds((params as { secondsBuffered: number }).secondsBuffered);
      else if (type === "recording.state") setRecording((params as { active: boolean }).active);
      else if (type === "capture.subject") setSubject(params as unknown as Subject);
      else if (type === "clip.saved") setSaving(false);
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
    setSaving(true);
    window.setTimeout(() => setSaving(false), 6000);
    void window.clipforge.invoke("clip.save", { durationSec: Number(dur) }).catch(() => setSaving(false));
  };
  const toggleRecord = () => {
    void window.clipforge.invoke(recording ? "recording.stop" : "recording.start").catch(() => {});
  };

  const usedBytes = clips.reduce((s, c) => s + c.sizeBytes, 0);
  const limitBytes = settings.storage.limitGb * 1024 * 1024 * 1024;
  const usedGb = usedBytes / 1024 / 1024 / 1024;
  const pct = limitBytes > 0 ? Math.min(100, (usedBytes / limitBytes) * 100) : 0;
  const fillClass = pct >= 100 ? "is-over" : pct >= 75 ? "is-warn" : "";
  const lastClips = [...clips].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);

  return (
    <div className="capture">
      <section className="capture__hero card">
        <div className="capture__hero-main">
          <span className="eyebrow">Replay buffer</span>
          <h2 className="capture__title"><StatusDot state={dotState} /> {stateTitle}</h2>
          <p className="capture__subject">
            {subject?.kind === "game" ? subject.name
              : subject?.kind === "monitor" ? "Desktop"
              : "Waiting for a game or desktop…"}
          </p>
          <p className="capture__meta num dim">
            {MODE_LABEL[settings.capture.mode]} · {v.fps} FPS · {resLabel} · {settings.replay.maxSeconds}s buffer
          </p>
        </div>
        <div className="capture__ring">
          <div className="capture__ring-num num">{ringSeconds ?? "—"}</div>
          <div className="eyebrow" style={{ marginTop: 2 }}>sec buffered</div>
          {recording && <span className="chip chip--rec"><span className="dot dot--rec" /> REC</span>}
        </div>
      </section>

      <section className="capture__actions">
        <div className="capture__save">
          <Segmented<Dur>
            value={dur}
            onChange={setDur}
            options={[{ value: "30", label: "30s" }, { value: "60", label: "60s" }, { value: "120", label: "2m" }, { value: "300", label: "5m" }]}
          />
          <Button size="lg" variant="primary" icon={<Icon name="aperture" size={18} />} loading={saving} onClick={saveClip}>Save clip</Button>
        </div>
        <Button size="lg" variant={recording ? "danger" : "soft"}
          icon={recording ? <Icon name="stop" size={16} /> : <Icon name="record" size={16} />}
          onClick={toggleRecord}>
          {recording ? "Stop" : "Record"}
        </Button>
      </section>

      <div className="capture__grid">
        <Card title="Hotkeys" icon={<Icon name="sliders" size={16} />}>
          <ul className="hotkey-list">
            {settings.hotkeys.map((h) => (
              <li key={h.id} className="hotkey-list__row">
                <span className="hotkey-list__label">{h.label || "Untitled"}</span>
                <span className="kb">{h.accelerator}</span>
              </li>
            ))}
            {settings.hotkeys.length === 0 && <li className="dim">No hotkeys configured.</li>}
          </ul>
        </Card>

        <Card title="Encoder & quality" icon={<Icon name="screen" size={16} />}>
          <ul className="kv">
            <li><span>Encoder</span><span>{ENC_LABEL[v.encoder] ?? v.encoder}</span></li>
            <li><span>Preset</span><span>{PRESET_LABEL[v.preset] ?? v.preset}</span></li>
            {v.custom && <li><span>Bitrate</span><span className="num">{v.bitrateKbps} kbps</span></li>}
            <li><span>Frame rate</span><span className="num">{v.fps} fps</span></li>
            <li><span>Resolution</span><span className="num">{resLabel}</span></li>
            <li><span>Export target</span><span className="num">{settings.export.targetMb} MB</span></li>
          </ul>
        </Card>

        <Card title="Storage" icon={<Icon name="folder" size={16} />}>
          <div className="meter">
            <div className="meter__track"><div className={`meter__fill ${fillClass}`} style={{ width: `${pct}%` }} /></div>
          </div>
          <p className="kv__line num dim"><strong>{usedGb.toFixed(2)} GB</strong> of {settings.storage.limitGb} GB used</p>
          <p className="kv__line dim">Oldest unprotected clips auto-delete at the limit.</p>
        </Card>
      </div>

      {lastClips.length > 0 ? (
        <Card title="Recent" icon={<Icon name="aperture" size={16} />}>
          <div className="recents">
            {lastClips.map((c) => (
              <button key={c.id} className="recent" onClick={() => setRecent(c)} title={c.game ?? "Untagged"}>
                <div className="recent__thumb">
                  {c.thumb ? <img src={`file://${c.thumb}`} alt="" /> : <div className="recent__nothumb"><Icon name="aperture" size={20} /></div>}
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
        </Card>
      ) : (
        <Card flat>
          <EmptyState icon={<Icon name="gamepad" size={28} />} title="No clips captured yet">
            Your saved clips and recordings will appear here.
          </EmptyState>
        </Card>
      )}

      {recent && <Viewer clip={recent} onClose={() => setRecent(null)} />}

    </div>
  );
}