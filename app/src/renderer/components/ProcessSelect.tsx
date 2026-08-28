import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

interface ProcessEntry { exe: string; pid: number; title: string }

function useProcesses(open: boolean) {
  const [entries, setEntries] = useState<ProcessEntry[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    window.shard.listProcesses().then((list) => {
      if (cancelled) return;
      setEntries(list);
    }).catch(() => {
      if (!cancelled) setEntries([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open]);
  return { entries, loading };
}

export function ProcessCombobox({
  value,
  onChange,
  placeholder = "search process…",
  style,
}: {
  value: string;
  onChange: (exe: string) => void;
  placeholder?: string;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const { entries, loading } = useProcesses(open);

  useEffect(() => setQuery(value), [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.exe.toLowerCase().includes(q) || e.title.toLowerCase().includes(q));
  }, [entries, query]);

  const visibleCount = Math.min(5, filtered.length);
  const wantHeight = Math.min(180, filtered.length * 36 + 8);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.max(rect.width, 220);
    let left = rect.left;
    if (left + width + margin > vw) left = Math.max(margin, vw - width - margin);
    const spaceBelow = vh - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    let top: number;
    let maxHeight: number;
    if (spaceBelow >= Math.min(wantHeight, 120) || spaceBelow >= spaceAbove) {
      top = rect.bottom + 4;
      maxHeight = Math.min(wantHeight, spaceBelow);
    } else {
      maxHeight = Math.min(wantHeight, spaceAbove);
      top = rect.top - maxHeight - 4;
    }
    // Ensure maxHeight shows at most 5 rows, but not more than available
    maxHeight = Math.min(maxHeight, 180);
    if (filtered.length === 0) maxHeight = 60;
    setPos({ left, top, width, maxHeight });
  }, [open, filtered.length, wantHeight]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (anchorRef.current?.contains(target)) return;
      // allow clicks inside menu
      const menu = document.getElementById("process-combobox-menu");
      if (menu?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", () => setOpen(false));
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", () => setOpen(false));
    };
  }, [open]);

  const commit = (exe: string) => {
    const normalized = exe.trim().toLowerCase();
    if (!normalized) return;
    const finalExe = normalized.endsWith(".exe") ? normalized : normalized + ".exe";
    onChange(finalExe);
    setQuery(finalExe);
    setOpen(false);
  };

  return (
    <div ref={anchorRef} style={{ position: "relative", flex: "1 1 200px", minWidth: 0, ...style }}>
      <input
        ref={inputRef}
        className="input"
        placeholder={placeholder}
        value={query}
        onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (filtered.length === 1) commit(filtered[0].exe);
            else if (query.trim()) commit(query.trim());
          } else if (e.key === "Escape") {
            setOpen(false);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "ArrowDown" && !open) {
            setOpen(true);
          }
        }}
        style={{ width: "100%" }}
      />
      {open && pos && (
        <div
          id="process-combobox-menu"
          role="listbox"
          className="shard-select__menu"
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            width: pos.width,
            maxHeight: pos.maxHeight,
            zIndex: 210,
            overflowY: "auto",
            overflowX: "hidden",
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {loading ? (
            <div className="field__hint" style={{ padding: "10px 12px" }}>Loading processes…</div>
          ) : filtered.length === 0 ? (
            <div className="field__hint" style={{ padding: "10px 12px" }}>
              {query.trim() ? `No match for "${query.trim()}" — press Enter to use it` : "No processes found"}
            </div>
          ) : (
            filtered.slice(0, 100).map((p) => (
              <button
                key={p.exe}
                role="option"
                className="shard-select__option"
                style={{ justifyContent: "space-between" }}
                onClick={() => commit(p.exe)}
              >
                <span className="mono" style={{ fontSize: 12 }}>{p.exe}</span>
                {p.title ? <span className="field__hint" style={{ fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginLeft: 8 }}>{p.title}</span> : null}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function ProcessPickerButton({ onPick, label = "Pick running" }: { onPick: (exe: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const [query, setQuery] = useState("");
  const { entries, loading } = useProcesses(open);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.exe.toLowerCase().includes(q) || e.title.toLowerCase().includes(q));
  }, [entries, query]);

  const wantHeight = Math.min(180, filtered.length * 36 + 40); // + search

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = 320;
    let left = rect.left;
    if (left + width + margin > vw) left = Math.max(margin, vw - width - margin);
    const spaceBelow = vh - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    let top: number;
    let maxHeight: number;
    if (spaceBelow >= Math.min(wantHeight, 120) || spaceBelow >= spaceAbove) {
      top = rect.bottom + 4;
      maxHeight = Math.min(wantHeight, spaceBelow);
    } else {
      maxHeight = Math.min(wantHeight, spaceAbove);
      top = rect.top - maxHeight - 4;
    }
    maxHeight = Math.min(maxHeight, 180);
    setPos({ left, top, width, maxHeight });
  }, [open, filtered.length, wantHeight]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (btnRef.current?.contains(target)) return;
      const menu = document.getElementById("process-picker-menu");
      if (menu?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", () => setOpen(false));
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", () => setOpen(false));
    };
  }, [open]);

  return (
    <>
      <button ref={btnRef} type="button" className="btn" onClick={() => setOpen((v) => !v)}>{label}</button>
      {open && pos && (
        <div
          id="process-picker-menu"
          className="shard-select__menu"
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            width: pos.width,
            maxHeight: pos.maxHeight,
            zIndex: 210,
            overflowY: "auto",
            padding: 4,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <input
            className="input"
            placeholder="Search processes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            style={{ height: 32, fontSize: 12 }}
          />
          <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
            {loading ? (
              <div className="field__hint" style={{ padding: "8px" }}>Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="field__hint" style={{ padding: "8px" }}>No matches</div>
            ) : (
              filtered.slice(0, 100).map((p) => (
                <button
                  key={p.exe}
                  className="shard-select__option"
                  style={{ justifyContent: "space-between" }}
                  onClick={() => { onPick(p.exe); setOpen(false); setQuery(""); }}
                >
                  <span className="mono" style={{ fontSize: 12 }}>{p.exe}</span>
                  {p.title ? <span className="field__hint" style={{ fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginLeft: 8 }}>{p.title}</span> : null}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
