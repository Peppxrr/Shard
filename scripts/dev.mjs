// Shard dev runner (started by scripts/dev.ps1 — builds the core first).
//
// Orchestrates three processes:
//   1. Vite dev server            — renderer (React) with HMR, port 5173.
//   2. tsc --watch                — Electron main + preload compiled to CJS
//                                   (dist/main), emitted on every change.
//   3. Electron                   — spawned with VITE_DEV_SERVER_URL so the
//                                   window loads from Vite (hot UI) and
//                                   CF_CORE_BIN pointing at the dev core
//                                   (app/resources/core-bin-dev).
//
// Whenever tsc emits a new main-process build, Electron is killed and
// relaunched with the same env. The renderer needs no restart — Vite HMR
// pushes changes into the live window. Ctrl+C tears the whole tree down.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "app");
const coreBinDev = path.join(appDir, "resources", "core-bin-dev");
const mainOut = path.join(appDir, "dist", "main", "main", "main.js");
const viteUrl = "http://localhost:5173";

const isWin = process.platform === "win32";

let vite = null;
let tsc = null;
let electron = null;
let restartTimer = null;
let stopping = false;
let launched = false; // first electron launch done; later changes restart it

function log(msg) {
  console.log(`[dev] ${msg}`);
}

function bin(name) {
  return path.join(appDir, "node_modules", name);
}

function killTree(proc, label) {
  if (!proc || proc.killed) return;
  if (isWin && proc.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      /* fall through to plain kill */
    }
  }
  proc.kill("SIGTERM");
}

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  log("shutting down…");
  if (restartTimer) clearTimeout(restartTimer);
  killTree(electron, "electron");
  killTree(vite, "vite");
  killTree(tsc, "tsc");
  // Give taskkill a moment to reap the tree before we exit.
  setTimeout(() => process.exit(code), isWin ? 500 : 50);
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
process.on("exit", () => {
  // Hard fallback if the graceful path never ran (e.g. parent killed us).
  if (!stopping) {
    killTree(electron, "electron");
    killTree(vite, "vite");
    killTree(tsc, "tsc");
  }
});

function startVite() {
  if (vite) return;
  log("starting vite dev server…");
  // node_modules/vite/bin/vite.js — spawn directly, no shell indirection.
  vite = spawn(process.execPath, [bin("vite/bin/vite.js")], { cwd: appDir, stdio: "inherit" });
  vite.on("exit", (code) => {
    vite = null;
    if (!stopping) {
      log(`vite exited (${code}) — restarting in 1s`);
      setTimeout(startVite, 1000);
    }
  });
}

function startTscWatch() {
  if (tsc) return;
  log("starting tsc --watch for main process…");
  tsc = spawn(process.execPath, [bin("typescript/bin/tsc"), "-p", "tsconfig.main.json", "--watch", "--preserveWatchOutput"], {
    cwd: appDir,
    stdio: "inherit",
  });
  tsc.on("exit", (code) => {
    tsc = null;
    if (!stopping) {
      log(`tsc --watch exited (${code}) — restarting in 1s`);
      setTimeout(startTscWatch, 1000);
    }
  });
}

function startElectron() {
  if (electron || stopping) return;
  log("starting electron…");
  // Windows ships a real electron.exe (no .cmd shim needed).
  const exe = isWin ? bin("electron/dist/electron.exe") : bin("electron/dist/electron");
  electron = spawn(exe, [appDir], {
    cwd: appDir,
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: viteUrl, CF_CORE_BIN: coreBinDev },
  });
  electron.on("exit", (code) => {
    electron = null;
    if (!stopping && launched) log(`electron exited (${code})`);
  });
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (electron) {
      log("main process changed — restarting electron");
      killTree(electron, "electron");
      // The exit handler fires async; respawn on a short delay so the old
      // process is fully gone (better-sqlite3/userData locks release).
      setTimeout(startElectron, 400);
    } else {
      startElectron();
    }
  }, 300);
}

function watchMainOutput() {
  const watchDir = path.join(appDir, "dist", "main", "main");
  let watcher = null;
  try {
    watcher = watch(watchDir, { recursive: true }, (_ev, file) => {
      // The very first compile populates the dir while we wait for it below;
      // only post-launch changes should restart Electron.
      if (!launched) return;
      if (typeof file === "string" && file.endsWith(".js")) scheduleRestart();
    });
  } catch {
    log(`cannot watch ${watchDir} — main-process hot reload disabled`);
  }
  return watcher;
}

async function main() {
  if (!existsSync(coreBinDev)) {
    log(`missing ${coreBinDev} — run scripts/dev.ps1 (without -SkipCore) first`);
    process.exit(1);
  }
  if (!existsSync(bin("electron"))) {
    log("electron not installed — run `npm install` in app/ first");
    process.exit(1);
  }

  startTscWatch();
  startVite();
  watchMainOutput();

  // Wait for the first main-process build, then launch Electron. tsc --watch
  // emits dist/main/main/main.js on its first pass; poll briefly.
  const deadline = Date.now() + 90000;
  while (!existsSync(mainOut)) {
    if (Date.now() > deadline) {
      log(`timed out waiting for ${mainOut} — check tsc output above`);
      stopAll(1);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  startElectron();
  launched = true;

  log("dev runner up — renderer HMR on " + viteUrl + ", Ctrl+C to stop");
}

main().catch((e) => {
  console.error(e);
  stopAll(1);
});
