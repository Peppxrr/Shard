import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
// Production emits CommonJS; this source test resolves its relative TS dependency.
registerHooks({ resolve(specifier, context, next) {
  if (["./bundled-processes", "./editor-preparation"].includes(specifier)) specifier += ".ts";
  return next(specifier, context);
} });
const { TimelinePreviews } = await import("../src/main/timeline-previews.ts");
const { ownedProcesses } = await import("../src/main/bundled-processes.ts");

const stagedFfmpeg = path.resolve("resources/core-bin/ffmpeg/ffmpeg.exe");
const vendorFfmpeg = path.resolve("../vendor/ffmpeg/bin/ffmpeg.exe");
const executable = existsSync(stagedFfmpeg) ? stagedFfmpeg : vendorFfmpeg;
assert.ok(existsSync(executable), `FFmpeg test binary not found: ${executable}`);
const parent = path.resolve("../tmp");
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, "timeline-preview-test-"));
const cache = path.join(root, "cache");
let processStarts = 0;
let cacheScans = 0;
const service = new TimelinePreviews(cache, executable, {
  onProcessStart: () => { processStarts++; }, onCacheScan: () => { cacheScans++; },
});
const directoryBytes = async directory => {
  const sizes = await Promise.all((await fs.readdir(directory)).map(file => fs.stat(path.join(directory, file)).then(stat => stat.size)));
  return sizes.reduce((sum, size) => sum + size, 0);
};
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
  const overview = updates.find(snapshot => snapshot.some(Boolean));
  assert.deepEqual(overview.map((file, index) => file ? index : -1).filter(index => index >= 0), [0, 2, 4, 6], "first batch spans the width");
  assert.equal(processStarts, 2, "8 overview samples need two batched process launches");
  const hashes = await Promise.all(frames.map(async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex")));
  assert(new Set(hashes).size > 4, "previews sample different points in the source");
  const originalTimes = await Promise.all(frames.map(async (file) => (await fs.stat(file)).mtimeMs));
  const warm = await service.generate(fixture, 8, 8);
  assert.deepEqual(warm, frames);
  assert.deepEqual(await Promise.all(warm.map(async (file) => (await fs.stat(file)).mtimeMs)), originalTimes, "warm requests never regenerate images");
  const beforeDetail = processStarts;
  const detail = await service.generate(fixture, 8, 24);
  assert.equal(detail.length, 24);
  assert.equal(processStarts - beforeDetail, 6, "higher detail generates only 24 missing canonical samples");
  assert.deepEqual(await Promise.all(frames.map(async file => (await fs.stat(file)).mtimeMs)), originalTimes, "zoom preserves coarse samples");
  assert.equal((await fs.readdir(cache)).length, 1, "zoom levels share one source directory");
  const beforeZoom = processStarts;
  await service.generate(fixture, 8, 12);
  await service.generate(fixture, 8, 8);
  await service.generate(fixture, 8, 16);
  assert.equal(processStarts, beforeZoom, "lower/intermediate zoom uses existing samples");
  assert.equal(cacheScans, 1, "cached opens and zoom changes never repeat the global disk scan");

  // Cancellation leaves committed images reusable, kills outstanding decoders,
  // and an immediate reopen waits for the old job to drain before resuming.
  await service.remove(fixture);
  const controller = new AbortController();
  let partial;
  const cancelled = service.generate(fixture, 8, 12, (snapshot) => {
    if (snapshot.some(Boolean)) { partial = snapshot.find(Boolean); controller.abort(); }
  }, controller.signal);
  await assert.rejects(cancelled, /cancelled/);
  assert(partial);
  const partialTime = (await fs.stat(partial)).mtimeMs;
  const resumed = await service.generate(fixture, 8, 12);
  assert.equal(resumed.filter(Boolean).length, 12);
  assert.equal((await fs.stat(partial)).mtimeMs, partialTime, "resume preserves completed samples");

  await service.remove(fixture);
  const a = new AbortController();
  const requestA = service.generate(fixture, 8, 16, (snapshot) => {
    if (snapshot.some(Boolean)) a.abort();
  }, a.signal);
  const requestB = service.generate(fixture, 8, 16);
  await assert.rejects(requestA, /cancelled/);
  assert.equal((await requestB).filter(Boolean).length, 16, "one subscriber cancelling cannot kill another's decoder");
  const oldDirectory = path.dirname((await service.generate(fixture, 8, 8))[0]);
  const modified = new Date(Date.now() + 2000);
  await fs.utimes(fixture, modified, modified);
  const changed = await service.generate(fixture, 8, 8);
  assert.notEqual(path.dirname(changed[0]), oldDirectory, "source modification invalidates preview identity");
  assert.equal(existsSync(oldDirectory), false, "obsolete source cache is removed");
  await assert.rejects(service.generate(fixture, 8, NaN), /Invalid/);
  await assert.rejects(service.generate(path.join(root, "missing.mp4"), 8, 8));
  await service.remove(fixture);
  assert.equal((await fs.readdir(cache)).length, 0, "deleting a clip removes all its thumbnail variants");
  const openingDuringDelete = service.generate(fixture, 8, 8);
  const openingRejected = assert.rejects(openingDuringDelete, /deleted/);
  await service.remove(fixture);
  await openingRejected;
  assert.equal((await fs.readdir(cache)).length, 0, "in-flight source stat cannot recreate a deleted cache");
  const active = service.generate(fixture, 8, 24);
  const activeFailure = assert.rejects(active, /deleted/);
  // Wait for the initial cache scan before deleting while decoders are running.
  await new Promise((resolve) => setTimeout(resolve, 40));
  await service.remove(fixture);
  await activeFailure;
  assert.equal((await fs.readdir(cache)).length, 0, "deletion waits for active writers; cancelled jobs cannot recreate the cache");
  const unavailable = new TimelinePreviews(path.join(root, "unavailable"), path.join(root, "missing-ffmpeg.exe"));
  await assert.rejects(unavailable.generate(fixture, 8, 8));
  await unavailable.dispose();
  await unavailable.dispose();
  await assert.rejects(unavailable.generate(fixture, 8, 8), /stopped/);
  const shutdownStarted = Promise.withResolvers();
  const shutdownService = new TimelinePreviews(path.join(root, "shutdown"), executable, { onProcessStart: () => shutdownStarted.resolve() });
  const pendingShutdown = shutdownService.generate(fixture, 8, 24);
  const rejectedShutdown = assert.rejects(pendingShutdown, /stopped/);
  await shutdownStarted.promise;
  await shutdownService.dispose();
  await rejectedShutdown;
  assert.equal(ownedProcesses.size, 0, "dispose waits for all tracked decoders to close");
  await shutdownService.dispose();
  shutdownService.resume();
  assert.equal((await shutdownService.generate(fixture, 8, 8)).filter(Boolean).length, 8, "failed install recovery can resume previews");
  await shutdownService.dispose();

  // Use deliberate directory sizes to make eviction independent of JPEG codec
  // variation. An active directory larger than budget must survive its writes.
  const lruRoot = path.join(root, "lru");
  await fs.mkdir(lruRoot);
  for (const [name, age] of [["old", 3], ["recent", 1]]) {
    const directory = path.join(lruRoot, name);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "bytes"), Buffer.alloc(name === "old" ? 90000 : 10000));
    const timestamp = new Date(Date.now() - age * 60000);
    await fs.utimes(directory, timestamp, timestamp);
  }
  const bounded = new TimelinePreviews(lruRoot, executable, { maxBytes: 70000 });
  const boundedFrames = await bounded.generate(fixture, 8, 8);
  await bounded.dispose();
  assert.equal(existsSync(path.join(lruRoot, "old")), false, "LRU evicts oldest clip first");
  assert.equal(existsSync(path.join(lruRoot, "recent")), true, "recent cache survives when budget allows");
  assert(boundedFrames.every(existsSync), "active preview writes survive pruning");
  const directories = await fs.readdir(lruRoot);
  let diskBytes = 0;
  for (const directory of directories) {
    for (const name of await fs.readdir(path.join(lruRoot, directory))) diskBytes += (await fs.stat(path.join(lruRoot, directory, name))).size;
  }
  assert(diskBytes <= 70000, "disk usage stays inside configured global budget");
  const exhaustedRoot = path.join(root, "exhausted");
  const exhausted = new TimelinePreviews(exhaustedRoot, executable, { maxBytes: 1 });
  await assert.rejects(exhausted.generate(fixture, 8, 8), /budget exhausted/, "protected writes cannot grow beyond budget");
  await exhausted.dispose();
  assert.equal((await fs.readdir(exhaustedRoot)).length, 0, "over-budget temporary files and empty directories are removed");

  const av1 = path.join(root, "moving-av1.mp4");
  await run(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=24", "-c:v", "libaom-av1", "-cpu-used", "8", "-threads", "2", "-g", "48", "-crf", "40", av1]);
  const beforeAv1 = processStarts;
  const av1Start = performance.now();
  let av1FirstMs;
  let av1CoarseMs;
  await service.generate(av1, 24, 12, snapshot => {
    if (av1FirstMs === undefined && snapshot.some(Boolean)) av1FirstMs = performance.now() - av1Start;
    if (av1CoarseMs === undefined && snapshot.filter(Boolean).length >= 6) av1CoarseMs = performance.now() - av1Start;
  });
  const av1CompleteMs = performance.now() - av1Start;
  const av1Cached = performance.now();
  const av1Frames = await service.generate(av1, 24, 12);
  const av1CachedMs = performance.now() - av1Cached;
  assert.equal(processStarts - beforeAv1, 4, "12-frame AV1 overview uses four processes and shares cached reopen");
  const av1CacheBytes = await directoryBytes(path.dirname(av1Frames[0]));
  const totalFilmstripCacheBytes = (await Promise.all((await fs.readdir(cache)).map(directory => directoryBytes(path.join(cache, directory))))).reduce((sum, size) => sum + size, 0);
  assert.equal(cacheScans, 1, "new clips, deletions, and writes reuse the global accounting index");
  console.log(JSON.stringify({ codec: "AV1", duration: 24, firstFrameMs: Math.round(av1FirstMs), coarseMs: Math.round(av1CoarseMs), completeMs: Math.round(av1CompleteMs), cachedMs: Math.round(av1CachedMs), processes: processStarts - beforeAv1, av1CacheBytes, totalFilmstripCacheBytes }));
  console.log("PASS: canonical zoom reuse, overview-first batches, cancellation/resume, shared jobs, source invalidation, active deletion, disk budget/LRU, decoder failure, shutdown, AV1");

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
  }
} finally {
  await service.dispose();
  await fs.rm(root, { recursive: true, force: true });
}
