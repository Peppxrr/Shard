import { promises as fs, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { BUILTIN_THEME_IDS, normalizeThemeValues, parseThemeManifest, parseThemeMeta, sanitizeThemeId, rewriteThemeUrls } from "../shared/themes";
import type { ThemeDocument, ThemeMeta, ThemeValues } from "../shared/themes";

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};
type ThemeLocation = { name: string; id: string; standalone: boolean };

/** A single discovery path keeps folder collisions, metadata, and reads consistent. */
export class ThemeStore {
  private revision = Date.now();
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(readonly dir: string, private version: string, private changed: () => void = () => {}) {}

  private async inside(root: string, relative: string): Promise<string> {
    const base = await fs.realpath(root);
    const target = await fs.realpath(path.resolve(root, relative));
    const rel = path.relative(base, target);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Theme path leaves its folder.");
    return target;
  }

  private async readText(root: string, relative: string): Promise<string> {
    const file = await this.inside(root, relative);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Theme text files must be smaller than 2 MB.");
    return fs.readFile(file, "utf8");
  }

  private async locations(): Promise<ThemeLocation[]> {
    await fs.mkdir(this.dir, { recursive: true });
    const entries = await fs.readdir(this.dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() || (e.isFile() && /\.css$/i.test(e.name) && e.name.toLowerCase() !== "custom.css"))
      .map(e => ({ name: e.name, id: sanitizeThemeId(e.isDirectory() ? e.name : e.name.slice(0, -4)), standalone: e.isFile() }))
      .sort((a, b) => {
      // Existing folder themes retain their identity when a same-named CSS file is dropped in.
      if (a.standalone !== b.standalone) return Number(a.standalone) - Number(b.standalone);
      const aExact = (a.standalone ? a.name.slice(0, -4) : a.name).toLowerCase() === a.id;
      const bExact = (b.standalone ? b.name.slice(0, -4) : b.name).toLowerCase() === b.id;
      return Number(bExact) - Number(aExact) || a.name.localeCompare(b.name);
    });
  }

  private url(relative: string): string {
    return `shard-theme://local/r${this.revision}/${relative.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
  }

  private async document(location: ThemeLocation): Promise<ThemeDocument> {
    const folder = location.name;
    if (location.standalone) {
      const css = await this.readText(this.dir, folder);
      return { meta: parseThemeMeta(css, folder.slice(0, -4)), styles: [this.url(folder)], values: {} };
    }
    const dir = await this.inside(this.dir, folder);
    let css = "";
    try { css = await this.readText(dir, "theme.css"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const meta = parseThemeMeta(css, folder);
    let styles = ["theme.css"];
    try {
      const raw = await this.readText(dir, "theme.json");
      const manifest = parseThemeManifest(JSON.parse(raw.replace(/^\uFEFF/, "")), this.version);
      for (const key of ["name", "author", "version", "description"] as const) if (manifest[key]) meta[key] = manifest[key];
      meta.settings = manifest.settings;
      styles = manifest.styles;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Validate all entry sheets before touching the active renderer theme.
    for (const file of styles) await this.readText(dir, file);
    return { meta, styles: styles.map(file => this.url(`${folder}/${file}`)), values: await this.values(meta) };
  }

  async list(): Promise<ThemeMeta[]> {
    const used = new Set<string>(BUILTIN_THEME_IDS);
    const result: ThemeMeta[] = [];
    for (const location of await this.locations()) {
      const { id, name } = location;
      if (used.has(id)) continue;
      used.add(id);
      try { result.push((await this.document(location)).meta); }
      catch (error) { result.push({ id, name, kind: "custom", error: error instanceof Error ? error.message : String(error) }); }
    }
    return result;
  }

  async read(id: string): Promise<ThemeDocument | null> {
    const safe = sanitizeThemeId(id);
    if ((BUILTIN_THEME_IDS as readonly string[]).includes(safe)) return null;
    const location = (await this.locations()).find(entry => entry.id === safe);
    return location ? this.document(location) : null;
  }

  async customCss(): Promise<string | null> {
    try { await this.readText(this.dir, "custom.css"); return this.url("custom.css"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  private async saved(): Promise<Record<string, ThemeValues>> {
    try { return JSON.parse(await fs.readFile(path.join(this.dir, "..", "theme-options.json"), "utf8")); }
    catch { return {}; }
  }
  private async values(meta: ThemeMeta): Promise<ThemeValues> {
    const saved = await this.saved();
    return normalizeThemeValues(meta.settings ?? {}, saved?.[meta.id]);
  }
  saveValues(id: string, input: ThemeValues): Promise<ThemeValues> {
    const operation = this.writes.catch(() => {}).then(async () => {
      const doc = await this.read(id);
      if (!doc) throw new Error("Theme no longer exists.");
      const values = normalizeThemeValues(doc.meta.settings ?? {}, input);
      const saved = await this.saved();
      const file = path.join(this.dir, "..", "theme-options.json");
      await fs.writeFile(`${file}.tmp`, JSON.stringify({ ...saved, [doc.meta.id]: values }, null, 2), "utf8");
      await fs.rename(`${file}.tmp`, file);
      return values;
    });
    this.writes = operation;
    return operation;
  }

  async resource(url: string): Promise<{ data: Uint8Array; mime: string }> {
    const parsed = new URL(url);
    if (parsed.protocol !== "shard-theme:" || parsed.hostname !== "local") throw new Error("Invalid theme URL.");
    const segments = parsed.pathname.split("/").slice(1).map(decodeURIComponent);
    if (!/^r\d+$/.test(segments.shift() ?? "") || !segments.length || segments.some(s => !s || /[\\/:\0]/.test(s) || s === "." || s === "..")) throw new Error("Invalid theme path.");
    const mime = MIME[path.extname(segments.at(-1)!).toLowerCase()];
    if (!mime) throw new Error("Unsupported theme resource type.");
    const file = await this.inside(this.dir, segments.join(path.sep));
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error("Theme resources must be smaller than 50 MB.");
    const bytes = await fs.readFile(file);
    return { data: new Uint8Array(path.extname(file).toLowerCase() === ".css" ? Buffer.from(rewriteThemeUrls(bytes.toString("utf8"), url)) : bytes), mime };
  }

  async startWatching(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    this.watcher = watch(this.dir, { recursive: true }, () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.revision++; this.changed(); }, 250);
    });
    this.watcher.on("error", error => console.warn("[themes] Live reload unavailable; use Reload themes.", error));
  }
  refresh(): void { this.revision++; }
  close(): void { clearTimeout(this.timer); this.watcher?.close(); }
}
