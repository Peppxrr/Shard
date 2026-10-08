import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { ShutdownLifecycle } from "../src/main/shutdown-lifecycle.ts";
import { OwnedProcesses } from "../src/main/bundled-processes.ts";
import { UpdateController } from "../src/main/update-controller.ts";
import { UpdateCache, UpdatePreferencesFile, sha512 as fileSha512, versionAtLeast } from "../src/main/update-storage.ts";

const require = createRequire(import.meta.url);
const { NsisUpdater } = require("electron-updater");
const { NodeHttpExecutor } = require("builder-util/out/nodeHttpExecutor");
const { ElectronHttpExecutor } = require("electron-updater/out/electronHttpExecutor");
const quiet = console.error;
const logged = [];
console.error = (...args) => logged.push(args);
const info = { version: "0.1.4", releaseNotes: "<p>Fixed capture.</p>", files: [] };
const deferred = () => Promise.withResolvers();

class FakeUpdater extends EventEmitter {
  checks = 0; downloads = 0; installs = 0;
  checkImpl = async () => { this.emit("update-available", info); };
  downloadImpl = async () => { this.emit("update-downloaded", info); };
  async checkForUpdates() { this.checks++; return this.checkImpl(); }
  async downloadUpdate() { this.downloads++; return this.downloadImpl(); }
  quitAndInstall(silent, runAfter) { assert.equal(silent, true); assert.equal(runAfter, true); this.installs++; }
}
function fixture(mode = "installed", backend = new FakeUpdater(), overrides = {}) {
  const states = [], urls = [];
  let prepared = 0, failures = 0;
  const controller = new UpdateController({ currentVersion: "0.1.3", mode,
    backend: mode === "disabled" ? null : backend, publish: state => states.push(state),
    prepareInstall: async () => { prepared++; return null; }, installFailed: () => { failures++; },
    openExternal: async url => { urls.push(url); }, ...overrides });
  return { controller, backend, states, urls, prepared: () => prepared, failures: () => failures };
}

try {
  // Exercise the real preload bridge independently of Electron: no arguments
  // accepted for updater commands, and each subscriber removes its own listener.
  const ipc = new EventEmitter(), bridges = {}, invokes = [];
  ipc.invoke = async (...args) => { invokes.push(args); return {}; };
  const preload = require("typescript").transpileModule(readFileSync(new URL("../src/main/preload.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: require("typescript").ScriptTarget.ES2022, module: require("typescript").ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(preload, { exports: {}, process: { platform: "win32", argv: [] }, require: name => {
    assert.equal(name, "electron");
    return { contextBridge: { exposeInMainWorld: (name, api) => { bridges[name] = api; } }, ipcRenderer: ipc };
  } });
  for (let i = 0; i < 5; i++) {
    let calls = 0;
    const off = bridges.shard.onUpdateState(() => { calls++; });
    assert.equal(ipc.listenerCount("updates:state"), 1);
    ipc.emit("updates:state", {}, { status: "idle" });
    assert.equal(calls, 1);
    off(); assert.equal(ipc.listenerCount("updates:state"), 0);
  }
  for (const method of ["getUpdateState", "checkForUpdates", "downloadUpdate", "installUpdate", "openUpdateRelease", "scheduleUpdate", "cancelScheduledUpdate", "dismissUpdate"])
    await bridges.shard[method]("https://untrusted.test/installer.exe");
  assert.deepEqual(invokes.map(args => args.length), Array(8).fill(1));

  const f = fixture();
  assert.equal(f.controller.getState().status, "idle");
  assert.equal(f.backend.checks, 0, "Service schedules checks after the app starts");
  assert.equal(f.backend.autoDownload, false);
  assert.equal(f.backend.autoInstallOnAppQuit, false);
  assert.equal(f.backend.allowPrerelease, false);
  assert.equal(f.backend.allowDowngrade, false);
  assert.equal(f.backend.disableWebInstaller, true);
  await f.controller.download(); await f.controller.install();
  assert.equal(f.backend.downloads + f.backend.installs, 0, "Out-of-order operations do nothing");
  const checking = deferred();
  f.backend.checkImpl = async () => { await checking.promise; f.backend.emit("update-available", info); };
  const first = f.controller.check();
  assert.equal((await f.controller.check()).status, "checking");
  assert.equal(f.backend.checks, 1, "Duplicate check coalesced");
  checking.resolve(); await first;
  assert.equal(f.controller.getState().status, "available");
  assert.equal(f.controller.getState().releaseNotes, "Fixed capture.");
  assert.equal(f.backend.downloads, 0);
  const downloading = deferred();
  f.backend.downloadImpl = async () => { await downloading.promise; f.backend.emit("update-downloaded", info); };
  const download = f.controller.download();
  f.backend.emit("download-progress", { percent: 45, total: 100, transferred: 45, bytesPerSecond: 20 });
  const snapshot = f.controller.getState();
  assert.equal(snapshot.progress.percent, 45);
  snapshot.progress.percent = 99;
  assert.equal(f.controller.getState().progress.percent, 45, "Snapshots cannot mutate the controller");
  await f.controller.download(); await f.controller.check(); await f.controller.install();
  assert.equal(f.backend.downloads, 1);
  assert.equal(f.backend.installs, 0);
  downloading.resolve(); await download;
  assert.equal(f.controller.getState().status, "downloaded");
  await f.controller.install(); await f.controller.install();
  assert.equal(f.backend.installs, 1);
  assert.equal(f.prepared(), 1);
  assert.equal(f.controller.getState().status, "installing");
  assert.ok(f.states.every((s, i) => i === 0 || s.revision > f.states[i - 1].revision));

  const portable = fixture("portable");
  await portable.controller.check(); await portable.controller.download(); await portable.controller.install();
  assert.equal(portable.backend.downloads + portable.backend.installs, 0);
  await portable.controller.openRelease();
  assert.deepEqual(portable.urls, ["https://github.com/Peppxrr/Shard/releases/tag/v0.1.4"]);
  portable.backend.emit("update-available", { ...info, version: "https://evil.test" });
  await portable.controller.openRelease();
  assert.equal(portable.urls.at(-1), "https://github.com/Peppxrr/Shard/releases/latest");

  const disabled = fixture("disabled");
  await disabled.controller.check(); await disabled.controller.download(); await disabled.controller.install();
  assert.equal(disabled.controller.getState().status, "disabled");
  assert.equal(disabled.backend.checks, 0);

  const errors = fixture();
  errors.backend.checkImpl = async () => { throw Object.assign(new Error("private stack path"), { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" }); };
  await errors.controller.check();
  assert.equal(errors.controller.getState().retry, "check");
  assert.match(errors.controller.getState().message, /does not include update information/);
  assert.ok(!JSON.stringify(errors.controller.getState()).includes("private stack"));
  errors.backend.checkImpl = async () => errors.backend.emit("update-not-available", info);
  await errors.controller.check();
  assert.equal(errors.controller.getState().status, "up-to-date");
  errors.backend.checkImpl = async () => errors.backend.emit("update-available", info);
  await errors.controller.check();
  errors.backend.downloadImpl = async () => { throw new Error("offline"); };
  await errors.controller.download();
  assert.equal(errors.controller.getState().retry, "download");
  errors.backend.downloadImpl = async () => errors.backend.emit("update-downloaded", info);
  await errors.controller.download();
  errors.backend.quitAndInstall = () => errors.backend.emit("error", new Error("installer failed"));
  await errors.controller.install();
  assert.equal(errors.controller.getState().retry, "install");
  assert.equal(errors.failures(), 1);

  const busy = fixture("installed", new FakeUpdater(), { prepareInstall: async () => "Stop your recording first." });
  await busy.controller.check(); await busy.controller.download(); await busy.controller.install();
  assert.equal(busy.controller.getState().status, "downloaded");
  assert.equal(busy.backend.installs, 0);
  assert.match(busy.controller.getState().message, /recording/);

  let choices = {};
  const scheduled = fixture("installed", new FakeUpdater(), { saveChoice: choice => { choices = choice; } });
  scheduled.controller.schedule();
  assert.equal(choices.scheduledVersion, undefined, "Cannot schedule before download");
  await scheduled.controller.check(); await scheduled.controller.download();
  scheduled.controller.schedule(); scheduled.controller.dismiss();
  assert.equal(choices.scheduledVersion, "0.1.4");
  assert.equal(scheduled.controller.getState().dismissed, true);
  const resumed = fixture("installed", new FakeUpdater(), { ...choices, saveChoice: choice => { choices = choice; } });
  await resumed.controller.check();
  assert.equal(resumed.controller.getState().installOnNextLaunch, true);
  assert.equal(resumed.controller.getState().dismissed, true);
  await resumed.controller.download(); await resumed.controller.install();
  assert.equal(choices.scheduledVersion, undefined, "Install consumes scheduling before execution");
  assert.equal(resumed.backend.autoInstallOnAppQuit, false, "PC shutdown never launches an installer");
  const cancel = fixture("installed", new FakeUpdater(), { scheduledVersion: "0.1.4", saveChoice: choice => { choices = choice; } });
  cancel.controller.unschedule(); assert.equal(choices.scheduledVersion, undefined);
  const newer = fixture("installed", new FakeUpdater(), { dismissedVersion: "0.1.3" });
  await newer.controller.check(); assert.equal(newer.controller.getState().dismissed, false);
  newer.backend.checkImpl = async () => { newer.backend.emit("error", new Error("offline")); throw new Error("offline"); };
  await newer.controller.check(true);
  assert.equal(newer.controller.getState().status, "available", "Background failure retains available update without alarming UI");
  assert.ok(newer.controller.getState().lastCheckedAt);
  const order = [];
  const ordered = fixture("installed", new FakeUpdater(), {
    beforeDownload: async () => { order.push("preserve"); }, afterDownload: async () => { order.push("restore"); },
    prepareInstall: async () => { order.push("core stopped"); return null; }, beforeInstall: async () => { order.push("persist"); },
  });
  ordered.backend.quitAndInstall = () => order.push("installer");
  await ordered.controller.check(); await ordered.controller.download(); await ordered.controller.install();
  assert.deepEqual(order, ["preserve", "restore", "core stopped", "persist", "installer"]);
  const failedChoice = fixture("installed", new FakeUpdater(), { saveChoice: () => { throw new Error("disk full"); } });
  await failedChoice.controller.check(); await failedChoice.controller.download();
  assert.throws(() => failedChoice.controller.schedule(), /disk full/);
  assert.ok(!failedChoice.controller.getState().installOnNextLaunch);
  // The same lifecycle is wired to Electron's before-quit and install prep.
  const normalDone = deferred(); let normalCleanups = 0, normalQuits = 0, prevented = 0;
  const normalLife = new ShutdownLifecycle({ guard: async () => null,
    cleanup: async update => { assert.equal(update, false); normalCleanups++; await normalDone.promise; },
    recover: async () => {}, quit: () => normalQuits++, log() {} });
  const quitEvent = { preventDefault() { prevented++; } };
  normalLife.beforeQuit(quitEvent); normalLife.beforeQuit(quitEvent);
  assert.equal(normalCleanups, 1); assert.equal(prevented, 2); assert.equal(normalQuits, 0);
  normalDone.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(normalQuits, 1); normalLife.beforeQuit(quitEvent); assert.equal(prevented, 2);

  const owned = new OwnedProcesses(), media = new EventEmitter();
  media.exitCode = null; media.signalCode = null; media.pid = 123; let signalled = 0;
  media.kill = () => { signalled++; return true; };
  owned.track(media, "resources/core-bin/ffmpeg/ffmpeg.exe");
  let updateCleanups = 0, recovered = 0;
  const updateLife = new ShutdownLifecycle({ guard: async () => null,
    cleanup: async update => { assert.equal(update, true); updateCleanups++; await owned.stop(); },
    recover: async () => { recovered++; owned.resume(); }, quit() {}, log() {} });
  let ready = false;
  const prepA = updateLife.prepareUpdate(); const prepB = updateLife.prepareUpdate();
  prepA.then(() => { ready = true; });
  assert.equal(prepA, prepB); await new Promise(resolve => setImmediate(resolve));
  assert.equal(signalled, 1); assert.equal(ready, false); assert.equal(updateLife.acceptingWork, false);
  assert.throws(() => owned.assertRunning(), /shut down/);
  media.exitCode = 0; media.emit("exit", 0);
  assert.equal(ready, false, "An exit request/event alone does not release inherited handles");
  media.emit("close", 0); await prepA;
  assert.equal(updateLife.updateReady, true); assert.equal(updateCleanups, 1); assert.equal(owned.size, 0);
  await updateLife.prepareUpdate(); await owned.stop();
  const handoffEvent = { preventDefault() { assert.fail("Updater quit must bypass normal asynchronous cleanup"); } };
  updateLife.beforeUpdaterQuit(); updateLife.beforeQuit(handoffEvent); updateLife.beforeQuit(handoffEvent);
  assert.equal(updateCleanups, 1);
  await Promise.all([updateLife.recoverUpdate(), updateLife.recoverUpdate()]);
  assert.equal(recovered, 1); assert.equal(updateLife.acceptingWork, true); owned.assertRunning();

  // A timeout refuses handoff without losing the tracked handle; retry can
  // complete once that exact process closes. Spawn failures close too.
  const stubborn = new EventEmitter(); stubborn.pid = 456; stubborn.exitCode = null; stubborn.signalCode = null;
  stubborn.kill = () => true; owned.track(stubborn, "resources/core-bin/ffmpeg/ffprobe.exe");
  await assert.rejects(owned.stop(10), /timed out/); assert.equal(owned.size, 1);
  stubborn.emit("close", 1); await owned.stop(); assert.equal(owned.size, 0);
  owned.resume();
  const failedSpawn = new EventEmitter(); failedSpawn.exitCode = null; failedSpawn.signalCode = null;
  failedSpawn.kill = () => assert.fail("Unstarted child cannot be killed");
  owned.track(failedSpawn, "missing-ffmpeg.exe");
  const failedSpawnStop = owned.stop(); failedSpawn.emit("close", -4058); await failedSpawnStop;

  const protectedChild = new EventEmitter(); protectedChild.pid = 789;
  protectedChild.exitCode = null; protectedChild.signalCode = null;
  protectedChild.kill = () => assert.fail("Generic cancellation must never kill the core supervisor");
  owned.resume(); owned.track(protectedChild, "resources/core-bin/shardcore.exe"); owned.awaitOnly(protectedChild);
  let protectedStopped = false;
  const protectedWait = owned.stop().then(() => { protectedStopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(protectedStopped, false);
  protectedChild.emit("close", 0); await protectedWait;
  assert.equal(owned.size, 0);
  const guardLife = new ShutdownLifecycle({ guard: async () => "Stop recording first",
    cleanup: async () => assert.fail("Busy recording must not be shut down"), recover: async () => {}, quit() {}, log() {} });
  assert.match(await guardLife.prepareUpdate(), /recording/); assert.equal(guardLife.acceptingWork, true);
  let partialRestored = 0;
  const partialLife = new ShutdownLifecycle({ guard: async () => null,
    cleanup: async () => { throw new Error("core timeout"); }, recover: async () => { partialRestored++; }, quit() {}, log() {} });
  await assert.rejects(partialLife.prepareUpdate(), /core timeout/);
  assert.equal(partialLife.updateReady, false); await partialLife.recoverUpdate();
  assert.equal(partialRestored, 1); assert.equal(partialLife.acceptingWork, true);

  // Recovery is awaited for both synchronous installer throws and emitted errors.
  for (const emitted of [false, true]) {
    const recoveryDone = deferred(); let restores = 0;
    const recoverable = fixture("installed", new FakeUpdater(), {
      prepareInstall: async () => updateLife.prepareUpdate(),
      installFailed: async () => { restores++; const restored = updateLife.recoverUpdate(); await recoveryDone.promise; await restored; },
    });
    await recoverable.controller.check(); await recoverable.controller.download();
    recoverable.backend.quitAndInstall = () => {
      if (emitted) recoverable.backend.emit("error", new Error("spawn failed"));
      else throw new Error("spawn failed");
    };
    let installSettled = false;
    const attempt = recoverable.controller.install().then(() => { installSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(restores, 1); assert.equal(installSettled, false);
    assert.equal(updateLife.updateReady, false, "Installer failure revokes quit bypass immediately");
    recoveryDone.resolve(); await attempt;
    assert.equal(updateLife.acceptingWork, true); assert.equal(recoverable.controller.getState().retry, "install");
    let obsoleteQuitBlocked = false;
    updateLife.beforeUpdaterQuit();
    updateLife.beforeQuit({ preventDefault() { obsoleteQuitBlocked = true; } });
    assert.equal(obsoleteQuitBlocked, true);
    assert.equal(updateLife.acceptingWork, true, "Late updater quit after failure must leave restored services usable");
    recoverable.backend.quitAndInstall = () => { assert.equal(updateLife.updateReady, true); };
    await recoverable.controller.install(); assert.equal(recoverable.controller.getState().status, "installing");
    await updateLife.recoverUpdate();
  }
  console.log("Shutdown tests passed: normal async quit, updater bypass, child-close barrier, repeated cleanup, bounded failure and recovery");

  const interruptedPrep = deferred();
  const interrupted = fixture("installed", new FakeUpdater(), { prepareInstall: () => interruptedPrep.promise });
  await interrupted.controller.check(); await interrupted.controller.download();
  const interruptedInstall = interrupted.controller.install();
  interrupted.backend.emit("error", new Error("backend failed during preparation"));
  interruptedPrep.resolve(null); await interruptedInstall;
  assert.equal(interrupted.backend.installs, 0, "Failed preparation cannot continue into an installer handoff");
  // Execute the actual main.ts cleanup/recovery callbacks with resource fakes.
  // This checks integration ordering rather than another copy of the lifecycle.
  const mainText = readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const mainLifecycleText = mainText.slice(mainText.indexOf("const jobs = new Set"), mainText.indexOf('app.on("window-all-closed"'));
  const mainLibraryText = mainText.slice(mainText.indexOf("function openLibrary("), mainText.indexOf("function savedLabel("));
  const appEvents = new EventEmitter(), nativeUpdaterEvents = new EventEmitter();
  const rootExit = deferred(), foregroundDone = deferred(), libraryWatchDrain = deferred(), resourceOwned = new OwnedProcesses();
  const resourceCounts = { dbClosed: 0, dbOpened: 0, coreStarted: 0, storageStarted: 0, watchStarted: 0,
    libraryWatchStarted: 0, libraryWatchStopped: 0, auxClosed: 0, hotkeysResumed: 0 };
  const applicationWindow = { isDestroyed: () => false };
  const resourceChild = new EventEmitter();
  resourceChild.pid = 777; resourceChild.exitCode = null; resourceChild.signalCode = null;
  let resourceKilled = false; resourceChild.kill = () => { resourceKilled = true; return true; };
  resourceOwned.track(resourceChild, "resources/core-bin/ffmpeg/ffmpeg.exe");
  class ResourceLibrary extends EventEmitter {
    constructor() { super(); resourceCounts.dbOpened++; }
    async stopWatching() { await libraryWatchDrain.promise; resourceCounts.libraryWatchStopped++; }
    startWatching() { resourceCounts.libraryWatchStarted++; }
    close() { resourceCounts.dbClosed++; }
  }
  class ResourceStorage extends EventEmitter { async stop() {} start() { resourceCounts.storageStarted++; } }
  const resourceContext = { exports: {}, ShutdownLifecycle, bounded: (label, promise) => promise, ownedProcesses: resourceOwned,
    jobs: undefined, win: applicationWindow, core: { ready: true, supervised: true, hasProcess: true,
      invoke: async () => ({ recording: { active: false } }),
      shutdown: async () => { await rootExit.promise; resourceContext.core.ready = false; resourceContext.core.hasProcess = false; },
      start: async () => { resourceCounts.coreStarted++; resourceContext.core.ready = true; } },
    hotkeys: { suspend() {}, dispose() {}, resume() { resourceCounts.hotkeysResumed++; }, apply() {} },
    themes: { close() {}, startWatching: async () => { resourceCounts.watchStarted++; } },
    exporter: { busy: false, cancel() {} }, library: new ResourceLibrary(), storage: new ResourceStorage(),
    Library: ResourceLibrary, StorageWatchdog: ResourceStorage, quitting: false,
    applicationStarted: true, servicesStoppedForUpdate: false, libraryClosedForUpdate: false,
    timelineRequests: new Map(), editorProbeCache: new Map(), process: { platform: "win32" },
    updater: { log() {}, stop: async () => {}, startChecks() {} },
    stopEditorPreviews: async () => {}, resumeEditorPreviews() {}, setSoundWindow() {},
    overlay: { destroy() {} }, devConsole: { open: false, close() {}, toggle() {} },
    getSettings: () => ({ app: { developerConsole: false } }), toast() {}, createWindow() { assert.fail("Existing main window must survive preparation"); },
    BrowserWindow: { getAllWindows: () => [applicationWindow, { isDestroyed: () => false, destroy() { resourceCounts.auxClosed++; } }] },
    electronAutoUpdater: nativeUpdaterEvents, app: Object.assign(appEvents, { quit() {}, getPath: () => "test-data" }),
  };
  vm.runInNewContext(require("typescript").transpileModule(mainLibraryText + mainLifecycleText + "\nexports.shutdown = shutdown; exports.trackJob = trackJob;", {
    compilerOptions: { target: require("typescript").ScriptTarget.ES2022, module: require("typescript").ModuleKind.CommonJS },
  }).outputText, resourceContext);
  resourceContext.exports.trackJob(foregroundDone.promise);
  const integratedPrep = resourceContext.exports.shutdown.prepareUpdate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resourceCounts.dbClosed, 0); assert.equal(resourceKilled, false);
  rootExit.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(resourceKilled, true); assert.equal(resourceCounts.dbClosed, 0);
  resourceChild.exitCode = 0; resourceChild.emit("close", 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resourceCounts.dbClosed, 0, "Database must wait for foreground/background users after child exit");
  foregroundDone.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(resourceCounts.dbClosed, 0, "Database must wait for active library reconciliation");
  libraryWatchDrain.resolve(); await integratedPrep;
  assert.equal(resourceCounts.libraryWatchStopped, 1);
  assert.equal(resourceCounts.dbClosed, 1); assert.equal(resourceCounts.auxClosed, 1);
  await resourceContext.exports.shutdown.prepareUpdate(); assert.equal(resourceCounts.dbClosed, 1);
  nativeUpdaterEvents.emit("before-quit-for-update");
  appEvents.emit("before-quit", { preventDefault() { assert.fail("Integrated updater before-quit must be unblocked"); } });
  await resourceContext.exports.shutdown.recoverUpdate();
  assert.equal(resourceCounts.dbOpened, 2); assert.equal(resourceCounts.coreStarted, 1);
  assert.equal(resourceCounts.storageStarted, 1); assert.equal(resourceCounts.watchStarted, 1);
  assert.equal(resourceCounts.libraryWatchStarted, 1, "Library watching resumes after failed update handoff");
  assert.equal(resourceCounts.hotkeysResumed, 1); assert.equal(resourceContext.quitting, false);
  let staleBlocked = false;
  nativeUpdaterEvents.emit("before-quit-for-update");
  appEvents.emit("before-quit", { preventDefault() { staleBlocked = true; } });
  assert.equal(staleBlocked, true); assert.equal(resourceContext.quitting, false);
  console.log("Main lifecycle integration passed: core/media/jobs drain, database ordering, quit handoff and service restoration");

  console.log("Updater state/lifecycle tests passed");

  const cacheDir = await mkdtemp(path.join(tmpdir(), "shard-cache-test-"));
  try {
    const cache = new UpdateCache(cacheDir, () => {});
    const p = (...names) => path.join(cacheDir, ...names);
    await mkdir(p("pending"));
    await writeFile(p("installer.exe"), "old installer");
    await writeFile(p("current.blockmap"), "old map");
    await cache.preserveBaseline();
    await writeFile(p("current.blockmap"), "new map");
    await cache.recover("0.1.3");
    assert.equal(await readFile(p("current.blockmap"), "utf8"), "old map", "Interrupted downloads restore the baseline");
    await cache.preserveBaseline();
    await writeFile(p("current.blockmap"), "new map");
    await cache.restoreBaseline();
    assert.equal(await readFile(p("current.blockmap"), "utf8"), "old map");
    await writeFile(p("pending", "Shard-Setup-0.1.4.exe"), "new installer");
    const pendingInfo = { fileName: "Shard-Setup-0.1.4.exe", sha512: await fileSha512(p("pending", "Shard-Setup-0.1.4.exe")) };
    await writeFile(p("pending", "update-info.json"), JSON.stringify(pendingInfo));
    await writeFile(p("pending", "current.blockmap"), "new map");
    await cache.recover("0.1.3");
    assert.ok(await cache.verifyPending("0.1.4"), "Pending update is kept before successful installation");
    await copyFile(p("pending", pendingInfo.fileName), p("installer.exe"));
    await cache.recover("0.1.4");
    assert.deepEqual(await readdir(p("pending")), []);
    assert.equal(await readFile(p("installer.exe"), "utf8"), "new installer");
    assert.equal(await readFile(p("current.blockmap"), "utf8"), "new map");
    await writeFile(p("pending", "update-info.json"), JSON.stringify({ ...pendingInfo, fileName: "../../outside.exe" }));
    assert.equal(await cache.pending(), null, "Reject cache path traversal");
    const preferences = new UpdatePreferencesFile(p("preferences.json"));
    preferences.save({ scheduledVersion: "0.1.4", dismissedVersion: "0.1.3" });
    assert.deepEqual(new UpdatePreferencesFile(p("preferences.json")).value, preferences.value);
    assert.equal(versionAtLeast("0.1.10", "0.1.9"), true);
    assert.equal(versionAtLeast("0.1.3", "0.1.4"), false);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
  console.log("Updater persistence/cache tests passed: interruption, matching baseline, completed-install cleanup, path validation");

  // Run the real startup service with Electron/timers replaced. Disk/cache and
  // controller code stay real; these tests never spawn a process or installer.
  const serviceDir = await mkdtemp(path.join(tmpdir(), "shard-startup-test-"));
  try {
    const source = require("typescript").transpileModule(readFileSync(new URL("../src/main/updater.ts", import.meta.url), "utf8"), {
      compilerOptions: { target: require("typescript").ScriptTarget.ES2022, module: require("typescript").ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    async function service(name, scheduledVersion, checkImpl) {
      const data = path.join(serviceDir, name), cache = path.join(data, "shard-updater");
      await mkdir(path.join(cache, "pending"), { recursive: true });
      await writeFile(path.join(data, "Uninstall Shard.exe"), "test installation marker");
      const prefs = new UpdatePreferencesFile(path.join(data, "updates.json"));
      prefs.save({ scheduledVersion });
      if (scheduledVersion) {
        const file = path.join(cache, "pending", "Shard-Setup-0.1.4.exe");
        await writeFile(file, "test bytes, never executable");
        await writeFile(path.join(cache, "pending", "update-info.json"), JSON.stringify({ fileName: path.basename(file), sha512: await fileSha512(file) }));
      }
      const backend = new FakeUpdater();
      if (checkImpl) backend.checkImpl = checkImpl;
      const timers = [], intervals = [], handlers = new Map(), exports = {};
      class Window extends EventEmitter {
        destroyed = false;
        webContents = { executeJavaScript: async () => {} };
        constructor(options) { super(); assert.equal(options.webPreferences.nodeIntegration, false); }
        show() {} isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
        async loadURL() { this.emit("ready-to-show"); }
      }
      vm.runInNewContext(source, { exports, console, URL, Date,
        process: { platform: "win32", env: { LOCALAPPDATA: data } },
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 1; }, clearTimeout: () => {},
        setInterval: (fn, ms) => { const timer = { fn, ms, unref() {} }; intervals.push(timer); return timer; }, clearInterval: () => {},
        require: id => {
          if (id === "electron") return { app: { isPackaged: true, getVersion: () => "0.1.3", getPath: name => name === "exe" ? path.join(data, "Shard.exe") : data },
            BrowserWindow: Window, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, shell: { openExternal: async () => {} } };
          if (id === "electron-updater") return { autoUpdater: backend };
          if (id === "./update-controller") return { UpdateController };
          if (id === "./update-storage") return { UpdateCache, UpdatePreferencesFile, versionAtLeast };
          if (id === "./update-log") return { createUpdateLog: () => ({ info() {}, warn() {}, error() {}, debug() {}, flush: async () => {} }) };
          return require(id);
        },
      });
      let prepared = 0;
      const instance = exports.registerUpdater({ window: () => null, prepareInstall: async () => { prepared++; return null; }, installFailed() {}, log() {} });
      return { instance, backend, timers, intervals, data, prepared: () => prepared, handlers };
    }
    const ordinary = await service("ordinary");
    assert.equal(await ordinary.instance.beforeLaunch(), false);
    assert.equal(ordinary.backend.checks, 0, "Normal startup does not wait on GitHub");
    ordinary.instance.startChecks(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(ordinary.backend.checks, 1);
    assert.equal(ordinary.intervals[0].ms, 12 * 60 * 60 * 1000);
    ordinary.intervals[0].fn(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(ordinary.backend.checks, 2);
    ordinary.instance.startChecks(); assert.equal(ordinary.intervals.length, 1);
    assert.throws(() => ordinary.handlers.get("updates:install")({}), /not allowed/);
    const launch = await service("scheduled", "0.1.4");
    assert.equal(await launch.instance.beforeLaunch(), true);
    assert.equal(launch.backend.installs, 1); assert.equal(launch.prepared(), 1);
    assert.equal(new UpdatePreferencesFile(path.join(launch.data, "updates.json")).value.scheduledVersion, undefined);
    const offline = await service("offline", "0.1.4", async () => { throw new Error("offline"); });
    assert.equal(await offline.instance.beforeLaunch(), false);
    assert.equal(offline.backend.installs, 0);
    assert.equal(new UpdatePreferencesFile(path.join(offline.data, "updates.json")).value.scheduledVersion, "0.1.4");
    const slowCheck = deferred();
    const slow = await service("slow", "0.1.4", () => slowCheck.promise);
    const launchSlow = slow.instance.beforeLaunch();
    // File reads precede creation of the timeout; wait for that exact boundary.
    while (!slow.timers.length) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(slow.timers[0].ms, 12000); slow.timers[0].fn();
    assert.equal(await launchSlow, false);
    slow.backend.emit("update-available", info); slowCheck.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(slow.backend.installs, 0, "Late metadata cannot install after startup has continued");
    const damaged = await service("damaged", "0.1.4");
    await writeFile(path.join(damaged.data, "shard-updater/pending/Shard-Setup-0.1.4.exe"), "tampered");
    assert.equal(await damaged.instance.beforeLaunch(), false);
    assert.equal(damaged.backend.downloads, 0, "Damaged deferred files need an explicit new download");
    assert.equal(damaged.backend.installs, 0);
  } finally { await rm(serviceDir, { recursive: true, force: true }); }
  console.log("Startup updater tests passed: startup/12h checks, deferred install, offline, timeout, damaged cache, IPC isolation");

  // The shutdown fixture loads the real client's pure logging dependencies;
  // relative requires must resolve from the source module, not this script.
  const coreDependencies = {};
  for (const [id, source] of Object.entries({
    "../shared/dev-console": "../src/shared/dev-console.ts",
    "./core-line-decoder": "../src/main/core-line-decoder.ts",
  })) {
    const exports = {};
    vm.runInNewContext(require("typescript").transpileModule(readFileSync(new URL(source, import.meta.url), "utf8"), {
      compilerOptions: { target: require("typescript").ScriptTarget.ES2022, module: require("typescript").ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText, { exports, require, Buffer });
    coreDependencies[id] = exports;
  }
  const coreExports = {}, coreTimers = [], processExports = {};
  const fakeTimers = { setTimeout: fn => { const timer = { fn }; coreTimers.push(timer); return timer; }, clearTimeout: timer => { if (timer) timer.cleared = true; } };
  vm.runInNewContext(require("typescript").transpileModule(readFileSync(new URL("../src/main/bundled-processes.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: require("typescript").ScriptTarget.ES2022, module: require("typescript").ModuleKind.CommonJS },
  }).outputText, { exports: processExports, require, Promise, ...fakeTimers });
  coreDependencies["./bundled-processes"] = processExports;
  vm.runInNewContext(require("typescript").transpileModule(readFileSync(new URL("../src/main/core-client.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: require("typescript").ScriptTarget.ES2022, module: require("typescript").ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, { exports: coreExports, process, console,
    setTimeout: fn => { const timer = { fn }; coreTimers.push(timer); return timer; }, clearTimeout: timer => { if (timer) timer.cleared = true; },
    require: id => id === "electron" ? { app: {} } : id === "./settings" ? {} : coreDependencies[id] ?? require(id),
  });
  const client = new coreExports.CoreClient(), child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; let killed = false, finished = false;
  child.stdin = { destroyed: false, on() {}, write() { killed = true; } };
  client.supervised = true; client.ready = true;
  child.kill = () => { killed = true; return true; };
  client.reconnectTimer = { cleared: false };
  client.proc = child; client.invoke = async () => {};
  const stopped = client.shutdown().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  coreTimers[0].fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(killed, true); assert.equal(finished, false, "Signalling kill is not proof that core DLLs are released");
  child.exitCode = 0; child.emit("exit", 0);
  assert.equal(finished, false, "Core exit is insufficient until inherited stdio closes after descendants exit");
  child.emit("close", 0); await stopped;
  assert.equal(finished, true);
  assert.equal(client.reconnectTimer, null, "Installer failure can restart the core without a stale reconnect timer");
  assert.ok(coreTimers.every(timer => timer.cleared));
  console.log("Capture shutdown test passed: installer waits for the core process to actually exit");

  // Exercise the actual NSIS updater and its YAML/SemVer/SHA-512 download path
  // against an isolated localhost feed. The dummy bytes are NEVER executed.
  const dir = await mkdtemp(path.join(tmpdir(), "shard-update-test-"));
  const bytes = Buffer.alloc(256 * 1024, 42);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  let remoteVersion = "0.1.4", tamper = false, missing = false, exeRequests = 0;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/latest.yml")) {
      if (missing) { res.writeHead(404); res.end(); return; }
      res.end(`version: ${remoteVersion}\nfiles:\n  - url: update.exe\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: update.exe\nsha512: ${sha512}\nreleaseDate: '2026-09-18T00:00:00.000Z'\n`);
    } else if (req.url === "/update.exe") {
      exeRequests++;
      res.setHeader("Content-Length", bytes.length);
      res.end(tamper ? Buffer.alloc(bytes.length, 43) : bytes);
    } else { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    async function real(name) {
      const data = path.join(dir, name);
      await mkdir(data);
      const config = path.join(data, "app-update.yml");
      await writeFile(config, `provider: generic\nurl: ${url}\nupdaterCacheDirName: ${name}\n`);
      let quitHooks = 0;
      const adapter = { version: "0.1.3", name, isPackaged: true, appUpdateConfigPath: config,
        userDataPath: data, baseCachePath: data, whenReady: async () => {},
        quit: () => assert.fail("Tests must never quit/install"), relaunch: () => assert.fail("Tests must never relaunch"),
        onQuit: () => { quitHooks++; } };
      const updater = new NsisUpdater(null, adapter);
      updater.logger = null;
      updater.httpExecutor = new NodeHttpExecutor();
      updater.httpExecutor.download = ElectronHttpExecutor.prototype.download;
      updater.disableDifferentialDownload = true;
      return { ...fixture("installed", updater), quitHooks: () => quitHooks };
    }
    const valid = await real("valid");
    await valid.controller.check();
    assert.equal(valid.controller.getState().status, "available");
    assert.equal(exeRequests, 0, "Metadata check must not fetch installer");
    await valid.controller.download();
    assert.equal(valid.controller.getState().status, "downloaded");
    assert.equal(exeRequests, 1);
    assert.equal(valid.quitHooks(), 0, "No install-on-quit handler");
    tamper = true;
    const corrupt = await real("corrupt");
    await corrupt.controller.check(); await corrupt.controller.download();
    assert.equal(corrupt.controller.getState().status, "error");
    assert.equal(corrupt.controller.getState().retry, "download");
    assert.ok(logged.some(args => args.some(a => /checksum mismatch/i.test(String(a)))), "Real updater rejects corrupted bytes");
    for (const version of ["0.1.2", "0.1.3"]) {
      remoteVersion = version;
      const current = await real(`version-${version}`);
      await current.controller.check();
      assert.equal(current.controller.getState().status, "up-to-date", "Never downgrade or reinstall same version");
    }
    missing = true;
    const absent = await real("missing");
    await absent.controller.check();
    assert.equal(absent.controller.getState().status, "error");
    console.log("Real electron-updater localhost tests passed: SemVer, YAML, explicit download, SHA-512 rejection, missing metadata, no install-on-quit");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
} finally { console.error = quiet; }
