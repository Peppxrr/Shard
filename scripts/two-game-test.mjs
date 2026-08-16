// Two-game focus-following test: with two games running, capture must follow
// the ACTIVE (foreground) game after the 10 s debounce.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const coreBin = path.resolve("app/resources/core-bin");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-2game-"));
const coreExe = path.join(coreBin, "clipcore.exe");

function makeGame(name, color, title) {
  const exe = path.join(tmp, name);
  fs.copyFileSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", exe);
  return { exe, title };
}
const gameA = makeGame("cfgame-a.exe", "Red", "GAMEA");
const gameB = makeGame("cfgame-b.exe", "Blue", "GAMEB");
fs.writeFileSync(path.join(tmp, "games.json"),
  JSON.stringify([{ exe: "cfgame-a.exe", name: "Game A" }, { exe: "cfgame-b.exe", name: "Game B" }]));

const core = spawn(coreExe, ["--config-dir", tmp, "--core-bin", coreBin, "--games", path.join(tmp, "games.json"), "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
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
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
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

const log = (...a) => console.log("[2game]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn a fake game window (WinForms form of the given color/title).
function spawnForm(game, color, title) {
  return spawn(game.exe, ["-NoProfile", "-Command",
    `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.FormBorderStyle = 'FixedSingle'; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(80,80); $f.Size = New-Object System.Drawing.Size(900,600); $f.BackColor = [System.Drawing.Color]::${color}; $f.Show(); [System.Windows.Forms.Application]::Run($f)`],
    { stdio: "ignore" });
}
// Bring a window to the foreground by title.
function focus(title) {
  return spawnSync("powershell.exe", ["-NoProfile", "-Command",
    `$ws = New-Object -ComObject WScript.Shell; $ws.AppActivate('${title}')`], { encoding: "utf8" });
}

try {
  log("spawning game A...");
  spawnForm(gameA, "Red", "GAMEA");
  let subj = await waitEvent("capture.subject", 30000);
  log("after A start: subject =", JSON.stringify(subj));
  if (subj.kind !== "game" || subj.name !== "Game A") throw new Error("A not captured");

  log("spawning game B...");
  spawnForm(gameB, "Blue", "GAMEB");
  subj = await waitEvent("capture.subject", 30000);
  log("after B start: subject =", JSON.stringify(subj));
  if (subj.kind !== "game" || subj.name !== "Game B") throw new Error("B not captured (newest should win)");

  log("focusing game A (debounce 10s)...");
  focus("GAMEA");
  await sleep(13000);
  const st = await call("state.get");
  log("after focusing A + 13s: subject =", JSON.stringify(st.capture.subject));
  if (st.capture.subject.name !== "Game A") throw new Error("capture did not follow focus back to A");

  log("focusing game B...");
  focus("GAMEB");
  await sleep(13000);
  const st2 = await call("state.get");
  log("after focusing B + 13s: subject =", JSON.stringify(st2.capture.subject));
  if (st2.capture.subject.name !== "Game B") throw new Error("capture did not follow focus back to B");

  log("PASS: capture follows the active game (A -> B -> A -> B)");
  await call("shutdown");
  process.exit(0);
} catch (e) {
  console.error("FAIL:", e.message);
  try { await call("shutdown"); } catch {}
  process.exit(1);
}
