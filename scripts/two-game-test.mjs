// Two-game focus-following test: with two games running, capture must follow
// the ACTIVE (foreground) game after the 1.5 s debounce.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const coreBin = path.resolve(process.env.CF_COREBIN ?? "app/resources/core-bin");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-2game-"));
const coreExe = path.join(coreBin, "shardcore.exe");

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
const fixtures = [];

async function waitSubject(name, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await call("state.get");
    if (state.capture.subject.kind === "game" && state.capture.subject.name === name)
      return state.capture.subject;
    await sleep(500);
  }
  throw new Error(`capture did not switch to ${name}`);
}

async function focusGame(title) {
  // Windows may deny focus while the form is starting. Require a successful
  // activation before measuring the detector; process creation alone is not
  // user intent, especially now that background games qualify independently.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = focus(title);
    if (result.status === 0 && result.stdout.includes("FOCUSED")) return;
    await sleep(500);
  }
  throw new Error(`could not foreground fixture ${title}`);
}

// Spawn a fake game window (WinForms form of the given color/title).
function spawnForm(game, color, title) {
  return spawn(game.exe, ["-NoProfile", "-Command",
    `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.FormBorderStyle = 'FixedSingle'; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(80,80); $f.Size = New-Object System.Drawing.Size(900,600); $f.BackColor = [System.Drawing.Color]::${color}; $f.Show(); [System.Windows.Forms.Application]::Run($f)`],
    { stdio: "ignore" });
}
// Bring a window to the foreground by title. AppActivate is blocked by
// Windows' foreground-lock when real apps hold focus (the game window never
// gets activated, so the focus-following assertion can't pass on a busy
// desktop); the fake-ALT press makes this process foreground-eligible first,
// then SetForegroundWindow forces the switch.
function focus(title) {
  return spawnSync("powershell.exe", ["-NoProfile", "-Command",
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public class FL { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWndProc cb, IntPtr lp); public delegate bool EnumWndProc(IntPtr h, IntPtr lp); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c); [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h); public static IntPtr Find(string title) { IntPtr found = IntPtr.Zero; EnumWindows((h, lp) => { int len = GetWindowTextLength(h); if (len > 0) { StringBuilder sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity); if (sb.ToString() == title) { found = h; return false; } } return true; }, IntPtr.Zero); return found; } }'; $h = [FL]::Find('${title}'); if ($h -eq [IntPtr]::Zero) { Write-Output 'NOTFOUND'; exit 1 }; [FL]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [FL]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50; [FL]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 100; if ([FL]::GetForegroundWindow() -eq $h) { Write-Output 'FOCUSED' } else { exit 2 }`], { encoding: "utf8" });
}

try {
  log("spawning game A...");
  fixtures.push(spawnForm(gameA, "Red", "GAMEA"));
  let subj = await waitSubject("Game A");
  log("after A start: subject =", JSON.stringify(subj));
  if (subj.kind !== "game" || subj.name !== "Game A") throw new Error("A not captured");

  log("spawning game B...");
  fixtures.push(spawnForm(gameB, "Blue", "GAMEB"));
  await focusGame("GAMEB");
  subj = await waitSubject("Game B");
  log("after B start: subject =", JSON.stringify(subj));
  if (subj.kind !== "game" || subj.name !== "Game B") throw new Error("focused B not captured");

  log("focusing game A (debounce 1.5s)...");
  await focusGame("GAMEA");
  log("after focusing A: subject =", JSON.stringify(await waitSubject("Game A")));

  log("focusing game B...");
  await focusGame("GAMEB");
  log("after focusing B: subject =", JSON.stringify(await waitSubject("Game B")));

  log("PASS: capture follows the active game (A -> B -> A -> B)");
  await call("shutdown");
  process.exitCode = 0;
} catch (e) {
  console.error("FAIL:", e.message);
  try { await call("shutdown"); } catch {}
  process.exitCode = 1;
} finally {
  ws.close();
  for (const fixture of fixtures) fixture.kill();
  core.kill();
}
