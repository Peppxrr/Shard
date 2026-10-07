import { useEffect, useState } from "react";
import type { RecordingPriorityStatus } from "../../shared/contracts";
import { Button, Card, Confirm, Icon, Toggle } from "./ui";

type PriorityState = "loading" | "unsupported" | "busy" | "off" | "active" | "inactive";

function priorityState(status: RecordingPriorityStatus | null): PriorityState {
  if (!status) return "loading";
  if (!status.supported) return "unsupported";
  if (status.busy) return "busy";
  if (!status.enabled) return "off";
  return status.coreElevated ? "active" : "inactive";
}

export function RecordingPerformanceCard() {
  const [status, setStatus] = useState<RecordingPriorityStatus | null>(null);
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void window.shard.getRecordingPriority().then(next => { if (alive) setStatus(next); }).catch(() => {});
    const off = window.shard.onRecordingPriority(setStatus);
    return () => { alive = false; off(); };
  }, []);

  const apply = async (enabled: boolean) => {
    setConfirm(null);
    setError("");
    try { setStatus(await window.shard.setRecordingPriority(enabled)); }
    catch (cause) { setError(`Could not change Recording priority: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };

  const exportDiagnostics = async () => {
    setExporting(true);
    setError("");
    setExported("");
    try {
      const saved = await window.shard.exportDiagnostics();
      if (saved) setExported(saved);
    } catch (cause) {
      setError(`Could not export diagnostics: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setExporting(false);
    }
  };

  const state = priorityState(status);
  const staleTask = status?.enabled && status.installed && !status.current;
  return <Card title="Recording performance" sub="Keep recordings smooth when a game maxes out your GPU.">
    <div data-shard-component="recording-priority" data-shard-state={state}>
      <label className="setting-row setting-row--switch">
        <span className="setting-row__copy">
          <strong>Recording priority</strong>
          <span>Gives recording GPU time ahead of the game. <span data-shard-slot="priority-warning">May increase CPU usage on slower PCs.</span> Windows asks for administrator permission once.</span>
        </span>
        <Toggle checked={status?.enabled ?? false} disabled={state === "loading" || state === "unsupported" || state === "busy"} onChange={setConfirm} />
      </label>
      {state === "busy" && <p data-shard-slot="priority-status" className="priority-status">Waiting for Windows to approve…</p>}
      {status?.message && <p data-shard-slot="priority-message" role="alert" className="form-error">{status.message}</p>}
      {staleTask && <Button size="sm" onClick={() => void apply(true)}>Turn on again</Button>}
    </div>
    <div data-shard-slot="diagnostics-export" className="setting-row">
      <div className="setting-row__copy">
        <h3>Diagnostics</h3>
        <p>Saves one .zip with the capture log, per-second frame stats and system details to send with a bug report. Nothing is uploaded.</p>
      </div>
      <div className="setting-row__control">
        <Button size="sm" icon={<Icon name="terminal" size={14} />} loading={exporting} disabled={exporting} onClick={() => void exportDiagnostics()}>Export diagnostics</Button>
      </div>
    </div>
    {exported && <p className="settings-note" role="status"><Icon name="check" size={14} />Saved {exported}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <Confirm open={confirm !== null}
      title={confirm ? "Turn on Recording priority?" : "Turn off Recording priority?"}
      message={confirm
        ? "Windows will ask for administrator permission. Capture restarts, so your replay buffer is cleared."
        : "Capture restarts, so your replay buffer is cleared."}
      confirmLabel={confirm ? "Turn on" : "Turn off"}
      onConfirm={() => void apply(confirm === true)}
      onCancel={() => setConfirm(null)} />
  </Card>;
}
