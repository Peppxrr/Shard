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
};

const MAX_LINES = 5000;

export function DevConsole() {
  const [lines, setLines] = useState<DevConsoleLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  // ring.stats fires every second and drowns the log — hidden by default.
  const [showRingStats, setShowRingStats] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return window.shard.onDevConsoleLine((line) => {
      setLines((prev) => [...prev.slice(-MAX_LINES), line]);
    });
  }, []);

  const visible = showRingStats ? lines : lines.filter((l) => !l.text.startsWith("ring.stats "));

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
        <Button size="sm" variant="ghost" onClick={() => setPaused((p) => !p)}>
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setLines([])}>Clear</Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(visible.map((l) => l.text).join("\n")).catch(() => {});
          }}
        >
          Copy
        </Button>
      </header>
      <div
        className="devconsole__scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
        }}
      >
        {visible.length === 0 && <div className="devconsole__empty">Waiting for core output…</div>}
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
