import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipRecord, CoreState, ExportProgress, Settings } from "../shared/contracts";
import { DEFAULT_SETTINGS } from "../shared/contracts";
import { CapturePage } from "./components/CapturePage";
import { LibraryPage } from "./components/LibraryPage";
import { GamesPage } from "./components/GamesPage";
import { SettingsPage } from "./components/SettingsPage";
import { Editor } from "./components/Editor";
import { Button, Icon, Logo, Spinner, Toasts, type ToastItem } from "./components/ui";

type Tab = "capture" | "library" | "games" | "settings";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "capture", label: "Capture", icon: "aperture" },
  { id: "library", label: "Library", icon: "screen" },
  { id: "games", label: "Games", icon: "games" },
  { id: "settings", label: "Settings", icon: "sliders" },
];

interface Subject { kind: "monitor" | "game" | "none"; name: string | null }

export function App() {
  const [tab, setTab] = useState<Tab>("capture");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [clips, setClips] = useState<ClipRecord[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [editingClip, setEditingClip] = useState<ClipRecord | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [booting, setBooting] = useState(true);
  const [saved, setSaved] = useState(false);
  const toastId = useRef(0);

  const pushToast = useCallback((message: string, kind: ToastItem["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    (async () => {
      const s = await window.clipforge.getSettings();
      setSettings(s);
      const clips = await window.clipforge.listClips();
      setClips(clips);
      setBooting(false);
    })().catch(() => setBooting(false));

    unsubs.push(
      window.clipforge.onCoreEvent((type, params) => {
        if (type === "clip.saved" || type === "recording.state") window.clipforge.listClips().then(setClips);
        if (type === "error") pushToast(String(params.message ?? "Core error"), "error");
      })
    );
    unsubs.push(window.clipforge.onLibraryChanged(() => window.clipforge.listClips().then(setClips)));
    unsubs.push(window.clipforge.onToast((message) => pushToast(message)));
    unsubs.push(
      window.clipforge.onExport((p) => {
        setExportProgress(p);
        if (p.done) {
          window.clipforge.listClips().then(setClips);
          if (p.error) pushToast(`Export failed: ${p.error}`, "error");
        }
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [pushToast]);

  const saveSettings = async () => {
    await window.clipforge.setSettings(settings);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  };

  if (booting) return <div className="boot"><Spinner size={22} /><span>Starting…</span></div>;

  const usedBytes = clips.reduce((acc, c) => acc + c.sizeBytes, 0);

  return (
    <div className="app">
      <header className="app__bar">
        <div className="brand"><Logo size={20} /><span className="brand__name">Shard</span></div>
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t.id} type="button" className="nav__item" aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
              <span className="ico"><Icon name={t.icon} size={16} /></span>{t.label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <LiveStatus />
        <StorageMeter usedBytes={usedBytes} limitGb={settings.storage.limitGb} />
        {(tab === "settings" || tab === "games") && (
          <Button variant="primary" size="sm" icon={<Icon name="check" size={15} />} onClick={() => void saveSettings()}>
            {saved ? "Saved" : "Save"}
          </Button>
        )}
      </header>

      <main className="app__main">
        {tab === "capture" && <CapturePage settings={settings} clips={clips} />}
        {tab === "library" && <LibraryPage clips={clips} onOpenEditor={setEditingClip} />}
        {tab === "games" && <GamesPage settings={settings} onChange={setSettings} />}
        {tab === "settings" && <SettingsPage settings={settings} onChange={setSettings} />}
      </main>

      {editingClip && (
        <Editor
          clip={editingClip}
          onClose={() => setEditingClip(null)}
          onExport={() => setExportProgress({ clipId: editingClip.id, phase: "queued", percent: 0 })}
        />
      )}

      {exportProgress && !exportProgress.done && (
        <div className="exportbar">
          <Icon name="link" size={15} />
          <span className="exportbar__phase">{exportProgress.phase}</span>
          <div className="exportbar__track"><div className="exportbar__fill" style={{ width: `${Math.max(2, Math.round(exportProgress.percent))}%` }} /></div>
          <span className="num">{Math.round(exportProgress.percent)}%</span>
          <Button size="sm" variant="ghost" onClick={() => void window.clipforge.cancelExport()}>Cancel</Button>
        </div>
      )}

      <Toasts toasts={toasts} onDismiss={(id) => setToasts((x) => x.filter((y) => y.id !== id))} />
    </div>
  );
}

/* Compact always-visible live capture status (subscribes to core events; mirrors the dashboard's richer view). */
function LiveStatus() {
  const [subject, setSubject] = useState<Subject | null>(null);
  const [recording, setRecording] = useState(false);
  const [ring, setRing] = useState<number | null>(null);
  useEffect(() => {
    window.clipforge.invoke("state.get").then((st) => {
      const s = st as CoreState;
      setSubject(s.capture.subject);
      setRecording(s.recording.active);
      setRing(s.ring.secondsBuffered);
    }).catch(() => {});
    return window.clipforge.onCoreEvent((type, params) => {
      if (type === "capture.subject") setSubject(params as unknown as Subject);
      else if (type === "recording.state") setRecording((params as { active: boolean }).active);
      else if (type === "ring.stats") setRing((params as { secondsBuffered: number }).secondsBuffered);
    });
  }, []);
  const capturing = subject && subject.kind !== "none";
  return (
    <div className="lv">
      {recording && <span className="chip chip--rec"><span className="dot dot--rec" /> REC</span>}
      {capturing ? (
        <span className={`chip ${subject?.kind === "game" ? "chip--game" : "chip--monitor"}`}>
          <Icon name={subject?.kind === "game" ? "gamepad" : "screen"} size={12} /> {subject?.name ?? (subject?.kind === "game" ? "Game" : "Desktop")}
        </span>
      ) : (
        !recording && <span className="chip chip--idle">not capturing</span>
      )}
      {ring !== null && <span className="lv__ring num">{ring}s</span>}
    </div>
  );
}

function StorageMeter({ usedBytes, limitGb }: { usedBytes: number; limitGb: number }) {
  const limitBytes = limitGb * 1024 * 1024 * 1024;
  const usedGb = usedBytes / 1024 / 1024 / 1024;
  const pct = limitBytes > 0 ? Math.min(100, (usedBytes / limitBytes) * 100) : 0;
  const cls = pct >= 100 ? "is-over" : pct >= 75 ? "is-warn" : "";
  return (
    <div className="meter-sm" title={`${usedGb.toFixed(2)} GB of ${limitGb} GB used`}>
      <div className="meter-sm__track"><div className={`meter-sm__fill ${cls}`} style={{ width: `${pct}%` }} /></div>
      <span className="meter-sm__label num">{usedGb.toFixed(1)}/{limitGb} GB</span>
    </div>
  );
}