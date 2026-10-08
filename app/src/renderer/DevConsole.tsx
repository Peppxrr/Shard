import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  devConsoleSeverity,
  devConsoleSource,
  filterDevConsoleLines,
  serializeDevConsoleLines,
  type DevConsoleFilter,
  type DevConsoleSeverity,
} from "../shared/dev-console";
import type { DevConsoleLine } from "../shared/contracts";
import { Button, Icon, ShardSelect } from "./components/ui";

const HISTORY_LIMIT = 20_000;
const PAGE_SIZE = 500;
const FILTER_STORAGE_KEY = "shard:dev-console-filters:v1";
const SEVERITIES: DevConsoleSeverity[] = ["debug", "info", "warn", "error"];
const SOURCES = [
  { value: "all", label: "All sources" },
  { value: "core", label: "Capture core" },
  { value: "core.stdout", label: "Core · stdout" },
  { value: "core.stderr", label: "Core · stderr" },
  { value: "app", label: "App" },
  { value: "rpc", label: "RPC" },
  { value: "event", label: "Events" },
  { value: "updates", label: "Updates" },
];

interface ConsolePreferences extends DevConsoleFilter {
  includeRingStats: boolean;
}

type HistoryState = "loading" | "ready" | "error";
type BusyAction = "clear" | "copy" | "export" | null;
type Feedback = { kind: "info" | "error"; message: string } | null;

const DEFAULT_PREFERENCES: ConsolePreferences = {
  source: "all",
  severity: "all",
  query: "",
  includeRingStats: false,
};

function readPreferences(): ConsolePreferences {
  try {
    const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<ConsolePreferences>;
    return {
      source: SOURCES.some(source => source.value === parsed.source) ? parsed.source! : "all",
      severity: parsed.severity === "all" || SEVERITIES.includes(parsed.severity as DevConsoleSeverity)
        ? parsed.severity!
        : "all",
      query: typeof parsed.query === "string" ? parsed.query : "",
      includeRingStats: parsed.includeRingStats === true,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function compareLines(a: DevConsoleLine, b: DevConsoleLine): number {
  const byTime = (a.t || 0) - (b.t || 0);
  if (byTime) return byTime;
  const aId = a.id ?? 0;
  const bId = b.id ?? 0;
  return aId < 0 || bId < 0 ? Math.abs(aId) - Math.abs(bId) : aId - bId;
}

function mergeLines(lines: DevConsoleLine[], additions: DevConsoleLine[]): DevConsoleLine[] {
  const merged = new Map<number, DevConsoleLine>();
  for (const line of [...lines, ...additions]) {
    if (line.id === 0 || !Number.isSafeInteger(line.id)) continue;
    merged.set(line.id!, line);
  }
  return [...merged.values()].sort(compareLines).slice(-HISTORY_LIMIT);
}

function countLabel(value: number): string {
  return new Intl.NumberFormat(window.shard.regionalLocale).format(value);
}

function countWithNoun(value: number, singular: string, plural = `${singular}s`): string {
  return `${countLabel(value)} ${value === 1 ? singular : plural}`;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function sourceLabel(line: DevConsoleLine): string {
  const source = devConsoleSource(line);
  return source === "core.stdout" ? "Core · stdout"
    : source === "core.stderr" ? "Core · stderr"
          : SOURCES.find(option => option.value === source)?.label ?? source;
}

export function DevConsole() {
  const [lines, setLines] = useState<DevConsoleLine[]>([]);
  const linesRef = useRef<DevConsoleLine[]>([]);
  const [pausedLines, setPausedLines] = useState<DevConsoleLine[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [overflowNotice, setOverflowNotice] = useState<DevConsoleLine | null>(null);
  const [historyState, setHistoryState] = useState<HistoryState>("loading");
  const [historyError, setHistoryError] = useState("");
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [preferences, setPreferences] = useState<ConsolePreferences>(readPreferences);
  const [pageAnchorId, setPageAnchorId] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [clipboardAvailable, setClipboardAvailable] = useState(false);
  const filteredListRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingLinesRef = useRef<DevConsoleLine[]>([]);
  const batchTimerRef = useRef<number | null>(null);
  const clearBoundaryRef = useRef(0);
  const historyRequestRef = useRef(0);
  const syntheticIdRef = useRef(-1);

  const flushPending = useCallback(() => {
    if (batchTimerRef.current !== null) {
      window.clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    const pending = pendingLinesRef.current.splice(0).filter(line =>
      typeof line.id === "number" && line.id !== 0 && (line.id < 0 || line.id > clearBoundaryRef.current)
    );
    if (!pending.length) return;
    const next = mergeLines(linesRef.current, pending);
    linesRef.current = next;
    if (!pausedRef.current) setLines(next);
  }, []);

  const loadHistory = useCallback(async () => {
    const request = ++historyRequestRef.current;
    setHistoryState("loading");
    setHistoryError("");
    try {
      const history = await window.shard.getDevConsoleHistory();
      if (request !== historyRequestRef.current) return;
      const notice = history.find(line => line.id === 0) ?? null;
      const retained = history.filter(line =>
        line.id !== 0 && Number.isSafeInteger(line.id) && line.id! > clearBoundaryRef.current
      );
      const next = mergeLines(retained, linesRef.current);
      linesRef.current = next;
      if (pausedRef.current) {
        setPausedLines(current => mergeLines(retained, current));
      } else {
        setLines(next);
      }
      setOverflowNotice(notice);
      setHistoryState("ready");
    } catch (error) {
      if (request !== historyRequestRef.current) return;
      setHistoryError(error instanceof Error ? error.message : "Could not load the saved console history.");
      setHistoryState("error");
    }
  }, []);

  useEffect(() => setClipboardAvailable(Boolean(navigator.clipboard?.writeText)), []);

  useEffect(() => {
    const off = window.shard.onDevConsoleLine(line => {
      if (line.id === 0) {
        setOverflowNotice(line);
        return;
      }
      const stableLine = Number.isSafeInteger(line.id) ? line : { ...line, id: syntheticIdRef.current-- };
      pendingLinesRef.current.push(stableLine);
      if (batchTimerRef.current === null) {
        batchTimerRef.current = window.setTimeout(flushPending, 100);
      }
    });
    void loadHistory();
    return () => {
      off();
      historyRequestRef.current++;
      if (batchTimerRef.current !== null) window.clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    };
  }, [flushPending, loadHistory]);

  useEffect(() => {
    try {
      window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // The current filter state remains available for this window.
    }
  }, [preferences]);

  useEffect(() => {
    setPageAnchorId(null);
  }, [preferences]);

  const shownLines = paused ? pausedLines : lines;
  const filteredLines = useMemo(() => {
    const matches = filterDevConsoleLines(shownLines, preferences);
    return preferences.includeRingStats ? matches : matches.filter(line => !line.text.startsWith("ring.stats "));
  }, [shownLines, preferences]);
  const pageAnchorIndex = pageAnchorId === null
    ? -1
    : filteredLines.findIndex(line => line.id === pageAnchorId);
  const firstIndex = pageAnchorIndex >= 0 ? pageAnchorIndex : Math.max(0, filteredLines.length - PAGE_SIZE);
  const pageEnd = Math.min(filteredLines.length, firstIndex + PAGE_SIZE);
  const pageLines = filteredLines.slice(firstIndex, pageEnd);
  const olderCount = firstIndex;
  const firstVisible = pageLines.length ? firstIndex + 1 : 0;
  const hasNewer = pageEnd < filteredLines.length;
  const pageState = historyState === "error" ? "error"
    : historyState === "loading" && shownLines.length === 0 ? "loading"
      : "ready";
  const actionState = busyAction === "clear" ? "clearing"
    : busyAction === "copy" ? "copying"
      : busyAction === "export" ? "exporting"
        : "idle";

  useEffect(() => {
    const element = filteredListRef.current;
    const filtersOpen = document.querySelector('[data-shard-slot="console-controls"] :popover-open');
    if (element && autoScroll && !paused && pageAnchorId === null && !filtersOpen) {
      element.scrollTop = element.scrollHeight;
    }
  }, [pageLines, autoScroll, paused, pageAnchorId]);

  useEffect(() => {
    if (pageAnchorId !== null && pageAnchorIndex < 0) {
      setPageAnchorId(null);
      setAutoScroll(true);
    }
  }, [pageAnchorId, pageAnchorIndex]);

  const updatePreference = <K extends keyof ConsolePreferences>(key: K, value: ConsolePreferences[K]) => {
    setPreferences(current => ({ ...current, [key]: value }));
    setFeedback(null);
  };

  const togglePause = () => {
    if (pausedRef.current) {
      pausedRef.current = false;
      setPaused(false);
      setPausedLines([]);
      flushPending();
      setLines(linesRef.current);
    } else {
      flushPending();
      pausedRef.current = true;
      setPausedLines(linesRef.current);
      setPaused(true);
    }
  };

  const clearHistory = async () => {
    setBusyAction("clear");
    setFeedback(null);
    try {
      const boundary = await window.shard.clearDevConsoleHistory();
      clearBoundaryRef.current = Math.max(clearBoundaryRef.current, boundary);
      historyRequestRef.current++;
      const waiting = pendingLinesRef.current.splice(0).filter(line =>
        typeof line.id === "number" && line.id > clearBoundaryRef.current
      );
      const next = mergeLines(linesRef.current.filter(line =>
        typeof line.id === "number" && line.id > clearBoundaryRef.current
      ), waiting);
      linesRef.current = next;
      if (pausedRef.current) setPausedLines([]);
      else setLines(next);
      setOverflowNotice(null);
      setHistoryState("ready");
      setHistoryError("");
      setAutoScroll(true);
      setPageAnchorId(null);
      setFeedback({ kind: "info", message: "Console history cleared." });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Could not clear console history." });
    } finally {
      setBusyAction(null);
    }
  };

  const copyFiltered = async () => {
    if (!navigator.clipboard?.writeText || filteredLines.length === 0) return;
    setBusyAction("copy");
    setFeedback(null);
    try {
      await navigator.clipboard.writeText(serializeDevConsoleLines(filteredLines));
      const noun = filteredLines.length === 1 ? "message" : "messages";
      setFeedback({ kind: "info", message: `Copied ${countLabel(filteredLines.length)} matching ${noun}.` });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Clipboard access was blocked." });
    } finally {
      setBusyAction(null);
    }
  };

  const exportSession = async () => {
    setBusyAction("export");
    setFeedback(null);
    try {
      const path = await window.shard.exportDevConsoleLog();
      setFeedback(path
        ? { kind: "info", message: `Full session log saved to ${path}` }
        : { kind: "info", message: "Log export canceled." });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Could not export the session log." });
    } finally {
      setBusyAction(null);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const typing = isTextEntry(event.target);
    if (event.key === "/" && !typing && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      searchRef.current?.focus();
    } else if (event.key === "Escape" && event.target === searchRef.current && preferences.query) {
      updatePreference("query", "");
    } else if (event.code === "Space" && event.target === filteredListRef.current) {
      event.preventDefault();
      togglePause();
    }
  };

  return (
    <main
      className="devconsole"
      data-shard-page="console"
      data-shard-component="developer-console"
      data-shard-state={pageState}
      data-stream-state={paused ? "paused" : "live"}
      data-action-state={actionState}
      onKeyDown={handleKeyDown}
    >
      <div className="dc__shell" data-shard-slot="console-shell">
        <header className="dc__header" data-shard-slot="console-header">
          <div className="dc__identity" data-shard-slot="console-identity">
            <span className="dc__mark" aria-hidden="true"><Icon name="terminal" size={18} /></span>
            <div>
              <div className="dc__eyebrow">DEVELOPER TOOLS</div>
              <h1 data-shard-slot="console-heading">Developer console</h1>
              <p>Live output from Shard and the capture core.</p>
            </div>
          </div>
          <div className={`dc__live${paused ? " is-paused" : ""}`} data-shard-slot="console-live-state" aria-live="polite">
            <span className="dc__live-dot" />
            {paused ? "Paused" : "Live"}
          </div>
        </header>

        <section className="dc__controls" data-shard-slot="console-controls" aria-label="Console controls">
          <div className="dc__filters" data-shard-slot="console-filters">
            <label className="dc__field">
              <span>Source</span>
              <ShardSelect value={preferences.source} onChange={value => updatePreference("source", value)} options={SOURCES} ariaLabel="Filter by source" className="dc__select" />
            </label>
            <label className="dc__field dc__field--severity">
              <span>Severity</span>
              <ShardSelect
                value={preferences.severity}
                onChange={value => updatePreference("severity", value)}
                options={[{ value: "all", label: "All levels" }, ...SEVERITIES.map(level => ({ value: level, label: level[0].toUpperCase() + level.slice(1) }))]}
                ariaLabel="Filter by severity"
                className="dc__select"
              />
            </label>
            <label className="dc__search" data-shard-slot="console-search">
              <Icon name="search" size={15} />
              <input
                ref={searchRef}
                className="input"
                type="search"
                aria-label="Search log messages"
                placeholder="Search messages…"
                value={preferences.query}
                onChange={event => updatePreference("query", event.target.value)}
              />
              {preferences.query && <button type="button" className="dc__clear-search" aria-label="Clear search" onClick={() => updatePreference("query", "")}><Icon name="x" size={14} /></button>}
            </label>
            <label className="dc__ring-toggle" title="ring.stats messages arrive once per second">
              <input type="checkbox" checked={preferences.includeRingStats} onChange={event => updatePreference("includeRingStats", event.target.checked)} />
              <span>Include ring stats</span>
            </label>
          </div>
          <div className="dc__actions" data-shard-slot="console-actions" data-shard-state={actionState}>
            <Button size="sm" variant="ghost" icon={<Icon name={paused ? "play" : "pause"} size={14} />} onClick={togglePause} disabled={busyAction !== null}>
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button size="sm" variant="ghost" icon={<Icon name="trash" size={14} />} onClick={() => void clearHistory()} disabled={busyAction !== null}>
              Clear view
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void copyFiltered()} disabled={busyAction !== null || filteredLines.length === 0 || !clipboardAvailable}>
              {busyAction === "copy" ? "Copying…" : "Copy filtered"}
            </Button>
            <Button size="sm" variant="primary" icon={<Icon name="save" size={14} />} onClick={() => void exportSession()} disabled={busyAction !== null}>
              {busyAction === "export" ? "Exporting…" : "Export session"}
            </Button>
          </div>
        </section>

        <section className="dc__workspace" data-shard-slot="console-workspace" aria-label="Console output">
          {overflowNotice && <div className="dc__notice" data-shard-slot="console-overflow" role="status">
            <Icon name="filter" size={15} />
            <span><strong>History limit reached.</strong> {overflowNotice.text} Full session export includes the complete session log.</span>
          </div>}
          {(feedback || historyState === "error") && <div className={`dc__feedback${feedback?.kind === "error" || historyState === "error" ? " is-error" : ""}`} data-shard-slot="console-feedback" role={feedback?.kind === "error" || historyState === "error" ? "alert" : "status"}>
            <span>{feedback?.message ?? `History could not be loaded: ${historyError}`}</span>
            {historyState === "error" && <Button size="sm" variant="ghost" icon={<Icon name="refresh" size={13} />} onClick={() => void loadHistory()} disabled={busyAction !== null}>Retry</Button>}
            {feedback && <button type="button" className="dc__dismiss" aria-label="Dismiss message" onClick={() => setFeedback(null)}><Icon name="x" size={14} /></button>}
          </div>}
          <div className="dc__output-head" data-shard-slot="console-results">
            <div className="dc__output-title"><Icon name="terminal" size={14} /><span>Session output</span></div>
            <span className="dc__output-count">{countWithNoun(filteredLines.length, "match", "matches")}</span>
          </div>
          <div
            className="dc__list"
            data-shard-slot="console-list"
            ref={filteredListRef}
            tabIndex={0}
            aria-label="Filtered console messages"
            aria-describedby="dc-keyboard-help"
            onScroll={event => {
              const element = event.currentTarget;
              setAutoScroll(element.scrollHeight - element.scrollTop - element.clientHeight < 32);
            }}
          >
            {pageState === "loading" && <div className="dc__empty" data-shard-slot="console-empty" role="status">
              <span className="dc__spinner" />
              <strong>Loading console history</strong>
              <span>Connecting to the saved session output…</span>
            </div>}
            {pageState !== "loading" && filteredLines.length === 0 && <div className="dc__empty" data-shard-slot="console-empty">
              <span className="dc__empty-icon"><Icon name={preferences.query || preferences.source !== "all" || preferences.severity !== "all" ? "filter" : "terminal"} size={20} /></span>
              <strong>{shownLines.length ? "No messages match these filters" : "No console messages yet"}</strong>
              <span>{shownLines.length ? "Try another source, severity, or search term." : historyState === "error" ? "Retry history loading or wait for new live output." : "New app and capture core output will appear here."}</span>
            </div>}
            {pageState !== "loading" && olderCount > 0 && <div className="dc__page-top" data-shard-slot="console-pagination">
              <Button size="sm" variant="ghost" onClick={() => {
                const nextStart = Math.max(0, firstIndex - PAGE_SIZE);
                setPageAnchorId(filteredLines[nextStart]?.id ?? null);
                setAutoScroll(false);
              }}>
                Show {countLabel(Math.min(PAGE_SIZE, olderCount))} older messages
              </Button>
              <span>{countLabel(olderCount)} older · newest first page</span>
            </div>}
            {pageState !== "loading" && pageLines.map(line => {
              const severity = devConsoleSeverity(line);
              const source = devConsoleSource(line);
              const timestamp = new Date(line.t).toLocaleTimeString(window.shard.regionalLocale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, fractionalSecondDigits: 3 });
              return <article
                className="dc__row"
                key={line.id!}
                data-shard-slot="console-row"
                data-severity={severity}
                data-source={source}
              >
                <time className="dc__time" data-shard-slot="console-time" dateTime={new Date(line.t).toISOString()}>{timestamp}</time>
                <span className="dc__source" data-shard-slot="console-source">{sourceLabel(line)}</span>
                <span className="dc__severity" data-shard-slot="console-severity">{severity}</span>
                <pre className="dc__message" data-shard-slot="console-message">{line.text}</pre>
              </article>;
            })}
          </div>
          <div className="dc__bottom" data-shard-slot="console-footer">
            <div className="dc__counts" data-shard-slot="console-counts">
              <span><strong>{countLabel(filteredLines.length)}</strong> {filteredLines.length === 1 ? "match" : "matches"}</span>
              <span>{countLabel(shownLines.length)} retained</span>
              {paused && <span className="dc__paused-note">Live output is still being collected</span>}
            </div>
            <div className="dc__paging" data-shard-slot="console-paging">
              <span>{filteredLines.length ? `${countLabel(firstVisible)}–${countLabel(pageEnd)}` : "0"} of {countLabel(filteredLines.length)}</span>
              <Button size="sm" variant="ghost" onClick={() => {
                const nextStart = pageEnd;
                if (nextStart + PAGE_SIZE >= filteredLines.length) {
                  setPageAnchorId(null);
                  setAutoScroll(true);
                } else {
                  setPageAnchorId(filteredLines[nextStart]?.id ?? null);
                  setAutoScroll(false);
                }
              }} disabled={!hasNewer}>
                Newer messages
              </Button>
            </div>
            <span className="dc__keyboard-help" data-shard-slot="console-keyboard-help" id="dc-keyboard-help">Press <kbd>/</kbd> to search · <kbd>Space</kbd> to pause while output is focused</span>
          </div>
        </section>
      </div>
    </main>
  );
}
