// ui.tsx — reusable design-system primitives for the Shard UI.
// Pure presentation over functionality; no business logic, no IPC.

import { useEffect } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/* ---------------------------------------------------------------------------
 * Icon — curated 24-grid stroke glyphs, currentColor, 16px default.
 * ------------------------------------------------------------------------- */
const GLYPH: Record<string, ReactNode> = {
  aperture: <><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 0 0 18M12 3a9 9 0 0 1 0 18M3.5 8.5h17M7.5 21l4.5-8M16.5 21l-4.5-8" /></>,
  record: <><circle cx="12" cy="12" r="5.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="9" /></>,
  stop: <><rect x="6" y="6" width="12" height="12" rx="2.2" fill="currentColor" stroke="none" /></>,
  play: <><path d="M8 6v12l9-6z" fill="currentColor" stroke="none" /></>,
  pause: <><rect x="8" y="6" width="3" height="12" rx="1" fill="currentColor" stroke="none" /><rect x="13" y="6" width="3" height="12" rx="1" fill="currentColor" stroke="none" /></>,
  scissor: <><circle cx="6" cy="6" r="2.5" /><path d="M7.8 7.8 20 20M7.8 16.2 20 4M6 6 20 20M6 18 20 4" /><circle cx="6" cy="18" r="2.5" /></>,
  folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  folderOpen: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H4z" /><path d="M3 10h19l-2 7a2 2 0 0 1-2 1.5H5A2 2 0 0 1 3 16z" /></>,
  trash: <><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2m-7 0v12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7" /></>,
  star: <><path d="m12 4 2.4 5 5.6.6-4 3.8 1 5.6-4.6-2.6L7.6 19l1-5.6-4-3.8 5.6-.6z" /></>,
  x: <><path d="M6 6l12 12M18 6 6 18" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  sliders: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="8" cy="18" r="2" /></>,
  gamepad: <><path d="M6 7h12a4 4 0 0 1 4 4v3a3 3 0 0 1-5.2 2l-1.3-1.4a2 2 0 0 0-3 0L11 16a3 3 0 0 1-5.2-2v-3a4 4 0 0 1 4-4Z" /><path d="M8 10v2M7 11h2M16 10h.01M15 12h.01" /></>,
  screen: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M9 21h6M12 17v4" /></>,
  games: <><path d="M7 9h10M7 13h10M9 7v8M15 7v8" /><rect x="4" y="4" width="16" height="16" rx="3" /></>,
  chevron: <><path d="m8 5 8 7-8 7" /></>,
  check: <><path d="m5 12 5 5 9-10" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  capture: <><circle cx="12" cy="13" r="4.5" /><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" /></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 19a2 2 0 0 0 4 0" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.6 0l2.4-2.4a4 4 0 0 0-5.6-5.6L11 7M14 10a4 4 0 0 0-5.6 0L6 12.4a4 4 0 0 0 5.6 5.6L13 17" /></>,
  power: <><path d="M12 3v9M6.5 6.5a8 8 0 1 0 11 0" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>,
};

export function Icon({ name, size = 16, className }: { name: keyof typeof GLYPH | string; size?: number; className?: string }) {
  const g = GLYPH[name] ?? GLYPH.aperture;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {g}
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Button
 * ------------------------------------------------------------------------- */
type ButtonVariant = "default" | "primary" | "ghost" | "soft" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: Size;
  icon?: ReactNode;
  iconRight?: ReactNode;
  block?: boolean;
  loading?: boolean;
}
export function Button({ variant = "default", size = "md", icon, iconRight, block, loading, className, children, disabled, type, ...rest }: ButtonProps) {
  const cls = ["btn", variant !== "default" && `btn--${variant}`, size !== "md" && `btn--${size}`, block && "btn--block", className]
    .filter(Boolean).join(" ");
  return (
    <button className={cls} type={type ?? "button"} disabled={disabled || loading} {...rest}>
      {loading && <span className="spin" style={{ width: 14, height: 14 }} />}
      {icon}
      {children}
      {iconRight}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost" | "danger";
  size?: Size;
  active?: boolean;
  label?: string; // sets both title + aria-label
}
export function IconButton({ variant = "ghost", size = "md", active, label, className, children, type, ...rest }: IconButtonProps) {
  const cls = ["btn", "btn--icon", variant !== "ghost" && `btn--${variant}`, size !== "md" && `btn--${size}`, className]
    .filter(Boolean).join(" ");
  return (
    <button className={cls} type={type ?? "button"} aria-pressed={active} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------------------
 * Toggle / Checkbox / Slider
 * ------------------------------------------------------------------------- */
export function Toggle({ checked, onChange, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; id?: string }) {
  return (
    <span className="toggle">
      <input type="checkbox" id={id} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle__track"><span className="toggle__thumb" /></span>
    </span>
  );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/* ---------------------------------------------------------------------------
 * Field wrapper
 * ------------------------------------------------------------------------- */
interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  inline?: boolean;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}
export function Field({ label, hint, inline, htmlFor, className, children }: FieldProps) {
  return (
    <div className={["field", inline && "field--inline", className].filter(Boolean).join(" ")}>
      {label && <label className="field__label" htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint && <div className="field__hint">{hint}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Segmented control
 * ------------------------------------------------------------------------- */
export function Segmented<T extends string>({ value, onChange, options, block }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  block?: boolean;
}) {
  return (
    <div className={["seg", block && "seg--block"].filter(Boolean).join(" ")}>
      {options.map((o) => (
        <button key={o.value} type="button" className="seg__item" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Card / Section
 * ------------------------------------------------------------------------- */
interface CardProps {
  title?: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  foot?: ReactNode;
  className?: string;
  flat?: boolean;
  hover?: boolean;
}
export function Card({ title, sub, icon, actions, children, foot, className, flat, hover }: CardProps) {
  return (
    <section className={["card", flat && "card--flat", hover && "card--hover", className].filter(Boolean).join(" ")}>
      {title && (
        <header className="card__head">
          <div>
            <div className="card__title">{icon}{title}</div>
            {sub && <div className="card__sub" style={{ marginTop: 2 }}>{sub}</div>}
          </div>
          {actions && <div style={{ display: "flex", gap: "var(--sp-2)" }}>{actions}</div>}
        </header>
      )}
      {children && <div className="card__body">{children}</div>}
      {foot && <footer className="card__foot">{foot}</footer>}
    </section>
  );
}

export function SectionTitle({ children, hint, actions }: { children: ReactNode; hint?: ReactNode; actions?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "var(--sp-3)", marginBottom: "var(--sp-4)" }}>
      <div>
        <h3 className="section-title">{children}</h3>
        {hint && <p className="section-sub" style={{ marginBottom: 0 }}>{hint}</p>}
      </div>
      {actions}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Modal
 * ------------------------------------------------------------------------- */
interface ModalProps {
  open: boolean;
  onClose?: () => void;
  title?: ReactNode;
  sub?: ReactNode;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
  foot?: ReactNode;
  closeOnBackdrop?: boolean;
}
export function Modal({ open, onClose, title, sub, size = "md", children, foot, closeOnBackdrop = true }: ModalProps) {
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={`modal modal--${size}`} onMouseDown={closeOnBackdrop && onClose ? onClose : undefined}>
      <div className="modal__panel" onMouseDown={(e) => e.stopPropagation()}>
        {(title || onClose) && (
          <header className="modal__head">
            <div>
              {title && <div className="modal__title">{title}</div>}
              {sub && <div className="modal__sub">{sub}</div>}
            </div>
            {onClose && <IconButton className="x" label="Close" onClick={onClose} children={<Icon name="x" size={18} />} />}
          </header>
        )}
        <div className="modal__body">{children}</div>
        {foot && <footer className="modal__foot">{foot}</footer>}
      </div>
    </div>
  );
}

interface ConfirmProps {
  open: boolean;
  title?: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}
export function Confirm({ open, title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Modal open={open} onClose={onCancel} size="sm" title={title}
      foot={<>
        <span className="spacer" />
        <Button onClick={onCancel}>{cancelLabel}</Button>
        <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
      </>}>
      <p className="dim" style={{ lineHeight: 1.6 }}>{message}</p>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
 * Toasts
 * ------------------------------------------------------------------------- */
export interface ToastItem {
  id: number;
  message: string;
  kind?: "info" | "error" | "ok";
}
export function Toasts({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={["toast", t.kind && `toast--${t.kind}`].filter(Boolean).join(" ")}>
          <span className="toast__ico">{t.kind === "error" ? "⚠" : t.kind === "ok" ? "✓" : "•"}</span>
          <span className="toast__msg">{t.message}</span>
          <IconButton size="sm" className="toast__x" label="Dismiss" onClick={() => onDismiss(t.id)} children={<Icon name="x" size={14} />} />
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Empty / Spinner / Tip
 * ------------------------------------------------------------------------- */
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty__art">{icon}</div>}
      <div className="empty__title">{title}</div>
      {children && <div className="empty__text">{children}</div>}
      {action}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spin" style={{ width: size, height: size }} />;
}

export function Tip({ tip, children }: { tip: string; children: ReactNode }) {
  return <span data-tip={tip}>{children}</span>;
}

export function StatusDot({ state = "idle" }: { state?: "live" | "rec" | "idle" }) {
  return <span className={`dot dot--${state}`} />;
}

/* Faceted "Shard" mark — a fragment of captured time. Brand gradient, cut-glass planes. */
export function Logo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="380 150 280 740" aria-label="Shard" role="img">
      <defs>
        <linearGradient id="shardLeft" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2c46c2" /><stop offset="1" stopColor="#3a55d4" /></linearGradient>
        <linearGradient id="shardMid" x1="0" y1="0" x2="0.2" y2="1"><stop offset="0" stopColor="#6aa6ff" /><stop offset="1" stopColor="#4f86f0" /></linearGradient>
        <linearGradient id="shardRight" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#9ec9ff" /><stop offset="1" stopColor="#6aa6ff" /></linearGradient>
        <clipPath id="shardClip"><path d="M550 168 L632 372 L612 690 L566 872 L476 866 L392 678 L410 372 Z" /></clipPath>
      </defs>
      <g clipPath="url(#shardClip)">
        <polygon points="550,168 410,372 392,678 476,866" fill="url(#shardLeft)" />
        <polygon points="550,168 476,866 566,872" fill="url(#shardMid)" />
        <polygon points="550,168 566,872 612,690 632,372" fill="url(#shardRight)" />
        <line x1="550" y1="168" x2="476" y2="866" stroke="#fff" strokeOpacity="0.16" strokeWidth="3" />
        <line x1="550" y1="168" x2="566" y2="872" stroke="#fff" strokeOpacity="0.10" strokeWidth="2" />
      </g>
      <path d="M550 168 L632 372 L612 690 L566 872" fill="none" stroke="#dcebff" strokeOpacity="0.6" strokeWidth="5" strokeLinejoin="round" />
      <path d="M550 168 L632 372 L612 690 L566 872 L476 866 L392 678 L410 372 Z" fill="none" stroke="#05070c" strokeOpacity="0.45" strokeWidth="2" />
    </svg>
  );
}