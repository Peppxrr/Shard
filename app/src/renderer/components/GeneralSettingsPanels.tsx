import { useState } from "react";
import type { ExportEncoderInfo, MonitorInfo, Settings } from "../../shared/contracts";
import { Button, Card, Confirm, Icon, ShardSelect } from "./ui";
import { ChoiceCards, NumberControl, SettingRow, SwitchRow } from "./SettingControls";
import { UpdatesSettings } from "./UpdatesSettings";

type Props = { settings: Settings; onChange: (settings: Settings) => void };

export function CaptureSettingsPanel({ settings, onChange, monitors }: Props & { monitors: MonitorInfo[] }) {
  const capture = (next: Partial<Settings["capture"]>) => onChange({ ...settings, capture: { ...settings.capture, ...next } });
  const replay = (next: Partial<Settings["replay"]>) => onChange({ ...settings, replay: { ...settings.replay, ...next } });
  return <div className="stack"><Card title="Capture source" sub="Choose what appears in your clips.">
    <ChoiceCards label="Capture mode" value={settings.capture.mode} onChange={mode => capture({ mode })} options={[
      { value: "auto", label: "Auto", description: "Follow games, then return to desktop.", icon: "auto" },
      { value: "screen", label: "Desktop", description: "Always capture your chosen display.", icon: "monitor" },
      { value: "game", label: "Game only", description: "Capture games without your desktop.", icon: "box" },
    ]} />
    <SettingRow title="Display" description={settings.capture.mode === "game" ? "Not used in Game only mode." : "Used for desktop capture and Auto’s desktop fallback."}>
      <ShardSelect value={String(settings.capture.monitor)} onChange={value => capture({ monitor: Number(value) })} disabled={settings.capture.mode === "game" || !monitors.length}
        options={monitors.length ? monitors.map(m => ({ value: String(m.index), label: `${m.name} · ${m.width}×${m.height}${m.primary ? " (Primary)" : ""}` })) : [{ value: String(settings.capture.monitor), label: "Finding displays…" }]} />
    </SettingRow>
  </Card><Card title="Replay history" sub="Keep recent gameplay ready to save from memory.">
    <SettingRow title="Duration" description="The maximum history available to your save shortcut."><NumberControl label="Replay duration" value={settings.replay.maxSeconds} min={30} unit="sec" onChange={maxSeconds => replay({ maxSeconds })} /></SettingRow>
    <SettingRow title="Memory limit" description="A lower limit may shorten the available history."><NumberControl label="Replay memory limit" value={settings.replay.maxMb} min={256} unit="MB" onChange={maxMb => replay({ maxMb })} /></SettingRow>
    <p className="settings-note"><Icon name="disc" size={14} />Memory is released 15 seconds after capture stops.</p>
  </Card></div>;
}

export function ExportSettingsPanel({ settings, onChange, encoders }: Props & { encoders: ExportEncoderInfo[] }) {
  const patch = (next: Partial<Settings["export"]>) => onChange({ ...settings, export: { ...settings.export, ...next } });
  return <div className="stack"><Card title="Sharing defaults" sub="Starting values for your next export. Adjust them in the editor anytime.">
    <SettingRow title="File size limit" description="Exports must fit within this limit."><NumberControl label="Export size limit" value={settings.export.targetMb} min={1} max={100} unit="MB" onChange={targetMb => patch({ targetMb })} /></SettingRow>
    <SettingRow title="Resolution" description="Original keeps the clip’s dimensions. Size fitting may reduce them."><ShardSelect value={settings.export.resolution} onChange={resolution => patch({ resolution })} options={[{ value: "source", label: "Original" }, ...(["1080p", "720p", "480p", "360p"] as const).map(value => ({ value, label: value }))]} /></SettingRow>
  </Card><Card title="Export encoding" sub="Choose the encoder used to create shared clips.">
    <SettingRow title="Encoder" description={settings.export.encoder === "auto" ? "Uses supported GPU H.264, with CPU fallback." : "Only encoders supported on this computer are listed."}>
      <ShardSelect value={settings.export.encoder} onChange={encoder => patch({ encoder })} options={[{ value: "auto", label: "Automatic" }, ...encoders.map(e => ({ value: e.id, label: e.label }))]} />
    </SettingRow>
  </Card></div>;
}

export function StorageSettingsPanel({ settings, onChange, defaultFolder }: Props & { defaultFolder: string }) {
  const [error, setError] = useState("");
  const patch = (next: Partial<Settings["storage"]>) => onChange({ ...settings, storage: { ...settings.storage, ...next } });
  const folder = settings.storage.clipsDir.trim();
  const browse = async () => {
    try { setError(""); const next = await window.shard.pickClipsFolder(folder); if (next !== null) patch({ clipsDir: next }); }
    catch { setError("Could not open the folder picker. Please try again."); }
  };
  return <div className="stack"><Card title="Clip location" sub="Choose where new clips, recordings, and exports are saved.">
    <div className="folder-choice"><span className="folder-choice__icon"><Icon name="folder" size={22} /></span><div className="folder-choice__copy"><strong>{folder ? "Custom folder" : "Default folder"}</strong><span title={folder || defaultFolder}>{folder || defaultFolder || "App data folder"}</span></div><Button size="sm" onClick={() => void browse()}>Change folder</Button>{folder && <Button size="sm" variant="ghost" onClick={() => patch({ clipsDir: "" })}>Reset</Button>}</div>
    <p className="field__hint">Changing this folder keeps existing clips in your library.</p>{error && <p role="alert" className="form-error">{error}</p>}
  </Card><Card title="Automatic cleanup" sub="Manage storage without removing your favorites.">
    <SettingRow title="Storage limit" description="Oldest unprotected clips are deleted when this limit is reached."><NumberControl label="Storage limit" value={settings.storage.limitGb} min={1} max={1000} unit="GB" onChange={limitGb => patch({ limitGb })} /></SettingRow>
    <SwitchRow title="Include edited clips" description="Allow cleanup to remove unprotected editor exports too." checked={settings.storage.deleteEdited} onChange={deleteEdited => patch({ deleteEdited })} />
    <p className="settings-note"><Icon name="star" size={14} />Favorites are always kept and do not count toward this limit.</p>
  </Card></div>;
}

export function AppSettingsPanel({ settings, onChange, version }: Props & { version: string }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const patch = (next: Partial<Settings["app"]>) => onChange({ ...settings, app: { ...settings.app, ...next } });
  const restart = async () => {
    const next = { ...settings, app: { ...settings.app, hardwareAcceleration: pending! } };
    setPending(null);
    try { await window.shard.setSettings(next); onChange(next); await window.shard.restartApp(); }
    catch { setError("Could not restart. Save your changes and restart the app manually."); }
  };
  return <div className="stack"><Card title="Clip notifications" sub="Choose how the app lets you know a clip was saved.">
    <ChoiceCards label="Clip notification style" value={settings.app.notificationStyle} onChange={notificationStyle => patch({ notificationStyle })} options={[
      { value: "overlay", label: "Overlay", description: "A brief popup in the corner.", icon: "overlay" },
      { value: "windows", label: "Windows", description: "A notification when the app is hidden.", icon: "bell" },
      { value: "off", label: "Off", description: "Save without a visual notification.", icon: "bellOff" },
    ]} />
  </Card><Card title="Startup & background" sub="Keep capture available when you need it.">
    <SwitchRow title="Start with Windows" description="Open the app when you sign in." checked={settings.app.startWithWindows} onChange={startWithWindows => patch({ startWithWindows })} />
    <SwitchRow title="Keep running when closed" description="Closing the window sends the app to the system tray." checked={settings.app.minimizeToTray} onChange={minimizeToTray => patch({ minimizeToTray })} />
  </Card><Card title="Advanced" sub="Performance and troubleshooting options.">
    <SwitchRow title="Hardware acceleration" description="Use GPU acceleration for the app. Changing this requires a restart." checked={settings.app.hardwareAcceleration ?? true} onChange={setPending} />
    <SwitchRow title="Developer console" description="Show detailed logs in a separate window." checked={settings.app.developerConsole} onChange={developerConsole => patch({ developerConsole })} />
    {error && <p className="form-error" role="alert">{error}</p>}
  </Card><UpdatesSettings version={version} /><div className="settings-credits"><p>Icons by Feather (MIT) and Lucide (ISC). Licenses included with the app.</p></div>
    <Confirm open={pending !== null} title="Save and restart?" message="Your settings will be saved before the app restarts to apply hardware acceleration." confirmLabel="Save and restart" onConfirm={() => void restart()} onCancel={() => setPending(null)} />
  </div>;
}
