// Chromium owns playback. Editor preparation gets one FFmpeg process slot,
// yielding between jobs/batches so waveforms precede encoders and zoom detail.
export type PreparationPriority = "waveform" | "filmstrip-coarse" | "audio" | "filmstrip-detail" | "background";
const priorities: PreparationPriority[] = ["waveform", "filmstrip-coarse", "audio", "filmstrip-detail", "background"];
type Priority = PreparationPriority | (() => PreparationPriority);
type Entry = { priority: Priority; start: () => Promise<void> };
const queue: Entry[] = [];
let running = false;
let scheduled = false;

export function runEditorPreparation<T>(priority: Priority, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      reject(new Error("Editor preparation cancelled"));
    };
    const entry: Entry = { priority, start: async () => {
      signal.removeEventListener("abort", cancel);
      try { signal.throwIfAborted(); resolve(await task()); } catch (error) { reject(error); }
    } };
    signal.addEventListener("abort", cancel, { once: true });
    queue.push(entry);
    pump();
  });
}

function pump(): void {
  if (running || scheduled || !queue.length) return;
  scheduled = true;
  // Defer once so requests arriving together can be ordered by priority.
  setImmediate(() => {
    scheduled = false;
    // Queued filmstrip warmups can become foreground when the editor opens.
    const rank = (entry: Entry) => priorities.indexOf(typeof entry.priority === "function" ? entry.priority() : entry.priority);
    queue.sort((a, b) => rank(a) - rank(b));
    const entry = queue.shift();
    if (!entry) return;
    running = true;
    void entry.start().finally(() => { running = false; pump(); });
  });
}
