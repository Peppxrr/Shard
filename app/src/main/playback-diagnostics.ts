import { app, BrowserWindow, clipboard, screen } from "electron";
import type { WebContents } from "electron";

const properties = new Set([
  "kVideoDecoderName", "kIsPlatformVideoDecoder", "kVideoTracks", "kResolution",
  "kFramerate", "kVideoPlaybackRoughness", "kVideoPlaybackFreezing", "kRendererName",
]);

async function deadline<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Diagnostic query timed out")), ms);
    })]);
  } finally { clearTimeout(timer!); }
}

// Media.enable replays properties for existing players. Only attach on demand,
// never take over an existing debugger or retain URLs/file paths in the report.
async function decoderProperties(contents: WebContents): Promise<object> {
  const debug = contents.debugger;
  if (debug.isAttached() || contents.isDevToolsOpened()) return { unavailable: "DevTools/debugger already open" };
  const players: Record<string, Record<string, string>> = {};
  let owned = false;
  const detached = () => { owned = false; };
  const message = (_event: unknown, method: string, params: { playerId?: string; properties?: Array<{ name: string; value: string }> }) => {
    if (method !== "Media.playerPropertiesChanged" || !params.playerId || !Array.isArray(params.properties)) return;
    for (const property of params.properties) {
      if (properties.has(property.name) && typeof property.value === "string") {
        (players[params.playerId] ??= {})[property.name] = property.value.slice(0, 4000);
      }
    }
  };
  try {
    debug.attach("1.3");
    owned = true;
    debug.on("detach", detached);
    debug.on("message", message);
    await deadline(debug.sendCommand("Media.enable"));
    await new Promise(resolve => setTimeout(resolve, 500));
    return Object.keys(players).length ? { players } : { unavailable: "Chromium did not expose current decoder properties" };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  } finally {
    debug.removeListener("message", message);
    debug.removeListener("detach", detached);
    if (owned && debug.isAttached()) debug.detach();
  }
}

const pending = new Set<number>();
export async function createPlaybackReport(contents: WebContents, sampleJson: string): Promise<string> {
  if (typeof sampleJson !== "string" || sampleJson.length > 16000) throw new Error("Invalid playback report");
  const sample: unknown = JSON.parse(sampleJson);
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) throw new Error("Invalid playback sample");
  if (pending.has(contents.id)) throw new Error("A playback report is already being collected");
  pending.add(contents.id);
  try {
    const [gpu, decoder] = await Promise.all([
      deadline(app.getGPUInfo("basic")).catch(() => null), decoderProperties(contents),
    ]);
    const window = BrowserWindow.fromWebContents(contents);
    const display = window ? screen.getDisplayMatching(window.getBounds()) : null;
    const info = gpu as { gpuDevice?: unknown[]; auxAttributes?: { driverVersion?: string; glRenderer?: string } } | null;
    return JSON.stringify({
      report: "Shard playback diagnostics", version: app.getVersion(), electron: process.versions.electron,
      chromium: process.versions.chrome, platform: process.platform,
      gpuFeatures: app.getGPUFeatureStatus(), gpuDevices: info?.gpuDevice ?? null,
      driverVersion: info?.auxAttributes?.driverVersion ?? null,
      display: display ? { refreshRate: display.displayFrequency, scaleFactor: display.scaleFactor } : null,
      decoder, playback: sample,
      note: "GPU feature status is global; kIsPlatformVideoDecoder and kVideoDecoderName describe the actual media pipeline when available. No clip contents or file paths are included.",
    }, null, 2);
  } finally { pending.delete(contents.id); }
}

export async function copyPlaybackReport(contents: WebContents, sampleJson: string): Promise<void> {
  clipboard.writeText(await createPlaybackReport(contents, sampleJson));
}
