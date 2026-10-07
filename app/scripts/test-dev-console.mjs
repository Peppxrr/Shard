import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import electron from "electron";
const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadTs(file) {
  const absolute = path.resolve(appDir, file);
  const loaded = new Module(absolute);
  loaded.filename = absolute;
  loaded.paths = Module._nodeModulePaths(path.dirname(absolute));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = id => id === "../shared/dev-console" ? loadTs("src/shared/dev-console.ts") : originalRequire(id);
  const source = require("node:fs").readFileSync(absolute, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  loaded._compile(compiled, absolute);
  return loaded.exports;
}

const { CoreLineDecoder } = loadTs("src/main/core-line-decoder.ts");
const { classifyDevConsoleSeverity, devConsoleSource, filterDevConsoleLines, serializeDevConsoleLines } = loadTs("src/shared/dev-console.ts");

const decoded = [];
const decoder = new CoreLineDecoder(line => decoded.push(line));
const emoji = Buffer.from("🌲");
decoder.push(Buffer.from("first\r"));
decoder.push(Buffer.from("\nemoji "));
decoder.push(emoji.subarray(0, 2));
decoder.push(emoji.subarray(2));
decoder.push(Buffer.from("\r"));
decoder.push(Buffer.from("\nfinal partial"));
decoder.finish();
assert.deepEqual(decoded, ["first", "emoji 🌲", "final partial"]);

assert.equal(classifyDevConsoleSeverity("capture health: frames=60 retry=0", "stderr"), "info");
assert.equal(classifyDevConsoleSeverity("[capture-health][warn] dropped frames=1", "stderr"), "warn");
assert.equal(classifyDevConsoleSeverity("[error] encoder unavailable", "stdout"), "error");
const records = [
  { id: 0, t: 1, level: "app", severity: "warn", text: "overflow notice" },
  { id: 1, t: 2, level: "core", stream: "stdout", severity: "info", text: "PORT 4521" },
  { id: 2, t: 3, level: "core", stream: "stderr", severity: "info", text: "capture health stable" },
  { id: 3, t: 4, level: "app", severity: "warn", text: "search marker" },
];
assert.equal(devConsoleSource(records[1]), "core.stdout");
assert.deepEqual(filterDevConsoleLines(records, { source: "core", severity: "all", query: "" }).map(line => line.id), [1, 2]);
assert.deepEqual(filterDevConsoleLines(records, { source: "core.stdout", severity: "all", query: "" }).map(line => line.id), [1]);
assert.deepEqual(filterDevConsoleLines(records, { source: "all", severity: "info", query: "stderr" }).map(line => line.id), [2]);
assert.deepEqual(filterDevConsoleLines(records, { source: "all", severity: "warn", query: "marker" }).map(line => line.id), [3]);
assert.match(serializeDevConsoleLines(records.slice(1, 2)), /\[core\.stdout\] \[info\] PORT 4521/);

// Recording priority is active only when the elevated core applied libobs
// GPU priority; anything else enabled is inactive with a stated reason.
const { recordingPriorityEffect } = loadTs("src/shared/recording-priority.ts");
const priority = { enabled: true, supported: true, installed: true, current: true, coreElevated: true, gpuPriority: "set", gpuVendor: "nvidia", busy: false, message: null };
assert.deepEqual(recordingPriorityEffect(priority), { state: "active", problem: null });
assert.deepEqual(recordingPriorityEffect({ ...priority, gpuPriority: "failed" }), { state: "inactive", problem: "gpu_priority_failed" });
assert.deepEqual(recordingPriorityEffect({ ...priority, gpuPriority: "unknown", gpuVendor: "intel" }), { state: "inactive", problem: "gpu_priority_unsupported" });
assert.deepEqual(recordingPriorityEffect({ ...priority, gpuPriority: "unknown" }), { state: "inactive", problem: "gpu_priority_unknown" });
assert.deepEqual(recordingPriorityEffect({ ...priority, coreElevated: false, current: false }), { state: "inactive", problem: "task_stale" });
assert.deepEqual(recordingPriorityEffect({ ...priority, coreElevated: false, installed: false, current: false }), { state: "inactive", problem: "not_installed" });
assert.deepEqual(recordingPriorityEffect({ ...priority, coreElevated: false, gpuPriority: "unknown" }), { state: "inactive", problem: "core_not_elevated" });
assert.deepEqual(recordingPriorityEffect({ ...priority, coreElevated: false, gpuPriority: "unknown", gpuVendor: null }), { state: "inactive", problem: null }); // core starting
assert.equal(recordingPriorityEffect({ ...priority, enabled: false }).state, "off");
assert.equal(recordingPriorityEffect({ ...priority, busy: true }).state, "busy");

// Clip saves stay pending until their own terminal event, however long the
// save takes; a result that beats the clip.save reply does not re-open it.
const { ClipSaveTracker } = loadTs("src/shared/clip-saves.ts");
const saves = new ClipSaveTracker();
saves.apply("clip.queued", { request: 1 });
saves.apply("clip.queued", { request: 2 });
assert.equal(saves.apply("error", { message: "unrelated" }), false);
saves.apply("clip.saved", { request: 1 });
assert.equal(saves.size, 1);
saves.apply("error", { request: 2, message: "Save failed" });
assert.equal(saves.size, 0);
saves.apply("clip.dropped", { request: 3 });
saves.queued(3); // late clip.save reply for an already-finished request
assert.equal(saves.size, 0);
saves.apply("clip.queued", { request: 4 });
saves.apply("ready", {}); // restarted core: nothing queued, ids restart
assert.equal(saves.size, 0);
saves.queued(1);
assert.equal(saves.size, 1);

const root = await mkdtemp(path.join(tmpdir(), "shard-dev-console-"));
try {
  const child = spawn(electron, [path.join(appDir, "scripts/test-dev-console.cjs"), root], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    cwd: appDir,
    windowsHide: true,
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => signal ? reject(new Error("Developer console test helper exited from " + signal)) : resolve(exitCode));
  });
  assert.equal(code, 0, "developer console main-process filesystem harness");
  console.log("PASS developer console line decoding, classification, filtering, serialization, session logging, and Recording priority state");
} finally {
  await rm(root, { recursive: true, force: true });
}
