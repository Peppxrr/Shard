// Real Game Capture swap test (Windows, Node >= 22).
//
// Runs two registered copies of the animated D3D11 fixture with different
// aspect ratios and swaps capture between them by focus. Verifies the 5 s
// focus debounce, that a brief alt-tab does not swap, that the replay ring and
// encoded format survive every swap, and that returning to a game whose
// process already holds the official graphics hook reacquires hook frames.
// CF_GC_SWAP_MODE=auto additionally starts on the desktop and verifies the
// return to desktop capture after both games close.
//
// Build first (Debug shown; Release paths work the same way):
//   cmake --build build_x64 --config Debug --target shard_gc_d3d11_fixture
//   powershell -File scripts/build.ps1 -Config Debug -SkipApp
// Run:
//   $env:CF_COREBIN="$PWD/app/resources/core-bin-dev"
//   $env:CF_GC_FIXTURE="$PWD/build_x64/Debug/shard_gc_d3d11_fixture.exe"
//   node scripts/game-swap-test.mjs
// env: CF_COREBIN, CF_GC_FIXTURE, CF_GC_SWAP_MODE=game|auto, CF_KEEP_TEMP=1
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const coreBin = path.resolve(process.env.CF_COREBIN ?? path.join(root, "app/resources/core-bin"));
const fixtureSource = path.resolve(process.env.CF_GC_FIXTURE ?? path.join(root, "build_x64/Release/shard_gc_d3d11_fixture.exe"));
const mode = process.env.CF_GC_SWAP_MODE ?? "game";
if (mode !== "game" && mode !== "auto") throw new Error(`unsupported CF_GC_SWAP_MODE: ${mode}`);
const coreExe = path.join(coreBin, "shardcore.exe");
const ffmpegExe = path.join(coreBin, "ffmpeg.exe");
const ffprobeExe = path.join(coreBin, "ffprobe.exe");
for (const required of [coreExe, ffmpegExe, ffprobeExe, fixtureSource]) {
  if (!fs.existsSync(required)) throw new Error(`missing required binary: ${required}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shard-swap-"));
const keep = process.env.CF_KEEP_TEMP === "1";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log("[game-swap]", ...args);

// Different aspect ratios: before swaps preserved the canvas, either swap
// forced a native video reset that cleared the replay ring.
const games = {
  a: { name: "Swap Fixture A", exe: "shard_swap_a.exe", size: [1280, 720] },
  b: { name: "Swap Fixture B", exe: "shard_swap_b.exe", size: [960, 720] },
};
for (const game of Object.values(games)) fs.copyFileSync(fixtureSource, path.join(tmp, game.exe));
fs.writeFileSync(path.join(tmp, "games.json"), JSON.stringify({
  version: 10,
  user: Object.entries(games).map(([id, game]) => ({ id: `u:swap-${id}`, name: game.name, executables: [game.exe] })),
  discovered: [],
  customFolders: [],
  ignoredExes: [],
  verboseDetection: true,
}));
fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({
  capture: { mode, monitor: 0 },
  replay: { maxSeconds: 300, maxMb: 2048 },
}));

let core;
let ws;
let coreErr = "";
let stdoutBuf = "";
let nextId = 1;
const children = {};
const pending = new Map();
const waiters = [];
const ringHistory = [];
const subjects = [];

function waitEvent(name, timeoutMs, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    waiters.push({ name, predicate, resolve: (params) => { clearTimeout(timer); resolve(params); } });
  });
}

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 30_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

function focus(game) {
  const name = path.basename(game.exe, ".exe");
  const result = spawnSync("powershell", ["-NoProfile", "-Command", `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SwapWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
"@
$target = Get-Process '${name}' -ErrorAction Stop | Select-Object -First 1
$h = $target.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { throw 'fixture has no main window' }
[SwapWindow]::ShowWindow($h, 9) | Out-Null
# A synthetic Alt tap satisfies the foreground-lock input rule.
[SwapWindow]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[SwapWindow]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[SwapWindow]::SetForegroundWindow($h) | Out-Null
if ([SwapWindow]::GetForegroundWindow() -ne $h) { throw 'focus was refused' }
`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`focus ${game.exe} failed: ${result.stderr.trim()}`);
}

async function holdFocus(game, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { focus(game); } catch {}
    await delay(Math.min(1000, Math.max(0, end - Date.now())));
  }
}

async function launch(game) {
  children[game.exe] = spawn(path.join(tmp, game.exe), [], {
    stdio: "ignore",
    env: { ...process.env, SHARD_GC_FIXTURE_WIDTH: String(game.size[0]), SHARD_GC_FIXTURE_HEIGHT: String(game.size[1]) },
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { focus(game); game.pid = children[game.exe].pid; return; } catch (error) {
      if (Date.now() > deadline) throw error;
      await delay(500);
    }
  }
}

// Focus `game` and keep it focused until capture follows it. Returns the
// focus-to-swap latency measured from the first accepted focus.
async function swapTo(game, timeoutMs = 15_000) {
  const subject = waitEvent("capture.subject", timeoutMs, (params) => params?.kind === "game" && params?.name === game.name);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { focus(game); break; } catch (error) {
      if (Date.now() > deadline) throw error;
      await delay(250);
    }
  }
  const focusedAt = Date.now();
  let done = false;
  const pulse = (async () => { while (!done) { try { focus(game); } catch {} await delay(1000); } })();
  try { await subject; } finally { done = true; await pulse; }
  return Date.now() - focusedAt;
}

function healthyHook(game, fromOffset) {
  return coreErr.slice(fromOffset).split(/\r?\n/).some((line) => line.includes("[capture-health]") &&
    line.includes(`subject_exe=${game.exe}`) && line.includes("hook_healthy=true") && line.includes("selected_backend=hook"));
}

async function waitHealthyHook(game, fromOffset, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!healthyHook(game, fromOffset)) {
    if (Date.now() > deadline) throw new Error(`${game.exe} never produced healthy hook frames after the swap`);
    try { focus(game); } catch {}
    await delay(1000);
  }
}

function assertRingKept(fromIndex, label) {
  let peak = 0;
  for (const sample of ringHistory.slice(fromIndex)) {
    if (sample.secondsBuffered + 1 < peak)
      throw new Error(`${label} discarded replay history: ${peak}s -> ${sample.secondsBuffered}s`);
    peak = Math.max(peak, sample.secondsBuffered);
  }
}

function probe(file) {
  const result = spawnSync(ffprobeExe, ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height", "-of", "json", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffprobe failed: ${result.stderr}`);
  return JSON.parse(result.stdout).streams[0];
}

async function cleanup() {
  try { if (ws?.readyState === WebSocket.OPEN) await call("shutdown"); } catch {}
  try { ws?.close(); } catch {}
  for (const child of [...Object.values(children), core]) { try { child?.kill(); } catch {} }
  await delay(1000);
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  else log(`kept temp directory: ${tmp}`);
}

try {
  core = spawn(coreExe, ["--config-dir", tmp, "--core-bin", coreBin, "--games", path.join(tmp, "games.json"), "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SHARD_GAME_CAPTURE_DIAGNOSTICS: "1" },
  });
  core.stdout.on("data", (data) => (stdoutBuf += data));
  core.stderr.on("data", (data) => (coreErr += data));
  const port = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const timer = setInterval(() => {
      const match = stdoutBuf.match(/^PORT (\d+)\r?$/m);
      if (match) { clearInterval(timer); resolve(Number(match[1])); }
      else if (core.exitCode !== null || Date.now() > deadline) { clearInterval(timer); reject(new Error(`core failed to start\n${coreErr}`)); }
    }, 100);
  });
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
  ws.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.method === "ring.stats") ringHistory.push({ at: Date.now(), secondsBuffered: message.params?.secondsBuffered ?? 0 });
    if (message.method === "capture.subject") subjects.push({ at: Date.now(), ...message.params });
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else request.resolve(message.result);
      return;
    }
    const index = waiters.findIndex((waiter) => waiter.name === message.method && waiter.predicate(message.params));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message.params);
  });
  const ready = await waitEvent("ready", 15_000);
  const expectedStart = mode === "auto" ? "monitor" : "none";
  if (ready.capture?.subject?.kind !== expectedStart)
    throw new Error(`unexpected startup subject: ${JSON.stringify(ready.capture?.subject)}`);

  // Phase 1: the first game is captured immediately.
  const firstSubject = waitEvent("capture.subject", 60_000, (params) => params?.name === games.a.name);
  await launch(games.a);
  await firstSubject;
  log(`captured ${games.a.name} (pid ${games.a.pid})`);
  await waitHealthyHook(games.a, 0, 60_000);
  if (mode === "game") {
    // Game-only mode starts with an idle ring, so the first game owns the canvas.
    const deadline = Date.now() + 30_000;
    while (!coreErr.includes(`canvas ${games.a.size.join("x")}, resized=true`)) {
      if (Date.now() > deadline) throw new Error(`first game did not fit its native canvas\n${coreErr.slice(-4000)}`);
      await delay(250);
    }
  }
  await holdFocus(games.a, 8000);
  const historyStart = ringHistory.length;
  const historyStartedAt = Date.now();
  const offsetAfterWarm = coreErr.length;
  log(`ring warmed: ${ringHistory.at(-1)?.secondsBuffered ?? 0}s`);

  // Phase 2: a newly launched game, then a 2 s alt-tab, must not take over.
  const subjectsBeforeFlick = subjects.length;
  await launch(games.b);
  await holdFocus(games.a, 7000);
  await holdFocus(games.b, 2000);
  await holdFocus(games.a, 7000);
  if (subjects.slice(subjectsBeforeFlick).some((subject) => subject.name === games.b.name))
    throw new Error("a brief focus change swapped capture");
  log("launch focus and a 2 s alt-tab kept the current game");

  // Phase 3: holding focus swaps after the debounce, with hook frames.
  const swaps = [[games.b, "first swap to B"], [games.a, "return to injected A"], [games.b, "return to injected B"]];
  for (const [game, label] of swaps) {
    const offset = coreErr.length;
    const latency = await swapTo(game);
    if (latency < 4000 || latency > 10_000) throw new Error(`${label}: swap latency ${latency}ms outside the 5 s debounce`);
    await waitHealthyHook(game, offset);
    await holdFocus(game, 4000);
    const failures = coreErr.slice(offset).split(/\r?\n/).filter((line) => line.includes("stage=CaptureInitialization reason=timeout"));
    if (failures.length) throw new Error(`${label}: hook initialization timed out\n${failures.join("\n")}`);
    if (label.startsWith("return") && !coreErr.slice(offset).includes("stage=ExistingHook result=restart_signaled"))
      throw new Error(`${label}: existing-hook path was not exercised`);
    log(`${label}: swapped after ${latency}ms, healthy hook frames`);
  }
  assertRingKept(historyStart, "game swaps");
  const swapLogs = coreErr.slice(offsetAfterWarm);
  if (swapLogs.includes("replay buffer restarted")) throw new Error("a game swap restarted the replay buffer");
  if (!swapLogs.includes("reason=subject_switch")) throw new Error("missing subject_switch preservation diagnostic");

  // Phase 4: the whole history spans every swap in one decodable format.
  const saved = waitEvent("clip.saved", 90_000);
  await call("clip.save", { durationSec: 0 });
  const clip = await saved;
  const spanSec = (Date.now() - historyStartedAt) / 1000;
  if ((clip.actualSec ?? 0) < spanSec - 3) throw new Error(`saved history ${clip.actualSec}s does not span the swaps (${spanSec.toFixed(1)}s)`);
  const decoded = spawnSync(ffmpegExe, ["-v", "error", "-i", clip.path, "-map", "0:v:0", "-f", "null", "-"], { encoding: "utf8" });
  if (decoded.status !== 0 || decoded.stderr.trim()) throw new Error(`history decode failed: ${decoded.stderr}`);
  const stream = probe(clip.path);
  log(`full history ${clip.actualSec.toFixed(1)}s decodes at ${stream.width}x${stream.height}`);

  if (mode === "auto") {
    // Screen mode overrides the game; returning to auto resumes the primary.
    const toScreen = waitEvent("capture.subject", 10_000, (params) => params?.kind === "monitor");
    await call("config.set", { capture: { mode: "screen" } });
    await toScreen;
    const offset = coreErr.length;
    const back = waitEvent("capture.subject", 10_000, (params) => params?.name === games.b.name);
    await call("config.set", { capture: { mode: "auto" } });
    await back;
    await waitHealthyHook(games.b, offset);
    log("screen -> auto resumed the running game with hook frames");
  }

  // Phase 5: closing the primary falls back immediately; auto mode ends on the desktop.
  const closeIndex = ringHistory.length;
  const toA = waitEvent("capture.subject", 10_000, (params) => params?.name === games.a.name);
  children[games.b.exe].kill();
  await toA;
  log("closing the primary game moved capture to the remaining game");
  if (mode === "auto") {
    const toDesktop = waitEvent("capture.subject", 10_000, (params) => params?.kind === "monitor");
    children[games.a.exe].kill();
    await toDesktop;
    await delay(4000);
    assertRingKept(closeIndex, "returning to the desktop");
    if (coreErr.slice(offsetAfterWarm).includes("replay buffer restarted"))
      throw new Error("returning to the desktop restarted the replay buffer");
    log("closing the last game returned to desktop capture with history kept");
  }
  log(`PASS (${mode} mode)`);
} catch (error) {
  for (const line of coreErr.split(/\r?\n/).filter((line) =>
    line.includes("[GC]") || line.includes("[GameDetection]") || line.includes("capture-geometry") ||
    line.includes("replay") || line.includes("canvas"))) console.error(line);
  throw error;
} finally {
  await cleanup();
}
