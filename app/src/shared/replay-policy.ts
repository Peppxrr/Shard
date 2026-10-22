import type { Settings } from "./contracts";

export const MAX_CAPTURE_SECONDS = 2_147_483_647;
const MIN_MEMORY_MB = 256;
const DECODE_PREROLL_SECONDS = 2;

function positiveSeconds(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(MAX_CAPTURE_SECONDS, Math.max(1, Math.round(value))) : fallback;
}

export function replayHotkeyMinimum(settings: Settings): number {
  return settings.hotkeys.reduce((seconds, hotkey) => hotkey.action === "save_clip" && hotkey.accelerator.trim()
    ? Math.max(seconds, positiveSeconds(hotkey.durationSec, 60)) : seconds, 30);
}

// Match EncoderManager::effectiveBitrateKbps and ReplayRing's stable audio
// tracks (master + up to five rows, including disabled rows), each at 160 kbps.
// Allow 20% bitrate headroom and the ring's two-second decode preroll. This is
// an encoded-size estimate; the ring still enforces its real packet byte cap.
function replayMbPerSecond(settings: Settings): number {
  const video = settings.video;
  const bitrate = video.preset === "low" ? 4000 : video.preset === "high" ? 16000
    : video.preset === "custom" ? Math.max(1, video.bitrateKbps || 8000) : 8000;
  const tracks = 1 + Math.min(settings.audio.sources.length, 5);
  return (bitrate + tracks * 160) * 1000 / 8 / 1024 ** 2 * 1.2;
}

export function replayMemoryMb(settings: Settings, seconds: number): number {
  return Math.max(MIN_MEMORY_MB, Math.ceil((seconds + DECODE_PREROLL_SECONDS) * replayMbPerSecond(settings)));
}

// One policy for live drafts, persisted settings and the payload sent to core.
// Editing memory changes duration; editing duration changes memory. Bound
// shortcuts always win over either field so their requested history can fit.
export function reconcileReplaySettings(next: Settings, previous?: Settings): Settings {
  const minimum = replayHotkeyMinimum(next);
  const memory = Number.isFinite(next.replay.maxMb) ? Math.max(MIN_MEMORY_MB, Math.round(next.replay.maxMb)) : 2048;
  const memoryEdited = previous && memory !== previous.replay.maxMb && next.replay.maxSeconds === previous.replay.maxSeconds;
  const maxSeconds = Math.max(minimum, memoryEdited
    ? Math.min(MAX_CAPTURE_SECONDS, Math.floor(memory / replayMbPerSecond(next) - DECODE_PREROLL_SECONDS))
    : positiveSeconds(next.replay.maxSeconds, 600));
  const durationChanged = previous && maxSeconds !== previous.replay.maxSeconds;
  const rateChanged = previous && replayMbPerSecond(previous) !== replayMbPerSecond(next);
  const requiredMb = replayMemoryMb(next, maxSeconds);
  return { ...next, replay: { ...next.replay, maxSeconds,
    maxMb: (durationChanged && !memoryEdited) || rateChanged ? requiredMb : Math.max(memory, requiredMb) },
    game: { ...next.game, graceSeconds: Number.isFinite(next.game.graceSeconds)
      ? Math.min(MAX_CAPTURE_SECONDS, Math.max(0, Math.round(next.game.graceSeconds))) : 15 } };
}
