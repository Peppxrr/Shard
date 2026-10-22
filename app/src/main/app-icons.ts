// Artwork for games (Games page, statusbar) and App audio rows.
//
// Windows: the icon embedded in the right executable. Games ship helpers next
// to the real binary (anti-cheat bootstrappers, crash reporters, installers),
// and Unreal/Unity builds often run an icon-less binary under Binaries/Win64,
// so candidates are ranked, helpers are skipped, and the generic "application"
// icon is rejected. Electron's extractor misses some resources, so .NET
// extraction is the fallback. Then Steam's cached library icon.
// Linux: Steam's library icon, then the matching .desktop entry's icon.
// Resolved executable icons are cached on disk so they survive the game closing.
import { app, nativeImage } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GameIconRequest } from "../shared/contracts";

type Url = string | null;
const WINDOWS = process.platform === "win32";
const cacheDir = () => path.join(app.getPath("userData"), "icon-cache");
const cacheFile = (key: string) => path.join(cacheDir(), `${createHash("sha1").update(key).digest("hex")}.png`);
const memory = new Map<string, Url>();

// Helpers that sit beside games and carry another product's icon (or none).
const HELPER_EXE = /anti.?cheat|^eac|battleye|_be\.exe$|^beservice|start_protected_game|crash|report|unins|setup|install|redist|prereq|dxsetup|updat|patcher|helper|cefprocess|bugsplat|dump/i;
// Runtimes that host a game (Minecraft runs in javaw.exe) carry their own icon.
const RUNTIME_HOST = /^(javaw?|pythonw?|node|electron|mono|dotnet|dosbox.*|love)\.exe$/i;
// Build-output folders; their ancestors hold the shipped launcher exe.
const BUILD_DIR = /^(win64|win32|x64|x86|x86_64|binaries|bin|engine|shipping|retail)$/i;
const SHIPPING_SUFFIX = /([-_](win64|win32|x64|shipping|dx11|dx12|vulkan|egs|steam))+$/;

const norm = (s: string) => s.toLowerCase().replace(/\.exe$/, "").replace(SHIPPING_SUFFIX, "").replace(/[^a-z0-9]/g, "");

// ------------------------------------------------------------ PowerShell --
function powershell(script: string, input: string[]): Promise<string[]> {
  if (!WINDOWS || !input.length) return Promise.resolve([]);
  return new Promise(resolve => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on("data", chunk => { out += String(chunk); });
    child.on("error", () => { clearTimeout(timer); resolve([]); });
    child.on("close", () => { clearTimeout(timer); resolve(out.split(/\r?\n/).slice(0, input.length)); });
    child.stdin.end(JSON.stringify(input));
  });
}
// One base64 PNG (or empty line) per input path.
const EXTRACT_PS = "Add-Type -AssemblyName System.Drawing; foreach ($p in ([Console]::In.ReadToEnd() | ConvertFrom-Json)) { try { $b = [System.Drawing.Icon]::ExtractAssociatedIcon($p).ToBitmap(); $m = New-Object IO.MemoryStream; $b.Save($m, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($m.ToArray()) } catch { '' } }";
// One image path (or empty line) per process name.
const PROCESS_PATH_PS = "foreach ($n in ([Console]::In.ReadToEnd() | ConvertFrom-Json)) { $p = (Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1).Path; if ($p) { $p } else { '' } }";

// ------------------------------------------------- executable icons (Win) --
let genericIcon: Promise<{ electron: string; dotnet: string }> | null = null;
const bitmapHash = (image: Electron.NativeImage) => createHash("sha1").update(image.toBitmap()).digest("hex");

// Fingerprint the stock "application" icon from an empty .exe.
function generic(): Promise<{ electron: string; dotnet: string }> {
  return genericIcon ??= (async () => {
    const blank = path.join(cacheDir(), "generic.exe");
    try { await fs.mkdir(cacheDir(), { recursive: true }); await fs.writeFile(blank, ""); } catch {}
    const electron = await app.getFileIcon(blank, { size: "large" }).then(bitmapHash, () => "");
    const [dotnet = ""] = await powershell(EXTRACT_PS, [blank]);
    return { electron, dotnet };
  })();
}

async function exeIcons(files: string[]): Promise<Url> {
  const existing = files.filter(file => file.toLowerCase().endsWith(".exe") && existsSync(file));
  if (!existing.length) return null;
  const stock = await generic();
  for (const file of existing) {
    try {
      const icon = await app.getFileIcon(file, { size: "large" });
      if (!icon.isEmpty() && bitmapHash(icon) !== stock.electron) return icon.toDataURL();
    } catch {}
  }
  const extracted = await powershell(EXTRACT_PS, existing);
  const found = extracted.find(png => png && png !== stock.dotnet);
  return found ? `data:image/png;base64,${found}` : null;
}

async function listExes(dir: string): Promise<string[]> {
  try { return (await fs.readdir(dir, { withFileTypes: true })).filter(e => e.isFile() && e.name.toLowerCase().endsWith(".exe")).map(e => path.join(dir, e.name)); }
  catch { return []; }
}

// Breadth-first, bounded search of an install folder for the game's executables.
async function findNamed(root: string, names: Set<string>): Promise<string[]> {
  const found: string[] = [];
  let level = [root];
  let visited = 0;
  for (let depth = 0; depth <= 4 && level.length && visited < 400; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (++visited > 400) break;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isFile() && names.has(entry.name.toLowerCase())) found.push(path.join(dir, entry.name));
        else if (entry.isDirectory()) next.push(path.join(dir, entry.name));
      }
    }
    level = next;
  }
  return found;
}

// Climb out of build-output folders (Engine/Binaries/Win64) to the install root.
function shippedRoot(dir: string): string {
  let current = dir;
  let climbed = false;
  while (BUILD_DIR.test(path.basename(current)) && path.dirname(current) !== current) { current = path.dirname(current); climbed = true; }
  // Unreal projects keep <Project>/Binaries/Win64 under the install root.
  if (climbed && existsSync(path.join(path.dirname(current), "Engine"))) current = path.dirname(current);
  return current;
}

async function gameExeIcon(request: GameIconRequest): Promise<Url> {
  const names = new Set(request.executables.map(exe => exe.toLowerCase()));
  const known = new Set<string>();
  const roots = new Set(request.installPaths.filter(p => path.isAbsolute(p)).map(p => path.normalize(p)));
  if (request.path) { known.add(path.normalize(request.path)); roots.add(path.dirname(path.normalize(request.path))); }
  for (const root of [...roots]) for (const file of await findNamed(root, names)) known.add(file);
  for (const file of [...known]) { roots.add(path.dirname(file)); roots.add(shippedRoot(path.dirname(file))); }
  for (const root of [...roots]) roots.add(shippedRoot(root));
  const candidates = new Set(known);
  for (const root of roots) for (const file of await listExes(root)) candidates.add(file);

  const title = norm(request.name);
  const score = (file: string) => {
    const base = path.basename(file).toLowerCase();
    const stem = norm(base);
    let value = names.has(base) ? 3 : 0;
    if (title && stem && (title.includes(stem) || stem.includes(title))) value += 4;
    if (roots.has(path.dirname(file)) && !BUILD_DIR.test(path.basename(path.dirname(file)))) value += 1;
    return value;
  };
  const ranked = [...candidates].filter(file => !HELPER_EXE.test(path.basename(file)) && !RUNTIME_HOST.test(path.basename(file))).map(file => ({ file, value: score(file) }))
    .filter(entry => entry.value > 0).sort((a, b) => b.value - a.value).slice(0, 8).map(entry => entry.file);
  return exeIcons(ranked);
}

// ------------------------------------------------------------------ Steam --
type SteamApps = Map<string, string>; // lowercase installdir -> appid
let steam: Promise<{ roots: string[]; apps: SteamApps }> | null = null;

function steamLibraries(): Promise<{ roots: string[]; apps: SteamApps }> {
  return steam ??= (async () => {
    const home = os.homedir();
    // Same locations as core/src/platform/{windows,linux}/launchers_*.cpp.
    const candidates = WINDOWS
      ? [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter((base): base is string => !!base).map(base => path.join(base, "Steam"))
      : [path.join(home, ".local/share/Steam"), path.join(home, ".steam/steam"), path.join(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam")];
    const roots = candidates.filter(root => existsSync(path.join(root, "appcache", "librarycache")));
    const libraries = new Set(roots);
    for (const root of roots) {
      const vdf = await fs.readFile(path.join(root, "steamapps", "libraryfolders.vdf"), "utf8").catch(() => "");
      for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(match[1].replace(/\\\\/g, "\\"));
    }
    const apps: SteamApps = new Map();
    for (const library of libraries) {
      const dir = path.join(library, "steamapps");
      for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
        if (!/^appmanifest_\d+\.acf$/.test(name)) continue;
        const acf = await fs.readFile(path.join(dir, name), "utf8").catch(() => "");
        const id = /"appid"\s+"(\d+)"/.exec(acf)?.[1];
        const installdir = /"installdir"\s+"([^"]+)"/.exec(acf)?.[1];
        if (id && installdir) apps.set(installdir.toLowerCase(), id);
      }
    }
    return { roots, apps };
  })();
}

async function steamIcon(request: GameIconRequest): Promise<Url> {
  const { roots, apps } = await steamLibraries();
  const ids = new Set(request.launchers.filter(l => l.type === "steam" && /^\d+$/.test(l.id)).map(l => l.id));
  // Games detected from a running process carry only their path.
  for (const p of [...request.installPaths, request.path ?? ""]) {
    const dir = /steamapps[\\/]common[\\/]([^\\/]+)/i.exec(p)?.[1];
    const id = dir && apps.get(dir.toLowerCase());
    if (id) ids.add(id);
  }
  for (const root of roots) {
    const cache = path.join(root, "appcache", "librarycache");
    for (const id of ids) {
      // Current layout: <appid>/<icon sha1>.jpg beside header/library art; older: <appid>_icon.jpg.
      const file = (await fs.readdir(path.join(cache, id)).catch(() => [] as string[])).find(name => /^[0-9a-f]{40}\.(jpg|png)$/i.test(name));
      const image = nativeImage.createFromPath(file ? path.join(cache, id, file) : path.join(cache, `${id}_icon.jpg`));
      if (!image.isEmpty()) return image.toDataURL();
    }
  }
  return null;
}

// ------------------------------------------------------- Linux desktop --
type DesktopEntry = { id: string; name: string; exec: string; wmClass: string; icon: string };
let desktop: Promise<DesktopEntry[]> | null = null;

function dataDirs(): string[] {
  const home = os.homedir();
  return [...new Set([process.env.XDG_DATA_HOME || path.join(home, ".local/share"),
    ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
    path.join(home, ".local/share/flatpak/exports/share"), "/var/lib/flatpak/exports/share"].filter(Boolean))];
}

function desktopEntries(): Promise<DesktopEntry[]> {
  return desktop ??= (async () => {
    const entries: DesktopEntry[] = [];
    for (const dir of dataDirs().map(d => path.join(d, "applications"))) {
      for (const file of await fs.readdir(dir).catch(() => [] as string[])) {
        if (!file.endsWith(".desktop")) continue;
        const text = await fs.readFile(path.join(dir, file), "utf8").catch(() => "");
        const section = text.split(/^\[/m).find(part => part.startsWith("Desktop Entry]")) ?? "";
        const field = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(section)?.[1].trim() ?? "";
        if (field("Icon")) entries.push({ id: file.slice(0, -8).toLowerCase(), name: field("Name").toLowerCase(), exec: field("Exec"), wmClass: field("StartupWMClass").toLowerCase(), icon: field("Icon") });
      }
    }
    return entries;
  })();
}

// The program an Exec= line runs: skips env assignments; flatpak runs its app id.
function execProgram(exec: string): string {
  const tokens = exec.split(/\s+/).filter(token => token && !token.startsWith("%"));
  let i = 0;
  if (path.basename(tokens[i] ?? "") === "env") i++;
  while (/^\w+=/.test(tokens[i] ?? "")) i++;
  if (path.basename(tokens[i] ?? "") === "flatpak") return (tokens.slice(i + 1).find(token => !token.startsWith("-") && token !== "run") ?? "").toLowerCase();
  return path.basename((tokens[i] ?? "").replace(/^"|"$/g, "")).toLowerCase();
}

async function themeIcon(icon: string): Promise<Url> {
  const files = path.isAbsolute(icon) ? [icon] : dataDirs().flatMap(dir => [
    ...["512x512", "256x256", "128x128", "96x96", "64x64", "48x48", "scalable"].flatMap(size => [".png", ".svg"].map(ext => path.join(dir, "icons/hicolor", size, "apps", icon + ext))),
    ...[".png", ".svg"].map(ext => path.join(dir, "pixmaps", icon + ext))]);
  for (const file of files) {
    if (!existsSync(file)) continue;
    if (file.endsWith(".svg")) {
      const svg = await fs.readFile(file).catch(() => null);
      if (svg && svg.length < 512 * 1024) return `data:image/svg+xml;base64,${svg.toString("base64")}`;
    } else {
      const image = nativeImage.createFromPath(file);
      if (!image.isEmpty()) return image.resize({ width: 64, height: 64, quality: "best" }).toDataURL();
    }
  }
  return null;
}

async function desktopIcon(exes: string[], title?: string): Promise<Url> {
  if (process.platform !== "linux") return null;
  const stems = new Set(exes.map(exe => exe.toLowerCase().replace(/\.exe$/, "")).filter(Boolean));
  const name = title?.toLowerCase();
  const entry = (await desktopEntries()).find(e => stems.has(execProgram(e.exec)) || stems.has(e.wmClass) || stems.has(e.id)
    || [...stems].some(stem => e.id.endsWith(`.${stem}`) || execProgram(e.exec).endsWith(`.${stem}`)) || (!!name && e.name === name));
  return entry ? themeIcon(entry.icon) : null;
}

// ---------------------------------------------------------------- cache --
let legacyCleared = false;
// `key` scopes the in-memory result; `diskKey` names the persistent icon.
async function cached(key: string, diskKey: string, resolve: () => Promise<Url>, persist: boolean): Promise<Url> {
  if (memory.has(key)) return memory.get(key)!;
  if (!legacyCleared) { legacyCleared = true; void fs.rm(path.join(app.getPath("userData"), "game-icons"), { recursive: true, force: true }); }
  const disk = nativeImage.createFromPath(cacheFile(diskKey));
  let url: Url = disk.isEmpty() ? null : disk.toDataURL();
  if (!url) {
    url = await resolve().catch(() => null);
    if (url && persist && url.startsWith("data:image/png")) {
      const png = nativeImage.createFromDataURL(url).toPNG();
      void fs.mkdir(cacheDir(), { recursive: true }).then(() => fs.writeFile(cacheFile(diskKey), png)).catch(() => {});
    }
  }
  memory.set(key, url);
  return url;
}

async function pool<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < items.length) await work(items[next++]); }));
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function isGameRequest(value: unknown): value is GameIconRequest {
  const r = value as Record<string, unknown> | null;
  return !!r && typeof r === "object" && typeof r.id === "string" && typeof r.name === "string" && strings(r.executables)
    && strings(r.installPaths) && Array.isArray(r.launchers) && (r.path === undefined || typeof r.path === "string");
}

export async function gameIcons(requests: unknown): Promise<Record<string, string>> {
  if (!Array.isArray(requests)) return {};
  const result: Record<string, string> = {};
  await pool(requests.filter(isGameRequest).slice(0, 1000), async request => {
    // A game first seen idle is looked up again once it runs and its path is known.
    const url = await cached(`game:${request.id}:${request.path ?? ""}`, `game:${request.id}`, async () =>
      (WINDOWS ? await gameExeIcon(request) : null) ?? await steamIcon(request) ?? await desktopIcon(request.executables, request.name), true);
    if (url) result[request.id] = url;
  });
  return result;
}

export async function appIcons(exes: unknown): Promise<Record<string, string>> {
  if (!strings(exes)) return {};
  const wanted = [...new Set(exes.map(exe => exe.trim().toLowerCase()).filter(exe => /^[\w .+()-]{1,128}$/.test(exe)))].slice(0, 64);
  // Windows reads the icon from the running process's image, found in one batch.
  const lookup = WINDOWS ? wanted.filter(exe => !memory.has(`app:${exe}`) && !existsSync(cacheFile(`app:${exe}`))) : [];
  const found = await powershell(PROCESS_PATH_PS, lookup.map(exe => exe.replace(/\.exe$/, "")));
  const running = new Map(lookup.map((exe, i) => [exe, found[i] ?? ""]));
  const result: Record<string, string> = {};
  await pool(wanted, async exe => {
    const key = `app:${exe}`;
    const url = await cached(key, key, async () => WINDOWS ? exeIcons([running.get(exe) ?? ""]) : desktopIcon([exe]), WINDOWS);
    if (url) result[exe] = url;
    else memory.delete(key); // Not running yet; look again next time.
  });
  return result;
}
