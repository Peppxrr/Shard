import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TimelinePreviews } from "../src/main/timeline-previews.ts";

const executable = path.resolve("resources/core-bin/ffmpeg.exe");
const parent = path.resolve("../tmp");
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, "timeline-preview-test-"));
const cache = path.join(root, "cache");
const service = new TimelinePreviews(cache, executable);
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(executable, ["-y", "-v", "error", ...args], { windowsHide: true });
  let diagnostic = "";
  child.stderr.on("data", (data) => { diagnostic += data; });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve() : reject(new Error(diagnostic)));
});

try {
  const fixture = path.join(root, "moving.mp4");
  await run(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=8", "-c:v", "libx264", "-g", "48", fixture]);
  const updates = [];
  const frames = await service.generate(fixture, 8, 8, (snapshot) => updates.push(snapshot));
  assert.equal(frames.length, 8);
  assert(updates.some((snapshot) => snapshot.filter(Boolean).length > 0 && snapshot.filter(Boolean).length < 8), "frames arrive before the batch finishes");
  assert(updates.every((snapshot) => snapshot.length === 8), "sample positions never shift as frames arrive");
  const hashes = await Promise.all(frames.map(async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex")));
  assert(new Set(hashes).size > 4, "previews sample different points in the source");
  const originalTimes = await Promise.all(frames.map(async (file) => (await fs.stat(file)).mtimeMs));
  const warm = await service.generate(fixture, 8, 8);
  assert.deepEqual(warm, frames);
  assert.deepEqual(await Promise.all(warm.map(async (file) => (await fs.stat(file)).mtimeMs)), originalTimes, "warm requests never regenerate images");

  // Cancellation leaves committed images reusable, kills outstanding decoders,
  // and an immediate reopen waits for the old job to drain before resuming.
  const controller = new AbortController();
  let partial;
  const cancelled = service.generate(fixture, 8, 12, (snapshot) => {
    if (snapshot.filter(Boolean).length === 1) { partial = snapshot.find(Boolean); controller.abort(); }
  }, controller.signal);
  await assert.rejects(cancelled, /cancelled/);
  assert(partial);
  const partialTime = (await fs.stat(partial)).mtimeMs;
  const resumed = await service.generate(fixture, 8, 12);
  assert.equal(resumed.filter(Boolean).length, 12);
  assert.equal((await fs.stat(partial)).mtimeMs, partialTime, "resume preserves completed samples");

  const a = new AbortController();
  const requestA = service.generate(fixture, 8, 16, (snapshot) => {
    if (snapshot.some(Boolean)) a.abort();
  }, a.signal);
  const requestB = service.generate(fixture, 8, 16);
  await assert.rejects(requestA, /cancelled/);
  assert.equal((await requestB).filter(Boolean).length, 16, "one subscriber cancelling cannot kill another's decoder");
  await assert.rejects(service.generate(fixture, 8, NaN), /Invalid/);
  await assert.rejects(service.generate(path.join(root, "missing.mp4"), 8, 8));
  await service.remove(fixture);
  assert.equal((await fs.readdir(cache)).length, 0, "deleting a clip removes all its thumbnail variants");
  const active = service.generate(fixture, 8, 24);
  const activeFailure = assert.rejects(active, /deleted/);
  // Wait for the initial cache scan before deleting while decoders are running.
  await new Promise((resolve) => setTimeout(resolve, 40));
  await service.remove(fixture);
  await activeFailure;
  assert.equal((await fs.readdir(cache)).length, 0, "deletion waits for active writers; cancelled jobs cannot recreate the cache");
  const unavailable = new TimelinePreviews(path.join(root, "unavailable"), path.join(root, "missing-ffmpeg.exe"));
  await assert.rejects(unavailable.generate(fixture, 8, 8));
  unavailable.dispose();
  await assert.rejects(unavailable.generate(fixture, 8, 8), /stopped/);
  console.log("PASS: progressive positions, distinct samples, cache reuse, cancellation/resume, shared jobs, validation, active deletion, unavailable decoder, shutdown");

  if (process.argv[2]) {
    const source = path.resolve(process.argv[2]);
    const duration = Number(process.argv[3]);
    const oldDirectory = path.join(root, "old");
    await fs.mkdir(oldDirectory);
    const before = performance.now();
    await run(["-i", source, "-an", "-vf", `fps=36/${duration},scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2:color=black`, "-frames:v", "36", "-q:v", "5", path.join(oldDirectory, "frame-%03d.jpg")]);
    const oldMs = performance.now() - before;
    const start = performance.now();
    let firstMs;
    await service.generate(source, duration, 12, (snapshot) => { if (firstMs === undefined && snapshot.some(Boolean)) firstMs = performance.now() - start; });
    const coldMs = performance.now() - start;
    const repeat = performance.now();
    await service.generate(source, duration, 12);
    const report = { source, duration, oldFrames: 36, overviewFrames: 12, oldBatchMs: Math.round(oldMs), firstFrameMs: Math.round(firstMs), completeMs: Math.round(coldMs), cachedMs: Math.round(performance.now() - repeat) };
    console.log(JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(parent, "timeline-preview-benchmark.json"), JSON.stringify(report, null, 2));
  }
} finally {
  service.dispose();
  await fs.rm(root, { recursive: true, force: true });
}
