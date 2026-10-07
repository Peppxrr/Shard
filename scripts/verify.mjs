// Explicit scopes avoid accidentally testing unrelated work in a dirty checkout.
// Full output stays in ignored logs; callers normally need only the summary.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, existsSync, writeFileSync, readdirSync, lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const app = path.join(root, "app");
const args = process.argv.slice(2);
const planOnly = args.includes("--plan");
const scopes = args.filter(arg => arg !== "--plan");
if (!scopes.length) scopes.push("app");
const allowed = ["app", "editor", "storage", "updater", "themes", "diagnostics", "core", "capture", "release"];
if (scopes.some(scope => !allowed.includes(scope))) {
  console.error(`Usage: npm --prefix app run verify -- [${allowed.join(" | ")}] [--plan]`);
  process.exit(2);
}
const release = scopes.includes("release");
const config = release ? "Release" : "Debug";
const steps = new Map();
const add = (id, command, args, cwd = root) => steps.set(id, { id, command, args, cwd });
const node = (id, script, ...args) => add(id, process.execPath, [path.join(root, script), ...args]);
const npm = (id, script) => {
  if (!process.env.npm_execpath && !planOnly) throw new Error("Run this through npm run verify so npm's executable can be resolved safely.");
  add(id, process.execPath, [process.env.npm_execpath ?? "<npm CLI>", "run", script], app);
};
const ps = (id, script, ...args) => add(id, "powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.join(root, script), ...args]);

if (release) {
  node("release-version", "app/scripts/release.mjs", "validate");
}
// Editor tests invoke the bundled FFmpeg tools, so stage them before the
// cheap release checks while still keeping the expensive OBS build last.
if (release &&
    (!["ffmpeg.exe", "ffprobe.exe"].every(file => existsSync(path.join(root, "vendor/ffmpeg/bin", file))) ||
     !existsSync(path.join(root, "vendor/ffmpeg/pins.json")) ||
     JSON.stringify(JSON.parse(readFileSync(path.join(root, "vendor/ffmpeg/pins.json"), "utf8"))) !== JSON.stringify(JSON.parse(readFileSync(path.join(root, "runtime-dependencies.json"), "utf8")).ffmpeg))) {
  ps("fetch-ffmpeg", "scripts/fetch-ffmpeg.ps1");
}

// package already builds the app: never run the same build twice in a release.
if (!release && scopes.some(scope => ["app", "editor", "storage", "updater", "themes", "diagnostics"].includes(scope))) npm("app-build", "build");
if (release || scopes.includes("editor")) {
  npm("editor-tests", "test:editor");
  npm("preview-tests", "test:previews");
  npm("library-tests", "test:library");
}
if (release || scopes.includes("updater")) npm("updater-tests", "test:updater");
if (release || scopes.includes("themes")) npm("theme-tests", "test:themes");
if (release || scopes.includes("diagnostics")) npm("diagnostics-tests", "test:diagnostics");
if (release || scopes.includes("storage")) {
  npm("library-tests", "test:library");
  npm("storage-tests", "test:storage");
}

if (release || scopes.some(scope => scope === "core" || scope === "capture")) {
  ps("core-build", "scripts/build.ps1", "-Config", config);
  add("core-test-build", "cmake", ["--build", "build_x64", "--config", config, "--target", "shard_tests", "shard_capture_resilience_tests", "shard_audio_isolation_tests", "shard_perf_tests", "shard_priority_tests", "--parallel"]);
  add("detection-tests", path.join(root, "build_x64", config, "shard_tests.exe"), []);
  add("capture-unit-tests", path.join(root, "build_x64", config, "shard_capture_resilience_tests.exe"), []);
  add("audio-isolation-tests", path.join(root, "build_x64", config, "shard_audio_isolation_tests.exe"), []);
  add("perf-tests", path.join(root, "build_x64", config, "shard_perf_tests.exe"), []);
  add("priority-tests", path.join(root, "build_x64", config, "shard_priority_tests.exe"), []);
}
if (scopes.includes("capture")) {
  const bin = path.join(root, "app/resources", release ? "core-bin" : "core-bin-dev");
  ps("capture-e2e", "scripts/e2e.ps1", "-CoreBin", bin);
}
if (release) {
  npm("package", "package");
  npm("release-artifacts", "verify:release");
}
console.log(`Verification: ${scopes.join(", ")}${planOnly ? " (plan only)" : ""}`);
if (planOnly) {
  for (const step of steps.values()) console.log(`  ${step.id}`);
  process.exit(0);
}

const verifyRoot = path.join(root, "tmp/verify");
mkdirSync(verifyRoot, { recursive: true });
const runName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const logDir = path.join(verifyRoot, runName);

function cleanupStalePackageSmokeProfile() {
  const profilePath = path.join(root, "tmp/package-smoke-profile");
  const tempRoot = path.join(root, "tmp");
  if (!existsSync(profilePath)) return;
  try {
    const tempRootReal = realpathSync(tempRoot);
    const profileInfo = lstatSync(profilePath);
    if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink()) return;
    const profileReal = realpathSync(profilePath);
    if (path.dirname(profileReal) !== tempRootReal || Date.now() - statSync(profileReal).mtimeMs < 14 * 24 * 60 * 60 * 1000) return;

    const processRows = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const appIsRunning = processRows.split(/\r?\n/).some(row => /^("(?:Shard|shardcore|electron)\.exe")\s*,/i.test(row));
    if (appIsRunning) return;

    const configPath = path.join(profileReal, "core/config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const expectedClips = path.join(profileReal, "core/clips");
    const expectedRecordings = path.join(profileReal, "core/recordings");
    if (path.resolve(config.dirs?.clips ?? "") !== expectedClips ||
        path.resolve(config.dirs?.recordings ?? "") !== expectedRecordings) return;
    const clips = path.join(profileReal, "core/clips");
    const clipEntries = readdirSync(clips, { withFileTypes: true });
    if (clipEntries.some(entry => !entry.isFile() || !/^clip-\d{8}-\d{6}-\d+\.mp4$/i.test(entry.name))) return;

    // This exact profile is a known packaged-smoke fixture. Retain it while
    // Shard/Electron is running, while recent, or if its contents differ.
    if (path.dirname(profileReal) === tempRootReal) rmSync(profileReal, { recursive: true, force: true });
  } catch {
    // Process inspection and filesystem uncertainty must never block a check
    // or trigger broader cleanup.
  }
}

// Keep recent completed runs for diagnostics while leaving active runs,
// legacy output without our marker, and anything outside tmp/verify alone.
function pruneCompletedRuns() {
  const verifyRootReal = realpathSync(verifyRoot);
  const completed = [];
  for (const entry of readdirSync(verifyRoot, { withFileTypes: true })) {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(\d+)$/.exec(entry.name);
    if (!entry.isDirectory() || !match || entry.name === runName) continue;
    const runPath = path.join(verifyRoot, entry.name);
    try {
      const info = lstatSync(runPath);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const runReal = realpathSync(runPath);
      if (path.dirname(runReal) !== verifyRootReal) continue;
      const summary = JSON.parse(readFileSync(path.join(runReal, "summary.json"), "utf8"));
      if (summary.schemaVersion !== 1 || !["passed", "failed"].includes(summary.status) ||
          !Array.isArray(summary.scopes) || !Array.isArray(summary.results)) continue;

      // A finished marker is written before the process exits. Protect it if
      // the owning verifier is still alive during another verifier's startup.
      let ownerActive = true;
      try {
        process.kill(Number(match[2]), 0);
      } catch (error) {
        if (error?.code === "ESRCH") ownerActive = false;
      }
      if (!ownerActive) completed.push({ name: entry.name, path: runReal, status: summary.status });
    } catch {
      // Unknown, partial, or unreadable output is retained for inspection.
    }
  }

  for (const status of ["passed", "failed"]) {
    const runs = completed.filter(run => run.status === status).sort((a, b) => b.name.localeCompare(a.name));
    for (const run of runs.slice(10)) {
      if (path.dirname(run.path) === verifyRootReal) {
        try { rmSync(run.path, { recursive: true, force: true }); } catch { /* Retain locked diagnostics. */ }
      }
    }
  }
}

cleanupStalePackageSmokeProfile();
try { pruneCompletedRuns(); } catch { /* Cleanup must not prevent verification. */ }
mkdirSync(logDir);
const results = [];
console.log(`Logs: ${logDir}`);
const summaryPath = path.join(logDir, "summary.json");
const writeSummary = status => writeFileSync(summaryPath, JSON.stringify({ schemaVersion: 1, status, scopes, results }, null, 2));
writeSummary("running");
for (const step of steps.values()) {
  const log = path.join(logDir, `${step.id}.log`);
  const fd = openSync(log, "w");
  const start = Date.now();
  console.log(`RUN  ${step.id}`);
  const outcome = await new Promise(resolve => {
    const child = spawn(step.command, step.args, { cwd: step.cwd, windowsHide: true, stdio: ["ignore", fd, fd] });
    child.once("error", error => resolve({ code: 1, error: error.message }));
    child.once("close", code => resolve({ code: code ?? 1 }));
  });
  closeSync(fd);
  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  results.push({ step: step.id, ...outcome, seconds, log });
  writeSummary(outcome.code === 0 ? "running" : "failed");
  if (outcome.code !== 0) {
    console.error(`FAIL ${step.id} (${seconds}s). Full log: ${log}`);
    if (outcome.error) console.error(outcome.error);
    console.error(readFileSync(log, "utf8").trimEnd().split(/\r?\n/).slice(-20).join("\n"));
    process.exit(1);
  }
  console.log(`PASS ${step.id} (${seconds}s)`);
}
writeSummary("passed");
console.log(`PASS ${results.length} checks. Verification complete; no broader checks implied.`);
