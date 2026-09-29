import type { DevConsoleLine } from "./contracts";

export type DevConsoleSeverity = "debug" | "info" | "warn" | "error";
export type DevConsoleStream = "stdout" | "stderr";

export interface DevConsoleFilter {
  source: string;
  severity: string;
  query: string;
}

export function classifyDevConsoleSeverity(text: string, stream?: DevConsoleStream): DevConsoleSeverity {
  // Core snapshots contain many fields named `failure_reason` or boolean
  // `*_failed=false`; only classify clear log-level markers or statements.
  if (/\[(?:(?:obs|capture-health)\]\[)?(?:fatal|error)\]|(?:^|\s)(?:fatal|error):|\b(?:failed to|could not|unable to)\s+\w+/i.test(text)) return "error";
  if (/\[(?:(?:obs|capture-health)\]\[)?warn(?:ing)?\]|(?:^|\s)warn(?:ing)?:/i.test(text)) return "warn";
  if (/\[(?:(?:obs|capture-health)\]\[)?(?:debug|trace)\]|(?:^|\s)(?:debug|trace):/i.test(text)) return "debug";
  // A stream name is a source, not a severity. stderr can carry routine
  // health details, so keep unmarked lines at the neutral info level.
  void stream;
  return "info";
}

export function devConsoleSeverity(line: DevConsoleLine): DevConsoleSeverity {
  return line.severity ?? classifyDevConsoleSeverity(line.text, line.stream);
}

export function devConsoleSource(line: DevConsoleLine): string {
  return line.level === "core" && line.stream ? `core.${line.stream}` : line.level;
}

export function filterDevConsoleLines(lines: DevConsoleLine[], filter: DevConsoleFilter): DevConsoleLine[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return lines.filter(line =>
    line.id !== 0 &&
    (filter.source === "all" ||
      (filter.source === "core" ? line.level === "core" : devConsoleSource(line) === filter.source)) &&
    (filter.severity === "all" || devConsoleSeverity(line) === filter.severity) &&
    (!query || `${line.text}\n${line.level}\n${line.stream ?? ""}`.toLocaleLowerCase().includes(query))
  );
}

export function serializeDevConsoleLines(lines: DevConsoleLine[]): string {
  return lines.map(line => {
    const timestamp = new Date(line.t).toISOString();
    const source = devConsoleSource(line);
    return `${timestamp} [${source}] [${devConsoleSeverity(line)}] ${line.text}`;
  }).join("\n");
}
