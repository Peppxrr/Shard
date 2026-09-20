// verify-core-bin.mjs — packaging gate: the installer is only as good as the
// staged core-bin tree (electron-builder bundles app/resources/core-bin via
// extraResources; it never rebuilds or checks it). This script refuses to
// package an incomplete, stale, or tampered staging dir:
//   - every runtime file the core needs must exist (manifest below mirrors
//     scripts/build.ps1 staging);
//   - the Game Capture hook payload (official signed OBS 32.2.1 binaries)
//     must hash-match the pinned manifest in vendor/obs-hook-payload —
//     anti-cheat compatibility depends on those bytes being untouched;
//   - no build symbols (*.pdb) or old-layout leftovers may ship;
//   - shardcore.exe must not be older than the core sources (a stale core in
//     a fresh installer is exactly the "fixed but still broken" trap).
// Run via `npm run package` (wired in package.json) or directly:
//   node scripts/verify-core-bin.mjs [path-to-core-bin]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const appRoot = join(import.meta.dirname, "..");
const repoRoot = join(appRoot, "..");
const coreBin = process.argv[2]
  ? resolve(process.argv[2])
  : join(appRoot, "resources", "core-bin");

const pins = JSON.parse(readFileSync(join(repoRoot, "runtime-dependencies.json"), "utf8"));
const ROOT_FILES = [
  "shardcore.exe", "obs.dll", "libobs-d3d11.dll", "libobs-winrt.dll", "w32-pthreads.dll",
  "obs-ffmpeg-mux.exe", "obs-nvenc-test.exe", "ffmpeg.exe", "ffprobe.exe",
  // obs-deps runtime (FFmpeg, curl, x264, ...)
  ...pins.obs.runtimeDlls,
];

const PLUGINS = [
  "win-capture", "win-wasapi", "obs-x264", "obs-nvenc",
  "obs-ffmpeg", "obs-outputs", "obs-filters", "image-source", "text-freetype2",
];

const WIN_CAPTURE_DATA = [
  // Official signed OBS payload (hash-checked below) + Shard's vulkan layer
  // manifests + the offsets helpers spawned at module load.
  "graphics-hook64.dll", "graphics-hook32.dll", "inject-helper64.exe", "inject-helper32.exe",
  "shard-vulkan32.json", "shard-vulkan64.json",
  "get-graphics-offsets32.exe", "get-graphics-offsets64.exe", "compatibility.json",
];

// Files that must live ONLY under data/obs-plugins/win-capture. Copies at the
// data/obs-plugins root are leftovers from the pre-patch layout and can
// register a second hook — the exact ambiguity the patch removed.
const STALE_AT_DATA_ROOT = [
  "obs-vulkan32.json", "obs-vulkan64.json", "compatibility.json", "locale",
  "graphics-hook32.dll", "graphics-hook64.dll", "inject-helper32.exe", "inject-helper64.exe",
  "get-graphics-offsets32.exe", "get-graphics-offsets64.exe",
];

const errors = [];
const fail = (msg) => { errors.push(msg); console.error(`  x ${msg}`); };

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

console.log(`==> Verifying staged core-bin: ${coreBin}`);

if (!existsSync(coreBin)) {
  fail(`staging dir does not exist — run scripts/build.ps1 first`);
} else {
  for (const f of ROOT_FILES) {
    if (!existsSync(join(coreBin, f))) fail(`missing ${f}`);
  }
  for (const p of PLUGINS) {
    if (!existsSync(join(coreBin, "obs-plugins/64bit", `${p}.dll`))) fail(`missing obs-plugins/64bit/${p}.dll`);
    const data = join(coreBin, "data/obs-plugins", p);
    if (!existsSync(data)) fail(`missing plugin data dir data/obs-plugins/${p}`);
  }
  for (const f of WIN_CAPTURE_DATA) {
    if (!existsSync(join(coreBin, "data/obs-plugins/win-capture", f))) fail(`missing data/obs-plugins/win-capture/${f}`);
  }
  if (!existsSync(join(coreBin, "data/libobs/default.effect"))) {
    fail("missing data/libobs/default.effect (libobs cannot render without it)");
  }

  const stagedPins = join(coreBin, "runtime-dependencies.json");
  if (!existsSync(stagedPins) || JSON.stringify(JSON.parse(readFileSync(stagedPins, "utf8"))) !== JSON.stringify(pins))
    fail("staged runtime dependency versions differ from the selected pins — rebuild the core");
  const ffmpegPins = join(coreBin, "ffmpeg-pins.json");
  if (!existsSync(ffmpegPins) || JSON.stringify(JSON.parse(readFileSync(ffmpegPins, "utf8"))) !== JSON.stringify(pins.ffmpeg))
    fail("FFmpeg provenance does not match the selected version — fetch FFmpeg and rebuild");

  // Hook payload integrity: the staged bytes must be the pinned, officially
  // signed OBS release binaries — a rebuilt or modified hook breaks the
  // anti-cheat trust model (and the patched win-capture would refuse it anyway).
  const payloadDir = join(repoRoot, pins.obs.hookPayload);
  const manifestPath = join(payloadDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(`${pins.obs.hookPayload}/manifest.json missing — cannot verify official hook payload`);
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.obsVersion !== pins.obs.version) fail("OBS version differs from its hook payload manifest");
    for (const [name, expected] of Object.entries(manifest.files)) {
      const staged = join(coreBin, "data/obs-plugins/win-capture", name);
      if (!existsSync(staged)) continue; // already reported as missing above
      const actual = sha256(staged);
      if (actual !== expected.sha256.toLowerCase()) {
        fail(`hook payload ${name} hash mismatch: staged bytes differ from the pinned official release`);
      }
    }
    console.log(`  . hook payload matches pinned OBS ${manifest.obsVersion} manifest`);
  }

  // Ship hygiene: symbols and old-layout copies bloat the installer and can
  // shadow the real hook.
  const pdbs = [...walk(coreBin)].filter((p) => p.endsWith(".pdb"));
  if (pdbs.length) fail(`${pdbs.length} stray .pdb file(s) staged (e.g. ${relative(coreBin, pdbs[0])})`);
  for (const name of STALE_AT_DATA_ROOT) {
    if (existsSync(join(coreBin, "data/obs-plugins", name))) {
      fail(`stale pre-patch layout file data/obs-plugins/${name} (belongs under win-capture/ or must not exist)`);
    }
  }
  if (existsSync(join(coreBin, "clipcore.exe"))) {
    fail("stale clipcore.exe staged beside shardcore.exe");
  }

  // Staleness: a fresh installer wrapping an old core reproduces bugs that
  // were already fixed in source. Compare mtimes (git checkouts can shift
  // these; re-run scripts/build.ps1 if this fires spuriously).
  let newestSource = 0;
  let newestName = "";
  const coreSrc = join(repoRoot, "core/src");
  for (const p of walk(coreSrc)) {
    const m = statSync(p).mtimeMs;
    if (m > newestSource) { newestSource = m; newestName = relative(repoRoot, p); }
  }
  const cmakeLists = join(repoRoot, "core/CMakeLists.txt");
  if (existsSync(cmakeLists) && statSync(cmakeLists).mtimeMs > newestSource) {
    newestSource = statSync(cmakeLists).mtimeMs;
    newestName = "core/CMakeLists.txt";
  }
  const shardcore = join(coreBin, "shardcore.exe");
  // Version bumps now live in package.json instead of changing CMakeLists.
  // Check the actual PE version so an old core cannot pass the mtime gate.
  if (process.platform === "win32" && existsSync(shardcore)) {
    try {
      const version = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "(Get-Item -LiteralPath $env:SHARD_VERIFY_CORE).VersionInfo.ProductVersion"], {
        env: { ...process.env, SHARD_VERIFY_CORE: shardcore }, encoding: "utf8", windowsHide: true, timeout: 15000,
      }).trim();
      const expected = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version;
      if (version !== expected) fail(`core version ${version} does not match app version ${expected} — rebuild the core`);
    } catch {
      fail("could not read the core's Windows version resource");
    }
  }
  if (existsSync(shardcore) && statSync(shardcore).mtimeMs < newestSource) {
    fail(`staged shardcore.exe is older than ${newestName} — re-run scripts/build.ps1 before packaging`);
  }
}

if (errors.length) {
  console.error(`\ncore-bin verification FAILED (${errors.length} problem${errors.length === 1 ? "" : "s"}).`);
  console.error("Fix with: powershell -File scripts/build.ps1   (rebuilds + restages the Release core)");
  process.exit(1);
}
console.log("==> core-bin verification passed — safe to package");
