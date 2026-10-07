// Validation for frame-loss data that crosses process boundaries (core
// events, SQLite rows). Mirrors the shapes in contracts.ts.
import type { ClipLagInfo, ClipLagSegment, PerfCause } from "./contracts";

const CAUSES: readonly PerfCause[] = ["ok", "gpu_starved", "render_stall", "encoder_overloaded"];

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function cause(value: unknown): PerfCause {
  return CAUSES.find(item => item === value) ?? "ok";
}

// Returns null for anything that is not a lag record; drops malformed
// segments instead of rejecting the whole record.
export function parseClipLag(value: unknown): ClipLagInfo | null {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || !("segments" in value) || !Array.isArray(value.segments)) return null;
  const record = value as Record<string, unknown>;
  const segments: ClipLagSegment[] = [];
  for (const item of value.segments as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const segment = item as Record<string, unknown>;
    const start = Number(segment.start);
    const end = Number(segment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || start < 0) continue;
    segments.push({ start, end, lagged: count(segment.lagged), skipped: count(segment.skipped), cause: cause(segment.cause) });
  }
  return {
    frames: count(record.frames),
    lagged: count(record.lagged),
    skipped: count(record.skipped),
    cause: cause(record.cause),
    segments,
  };
}

export const PERF_CAUSE_LABEL: Record<PerfCause, string> = {
  ok: "No dropped frames",
  gpu_starved: "GPU maxed out",
  render_stall: "Render stall",
  encoder_overloaded: "Encoder overloaded",
};
