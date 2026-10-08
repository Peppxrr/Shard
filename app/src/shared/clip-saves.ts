// Clip save requests between acceptance and their terminal core event. The
// core acknowledges each accepted request with `clip.queued {request}` and
// ends it with exactly one of `clip.saved`, `clip.dropped` or an `error`
// carrying the same `request` id. A save can legitimately take well over 30 s
// (encoder catch-up after GPU starvation, then muxing and disk I/O), so UI
// state follows these events rather than a timer.
const RECENT_FINISHED = 64;

export class ClipSaveTracker {
  private readonly pending = new Set<number>();
  // Recently finished ids: a fast save's result can arrive before the
  // clip.save reply that also reports its id.
  private readonly finished: number[] = [];

  get size(): number {
    return this.pending.size;
  }

  queued(request: unknown): void {
    if (typeof request !== "number" || this.finished.includes(request)) return;
    this.pending.add(request);
  }

  settled(request: unknown): void {
    if (typeof request !== "number") return;
    this.pending.delete(request);
    this.finished.push(request);
    if (this.finished.length > RECENT_FINISHED) this.finished.shift();
  }

  // A (re)started core has no queued saves and numbers requests from 1 again.
  clear(): void {
    this.pending.clear();
    this.finished.length = 0;
  }

  // Applies a core event; true when it concerned clip saves.
  apply(type: string, params: Record<string, unknown>): boolean {
    switch (type) {
      case "ready": this.clear(); return true;
      case "clip.queued": this.queued(params.request); return true;
      case "clip.saved":
      case "clip.dropped": this.settled(params.request); return true;
      case "error":
        if (params.request === undefined) return false;
        this.settled(params.request);
        return true;
      default: return false;
    }
  }
}
