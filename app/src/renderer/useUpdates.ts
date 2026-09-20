import { useEffect, useState } from "react";
import type { UpdateState } from "../shared/contracts";

export function useUpdates() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState("");
  const accept = (next: UpdateState) => setState(previous => !previous || next.revision >= previous.revision ? next : previous);
  useEffect(() => {
    let active = true;
    const receive = (next: UpdateState) => { if (active) accept(next); };
    const off = window.shard.onUpdateState(receive);
    void window.shard.getUpdateState().then(receive).catch(() => { if (active) setError("Could not load update status. Try reopening this panel."); });
    return () => { active = false; off(); };
  }, []);
  const run = async (action: () => Promise<UpdateState>) => {
    setError("");
    try { accept(await action()); }
    catch { setError("Could not save or complete this update request. Please try again."); }
  };
  return { state, error, run };
}
