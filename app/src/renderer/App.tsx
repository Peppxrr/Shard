import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipRecord, CoreState, ExportProgress, Settings } from "../shared/contracts";
import { DEFAULT_SETTINGS } from "../shared/contracts";
import { CapturePage } from "./components/CapturePage";
import { LibraryPage } from "./components/LibraryPage";
import { GamesPage } from "./components/GamesPage";
import { SettingsPage } from "./components/SettingsPage";
import { Editor } from "./components/Editor";
import { Button, Icon, Modal, Spinner, Toasts, type ToastItem } from "./components/ui";
import { setTheme } from "./themeManager";

type Tab = "capture" | "library" | "games" | "settings";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "capture", label: "Capture", icon: "video" },
  { id: "library", label: "Library", icon: "film" },
  { id: "games", label: "Games", icon: "box" },
  { id: "settings", label: "Settings", icon: "settings" },
];

interface Subject { kind: "monitor" | "game" | "none"; name: string | null }

function WindowControls({ floating = false }: { floating?: boolean }) {
  const supported = window.shard.windowControlsSupported;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!supported) return;
    void window.shard.isWindowMaximized().then(setMaximized);
    return window.shard.onWindowMaximized(setMaximized);
  }, [supported]);

  if (!supported) return null;
  return (
    <div className={`window-controls${floating ? " window-controls--floating" : ""}`}>
      <button className="window-control" type="button" aria-label="Minimize Shard" title="Minimize"
        onClick={() => void window.shard.minimizeWindow()}>
        <Icon name="minimize" size={13} />
      </button>
      <button className="window-control" type="button" aria-label={maximized ? "Restore Shard" : "Maximize Shard"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => void window.shard.toggleMaximizeWindow().then(setMaximized)}>
        <Icon name={maximized ? "restore" : "maximizeWindow"} size={13} />
      </button>
      <button className="window-control window-control--close" type="button" aria-label="Close Shard" title="Close"
        onClick={() => void window.shard.closeWindow()}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("capture");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [pendingTab, setPendingTab] = useState<Tab | null>(null);
  const [showUnsaved, setShowUnsaved] = useState(false);
  const [clips, setClips] = useState<ClipRecord[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [editingClip, setEditingClip] = useState<ClipRecord | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [booting, setBooting] = useState(true);
  const [saved, setSaved] = useState(false);
  const toastId = useRef(0);
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const clipAudioRef = useRef<{ current: HTMLAudioElement | null; path: string; volume: number }>({ current: null, path: "", volume: 0.8 });

  const pushToast = useCallback((message: string, kind: ToastItem["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    (async () => {
      const s = await window.shard.getSettings();
      setSettings(s);
      setSavedSettings(s);
      const clips = await window.shard.listClips();
      setClips(clips);
      setBooting(false);
    })().catch(() => setBooting(false));

    unsubs.push(
      window.shard.onCoreEvent((type, params) => {
        if (type === "clip.saved" || type === "recording.state") window.shard.listClips().then(setClips);
        if (type === "clip.saved") {
          // Play clip sound instantly in renderer (low latency, same tick as overlay)
          try {
            const vol = (settingsRef.current as any)?.app?.clipSoundVolume ?? 0.8;
            const enabled = (settingsRef.current as any)?.app?.clipSound ?? true;
            if (enabled) {
              const outer = clipAudioRef.current as unknown as { current: HTMLAudioElement | null; path: string; volume: number };
              let audio: HTMLAudioElement | null = outer?.current ?? null;
              // If preloaded audio exists and volume matches, reuse it
              if (audio && outer && outer.path) {
                try { audio.pause(); audio.currentTime = 0; audio.volume = Math.min(1, Math.max(0, vol)); } catch {}
                const p = audio.play();
                if (p && typeof (p as any).catch === "function") (p as Promise<void>).catch(() => {});
              } else {
                // Fallback: let main handle it (will send play-clip-sound) or create one-shot
                void window.shard.previewClipSound("", vol).catch(()=>{});
              }
            }
          } catch {}
        }
        if (type === "error") pushToast(String(params.message ?? "Core error"), "error");
      })
    );
    unsubs.push(window.shard.onLibraryChanged(() => window.shard.listClips().then(setClips)));
    unsubs.push(window.shard.onToast((message) => pushToast(message)));
    unsubs.push(
      window.shard.onExport((p) => {
        setExportProgress(p);
        if (p.done) {
          window.shard.listClips().then(setClips);
          if (p.error) pushToast(`Export failed: ${p.error}`, "error");
        }
      })
    );
    // Low-latency clip sound — use preloaded Audio from outer ref
    unsubs.push(
      window.shard.onPlayClipSound(({ path, volume }) => {
        try {
          const vol = Math.min(1, Math.max(0, volume));
          // Use preloaded if matching, else create fresh but still fast
          let audio: HTMLAudioElement | null = null;
          const outer = clipAudioRef.current as unknown as { current: HTMLAudioElement | null; path: string; volume: number };
          const isPreloaded = outer && outer.current && outer.path && outer.path.includes(encodeURIComponent(path.split(/[\\/]/).pop() || "")) && Math.abs(outer.volume - vol) < 0.01;
          if (isPreloaded) {
            audio = (outer as any).current as HTMLAudioElement;
            try { audio.pause(); audio.currentTime = 0; audio.volume = vol; } catch {}
          } else {
            const url = path.startsWith("file://") ? path : "file:///" + path.replace(/\\/g, "/").split("/").map((seg, i) => i===0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)).join("/");
            audio = new Audio(url);
            audio.volume = vol;
            audio.preload = "auto";
          }
          // Play immediately, no await
          const p = audio.play();
          if (p && typeof (p as any).catch === "function") (p as Promise<void>).catch(() => {});
        } catch {}
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [pushToast]);

  // Preload clip sound on settings change for instant play
  useEffect(() => {
    let cancelled = false;
    const vol = (settings as any)?.app?.clipSoundVolume ?? 0.8;
    const customPath = (settings as any)?.app?.clipSoundPath ?? "";
    (async () => {
      try {
        let p = String(customPath || "").trim();
        if (!p) p = await window.shard.getClipSoundDefaultPath().catch(() => "");
        if (!p || cancelled) return;
        const url = p.startsWith("file://") ? p : "file:///" + p.replace(/\\/g, "/").split("/").map((seg, i) => i===0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)).join("/");
        const outer = clipAudioRef.current as unknown as { current: HTMLAudioElement | null; path: string; volume: number };
        // This outer ref is actually an object with current/path/volume, but we defined it as useRef<{current,path,volume}>
        // So outer.current is the Audio, outer.path is the URL
        if (outer && (outer as any).path === url && Math.abs((outer as any).volume - vol) < 0.01) return;
        const a = new Audio();
        a.preload = "auto";
        a.src = url;
        a.volume = Math.min(1, Math.max(0, vol));
        a.load();
        try { a.muted = true; await a.play().catch(()=>{}); a.pause(); a.currentTime = 0; a.muted = false; } catch {}
        if (cancelled) return;
        (clipAudioRef.current as any).current = a;
        (clipAudioRef.current as any).path = url;
        (clipAudioRef.current as any).volume = vol;
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [settings.app.clipSoundPath, settings.app.clipSoundVolume]);

  const saveSettings = async () => {
    await window.shard.setSettings(settings);
    setSavedSettings(settings);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  };

  const isDirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);

  const requestTab = (next: Tab) => {
    if (tab === "settings" && isDirty && next !== "settings") {
      setPendingTab(next);
      setShowUnsaved(true);
      return;
    }
    setTab(next);
  };

  const applyAndLeave = async () => {
    await window.shard.setSettings(settings);
    setSavedSettings(settings);
    setShowUnsaved(false);
    if (pendingTab) { setTab(pendingTab); setPendingTab(null); }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  };

  const declineAndLeave = async () => {
    // revert theme if changed
    const prevTheme = savedSettings.appearance?.theme;
    const curTheme = settings.appearance?.theme;
    if (prevTheme && curTheme !== prevTheme) {
      try { await setTheme(prevTheme); } catch {}
    }
    setSettings(savedSettings);
    setShowUnsaved(false);
    if (pendingTab) { setTab(pendingTab); setPendingTab(null); }
  };

  if (booting) return <div className="boot app--frameless"><WindowControls floating /><Spinner size={22} /><span>Starting…</span></div>;

  const usedBytes = clips.reduce((acc, c) => acc + c.sizeBytes, 0);

  return (
    <div className={`app${window.shard.windowControlsSupported ? " app--frameless" : ""}`}>
      <header className="app__bar">
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t.id} type="button" className="nav__item" aria-current={tab === t.id ? "page" : undefined} onClick={() => requestTab(t.id)}>
              <span className="ico"><Icon name={t.icon} size={16} /></span>{t.label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <LiveStatus />
        <StorageMeter usedBytes={usedBytes} limitGb={settings.storage.limitGb} />
        {tab === "settings" && (
          <Button variant="primary" size="sm" icon={<Icon name="check" size={15} />} onClick={() => void saveSettings()} disabled={!isDirty}>
            {saved ? "Saved" : "Save"}
          </Button>
        )}
        <WindowControls />
      </header>

      <main className="app__main">
        {tab === "capture" && <CapturePage settings={settings} clips={clips} />}
        {tab === "library" && <LibraryPage clips={clips} onOpenEditor={setEditingClip} />}
        {tab === "games" && <GamesPage settings={settings} onChange={(next) => {
          setSettings(next);
          setSavedSettings(next);
          void window.shard.setSettings(next).catch(() => {});
        }} />}
        {tab === "settings" && <SettingsPage settings={settings} onChange={setSettings}
          onCommit={(next) => {
            setSettings(next);
            const committed = { ...savedSettings, audio: next.audio };
            void window.shard.setSettings(committed).then(() => {
              setSavedSettings((current) => ({ ...current, audio: next.audio }));
            }).catch((error: unknown) => {
              pushToast(`Audio source update failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            });
          }} />}
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
          <Button size="sm" variant="ghost" onClick={() => void window.shard.cancelExport()}>Cancel</Button>
        </div>
      )}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((x) => x.filter((y) => y.id !== id))} />

      {showUnsaved && (
        <Modal open onClose={() => setShowUnsaved(false)} title="Unsaved changes" sub="You have unsaved settings changes.">
          <p className="field__hint" style={{ lineHeight: "1.6" }}>
            Do you want to apply your changes or discard them? Apply saves to disk and updates the core.
          </p>
          <div className="row" style={{ marginTop: "var(--sp-4)", justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setShowUnsaved(false)}>Cancel</Button>
            <Button variant="ghost" onClick={() => void declineAndLeave()}>Decline</Button>
            <Button variant="primary" onClick={() => void applyAndLeave()}>Apply</Button>
          </div>
        </Modal>
      )}

      {settings.app.developerConsole && (
        <button
          type="button"
          className="dev-chip"
          title="Developer console (click to toggle the log window)"
          onClick={() => void window.shard.toggleDevConsole()}
        >
          <Icon name="terminal" size={12} /> console
        </button>
      )}
    </div>
  );
}

/* Compact always-visible live capture status (subscribes to core events; mirrors the dashboard's richer view). */
function LiveStatus() {
  const [subject, setSubject] = useState<Subject | null>(null);
  const [recording, setRecording] = useState(false);
  const [ring, setRing] = useState<number | null>(null);
  useEffect(() => {
    const loadState = () => {
      void window.shard.invoke("state.get").then((st) => {
        const s = st as CoreState;
        setSubject(s.capture.subject);
        setRecording(s.recording.active);
        setRing(s.ring.secondsBuffered);
      }).catch(() => {});
    };
    loadState();
    return window.shard.onCoreEvent((type, params) => {
      if (type === "ready") loadState();
      else if (type === "capture.subject") setSubject(params as unknown as Subject);
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
          <Icon name={subject?.kind === "game" ? "box" : "screen"} size={12} /> {subject?.name ?? (subject?.kind === "game" ? "Game" : "Desktop")}
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