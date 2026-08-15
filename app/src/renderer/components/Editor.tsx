import { useEffect, useMemo, useRef, useState } from "react";
import type { AudioTrackInfo, ClipRecord, ExportProgress } from "../../shared/contracts";
import { fmtDuration } from "./LibraryPage";

interface Segment {
  start: number;
  end: number;
}

interface Props {
  clip: ClipRecord;
  onClose: () => void;
  onExport: () => void;
}

// Editor: trim (in/out) minus zero-or-more cuts. The preview plays the
// *result* — the source file is seeked over cut regions and outside the
// in/out range, and the timeline shows retained vs removed. Exports include
// only the checked audio tracks (multi-track recordings split per source).
export function Editor({ clip, onClose, onExport }: Props) {
  const duration = clip.durationMs / 1000;
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(duration);
  const [cuts, setCuts] = useState<Segment[]>([]);
  const [tracks, setTracks] = useState<AudioTrackInfo[]>([]);
  const [selectedTracks, setSelectedTracks] = useState<number[]>([]);
  const [exportDone, setExportDone] = useState<ExportProgress | null>(null);
  const [exporting, setExporting] = useState(false);
  const [resultTime, setResultTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    window.clipforge.probeTracks(clip.path).then((ts) => {
      setTracks(ts);
      setSelectedTracks(ts.length ? ts.map((t) => t.index) : [0]);
    }).catch(() => {});
    return window.clipforge.onExport((p) => {
      setExportDone(p);
      if (p.done) setExporting(false);
    });
  }, [clip.path]);

  // Retained segments: [in,out] minus cuts.
  const retained = useMemo<Segment[]>(() => {
    if (outPoint <= inPoint) return [];
    const segs: Segment[] = [{ start: inPoint, end: outPoint }];
    for (const cut of cuts) {
      const next: Segment[] = [];
      for (const s of segs) {
        if (cut.start <= s.start && cut.end >= s.end) continue;
        if (cut.end <= s.start || cut.start >= s.end) { next.push(s); continue; }
        if (cut.start > s.start) next.push({ start: s.start, end: Math.min(cut.start, s.end) });
        if (cut.end < s.end) next.push({ start: Math.max(cut.end, s.start), end: s.end });
      }
      segs.length = 0;
      segs.push(...next);
    }
    return segs.filter((s) => s.end - s.start > 0.05);
  }, [inPoint, outPoint, cuts]);

  const totalRetained = retained.reduce((s, x) => s + (x.end - x.start), 0);

  // Map a source time to the position within the edited result.
  const sourceToResult = (t: number): number => {
    let acc = 0;
    for (const seg of retained) {
      if (t < seg.start) return acc;
      if (t <= seg.end) return acc + (t - seg.start);
      acc += seg.end - seg.start;
    }
    return acc;
  };

  // The preview plays the result: skip cuts, stay inside in/out.
  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || v.paused || v.seeking) return;
    let jumped = false;
    for (const cut of cuts) {
      if (v.currentTime > cut.start && v.currentTime < cut.end) {
        v.currentTime = cut.end + 0.01;
        jumped = true;
        break;
      }
    }
    if (!jumped) {
      if (v.currentTime < inPoint) { v.currentTime = inPoint; jumped = true; }
      else if (v.currentTime > outPoint) { v.currentTime = inPoint; jumped = true; }
    }
    setResultTime(sourceToResult(v.currentTime));
  };

  const addCutAtPlayhead = () => {
    const v = videoRef.current;
    if (!v) return;
    const t = v.currentTime;
    const len = Math.min(2, Math.max(0.5, duration / 50));
    const cut: Segment = { start: Math.max(inPoint, t - len / 2), end: Math.min(outPoint, t + len / 2) };
    setCuts((c) => [...c, cut]);
  };

  const doExport = () => {
    setExporting(true);
    setExportDone(null);
    void window.clipforge.startExport(clip.id, retained, selectedTracks);
    onExport();
  };

  const step = Math.max(0.01, duration / 2000);

  return (
    <div className="modal editor-modal">
      <div className="modal-body editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Edit — {clip.game ?? "Untagged"}</strong>
          <button onClick={onClose}>×</button>
        </div>

        <div className="editor-preview">
          <video
            ref={videoRef}
            src={`file://${clip.path}`}
            controls
            className="player"
            onTimeUpdate={onTimeUpdate}
            onSeeked={() => setResultTime(sourceToResult(videoRef.current?.currentTime ?? 0))}
          />
          <div className="preview-info">
            <span>Result {fmtDuration(resultTime * 1000)} / {fmtDuration(totalRetained * 1000)}</span>
            <span className="dim">({retained.length} segment{retained.length === 1 ? "" : "s"})</span>
          </div>
        </div>

        <div className="timeline">
          <div className="timeline-bar">
            <div className="in-out" style={{ left: `${(inPoint / duration) * 100}%`, width: `${((outPoint - inPoint) / duration) * 100}%` }} />
            {cuts.map((c, i) => (
              <div
                key={i}
                className="cut-region"
                style={{ left: `${(c.start / duration) * 100}%`, width: `${((c.end - c.start) / duration) * 100}%` }}
                title={`Cut ${c.start.toFixed(1)}–${c.end.toFixed(1)}`}
              />
            ))}
            <input
              type="range" min={0} max={duration} step={step} value={inPoint}
              onChange={(e) => setInPoint(Math.min(Number(e.target.value), outPoint - 0.1))}
              className="handle left"
            />
            <input
              type="range" min={0} max={duration} step={step} value={outPoint}
              onChange={(e) => setOutPoint(Math.max(Number(e.target.value), inPoint + 0.1))}
              className="handle right"
            />
          </div>
          <div className="timeline-labels">
            <span>In {fmtDuration(inPoint * 1000)}</span>
            <span>Out {fmtDuration(outPoint * 1000)}</span>
            <span>Retained {fmtDuration(totalRetained * 1000)}</span>
          </div>
        </div>

        {tracks.length > 0 && (
          <div className="track-select">
            <span className="track-title">Audio tracks</span>
            {tracks.map((t) => (
              <label key={t.index} className="track-chip">
                <input
                  type="checkbox"
                  checked={selectedTracks.includes(t.index)}
                  onChange={(e) => {
                    setSelectedTracks((prev) =>
                      e.target.checked ? [...prev, t.index] : prev.filter((i) => i !== t.index)
                    );
                  }}
                />
                Track {t.index} <span className="dim mono">({t.codec})</span>
              </label>
            ))}
            {selectedTracks.length === 0 && <span className="hint">No audio will be exported.</span>}
          </div>
        )}

        <div className="editor-actions">
          <button onClick={addCutAtPlayhead}>Add cut at playhead</button>
          <button onClick={() => setCuts([])}>Remove all cuts</button>
          <button onClick={() => { setInPoint(0); setOutPoint(duration); setCuts([]); }}>Reset</button>
          <span className="spacer" />
          <button className="primary" onClick={doExport} disabled={exporting || retained.length === 0}>
            {exporting ? "Exporting…" : "Export (Discord size)"}
          </button>
        </div>

        {exportDone?.done && (
          <div className="export-result">
            {exportDone.result ? (
              <>
                Export ready: {exportDone.result.path} ({exportDone.result.sizeMb} MB)
                {exportDone.result.overTarget && " — over target, Discord may reject"}
                <button onClick={() => window.clipforge.revealInExplorer(exportDone.result!.path)}>Reveal</button>
              </>
            ) : (
              <span className="error">{exportDone.error ?? "Export failed"}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
