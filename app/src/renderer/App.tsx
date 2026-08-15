import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipRecord, ExportProgress, Settings } from "../shared/contracts";
import { DEFAULT_SETTINGS } from "../shared/contracts";
import { LibraryPage } from "./components/LibraryPage";
import { SettingsPage } from "./components/SettingsPage";
import { Editor } from "./components/Editor";

interface Toast {
  id: number;
  message: string;
}

export function App() {
  const [tab, setTab] = useState<"library" | "settings">("library");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [clips, setClips] = useState<ClipRecord[]>([]);
  const [editingClip, setEditingClip] = useState<ClipRecord | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const toastId = useRef(0);

  const pushToast = useCallback((message: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  useEffect(() => {
    let unsubs: Array<() => void> = [];
    (async () => {
      const s = await window.clipforge.getSettings();
      setSettings(s);
      const clips = await window.clipforge.listClips();
      setClips(clips);
    })();

    unsubs.push(
      window.clipforge.onCoreEvent((type, params) => {
        if (type === "clip.saved" || type === "recording.state") {
          window.clipforge.listClips().then(setClips);
        }
        if (type === "error") pushToast(String(params.message ?? "Core error"));
      })
    );
    unsubs.push(window.clipforge.onLibraryChanged(() => window.clipforge.listClips().then(setClips)));
    unsubs.push(window.clipforge.onToast((message) => pushToast(message)));
    unsubs.push(
      window.clipforge.onExport((p) => {
        setExportProgress(p);
        if (p.done) {
          window.clipforge.listClips().then(setClips);
          if (p.error) pushToast(`Export failed: ${p.error}`);
        }
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [pushToast]);

  if (!settings) return <div className="boot">Starting…</div>;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Shard</div>
        <nav>
          <button className={tab === "library" ? "active" : ""} onClick={() => setTab("library")}>
            Library
          </button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
            Settings
          </button>
        </nav>
        <div className="spacer" />
        <RingIndicator />
      </header>

      <main>
        {tab === "library" && (
          <LibraryPage clips={clips} onOpenEditor={setEditingClip} />
        )}
        {tab === "settings" && <SettingsPage settings={settings} onChange={setSettings} />}
      </main>

      <footer className="statusbar">
        <StorageBar usedBytes={clips.reduce((s, c) => s + c.sizeBytes, 0)} limitGb={settings.storage.limitGb} />
        <div className="spacer" />
        <CaptureChip />
      </footer>

      {editingClip && (
        <Editor
          clip={editingClip}
          onClose={() => setEditingClip(null)}
          onExport={() => setExportProgress({ clipId: editingClip.id, phase: "queued", percent: 0 })}
        />
      )}

      {exportProgress && !exportProgress.done && (
        <div className="exportbar">
          {exportProgress.phase}: {Math.round(exportProgress.percent)}%
          <button onClick={() => void window.clipforge.cancelExport()}>Cancel</button>
        </div>
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.message}</span>
            <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Topbar chip: what is being captured right now (desktop / game / nothing).
interface CaptureSubject { kind: string; name: string | null }

function subjectOf(state: unknown): CaptureSubject | null {
  if (!state || typeof state !== "object") return null;
  const capture = (state as Record<string, unknown>).capture;
  if (!capture || typeof capture !== "object") return null;
  const subject = (capture as Record<string, unknown>).subject;
  if (!subject || typeof subject !== "object") return null;
  const kind = (subject as Record<string, unknown>).kind;
  const name = (subject as Record<string, unknown>).name;
  if (typeof kind !== "string") return null;
  return { kind, name: typeof name === "string" ? name : null };
}

function CaptureChip() {
  const [subject, setSubject] = useState<CaptureSubject | null>(null);
  useEffect(() => {
    window.clipforge.invoke("state.get").then((st) => setSubject(subjectOf(st))).catch(() => {});
    return window.clipforge.onCoreEvent((type, params) => {
      if (type === "capture.subject") setSubject(subjectOf(params));
    });
  }, []);
  if (!subject || subject.kind === "none") {
    return <span className="capture-chip idle" title="Nothing is being captured">—</span>;
  }
  return (
    <span className={`capture-chip ${subject.kind}`} title="Current capture source">
      {subject.kind === "game" ? "🎮" : "🖥"} {subject.name ?? (subject.kind === "game" ? "Game" : "Desktop")}
    </span>
  );
}

function StorageBar({ usedBytes, limitGb }: { usedBytes: number; limitGb: number }) {
  const limitBytes = limitGb * 1024 * 1024 * 1024;
  const usedGb = usedBytes / 1024 / 1024 / 1024;
  const pct = limitBytes > 0 ? Math.min(100, (usedBytes / limitBytes) * 100) : 0;
  const cls = pct >= 100 ? "over" : pct >= 75 ? "warn" : "";
  return (
    <div className="storagebar" title={`${usedGb.toFixed(2)} GB of ${limitGb} GB used`}>
      <span className="sb-label">0 GB</span>
      <div className="sb-track">
        <div className={`sb-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="sb-label">{limitGb} GB</span>
    </div>
  );
}

function RingIndicator() {
  const [seconds, setSeconds] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    return window.clipforge.onCoreEvent((type, params) => {
      if (type === "ring.stats") setSeconds((params as { secondsBuffered: number }).secondsBuffered);
      if (type === "recording.state") setRecording((params as { active: boolean }).active);
    });
  }, []);
  return (
    <div className="ring-indicator" title="Replay buffer">
      {recording && <span className="rec-dot" />}
      {seconds !== null ? `${seconds}s buffered` : "…"}
    </div>
  );
}

export type { Settings };
export { DEFAULT_SETTINGS };
