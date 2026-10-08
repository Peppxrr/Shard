// Package size report for a built release directory. Prints download sizes,
// installed size by component group, and the largest files; writes a JSON
// snapshot so a later build can be compared with --compare <old.json>.
//
//   node scripts/size-report.mjs [releaseDir] [--json <out>] [--compare <old.json>] [--top <n>]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  args.splice(index, 2);
  return value;
};
const top = Number(option("--top") ?? 30);
const comparePath = option("--compare");
const jsonOption = option("--json");
if (args.length > 1 || args.some(arg => arg.startsWith("--"))) {
  console.error("Usage: node scripts/size-report.mjs [releaseDir] [--json <out>] [--compare <old.json>] [--top <n>]");
  process.exit(2);
}
const releaseDir = resolve(args[0] ?? join(appRoot, "release"));
const unpacked = join(releaseDir, "win-unpacked");
if (!existsSync(unpacked)) throw new Error(`No win-unpacked directory in ${releaseDir}; run npm run package first`);

// First matching rule wins. Paths are relative to win-unpacked with "/" separators.
const GROUPS = [
  ["FFmpeg", path => /^resources\/core-bin\/(ffmpeg\/|ffmpeg\.exe$|ffprobe\.exe$|ffmpeg-pins\.json$)/.test(path)],
  ["OBS/core", path => path.startsWith("resources/core-bin/")],
  ["Native npm modules", path => path.startsWith("resources/app.asar.unpacked/")],
  ["Shard app", path => path === "resources/app.asar"],
  ["Other resources", path => path.startsWith("resources/")],
  ["Electron/Chromium", () => true],
];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [{ path: relative(unpacked, full).split(sep).join("/"), bytes: statSync(full).size }];
  });
}

const files = walk(unpacked);
const groups = Object.fromEntries(GROUPS.map(([name]) => [name, { bytes: 0, files: 0 }]));
for (const file of files) {
  const [name] = GROUPS.find(([, match]) => match(file.path));
  groups[name].bytes += file.bytes;
  groups[name].files++;
}
const sumUnder = prefix => files.filter(file => file.path === prefix || file.path.startsWith(`${prefix}/`)).reduce((sum, file) => sum + file.bytes, 0);
const artifact = pattern => {
  const name = readdirSync(releaseDir).find(entry => pattern.test(entry));
  return name ? { name, bytes: statSync(join(releaseDir, name)).size } : null;
};
const report = {
  schemaVersion: 1,
  version: JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version,
  generatedAt: new Date().toISOString(),
  artifacts: {
    installer: artifact(/^Shard-Setup-.*\.exe$/),
    portable: artifact(/^Shard-.*-portable\.exe$/),
    blockmap: artifact(/^Shard-Setup-.*\.exe\.blockmap$/),
  },
  installed: {
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files: files.length,
    appAsar: sumUnder("resources/app.asar"),
    appAsarUnpacked: sumUnder("resources/app.asar.unpacked"),
    coreBin: sumUnder("resources/core-bin"),
    electronLocales: sumUnder("locales"),
  },
  groups,
  largest: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, top),
};

const previous = comparePath ? JSON.parse(readFileSync(resolve(comparePath), "utf8")) : null;
const mib = bytes => `${(bytes / 1048576).toFixed(1)} MiB`;
const delta = (now, before) => {
  if (before === undefined || before === null) return "";
  const change = now - before;
  return change === 0 ? "  (=)" : `  (${change > 0 ? "+" : "-"}${mib(Math.abs(change))}, ${before ? `${((change / before) * 100).toFixed(1)}%` : "new"})`;
};
const row = (label, now, before) => console.log(`  ${label.padEnd(22)} ${mib(now).padStart(11)}${delta(now, before)}`);

console.log(`Shard ${report.version} package size (${releaseDir})${previous ? ` vs ${previous.version} report from ${previous.generatedAt}` : ""}`);
console.log("Download");
for (const [key, label] of [["installer", "Installer"], ["portable", "Portable"], ["blockmap", "Blockmap"]]) {
  if (report.artifacts[key]) row(label, report.artifacts[key].bytes, previous?.artifacts?.[key]?.bytes);
}
console.log(`Installed (${report.installed.files} files)`);
row("win-unpacked", report.installed.bytes, previous?.installed?.bytes);
row("core-bin", report.installed.coreBin, previous?.installed?.coreBin);
row("app.asar", report.installed.appAsar, previous?.installed?.appAsar);
row("app.asar.unpacked", report.installed.appAsarUnpacked, previous?.installed?.appAsarUnpacked);
row("Electron locales", report.installed.electronLocales, previous?.installed?.electronLocales);
console.log("Groups");
for (const [name, group] of Object.entries(groups)) row(name, group.bytes, previous?.groups?.[name]?.bytes);
console.log(`Largest ${report.largest.length} files`);
for (const file of report.largest) console.log(`  ${mib(file.bytes).padStart(11)}  ${file.path}`);
if (previous) {
  const before = new Map((previous.largest ?? []).map(file => [file.path, file.bytes]));
  const gone = [...before.keys()].filter(path => !files.some(file => file.path === path));
  if (gone.length) console.log(`Previously largest files no longer packaged: ${gone.join(", ")}`);
}

const jsonPath = resolve(jsonOption ?? join(releaseDir, "size-report.json"));
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${basename(jsonPath)}`);
