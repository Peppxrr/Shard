import { useEffect, useRef, useState } from "react";
import type { AudioDeviceInfo, ExportEncoderInfo, MonitorInfo, Settings, VideoEncoderInfo } from "../../shared/contracts";
import { Button, Card, Icon, IconButton, ShardSelect } from "./ui";
import { VideoSettingsPanel } from "./VideoSettingsPanel";
import { ClipSoundSettings } from "./ClipSoundSettings";
import { CaptureSettingsPanel, ExportSettingsPanel, StorageSettingsPanel, AppSettingsPanel } from "./GeneralSettingsPanels";
import { AudioSourcesSettings } from "./AudioSourcesSettings";
import { HotkeysSettings } from "./HotkeysSettings";
import { AppearancePanel } from "./AppearancePanel";

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
    <div data-shard-page="settings" data-shard-section={active} className="page settings" ref={pageRef}>
      <aside data-shard-slot="settings-navigation" className="settings__nav">
        <h1 className="page__title settings__title">Settings</h1>
        {NAV.map((s) => (
          <button key={s.id} type="button" className={active === s.id ? "nav__item settings__nav-item active" : "nav__item settings__nav-item"}
            aria-current={active === s.id ? "page" : undefined} onClick={() => setActive(s.id)}>
            <span className="ico"><Icon name={s.icon} size={15} /></span> {s.label}
          </button>
        ))}
      </aside>

      <div data-shard-slot="settings-content" className="settings__content">
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
