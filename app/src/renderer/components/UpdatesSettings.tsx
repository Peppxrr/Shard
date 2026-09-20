import { useUpdates } from "../useUpdates";
import { Button, Card, Icon } from "./ui";

export function UpdatesSettings({ version, embedded = false }: { version: string; embedded?: boolean }) {
  const { state, error, run } = useUpdates();
  const status = state?.status;
  const canDownload = status === "available" || (status === "error" && state?.retry === "download");
  const canInstall = status === "downloaded" || (status === "error" && state?.retry === "install");
  const canCheck = status === "idle" || status === "up-to-date" || (status === "error" && state?.retry === "check");
  const label = status === "checking" ? "Checking for updates" : status === "up-to-date" ? "You’re up to date" :
    status === "available" ? "A new version is available" : status === "downloading" ? "Getting your update ready" :
    status === "downloaded" ? "Ready when you are" : status === "installing" ? "Restarting to update" :
    status === "error" ? "Update needs attention" : status === "disabled" ? "Updates unavailable" : "Keep Shard up to date";
  const content = <div className="updates">
    <div className="updates__overview">
      <div className={`updates__icon${status === "error" ? " updates__icon--error" : ""}`}><Icon name={status === "up-to-date" || canInstall ? "check" : "refresh"} size={22} /></div>
      <div className="updates__heading"><h3 role="status" aria-live="polite">{label}</h3>
        <div className="updates__versions"><span>Installed <strong className="num">{state?.currentVersion || version || "…"}</strong></span>
          {state?.version && <><span aria-hidden="true">→</span><span className="updates__version num">{state.version}</span></>}
        </div>
      </div>
    </div>
    {state?.message && <p className={status === "error" ? "updates__message updates__message--error" : "updates__message"} role={status === "error" ? "alert" : "status"}>{state.message}</p>}
    {status === "downloading" && state && <div className="updates__download">
      <div className="updates__download-label"><span>{state.downloadKind === "full" ? "Downloading full update" : "Downloading changes"}</span><strong className="num">{state.progress ? `${Math.round(state.progress.percent)}%` : "Preparing…"}</strong></div>
      <progress aria-label="Update download" max={100} value={state.progress?.percent} />
      <div className="updates__download-meta num"><span>{state.progress ? `${(state.progress.transferred / 1048576).toFixed(1)} of ${(state.progress.total / 1048576).toFixed(1)} MB` : "Checking your downloaded files"}</span><span>{state.progress && `${(state.progress.bytesPerSecond / 1048576).toFixed(1)} MB/s`}</span></div>
    </div>}
    {state?.installOnNextLaunch && <div className="updates__scheduled"><Icon name="clock" size={16}/><div><strong>Scheduled for your next launch</strong><p>Close Shard whenever you’re ready. The update will finish the next time you open it.</p></div></div>}
    <div className="updates__actions">
      {(canCheck || status === "checking" || status === "disabled") && <Button size="sm" loading={status === "checking"} disabled={status === "disabled"} onClick={() => void run(window.shard.checkForUpdates)}>Check for updates</Button>}
      {canDownload && <Button size="sm" variant="primary" icon={<Icon name="refresh" size={14}/>} onClick={() => void run(state?.mode === "portable" ? window.shard.openUpdateRelease : window.shard.downloadUpdate)}>{state?.mode === "portable" ? "View GitHub release" : "Download update"}</Button>}
      {canInstall && <>
        <Button size="sm" variant="primary" onClick={() => void run(window.shard.installUpdate)}>Update &amp; restart</Button>
        <Button size="sm" variant="ghost" onClick={() => void run(state?.installOnNextLaunch ? window.shard.cancelScheduledUpdate : window.shard.scheduleUpdate)}>{state?.installOnNextLaunch ? "Cancel scheduled update" : "Install on next launch"}</Button>
      </>}
      {status === "error" && <Button size="sm" variant="ghost" onClick={() => void run(window.shard.openUpdateRelease)}>View GitHub release</Button>}
    </div>
    {canInstall && <p className="updates__hint">Save your editor changes before restarting. Unsaved replay history will be cleared.</p>}
    {state?.mode === "portable" && <p className="updates__hint">Download the new portable EXE, close Shard, then replace the old EXE. Your settings and clips stay in place.</p>}
    {state?.releaseNotes && <details className="updates__notes" open><summary>What’s new in {state.version}<Icon name="chevronDown" size={14}/></summary><div>{state.releaseNotes}</div></details>}
    {state?.mode !== "disabled" && <div className="updates__foot"><Icon name="refresh" size={12}/><span>Checks at startup and every 12 hours{state?.lastCheckedAt ? ` · Last checked ${new Date(state.lastCheckedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
  return embedded ? content : <Card title="Updates" sub="Latest improvements. Your choice of when to install.">{content}</Card>;
}
