// Rebuilds native modules (better-sqlite3) against the installed Electron ABI.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const electronDir = path.join(appDir, "node_modules", "electron");

if (!existsSync(electronDir)) {
  console.log("postinstall: electron not installed yet, skipping rebuild");
  process.exit(0);
}

const electronPkg = JSON.parse(readFileSync(path.join(electronDir, "package.json"), "utf8"));
console.log(`postinstall: rebuilding native modules for Electron ${electronPkg.version}…`);
try {
  execSync(`npx electron-rebuild -f -w better-sqlite3 --version ${electronPkg.version}`, {
    cwd: appDir,
    stdio: "inherit",
  });
  console.log("postinstall: native modules rebuilt");
} catch (e) {
  console.error("postinstall: electron-rebuild failed", e.message);
  process.exit(1);
}
