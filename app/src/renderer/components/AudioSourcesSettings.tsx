import type { CSSProperties } from "react";
import type { AudioDeviceInfo, Settings } from "../../shared/contracts";
import { Button, Icon, IconButton, ShardSelect, Toggle } from "./ui";
import { ProcessCombobox } from "./ProcessSelect";
import { useAppIcons } from "../app-icons";

type Source = Settings["audio"]["sources"][number];
const KIND: Record<Source["kind"], { label: string; icon: string }> = {
  output: { label: "Desktop audio", icon: "volume" },
  input: { label: "Microphone", icon: "mic" },
  process: { label: "App audio", icon: "monitor" },
};

const appExe = (source: Source) => (source.window ?? "").replace(/^::?/, "").trim().toLowerCase();

// One dense row per track so long source lists stay scannable.
export function AudioSourcesSettings({ sources, devices, onChange, onCommit }: {
  sources: Source[]; devices: AudioDeviceInfo[]; onChange: (sources: Source[]) => void; onCommit: (sources: Source[]) => void;
}) {
  const appArt = useAppIcons(sources.filter(s => s.kind === "process").map(appExe));
  const used = new Set(sources.filter(s => s.kind !== "process").map(s => s.id));
  const available = (kind: "output" | "input") => devices.filter(d => d.isInput === (kind === "input") && !used.has(d.id));
  const patch = (i: number, next: Partial<Source>) => onChange(sources.map((s, index) => index === i ? { ...s, ...next } : s));
  const commit = (i: number, next: Partial<Source>) => onCommit(sources.map((s, index) => index === i ? { ...s, ...next } : s));
  const add = (kind: Source["kind"]) => {
    const device = kind === "process" ? undefined : available(kind)[0];
    if (kind !== "process" && !device) return;
    onChange([...sources, { kind, id: device?.id ?? "", name: device?.name ?? "App audio", window: kind === "process" ? "::" : undefined, excludeFromDesktop: kind === "process" ? true : undefined, gain: 1, enabled: true }]);
  };
  return <div className="audio-sources">
    {!sources.length && <div className="audio-default"><span className="setting-symbol"><Icon name="volume" size={20} /></span><div><strong>Default desktop audio</strong><p>Sound from your default output is included automatically. Add sources to choose exactly what is recorded.</p></div></div>}
    {sources.length > 0 && <ul data-shard-slot="audio-source-list" className="audio-source-list">{sources.map((s, i) => {
      const { label, icon } = KIND[s.kind];
      const name = `${label} ${i + 1}`;
      const art = s.kind === "process" ? appArt.get(appExe(s)) : undefined;
      const options = devices.filter(d => d.isInput === (s.kind === "input") && (d.id === s.id || !used.has(d.id))).map(d => ({ value: d.id, label: d.name }));
      if (!options.some(d => d.value === s.id)) options.unshift({ value: s.id, label: `${s.name || "Saved device"} (Unavailable)` });
      return <li data-shard-component="audio-source" data-kind={s.kind} data-shard-state={s.enabled ? "on" : "off"} className="audio-source" key={i}>
        <span className="audio-source__kind" data-shard-state={art ? "image" : "fallback"} title={`Track ${i + 1} · ${label}`}>{art ? <img src={art} alt="" draggable={false} /> : <Icon name={icon} size={16} />}</span>
        <div className="audio-source__target">
          <span className="audio-source__label">{label}</span>
          {s.kind !== "process" ? <ShardSelect ariaLabel={`${name} device`} value={s.id} onChange={id => patch(i, { id, name: devices.find(d => d.id === id)?.name ?? id })} options={options} /> : <ProcessCombobox value={appExe(s)} placeholder="Choose a running app" style={{ flex: "0 0 auto" }} onChange={exe => {
            const normalized = exe.trim().toLowerCase(); patch(i, { window: normalized ? `::${normalized}` : "::", name: normalized ? `App: ${normalized}` : "App audio" });
          }} />}
        </div>
        <div className="source-volume" title={`${s.gain > 1 ? "Boosted above the original volume." : "100% keeps the original volume."} Double-click to reset to 100%.`}>
          <input aria-label={`${name} volume`} className="slider" type="range" min={0} max={2} step={0.05} value={s.gain} style={{ "--range-progress": `${s.gain * 50}%`, "--range-color": s.gain > 1 ? "var(--warn)" : "var(--accent)" } as CSSProperties} onChange={event => patch(i, { gain: Number(event.target.value) })} onDoubleClick={() => patch(i, { gain: 1 })} />
          <output className="num" data-boosted={s.gain > 1 || undefined}>{Math.round(s.gain * 100)}%</output>
        </div>
        <div className="audio-source__actions">
          <label className="inline-switch"><span className="sr">Enable {name}</span><Toggle checked={s.enabled} onChange={enabled => commit(i, { enabled })} /></label>
          <IconButton size="sm" variant="ghost" label={`Remove ${name}`} onClick={() => onChange(sources.filter((_, index) => index !== i))}><Icon name="x" size={15} /></IconButton>
        </div>
      </li>;
    })}</ul>}
    <div className="source-add"><Button size="sm" variant="ghost" disabled={!available("output").length} icon={<Icon name="plus" size={14} />} onClick={() => add("output")}>Desktop audio</Button><Button size="sm" variant="ghost" disabled={!available("input").length} icon={<Icon name="plus" size={14} />} onClick={() => add("input")}>Microphone</Button><Button size="sm" variant="ghost" icon={<Icon name="plus" size={14} />} onClick={() => add("process")}>App audio</Button></div>
    <p className="field__hint">Each source gets its own track. Turn off every configured source to record without audio.</p>
  </div>;
}
