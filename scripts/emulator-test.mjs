// Custom folder + emulator end-to-end: add a folder, rescan, detect the
// emulator process, and confirm the session carries the emulator flag.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const coreBin = path.resolve("app/resources/core-bin");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-emu-"));
const emuDir = path.join(tmp, "Emus");
fs.mkdirSync(emuDir, { recursive: true });
const dolphinExe = path.join(emuDir, "Dolphin.exe");
fs.copyFileSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", dolphinExe);

const core = spawn(path.join(coreBin, "clipcore.exe"), ["--config-dir", tmp, "--core-bin", coreBin, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
let stdoutBuf = "";
core.stderr.on("data", (d) => process.stderr.write("[core] " + d));
core.stdout.on("data", (d) => (stdoutBuf += d));
const port = await new Promise((res, rej) => {
  const t = setInterval(() => {
    const m = stdoutBuf.match(/^PORT (\d+)\r?$/m);
    if (m) { clearInterval(t); res(Number(m[1])); }
    else if (core.exitCode !== null) rej(new Error("core exited"));
  }, 200);
});
let ws, id = 0;
const pending = new Map();
const waiters = [];
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }));
    setTimeout(() => reject(new Error("timeout: " + method)), 20000);
  });
}
function waitEvent(name, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${name}`)), timeoutMs);
    waiters.push({ name, resolve: (p) => { clearTimeout(timer); resolve(p); } });
  });
}
ws = new WebSocket(`ws://127.0.0.1:${port}`);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m.result); } return; }
  const i = waiters.findIndex((w) => w.name === m.method);
  if (i >= 0) waiters.splice(i, 1)[0].resolve(m.params);
};
await waitEvent("ready", 15000);
const log = (...a) => console.log("[emu]", ...a);

try {
  const add = await call("game.addCustomFolder", { name: "My Emulators", path: emuDir, emulator: true });
  if (!add.ok) throw new Error("addCustomFolder failed");
  log("folder added:", add.id);
  await call("game.refreshDiscovery");
  const games = await call("game.listGames");
  const dolph = games.find((g) => g.executables.includes("dolphin.exe"));
  if (!dolph) throw new Error("dolphin not discovered from custom folder");
  if (!dolph.emulator) throw new Error("emulator flag not set");
  log("discovered:", dolph.name, "emulator=" + dolph.emulator, "launcher=" + dolph.launchers[0].type);

  const startedP = waitEvent("game.session", 30000);
  const subjP = waitEvent("capture.subject", 30000);
  const form = spawn(dolphinExe, ["-NoProfile", "-Command",
    "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = 'Super Mario Galaxy'; $f.Size = New-Object System.Drawing.Size(900,600); $f.BackColor = [System.Drawing.Color]::Green; $f.Show(); [System.Windows.Forms.Application]::Run($f)"],
    { stdio: "ignore" });
  const sess = await startedP;
  log("session:", sess.state, sess.name, "emulator=" + sess.emulator);
  if (!sess.emulator) throw new Error("session lost the emulator flag");
  const subj = await subjP;
  log("subject:", JSON.stringify(subj));
  if (subj.kind !== "game") throw new Error("emulator process not captured");
  const st = await call("state.get");
  log("sessions:", JSON.stringify(st.sessions.map((s) => ({ name: s.name, emulator: s.emulator }))));

  log("PASS: custom emulator folder -> discovery -> detection -> capture");
  await call("shutdown");
  form.kill();
  process.exit(0);
} catch (e) {
  console.error("FAIL:", e.message);
  try { await call("shutdown"); } catch {}
  process.exit(1);
}
