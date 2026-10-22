import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import electron from "electron";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const app = path.resolve(import.meta.dirname, "..");
function load(relative) {
  const exports = {};
  const file = path.join(app, "src/shared", relative);
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports });
  return exports;
}
const { DEFAULT_SETTINGS } = load("contracts.ts");
const { reconcileReplaySettings: reconcile, replayMemoryMb, replayHotkeyMinimum } = load("replay-policy.ts");
const initial = structuredClone(DEFAULT_SETTINGS);
let next = reconcile({ ...initial, replay: { maxSeconds: 300, maxMb: 256 },
  hotkeys: [{ id: "long", accelerator: "F8", action: "save_clip", durationSec: 600 }] });
assert.equal(next.replay.maxSeconds, 600);
assert.equal(next.replay.maxMb, replayMemoryMb(next, 600));
const expanded = reconcile({ ...next, replay: { ...next.replay, maxSeconds: 1200 } }, next);
assert.equal(expanded.replay.maxMb, replayMemoryMb(expanded, 1200));
const reduced = reconcile({ ...expanded, replay: { ...expanded.replay, maxMb: 1024 } }, expanded);
assert.ok(reduced.replay.maxSeconds >= 600 && reduced.replay.maxSeconds < 1200);
assert.equal(reduced.replay.maxMb, 1024);
next = reconcile({ ...expanded, replay: { ...expanded.replay, maxMb: 256 } }, expanded);
assert.equal(next.replay.maxSeconds, 600);
assert.equal(next.replay.maxMb, replayMemoryMb(next, 600));
assert.equal(replayHotkeyMinimum({ ...next, hotkeys: [{ action: "save_clip", accelerator: "", durationSec: 3600 },
  { action: "toggle_record", accelerator: "F8", durationSec: 3600 }] }), 30);
const high = reconcile({ ...next, video: { ...next.video, preset: "high" } }, next);
assert.equal(high.replay.maxSeconds, 600);
assert.ok(high.replay.maxMb > next.replay.maxMb);
const withRows = reconcile({ ...high, audio: { sources: Array.from({ length: 8 }, () => ({ enabled: false })) } }, high);
assert.ok(withRows.replay.maxMb > high.replay.maxMb);
assert.equal(replayMemoryMb(withRows, 600), replayMemoryMb({ ...withRows, audio: { sources: withRows.audio.sources.slice(0, 5) } }, 600));
assert.equal(reconcile({ ...next, game: { ...next.game, graceSeconds: 301 } }).game.graceSeconds, 301);
assert.equal(reconcile({ ...next, game: { ...next.game, graceSeconds: 0 } }).game.graceSeconds, 0);
assert.equal(JSON.stringify(reconcile(next)), JSON.stringify(next));
assert.equal(DEFAULT_SETTINGS.game.graceSeconds, 15);
console.log("Replay policy: shortcut floor, linked caps, quality/audio changes and stop delays passed");
const { parseDuration, formatDuration, formatDurationLong } = load("duration.ts");
for (const [input, seconds] of [["30s", 30], ["30sec", 30], ["30 seconds", 30], ["5m", 300], ["5min", 300], ["5 Minutes", 300],
  ["1h 30m", 5400], ["1m30s", 90], ["1.5m", 90], ["90", 90], ["1:30", 90], ["1:02:03", 3723], [" 2H ", 7200], ["0", 0]])
  assert.equal(parseDuration(input), seconds, input);
for (const input of ["", "soon", "5x", "1:75", "m5", "5m-"]) assert.equal(parseDuration(input), null, input);
assert.equal(formatDuration(300), "5m");
assert.equal(formatDuration(90), "1m 30s");
assert.equal(formatDuration(3605), "1h 5s");
assert.equal(formatDuration(3725, true), "1h 2m");
assert.equal(formatDuration(0), "0s");
assert.equal(formatDurationLong(61), "1 minute 1 second");
console.log("Duration input: units, combinations, clock notation, invalid input and compact formatting passed");

const tempRoot = path.resolve(app, "../tmp");
await mkdir(tempRoot, { recursive: true });
const fixture = await mkdtemp(path.join(tempRoot, "replay-settings-"));
let passed = false;
try {
  const profile = path.join(fixture, "settings-profile");
  await mkdir(profile);
  await writeFile(path.join(profile, "settings.json"), JSON.stringify({ ...initial,
    replay: { maxSeconds: 300, maxMb: 256 }, hotkeys: [{ id: "long", accelerator: "F8", action: "save_clip", durationSec: 600 }],
    game: { ...initial.game, graceSeconds: 301 } }));
  const persisted = {};
  const mainCode = ts.transpileModule(readFileSync(path.join(app, "src/main/settings.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(mainCode, { exports: persisted, structuredClone, require: name => name === "electron"
    ? { app: { getPath: () => profile } } : name === "../shared/contracts" ? { DEFAULT_SETTINGS }
    : name === "../shared/replay-policy" ? { reconcileReplaySettings: reconcile } : require(name) });
  const loaded = await persisted.loadSettings();
  assert.equal(loaded.replay.maxSeconds, 600);
  assert.equal(loaded.replay.maxMb, replayMemoryMb(loaded, 600));
  assert.equal(loaded.game.graceSeconds, 301); // Preserve a saved custom delay.
  await persisted.saveSettings({ ...loaded, replay: { ...loaded.replay, maxMb: 1024 } });
  const saved = JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8"));
  assert.ok(saved.replay.maxSeconds > 600);
  assert.equal(saved.replay.maxMb, 1024);
  assert.equal(JSON.stringify(saved), JSON.stringify(persisted.getSettings()));
  console.log("Replay persistence: legacy shortcut mismatch repaired, memory edit linked, saved custom delay preserved");
  await writeFile(path.join(fixture, "index.html"), '<div id="root"></div><script type="module" src="/entry.tsx"></script>');
  await writeFile(path.join(fixture, "entry.tsx"), `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {CaptureSettingsPanel} from '../../app/src/renderer/components/GeneralSettingsPanels';
import {HotkeysSettings} from '../../app/src/renderer/components/HotkeysSettings';
import {DEFAULT_SETTINGS} from '../../app/src/shared/contracts';
import {reconcileReplaySettings} from '../../app/src/shared/replay-policy';
import '../../app/src/renderer/styles.css';
window.shard = {platform:'win32', getHotkeyStatus:async()=>[], onHotkeyStatus:()=>()=>{}};
function Fixture() {
 const [settings,setSettings] = React.useState(()=>reconcileReplaySettings({...structuredClone(DEFAULT_SETTINGS), replay:{maxSeconds:300,maxMb:512}}));
 const change = next => setSettings(previous=>reconcileReplaySettings(next,previous));
 window.fixture = {settings};
 return <div data-shard-page="settings" style={{padding:24}}><CaptureSettingsPanel settings={settings} onChange={change} monitors={[]}/>
 <HotkeysSettings hotkeys={settings.hotkeys} onChange={hotkeys=>change({...settings,hotkeys})}/></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
  await build({ root: fixture, configFile: false, logLevel: "warn", plugins: [react()],
    resolve: { alias: { react: path.join(app, "node_modules/react"), "react-dom": path.join(app, "node_modules/react-dom") } },
    base: "./", build: { outDir: "dist", emptyOutDir: true } });
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(app, "scripts/test-replay-settings.cjs"), fixture], { stdio: "inherit", windowsHide: true });
    child.once("error", reject); child.once("exit", resolve);
  });
  assert.equal(code, 0, "Replay settings UI checks");
  passed = true;
} finally {
  if (passed) await rm(fixture, { recursive: true, force: true });
  else console.error(`Replay settings fixture kept for diagnostics: ${fixture}`);
}
