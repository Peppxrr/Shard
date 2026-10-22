import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon, Toggle } from "./ui";
import { MAX_CAPTURE_SECONDS } from "../../shared/replay-policy";
import { formatDuration, parseDuration } from "../../shared/duration";

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

// Free-form duration ("90s", "5m", "1h 30m", "1:30"); commits on Enter or
// blur, clamps to the allowed range and redisplays in its compact form.
export function DurationControl({ label, seconds, min = 1, max = MAX_CAPTURE_SECONDS, onChange }: {
  label: string; seconds: number; min?: number; max?: number; onChange: (seconds: number) => void;
}) {
  const id = useId();
  const [draft, setDraftState] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  // Enter commits then blurs; the ref lets the following blur see it was handled.
  const pending = useRef<string | null>(null);
  const setDraft = (value: string | null) => { pending.current = value; setDraftState(value); };
  const commit = () => {
    const text = pending.current;
    if (text === null) return;
    const parsed = parseDuration(text);
    setDraft(null);
    setInvalid(parsed === null);
    if (parsed === null) return;
    const next = Math.min(max, Math.max(min, parsed));
    if (next !== seconds) onChange(next);
  };
  return <label data-shard-component="duration-control" data-unit={seconds >= 60 ? "min" : "sec"} data-shard-state={invalid ? "invalid" : undefined} className="number-control duration-control" htmlFor={id}
    title={`Type a length such as 30s, 5m or 1h 30m. Minimum ${formatDuration(min)}.`}>
    <span className="sr">{label}</span>
    <input id={id} type="text" inputMode="text" spellCheck={false} autoComplete="off" aria-invalid={invalid || undefined}
      value={draft ?? formatDuration(seconds)} onChange={event => { setDraft(event.target.value); setInvalid(false); }}
      onBlur={commit} onKeyDown={event => {
        if (event.key === "Enter") { commit(); event.currentTarget.blur(); }
        else if (event.key === "Escape") { setDraft(null); setInvalid(false); event.currentTarget.blur(); }
      }} />
  </label>;
}
