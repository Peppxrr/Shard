import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { AudioDeviceInfo, MonitorInfo, Settings } from "../../shared/contracts";
import { Button, Card, Confirm, Field, Icon, IconButton, Segmented, ShardSelect, StatusDot, Toggle } from "./ui";
import { ProcessCombobox } from "./ProcessSelect";
import { getAllThemes, setTheme, reloadThemes, openThemesFolder, getSelectedId } from "../themeManager";
import type { ThemeMeta } from "../../shared/contracts";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onCommit: (s: Settings) => void;
}

const NAV = [
  { id: "appearance", label: "Appearance", icon: "paintbrush" },
  { id: "capture", label: "Capture", icon: "video" },
  { id: "video", label: "Video", icon: "monitor" },
  { id: "export", label: "Export", icon: "export" },
  { id: "audio", label: "Audio", icon: "volume" },
  { id: "hotkeys", label: "Hotkeys", icon: "key" },
  { id: "storage", label: "Storage", icon: "hardDrive" },
  { id: "app", label: "App", icon: "power" },
] as const;

type NavId = (typeof NAV)[number]["id"];

export function SettingsPage({ settings, onChange, onCommit }: Props) {
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [active, setActive] = useState<NavId>(() => {
    try {
      const saved = localStorage.getItem("shard:settingsTab");
      if (saved && (NAV as readonly { id: string }[]).some((n) => n.id === saved)) return saved as NavId;
    } catch {}
    return "appearance";
  });
  const [version, setVersion] = useState("");
  const [defaultClipsFolder, setDefaultClipsFolder] = useState("");
  const [pendingHwAccel, setPendingHwAccel] = useState<boolean | null>(null);

  useEffect(() => {
    try { localStorage.setItem("shard:settingsTab", active); } catch {}
  }, [active]);

  useEffect(() => {
    window.shard.version().then(setVersion).catch(() => {});
    window.shard.getDefaultClipsFolder().then(setDefaultClipsFolder).catch(() => {});
    // The core spawns asynchronously; invokes reject with "core not connected"
    // until its WebSocket opens. Retry until both lists land, and re-fetch on
    // the core "ready" event (covers reconnects), or the monitor dropdown and
    // audio device selects stay empty and look permanently disabled. Monitors
    // additionally fall back to Electron's own display enumeration so the
    // dropdown is usable even while the core is unavailable.
    let populated = false;
    const load = async () => {
      const [d, m] = await Promise.all([
        window.shard.invoke("audio.listDevices").catch(() => null),
        window.shard.invoke("capture.listMonitors").catch(() => null),
      ]);
      if (d) setDevices(d as AudioDeviceInfo[]);
      if (m && (m as MonitorInfo[]).length) {
        setMonitors(m as MonitorInfo[]);
        populated = true;
      } else {
        const fallback = await window.shard.listMonitorsFallback().catch(() => [] as MonitorInfo[]);
        if (fallback.length) setMonitors((prev) => (prev.length ? prev : fallback));
      }
    };
    void load();
    const off = window.shard.onCoreEvent((type) => {
      if (type === "ready") void load();
    });
    let attempts = 0;
    const timer = window.setInterval(() => {
      if (populated || ++attempts > 20) {
        window.clearInterval(timer);
        return;
      }
      void load();
    }, 1500);
    return () => {
      off();
      window.clearInterval(timer);
    };
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
        {active === "appearance" && (
          <AppearancePanel settings={settings} onChange={onChange} />
        )}
        {active === "capture" && (
          <div className="stack">
            <Card title="Capture mode" icon={<Icon name="video" size={16} />}>
              <Field label="Mode" hint="Auto stays on the game while it is active (no desktop flashes mid-game) and only falls back to desktop once it closes. Game only never captures desktop.">
                <ShardSelect
                  value={settings.capture.mode}
                  onChange={(v) => patchDeep("capture", { mode: v })}
                  style={{ maxWidth: 320 }}
                  options={[
                    { value: "auto", label: "Auto (game capture, desktop when no game)" },
                    { value: "screen", label: "Desktop (monitor capture)" },
                    { value: "game", label: "Game only (never desktop)" },
                  ]}
                />
              </Field>
              <Field label="Monitor (for desktop capture)" hint={monitors.length === 0 ? "Detecting displays…" : undefined}>
                <ShardSelect
                  value={String(settings.capture.monitor)}
                  onChange={(v) => patchDeep("capture", { monitor: Number(v) })}
                  style={{ maxWidth: 420 }}
                  disabled={settings.capture.mode === "game" || monitors.length === 0}
                  options={
                    monitors.length
                      ? monitors.map((monitor) => ({
                          value: String(monitor.index),
                          label: `${monitor.name} — ${monitor.width}×${monitor.height}${monitor.primary ? " (Primary)" : ""}`,
                        }))
                      : [{ value: String(settings.capture.monitor), label: `Display ${settings.capture.monitor + 1}` }]
                  }
                />
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
          <Card title="Video" icon={<Icon name="monitor" size={16} />}>
            <Field label="Encoder">
              <ShardSelect
                value={settings.video.encoder}
                onChange={(v) => patchDeep("video", { encoder: v })}
                style={{ maxWidth: 320 }}
                options={[
                  { value: "auto", label: "Auto (NVENC H.264 → x264)" },
                  { value: "obs_x264", label: "x264 (CPU)" },
                  { value: "obs_x265", label: "x265 / HEVC (CPU)" },
                  { value: "obs_nvenc_h264_tex", label: "NVENC H.264 (GPU)" },
                  { value: "obs_nvenc_hevc_tex", label: "NVENC HEVC (GPU)" },
                  { value: "obs_nvenc_av1_tex", label: "NVENC AV1 (GPU)" },
                ]}
              />
            </Field>
            <Field label="Preset" hint="Medium / High use your monitor's native resolution.">
              <ShardSelect
                value={settings.video.preset}
                onChange={(v) => patchDeep("video", { preset: v, custom: v === "custom" })}
                style={{ maxWidth: 320 }}
                options={[
                  { value: "low", label: "Low — 720p30 @ 4 Mbps" },
                  { value: "medium", label: "Medium — native @ 8 Mbps" },
                  { value: "high", label: "High — native @ 16 Mbps" },
                  { value: "custom", label: "Custom" },
                ]}
              />
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
                {settings.video.encoder === "obs_x264" && (
                  <Field label="x264 preset">
                    <ShardSelect
                      value={settings.video.x264Preset}
                      onChange={(v) => patchDeep("video", { x264Preset: v })}
                      style={{ maxWidth: 160 }}
                      options={["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"].map((p) => ({ value: p, label: p }))}
                    />
                  </Field>
                )}
              </div>
            )}
          </Card>
        )}

        {active === "export" && (
          <Card title="Export" icon={<Icon name="export" size={16} />}>
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
              <ShardSelect
                value={settings.export.resolution}
                onChange={(v) => patchDeep("export", { resolution: v })}
                style={{ maxWidth: 320 }}
                options={[
                  { value: "source", label: "Source" },
                  { value: "1080p", label: "1080p" },
                  { value: "720p", label: "720p" },
                  { value: "480p", label: "480p" },
                  { value: "360p", label: "360p" },
                ]}
              />
            </Field>
          </Card>
        )}

        {active === "audio" && (
          <div className="stack">
            <Card title="Audio sources" icon={<Icon name="sliders" size={16} />}>
              <p className="field__hint" style={{ margin: "0 0 var(--sp-4)" }}>
                With no sources configured, the default output device is captured automatically. Disabling every configured
                source intentionally captures no device. Voicemeeter buses appear as normal output devices. Per-app capture needs Win10 2004+.
              </p>
              <AudioSources settings={settings} devices={devices} patch={patchDeep}
                commit={(sources) => onCommit({ ...settings, audio: { ...settings.audio, sources } })} />
            </Card>
            <ClipSoundCard settings={settings} onChange={onChange} />
          </div>
        )}

        {active === "hotkeys" && (
          <Card title="Hotkeys" icon={<Icon name="key" size={16} />}>
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
                  <ShardSelect
                    value={h.action}
                    onChange={(v) => {
                      const hotkeys = settings.hotkeys.map((x) => x.id === h.id ? { ...x, action: v as typeof x.action } : x);
                      patch({ hotkeys });
                    }}
                    style={{ width: 148, flex: "0 0 auto" }}
                    options={[
                      { value: "save_clip", label: "Save clip" },
                      { value: "toggle_record", label: "Toggle recording" },
                    ]}
                  />
                  {h.action === "save_clip" && (
                    <span className="hotkey__dur">
                      <HotkeyDurationInput
                        value={h.durationSec ?? 60}
                        unit={h.durationUnit ?? "sec"}
                        onCommit={(durationSec) => {
                          const hotkeys = settings.hotkeys.map((x) => (x.id === h.id ? { ...x, durationSec } : x));
                          patch({ hotkeys });
                        }}
                      />
                      <ShardSelect
                        value={h.durationUnit ?? "sec"}
                        onChange={(v) => {
                          const unit = v as "sec" | "min";
                          const secs = h.durationSec ?? 60;
                          const durationSec = unit === "min" ? Math.max(60, Math.round(secs / 60) * 60) : secs;
                          const hotkeys = settings.hotkeys.map((x) => x.id === h.id ? { ...x, durationSec, durationUnit: unit } : x);
                          patch({ hotkeys });
                        }}
                        options={[
                          { value: "sec", label: "sec" },
                          { value: "min", label: "min" },
                        ]}
                        style={{ width: 64 }}
                      />
                    </span>
                  )}
                  <IconButton variant="danger" label="Remove hotkey" onClick={() => { patch({ hotkeys: settings.hotkeys.filter((x) => x.id !== h.id) }); }}>
                    <Icon name="x" size={15} />
                  </IconButton>
                </div>
              ))}
              <Button icon={<Icon name="plus" size={15} />} onClick={() => {
                const id = `hotkey_${Date.now()}`;
                patch({ hotkeys: [...settings.hotkeys, { id, label: "New hotkey", accelerator: "", action: "save_clip", durationSec: 60, durationUnit: "sec" }] });
              }}>Add hotkey</Button>
            </div>
          </Card>
        )}

        {active === "storage" && (
          <Card title="Storage" icon={<Icon name="hardDrive" size={16} />}>
            <Field
              label="Retention limit (GB)"
              hint={settings.storage.deleteEdited
                ? "Oldest unprotected clips, including editor exports, are deleted automatically to stay under the limit."
                : "Oldest unprotected source clips are deleted automatically. Editor exports are retained."}
            >
              <input className="input" type="number" min={1} max={1000} value={settings.storage.limitGb}
                onChange={(e) => patchDeep("storage", { limitGb: Number(e.target.value) })} style={{ maxWidth: 160 }} />
            </Field>
            <label className="settings__row">
              <Toggle checked={settings.storage.deleteEdited} onChange={(value) => patchDeep("storage", { deleteEdited: value })} />
              <span>Delete unprotected editor clips when storage is full</span>
            </label>
            <Field label="Clips folder" hint={<>Base directory for clips. Shard creates <span className="mono">clips/</span>, <span className="mono">editor/</span>, and <span className="mono">recordings/</span> inside it. Existing clips stay in the library.</>}>
              <div className="storage-location">
                <Button icon={<Icon name="folderOpen" size={15} />} onClick={() => {
                  void window.shard.pickClipsFolder(settings.storage.clipsDir).then((folder) => {
                    if (folder !== null) patchDeep("storage", { clipsDir: folder });
                  });
                }}>Browse</Button>
                <div className="storage-location__value" title={settings.storage.clipsDir.trim() || defaultClipsFolder}>
                  <span className={`storage-location__kind${settings.storage.clipsDir.trim() ? " is-custom" : ""}`}>
                    {settings.storage.clipsDir.trim() ? "Custom" : "Default clip location"}
                  </span>
                  <span className="storage-location__path mono">
                    {settings.storage.clipsDir.trim() || defaultClipsFolder || "App data folder"}
                  </span>
                </div>
                {settings.storage.clipsDir.trim() && (
                  <Button variant="ghost" onClick={() => patchDeep("storage", { clipsDir: "" })}>Use default</Button>
                )}
              </div>
            </Field>
          </Card>
        )}

        {active === "app" && (
          <>
          <Card title="App" icon={<Icon name="power" size={16} />}>
            <Field label="Clip-saved notification" hint="Overlay shows a popup on your screen for a moment (top-left); Windows notification is used when the window is hidden.">
              <ShardSelect
                value={settings.app.notificationStyle}
                onChange={(v) => patchDeep("app", { notificationStyle: v })}
                style={{ maxWidth: 320 }}
                options={[
                  { value: "overlay", label: "Overlay toast" },
                  { value: "windows", label: "Windows notification (when hidden)" },
                  { value: "off", label: "Off" },
                ]}
              />
            </Field>
            <label className="settings__row">
              <Toggle checked={settings.app.startWithWindows} onChange={(v) => patchDeep("app", { startWithWindows: v })} />
              <span>Start with Windows</span>
            </label>
            <label className="settings__row">
              <Toggle checked={settings.app.minimizeToTray} onChange={(v) => patchDeep("app", { minimizeToTray: v })} />
              <span>Minimize to tray when closed <span className="field__hint" style={{ display: "inline" }}>(off = closing the window quits Shard)</span></span>
            </label>
            <label className="settings__row">
              <Toggle checked={settings.app.hardwareAcceleration ?? true} onChange={(v) => setPendingHwAccel(v)} />
              <span>Hardware acceleration <span className="field__hint" style={{ display: "inline" }}>(disable only for black captures / hybrid-GPU — requires restart)</span></span>
            </label>
            <label className="settings__row">
              <Toggle checked={settings.app.developerConsole} onChange={(v) => patchDeep("app", { developerConsole: v })} />
              <span>Developer console <span className="field__hint" style={{ display: "inline" }}>(streams core logs in a separate window)</span></span>
            </label>
            {version && (
              <div className="settings__about"><StatusDot state="live" /> Shard <span className="mono">v{version}</span></div>
            )}
          </Card>
          <Confirm
            open={pendingHwAccel !== null}
            title="Restart required"
            message={pendingHwAccel ? "Hardware acceleration will be enabled after restart. Restart now?" : "Hardware acceleration will be disabled after restart (fixes black captures on some hybrid-GPU systems, e.g. Terraria). Restart now?"}
            confirmLabel="Restart"
            cancelLabel="Cancel"
            onConfirm={() => {
              const next = pendingHwAccel!;
              setPendingHwAccel(null);
              patchDeep("app", { hardwareAcceleration: next });
              // allow settings to flush to disk before relaunch (saveSettings is async)
              setTimeout(() => {
                window.shard.restartApp().catch(() => {});
              }, 200);
            }}
            onCancel={() => setPendingHwAccel(null)}
          />
          </>
        )}
      </div>
    </div>
  );
}


/* ----------------------------- Appearance / Themes ----------------------------- */
function AppearancePanel({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const [themes, setThemes] = useState<ThemeMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [themesDir, setThemesDir] = useState<string>("");
  const selected = settings.appearance?.theme ?? getSelectedId() ?? "default";

  const load = async () => {
    setLoading(true);
    try {
      const all = await getAllThemes();
      setThemes(all);
      try {
        const dir = await window.shard.getThemesDir();
        setThemesDir(dir);
      } catch {}
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const builtin = themes.filter((t) => t.kind === "builtin");
  const custom = themes.filter((t) => t.kind === "custom");

  const handleSelect = async (id: string) => {
    const safe = id.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-") || "default";
    // Apply immediately via themeManager (also persists to localStorage + settings)
    await setTheme(safe);
    // Keep React settings in sync so save shows correct value and persists
    onChange({ ...settings, appearance: { theme: safe } });
  };

  const handleReload = async () => {
    await load();
    await reloadThemes(selected);
  };

  const handleOpen = async () => {
    await openThemesFolder().catch(() => {});
  };

  return (
    <div className="stack">
      <Card title="Theme" icon={<Icon name="paintbrush" size={16} />}>
        <Field label="Selected theme" hint={loading ? "Loading themes…" : `${themes.length} theme${themes.length===1?"":"s"} installed — ${builtin.length} built-in, ${custom.length} custom`}>
          <ShardSelect
            value={selected}
            onChange={handleSelect}
            style={{ maxWidth: 360 }}
            options={themes.map((t) => ({
              value: t.id,
              label: `${t.name} ${t.kind === "custom" ? "· custom" : "· built-in"}${t.author ? " — " + t.author : ""}`,
            }))}
          />
        </Field>

        <div className="row row--tight" style={{ marginTop: "var(--sp-3)" }}>
          <Button size="sm" onClick={() => void handleOpen()} icon={<Icon name="folder" size={14} />}>Open Themes Folder</Button>
          <Button size="sm" variant="ghost" onClick={() => void handleReload()} icon={<Icon name="refresh" size={14} />}>Reload Themes</Button>
          <span className="field__hint" style={{ marginLeft: "var(--sp-2)" }}>
            Themes live in <span className="mono">{themesDir || "%APPDATA%/Shard/Themes"}</span>
          </span>
        </div>

        {custom.length === 0 && !loading && (
          <p className="field__hint" style={{ marginTop: "var(--sp-3)" }}>
            No custom themes yet. Create a folder like <span className="mono">Themes/my-theme/theme.css</span> and click Reload.
          </p>
        )}
      </Card>

      <Card title="Installed themes" icon={<Icon name="hardDrive" size={16} />}>
        {loading ? (
          <div className="empty" style={{ padding: "var(--sp-6)" }}><span className="spin" /></div>
        ) : (
          <div className="stack">
            <div>
              <div className="eyebrow" style={{ marginBottom: "var(--sp-2)" }}>Built-in</div>
              <div className="stack" style={{ gap: "var(--sp-2)" }}>
                {builtin.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => void handleSelect(t.id)}
                    className={"card card--hover" + (selected === t.id ? " is-selected" : "")}
                    style={{
                      textAlign: "left",
                      padding: "var(--sp-3) var(--sp-4)",
                      borderColor: selected === t.id ? "var(--accent)" : undefined,
                      boxShadow: selected === t.id ? "0 0 0 1px var(--accent)" : undefined,
                      cursor: "pointer",
                      width: "100%",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--sp-3)" }}>
                      <strong>{t.name}</strong>
                      <span className="chip num" style={{ fontSize: "var(--fs-11)" }}>{t.id}</span>
                    </div>
                    {t.description && <div className="field__hint" style={{ marginTop: 4 }}>{t.description}</div>}
                    <div className="field__hint mono" style={{ marginTop: 2 }}>{t.author ? t.author + " · " : ""}{t.version ? "v" + t.version : ""}</div>
                  </button>
                ))}
              </div>
            </div>

            {custom.length > 0 && (
              <div>
                <div className="eyebrow" style={{ marginBottom: "var(--sp-2)" }}>Custom themes</div>
                <div className="stack" style={{ gap: "var(--sp-2)" }}>
                  {custom.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => void handleSelect(t.id)}
                      className={"card card--hover" + (selected === t.id ? " is-selected" : "")}
                      style={{
                        textAlign: "left",
                        padding: "var(--sp-3) var(--sp-4)",
                        borderColor: selected === t.id ? "var(--accent)" : undefined,
                        boxShadow: selected === t.id ? "0 0 0 1px var(--accent)" : undefined,
                        cursor: "pointer",
                        width: "100%",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--sp-3)" }}>
                        <strong>{t.name}</strong>
                        <span className="chip num" style={{ fontSize: "var(--fs-11)" }}>{t.id}</span>
                      </div>
                      {t.description && <div className="field__hint" style={{ marginTop: 4 }}>{t.description}</div>}
                      <div className="field__hint mono" style={{ marginTop: 2 }}>{t.author ? t.author + " · " : ""}{t.version ? "v" + t.version : ""}custom</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="block" style={{ background: "var(--bg-1)", borderStyle: "dashed" }}>
              <div className="eyebrow">Custom themes may load remote resources</div>
              <p className="field__hint" style={{ marginTop: 6, lineHeight: "1.5" }}>
                Custom themes may load images, fonts, or other resources from the internet via <span className="mono">url("https://…")</span> or <span className="mono">@import</span>.
                Only install themes you trust. Built-in Shard themes use local resources only.
              </p>
            </div>
          </div>
        )}
      </Card>

      <Card title="How to create a theme" icon={<Icon name="question" size={24} />}>
        <p className="field__hint" style={{ lineHeight: "1.6" }}>
          Create a folder <span className="mono">%APPDATA%/Shard/Themes/my-theme/</span> with a <span className="mono">theme.css</span>.
          See <span className="mono">docs/THEMES.md</span> for variables, class names, local assets (<span className="mono">url("./bg.webp")</span>),
          fonts, and an example theme. Click <strong>Reload Themes</strong> after editing — no restart needed.
        </p>
        <p className="field__hint" style={{ marginTop: "var(--sp-2)", lineHeight: "1.6" }}>
          Optional <span className="mono">Themes/custom.css</span> loads after the selected theme for quick personal overrides.
        </p>
      </Card>
    </div>
  );
}


function ClipSoundCard({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const [defaultPath, setDefaultPath] = useState<string>("");
  useEffect(() => { window.shard.getClipSoundDefaultPath().then(setDefaultPath).catch(() => {}); }, []);
  const vol = typeof settings.app.clipSoundVolume === "number" ? settings.app.clipSoundVolume : 0.8;
  const customPath = settings.app.clipSoundPath || "";
  const displayName = customPath ? customPath.split(/[\\/]/).pop() || customPath : "Default — Clip Sound.wav";
  const isCustom = !!customPath;

  const pickFile = async () => {
    const picked = await window.shard.pickClipSound();
    if (picked) onChange({ ...settings, app: { ...settings.app, clipSoundPath: picked, clipSound: true } });
  };
  const useDefault = () => onChange({ ...settings, app: { ...settings.app, clipSoundPath: "" } });
  const preview = () => {
    void window.shard.previewClipSound(customPath, vol);
  };

  return (
    <Card title="Clip sound" icon={<Icon name="volume" size={16} />}>
      <label className="settings__row">
        <Toggle checked={settings.app.clipSound} onChange={(v) => onChange({ ...settings, app: { ...settings.app, clipSound: v } })} />
        <span>Play sound when a clip is saved</span>
      </label>
      <div style={{ opacity: settings.app.clipSound ? 1 : 0.55, pointerEvents: settings.app.clipSound ? "auto" : "none" }}>
        <Field label="Volume" hint={`${Math.round(vol * 100)}% — preview at current volume`}>
          <div className="row" style={{ alignItems: "center" }}>
            <input
              className="slider volume-slider"
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={vol}
              style={volumeSliderStyle(vol, 1)}
              onChange={(e) => onChange({ ...settings, app: { ...settings.app, clipSoundVolume: Number(e.target.value) } })}
            />
            <span className="aud__gain num" style={{ minWidth: 36 }}>{Math.round(vol * 100)}%</span>
            <Button size="sm" variant="ghost" onClick={preview} icon={<Icon name="play" size={14} />}>Preview</Button>
          </div>
        </Field>
        <Field label="Sound file" hint={<>Default is the bundled <span className="mono">Clip Sound.wav</span> (21KB, 48kHz mono). Choose any wav/mp3/ogg/flac/m4a. Custom files are stored as an absolute path.</>}>
          <div className="row row--tight" style={{ alignItems: "center" }}>
            <input className="input" readOnly value={displayName} title={customPath || defaultPath} style={{ flex: "1 1 200px", opacity: isCustom ? 1 : 0.85 }} placeholder="Default — Clip Sound.wav" />
            <Button size="sm" onClick={pickFile} icon={<Icon name="folder" size={14} />}>Choose…</Button>
            {isCustom && <Button size="sm" variant="ghost" onClick={useDefault}>Use default</Button>}
          </div>
          {isCustom && customPath && <div className="field__hint mono" style={{ marginTop: 6, wordBreak: "break-all", fontSize: 11 }}>{customPath}</div>}
        </Field>
      </div>
    </Card>
  );
}

/* ----------------------------- Audio sources ----------------------------- */
function AudioSources({ settings, devices, patch, commit }: {
  settings: Settings;
  devices: AudioDeviceInfo[];
  patch: (section: "audio", p: unknown) => void;
  commit: (sources: Settings["audio"]["sources"]) => void;
}) {
  // Device ids already configured by another row — hidden from the device
  // selects and skipped by add(), so one physical device can never be
  // captured twice.
  const usedIds = new Set(settings.audio.sources.filter((s) => s.kind !== "process").map((s) => s.id));

  const add = (kind: "output" | "input" | "process") => {
    // Never configure the same physical device twice: pick the first device
    // of this flow that is not already used by another row.
    const pool = devices.filter((x) => (kind === "input" ? x.isInput : !x.isInput) && !usedIds.has(x.id));
    const d = pool[0];
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
          <ShardSelect
            value={s.kind}
            onChange={(v) => { const sources = [...settings.audio.sources]; sources[i] = { ...sources[i], kind: v as typeof s.kind }; patch("audio", { sources }); }}
            style={{ maxWidth: 160 }}
            options={[
              { value: "output", label: "Device output" },
              { value: "input", label: "Device input" },
              { value: "process", label: "App audio" },
            ]}
          />
          {s.kind !== "process" ? (
            <ShardSelect
              value={s.id}
              onChange={(v) => { const sources = [...settings.audio.sources]; const d = devices.find((x) => x.id === v); sources[i] = { ...sources[i], id: v, name: d?.name ?? v }; patch("audio", { sources }); }}
              style={{ flex: "1 1 200px" }}
              options={devices
                .filter((d) => (s.kind === "input" ? d.isInput : !d.isInput) && (d.id === s.id || !usedIds.has(d.id)))
                .map((d) => ({ value: d.id, label: `${d.name}${d.isVoicemeeter ? " (Voicemeeter)" : ""}` }))}
            />
          ) : (
            <ProcessCombobox
              value={(s.window ?? "").replace(/^::?/, "").trim()}
              onChange={(exe) => {
                const sources = [...settings.audio.sources];
                const normalized = exe.trim().toLowerCase();
                const win = normalized ? `::${normalized}` : "::";
                sources[i] = { ...sources[i], window: win, name: normalized ? `App: ${normalized}` : "App audio" };
                patch("audio", { sources });
              }}
              placeholder="::game.exe — pick running app"
              style={{ flex: "1 1 200px" }}
            />
          )}
          <input
            className="slider volume-slider"
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={s.gain}
            title={`Gain ${Math.round(s.gain * 100)}%`}
            style={volumeSliderStyle(s.gain, 2)}
            onChange={(e) => { const sources = [...settings.audio.sources]; sources[i] = { ...sources[i], gain: Number(e.target.value) }; patch("audio", { sources }); }}
          />
          <span className="aud__gain num">{Math.round(s.gain * 100)}%</span>
          <Toggle checked={s.enabled}
            onChange={(enabled) => {
              const sources = [...settings.audio.sources];
              sources[i] = { ...sources[i], enabled };
              commit(sources);
            }} />
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

function volumeSliderStyle(value: number, max: number): CSSProperties {
  return {
    "--range-progress": `${Math.max(0, Math.min(100, (value / max) * 100))}%`,
    "--range-color": value > 1 ? "var(--danger)" : "var(--accent)",
  } as CSSProperties;
}

/* ------------------------------- Hotkey input ---------------------------- */
// Duration field with proper editing: the current value can be fully deleted
// while typing (empty state), and blurring without a value resets the field
// to 0 instead of snapping to 1 (the old controlled input made "0"
// impossible to delete). A committed 0 is treated as "no value" by the
// trigger (falls back to the 60 s default).
function HotkeyDurationInput({ value, unit, onCommit }: {
  value: number;
  unit: "sec" | "min";
  onCommit: (durationSec: number) => void;
}) {
  const [text, setText] = useState<string>(String(Math.round(value / (unit === "min" ? 60 : 1))));
  useEffect(() => setText(String(Math.round(value / (unit === "min" ? 60 : 1)))), [value, unit]);

  const commitText = (raw: string) => {
    const n = Number(raw);
    const secs = unit === "min" ? (Number.isFinite(n) ? n * 60 : 0) : (Number.isFinite(n) ? n : 0);
    onCommit(Math.max(0, secs));
  };

  return (
    <input
      className="input"
      type="number"
      min={0}
      value={text}
      style={{ width: 56 }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n) && n > 0) commitText(e.target.value);
      }}
      onBlur={() => {
        const n = Number(text);
        if (text.trim() === "" || !Number.isFinite(n) || n <= 0) {
          setText("0");
          onCommit(0);
        } else {
          commitText(text);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function HotkeyInput({ value, onCommit }: { value: string; onCommit: (acc: string) => void }) {  const [capturing, setCapturing] = useState(false);
  const [current, setCurrent] = useState(value);
  useEffect(() => setCurrent(value), [value]);

  // Registered global shortcuts (the F8/F9/F10 defaults) are consumed by the OS
  // before the window sees them, making the defaults impossible to re-enter.
  // Release every shortcut for the duration of the capture and re-apply after
  // (commit, Escape, or unmount).
  useEffect(() => {
    if (!capturing) return;
    void window.shard.suspendHotkeys();
    return () => void window.shard.resumeHotkeys();
  }, [capturing]);

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