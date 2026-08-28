import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  commitHistory,
  createEditorState,
  createHistory,
  deleteSegment,
  editedDuration,
  pixelToTime,
  redoHistory,
  sourceToResultTime,
  splitSegment,
  timeToPixel,
  trimSegment,
  undoHistory,
} from "../src/renderer/editor/model.ts";
import { buildExportGraph, resolveExportAudioTracks, validateExportSegments } from "../src/main/export-graph.ts";

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
const requestedAudioTracks = (count) => Array.from({ length: count }, (_, audioIndex) => ({
  streamIndex: audioIndex + 1,
  name: `Audio ${audioIndex + 1}`,
  included: true,
  muted: false,
  volume: 1,
}));
assert.equal(resolveExportAudioTracks(availableAudioTracks(1), requestedAudioTracks(1)).length, 1);
const twentyResolvedTracks = resolveExportAudioTracks(availableAudioTracks(20), requestedAudioTracks(20));
assert.deepEqual(twentyResolvedTracks.map((track) => track.streamIndex), Array.from({ length: 20 }, (_, index) => index + 1));
assert.deepEqual(
  resolveExportAudioTracks(availableAudioTracks(2), requestedAudioTracks(2).map((track) => ({ ...track, included: false }))),
  [],
  "explicitly excluded audio tracks must produce a video-only export",
);
assert.throws(
  () => resolveExportAudioTracks(availableAudioTracks(1), [...requestedAudioTracks(1), ...requestedAudioTracks(1)]),
  /selected more than once/,
);

let state = createEditorState(60, audioTracks);
state = splitSegment(state, state.selectedSegmentId, 25);
assert.deepEqual(state.segments.map(({ sourceStart, sourceEnd }) => [sourceStart, sourceEnd]), [[0, 25], [25, 60]]);
state = splitSegment(state, state.selectedSegmentId, 35);
assert.deepEqual(state.segments.map(({ sourceStart, sourceEnd }) => [sourceStart, sourceEnd]), [[0, 25], [25, 35], [35, 60]]);
state = { ...state, selectedSegmentId: state.segments[1].id };
state = deleteSegment(state, state.selectedSegmentId);
assert.deepEqual(state.segments.map(({ sourceStart, sourceEnd }) => [sourceStart, sourceEnd]), [[0, 25], [35, 60]]);
assert.equal(editedDuration(state.segments), 50);
assert.equal(sourceToResultTime(state.segments, 40), 30);
state = trimSegment(state, state.segments[0].id, "start", 5);
assert.equal(editedDuration(state.segments), 45);
state = trimSegment(state, state.segments[0].id, "start", 1);
assert.equal(state.segments[0].sourceStart, 1, "a trimmed edge can expand back toward its original bound");
assert.equal(editedDuration(state.segments), 49);

const px = timeToPixel(12.5, 20, 40);
assert.equal(px, 210);
assert.equal(pixelToTime(px, 20, 40), 12.5);

let history = createHistory(createEditorState(30, audioTracks));
const split = splitSegment(history.present, history.present.selectedSegmentId, 10);
history = commitHistory(history, split);
assert.equal(history.present.segments.length, 2);
history = undoHistory(history);
assert.equal(history.present.segments.length, 1);
history = redoHistory(history);
assert.equal(history.present.segments.length, 2);

const graph = buildExportGraph(
  [{ start: 0, end: 1 }, { start: 2, end: 4 }],
  [
    { streamIndex: 1, audioIndex: 0, name: "Game", included: true, muted: false, volume: 1 },
    { streamIndex: 2, audioIndex: 1, name: "Microphone", included: true, muted: false, volume: 0.8 },
  ],
  320,
  180,
);
assert.match(graph.filter, /\[v0\]\[a0_0\]\[a1_0\]\[v1\]\[a0_1\]\[a1_1\]concat=n=2:v=1:a=2\[vc\]\[act0\]\[act1\]/);
assert.match(graph.filter, /\[0:1\]atrim=start=0:end=1/);
assert.deepEqual(graph.maps, ["-map", "[v]", "-map", "[amix]"]);
assert.deepEqual(graph.audioOutputs.map((output) => output.name), ["Audio Mix"]);
assert.throws(() => validateExportSegments([{ start: 4, end: 2 }], 5), /outside the source clip/);

const tempDir = await mkdtemp(path.join(os.tmpdir(), "Shard Editor Ω "));
const ffmpeg = path.resolve("resources/core-bin/ffmpeg.exe");
const ffprobe = path.resolve("resources/core-bin/ffprobe.exe");
const input = path.join(tempDir, "Source clip ü with spaces.mp4");
const multiOutput = path.join(tempDir, "Edited multi Ω.mp4");
const singleOutput = path.join(tempDir, "Edited single ü.mp4");
const twentyInput = path.join(tempDir, "Source with twenty audio streams.mp4");
const twentyOutput = path.join(tempDir, "Edited twenty audio streams.mp4");

try {
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

  const singleGraph = buildExportGraph(
    [{ start: 0.5, end: 2.5 }],
    [{ streamIndex: 1, name: "Game", included: true, muted: false, volume: 1 }],
    320,
    180,
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
    [{ start: 0, end: 0.75 }],
    twentyResolvedTracks,
    160,
    90,
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

  console.log("editor tests passed: model, history, timeline math, cuts, single audible mix from 1/2/20-track inputs, spaces, Unicode");
} finally {
  await rm(tempDir, { recursive: true, force: true });
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
