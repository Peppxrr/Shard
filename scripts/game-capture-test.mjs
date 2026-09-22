// Real OBS Game Capture compatibility smoke test (Windows, Node >= 22).
//
// Builds/runs an animated D3D11 swapchain target and records it while focused,
// unfocused, fully covered, and genuinely minimized. Each clip is decoded to
// frame MD5s; changing hashes prove freshness rather than a repeated final
// frame. Host-side diagnostics prove official-payload verification and helper
// lifecycle ordering without modifying the signed target-side binaries.
//
// Build first:
//   cmake --build build_x64 --config Release --target shard_gc_d3d11_fixture
//   powershell -File scripts/build.ps1 -SkipApp
// Run:
//   node scripts/game-capture-test.mjs
// env: CF_COREBIN, CF_GC_FIXTURE, CF_KEEP_TEMP=1
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
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
const geometryTest = process.env.CF_GC_GEOMETRY === "1";
const geometryCases = { "four-three": [960, 720], laptop: [1280, 800], ultrawide: [1720, 720] };
let expectedSize = [Number(process.env.SHARD_GC_FIXTURE_WIDTH || 960), Number(process.env.SHARD_GC_FIXTURE_HEIGHT || 540)];
const recordingTest = process.env.CF_GC_RECORDING === "1";
const recordingPaths = new Set();
const coreExe = path.join(coreBin, "shardcore.exe");
const ffmpegExe = path.join(coreBin, "ffmpeg.exe");
const privateHookDir = path.join(coreBin, "data/obs-plugins/win-capture");
const runtimePins = JSON.parse(fs.readFileSync(path.join(root, "runtime-dependencies.json"), "utf8"));
const payloadManifestPath = path.join(root, runtimePins.obs.hookPayload, "manifest.json");
const payloadManifest = JSON.parse(fs.readFileSync(payloadManifestPath, "utf8"));
const privatePayload = Object.fromEntries(
  Object.keys(payloadManifest.files).map((name) => [name, path.join(privateHookDir, name)]),
);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shard-gc-"));
const keep = process.env.CF_KEEP_TEMP === "1";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log("[game-capture]", ...args);

for (const required of [coreExe, ffmpegExe, fixtureExe, ...Object.values(privatePayload)]) {
  if (!fs.existsSync(required)) throw new Error(`missing required binary: ${required}`);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}


// This is a graphics-hook smoke fixture, not semantic evidence that a process
// is a game. Register it explicitly so the test exercises capture rather than
// depending on the detector's former generic-D3D false-positive path.
const fixtureExeName = path.basename(fixtureExe).toLowerCase();
const fixtureName = path.basename(fixtureExe, path.extname(fixtureExe));
fs.writeFileSync(
  path.join(tmp, "games.json"),
  JSON.stringify({
    version: 10,
    user: [{ id: `u:${fixtureName.toLowerCase()}`, name: fixtureName, executables: [fixtureExeName] }],
    discovered: [],
    customFolders: [],
    ignoredExes: (process.env.CF_GC_IGNORE_EXES || "").split(",").filter(Boolean),
    verboseDetection: true,
  }),
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

function waitEvent(name, timeoutMs = 90_000, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    waiters.push({
      name,
      predicate,
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

function authenticode(file) {
  const escaped = file.replaceAll("'", "''");
  return JSON.parse(
    runPowerShell(`
$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'
$signer = if ($signature.SignerCertificate) {
  $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
} else { '<missing>' }
$thumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { '<missing>' }
[pscustomobject]@{ status = [string]$signature.Status; signer = $signer; thumbprint = $thumbprint } |
  ConvertTo-Json -Compress
`),
  );
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
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
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
  [GcWindow]::SetWindowPos($h, [IntPtr]::Zero, 100, 100, 0, 0, 0x0041) | Out-Null
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
} elseif (${geometryCases[state] ? "$true" : "$false"}) {
  [GcWindow]::PostMessage($h, 0x8001, [IntPtr](${geometryCases[state]?.[0] ?? 0}), [IntPtr](${geometryCases[state]?.[1] ?? 0})) | Out-Null
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
  if (recordingTest && core) {
    const exit = core.exitCode ?? await new Promise(resolve => {
      const timer = setTimeout(() => resolve("timeout"), 15_000);
      core.once("exit", code => { clearTimeout(timer); resolve(code); });
    });
    if (exit !== 0) {
      for (const child of [cover, fixture, core]) { try { child?.kill(); } catch {} }
      throw new Error(`core did not shut down cleanly after recording: ${exit}`);
    }
    log("core shutdown exit 0");
  }
  for (const child of [cover, fixture, core]) {
    try { child?.kill(); } catch {}
  }
  await delay(500);
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  else log(`kept temp directory: ${tmp}`);
}

try {
  if (!diagnosticsOnly) {
    for (const [name, file] of Object.entries(privatePayload)) {
      const expected = payloadManifest.files[name];
      const actualHash = sha256(file);
      if (actualHash !== expected.sha256) {
        throw new Error(`packaged ${name} hash mismatch: expected ${expected.sha256}, got ${actualHash}`);
      }
      const signature = authenticode(file);
      if (
        signature.status !== "Valid" ||
        signature.signer !== payloadManifest.signer ||
        signature.thumbprint !== expected.signerThumbprint
      ) {
        throw new Error(`packaged ${name} signer mismatch: ${JSON.stringify(signature)}`);
      }
    }
  }
  core = spawn(
    coreExe,
    ["--config-dir", tmp, "--core-bin", coreBin, "--games", path.join(tmp, "games.json"), "--port", "0"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SHARD_GAME_CAPTURE_DIAGNOSTICS: "1",
      },
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
    if (message.method === "recording.state" && message.params?.path) recordingPaths.add(message.params.path);
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else request.resolve(message.result);
      return;
    }
    const index = waiters.findIndex(
      (waiter) => waiter.name === message.method && waiter.predicate(message.params),
    );
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message.params);
  });
  const readyEvent = waitEvent("ready", 15_000);
  const expectedSubjectName = path.basename(fixtureExe, ".exe").toLowerCase();
  const subjectEvent = useExistingTarget
    ? undefined
    : waitEvent(
        "capture.subject",
        60_000,
        (params) => params?.kind === "game" && params?.name?.toLowerCase() === expectedSubjectName,
      );
  await readyEvent;
  if (targetLauncher) {
    fixture = spawn(targetLauncher, [], { cwd: path.dirname(targetLauncher), stdio: "ignore" });
  } else if (!useExistingTarget) {
    fixture = spawn(fixtureExe, [], { stdio: "ignore" });
  }
  await focusTargetWhenReady();
  const focusedAt = Date.now();
  let focusPulse;
  if (subjectEvent) {
    focusPulse = setInterval(() => {
      try { setTargetState("focused"); } catch {}
    }, 1500);
  }
  let subject;
  try {
    subject = subjectEvent ? await subjectEvent : { kind: "game", name: path.basename(fixtureExe, ".exe") };
  } finally {
    clearInterval(focusPulse);
  }
  if (subject.kind !== "game") throw new Error(`unexpected capture subject: ${JSON.stringify(subject)}`);
  const detectionMs = Date.now() - focusedAt;
  if (subjectEvent && detectionMs > 5_000) {
    throw new Error(`unknown game detection took ${detectionMs}ms (expected <= 5000ms)`);
  }
  log(`capture subject: ${subject.name} (live detection ${detectionMs}ms)`);

  if (!diagnosticsOnly) {
    let buffered = 0;
    const warmDeadline = Date.now() + 60_000;
    while (buffered < 6 && Date.now() < warmDeadline) {
      const stats = await waitEvent("ring.stats", 10_000);
      buffered = stats.secondsBuffered ?? 0;
    }
  }
  const rows = [];
  if (recordingTest) await call("recording.start");
  for (const state of states) {
    const phaseStart = coreErr.length;
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
    if (geometryTest) {
      const replacement = geometryCases[state];
      if (replacement) expectedSize = replacement;
      const [width, height] = expectedSize;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const logs = coreErr.slice(replacement ? phaseStart : 0);
        if (logs.includes(`canvas ${width}x${height}, resized=true`) &&
            (!replacement || logs.includes("game window replaced"))) break;
        await delay(200);
      }
      const logs = coreErr.slice(replacement ? phaseStart : 0);
      if (!logs.includes(`canvas ${width}x${height}, resized=true`))
        throw new Error(`capture never reached native ${width}x${height}\n${logs}`);
      await delay(4500); // Refill after the stream-size boundary before saving.
    }
    await delay(diagnosticsOnly ? 5000 : 4000);
    if (diagnosticsOnly) {
      rows.push({ state });
      continue;
    }
    const saved = await saveClip();
    const freshness = uniqueFrameHashes(saved.path);
    if (geometryTest) {
      const probe = spawnSync(path.join(coreBin, "ffprobe.exe"), ["-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "json", saved.path], {encoding:"utf8"});
      const stream = JSON.parse(probe.stdout).streams[0];
      if (stream.width !== expectedSize[0] || stream.height !== expectedSize[1])
        throw new Error(`wrong native size: ${JSON.stringify(stream)} expected ${expectedSize}`);
      const frame = spawnSync(ffmpegExe, ["-v", "error", "-ss", "1", "-i", saved.path,
        "-vf", "scale=64:48", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], {maxBuffer:1024*1024});
      if (frame.status !== 0 || frame.stdout.length !== 64*48*3) throw new Error("edge check decode failed");
      const center = (24*64+32)*3;
      for (const pixel of [0, 63, 47*64, 48*64-1])
        for (let channel=0;channel<3;channel++)
          if (Math.abs(frame.stdout[pixel*3+channel]-frame.stdout[center+channel])>15)
            throw new Error(`added border at ${state} corner ${pixel}`);
      log(`native ${stream.width}x${stream.height}, no added edge bars`);
    }
    const fresh = freshness.decodedFrames >= 10 && freshness.uniqueFrames >= 5;
    rows.push({ state, path: saved.path, ...freshness, fresh });
    if (!fresh) throw new Error(`${state} capture froze: ${JSON.stringify(freshness)}`);
  }

  await delay(500);
  if (recordingTest) {
    const stopped = waitEvent("recording.state", 15_000, params => !params.active);
    await call("recording.stop");
    await stopped;
    const sizes = [];
    for (const recording of recordingPaths) {
      const info = spawnSync(path.join(coreBin, "ffprobe.exe"), ["-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "json", recording], {encoding:"utf8"});
      if (info.status !== 0) throw new Error(`recording probe failed: ${info.stderr}`);
      const stream = JSON.parse(info.stdout).streams[0];
      sizes.push(`${stream.width}x${stream.height}`);
      const decoded = spawnSync(ffmpegExe, ["-v", "error", "-i", recording, "-map", "0:v:0", "-f", "null", "-"], {encoding:"utf8"});
      if (decoded.status !== 0 || decoded.stderr.trim()) throw new Error(`recording decode failed: ${decoded.stderr}`);
    }
    if (recordingPaths.size < 2 || !sizes.includes(expectedSize.join("x")))
      throw new Error(`recording did not continue at new size: ${sizes}`);
    log(`recording segments finalized and decode cleanly: ${sizes.join(", ")}`);
  }
  const diagnostics = coreErr.split(/\r?\n/).filter((line) => line.includes("[GC]"));
  if (!diagnosticsOnly && states.includes("minimized") &&
      !diagnostics.some((line) => line.includes("stage=WindowLayer minimized=true wgc_visible=false"))) {
    throw new Error(`minimized capture did not suppress the opaque WGC layer\n${diagnostics.join("\n")}`);
  }
  if (!expectedBlockStage) {
    for (const expected of [
      "stage=HelperPayloadVerification result=success",
      "stage=HookDllPayloadVerification result=success",
      "injection_hook_source=shard_private_official_obs",
    ]) {
      if (!diagnostics.some((line) => line.includes(expected))) {
        throw new Error(`missing isolation diagnostic: ${expected}\n${diagnostics.join("\n")}`);
      }
    }
    const injectionPathLine = diagnostics.find((line) => line.includes("injection_hook_path="));
    if (!injectionPathLine || !injectionPathLine.toLowerCase().includes(privateHookDir.toLowerCase())) {
      throw new Error(`Shard did not select its private hook: ${injectionPathLine ?? "<missing>"}`);
    }
  }

  let helperActive = false;
  let lastHelperLaunchAt;
  for (const line of diagnostics) {
    if (line.includes("stage=HelperLaunch result=success")) {
      const timestamp = Number(line.match(/ts_ms=(\d+)/)?.[1]);
      if (helperActive) throw new Error(`overlapping compatibility helper attempt: ${line}`);
      if (lastHelperLaunchAt !== undefined && timestamp - lastHelperLaunchAt < 10_000) {
        throw new Error(`compatibility helper relaunched before capture initialization timeout: ${line}`);
      }
      helperActive = true;
      lastHelperLaunchAt = timestamp;
    } else if (line.includes("stage=HelperExit")) {
      helperActive = false;
    }
  }

  if (expectedBlockStage) {
    if (!["HookDllPayloadHash", "HelperPayloadHash"].includes(expectedBlockStage)) {
      throw new Error(`unsupported expected block stage: ${expectedBlockStage}`);
    }
    if (!diagnostics.some((line) => line.includes(`stage=${expectedBlockStage}`))) {
      throw new Error(`missing payload rejection diagnostic: ${expectedBlockStage}\n${diagnostics.join("\n")}`);
    }
    if (diagnostics.some((line) => line.includes("stage=HelperLaunch result=success"))) {
      throw new Error(`unverified payload reached helper launch\n${diagnostics.join("\n")}`);
    }
    console.table(rows);
    log(`PASS: injection failed closed at ${expectedBlockStage}`);
  } else {
    const requiredStages = [
      "stage=HelperLaunch result=success",
      "stage=HelperExit result=success",
      "stage=HookInfo result=opened",
      "stage=IpcEvents result=opened",
      "stage=HookInitializeSignal result=success",
      "stage=HookReady result=signaled",
      "stage=FrameImport result=success",
    ];
    for (const stage of requiredStages) {
      if (!diagnostics.some((line) => line.includes(stage))) {
        throw new Error(`missing Game Capture diagnostic: ${stage}\n${diagnostics.join("\n")}`);
      }
    }
    const firstFrameImport = diagnostics.findIndex((line) => line.includes("stage=FrameImport result=success"));
    const initialLaunches = diagnostics
      .slice(0, firstFrameImport)
      .filter((line) => line.includes("stage=HelperLaunch result=success"));
    if (initialLaunches.length !== 1) {
      throw new Error(`expected one compatibility helper before capture initialization, got ${initialLaunches.length}`);
    }
    console.table(rows.map(({ state, decodedFrames, uniqueFrames, fresh }) => ({ state, decodedFrames, uniqueFrames, fresh })));
    log(`PASS: official OBS compatibility payload loaded and all requested states produced fresh ${api} frames`);
  }
  for (const line of diagnostics) console.log(line);
} catch (error) {
  for (const line of coreErr.split(/\r?\n/).filter(
    (line) => line.includes("[GC]") || line.includes("[GameDetection]") || line.startsWith("  "),
  )) console.error(line);
  throw error;
} finally {
  await cleanup();
}
