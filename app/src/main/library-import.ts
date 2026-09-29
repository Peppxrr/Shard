import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

export interface ImportTreeScan {
  files: string[];
  skipped: number;
  errors: string[];
}

export interface MedalImportMetadata {
  game: string | null;
  createdAt: number;
}

export interface ImportSourceFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}

export function sourceFingerprint(file: string, size: number, mtimeMs: number): ImportSourceFingerprint {
  let normalized = path.resolve(file);
  if (process.platform === "win32") normalized = normalized.toLocaleLowerCase("en-US");
  return { path: normalized, size, mtimeMs };
}

export async function scanMp4Tree(root: string): Promise<ImportTreeScan> {
  const files: string[] = [];
  const errors: string[] = [];
  let skipped = 0;
  let realRoot: string;

  try {
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { files, skipped, errors: [`Selected path is not a regular folder: ${root}`] };
    }
    realRoot = await fs.realpath(root);
  } catch (error) {
    return { files, skipped, errors: [`Cannot open selected folder: ${errorMessage(error)}`] };
  }

  const isInsideRoot = (candidate: string): boolean => {
    const relative = path.relative(realRoot, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(`Cannot read folder ${path.relative(realRoot, directory) || "."}: ${errorMessage(error)}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      try {
        const stat = await fs.lstat(fullPath);
        if (stat.isSymbolicLink()) {
          skipped++;
          errors.push(`Skipped symbolic link: ${path.relative(realRoot, fullPath)}`);
          continue;
        }
        const realPath = await fs.realpath(fullPath);
        if (!isInsideRoot(realPath)) {
          skipped++;
          errors.push(`Skipped path outside selected folder: ${path.relative(realRoot, fullPath)}`);
          continue;
        }
        if (stat.isDirectory()) {
          await walk(realPath);
        } else if (stat.isFile() && path.extname(entry.name).toLowerCase() === ".mp4") {
          files.push(realPath);
        }
      } catch (error) {
        errors.push(`Cannot inspect ${path.relative(realRoot, fullPath)}: ${errorMessage(error)}`);
      }
    }
  };

  await walk(realRoot);
  files.sort((a, b) => a.localeCompare(b));
  return { files, skipped, errors };
}

export function medalImportMetadata(root: string, file: string, modifiedAt: number): MedalImportMetadata {
  const relative = path.relative(root, file);
  const components = relative.split(/[\\/]/).filter(Boolean);
  const folderGame = components.length > 1 ? components[0].trim() : "";
  const stem = path.basename(file, path.extname(file));
  const match = /^MedalTV(.+?)(\d{17})$/i.exec(stem);
  const medalGame = match ? humanizeGameName(match[1]) : "";
  const medalDate = match ? parseMedalTimestamp(match[2]) : null;

  return {
    game: folderGame || medalGame || null,
    createdAt: medalDate ?? (Number.isFinite(modifiedAt) && modifiedAt > 0 ? modifiedAt : Date.now()),
  };
}

export function validateClipBasename(input: string): string {
  if (typeof input !== "string") throw new Error("Enter a clip name");
  let name = input.trim();
  if (name.toLowerCase().endsWith(".mp4")) name = name.slice(0, -4);
  if (!name || name === "." || name === "..") throw new Error("Enter a valid clip name");
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) throw new Error("Clip names cannot contain \\/:*?\"<>| or control characters");
  if (/[ .]$/.test(name)) throw new Error("Clip names cannot end with a space or period");
  if (name.length > 240) throw new Error("Clip name is too long");
  const deviceName = name.split(".", 1)[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(deviceName)) throw new Error("That name is reserved by Windows");
  return name;
}

export async function copyMp4ToUniquePath(source: string, destinationDirectory: string): Promise<string> {
  await fs.mkdir(destinationDirectory, { recursive: true });
  const sourceBase = path.basename(source, path.extname(source));
  for (let collision = 0; collision < 10000; collision++) {
    const suffix = collision === 0 ? "" : ` (${collision + 1})`;
    const base = truncateUtf16(sourceBase, 250 - suffix.length);
    const destination = path.join(destinationDirectory, `${base}${suffix}.mp4`);
    try {
      await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`Could not choose an unused filename for ${path.basename(source)}`);
}

function parseMedalTimestamp(value: string): number | null {
  if (!/^\d{17}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const millisecond = Number(value.slice(14, 17));
  const date = new Date(year, month - 1, day, hour, minute, second, millisecond);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day ||
      date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second ||
      date.getMilliseconds() !== millisecond) return null;
  return date.getTime();
}

function humanizeGameName(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .trim();
}

function truncateUtf16(value: string, limit: number): string {
  let result = "";
  for (const character of value) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result || "Medal clip";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
