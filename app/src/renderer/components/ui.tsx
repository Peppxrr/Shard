// Shared UI primitives using original bundled Feather/Lucide SVG assets.
import { ICON_MARKUP } from "./iconAssets";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { THEME_CHANGE_EVENT, getThemeIconUrl } from "../themeManager";

/* ---------------------------------------------------------------------------
 * Icon — curated 24-grid stroke glyphs, currentColor, 16px default.
 * ------------------------------------------------------------------------- */
function useThemeIconUrl(token: string): string | null {
  const [url, setUrl] = useState<string | null>(() => getThemeIconUrl(token));
  useLayoutEffect(() => {
    const refresh = () => setUrl(getThemeIconUrl(token));
    refresh();
    window.addEventListener(THEME_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, refresh);
  }, [token]);
  return url;
}

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const token = String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-z0-9-_]/gi, "-")
    .toLowerCase();
  const customUrl = useThemeIconUrl(token);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const glyph = ICON_MARKUP[name] ?? ICON_MARKUP.question;
  if (customUrl && customUrl !== failedUrl) return <svg className={className} data-icon={token} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <image href={customUrl} onError={() => setFailedUrl(customUrl)} width="24" height="24" preserveAspectRatio="xMidYMid meet" />
  </svg>;
  return <svg className={className} data-icon={token} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: glyph }} />;
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
    <button data-shard-component="button" data-variant={variant ?? "default"} data-loading={!!loading} className={cls} type={type ?? "button"} disabled={disabled || loading} {...rest}>
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
    <button data-shard-component="icon-button" className={cls} type={type ?? "button"} aria-pressed={active} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------------------
 * Toggle / Checkbox / Slider
 * ------------------------------------------------------------------------- */
export function Toggle({ checked, onChange, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; id?: string }) {
  return (
    <span data-shard-component="toggle" data-checked={checked} className="toggle">
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
    <section data-shard-component="card" className={["card", flat && "card--flat", hover && "card--hover", className].filter(Boolean).join(" ")}>
      {title && (
        <header data-shard-slot="card-header" className="card__head">
          <div>
            <div className="card__title">{icon}{title}</div>
            {sub && <div className="card__sub">{sub}</div>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      {children && <div data-shard-slot="card-body" className="card__body">{children}</div>}
      {foot && <footer data-shard-slot="card-footer" className="card__foot">{foot}</footer>}
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
  size?: "sm" | "md" | "lg" | "full";
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
    <div data-shard-component="modal" className={`modal modal--${size}`} onMouseDown={closeOnBackdrop && onClose ? onClose : undefined}>
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
        <div data-shard-component="toast" data-shard-state={t.kind ?? "info"} key={t.id} className={["toast", t.kind && `toast--${t.kind}`].filter(Boolean).join(" ")}>
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
    <div data-shard-component="empty" className="empty">
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

/* ---------------------------------------------------------------------------
 * Popover / ContextMenu — viewport-aware positioning
 * ------------------------------------------------------------------------- */
export function ContextMenu({
  x,
  y,
  onClose,
  children,
  className,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    // Flip horizontally if overflow right
    if (left + rect.width + margin > vw) left = Math.max(margin, vw - rect.width - margin);
    if (left < margin) left = margin;
    // Flip vertically if overflow bottom — try above cursor first
    if (top + rect.height + margin > vh) {
      const above = y - rect.height - 8;
      if (above >= margin) top = above;
      else top = Math.max(margin, vh - rect.height - margin);
    }
    if (top < margin) top = margin;
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className={className ?? "editor-context"}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 200 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Shard Select — replaces native <select> with styled popover
 * ------------------------------------------------------------------------- */
export interface SelectOption<T extends string> {
  value: T;
  label: string;
}
export function ShardSelect<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  disabled,
  className,
  style,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.max(rect.width, 180);
    let left = rect.left;
    if (left + width + margin > vw) left = Math.max(margin, vw - width - margin);
    const spaceBelow = vh - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const wantBelow = Math.min(280, options.length * 36 + 8);
    let top: number;
    let maxHeight: number;
    if (spaceBelow >= Math.min(wantBelow, 200) || spaceBelow >= spaceAbove) {
      top = rect.bottom + 4;
      maxHeight = Math.min(wantBelow, spaceBelow);
    } else {
      maxHeight = Math.min(wantBelow, spaceAbove);
      top = rect.top - maxHeight - 4;
    }
    setPos({ left, top, width, maxHeight });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);
  return (
    <>
      <button
        data-shard-component="select"
        ref={btnRef}
        type="button"
        className={["shard-select", className].filter(Boolean).join(" ")}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={style}
        onPointerDown={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="shard-select__value">{selected?.label ?? placeholder ?? "Select"}</span>
        <span className="shard-select__chev"><Icon name="chevronDown" size={14} /></span>
      </button>
      {open && pos && (
        <div
          data-shard-component="select-menu"
          role="listbox"
          className="shard-select__menu"
          style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight, zIndex: 210 }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {options.map((o) => (
            <button
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={["shard-select__option", o.value === value && "is-selected"].filter(Boolean).join(" ")}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
