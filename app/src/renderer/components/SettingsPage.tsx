import { useEffect, useState } from "react";
import type { AudioDeviceInfo, Settings } from "../../shared/contracts";
import { DEFAULT_SETTINGS } from "../../shared/contracts";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

const SECTIONS = [
  { id: "recorder", label: "Recorder" },
  { id: "quality", label: "Quality" },
  { id: "audio", label: "Audio" },
  { id: "games", label: "Game Detection" },
  { id: "hotkeys", label: "Hotkeys" },
  { id: "storage", label: "Storage" },
  { id: "app", label: "App" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsPage({ settings, onChange }: Props) {
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [hotkeyStatus, setHotkeyStatus] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [saved, setSaved] = useState(false);
  const [active, setActive] = useState<SectionId>("recorder");
  const [durationUnit, setDurationUnit] = useState<string | null>(null);

  useEffect(() => {
    window.clipforge.invoke("audio.listDevices").then((d) => setDevices(d as AudioDeviceInfo[])).catch(() => {});
  }, []);

  const patch = (p: Partial<Settings>) => {
    setSaved(false);
    onChange({ ...settings, ...p });
  };
  const patchDeep = (section: "capture" | "video" | "replay" | "game" | "storage" | "app" | "export" | "audio", p: unknown) => {
    setSaved(false);
    onChange({ ...settings, [section]: { ...(settings[section] as object), ...(p as object) } });
  };

  const save = async () => {
    await window.clipforge.setSettings(settings);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="settings-shell">
      <aside className="settings-sidebar">
        {SECTIONS.map((s) => (
          <button key={s.id} className={active === s.id ? "active" : ""} onClick={() => setActive(s.id)}>
            {s.label}
          </button>
        ))}
      </aside>

      <div className="settings">
        {active === "recorder" && (
          <>
            <section>
              <h2>Capture</h2>
              <label>
                Mode
                <select value={settings.capture.mode} onChange={(e) => patchDeep("capture", { mode: e.target.value })}>
                  <option value="auto">Auto (game capture, desktop when no game)</option>
                  <option value="screen">Desktop (monitor capture)</option>
                  <option value="game">Game only (never desktop)</option>
                </select>
              </label>
              <p className="hint">
                Auto: stays on the game while it is active (no desktop flashes mid-game) and only falls back to
                desktop once it closes. Game only: game capture with no desktop fallback at all.
              </p>
              <label>
                Monitor (for desktop mode)
                <input
                  type="number" min={0} value={settings.capture.monitor}
                  onChange={(e) => patchDeep("capture", { monitor: Number(e.target.value) })}
                />
              </label>
            </section>

            <section>
              <h2>Replay buffer</h2>
              <p className="hint">
                The ring buffers only while capture is active and frees its RAM 15 s after capture ends, so you can
                still grab a last-second clip after closing a game.
              </p>
              <div className="row">
                <label>
                  Max seconds
                  <input type="number" min={30} step={30} value={settings.replay.maxSeconds}
                    onChange={(e) => patchDeep("replay", { maxSeconds: Number(e.target.value) })} />
                </label>
                <label>
                  Max MB (RAM)
                  <input type="number" min={256} step={256} value={settings.replay.maxMb}
                    onChange={(e) => patchDeep("replay", { maxMb: Number(e.target.value) })} />
                </label>
              </div>
            </section>
          </>
        )}

        {active === "quality" && (
          <>
            <section>
              <h2>Video</h2>
              <label>
                Encoder
                <select value={settings.video.encoder} onChange={(e) => patchDeep("video", { encoder: e.target.value })}>
                  <option value="auto">Auto (NVENC H.264 → x264)</option>
                  <option value="obs_x264">x264 (CPU)</option>
                  <option value="obs_nvenc_h264_tex">NVENC H.264 (GPU)</option>
                  <option value="obs_nvenc_av1_tex">NVENC AV1 (GPU)</option>
                </select>
              </label>
              <label>
                Preset
                <select
                  value={settings.video.preset}
                  onChange={(e) => patchDeep("video", { preset: e.target.value, custom: e.target.value === "custom" })}
                >
                  <option value="low">Low — 720p30 @ 4 Mbps</option>
                  <option value="medium">Medium — 1080p60 @ 8 Mbps</option>
                  <option value="high">High — 1080p60 @ 16 Mbps</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              {settings.video.custom && (
                <div className="row">
                  <label>
                    Bitrate (kbps)
                    <input type="number" min={100} step={100} value={settings.video.bitrateKbps}
                      onChange={(e) => patchDeep("video", { bitrateKbps: Number(e.target.value) })} />
                  </label>
                  <label>
                    FPS
                    <input type="number" min={15} max={240} value={settings.video.fps}
                      onChange={(e) => patchDeep("video", { fps: Number(e.target.value) })} />
                  </label>
                  <label>
                    Width
                    <input type="number" min={320} step={2} value={settings.video.width}
                      onChange={(e) => patchDeep("video", { width: Number(e.target.value) })} />
                  </label>
                  <label>
                    Height
                    <input type="number" min={240} step={2} value={settings.video.height}
                      onChange={(e) => patchDeep("video", { height: Number(e.target.value) })} />
                  </label>
                  <label>
                    x264 preset
                    <select value={settings.video.x264Preset}
                      onChange={(e) => patchDeep("video", { x264Preset: e.target.value })}>
                      {["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"].map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </section>

            <section>
              <h2>Export</h2>
              <div className="row">
                <label>
                  Target size (MB)
                  <input type="number" min={1} max={100} value={settings.export.targetMb}
                    onChange={(e) => patchDeep("export", { targetMb: Number(e.target.value) })} />
                </label>
                <label>
                  Codec
                  <select value={settings.export.codec}
                    onChange={(e) => patchDeep("export", { codec: e.target.value })}>
                    <option value="h264">H.264</option>
                    <option value="h265">H.265</option>
                  </select>
                </label>
                <label>
                  Resolution
                  <select value={settings.export.resolution}
                    onChange={(e) => patchDeep("export", { resolution: e.target.value })}>
                    <option value="auto">Auto (by length)</option>
                    <option value="source">Source</option>
                    <option value="1080p">1080p</option>
                    <option value="720p">720p</option>
                    <option value="480p">480p</option>
                    <option value="360p">360p</option>
                  </select>
                </label>
                <label>
                  Audio (kbps)
                  <input type="number" min={64} max={320} step={32} value={settings.export.audioBitrateKbps}
                    onChange={(e) => patchDeep("export", { audioBitrateKbps: Number(e.target.value) })} />
                </label>
              </div>
            </section>
          </>
        )}

        {active === "audio" && (
          <section>
            <h2>Audio sources</h2>
            <p className="hint">
              With no sources enabled, the default output device is captured automatically. Voicemeeter buses appear as
              normal output devices. Per-app capture needs Win10 2004+.
            </p>
            <AudioSources settings={settings} devices={devices} patch={patchDeep} />
          </section>
        )}

        {active === "games" && (
          <>
            <section>
              <h2>Game Detection</h2>
              <label>
                <input type="checkbox" checked={settings.game.autoRecord}
                  onChange={(e) => patchDeep("game", { autoRecord: e.target.checked })} />
                Auto-record when a known game is foreground
              </label>
              <label>
                Grace after leaving game (s)
                <input type="number" min={0} max={300} value={settings.game.graceSeconds}
                  onChange={(e) => patchDeep("game", { graceSeconds: Number(e.target.value) })} />
              </label>
            </section>
            <section>
              <h2>Known games</h2>
              <GameList />
            </section>
          </>
        )}

        {active === "hotkeys" && (
          <section>
            <h2>Hotkeys</h2>
            <p className="hint">
              Windows key combos are not supported by Electron global shortcuts. Click a row's key to rebind; add as
              many as you like.
            </p>
            {settings.hotkeys.map((h) => (
              <div className={`hotkey-row ${hotkeyStatus[h.id] && !hotkeyStatus[h.id].ok ? "bad" : ""}`} key={h.id}>
                <input
                  className="hotkey-label"
                  value={h.label}
                  placeholder="Label"
                  onChange={(e) => {
                    const hotkeys = settings.hotkeys.map((x) => (x.id === h.id ? { ...x, label: e.target.value } : x));
                    patch({ hotkeys });
                  }}
                />
                <HotkeyInput
                  value={h.accelerator}
                  onCommit={(acc) => {
                    const hotkeys = settings.hotkeys.map((x) => (x.id === h.id ? { ...x, accelerator: acc } : x));
                    patch({ hotkeys });
                  }}
                />
                <select
                  value={h.action}
                  onChange={(e) => {
                    const hotkeys = settings.hotkeys.map((x) =>
                      x.id === h.id ? { ...x, action: e.target.value as typeof x.action } : x
                    );
                    patch({ hotkeys });
                  }}
                >
                  <option value="save_clip">Save clip</option>
                  <option value="toggle_record">Toggle recording</option>
                </select>
                {h.action === "save_clip" && (
                  <span className="hotkey-duration">
                    <input
                      type="number" min={1} value={Math.round((h.durationSec ?? 60) / (durationUnit === h.id ? 60 : 1))}
                      onChange={(e) => {
                        const n = Number(e.target.value) || 0;
                        const secs = durationUnit === h.id ? n * 60 : n;
                        const hotkeys = settings.hotkeys.map((x) =>
                          x.id === h.id ? { ...x, durationSec: Math.max(1, secs) } : x
                        );
                        patch({ hotkeys });
                      }}
                    />
                    <select
                      value={durationUnit === h.id ? "min" : "sec"}
                      onChange={(e) => {
                        const secs = h.durationSec ?? 60;
                        const hotkeys = settings.hotkeys.map((x) =>
                          x.id === h.id ? { ...x, durationSec: e.target.value === "min" ? Math.max(60, secs) : secs } : x
                        );
                        setDurationUnit(h.id);
                        patch({ hotkeys });
                      }}
                    >
                      <option value="sec">sec</option>
                      <option value="min">min</option>
                    </select>
                  </span>
                )}
                <button
                  className="danger"
                  title="Remove hotkey"
                  onClick={() => patch({ hotkeys: settings.hotkeys.filter((x) => x.id !== h.id) })}
                >
                  ✕
                </button>
                {hotkeyStatus[h.id] && !hotkeyStatus[h.id].ok && (
                  <span className="error">{hotkeyStatus[h.id].error}</span>
                )}
              </div>
            ))}
            <div className="row">
              <button
                onClick={() => {
                  const id = `hotkey_${Date.now()}`;
                  patch({ hotkeys: [...settings.hotkeys, { id, label: "New hotkey", accelerator: "", action: "save_clip", durationSec: 60 }] });
                }}
              >
                + Add hotkey
              </button>
            </div>
          </section>
        )}

        {active === "storage" && (
          <>
            <section>
              <h2>Storage</h2>
              <label>
                Limit (GB)
                <input type="number" min={1} max={1000} value={settings.storage.limitGb}
                  onChange={(e) => patchDeep("storage", { limitGb: Number(e.target.value) })} />
              </label>
              <p className="hint">
                Oldest unprotected clips are deleted automatically to stay under the limit. Edited clips are never
                auto-deleted.
              </p>
              <label>
                Clips folder (base directory)
                <input
                  type="text"
                  placeholder="e.g. D:\Clips (leave empty for default)"
                  value={settings.storage.clipsDir}
                  onChange={(e) => patchDeep("storage", { clipsDir: e.target.value })}
                />
              </label>
              <p className="hint">
                The app creates <span className="mono">clips/</span> and <span className="mono">editor/</span> inside
                this folder. Clips saved after the change land there; existing clips stay in the library.
              </p>
            </section>
          </>
        )}

        {active === "app" && (
          <section>
            <h2>App</h2>
            <label>
              Clip-saved notification
              <select value={settings.app.notificationStyle}
                onChange={(e) => patchDeep("app", { notificationStyle: e.target.value })}>
                <option value="overlay">Overlay toast</option>
                <option value="windows">Windows notification (when hidden)</option>
                <option value="off">Off</option>
              </select>
            </label>
            <p className="hint">Overlay shows a small toast for a moment; Windows notification is used when the window is hidden.</p>
            <label>
              <input type="checkbox" checked={settings.app.startWithWindows}
                onChange={(e) => patchDeep("app", { startWithWindows: e.target.checked })} />
              Start with Windows
            </label>
          </section>
        )}

        <button className="primary big" onClick={() => void save()}>{saved ? "Saved ✓" : "Save settings"}</button>
      </div>
    </div>
  );
}

function AudioSources({
  settings, devices, patch,
}: {
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
      kind,
      window: kind === "process" ? "::" : undefined,
      gain: 1,
      enabled: true,
    });
    patch("audio", { sources });
  };

  return (
    <div className="audio-sources">
      {settings.audio.sources.map((s, i) => (
        <div className="audio-row" key={i}>
          <select
            value={s.kind}
            onChange={(e) => {
              const sources = [...settings.audio.sources];
              sources[i] = { ...sources[i], kind: e.target.value as typeof s.kind };
              patch("audio", { sources });
            }}
          >
            <option value="output">Device output</option>
            <option value="input">Device input</option>
            <option value="process">App audio</option>
          </select>
          {s.kind !== "process" ? (
            <select
              value={s.id}
              onChange={(e) => {
                const sources = [...settings.audio.sources];
                const d = devices.find((x) => x.id === e.target.value);
                sources[i] = { ...sources[i], id: e.target.value, name: d?.name ?? e.target.value };
                patch("audio", { sources });
              }}
            >
              {devices
                .filter((d) => (s.kind === "input" ? d.isInput : !d.isInput))
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}{d.isVoicemeeter ? " (Voicemeeter)" : ""}
                  </option>
                ))}
            </select>
          ) : (
            <input
              placeholder="::game.exe"
              value={s.window ?? ""}
              onChange={(e) => {
                const sources = [...settings.audio.sources];
                sources[i] = { ...sources[i], window: e.target.value };
                patch("audio", { sources });
              }}
            />
          )}
          <input
            type="range" min={0} max={1} step={0.05} value={s.gain} title={`Gain ${Math.round(s.gain * 100)}%`}
            onChange={(e) => {
              const sources = [...settings.audio.sources];
              sources[i] = { ...sources[i], gain: Number(e.target.value) };
              patch("audio", { sources });
            }}
          />
          <span className="gain">{Math.round(s.gain * 100)}%</span>
          <input
            type="checkbox" checked={s.enabled} title="Enabled"
            onChange={(e) => {
              const sources = [...settings.audio.sources];
              sources[i] = { ...sources[i], enabled: e.target.checked };
              patch("audio", { sources });
            }}
          />
          <button
            onClick={() => patch("audio", { sources: settings.audio.sources.filter((_, j) => j !== i) })}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="row">
        <button onClick={() => add("output")}>+ Output device</button>
        <button onClick={() => add("input")}>+ Input device</button>
        <button onClick={() => add("process")}>+ App audio</button>
      </div>
    </div>
  );
}

function GameList() {
  const [games, setGames] = useState<{ exe: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [exe, setExe] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    window.clipforge.invoke("game.listKnown").then((g) => setGames(g as { exe: string; name: string }[])).catch(() => {});
  }, []);
  const refresh = async () => {
    setGames((await window.clipforge.invoke("game.listKnown")) as { exe: string; name: string }[]);
  };
  return (
    <div className="games-dropdown">
      <button onClick={() => setOpen((o) => !o)} title="Toggle known games list">
        🎮 Known games ({games.length}) {open ? "▲" : "▼"}
      </button>
      {open && (
        <div className="games-panel">
          {games.length === 0 && <div className="hint" style={{ padding: 10 }}>No games added yet.</div>}
          {games.map((g) => (
            <div className="games-row" key={g.exe}>
              <span className="gname">{g.name}</span>
              <span className="gexe">{g.exe}</span>
              <button onClick={() => window.clipforge.invoke("game.removeKnown", { exe: g.exe }).then(refresh)}>
                Remove
              </button>
            </div>
          ))}
          <div className="row" style={{ padding: 10 }}>
            <input placeholder="exe (e.g. mygame.exe)" value={exe} onChange={(e) => setExe(e.target.value)} />
            <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
            <button
              disabled={!exe || !name}
              onClick={async () => {
                await window.clipforge.invoke("game.addKnown", { exe, name });
                setExe("");
                setName("");
                await refresh();
              }}
            >
              Add game
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HotkeyInput({ value, onCommit }: { value: string; onCommit: (acc: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  const [current, setCurrent] = useState(value);
  useEffect(() => setCurrent(value), [value]);

  if (!capturing) {
    return (
      <button className="hotkey-value" onClick={() => setCapturing(true)}>
        {current || "press keys…"}
      </button>
    );
  }
  return (
    <button
      className="hotkey-value capturing"
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
        setCurrent(acc);
        setCapturing(false);
        onCommit(acc);
      }}
      tabIndex={0}
      autoFocus
    >
      press keys…
    </button>
  );
}

export { DEFAULT_SETTINGS };
