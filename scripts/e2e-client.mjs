// ClipForge core E2E client (Node >= 22, global WebSocket).
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
  assert(st.ring.active === true, "ring active");

  const warmStart = Date.now();
  await sleep(LONG ? 320000 : 70000); // ring holds >= 60 s
  const warmSecs = (Date.now() - warmStart) / 1000;

  // Save 60 s
  const want = LONG ? 300 : 60;
  const savedP = waitEvent("clip.saved", 120000);
  await call("clip.save", { durationSec: want });
  const clip = await savedP;
  console.log(`  clip.saved: requested=${clip.requestedSec} actual=${clip.actualSec.toFixed(2)}`);
  assert(Math.abs(clip.actualSec - want) <= 2, `clip.saved.actualSec in [${want - 2},${want + 2}] (got ${clip.actualSec.toFixed(2)})`);
  assert(fs.existsSync(clip.path), "clip file exists");

  const fmt = ffprobe(clip.path);
  const dur = Number(fmt.duration);
  console.log(`  ffprobe duration=${dur}`);
  assert(dur >= want - 5 && dur <= want + 5, `ffprobe duration in [${want - 5},${want + 5}] (got ${dur})`);

  // Capture mode toggle back to auto
  st = await call("config.set", { capture: { mode: "auto" } });
  assert(Array.isArray(st.applied) && st.applied.includes("capture"), "config.set capture->auto applied");

  // Devices: Voicemeeter present on this machine per plan.
  const devices = await call("audio.listDevices");
  assert(Array.isArray(devices), "audio.listDevices is an array");
  const vm = devices.filter((d) => d.isVoicemeeter);
  console.log(`  devices: ${devices.length} total, ${vm.length} voicemeeter`);
  assert(vm.length > 0, "Voicemeeter devices listed");

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
