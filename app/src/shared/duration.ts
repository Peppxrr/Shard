// One forgiving duration grammar for every typed duration in the app.
// A unit is recognized by its first letter (h, m, s), so "5m", "5 min",
// "5 minutes" and "5M" all mean the same thing. Units may be combined
// ("1h 30m", "1m30s"), clock notation works ("1:30", "1:02:03"), and a
// bare number is seconds.

const UNIT_SECONDS: Record<string, number> = { h: 3600, m: 60, s: 1 };

export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  if (/^\d+(:\d{1,2}){1,2}$/.test(text)) {
    const parts = text.split(":").map(Number);
    if (parts.slice(1).some(part => part >= 60)) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  const token = /(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)\s*/gy;
  let total = 0;
  let consumed = 0;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    const scale = match[2] ? UNIT_SECONDS[match[2][0]] : 1;
    if (!scale) return null;
    total += Number(match[1]) * scale;
    consumed = token.lastIndex;
  }
  return consumed === text.length && Number.isFinite(total) ? Math.round(total) : null;
}

export interface DurationPart { value: number; unit: "h" | "m" | "s" }

// Exact parts for settings values ("1h 5s"); `coarse` drops seconds from
// hour-long values so live counters stay short ("1h 2m").
export function durationParts(seconds: number, coarse = false): DurationPart[] {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor(whole % 3600 / 60);
  const s = whole % 60;
  const parts: DurationPart[] = [];
  if (h) parts.push({ value: h, unit: "h" });
  if (m || (coarse && h)) parts.push({ value: m, unit: "m" });
  if (s && !(coarse && h)) parts.push({ value: s, unit: "s" });
  return parts.length ? parts : [{ value: 0, unit: "s" }];
}

export function formatDuration(seconds: number, coarse = false): string {
  return durationParts(seconds, coarse).map(part => `${part.value}${part.unit}`).join(" ");
}

const UNIT_WORD = { h: "hour", m: "minute", s: "second" } as const;
export function formatDurationLong(seconds: number): string {
  return durationParts(seconds).map(({ value, unit }) => `${value} ${UNIT_WORD[unit]}${value === 1 ? "" : "s"}`).join(" ");
}
