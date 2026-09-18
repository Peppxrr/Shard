import { useEffect, useState } from "react";
import type { UpdateState } from "../../shared/contracts";
import { Button, Card } from "./ui";
import { SettingRow } from "./SettingControls";

export function UpdatesSettings({ version }: { version: string }) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState("");
  const accept = (next: UpdateState) => setState(previous => !previous || next.revision >= previous.revision ? next : previous);
  useEffect(() => {
    let active = true;
    const receive = (next: UpdateState) => { if (active) accept(next); };
    const off = window.shard.onUpdateState(receive);
    void window.shard.getUpdateState().then(receive).catch(() => { if (active) setError("Could not load update status. Reopen Settings to try again."); });
    return () => { active = false; off(); };
  }, []);
  const run = async (action: () => Promise<UpdateState>) => {
    setError("");
    try { accept(await action()); }
    catch { setError("Could not complete the update request. Please try again."); }
  };
  const status = state?.status;
  const canDownload = status === "available" || (status === "error" && state?.retry === "download");
  const canInstall = status === "downloaded" || (status === "error" && state?.retry === "install");
  const canCheck = status === "idle" || status === "up-to-date" || (status === "error" && state?.retry === "check");
  const label = status === "checking" ? "Checking for updates…" : status === "up-to-date" ? "Shard is up to date" :
    status === "available" ? `Shard ${state?.version} is available` : status === "downloading" ? "Downloading update…" :
    status === "downloaded" ? `Shard ${state?.version} is ready to install` : status === "installing" ? "Restarting to update…" : "Check for a new version when you’re ready.";
  return <Card title="Updates" sub="You choose when to check, download, and restart.">
    <SettingRow title={`Shard ${state?.currentVersion || version || "…"}`} description="Installed version">
      {(canCheck || status === "checking" || status === "disabled") && <Button size="sm" loading={status === "checking"} disabled={status === "disabled"} onClick={() => void run(window.shard.checkForUpdates)}>Check for updates</Button>}
      {canDownload && state?.mode === "installed" && <Button size="sm" variant="primary" onClick={() => void run(window.shard.downloadUpdate)}>Download update</Button>}
      {canDownload && state?.mode === "portable" && <Button size="sm" variant="primary" onClick={() => void run(window.shard.openUpdateRelease)}>Open GitHub release</Button>}
      {canInstall && <Button size="sm" variant="primary" onClick={() => void run(window.shard.installUpdate)}>Restart &amp; update</Button>}
    </SettingRow>
    <p className="field__hint" role="status" aria-live="polite">{state?.message || label}</p>
    {status === "downloading" && <div className="updates-progress">
      <progress aria-label="Update download" max={100} value={state?.progress?.percent} />
      <span className="num">{state?.progress ? `${Math.round(state.progress.percent)}% · ${(state.progress.transferred / 1048576).toFixed(1)} / ${(state.progress.total / 1048576).toFixed(1)} MB` : "Starting download…"}</span>
    </div>}
    {state?.mode === "portable" && <p className="field__hint">Portable builds update manually. Download the new portable EXE from GitHub, close Shard, then replace your old EXE. Your settings and clips stay in place.</p>}
    {canInstall && <p className="field__hint">Save any editor changes first. Restarting clears unsaved replay history.</p>}
    {state?.releaseNotes && <details className="updates-notes"><summary>What’s new in {state.version}</summary><p>{state.releaseNotes}</p></details>}
    {status === "error" && <Button size="sm" variant="ghost" onClick={() => void run(window.shard.openUpdateRelease)}>Open GitHub release</Button>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </Card>;
}
