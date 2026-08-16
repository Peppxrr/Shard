import { useEffect, useState } from "react";
import type { AudioDeviceInfo, Settings } from "../../shared/contracts";
import { Button, Card, Field, Icon, IconButton, Segmented, StatusDot, Toggle } from "./ui";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

const NAV = [
  { id: "capture", label: "Capture", icon: "aperture" },
  { id: "video", label: "Video", icon: "screen" },
  { id: "export", label: "Export", icon: "link" },
  { id: "audio", label: "Audio", icon: "sliders" },
  { id: "hotkeys", label: "Hotkeys", icon: "bell" },
  { id: "storage", label: "Storage", icon: "folder" },
  { id: "app", label: "App", icon: "power" },
] as const;

type NavId = (typeof NAV)[number]["id"];

export function SettingsPage({ settings, onChange }: Props) {
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [active, setActive] = useState<NavId>("capture");
  const [durationUnit, setDurationUnit] = useState<string | null>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    window.clipforge.invoke("audio.listDevices").then((d) => setDevices(d as AudioDeviceInfo[])).catch(() => {});
    window.clipforge.version().then(setVersion).catch(() => {});
  }, []);

  const patch = (p: Partial<Settings>) => onChange({ ...settings, ...p });
  const patchDeep = (section: "capture" | "video" | "replay" | "storage" | "app" | "export" | "audio", p: unknown) =>
    onChange({ ...settings, [section]: { ...(settings[section] as object), ...(p as object) } });

  return (
    <div className="page settings">
      <aside className="settings__nav">
        {NAV.map((s) => (
          <button key={s.id} type="button" className={active === s.id ? "nav__item settings__nav-item active" : "nav__item settings__nav-item"}
            aria-current={active === s.id ? "page" : undefined} onClick={() => setActive(s.id)}>
            <span className="ico"><Icon name={s.icon} size={15} /></span> {s.label}
          </button>
        ))}
      </aside>

      <div className="settings__content">
        {active === "capture" && (
          <div className="stack">
            <Card title="Capture mode" icon={<Icon name="aperture" size={16} />}>
              <Field label="Mode" hint="Auto stays on the game while it is active (no desktop flashes mid-game) and only falls back to desktop once it closes. Game only never captures desktop.">
                <select className="select" value={settings.capture.mode} onChange={(e) => patchDeep("capture", { mode: e.target.value })} style={{ maxWidth: 320 }}>
                  <option value="auto">Auto (game capture, desktop when no game)</option>
                  <option value="screen">Desktop (monitor capture)</option>
                  <option value="game">Game only (never desktop)</option>
                </select>
              </Field>
              <Field label="Monitor (for desktop mode)">
                <input className="input" type="number" min={0} value={settings.capture.monitor}
                  onChange={(e) => patchDeep("capture", { monitor: Number(e.target.value) })} style={{ maxWidth: 160 }} />
              </Field>
            </Card>
            <Card title="Replay buffer" icon={<Icon name="record" size={16} />}>
              <p className="field__hint" style={{ margin: "0 0 var(--sp-4)" }}>
                The ring buffers only while capture is active and frees its RAM 15&nbsp;s after capture ends, so you can still
                grab a last-second clip after closing a game.
              </p>
              <div className="row">
                <Field label="Max seconds"><input className="input" type="number" min={30} step={30} value={settings.replay.maxSeconds}
                  onChange={(e) => patchDeep("replay", { maxSeconds: Number(e.target.value) })} style={{ maxWidth: 160 }} /></Field>
                <Field label="Max MB (RAM)"><input className="input" type="number" min={256} step={256} value={settings.replay.maxMb}
                  onChange={(e) => patchDeep("replay", { maxMb: Number(e.target.value) })} style={{ maxWidth: 160 }} /></Field>
              </div>
            </Card>
          </div>
        )}

        {active === "video" && (
          <Card title="Video" icon={<Icon name="screen" size={16} />}>
            <Field label="Encoder">
              <select className="select" value={settings.video.encoder} onChange={(e) => patchDeep("video", { encoder: e.target.value })} style={{ maxWidth: 320 }}>
                <option value="auto">Auto (NVENC H.264 → x264)</option>
                <option value="obs_x264">x264 (CPU)</option>
                <option value="obs_nvenc_h264_tex">NVENC H.264 (GPU)</option>
                <option value="obs_nvenc_av1_tex">NVENC AV1 (GPU)</option>
              </select>
            </Field>
            <Field label="Preset" hint="Medium / High use your monitor's native resolution.">
              <select className="select" value={settings.video.preset}
                onChange={(e) => patchDeep("video", { preset: e.target.value, custom: e.target.value === "custom" })} style={{ maxWidth: 320 }}>
                <option value="low">Low — 720p30 @ 4 Mbps</option>
                <option value="medium">Medium — native @ 8 Mbps</option>
                <option value="high">High — native @ 16 Mbps</option>
                <option value="custom">Custom</option>
              </select>
            </Field>
            {settings.video.custom && (
              <div className="row">
                <Field label="Bitrate (kbps)"><input className="input" type="number" min={100} step={100} value={settings.video.bitrateKbps}
                  onChange={(e) => patchDeep("video", { bitrateKbps: Number(e.target.value) })} style={{ maxWidth: 140 }} /></Field>
                <Field label="FPS"><input className="input" type="number" min={15} max={240} value={settings.video.fps}
                  onChange={(e) => patchDeep("video", { fps: Number(e.target.value) })} style={{ maxWidth: 100 }} /></Field>
                <Field label="Width"><input className="input" type="number" min={320} step={2} value={settings.video.width}
                  onChange={(e) => patchDeep("video", { width: Number(e.target.value) })} style={{ maxWidth: 120 }} /></Field>
                <Field label="Height"><input className="input" type="number" min={240} step={2} value={settings.video.height}
                  onChange={(e) => patchDeep("video", { height: Number(e.target.value) })} style={{ maxWidth: 120 }} /></Field>
                <Field label="x264 preset">
                  <select className="select" value={settings.video.x264Preset} onChange={(e) => patchDeep("video", { x264Preset: e.target.value })} style={{ maxWidth: 160 }}>
                    {["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"].map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
          </Card>
        )}

        {active === "export" && (
          <Card title="Export" icon={<Icon name="link" size={16} />}>
            <p className="field__hint" style={{ margin: "0 0 var(--sp-4)" }}>Default target is 10&nbsp;MB for Discord free uploads.</p>
            <div className="row">
              <Field label="Target size (MB)"><input className="input" type="number" min={1} max={100} value={settings.export.targetMb}
                onChange={(e) => patchDeep("export", { targetMb: Number(e.target.value) })} style={{ maxWidth: 120 }} /></Field>
              <Field label="Codec">
                <Segmented value={settings.export.codec} onChange={(c) => patchDeep("export", { codec: c })}
                  options={[{ value: "h264", label: "H.264" }, { value: "h265", label: "H.265" }]} />
              </Field>
            </div>
            <Field label="Resolution">
              <select className="select" value={settings.export.resolution} onChange={(e) => patchDeep("export", { resolution: e.target.value })} style={{ maxWidth: 320 }}>
                <option value="auto">Auto (by length)</option>
                <option value="source">Source</option>
                <option value="1080p">1080p</option>
                <option value="720p">720p</option>
                <option value="480p">480p</option>
                <option value="360p">360p</option>
              </select>
            </Field>
            <Field label="Audio (kbps)"><input className="input" type="number" min={64} max={320} step={32} value={settings.export.audioBitrateKbps}
              onChange={(e) => patchDeep("export", { audioBitrateKbps: Number(e.target.value) })} style={{ maxWidth: 120 }} /></Field>
          </Card>
        )}

        {active === "audio" && (
          <Card title="Audio sources" icon={<Icon name="sliders" size={16} />}>
            <p className="field__hint" style={{ margin: "0 0 var(--sp-4)" }}>
              With no sources enabled, the default output device is captured automatically. Voicemeeter buses appear as
              normal output devices. Per-app capture needs Win10 2004+.
            </p>
            <AudioSources settings={settings} devices={devices} patch={patchDeep} />
          </Card>
        )}

        {active === "hotkeys" && (
          <Card title="Hotkeys" icon={<Icon name="bell" size={16} />}>
            <p className="field__hint" style={{ margin: "0 0 var(--sp-4)" }}>
              Windows key combos are not supported by Electron global shortcuts. Click a row's key to rebind; add as many as you like.
            </p>
            <div className="hotkeys">
              {settings.hotkeys.map((h) => (
                <div className="hotkey" key={h.id}>
                  <input className="input hotkey__label" value={h.label} placeholder="Label"
                    onChange={(e) => {
                      const hotkeys = settings.hotkeys.map((x) => (x.id === h.id ? { ...x, label: e.target.value } : x));
                      patch({ hotkeys });
                    }} />
                  <HotkeyInput value={h.accelerator} onCommit={(acc) => {
                    const hotkeys = settings.hotkeys.map((x) => (x.id === h.id ? { ...x, accelerator: acc } : x));
                    patch({ hotkeys });
                  }} />
                  <select className="select hotkey__action" value={h.action}
                    onChange={(e) => {
                      const hotkeys = settings.hotkeys.map((x) => x.id === h.id ? { ...x, action: e.target.value as typeof x.action } : x);
                      patch({ hotkeys });
                    }}>
                    <option value="save_clip">Save clip</option>
                    <option value="toggle_record">Toggle recording</option>
                  </select>
                  {h.action === "save_clip" && (
                    <span className="hotkey__dur">
                      <input className="input" type="number" min={1}
                        value={Math.round((h.durationSec ?? 60) / (durationUnit === h.id ? 60 : 1))}
                        onChange={(e) => {
                          const n = Number(e.target.value) || 0;
                          const secs = durationUnit === h.id ? n * 60 : n;
                          const hotkeys = settings.hotkeys.map((x) => x.id === h.id ? { ...x, durationSec: Math.max(1, secs) } : x);
                          patch({ hotkeys });
                        }}
                        style={{ width: 76 }} />
                      <select className="select" value={durationUnit === h.id ? "min" : "sec"}
                        onChange={(e) => {
                          const secs = h.durationSec ?? 60;
                          const hotkeys = settings.hotkeys.map((x) => x.id === h.id ? { ...x, durationSec: e.target.value === "min" ? Math.max(60, secs) : secs } : x);
                          setDurationUnit(h.id);
                          patch({ hotkeys });
                        }}>
                        <option value="sec">sec</option>
                        <option value="min">min</option>
                      </select>
                    </span>
                  )}
                  <IconButton variant="danger" label="Remove hotkey" onClick={() => { patch({ hotkeys: settings.hotkeys.filter((x) => x.id !== h.id) }); }}>
                    <Icon name="x" size={15} />
                  </IconButton>
                </div>
              ))}
              <Button icon={<Icon name="plus" size={15} />} onClick={() => {
                const id = `hotkey_${Date.now()}`;
                patch({ hotkeys: [...settings.hotkeys, { id, label: "New hotkey", accelerator: "", action: "save_clip", durationSec: 60 }] });
              }}>Add hotkey</Button>
            </div>
          </Card>
        )}

        {active === "storage" && (
          <Card title="Storage" icon={<Icon name="folder" size={16} />}>
            <Field label="Retention limit (GB)" hint="Oldest unprotected clips are deleted automatically to stay under the limit. Edited clips are never auto-deleted.">
              <input className="input" type="number" min={1} max={1000} value={settings.storage.limitGb}
                onChange={(e) => patchDeep("storage", { limitGb: Number(e.target.value) })} style={{ maxWidth: 160 }} />
            </Field>
            <Field label="Clips folder" hint={<>Base directory for clips. The app creates <span className="mono">clips/</span> and <span className="mono">editor/</span> inside it. Empty = default (%APPDATA%). Existing clips stay in the library.</>}>
              <input className="input" type="text" placeholder="e.g. D:\Clips (leave empty for default)" value={settings.storage.clipsDir}
                onChange={(e) => patchDeep("storage", { clipsDir: e.target.value })} style={{ maxWidth: 420 }} />
            </Field>
          </Card>
        )}

        {active === "app" && (
          <Card title="App" icon={<Icon name="power" size={16} />}>
            <Field label="Clip-saved notification" hint="Overlay shows a small toast for a moment; Windows notification is used when the window is hidden.">
              <select className="select" value={settings.app.notificationStyle}
                onChange={(e) => patchDeep("app", { notificationStyle: e.target.value })} style={{ maxWidth: 320 }}>
                <option value="overlay">Overlay toast</option>
                <option value="windows">Windows notification (when hidden)</option>
                <option value="off">Off</option>
              </select>
            </Field>
            <label className="settings__row">
              <Toggle checked={settings.app.startWithWindows} onChange={(v) => patchDeep("app", { startWithWindows: v })} />
              <span>Start with Windows</span>
            </label>
            {version && (
              <div className="settings__about"><StatusDot state="live" /> Shard <span className="mono">v{version}</span></div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Audio sources ----------------------------- */
function AudioSources({ settings, devices, patch }: {
  settings: Settings;
  devices: AudioDeviceInfo[];
  patch: (section: "audio", p: unknown) => void;
}) {
  const add = (kind: "output" | "input" | "process") => {
    const d = devices.find((x) => (kind === "input" ? x.isInput : !x.isInput));
    const sources = [...settings.audio.sources];
    sources.push({
      id: kind === "process" ? "" : (d?.id ?? "default"),
      name: kind === "process" ? "App audio (foreground)" : (d?.name ?? "Default device"),
      kind, window: kind === "process" ? "::" : undefined, gain: 1, enabled: true,
    });
    patch("audio", { sources });
  };

  return (
    <div className="stack aud">
      {settings.audio.sources.map((s, i) => (
        <div className="aud__row" key={i}>
          <select className="select aud__kind" value={s.kind}
            onChange={(e) => { const sources = [...settings.audio.sources]; sources[i] = { ...sources[i], kind: e.target.value as typeof s.kind }; patch("audio", { sources }); }}>
            <option value="output">Device output</option>
            <option value="input">Device input</option>
            <option value="process">App audio</option>
          </select>
          {s.kind !== "process" ? (
            <select className="select" value={s.id}
              onChange={(e) => { const sources = [...settings.audio.sources]; const d = devices.find((x) => x.id === e.target.value); sources[i] = { ...sources[i], id: e.target.value, name: d?.name ?? e.target.value }; patch("audio", { sources }); }}
              style={{ flex: "1 1 200px" }}>
              {devices.filter((d) => (s.kind === "input" ? d.isInput : !d.isInput)).map((d) => (
                <option key={d.id} value={d.id}>{d.name}{d.isVoicemeeter ? " (Voicemeeter)" : ""}</option>
              ))}
            </select>
          ) : (
            <input className="input" placeholder="::game.exe" value={s.window ?? ""}
              onChange={(e) => { const sources = [...settings.audio.sources]; sources[i] = { ...sources[i], window: e.target.value }; patch("audio", { sources }); }}
              style={{ flex: "1 1 200px" }} />
          )}
          <input className="slider" type="range" min={0} max={1} step={0.05} value={s.gain} title={`Gain ${Math.round(s.gain * 100)}%`}
            onChange={(e) => { const sources = [...settings.audio.sources]; sources[i] = { ...sources[i], gain: Number(e.target.value) }; patch("audio", { sources }); }} />
          <span className="aud__gain num">{Math.round(s.gain * 100)}%</span>
          <Toggle checked={s.enabled}
            onChange={(chk) => { const sources = [...settings.audio.sources]; sources[i] = { ...sources[i], enabled: chk }; patch("audio", { sources }); }} />
          <IconButton variant="danger" label="Remove source" onClick={() => { patch("audio", { sources: settings.audio.sources.filter((_, j) => j !== i) }); }}>
            <Icon name="trash" size={15} />
          </IconButton>
        </div>
      ))}
      <div className="row row--tight">
        <Button size="sm" onClick={() => add("output")} icon={<Icon name="plus" size={14} />}>Output device</Button>
        <Button size="sm" onClick={() => add("input")} icon={<Icon name="plus" size={14} />}>Input device</Button>
        <Button size="sm" onClick={() => add("process")} icon={<Icon name="plus" size={14} />}>App audio</Button>
      </div>
    </div>
  );
}

/* ------------------------------- Hotkey input ---------------------------- */
function HotkeyInput({ value, onCommit }: { value: string; onCommit: (acc: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  const [current, setCurrent] = useState(value);
  useEffect(() => setCurrent(value), [value]);

  if (!capturing) {
    return <button className="kb hotkey__key" onClick={() => setCapturing(true)} title="Click to rebind">{current || "press keys…"}</button>;
  }
  return (
    <button className="kb hotkey__key capturing" autoFocus tabIndex={0}
      onKeyDown={(e) => {
        e.preventDefault();
        if (e.key === "Escape") { setCapturing(false); return; }
        const parts: string[] = [];
        if (e.ctrlKey) parts.push("Ctrl");
        if (e.altKey) parts.push("Alt");
        if (e.shiftKey) parts.push("Shift");
        if (e.metaKey) parts.push("Super");
        const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
        parts.push(key);
        const acc = parts.join("+");
        setCurrent(acc); setCapturing(false); onCommit(acc);
      }}>
      press keys…
    </button>
  );
}