// Explicit scopes avoid accidentally testing unrelated work in a dirty checkout.
// Full output stays in ignored logs; callers normally need only the summary.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const app = path.join(root, "app");
const args = process.argv.slice(2);
const planOnly = args.includes("--plan");
const scopes = args.filter(arg => arg !== "--plan");
if (!scopes.length) scopes.push("app");
const allowed = ["app", "editor", "updater", "themes", "core", "capture", "release"];
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
if (!release && scopes.some(scope => ["app", "editor", "updater", "themes"].includes(scope))) npm("app-build", "build");
if (release || scopes.includes("editor")) {
  npm("editor-tests", "test:editor");
  npm("preview-tests", "test:previews");
}
if (release || scopes.includes("updater")) npm("updater-tests", "test:updater");
if (release || scopes.includes("themes")) npm("theme-tests", "test:themes");

if (release || scopes.some(scope => scope === "core" || scope === "capture")) {
  ps("core-build", "scripts/build.ps1", "-Config", config);
  add("core-test-build", "cmake", ["--build", "build_x64", "--config", config, "--target", "shard_tests", "shard_capture_resilience_tests", "--parallel"]);
  add("detection-tests", path.join(root, "build_x64", config, "shard_tests.exe"), []);
  add("capture-unit-tests", path.join(root, "build_x64", config, "shard_capture_resilience_tests.exe"), []);
}
if (scopes.includes("capture")) {
  const bin = path.join(root, "app/resources", release ? "core-bin" : "core-bin-dev");
  ps("capture-e2e", "scripts/e2e.ps1", "-CoreBin", bin, "-KeepTemp");
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

const logDir = path.join(root, "tmp/verify", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
mkdirSync(logDir, { recursive: true });
const results = [];
console.log(`Logs: ${logDir}`);
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
  writeFileSync(path.join(logDir, "summary.json"), JSON.stringify({ scopes, results }, null, 2));
  if (outcome.code !== 0) {
    console.error(`FAIL ${step.id} (${seconds}s). Full log: ${log}`);
    if (outcome.error) console.error(outcome.error);
    console.error(readFileSync(log, "utf8").trimEnd().split(/\r?\n/).slice(-20).join("\n"));
    process.exit(1);
  }
  console.log(`PASS ${step.id} (${seconds}s)`);
}
console.log(`PASS ${results.length} checks. Verification complete; no broader checks implied.`);
