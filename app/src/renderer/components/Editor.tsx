import { useEffect, useMemo, useRef, useState } from "react";
import type { AudioTrackInfo, ClipRecord, ExportProgress } from "../../shared/contracts";
import { fmtDuration } from "./LibraryPage";
import { Modal, Button, Icon, Checkbox } from "./ui";

interface Segment { start: number; end: number; }
interface Props { clip: ClipRecord; onClose: () => void; onExport: () => void; }

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
  const [sourceTime, setSourceTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  // Probe audio tracks + subscribe to export progress (drives the result UI).
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

  const snapStep = Math.min(0.1, Math.max(0.01, duration / 20));
  const minimumTrim = Math.min(0.25, duration);
  const clampTime = (time: number) => Math.max(0, Math.min(duration, time));
  const snapTime = (time: number) => clampTime(Math.round(time / snapStep) * snapStep);

  const sourceTimeAtPointer = (clientX: number) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return snapTime(((clientX - rect.left) / rect.width) * duration);
  };
  const setTrimAtPointer = (edge: "in" | "out", clientX: number) => {
    const time = sourceTimeAtPointer(clientX);
    if (edge === "in") setInPoint(Math.min(time, outPoint - minimumTrim));
    else setOutPoint(Math.max(time, inPoint + minimumTrim));
  };
  const beginTrimDrag = (edge: "in" | "out", e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setTrimAtPointer(edge, e.clientX);
  };

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

  const seekAtPointer = (clientX: number) => {
    const time = Math.max(inPoint, Math.min(outPoint, sourceTimeAtPointer(clientX)));
    const video = videoRef.current;
    if (video) video.currentTime = time;
    setSourceTime(time);
    setResultTime(sourceToResult(time));
  };

  // The preview plays the result: skip cuts, stay inside in/out.
  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || v.paused || v.seeking) return;
    let jumped = false;
    for (const cut of cuts) {
      if (v.currentTime > cut.start && v.currentTime < cut.end) { v.currentTime = cut.end + 0.01; jumped = true; break; }
    }
    if (!jumped) {
      if (v.currentTime < inPoint) { v.currentTime = inPoint; jumped = true; }
      else if (v.currentTime > outPoint) { v.currentTime = inPoint; jumped = true; }
    }
    setSourceTime(v.currentTime);
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

  const dur = Math.max(duration, 0.001);
  const pct = (time: number) => `${(clampTime(time) / dur) * 100}%`;

  return (
    <Modal open onClose={onClose} closeOnBackdrop={false} size="lg" title="Edit clip"
      sub={<>{clip.game ?? "Untagged"} · {fmtDuration(clip.durationMs)}</>}>
      <div className="editor">
        <div className="editor__preview">
          <video
            ref={videoRef}
            className="editor__player player"
            src={`file://${clip.path}`}
            controls
            onTimeUpdate={onTimeUpdate}
            onSeeked={() => {
              const time = videoRef.current?.currentTime ?? 0;
              setSourceTime(time);
              setResultTime(sourceToResult(time));
            }}
          />
          <div className="editor__info">
            <span className="editor__result">Edited result <strong className="num">{fmtDuration(resultTime * 1000)}</strong> / {fmtDuration(totalRetained * 1000)}</span>
            <span className="dim">{retained.length} kept segment{retained.length === 1 ? "" : "s"}</span>
          </div>
        </div>

        <div className="tlpad">
          <div className="tl__head">
            <div>
              <strong>Trim</strong>
              <span>Drag a handle, or click the timeline to preview.</span>
            </div>
            <span className="chip num">Snap {snapStep < 0.1 ? `${Math.round(snapStep * 1000)} ms` : "0.1 s"}</span>
          </div>
          <div className="tl" ref={timelineRef} onPointerDown={(e) => seekAtPointer(e.clientX)}>
            <div className="tl__bar">
              <div className="tl__inout" style={{ left: pct(inPoint), width: `${((outPoint - inPoint) / dur) * 100}%` }} />
              {cuts.map((c, i) => (
                <div key={i} className="tl__cut" style={{ left: pct(c.start), width: `${((c.end - c.start) / dur) * 100}%` }}
                  title={`Cut ${c.start.toFixed(1)}–${c.end.toFixed(1)}`} />
              ))}
              <div className="tl__playhead" style={{ left: pct(sourceTime) }} />
              <button type="button" className="tl__handle tl__in" style={{ left: pct(inPoint) }}
                aria-label="Trim start" title={`Trim start: ${inPoint.toFixed(1)}s`}
                onPointerDown={(e) => beginTrimDrag("in", e)}
                onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && setTrimAtPointer("in", e.clientX)}>
                <span>IN</span>
              </button>
              <button type="button" className="tl__handle tl__out" style={{ left: pct(outPoint) }}
                aria-label="Trim end" title={`Trim end: ${outPoint.toFixed(1)}s`}
                onPointerDown={(e) => beginTrimDrag("out", e)}
                onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && setTrimAtPointer("out", e.clientX)}>
                <span>OUT</span>
              </button>
            </div>
          </div>
          <div className="tl__summary num">
            <span><b>Start</b> {fmtDuration(inPoint * 1000)}</span>
            <span><b>End</b> {fmtDuration(outPoint * 1000)}</span>
            <span><b>Keeping</b> {fmtDuration(totalRetained * 1000)}</span>
          </div>
        </div>

        {tracks.length > 0 && (
          <div className="tracks">
            <span className="tracks__title">Audio tracks</span>
            <div className="tracks__list">
              {tracks.map((t) => (
                <label key={t.index} className="track-chip">
                  <Checkbox checked={selectedTracks.includes(t.index)}
                    onChange={(chk) => setSelectedTracks((prev) => chk ? [...prev, t.index] : prev.filter((i) => i !== t.index))} />
                  Track {t.index} <span className="faint mono">({t.codec})</span>
                </label>
              ))}
              {selectedTracks.length === 0 && <span className="field__hint">No audio will be exported.</span>}
            </div>
          </div>
        )}

        <div className="editor__actions">
          <Button icon={<Icon name="scissor" size={15} />} onClick={addCutAtPlayhead}>Cut at playhead</Button>
          <Button onClick={() => setCuts([])} disabled={cuts.length === 0}>Clear cuts</Button>
          <Button onClick={() => { setInPoint(0); setOutPoint(duration); setCuts([]); }}>Reset</Button>
          <span className="spacer" />
          <Button variant="primary" icon={<Icon name="aperture" size={15} />} onClick={doExport} disabled={exporting || retained.length === 0}>
            {exporting ? "Exporting…" : "Export (Discord size)"}
          </Button>
        </div>

        {exportDone?.done && (
          <div className={`export-result ${exportDone.error ? "is-error" : "is-ok"}`}>
            {exportDone.result ? (
              <div className="export-result__line">
                <Icon name="check" size={16} />
                <span>Export ready ({exportDone.result.sizeMb} MB){exportDone.result.overTarget ? " — over target, Discord may reject" : ""}</span>
                <Button size="sm" icon={<Icon name="folderOpen" size={14} />} onClick={() => window.clipforge.revealInExplorer(exportDone.result!.path)}>Reveal</Button>
              </div>
            ) : (
              <span className="is-error">{exportDone.error ?? "Export failed"}</span>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}