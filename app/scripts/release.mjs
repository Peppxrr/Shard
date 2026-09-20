// Release gate and notes/checksum generation. No credentials or publishing here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { extractFile } from "@electron/asar";

const appRoot = resolve(import.meta.dirname, "..");
const root = resolve(appRoot, "..");
const pkg = JSON.parse(readFileSync(join(appRoot, "package.json")));
const lock = JSON.parse(readFileSync(join(appRoot, "package-lock.json")));
const config = yaml.load(readFileSync(join(appRoot, "electron-builder.yml"), "utf8"));
const version = pkg.version;
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Use stable major.minor.patch versions, without +metadata or four-part tags");
assert.ok(version.split(".").every(part => Number(part) <= 65535), "Windows version components must fit in 16 bits");
assert.equal(lock.version, version, "Run npm version to update the lockfile too");
assert.equal(lock.packages[""].version, version);
assert.equal(config.buildVersion, undefined, "Do not duplicate the version in builder config");
assert.equal(pkg.shortVersionWindows, undefined);
assert.equal(config.buildNumber, "0");
assert.equal(config.publish.provider, "github");
assert.equal(config.publish.owner, "Peppxrr");
assert.equal(config.publish.repo, "Shard");
const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : process.argv[3];
if (process.argv[2] === "validate" && tag) assert.equal(tag, `v${version}`, "Tag must match package.json");

function notes() {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const heading = `## ${version}`;
  const start = changelog.split(/\r?\n/).indexOf(heading);
  assert.ok(start >= 0, `Add a ${heading} section to CHANGELOG.md`);
  const lines = changelog.split(/\r?\n/).slice(start + 1);
  const end = lines.findIndex(line => line.startsWith("## "));
  const body = (end < 0 ? lines : lines.slice(0, end)).join("\n").trim();
  assert.ok(body.length, "Release notes must not be empty");
  return body;
}
async function digest(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

const command = process.argv[2] ?? "validate";
if (command === "notes") {
  const dir = join(appRoot, "release");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "release-notes.md"), notes() + "\n");
} else if (command === "artifacts") {
  const dir = resolve(process.argv[3] ?? join(appRoot, "release"));
  const installer = `Shard-Setup-${version}.exe`;
  const names = [installer, `${installer}.blockmap`, `Shard-${version}-portable.exe`, "latest.yml"];
  for (const name of names) assert.ok(statSync(join(dir, name)).size > 0, `Missing/empty ${name}`);
  const latest = yaml.load(readFileSync(join(dir, "latest.yml"), "utf8"));
  assert.equal(latest.version, version);
  assert.equal(latest.path, installer);
  assert.equal(latest.files.length, 1, "Only the NSIS installer belongs in latest.yml");
  const entry = latest.files[0];
  assert.equal(entry.url, installer);
  assert.equal(entry.size, statSync(join(dir, installer)).size);
  const sha512 = await digest(join(dir, installer), "sha512", "base64");
  assert.equal(entry.sha512, sha512);
  assert.equal(latest.sha512, sha512);
  const resources = join(dir, "win-unpacked/resources");
  const feed = yaml.load(readFileSync(join(resources, "app-update.yml"), "utf8"));
  assert.equal(feed.provider, "github");
  assert.equal(feed.updaterCacheDirName, "shard-updater", "Keep the differential installer cache stable across releases");
  assert.equal(feed.owner, "Peppxrr");
  assert.equal(feed.repo, "Shard");
  assert.ok(!feed.token && !feed.private, "Public clients must not embed credentials");
  const archive = join(resources, "app.asar");
  const packaged = JSON.parse(extractFile(archive, "package.json").toString());
  assert.equal(packaged.version, version);
  assert.ok(packaged.dependencies["electron-updater"]);
  for (const file of ["dist/main/main/updater.js", "dist/main/main/update-controller.js", "node_modules/electron-updater/package.json"])
    assert.ok(extractFile(archive, join(...file.split("/"))).length > 0, `Missing packaged ${file}`);
  const check = spawnSync(process.execPath, [join(appRoot, "scripts/verify-core-bin.mjs"), join(resources, "core-bin")], { stdio: "inherit" });
  assert.equal(check.status, 0, "Packaged core verification failed");
  const sums = await Promise.all(names.map(async name => `${await digest(join(dir, name), "sha256", "hex")}  ${name}`));
  writeFileSync(join(dir, "SHA256SUMS.txt"), sums.join("\n") + "\n");
} else {
  assert.equal(command, "validate", "Unknown release command");
  notes();
}
console.log(`Release ${version}: ${command} passed`);
