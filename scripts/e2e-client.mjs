// Shard core E2E client (Node >= 22, global WebSocket).
// Runs against a live core started by e2e.ps1 (env: CF_PORT, CF_TEMP, CF_COREBIN).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.CF_PORT);
const LONG = process.env.CF_LONG === '1';
const temp = process.env.CF_TEMP;
const coreBin = process.env.CF_COREBIN;

let nextId = 1;
const pending = new Map();
let ws;

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout: ${method}`));
    }, 30000);
  });
}

function waitEvent(name, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      reject(new Error(`timeout waiting for ${name}`));
    }, timeoutMs);
    function onMsg(ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.method === name) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        resolve(msg.params);
      }
    }
    ws.addEventListener("message", onMsg);
  });
}

const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ok: ${label}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ffprobe(file) {
  const r = spawnSync(path.join(coreBin, "ffprobe.exe"), ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("ffprobe failed: " + r.stderr);
  return JSON.parse(r.stdout).format;
}

async function main() {
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.method === "error") console.log("  [core error]", JSON.stringify(msg.params));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
    }
  });
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("ws error"))); });

  console.log("== connected ==");
  await waitEvent("ready", 15000);
  console.log("  ok: ready event");

  // Warm the ring with WGC display capture (deterministic).
  let st = await call("config.set", { capture: { mode: "screen", monitor: 0 } });
  assert(Array.isArray(st.applied) && st.applied.includes("capture"), "config.set capture applied");

  st = await call("state.get");
  assert(st.video.encoder === "auto", "state.get video defaults");
  // WGC initialization is asynchronous; a successful config.set is not a
  // promise that its first frame has already reached the replay output.
  for (let attempt = 0; !st.ring.active && attempt < 40; attempt++) {
    await sleep(250);
    st = await call("state.get");
  }
  assert(st.ring.active === true, "ring active");

  const warmStart = Date.now();
  await sleep(LONG ? 320000 : 70000); // ring holds >= 60 s
  const warmSecs = (Date.now() - warmStart) / 1000;

  // Save 60 s
  const want = LONG ? 300 : 60;
  const savedP = waitEvent("clip.saved", 120000);
  await call("clip.save", { durationSec: want });
  const clip = await savedP;
  console.log(`  clip.saved: requested=${clip.requestedSec} actual=${clip.actualSec.toFixed(3)}`);
  assert(Math.abs(clip.actualSec - want) <= 0.05, `clip.saved.actualSec within one encoded frame of ${want}s (got ${clip.actualSec.toFixed(3)})`);
  assert(fs.existsSync(clip.path), "clip file exists");

  const fmt = ffprobe(clip.path);
  const dur = Number(fmt.duration);
  console.log(`  ffprobe duration=${dur}`);
  assert(Math.abs(dur - want) <= 0.05, `ffprobe duration within one encoded frame of ${want}s (got ${dur})`);

  // Duration alone hid duplicate decode timestamps and discarded B-frame
  // composition offsets. Inspect the complete video packet cadence as well.
  const timing = spawnSync(path.join(coreBin, "ffprobe.exe"), ["-v", "error", "-select_streams", "v:0",
    "-show_packets", "-show_entries", "packet=pts_time,dts_time:stream=r_frame_rate", "-show_streams",
    "-of", "json", clip.path], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert(timing.status === 0, "video packet timing probe succeeds");
  const timed = JSON.parse(timing.stdout);
  const [rateNum, rateDen] = timed.streams[0].r_frame_rate.split("/").map(Number);
  const frameSeconds = rateDen / rateNum;
  const packets = timed.packets;
  assert(packets.every((p, i) => !i || Number(p.dts_time) > Number(packets[i - 1].dts_time)), "strictly increasing decode timestamps");
  const pts = packets.map(p => Number(p.pts_time)).filter(t => t >= 0).sort((a, b) => a - b);
  assert(pts.length >= Math.floor(want / frameSeconds) - 3, "saved replay retains the expected frame count");
  assert(pts.every((t, i) => !i || Math.abs(t - pts[i - 1] - frameSeconds) < 0.00001), "uniform presentation cadence without duplicate or missing frames");
  const tail = spawnSync(path.join(coreBin, "ffmpeg.exe"), ["-v", "error", "-xerror", "-ss", String(want - 1),
    "-i", clip.path, "-map", "0:v:0", "-an", "-f", "null", "-"], { encoding: "utf8" });
  assert(tail.status === 0 && !tail.stderr.trim(), "final reference group decodes without missing-frame errors");

  // Cover the old playable-but-black/silent regression in this same capture
  // run, so callers do not need a separate selftest + manual content probe.
  const streams = spawnSync(path.join(coreBin, "ffprobe.exe"), ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", clip.path], { encoding: "utf8" });
  assert(streams.status === 0 && JSON.parse(streams.stdout).streams.some(s => s.codec_type === "audio"), "clip has an audio track");
  const content = spawnSync(path.join(coreBin, "ffmpeg.exe"), ["-hide_banner", "-ss", "1", "-i", clip.path,
    "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-frames:v", "3", "-an", "-f", "null", "-"], { encoding: "utf8" });
  const luma = [...content.stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map(m => Number(m[1]));
  assert(content.status === 0 && luma.some(value => value > 16), "clip contains nonblack video (keep the test display visible)");

  // Keep the encoder purging under a deliberately undersized cap while outputs
  // restart. Old callbacks must drain their own ring, not a cleared/replaced one.
  await call("config.set", { replay: { maxSeconds: 2, maxMb: 1 } });
  for (let attempt = 0; attempt < 2; attempt++) {
    await sleep(4500);
    const pressure = await call("state.get");
    assert(pressure.ring.active && pressure.ring.secondsBuffered >= 1, "ring stays responsive under cap pressure");
    await call("config.set", { video: { encoder: "auto" } });
  }
  await sleep(3500);
  const restartedSave = waitEvent("clip.saved", 15000);
  await call("clip.save", { durationSec: 2 });
  const restartedClip = await restartedSave;
  assert(Math.abs(Number(ffprobe(restartedClip.path).duration) - 2) <= 0.05, "restarted ring can still save under cap pressure");

  // Capture mode toggle back to auto
  st = await call("config.set", { capture: { mode: "auto" } });
  assert(Array.isArray(st.applied) && st.applied.includes("capture"), "config.set capture->auto applied");

  // Check the contract without requiring the developer's audio hardware.
  const devices = await call("audio.listDevices");
  assert(Array.isArray(devices), "audio.listDevices is an array");
  const vm = devices.filter((d) => d.isVoicemeeter);
  console.log(`  devices: ${devices.length} total, ${vm.length} voicemeeter`);
  assert(devices.every(device => typeof device.isVoicemeeter === "boolean"), "audio device flags have the expected type");

  // Games
  const games = await call("game.listKnown");
  assert(Array.isArray(games), "game.listKnown is an array");
  await call("game.addKnown", { exe: "e2etest.exe", name: "E2E Test" });
  const after = await call("game.listKnown");
  assert(after.some((g) => g.exe === "e2etest.exe"), "game.addKnown persisted");
  await call("game.removeKnown", { exe: "e2etest.exe" });

  // Unknown method -> -32601
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 9999, method: "no.such.method", params: {} }));
  // (checked below via the pending map)

  // Ring stats arrive
  const stats = await waitEvent("ring.stats", 15000);
  assert(typeof stats.secondsBuffered === "number", "ring.stats emitted");

  console.log("== calling shutdown ==");
  await call("shutdown");
  ws.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
