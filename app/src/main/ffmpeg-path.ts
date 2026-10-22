// ffmpeg-path.ts — locates the editor/export FFmpeg tools. The bundled build
// in core-bin/ffmpeg wins; outside Windows the system ffmpeg/ffprobe on PATH
// is the fallback (Linux builds do not have to bundle FFmpeg). No Electron
// import, so the source tests resolve tools exactly like the app.
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export type FfmpegTool = "ffmpeg" | "ffprobe";

export function resolveFfmpegTool(tool: FfmpegTool, directories: readonly string[]): string {
  const file = process.platform === "win32" ? `${tool}.exe` : tool;
  for (const directory of directories) {
    const candidate = path.join(directory, file);
    if (isExecutable(candidate)) return candidate;
  }
  if (process.platform !== "win32") {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!directory) continue;
      const candidate = path.join(directory, file);
      if (isExecutable(candidate)) return candidate;
    }
    throw new Error(`${tool} not found in ${directories.join(", ") || "the bundled tools"} or on PATH; install FFmpeg`);
  }
  throw new Error(`${file} not found in ${directories.join(", ") || "the bundled tools"}; reinstall Shard`);
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
