import { useEffect, useState } from "react";
import type { HotkeyEntry, HotkeyStatus } from "../../shared/contracts";
import { Button, Card, Icon, IconButton, ShardSelect } from "./ui";
import { HotkeyInput } from "./HotkeyControls";
import { DurationControl } from "./SettingControls";
import { formatDurationLong } from "../../shared/duration";

export function HotkeysSettings({ hotkeys, onChange }: { hotkeys: HotkeyEntry[]; onChange: (hotkeys: HotkeyEntry[]) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  // Registration results for the saved shortcuts (e.g. ones Wayland cannot bind).
  const [statuses, setStatuses] = useState<HotkeyStatus[]>([]);
  useEffect(() => {
    let disposed = false;
    void window.shard.getHotkeyStatus().then(next => { if (!disposed) setStatuses(next); }).catch(() => {});
    const off = window.shard.onHotkeyStatus(setStatuses);
    return () => { disposed = true; off(); };
  }, []);
  const patch = (id: string, change: Partial<HotkeyEntry>) => onChange(hotkeys.map(hotkey => hotkey.id === id ? { ...hotkey, ...change } : hotkey));
  const add = () => {
    const id = `hotkey_${crypto.randomUUID()}`;
    onChange([...hotkeys, { id, label: "New shortcut", accelerator: "", action: "save_clip", durationSec: 60, durationUnit: "sec" }]);
    setExpanded(id);
  };
  return <div className="stack">
    <Card title="Keyboard shortcuts" sub="Capture a moment without leaving your game." className="shortcuts-card"
      actions={<Button icon={<Icon name="plus" size={15} />} onClick={add}>Add shortcut</Button>}>
      <div className="hotkeys">
        {hotkeys.map(hotkey => {
          const open = expanded === hotkey.id;
          const label = hotkey.label.trim() || "Untitled shortcut";
          const seconds = hotkey.durationSec && hotkey.durationSec > 0 ? hotkey.durationSec : 60;
          const duration = formatDurationLong(seconds);
          return <section className={`hotkey${open ? " is-expanded" : ""}`} key={hotkey.id} aria-label={label}>
            <div className="shortcut__summary">
              <span className="shortcut__icon"><Icon name={hotkey.action === "save_clip" ? "save" : "record"} size={18} /></span>
              <div className="shortcut__identity"><strong>{label}</strong><span>{hotkey.action === "save_clip" ? `Save the last ${duration}` : "Start or stop recording"}</span></div>
              <HotkeyInput value={hotkey.accelerator} label={label} used={hotkeys.filter(other => other.id !== hotkey.id).map(other => other.accelerator)} onCommit={accelerator => patch(hotkey.id, { accelerator })}
                status={statuses.find(status => status.id === hotkey.id && status.accelerator === hotkey.accelerator && !status.ok)?.error} />
              <div className="shortcut__actions">
                <IconButton label={`${open ? "Close details for" : "Edit"} ${label}`} active={open} aria-expanded={open} onClick={() => setExpanded(open ? null : hotkey.id)}><Icon name={open ? "chevron" : "edit"} size={16} /></IconButton>
                <IconButton variant="danger" label={`Remove ${label}`} onClick={() => onChange(hotkeys.filter(other => other.id !== hotkey.id))}><Icon name="trash" size={16} /></IconButton>
              </div>
            </div>
            {open && <div className="shortcut__details">
              <label className="shortcut__field shortcut__field--name"><span>Name</span><input className="input" aria-label={`Name for ${label}`} value={hotkey.label} placeholder="Name this shortcut" onChange={event => patch(hotkey.id, { label: event.target.value })} /></label>
              <div className="shortcut__field"><span>Action</span><ShardSelect ariaLabel={`Action for ${label}`} value={hotkey.action} options={[{ value: "save_clip", label: "Save clip" }, { value: "toggle_record", label: "Toggle recording" }]}
                onChange={action => patch(hotkey.id, { action: action as HotkeyEntry["action"] })} /></div>
              {hotkey.action === "save_clip" && <div className="shortcut__field"><span>Clip length</span><DurationControl label={`Clip length for ${label}`} seconds={seconds} onChange={durationSec => patch(hotkey.id, { durationSec })} /></div>}
            </div>}
          </section>;
        })}
        {!hotkeys.length && <div className="shortcuts-empty"><Icon name="key" size={28} /><strong>No shortcuts yet</strong><p>Add a shortcut to save clips or toggle recording from any app.</p><Button onClick={add} icon={<Icon name="plus" size={15} />}>Add your first shortcut</Button></div>}
      </div>
    </Card>
    <p className="settings-note"><Icon name="question" size={15} />Click a key combination to change it. Use Ctrl, Alt or Shift; press Escape to cancel.</p>
  </div>;
}
