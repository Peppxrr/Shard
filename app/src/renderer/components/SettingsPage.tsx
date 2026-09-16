import { useEffect, useRef, useState } from "react";
import type { AudioDeviceInfo, ExportEncoderInfo, MonitorInfo, Settings, VideoEncoderInfo } from "../../shared/contracts";
import { Button, Card, Icon, IconButton, ShardSelect } from "./ui";
import { VideoSettingsPanel } from "./VideoSettingsPanel";
import { ClipSoundSettings } from "./ClipSoundSettings";
import { CaptureSettingsPanel, ExportSettingsPanel, StorageSettingsPanel, AppSettingsPanel } from "./GeneralSettingsPanels";
import { AudioSourcesSettings } from "./AudioSourcesSettings";
import { HotkeysSettings } from "./HotkeysSettings";
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

const SETTINGS_DESCRIPTIONS: Record<NavId, string> = {
  appearance: "Make Shard feel at home on your desktop.",
  capture: "Choose what to capture and how much replay history to keep.",
  video: "Balance image quality, performance, and file size.",
  export: "Set the defaults for clips you share.",
  audio: "Choose the sounds and microphones included in your recordings.",
  hotkeys: "Keep your capture controls a keypress away.",
  storage: "Choose where clips live and how storage is managed.",
  app: "Control startup, notifications, and app behavior.",
};

export function SettingsPage({ settings, onChange, onCommit }: Props) {
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [videoEncoders, setVideoEncoders] = useState<VideoEncoderInfo[]>([]);
  const [exportEncoders, setExportEncoders] = useState<ExportEncoderInfo[]>([]);
  const [active, setActive] = useState<NavId>(() => {
    try {
      const saved = localStorage.getItem("shard:settingsTab");
      if (saved && (NAV as readonly { id: string }[]).some((n) => n.id === saved)) return saved as NavId;
    } catch {}
    return "appearance";
  });
  const [version, setVersion] = useState("");
  const [defaultClipsFolder, setDefaultClipsFolder] = useState("");
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { localStorage.setItem("shard:settingsTab", active); } catch {}
    pageRef.current?.parentElement?.scrollTo({ top: 0 });
  }, [active]);

  useEffect(() => {
    window.shard.version().then(setVersion).catch(() => {});
    window.shard.getDefaultClipsFolder().then(setDefaultClipsFolder).catch(() => {});
    window.shard.listExportEncoders().then(setExportEncoders).catch(() => {});
    // The core spawns asynchronously; invokes reject with "core not connected"
    // until its WebSocket opens. Retry until both lists land, and re-fetch on
    // the core "ready" event (covers reconnects), or the monitor dropdown and
    // audio device selects stay empty and look permanently disabled. Monitors
    // additionally fall back to Electron's own display enumeration so the
    // dropdown is usable even while the core is unavailable.
    let populated = false;
    const load = async () => {
      const [d, m, e] = await Promise.all([
        window.shard.invoke("audio.listDevices").catch(() => null),
        window.shard.invoke("capture.listMonitors").catch(() => null),
        window.shard.invoke("video.listEncoders").catch(() => null),
      ]);
      if (d) setDevices(d as AudioDeviceInfo[]);
      if (e) setVideoEncoders(e as VideoEncoderInfo[]);
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

  useEffect(() => {
    const resetVideo = videoEncoders.length > 0 && settings.video.encoder !== "auto" &&
      !videoEncoders.some((encoder) => encoder.id === settings.video.encoder);
    const resetExport = exportEncoders.length > 0 && settings.export.encoder !== "auto" &&
      !exportEncoders.some((encoder) => encoder.id === settings.export.encoder);
    if (!resetVideo && !resetExport) return;
    onChange({
      ...settings,
      video: resetVideo ? { ...settings.video, encoder: "auto" } : settings.video,
      export: resetExport ? { ...settings.export, encoder: "auto" } : settings.export,
    });
  }, [videoEncoders, exportEncoders, settings, onChange]);

  const patch = (p: Partial<Settings>) => onChange({ ...settings, ...p });
  const patchDeep = (section: "capture" | "video" | "replay" | "storage" | "app" | "export" | "audio", p: unknown) =>
    onChange({ ...settings, [section]: { ...(settings[section] as object), ...(p as object) } });

  return (
    <div className="page settings" ref={pageRef}>
      <aside className="settings__nav">
        <h1 className="page__title settings__title">Settings</h1>
        {NAV.map((s) => (
          <button key={s.id} type="button" className={active === s.id ? "nav__item settings__nav-item active" : "nav__item settings__nav-item"}
            aria-current={active === s.id ? "page" : undefined} onClick={() => setActive(s.id)}>
            <span className="ico"><Icon name={s.icon} size={15} /></span> {s.label}
          </button>
        ))}
      </aside>

      <div className="settings__content">
        <header className="page__head">
          <h2 className="page__title">{NAV.find((section) => section.id === active)?.label}</h2>
          <p className="dim page__sub">{SETTINGS_DESCRIPTIONS[active]}</p>
        </header>
        {active === "appearance" && (
          <AppearancePanel settings={settings} onChange={onChange} />
        )}
        {active === "capture" && (<CaptureSettingsPanel settings={settings} onChange={onChange} monitors={monitors} />)}

        {active === "video" && (
          <VideoSettingsPanel video={settings.video} encoders={videoEncoders}
            monitor={monitors.find((monitor) => monitor.index === settings.capture.monitor)}
            onChange={(video) => patch({ video })} />
        )}

        {active === "export" && (<ExportSettingsPanel settings={settings} onChange={onChange} encoders={exportEncoders} />)}

        {active === "audio" && (<div className="stack"><Card title="Recording audio" sub="Choose the sounds included in your clips."><AudioSourcesSettings sources={settings.audio.sources} devices={devices} onChange={sources => patchDeep("audio", { sources })} onCommit={sources => onCommit({ ...settings, audio: { ...settings.audio, sources } })} /></Card><ClipSoundSettings settings={settings} onChange={onChange} /></div>)}

        {active === "hotkeys" && <HotkeysSettings hotkeys={settings.hotkeys} onChange={hotkeys => patch({ hotkeys })} />}

        {active === "storage" && (<StorageSettingsPanel settings={settings} onChange={onChange} defaultFolder={defaultClipsFolder} />)}

        {active === "app" && <AppSettingsPanel settings={settings} onChange={onChange} version={version} />}
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
      <Card title="App theme" sub="Choose the colors and surfaces that feel right for you.">
        <div className="theme-grid" aria-label="Built-in themes">
          {builtin.map((theme) => (
            <button key={theme.id} type="button" aria-pressed={selected === theme.id}
              className="theme-option" onClick={() => void handleSelect(theme.id)}>
              <span className={"theme-option__preview theme-option__preview--" + theme.id} aria-hidden="true">
                <span className="theme-option__bar" /><span className="theme-option__sidebar" />
                <span className="theme-option__surface"><i /><i /><i /></span>
              </span>
              <span className="theme-option__label">{theme.name}
                {selected === theme.id && <Icon name="check" size={15} />}
              </span>
              <span className="theme-option__description">{theme.id === "oled" ? "Pure black surfaces" : theme.id === "midnight" ? "Deep navy, cool highlights" : "Charcoal with soft blue"}</span>
            </button>
          ))}
        </div>
        {loading && <p className="field__hint">Loading themes…</p>}
      </Card>
      <Card title="Custom themes" sub="Add your own colors and styles."
        actions={<Button size="sm" icon={<Icon name="refresh" size={14} />} onClick={() => void handleReload()}>Reload themes</Button>}>
        {custom.length > 0 && <div className="stack">
          {custom.map((theme) => (
            <button key={theme.id} type="button" className="theme-custom" aria-pressed={selected === theme.id}
              onClick={() => void handleSelect(theme.id)}>
              <span className="theme-custom__identity"><span className="setting-symbol"><Icon name="paintbrush" size={18} /></span><span><strong>{theme.name}</strong><span className="field__hint">{theme.description || (theme.author ? `Created by ${theme.author}` : "Custom color palette")}</span></span></span>
              {selected === theme.id && <Icon name="check" size={16} />}
            </button>
          ))}
        </div>}
        {!custom.length && <p className="field__hint">No custom themes installed.</p>}
        <div className="theme-folder">
          <Button icon={<Icon name="folder" size={15} />} onClick={() => void handleOpen()}>Open themes folder</Button>
          {themesDir && <span className="field__hint" title={themesDir}>{themesDir}</span>}
        </div>
        <details className="theme-help">
          <summary>Create a custom theme</summary>
          <p className="field__hint">Add a folder containing <code>theme.css</code> to your themes folder, then reload themes.
            See <code>docs/THEMES.md</code> for supported colors, spacing, and styles.</p>
          <p className="field__hint">Custom themes can load fonts and images from the internet. Only install themes you trust.</p>
        </details>
      </Card>
    </div>
  );
}
