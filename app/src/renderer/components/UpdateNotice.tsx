import { useUpdates } from "../useUpdates";
import { Icon, IconButton } from "./ui";

export function UpdateNotice({ onOpenUpdates }: { onOpenUpdates: () => void }) {
  const { state, error, run } = useUpdates();
  const visible = !!state?.version && !state.dismissed && ["available", "downloading", "downloaded"].includes(state.status);
  return <>
    <div className="update-notice" aria-live="polite">
      {visible && <>
        <button type="button" className="update-notice__link" onClick={onOpenUpdates}>
          <Icon name={state.status === "downloaded" ? "check" : "refresh"} size={13} />
          {state.installOnNextLaunch ? "Updates on next launch" : state.status === "downloaded" ? "Update ready" : state.status === "downloading" ? "Downloading update" : "Update available"}
        </button>
        <IconButton size="sm" label="Dismiss update notice" onClick={() => void run(window.shard.dismissUpdate)}><Icon name="x" size={12} /></IconButton>
      </>}
      {error && <span role="alert">{error}</span>}
    </div>
  </>;
}
