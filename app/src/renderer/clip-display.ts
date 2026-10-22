import type { ClipRecord } from "../shared/contracts";

export function clipDisplayName(clip: Pick<ClipRecord, "game" | "source">): string {
  return clip.game?.trim() || (clip.source === "recording" ? "Recording" : clip.source === "edited" ? "Edited Clip" : "Desktop");
}
