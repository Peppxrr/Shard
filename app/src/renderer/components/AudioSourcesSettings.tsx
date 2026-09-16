import type { CSSProperties } from "react";
import type { AudioDeviceInfo, Settings } from "../../shared/contracts";
import { Button, Icon, IconButton, ShardSelect, Toggle } from "./ui";
import { SettingRow } from "./SettingControls";
import { ProcessCombobox } from "./ProcessSelect";

type Source = Settings["audio"]["sources"][number];
export function AudioSourcesSettings({ sources, devices, onChange, onCommit }: {
  sources: Source[]; devices: AudioDeviceInfo[]; onChange: (sources: Source[]) => void; onCommit: (sources: Source[]) => void;
}) {
  const used = new Set(sources.filter(s => s.kind !== "process").map(s => s.id));
  const available = (kind: "output" | "input") => devices.filter(d => d.isInput === (kind === "input") && !used.has(d.id));
  const patch = (i: number, next: Partial<Source>) => onChange(sources.map((s, index) => index === i ? { ...s, ...next } : s));
  const add = (kind: Source["kind"]) => {
    const device = kind === "process" ? undefined : available(kind)[0];
    if (kind !== "process" && !device) return;
    onChange([...sources, { kind, id: device?.id ?? "", name: device?.name ?? "App audio", window: kind === "process" ? "::" : undefined, gain: 1, enabled: true }]);
  };
  return <div className="audio-sources">
    {!sources.length && <div className="audio-default"><span className="setting-symbol"><Icon name="volume" size={20} /></span><div><strong>Default desktop audio</strong><p>Sound from your default output is included automatically. Add sources to choose exactly what is recorded.</p></div></div>}
    {sources.map((s, i) => {
      const label = s.kind === "input" ? "Microphone" : s.kind === "output" ? "Desktop audio" : "App audio";
      const options = devices.filter(d => d.isInput === (s.kind === "input") && (d.id === s.id || !used.has(d.id))).map(d => ({ value: d.id, label: d.name }));
      if (!options.some(d => d.value === s.id)) options.unshift({ value: s.id, label: `${s.name || "Saved device"} (Unavailable)` });
      return <section className="audio-source" key={i}>
        <header className="audio-source__head"><Icon name={s.kind === "input" ? "mic" : "volume"} size={17} /><strong>{label}</strong><span className="spacer" /><label className="inline-switch"><span className="sr">Enable {label} {i + 1}</span><span>{s.enabled ? "On" : "Off"}</span><Toggle checked={s.enabled} onChange={enabled => onCommit(sources.map((item, index) => index === i ? { ...item, enabled } : item))} /></label><IconButton size="sm" variant="ghost" label={`Remove ${label} ${i + 1}`} onClick={() => onChange(sources.filter((_, index) => index !== i))}><Icon name="x" size={15} /></IconButton></header>
        <div className="audio-source__body"><SettingRow title={s.kind === "process" ? "Application" : "Device"}>
          {s.kind !== "process" ? <ShardSelect value={s.id} onChange={id => patch(i, { id, name: devices.find(d => d.id === id)?.name ?? id })} options={options} /> : <ProcessCombobox value={(s.window ?? "").replace(/^::?/, "").trim()} placeholder="Choose a running app" onChange={exe => {
            const normalized = exe.trim().toLowerCase(); patch(i, { window: normalized ? `::${normalized}` : "::", name: normalized ? `App: ${normalized}` : "App audio" });
          }} />}
        </SettingRow><SettingRow title="Volume" description={s.gain > 1 ? "Boosted above the original volume." : "100% keeps the original volume."}>
          <div className="source-volume"><input aria-label={`${label} ${i + 1} volume`} className="slider" type="range" min={0} max={2} step={0.05} value={s.gain} style={{ "--range-progress": `${s.gain * 50}%`, "--range-color": s.gain > 1 ? "var(--warn)" : "var(--accent)" } as CSSProperties} onChange={event => patch(i, { gain: Number(event.target.value) })} /><output className="num">{Math.round(s.gain * 100)}%</output></div>
        </SettingRow></div>
      </section>;
    })}
    <div className="source-add"><Button size="sm" disabled={!available("output").length} icon={<Icon name="plus" size={14} />} onClick={() => add("output")}>Desktop audio</Button><Button size="sm" disabled={!available("input").length} icon={<Icon name="plus" size={14} />} onClick={() => add("input")}>Microphone</Button><Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => add("process")}>App audio</Button></div>
    <p className="field__hint">Each source gets its own track. Turn off every configured source to record without audio.</p>
  </div>;
}
