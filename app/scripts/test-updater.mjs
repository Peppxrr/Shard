import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { UpdateController } from "../src/main/update-controller.ts";

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
  quitAndInstall(silent, runAfter) { assert.equal(silent, false); assert.equal(runAfter, true); this.installs++; }
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
    compilerOptions: { module: require("typescript").ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(preload, { exports: {}, process: { platform: "win32" }, require: name => {
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
  for (const method of ["getUpdateState", "checkForUpdates", "downloadUpdate", "installUpdate", "openUpdateRelease"])
    await bridges.shard[method]("https://untrusted.test/installer.exe");
  assert.deepEqual(invokes.map(args => args.length), [1, 1, 1, 1, 1]);

  const f = fixture();
  assert.equal(f.controller.getState().status, "idle");
  assert.equal(f.backend.checks, 0, "No startup check");
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
  console.log("Updater state/lifecycle tests passed");

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
