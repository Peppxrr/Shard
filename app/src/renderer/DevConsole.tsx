// DevConsole.tsx — the developer console window content (loaded via #console).
// Streams core stderr, RPC failures, and key core events live from the main
// process. Toolbar: pause, clear, copy-all. Dark monospace log with
// level-colored prefixes and a timestamp per line.
import { useEffect, useRef, useState } from "react";
import type { DevConsoleLine } from "../shared/contracts";
import { Button, Icon } from "./components/ui";

const LEVEL_CLASS: Record<DevConsoleLine["level"], string> = {
  core: "dcl--core",
  app: "dcl--app",
  rpc: "dcl--rpc",
  event: "dcl--event",
  updates: "dcl--updates",
};

const MAX_LINES = 5000;

export function DevConsole() {
  const [lines, setLines] = useState<DevConsoleLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  // ring.stats fires every second and drowns the log — hidden by default.
  const [showRingStats, setShowRingStats] = useState(false);
  const [source, setSource] = useState("all");
  const [query, setQuery] = useState("");
  const [frozen, setFrozen] = useState<DevConsoleLine[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const off = window.shard.onDevConsoleLine((line) => {
      setLines((prev) => [...prev.slice(-(MAX_LINES - 1)), line]);
    });
    void window.shard.getDevConsoleHistory().then(history => {
      if (active) setLines(current => [...new Map([...history, ...current].map(line => [line.id, line])).values()].slice(-MAX_LINES));
    }).catch(() => {});
    return () => { active = false; off(); };
  }, []);

  const visible = (paused ? frozen : lines).filter(line => (showRingStats || !line.text.startsWith("ring.stats ")) &&
    (source === "all" || line.level === source) && line.text.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    const el = scrollRef.current;
    if (el && autoScroll) el.scrollTop = el.scrollHeight;
  }, [visible, autoScroll]);

  return (
    <div className="devconsole">
      <header className="devconsole__bar">
        <span className="devconsole__title"><Icon name="terminal" size={13} /> Shard Developer Console</span>
        <span className="spacer" />
        <label className="devconsole__filter" title="ring.stats is emitted once per second">
          <input type="checkbox" checked={showRingStats} onChange={(e) => setShowRingStats(e.target.checked)} />
          ring.stats
        </label>
        <Button size="sm" variant="ghost" onClick={() => { if (!paused) setFrozen(lines); setPaused(!paused); }}>
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setLines([]); setFrozen([]); }}>Clear</Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(visible.map((l) => `${new Date(l.t).toISOString()} [${l.level}] ${l.text}`).join("\n")).catch(() => {});
          }}
        >
          Copy
        </Button>
      </header>
      <div className="devconsole__searchbar">
        <select className="select" aria-label="Log source" value={source} onChange={event => setSource(event.target.value)}>
          <option value="all">All sources</option><option value="updates">Updates</option><option value="core">Capture core</option>
          <option value="app">App</option><option value="rpc">RPC</option><option value="event">Events</option>
        </select>
        <input className="input" type="search" aria-label="Filter log messages" placeholder="Filter messages…" value={query} onChange={event => setQuery(event.target.value)}/>
      </div>
      <div
        className="devconsole__scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
        }}
      >
        {visible.length === 0 && <div className="devconsole__empty">{lines.length ? "No messages match these filters." : "Waiting for log messages…"}</div>}
        {visible.map((l, i) => (
          <div key={i} className="devconsole__line">
            <span className="devconsole__time">{new Date(l.t).toLocaleTimeString()}</span>
            <span className={`devconsole__lvl ${LEVEL_CLASS[l.level]}`}>{l.level}</span>
            <span className="devconsole__text">{l.text}</span>
          </div>
        ))}
      </div>
      <footer className="devconsole__foot">
        <span className="devconsole__count num">{visible.length} lines</span>
        <span className="devconsole__live num">{paused ? "paused" : "live"}</span>
      </footer>
    </div>
  );
}
