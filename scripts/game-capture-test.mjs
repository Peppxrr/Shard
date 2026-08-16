// Real OBS Game Capture compatibility smoke test (Windows, Node >= 22).
//
// Builds/runs an animated D3D11 swapchain target and records it while focused,
// unfocused, fully covered, and genuinely minimized. Each clip is decoded to
// frame MD5s; changing hashes prove freshness rather than a repeated final
// frame. The minimized row additionally requires the injected hook checkpoints.
//
// Build first:
//   cmake --build build_x64 --config Release --target shard_gc_d3d11_fixture
//   powershell -File scripts/build.ps1 -SkipApp
// Run:
//   node scripts/game-capture-test.mjs
// env: CF_COREBIN, CF_GC_FIXTURE, CF_KEEP_TEMP=1
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const coreBin = path.resolve(process.env.CF_COREBIN ?? path.join(root, "app/resources/core-bin"));
const api = (process.env.CF_GC_API ?? "D3D11").toUpperCase();
if (api !== "D3D11" && api !== "D3D12") throw new Error(`unsupported CF_GC_API: ${api}`);
const fixtureExe = path.resolve(
  process.env.CF_GC_FIXTURE ?? path.join(root, `build_x64/Release/shard_gc_${api.toLowerCase()}_fixture.exe`),
);
const useExistingTarget = process.env.CF_GC_EXISTING_TARGET === "1";
const targetLauncher = process.env.CF_GC_LAUNCHER ? path.resolve(process.env.CF_GC_LAUNCHER) : undefined;
const states = (process.env.CF_GC_STATES ?? "focused,unfocused,covered,minimized")
  .split(",")
  .map((state) => state.trim())
  .filter(Boolean);
const expectedBlockStage = process.env.CF_GC_EXPECT_BLOCK_STAGE;
const diagnosticsOnly = Boolean(expectedBlockStage);
const coreExe = path.join(coreBin, "clipcore.exe");
const ffmpegExe = path.join(coreBin, "ffmpeg.exe");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shard-gc-"));
const keep = process.env.CF_KEEP_TEMP === "1";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log("[game-capture]", ...args);

for (const required of [coreExe, ffmpegExe, fixtureExe]) {
  if (!fs.existsSync(required)) throw new Error(`missing required binary: ${required}`);
}

fs.writeFileSync(
  path.join(tmp, "games.json"),
  JSON.stringify([{ exe: path.basename(fixtureExe).toLowerCase(), name: `Shard GC ${api} Fixture` }]),
);

let core;
let fixture;
let cover;
let ws;
let coreErr = "";
let stdoutBuf = "";
let nextId = 1;
const pending = new Map();
const waiters = [];

function waitEvent(name, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    waiters.push({
      name,
      resolve: (params) => {
        clearTimeout(timer);
        resolve(params);
      },
    });
  });
}

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, 30_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

async function saveClip() {
  const savedEvent = waitEvent("clip.saved", 90_000);
  await call("clip.save", { durationSec: 3 });
  return savedEvent;
}

function uniqueFrameHashes(clipPath) {
  const result = spawnSync(
    ffmpegExe,
    ["-v", "error", "-i", clipPath, "-map", "0:v:0", "-vf", "fps=10", "-f", "framemd5", "-"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg framemd5 failed: ${result.stderr}`);
  const hashes = result.stdout
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1).trim());
  return { decodedFrames: hashes.length, uniqueFrames: new Set(hashes).size };
}

function runPowerShell(script) {
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PowerShell failed: ${result.stderr}`);
  return result.stdout.trim();
}

function setTargetState(state) {
  const fixtureName = path.basename(fixtureExe, ".exe");
  return runPowerShell(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class GcWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
}
"@
$target = Get-Process '${fixtureName}' -ErrorAction Stop | Select-Object -First 1
$target.Refresh()
$h = $target.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { throw 'fixture has no main window' }
$cover = Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'Shard GC Cover' } | Select-Object -First 1
if ('${state}' -eq 'focused') {
  [GcWindow]::ShowWindow($h, 9) | Out-Null
  [GcWindow]::SetWindowPos($h, [IntPtr]::Zero, 100, 100, 960, 540, 0x0040) | Out-Null
  [GcWindow]::SetForegroundWindow($h) | Out-Null
} elseif ('${state}' -eq 'unfocused') {
  [GcWindow]::ShowWindow($h, 9) | Out-Null
  if ($cover) {
    $cover.Refresh(); $ch = $cover.MainWindowHandle
    [GcWindow]::SetWindowPos($ch, [IntPtr](-1), 1300, 50, 300, 220, 0x0040) | Out-Null
    [GcWindow]::SetForegroundWindow($ch) | Out-Null
  }
} elseif ('${state}' -eq 'covered') {
  [GcWindow]::ShowWindow($h, 9) | Out-Null
  if (-not $cover) { throw 'cover window missing' }
  $r = New-Object GcWindow+Rect
  [GcWindow]::GetWindowRect($h, [ref]$r) | Out-Null
  $cover.Refresh(); $ch = $cover.MainWindowHandle
  [GcWindow]::SetWindowPos($ch, [IntPtr](-1), $r.left, $r.top, $r.right-$r.left, $r.bottom-$r.top, 0x0040) | Out-Null
  [GcWindow]::SetForegroundWindow($ch) | Out-Null
} elseif ('${state}' -eq 'minimized') {
  [GcWindow]::ShowWindow($h, 6) | Out-Null
}
$target.Refresh()
"hwnd=$h minimized=$($target.MainWindowHandle -eq [IntPtr]::Zero -or '${state}' -eq 'minimized')"
`);
}

async function focusTargetWhenReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return setTargetState("focused");
    } catch (error) {
      lastError = error;
      await delay(1000);
    }
  }
  throw new Error(`target window did not appear: ${lastError?.message ?? "unknown error"}`);
}

async function cleanup() {
  try {
    if (ws?.readyState === WebSocket.OPEN) await call("shutdown");
  } catch {}
  try { ws?.close(); } catch {}
  for (const child of [cover, fixture, core]) {
    try { child?.kill(); } catch {}
  }
  await delay(500);
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  else log(`kept temp directory: ${tmp}`);
}

try {
  core = spawn(
    coreExe,
    ["--config-dir", tmp, "--core-bin", coreBin, "--games", path.join(tmp, "games.json"), "--port", "0"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SHARD_GAME_CAPTURE_DIAGNOSTICS: "1" },
    },
  );
  core.stdout.on("data", (data) => (stdoutBuf += data));
  core.stderr.on("data", (data) => (coreErr += data));

  const port = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const timer = setInterval(() => {
      const match = stdoutBuf.match(/^PORT (\d+)\r?$/m);
      if (match) {
        clearInterval(timer);
        resolve(Number(match[1]));
      } else if (core.exitCode !== null || Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`core failed to start\n${coreErr}`));
      }
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
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else request.resolve(message.result);
      return;
    }
    const index = waiters.findIndex((waiter) => waiter.name === message.method);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message.params);
  });
  const readyEvent = waitEvent("ready", 15_000);
  const subjectEvent = useExistingTarget ? undefined : waitEvent("capture.subject", 60_000);
  await readyEvent;
  if (targetLauncher) {
    fixture = spawn(targetLauncher, [], { cwd: path.dirname(targetLauncher), stdio: "ignore" });
  } else if (!useExistingTarget) {
    fixture = spawn(fixtureExe, [], { stdio: "ignore" });
  }
  await focusTargetWhenReady();
  const subject = subjectEvent ? await subjectEvent : { kind: "game", name: path.basename(fixtureExe, ".exe") };
  if (subject.kind !== "game") throw new Error(`unexpected capture subject: ${JSON.stringify(subject)}`);
  log(`capture subject: ${subject.name}`);

  if (!diagnosticsOnly) {
    let buffered = 0;
    const warmDeadline = Date.now() + 60_000;
    while (buffered < 6 && Date.now() < warmDeadline) {
      const stats = await waitEvent("ring.stats", 10_000);
      buffered = stats.secondsBuffered ?? 0;
    }
  }
  const rows = [];
  for (const state of states) {
    if (state === "unfocused") {
      cover = spawn(
        "powershell",
        ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object Windows.Forms.Form; $f.Text='Shard GC Cover'; $f.BackColor=[Drawing.Color]::Blue; $f.TopMost=$true; $f.ShowInTaskbar=$true; [Windows.Forms.Application]::Run($f)"],
        { stdio: "ignore" },
      );
      await delay(1200);
    }
    const stateDetail = setTargetState(state);
    log(`${state}: ${stateDetail}`);
    await delay(diagnosticsOnly ? 5000 : 4000);
    if (diagnosticsOnly) {
      rows.push({ state });
      continue;
    }
    const saved = await saveClip();
    const freshness = uniqueFrameHashes(saved.path);
    const fresh = freshness.decodedFrames >= 10 && freshness.uniqueFrames >= 5;
    rows.push({ state, path: saved.path, ...freshness, fresh });
    if (!fresh) throw new Error(`${state} capture froze: ${JSON.stringify(freshness)}`);
  }

  await delay(500);
  const diagnostics = coreErr.split(/\r?\n/).filter((line) => line.includes("[GC]"));
  if (expectedBlockStage) {
    if (expectedBlockStage !== "TargetDllLoad") throw new Error(`unsupported expected block stage: ${expectedBlockStage}`);
    for (const stage of ["stage=SetWindowsHookEx result=1", "stage=WindowLayer minimized=true"]) {
      if (!diagnostics.some((line) => line.includes(stage))) {
        throw new Error(`missing pre-block diagnostic: ${stage}\n${diagnostics.join("\n")}`);
      }
    }
    if (diagnostics.some((line) => line.includes("stage=TargetDllLoad"))) {
      throw new Error(`capture unexpectedly progressed through ${expectedBlockStage}\n${diagnostics.join("\n")}`);
    }
    console.table(rows);
    log(`PASS: capture stopped before ${expectedBlockStage} after successful SetWindowsHookEx/message posting`);
  } else {
    const requiredStages = ["stage=SetWindowsHookEx", "stage=TargetDllLoad", `stage=GraphicsApiDetected api=${api}`, `stage=FirstFrameCopied api=${api}`, "stage=FrameImport result=success"];
    for (const stage of requiredStages) {
      if (!diagnostics.some((line) => line.includes(stage))) {
        throw new Error(`missing Game Capture diagnostic: ${stage}\n${diagnostics.join("\n")}`);
      }
    }
    console.table(rows.map(({ state, decodedFrames, uniqueFrames, fresh }) => ({ state, decodedFrames, uniqueFrames, fresh })));
    log(`PASS: compatibility hook loaded and all requested states produced fresh ${api} frames`);
  }
  for (const line of diagnostics) console.log(line);
} catch (error) {
  for (const line of coreErr.split(/\r?\n/).filter((line) => line.includes("[GC]"))) console.error(line);
  throw error;
} finally {
  await cleanup();
}
