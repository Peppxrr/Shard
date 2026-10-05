import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, utimes, symlink, unlink, rmdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import {
  clipAt,
  clipEnd,
  commitHistory,
  createRulerTicks,
  formatRulerTime,
  zoomScrollOffset,
  createTimelineGeometry,
  pixelsPerSecond,
  createEditorState,
  createHistory,
  deleteClip,
  linkAudio,
  moveClip,
  outputDuration,
  pixelToTime,
  redoHistory,
  separateAudio,
  snapOffset,
  snapTargets,
  splitAllTracks,
  splitClip,
  timeToPixel,
  trackClips,
  trimClip,
  undoHistory,
} from "../src/renderer/editor/model.ts";
import { buildExportGraph, exportTimelineDuration, resolveExportAudioTracks, validateTimelineClips } from "../src/main/export-graph.ts";
import { buildVideoEncoderArgs, pickExportResolution } from "../src/main/export-video.ts";
import { existsSync, statSync } from "node:fs";
import "./test-playback-diagnostics.mjs";

const editorCacheDirectory = await mkdtemp(path.join(os.tmpdir(), "shard-editor-cache-test-"));
registerHooks({ resolve(specifier, context, next) {
  if (["./bundled-processes", "./timeline-previews", "./editor-preparation", "./waveform-cache"].includes(specifier)) specifier += ".ts";
  if (specifier === "electron") return {
    url: `data:text/javascript,${encodeURIComponent(`export const app = { getPath: () => ${JSON.stringify(editorCacheDirectory)}, getAppPath: () => process.cwd() };`)}`,
    shortCircuit: true,
  };
  return next(specifier, context);
} });
const { generateWaveform, prepareAudioPreview, removeEditorMedia } = await import("../src/main/ffmpeg.ts");
const { encodeWaveform, decodeWaveform } = await import("../src/main/waveform-cache.ts");
const { runEditorPreparation } = await import("../src/main/editor-preparation.ts");
const { ownedProcesses } = await import("../src/main/bundled-processes.ts");

// Queue priority and cancellation are deterministic even when callers race.
const order = [];
const signal = new AbortController().signal;
const gate = Promise.withResolvers();
const started = Promise.withResolvers();
const blocker = runEditorPreparation("background", signal, async () => { started.resolve(); await gate.promise; });
await started.promise;
const aborted = new AbortController();
const queueCancelled = runEditorPreparation("audio", aborted.signal, async () => { assert.fail("cancelled task ran"); });
const queueFailure = assert.rejects(queueCancelled, /cancelled/);
aborted.abort();
const ordered = ["filmstrip-detail", "audio", "filmstrip-coarse", "waveform"].map(priority =>
  runEditorPreparation(priority, signal, async () => { order.push(priority); }));
let promotedPriority = "background";
const promoted = runEditorPreparation(() => promotedPriority, signal, async () => { order.push("promoted"); });
promotedPriority = "filmstrip-coarse";
gate.resolve();
await Promise.all([blocker, queueFailure, ...ordered, promoted]);
assert.deepEqual(order, ["waveform", "filmstrip-coarse", "promoted", "audio", "filmstrip-detail"]);

assert.deepEqual(pickExportResolution("720p", {w:3440,h:1440}), {w:1720,h:720});
assert.deepEqual(pickExportResolution("1080p", {w:2560,h:1600}), {w:1728,h:1080});
assert.deepEqual(pickExportResolution("720p", {w:1280,h:960}), {w:960,h:720});
assert.deepEqual(pickExportResolution("source", {w:1366,h:768}), {w:1366,h:768});
assert.deepEqual(pickExportResolution("1080p", {w:800,h:600}), {w:800,h:600});

const audioTracks = [
  { streamIndex: 1, audioIndex: 0, codec: "aac", name: "Game", kind: "output", channels: 2, sampleRate: 48000 },
  { streamIndex: 2, audioIndex: 1, codec: "aac", name: "Microphone", kind: "input", channels: 1, sampleRate: 48000 },
];

const availableAudioTracks = (count) => Array.from({ length: count }, (_, audioIndex) => ({
  streamIndex: audioIndex + 1,
  audioIndex,
  codec: "aac",
  name: `Audio ${audioIndex + 1}`,
  kind: "unknown",
  channels: 2,
  sampleRate: 48000,
  bitRate: 128000,
}));
const wholeSecond = [{ timelineStart: 0, sourceStart: 0, sourceEnd: 0.75 }];
const requestedAudioTracks = (count, clips = wholeSecond) => Array.from({ length: count }, (_, audioIndex) => ({
  streamIndex: audioIndex + 1,
  name: `Audio ${audioIndex + 1}`,
  included: true,
  muted: false,
  volume: 1,
  clips,
}));
assert.equal(resolveExportAudioTracks(availableAudioTracks(1), requestedAudioTracks(1), 1).length, 1);
const twentyResolvedTracks = resolveExportAudioTracks(availableAudioTracks(20), requestedAudioTracks(20), 1);
assert.deepEqual(twentyResolvedTracks.map((track) => track.streamIndex), Array.from({ length: 20 }, (_, index) => index + 1));
assert.deepEqual(twentyResolvedTracks[0].clips, wholeSecond);
assert.deepEqual(
  resolveExportAudioTracks(availableAudioTracks(2), requestedAudioTracks(2).map((track) => ({ ...track, included: false })), 1),
  [],
  "explicitly excluded audio tracks must produce a video-only export",
);
assert.throws(
  () => resolveExportAudioTracks(availableAudioTracks(1), [...requestedAudioTracks(1), ...requestedAudioTracks(1)], 1),
  /selected more than once/,
);
assert.throws(
  () => resolveExportAudioTracks(availableAudioTracks(1), requestedAudioTracks(1, [
    { timelineStart: 0, sourceStart: 0, sourceEnd: 0.5 },
    { timelineStart: 0.4, sourceStart: 0.5, sourceEnd: 0.9 },
  ]), 1),
  /overlap/,
  "overlapping clips on one audio track are rejected",
);

// Clip timeline: split, delete (leaves black), move (closes the gap), trim.
const placement = (clips) => clips.map((clip) => [clip.timelineStart, clip.sourceStart, clip.sourceEnd]);
let state = createEditorState(60, audioTracks);
state = splitClip(state, "video", 25);
state = splitClip(state, "video", 35);
assert.deepEqual(placement(state.videoClips), [[0, 0, 25], [25, 25, 35], [35, 35, 60]]);
assert.equal(state.selection.clipId, state.videoClips[2].id, "split selects the right-hand clip");
assert.equal(splitClip(state, "video", 25.01), state, "splits shorter than the minimum clip are refused");
state = deleteClip(state, "video", state.videoClips[1].id);
assert.deepEqual(placement(state.videoClips), [[0, 0, 25], [35, 35, 60]]);
assert.equal(clipAt(state.videoClips, 30), null, "deleted time stays empty (exports black)");
assert.equal(outputDuration(state), 60, "a gap does not shorten the output");
const lastId = state.videoClips[1].id;
assert.equal(moveClip(state, "video", lastId, 10).videoClips[1].timelineStart, 25, "a moved clip stops at its neighbour");
state = moveClip(state, "video", lastId, 25);
assert.deepEqual(placement(state.videoClips), [[0, 0, 25], [25, 35, 60]]);
assert.equal(outputDuration(state), 50, "closing the gap shortens the output");
assert.equal(moveClip(state, "video", state.videoClips[0].id, -5), state, "clips cannot move before 0");
state = trimClip(state, "video", state.videoClips[0].id, "start", 5);
assert.deepEqual(placement(state.videoClips)[0], [5, 5, 25], "trimming a start keeps the end in place");
state = trimClip(state, "video", state.videoClips[0].id, "start", -10);
assert.deepEqual(placement(state.videoClips)[0], [0, 0, 25], "a start cannot reach before the source");
state = trimClip(state, "video", state.videoClips[0].id, "end", 40);
assert.equal(clipEnd(state.videoClips[0]), 25, "an end cannot overlap the next clip");
state = trimClip(state, "video", state.videoClips[1].id, "end", 80);
assert.equal(state.videoClips[1].sourceEnd, 60, "an end cannot pass the source end");

// Separated audio keeps its own clips; video edits no longer touch it.
let separated = separateAudio(createEditorState(30, audioTracks));
const gameClip = separated.audioTracks[0].clips[0];
separated = trimClip(separated, "video", separated.videoClips[0].id, "end", 20);
assert.deepEqual(placement(separated.audioTracks[0].clips), [[0, 0, 30]], "trimming video leaves separated audio untrimmed");
separated = trimClip(separated, 1, gameClip.id, "start", 4);
assert.deepEqual(placement(separated.audioTracks[0].clips), [[4, 4, 30]]);
assert.deepEqual(placement(separated.videoClips), [[0, 0, 20]], "trimming audio leaves video untouched");
separated = moveClip(separated, 1, gameClip.id, 10);
assert.equal(outputDuration(separated), 36, "an audio clip past the last video clip extends the output");
assert.equal(trackClips(linkAudio(separated), 1), linkAudio(separated).videoClips, "linking makes audio follow the video clips");
assert.deepEqual(placement(trackClips(createEditorState(30, audioTracks), 2)), [[0, 0, 30]]);

// S razors through every track under the playhead; tracks with nothing there are untouched.
let razored = splitAllTracks(separated, 15);
assert.deepEqual(placement(razored.videoClips), [[0, 0, 15], [15, 15, 20]]);
assert.deepEqual(placement(razored.audioTracks[0].clips), [[10, 4, 9], [15, 9, 30]]);
assert.deepEqual(placement(razored.audioTracks[1].clips), [[0, 0, 15], [15, 15, 30]]);
razored = splitAllTracks(razored, 5);
assert.deepEqual(placement(razored.audioTracks[0].clips), [[10, 4, 9], [15, 9, 30]], "a track with no clip at the playhead is not split");
assert.equal(razored.videoClips.length, 3);
assert.equal(razored.audioTracks[1].clips.length, 3);

// Snapping: nearest edge within the threshold wins; the dragged clip never snaps to itself.
assert.deepEqual(snapOffset([9.875, 19.875], [0, 10, 25], 0.25), { offset: 0.125, target: 10 });
assert.deepEqual(snapOffset([12], [0, 10, 25], 0.2), { offset: 0, target: null });
const targets = snapTargets(separated, "video", separated.videoClips[0].id, 7);
assert(targets.includes(7) && targets.includes(10) && targets.includes(36), "playhead and other tracks' edges are targets");
assert(!targets.includes(20), "the dragged clip's own edges are not targets");

const px = timeToPixel(12.5, 20, 40);
assert.equal(px, 210);
assert.equal(pixelToTime(px, 20, 40), 12.5);

// Ruler subdivisions and labels must stay unique at fractional zoom scales.
for (const duration of [3, 60, 300, 3605]) {
  for (const zoom of [1, 1.4, 3.84, 8, 16]) {
    const scale = pixelsPerSecond(duration, 1000, zoom);
    const ticks = createRulerTicks(duration, scale);
    const labels = ticks.filter((tick) => tick.label !== null);
    assert.equal(new Set(labels.map((tick) => tick.label)).size, labels.length, "fractional ticks never repeat whole-second labels");
    assert.equal(new Set(ticks.map((tick) => tick.time)).size, ticks.length);
    assert(ticks.some((tick) => tick.label === null), "minor ticks are always present");
    assert(ticks.every((tick) => tick.time <= duration + 0.000001));
    // Coordinates remain continuous through scrolling and zoom, without snapping.
    const scroll = 0.4 * duration * scale;
    const geometry = createTimelineGeometry(() => ({ left: 180 - scroll, width: duration * scale }), duration, scale);
    const target = duration * 0.43 + 0.123;
    assert(Math.abs(geometry.clientXToTime(180 - scroll + target * scale) - target) < 1e-8);
  }
}
const overview = createRulerTicks(60, 16);
assert.deepEqual(overview.filter((tick) => tick.time <= 5).map((tick) => tick.time), [0, 1, 2, 3, 4, 5]);
assert.deepEqual(overview.filter((tick) => tick.time <= 5 && tick.label !== null).map((tick) => tick.label), ["0:00", "0:05"]);
assert.equal(formatRulerTime(0.25, 0.25), "0:00.25");
assert.equal(formatRulerTime(59.999999999, 0.1), "1:00.0");
assert.equal(formatRulerTime(3600.25, 0.25), "1:00:00.25");
const anchoredScroll = zoomScrollOffset(400, 250, 20, 40, 1000, 300);
assert.equal((400 + 250) / 20, (anchoredScroll + 250) / 40, "Ctrl-wheel keeps the time under the cursor fixed");
assert.equal(zoomScrollOffset(anchoredScroll, 250, 40, 20, 1000, 300), 400, "zoom round trip preserves scroll position");
assert.equal(zoomScrollOffset(4000, 900, 40, 1000 / 300, 1000, 300), 0, "fit clears horizontal scroll");

let history = createHistory(createEditorState(30, audioTracks));
history = commitHistory(history, splitClip(history.present, "video", 10));
assert.equal(history.present.videoClips.length, 2);
history = undoHistory(history);
assert.equal(history.present.videoClips.length, 1);
history = redoHistory(history);
assert.equal(history.present.videoClips.length, 2);

const graph = buildExportGraph(
  [{ timelineStart: 0, sourceStart: 0, sourceEnd: 1 }, { timelineStart: 1, sourceStart: 2, sourceEnd: 4 }],
  [
    { streamIndex: 1, audioIndex: 0, name: "Game", included: true, muted: false, volume: 1,
      clips: [{ timelineStart: 0, sourceStart: 0, sourceEnd: 1 }, { timelineStart: 1, sourceStart: 2, sourceEnd: 4 }] },
    { streamIndex: 2, audioIndex: 1, name: "Microphone", included: true, muted: false, volume: 0.8,
      clips: [{ timelineStart: 0, sourceStart: 0, sourceEnd: 1 }, { timelineStart: 1, sourceStart: 2, sourceEnd: 4 }] },
  ],
  320,
  180,
  30,
);
assert.match(graph.filter, /\[0:v:0\]trim=start=2:end=4,setpts=PTS-STARTPTS,scale=320:180,setsar=1\[vp1\]/);
assert.match(graph.filter, /\[vp0\]\[vp1\]concat=n=2:v=1:a=0\[v\]/);
assert.match(graph.filter, /\[0:1\]atrim=start=0:end=1/);
assert.match(graph.filter, /\[a1_0\]\[a1_1\]concat=n=2:v=0:a=1,volume=0\.8\[am1\]/);
assert(!graph.filter.includes("color="), "a gapless timeline has no black fillers");
assert.deepEqual(graph.maps, ["-map", "[v]", "-map", "[amix]"]);
assert.deepEqual(graph.audioOutputs.map((output) => output.name), ["Audio Mix"]);

// Gaps become black video and silent audio; output runs to the latest clip end.
const gapAudio = { streamIndex: 1, audioIndex: 0, name: "Game", included: true, muted: false, volume: 1,
  clips: [{ timelineStart: 2, sourceStart: 1, sourceEnd: 2 }] };
assert.equal(exportTimelineDuration([{ timelineStart: 0.5, sourceStart: 0, sourceEnd: 1 }], [gapAudio]), 3);
assert.equal(exportTimelineDuration([{ timelineStart: 0.5, sourceStart: 0, sourceEnd: 1 }], [{ ...gapAudio, included: false }]), 1.5);
const gapGraph = buildExportGraph([{ timelineStart: 0.5, sourceStart: 0, sourceEnd: 1 }], [gapAudio], 320, 180, 60);
assert.match(gapGraph.filter, /^color=c=black:s=320x180:r=60:d=0\.5,setsar=1\[vp0\]/);
assert.match(gapGraph.filter, /color=c=black:s=320x180:r=60:d=1\.5,setsar=1\[vp2\]/);
assert.match(gapGraph.filter, /anullsrc=r=48000:cl=stereo,atrim=duration=2,/);
const audioOnlyGraph = buildExportGraph([], [gapAudio], 320, 180, 60);
assert.match(audioOnlyGraph.filter, /^color=c=black:s=320x180:r=60:d=3,setsar=1\[vp0\];\[vp0\]concat=n=1:v=1:a=0\[v\]/);
assert.throws(() => buildExportGraph([], [], 320, 180, 60), /no clips/);
assert.throws(() => buildExportGraph([], [{ ...gapAudio, included: false }], 320, 180, 60), /no clips/);

assert.throws(() => validateTimelineClips([{ timelineStart: 0, sourceStart: 4, sourceEnd: 2 }], 5, "Video"), /too short/);
assert.throws(() => validateTimelineClips([{ timelineStart: 0, sourceStart: 0, sourceEnd: 6 }], 5, "Video"), /outside the source clip/);
assert.throws(() => validateTimelineClips([{ timelineStart: -1, sourceStart: 0, sourceEnd: 1 }], 5, "Video"), /before the timeline/);
assert.throws(() => validateTimelineClips([{ timelineStart: 0, sourceStart: NaN, sourceEnd: 1 }], 5, "Video"), /invalid timestamps/);
assert.throws(
  () => validateTimelineClips([{ timelineStart: 0, sourceStart: 0, sourceEnd: 2 }, { timelineStart: 1.9, sourceStart: 3, sourceEnd: 4 }], 5, "Video"),
  /Video clips overlap/,
);
assert.deepEqual(
  validateTimelineClips([
    { timelineStart: 2.0001, sourceStart: 3, sourceEnd: 5.02 },
    { timelineStart: 0, sourceStart: 0, sourceEnd: 2.0003 },
  ], 5, "Video").map((clip) => [clip.timelineStart, clip.sourceStart, Number(clip.sourceEnd.toFixed(6))]),
  [[0, 0, 2.0001], [2.0001, 3, 5]],
  "clips are sorted, float overlap is trimmed, and source ends are clamped",
);

const tempDir = await mkdtemp(path.join(os.tmpdir(), "Shard Editor Ω "));
const stagedFfmpegDir = path.resolve("resources/core-bin");
const vendorFfmpegDir = path.resolve("../vendor/ffmpeg/bin");
const ffmpegDir = existsSync(path.join(stagedFfmpegDir, "ffmpeg.exe")) ? stagedFfmpegDir : vendorFfmpegDir;
const ffmpeg = path.join(ffmpegDir, "ffmpeg.exe");
const ffprobe = path.join(ffmpegDir, "ffprobe.exe");
assert.ok(existsSync(ffmpeg) && existsSync(ffprobe), `FFmpeg test binaries not found in ${ffmpegDir}`);
// ffmpeg.ts resolves <resourcesPath>/core-bin like the packaged app. A clean
// release checkout has no staged core-bin yet, so expose the same binaries
// the test selected through a temporary junction.
const resourcesDir = await mkdtemp(path.join(os.tmpdir(), "shard-editor-resources-"));
const resourcesCoreBin = path.join(resourcesDir, "core-bin");
await symlink(ffmpegDir, resourcesCoreBin, "junction");
process.resourcesPath = resourcesDir;
const input = path.join(tempDir, "Source clip ü with spaces.mp4");
const multiOutput = path.join(tempDir, "Edited multi Ω.mp4");
const singleOutput = path.join(tempDir, "Edited single ü.mp4");
const twentyInput = path.join(tempDir, "Source with twenty audio streams.mp4");
const twentyOutput = path.join(tempDir, "Edited twenty audio streams.mp4");

try {
  for (const [w, h] of [[320, 240], [320, 200], [344, 144]]) {
    const nativeOutput = path.join(tempDir, `aspect-${w}-${h}.mp4`);
    const fitted = pickExportResolution(`${h / 2}p`, {w, h});
    const nativeGraph = buildExportGraph([{ timelineStart: 0, sourceStart: 0, sourceEnd: 1 }], [], fitted.w, fitted.h, 60);
    assert(!nativeGraph.filter.includes("pad="));
    run(ffmpeg, ["-y", "-f", "lavfi", "-i", `color=c=white:size=${w}x${h}:rate=60:duration=1`,
      "-filter_complex", nativeGraph.filter, ...nativeGraph.maps,
      ...buildVideoEncoderArgs("libx264", 500, 60), nativeOutput]);
    const video = probe(ffprobe, nativeOutput).streams[0];
    assert.equal(video.width, fitted.w);
    assert.equal(video.height, fitted.h);
    assert.equal(video.avg_frame_rate, "60/1");
    const frame = spawnSync(ffmpeg, ["-v", "error", "-i", nativeOutput, "-frames:v", "1",
      "-pix_fmt", "gray", "-f", "rawvideo", "-"], {maxBuffer:1024*1024});
    assert.equal(frame.status, 0);
    assert(frame.stdout.every(value => value > 220), "nonstandard export has no black padding");
  }
  // Real 60 fps cuts must remain CFR across non-frame-aligned boundaries.
  // A generous size limit must not inflate a simple short clip toward 20 MB.
  const sixtyInput = path.join(tempDir, "60 fps source.mp4");
  run(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=60:duration=8",
    "-c:v", "libx264", "-preset", "ultrafast", sixtyInput]);
  for (const clips of [
    [{ timelineStart: 0, sourceStart: 1.013, sourceEnd: 3.013 }],
    [{ timelineStart: 0, sourceStart: 0.013, sourceEnd: 3.013 }, { timelineStart: 3, sourceStart: 4.019, sourceEnd: 7.019 }],
  ]) {
    const output = path.join(tempDir, `cadence-${clips.length}.mp4`);
    const cadenceGraph = buildExportGraph(clips, [], 320, 180, 60);
    const duration = exportTimelineDuration(clips, []);
    const budget = Math.floor(20 * 1024 * 1024 * 8 * .9 / duration / 1000);
    run(ffmpeg, ["-y", "-i", sixtyInput, "-filter_complex", cadenceGraph.filter, ...cadenceGraph.maps,
      ...buildVideoEncoderArgs("libx264", budget, 60), output]);
    const video = probe(ffprobe, output).streams.find(s => s.codec_type === "video");
    assert.equal(video.avg_frame_rate, "60/1");
    assert(Math.abs(Number(video.nb_frames) - duration * 60) <= 1);
    assert(statSync(output).size < 2 * 1024 * 1024, "quality output stays far below the 20 MB ceiling");
  }
  // Size correction retains cadence while reducing the encoded bitrate.
  const fitted = path.join(tempDir, "size-fitted.mp4");
  run(ffmpeg, ["-y", "-i", sixtyInput, ...buildVideoEncoderArgs("libx264", 150, 60, false), fitted]);
  assert(statSync(fitted).size < 250000);
  assert.equal(probe(ffprobe, fitted).streams[0].avg_frame_rate, "60/1");
  run(ffmpeg, [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=4",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=4",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=4",
    "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", input,
  ]);

  run(ffmpeg, [
    "-y", "-i", input,
    "-filter_complex", graph.filter,
    ...graph.maps,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
    "-c:a", "aac", "-movflags", "+faststart", multiOutput,
  ]);
  const multiProbe = probe(ffprobe, multiOutput);
  const multiAudio = multiProbe.streams.filter((stream) => stream.codec_type === "audio");
  assert.equal(multiAudio.length, 1);
  assert.equal(multiAudio[0].disposition.default, 1);
  assert.ok(Number(multiAudio[0].bit_rate) > 10_000, "default playback mix must contain the audible source");
  const playbackDecode = spawnSync(ffmpeg, [
    "-v", "info", "-i", multiOutput, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "NUL",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(playbackDecode.status, 0, playbackDecode.stderr);
  assert.match(playbackDecode.stderr, /max_volume:\s*-\d+(?:\.\d+)? dB/);
  assert.ok(Number(multiProbe.format.duration) > 2.85 && Number(multiProbe.format.duration) < 3.15);

  const singleClips = [{ timelineStart: 0, sourceStart: 0.5, sourceEnd: 2.5 }];
  const singleGraph = buildExportGraph(
    singleClips,
    [{ streamIndex: 1, name: "Game", included: true, muted: false, volume: 1, clips: singleClips }],
    320,
    180,
    30,
  );
  run(ffmpeg, [
    "-y", "-i", input,
    "-filter_complex", singleGraph.filter,
    ...singleGraph.maps,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
    "-c:a", "aac", singleOutput,
  ]);
  const singleProbe = probe(ffprobe, singleOutput);
  assert.equal(singleProbe.streams.filter((stream) => stream.codec_type === "audio").length, 1);
  assert.ok(Number(singleProbe.format.duration) > 1.85 && Number(singleProbe.format.duration) < 2.15);

  run(ffmpeg, [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=15:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-map", "0:v:0",
    ...Array.from({ length: 20 }, () => ["-map", "1:a:0"]).flat(),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", twentyInput,
  ]);
  const twentyGraph = buildExportGraph(
    [{ timelineStart: 0, sourceStart: 0, sourceEnd: 0.75 }],
    twentyResolvedTracks,
    160,
    90,
    15,
  );
  run(ffmpeg, [
    "-y", "-i", twentyInput,
    "-filter_complex", twentyGraph.filter,
    ...twentyGraph.maps,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
    ...twentyGraph.audioOutputs.flatMap((output, index) => [
      `-c:a:${index}`, "aac", `-b:a:${index}`, `${output.bitRateKbps}k`,
      `-disposition:a:${index}`, index === 0 ? "default" : "0",
    ]),
    twentyOutput,
  ]);
  const twentyProbe = probe(ffprobe, twentyOutput);
  const twentyAudio = twentyProbe.streams.filter((stream) => stream.codec_type === "audio");
  assert.equal(twentyAudio.length, 1);
  assert.equal(twentyAudio[0].disposition.default, 1);
  assert.ok(Number(twentyAudio[0].bit_rate) > 10_000);
  assert.ok(Number(twentyProbe.format.duration) > 0.65 && Number(twentyProbe.format.duration) < 0.85);

  // Timeline gaps export as black frames and digital silence, and an audio
  // clip placed apart from the video lands at its own timeline position.
  const gapInput = path.join(tempDir, "Gap source.mp4");
  const gapOutput = path.join(tempDir, "Edited gaps.mp4");
  run(ffmpeg, [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=60:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", gapInput,
  ]);
  const gapVideoClips = [
    { timelineStart: 0.5, sourceStart: 0, sourceEnd: 1 },
    { timelineStart: 2, sourceStart: 2, sourceEnd: 3 },
  ];
  const gapTracks = resolveExportAudioTracks(availableAudioTracks(1), requestedAudioTracks(1, [
    { timelineStart: 3.5, sourceStart: 1, sourceEnd: 1.5 },
  ]), 4);
  const gapDuration = exportTimelineDuration(gapVideoClips, gapTracks);
  assert.equal(gapDuration, 4);
  const gapExportGraph = buildExportGraph(gapVideoClips, gapTracks, 320, 180, 60);
  run(ffmpeg, [
    "-y", "-i", gapInput,
    "-filter_complex", gapExportGraph.filter,
    ...gapExportGraph.maps,
    ...buildVideoEncoderArgs("libx264", 1000, 60),
    "-c:a", "aac", "-b:a", "192k", gapOutput,
  ]);
  const gapProbe = probe(ffprobe, gapOutput);
  assert.ok(Math.abs(Number(gapProbe.format.duration) - gapDuration) < 0.15, `gap export lasts ${gapProbe.format.duration}s`);
  const gapVideo = gapProbe.streams.find((stream) => stream.codec_type === "video");
  assert.equal(gapVideo.avg_frame_rate, "60/1");
  assert(Math.abs(Number(gapVideo.nb_frames) - gapDuration * 60) <= 2);
  const meanLuma = (seconds) => {
    const frame = spawnSync(ffmpeg, ["-v", "error", "-i", gapOutput, "-ss", String(seconds), "-frames:v", "1",
      "-pix_fmt", "gray", "-f", "rawvideo", "-"], { maxBuffer: 1024 * 1024, windowsHide: true });
    assert.equal(frame.status, 0, String(frame.stderr));
    assert.equal(frame.stdout.length, 320 * 180);
    return frame.stdout.reduce((sum, value) => sum + value, 0) / frame.stdout.length;
  };
  const maxVolume = (start, duration) => {
    const decoded = spawnSync(ffmpeg, ["-v", "info", "-i", gapOutput, "-ss", String(start), "-t", String(duration),
      "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "NUL"], { encoding: "utf8", windowsHide: true });
    assert.equal(decoded.status, 0, decoded.stderr);
    const match = decoded.stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?|-inf) dB/);
    assert(match, decoded.stderr);
    return match[1] === "-inf" ? -Infinity : Number(match[1]);
  };
  assert(meanLuma(0.25) < 24, "leading gap is black");
  assert(meanLuma(1.75) < 24, "middle gap is black");
  assert(meanLuma(3.5) < 24, "trailing video gap is black");
  assert(meanLuma(1) > 48, "video clip content is visible");
  assert(meanLuma(2.5) > 48, "second video clip content is visible");
  assert(maxVolume(0, 3.3) < -60, "audio is silent before its clip, even under video clips");
  assert(maxVolume(3.6, 0.35) > -30, "audio clip plays at its own timeline position");

  const audioCache = path.join(editorCacheDirectory, "shard-editor-audio");
  await mkdir(audioCache, { recursive: true });
  const legacyPreview = path.join(audioCache, `${"a".repeat(24)}.m4a`);
  const otherPreview = path.join(audioCache, `${"f".repeat(32)}-${"b".repeat(24)}.m4a`);
  await writeFile(legacyPreview, "legacy cache");
  await writeFile(otherPreview, "another source cache");
  const audioPreview = await prepareAudioPreview(input, 1);
  assert.equal(existsSync(legacyPreview), false, "obsolete audio cache format is cleaned up");
  const secondAudioPreview = await prepareAudioPreview(input, 2);
  const blobs = new Map();
  const waveformStore = { get: key => blobs.get(key), put: (key, data) => blobs.set(key, data) };
  let waveformProcesses = 0;
  ownedProcesses.setLogger(() => { waveformProcesses++; });
  const waveformStart = performance.now();
  const waveformPair = await Promise.all([generateWaveform(input, 1, 4, 2400, waveformStore), generateWaveform(input, 1, 4, 2400, waveformStore)]);
  assert.equal(waveformPair[0], waveformPair[1], "concurrent opens share the decoded waveform");
  assert.equal(waveformProcesses, 1, "simultaneous opens launch one waveform decoder");
  ownedProcesses.setLogger(() => {});
  const coldWaveformMs = performance.now() - waveformStart;
  const waveform = await generateWaveform(input, 1, 4, 256);
  assert.equal(waveform.peaks.length, 256);
  const encoded = encodeWaveform(waveformPair[0]);
  assert.equal(encoded.length, 4816, "waveform is kilobytes per track");
  assert(decodeWaveform(encoded).peaks.every((peak, index) => Math.abs(peak - waveformPair[0].peaks[index]) < 1 / 65535));
  assert.equal(decodeWaveform(encoded.subarray(0, 25)), undefined, "incomplete BLOB is never a cache hit");
  assert(existsSync(audioPreview));
  assert(existsSync(secondAudioPreview));
  // A fresh module instance simulates a new app process with empty in-memory maps.
  const frameKey = createHash("sha256").update(path.resolve(input)).digest("hex").slice(0, 16);
  const oldFrames = path.join(editorCacheDirectory, "shard-editor-frames", `${frameKey}-cached-frames`);
  await mkdir(oldFrames, { recursive: true });
  await writeFile(path.join(oldFrames, "frame-000.jpg"), "old frame");
  const restartedFfmpeg = await import("../src/main/ffmpeg.ts?cache-cleanup-restart");
  const cachedWaveformStart = performance.now();
  const restored = await restartedFfmpeg.generateWaveform(input, 1, 4, 2400, waveformStore);
  const cachedWaveformMs = performance.now() - cachedWaveformStart;
  assert.deepEqual(restored, decodeWaveform(encoded), "waveform persists across process memory reset");
  assert.equal(ownedProcesses.size, 0, "cached waveform opens no FFmpeg process");
  await utimes(input, new Date(), new Date(statSync(input).mtimeMs + 1000));
  await generateWaveform(input, 1, 4, 2400, waveformStore);
  assert.equal(blobs.size, 2, "modified source cannot reuse the stale waveform key");
  await assert.rejects(generateWaveform(input, 1, 4, NaN), /Invalid/);
  await restartedFfmpeg.removeEditorMedia(input);
  assert.equal(existsSync(audioPreview), false, "source prefix removes audio cache after restart");
  assert.equal(existsSync(secondAudioPreview), false, "cleanup removes every cached stream variant");
  assert.equal(existsSync(oldFrames), false, "timeline files are removed before the service has generated frames in this process");
  assert.equal(existsSync(otherPreview), true, "another source's cache is preserved");
  await removeEditorMedia(input);
  const activePreview = prepareAudioPreview(input, 1);
  const activeCancelled = assert.rejects(activePreview, /cancelled|abort/i);
  await Promise.all([activeCancelled, removeEditorMedia(input)]);
  assert.equal(ownedProcesses.size, 0, "deletion cancels and drains active preparation");
  const held = Promise.withResolvers();
  const heldStarted = Promise.withResolvers();
  const heldJob = runEditorPreparation("background", signal, async () => { heldStarted.resolve(); await held.promise; });
  await heldStarted.promise;
  const cancelledOpen = new AbortController();
  const abandoned = generateWaveform(input, 2, 4, 2400, undefined, cancelledOpen.signal);
  const surviving = generateWaveform(input, 2, 4, 2400);
  const abandonedFailure = assert.rejects(abandoned, /cancelled/);
  cancelledOpen.abort();
  held.resolve();
  await Promise.all([heldJob, abandonedFailure, surviving]);
  // Removal also clears memory entries; the next request repopulates normally.
  assert.equal((await generateWaveform(input, 1, 4, 256)).peaks.length, 256);
  console.log(JSON.stringify({ coldWaveformMs: Math.round(coldWaveformMs), cachedWaveformMs: Number(cachedWaveformMs.toFixed(2)), waveformBytesPerTrack: encoded.length }));

  console.log("editor tests passed: model, history, timeline math, cuts, single audible mix from 1/2/20-track inputs, spaces, Unicode");
} finally {
  await rm(tempDir, { recursive: true, force: true });
  await rm(editorCacheDirectory, { recursive: true, force: true });
  // Remove only the link, never the FFmpeg directory it points to.
  await unlink(resourcesCoreBin);
  await rmdir(resourcesDir);
}

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `${path.basename(executable)} failed (${result.status}):\n${result.stderr || result.stdout}`);
}

function probe(executable, file) {
  const result = spawnSync(executable, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
