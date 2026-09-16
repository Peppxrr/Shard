import { useEffect, useId, useState, type ReactNode } from "react";
import { Icon, Toggle } from "./ui";

export function SettingRow({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return <div className="setting-row"><div className="setting-row__copy"><h3>{title}</h3>{description && <p>{description}</p>}</div><div className="setting-row__control">{children}</div></div>;
}

export function SwitchRow({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="setting-row setting-row--switch"><span className="setting-row__copy"><strong>{title}</strong><span>{description}</span></span><Toggle checked={checked} onChange={onChange} /></label>;
}

export function ChoiceCards<T extends string>({ label, value, onChange, options }: {
  label: string; value: T; onChange: (value: T) => void;
  options: { value: T; label: string; description: string; icon?: string }[];
}) {
  return <div className="choice-cards" role="group" aria-label={label}>{options.map(option => <button key={option.value} type="button" className="quality-option" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
    {option.icon && <Icon name={option.icon} size={19} />}
    <span className="quality-option__name">{option.label}<span className="quality-option__check" aria-hidden="true">{value === option.value && <Icon name="check" size={12} />}</span></span>
    <span className="quality-option__description">{option.description}</span>
  </button>)}</div>;
}

// Incomplete values stay local; valid changes make the parent form dirty immediately.
export function NumberControl({ label, value, min, max = Number.MAX_SAFE_INTEGER, step = 1, unit, onChange }: {
  label: string; value: number; min: number; max?: number; step?: number; unit?: string; onChange: (value: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) { setDraft(String(value)); return; }
    const next = Math.min(max, Math.max(min, Number((Math.round(parsed / step) * step).toFixed(3))));
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return <label className="number-control" htmlFor={id}><span className="sr">{label}</span>
    <input id={id} type="number" min={min} max={max} step={step} value={draft} onChange={event => {
      const raw = event.target.value;
      setDraft(raw);
      const parsed = Number(raw);
      if (raw.trim() && Number.isFinite(parsed) && parsed >= min && parsed <= max && Math.abs(parsed / step - Math.round(parsed / step)) < 0.00001) onChange(parsed);
    }} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    {unit && <span className="number-control__unit" aria-hidden="true">{unit}</span>}
  </label>;
}
