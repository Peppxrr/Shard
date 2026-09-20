import assert from "node:assert/strict";
import { measurePlayback } from "../src/renderer/editor/playbackDiagnostics.ts";

const originals = Object.fromEntries(["window", "document", "performance", "PerformanceObserver"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let now = 0;
let timeout;
Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now } });
globalThis.window = { setTimeout: callback => { timeout = callback; return 0; } };
globalThis.document = Object.assign(new EventTarget(), { hidden: false });
globalThis.PerformanceObserver = class { static supportedEntryTypes = []; };
try {
  const makeVideo = () => Object.assign(new EventTarget(), {
    paused: false, ended: false, currentTime: 0, frames: 0, dropped: 0,
    getVideoPlaybackQuality() { return { totalVideoFrames: this.frames, droppedVideoFrames: this.dropped }; },
  });
  for (const event of ["pause", "ended", "seeking"]) {
    now = 0;
    const video = makeVideo();
    const measured = measurePlayback(video, new AbortController().signal);
    now = 4000;
    video.frames = 240;
    video.currentTime = 4;
    video.ended = event === "ended";
    video.dispatchEvent(new Event(event));
    const report = await measured;
    assert.equal(report.sampleSeconds, 4);
    assert.equal(report.presentedFps, 60, "four seconds of playback must not be divided by five");
    assert.equal(report.reliableSample, event !== "seeking");
  }
  now = 0;
  const video = makeVideo();
  const measured = measurePlayback(video, new AbortController().signal);
  now = 5000;
  video.frames = 300;
  video.dropped = 60;
  timeout();
  const report = await measured;
  assert.equal(report.presentedFps, 48, "real dropped frames remain visible");
  assert.equal(report.droppedFrames, 60);
  await assert.rejects(measurePlayback(Object.assign(makeVideo(), { paused: true }), new AbortController().signal), /Start playback/);
  const controller = new AbortController();
  const aborted = measurePlayback(makeVideo(), controller.signal);
  controller.abort();
  await assert.rejects(aborted, /cancelled/);
} finally {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
console.log("playback diagnostics passed: early stop, genuine drops, paused start, cancellation");
