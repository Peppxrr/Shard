import { useEffect, useRef, useState } from "react";

export function KeyCaps({ value }: { value: string }) {
  return <span className="keycaps" aria-hidden="true">{value ? value.split("+").map((key, index) => <span className="keycaps__part" key={index}>
    {index > 0 && <span className="keycaps__plus">+</span>}<kbd>{key}</kbd>
  </span>) : <span className="keycaps__empty">Set shortcut</span>}</span>;
}

function normalized(value: string): string {
  return value.replace(/Control/gi, "Ctrl").toLowerCase().split("+").sort().join("+");
}

export function HotkeyInput({ value, label, used = [], onCommit }: {
  value: string; label: string; used?: string[]; onCommit: (accelerator: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!capturing) return;
    let disposed = false;
    setReady(false);
    buttonRef.current?.focus();
    void window.shard.suspendHotkeys().then(() => {
      if (!disposed) setReady(true);
    }).catch(() => { if (!disposed) setError("Could not listen for keys. Try again."); });
    return () => { disposed = true; void window.shard.resumeHotkeys(); };
  }, [capturing]);

  return <div className="shortcut__binding">
    <button ref={buttonRef} type="button" className={`hotkey__key${capturing ? " capturing" : ""}`}
      aria-label={capturing ? `Press keys for ${label}; Escape to cancel` : `Change shortcut for ${label}: ${value || "not assigned"}`}
      onClick={() => { setError(""); setCapturing(true); }} onBlur={() => { setCapturing(false); setError(""); }}
      onKeyDown={event => {
        if (!capturing) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === "Escape") { setCapturing(false); setError(""); return; }
        if (!ready || ["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;
        if (event.metaKey) { setError("Use Ctrl, Alt or Shift instead of the Windows key."); return; }
        const parts: string[] = [];
        if (event.ctrlKey) parts.push("Ctrl");
        if (event.altKey) parts.push("Alt");
        if (event.shiftKey) parts.push("Shift");
        const key = event.key === " " ? "Space" : event.key === "+" ? "Plus" : event.key.startsWith("Arrow") ? event.key.slice(5) : event.key.length === 1 ? event.key.toUpperCase() : event.key;
        parts.push(key);
        const accelerator = parts.join("+");
        if (used.some(other => normalized(other) === normalized(accelerator))) {
          setError("That combination is already assigned."); return;
        }
        onCommit(accelerator); setCapturing(false); setError("");
      }}>
      {capturing ? <span className="shortcut__listening">{ready ? "Press a key combination…" : "Getting ready…"}</span> : <KeyCaps value={value} />}
    </button>
    {error && <span className="shortcut__error" role="status">{error}</span>}
  </div>;
}
