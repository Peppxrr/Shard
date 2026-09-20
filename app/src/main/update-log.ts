import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { DevConsoleLine } from "../shared/contracts";

// A bounded log survives the restart, including startup checks before any UI
// exists. Serial writes keep rotation and message order deterministic.
export function createUpdateLog(directory: string, feed: (line: DevConsoleLine) => void) {
  const file = path.join(directory, "updates.log");
  let writes = Promise.resolve();
  const write = (severity: string, values: unknown[]) => {
    const message = values.map(value => value instanceof Error ? value.stack ?? value.message : String(value)).join(" ")
      .replace(/https?:\/\/[^\s"<>]+/g, url => {
        try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return "[URL]"; }
      }).slice(0, 8000);
    const line: DevConsoleLine = { t: Date.now(), level: "updates", text: `[${severity}] ${message}` };
    feed(line);
    writes = writes.then(async () => {
      await mkdir(directory, { recursive: true });
      if (((await stat(file).catch(() => null))?.size ?? 0) > 2 * 1024 * 1024)
        await rename(file, `${file}.1`);
      await appendFile(file, `${new Date(line.t).toISOString()} ${line.text}\n`, "utf8");
    }).catch(error => console.error("[updates] Could not write update log", error));
  };
  return {
    info: (...values: unknown[]) => write("info", values),
    warn: (...values: unknown[]) => write("warn", values),
    error: (...values: unknown[]) => write("error", values),
    debug: (...values: unknown[]) => write("debug", values),
    flush: () => writes,
  };
}
