// themeManager.ts — isolated theme management layer for Shard.
// Handles built-in + custom theme discovery, CSS injection, local asset
// rewriting, metadata parsing, persistence, and fallback.

/* THEME API — public renderer class names are part of the theme contract.
   Custom themes may target any of these stable selectors; avoid renaming them
   without a major version bump.

   .app, .app__bar, .app__main,
   .nav, .nav__item,
   .card, .card__head, .card__body,
   .settings, .settings__nav, .settings__content,
   .capture, .capture__hero, .library, .games, .editor, .timeline, etc.
   See styles.css and docs/THEMES.md for the full list.
*/

export interface ThemeMeta {
  id: string;
  name: string;
  author?: string;
  version?: string;
  description?: string;
  kind: "builtin" | "custom";
}

interface ThemeEntry {
  meta: ThemeMeta;
  css: string;
}

// Vite raw imports — built-in theme CSS is bundled, local assets would be
// handled by Vite's asset pipeline if needed. Built-ins are color-only.
import defaultCss from "./themes/default/theme.css?raw";
import oledCss from "./themes/oled/theme.css?raw";
import midnightCss from "./themes/midnight/theme.css?raw";

const BUILTIN_CSS: Record<string, string> = {
  default: defaultCss,
  oled: oledCss,
  midnight: midnightCss,
};

const BUILTIN_META: Record<string, ThemeMeta> = {
  default: parseMeta(defaultCss, "default", "builtin") ?? { id: "default", name: "Default", kind: "builtin" },
  oled: parseMeta(oledCss, "oled", "builtin") ?? { id: "oled", name: "OLED", kind: "builtin" },
  midnight: parseMeta(midnightCss, "midnight", "builtin") ?? { id: "midnight", name: "Midnight", kind: "builtin" },
};

const STORAGE_KEY = "shard:theme";
const THEME_STYLE_ID = "shard-theme";
const CUSTOM_CSS_ID = "shard-custom-css";
export const THEME_CHANGE_EVENT = "shard:theme-change";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sanitizeThemeId(id: string): string {
  const s = String(id ?? "").trim().toLowerCase();
  if (!s) return "default";
  // allow a-z, 0-9, hyphen, underscore
  const cleaned = s.replace(/[^a-z0-9-_]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

function parseMeta(css: string, fallbackId: string, kind: "builtin" | "custom"): ThemeMeta | null {
  try {
    const m = css.match(/\/\*\*([\s\S]*?)\*\//);
    if (!m) return { id: sanitizeThemeId(fallbackId), name: fallbackId, kind };
    const block = m[1];
    const get = (key: string): string | undefined => {
      const re = new RegExp(`@${key}\\s+([^\\n*]+)`, "i");
      const hit = block.match(re);
      return hit?.[1]?.trim();
    };
    const name = get("name") || fallbackId;
    const meta: ThemeMeta = {
      id: sanitizeThemeId(fallbackId),
      name,
      kind,
    };
    const author = get("author");
    const version = get("version");
    const description = get("description");
    if (author) meta.author = author;
    if (version) meta.version = version;
    if (description) meta.description = description;
    return meta;
  } catch {
    return { id: sanitizeThemeId(fallbackId), name: fallbackId, kind };
  }
}

function toFileUrl(winPath: string): string {
  // C:\Users\...\Goob.png -> file:///C:/Users/.../Goob.png
  const posix = winPath.replace(/\\/g, "/");
  // Encode each segment but keep slashes and colon after drive letter
  // Split on "/" and encode; drive letter "C:" stays.
  const parts = posix.split("/");
  const encoded = parts.map((p, i) => (i === 0 && /^[A-Za-z]:$/.test(p) ? p : encodeURIComponent(p))).join("/");
  // Ensure leading slash for absolute Windows path is handled: file:///C:/...
  if (/^[A-Za-z]:/.test(encoded)) return `file:///${encoded}`;
  if (encoded.startsWith("/")) return `file://${encoded}`;
  return `file:///${encoded}`;
}

function rewriteUrls(css: string, baseDir: string, cacheBust: boolean = false): string {
  if (!baseDir) return css;
  // Normalize baseDir to posix without trailing slash for URL resolution
  const basePosix = baseDir.replace(/\\/g, "/").replace(/\/$/, "");
  const baseUrl = `file:///${basePosix}/`.replace(/\/\/\/+/g, "///");
  // Match url(...) — capture quote and url
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, quote: string, rawUrl: string) => {
    const url = rawUrl.trim();
    if (!url) return full;
    // Keep data:, https:, http:, //, file:, blob:, and absolute /...
    if (/^(data:|https?:|\/\/|file:|blob:)/i.test(url)) return full;
    if (url.startsWith("#")) return full;
    // Allow remote via https — do not block
    try {
      // Resolve relative against baseDir
      // Use URL constructor for proper ../ resolution
      const resolved = new URL(url, baseUrl).href;
      // resolved is file:///C:/... — add cache bust so reload picks up replaced images without restart
      const busted = cacheBust ? `${resolved}${resolved.includes("?") ? "&" : "?"}v=${Date.now()}` : resolved;
      const q = quote || '"';
      return `url(${q}${busted}${q})`;
    } catch {
      // Fallback: naive join
      const cleaned = url.replace(/^\.\//, "");
      const abs = `${basePosix}/${cleaned}`;
      const baseFile = toFileUrl(abs);
      const busted2 = cacheBust ? `${baseFile}${baseFile.includes("?") ? "&" : "?"}v=${Date.now()}` : baseFile;
      return `url(${quote || '"'}${busted2}${quote || '"'})`;
    }
  });
}

function ensureStyleEl(id: string): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (el) return el;
  el = document.createElement("style");
  el.id = id;
  // Ensure theme loads after base Shard CSS — append to head end
  document.head.appendChild(el);
  return el;
}

function setDataTheme(id: string): void {
  const safe = sanitizeThemeId(id);
  document.documentElement.setAttribute("data-theme", safe);
  document.body?.setAttribute("data-theme", safe);
}

function notifyThemeChange(id: string): void {
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { id: sanitizeThemeId(id) } }));
}

// ---------------------------------------------------------------------------
// Built-in access
// ---------------------------------------------------------------------------

export function getBuiltinThemes(): ThemeMeta[] {
  return Object.values(BUILTIN_META);
}

export function getBuiltinCss(id: string): string | null {
  const key = sanitizeThemeId(id);
  return BUILTIN_CSS[key] ?? null;
}

// ---------------------------------------------------------------------------
// Custom discovery via IPC (main process)
// ---------------------------------------------------------------------------

// Window.shardThemes is declared in src/renderer-env.d.ts — augmented there

async function listCustomThemes(): Promise<ThemeMeta[]> {
  try {
    if (window.shardThemes?.listCustom) return await window.shardThemes.listCustom();
    // Fallback: try via window.shard.invoke if exposed differently
    if ((window as any).shard?.listThemes) return await (window as any).shard.listThemes();
  } catch (e) {
    console.warn("[theme] listCustom failed", e);
  }
  return [];
}

async function readCustomTheme(id: string): Promise<{ css: string; dir: string } | null> {
  try {
    if (window.shardThemes?.readTheme) return await window.shardThemes.readTheme(sanitizeThemeId(id));
  } catch (e) {
    console.warn(`[theme] readTheme ${id} failed`, e);
  }
  return null;
}

async function readCustomCss(): Promise<{ css: string; dir: string } | null> {
  try {
    if (window.shardThemes?.readCustomCss) return await window.shardThemes.readCustomCss();
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Public manager
// ---------------------------------------------------------------------------

export async function getAllThemes(): Promise<ThemeMeta[]> {
  const builtins = getBuiltinThemes();
  const customs = await listCustomThemes();
  // Customs already contain parsed meta; ensure kind
  const merged = [...builtins, ...customs];
  // Deduplicate by id (builtin takes precedence if collision)
  const seen = new Set<string>();
  const out: ThemeMeta[] = [];
  for (const t of merged) {
    const id = sanitizeThemeId(t.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...t, id });
  }
  return out;
}

export function getSelectedId(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v) return sanitizeThemeId(v);
  } catch {}
  return "default";
}

export function persistLocal(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, sanitizeThemeId(id));
  } catch {}
}

async function persistToSettings(id: string): Promise<void> {
  try {
    const s = await window.shard?.getSettings?.();
    if (!s) return;
    const safe = sanitizeThemeId(id);
    // Support both appearance.theme and app.theme
    if (s.appearance) {
      if (s.appearance.theme === safe) return;
      s.appearance.theme = safe;
    } else if (s.app && "theme" in s.app) {
      (s.app as any).theme = safe;
    } else {
      // Create appearance if missing
      (s as any).appearance = { theme: safe };
    }
    await window.shard?.setSettings?.(s);
  } catch (e) {
    console.warn("[theme] persistToSettings failed", e);
  }
}

// Core apply — injects CSS and sets data-theme
export async function applyTheme(id: string, opts: { persist?: boolean } = {}): Promise<void> {
  const safe = sanitizeThemeId(id || "default");
  const builtinCss = getBuiltinCss(safe);
  const styleEl = ensureStyleEl(THEME_STYLE_ID);
  const customCssEl = ensureStyleEl(CUSTOM_CSS_ID);

  // Always set data-theme early for selectors like [data-theme="oled"]
  setDataTheme(safe);

  try {
    if (builtinCss !== null) {
      // Built-in: direct inject (no URL rewriting needed — color-only)
      styleEl.textContent = builtinCss;
    } else {
      // Custom: read from disk, rewrite urls, inject
      const data = await readCustomTheme(safe);
      if (!data || !data.css) throw new Error(`theme "${safe}" not found`);
      const rewritten = rewriteUrls(data.css, data.dir, true);
      styleEl.textContent = rewritten;
    }

    // After main theme, optionally load Themes/custom.css (user overrides)
    // Loading order: base -> selected theme -> custom.css
    try {
      const custom = await readCustomCss();
      if (custom && custom.css) {
        const rewritten = rewriteUrls(custom.css, custom.dir, true);
        customCssEl.textContent = rewritten;
      } else {
        customCssEl.textContent = "";
      }
    } catch {
      customCssEl.textContent = "";
    }

    persistLocal(safe);
    if (opts.persist) await persistToSettings(safe);
    notifyThemeChange(safe);
    console.info(`[theme] applied ${safe}`);
  } catch (e) {
    console.warn(`[theme] failed to apply "${safe}", falling back to default`, e);
    if (safe !== "default") {
      // Fallback — clear custom css as well
      styleEl.textContent = BUILTIN_CSS["default"] ?? "";
      customCssEl.textContent = "";
      setDataTheme("default");
      persistLocal("default");
      if (opts.persist) await persistToSettings("default").catch(() => {});
    } else {
      styleEl.textContent = BUILTIN_CSS["default"] ?? "";
    }
    notifyThemeChange("default");
  }
}

// Early init — call before React mounts to avoid FOUC
export async function initTheme(): Promise<string> {
  // 1. Sync from localStorage for instant paint
  const localId = getSelectedId();
  setDataTheme(localId);
  const builtinCss = getBuiltinCss(localId);
  if (builtinCss !== null) {
    ensureStyleEl(THEME_STYLE_ID).textContent = builtinCss;
  } else {
    // For custom, we cannot synchronously read file — keep default until async loads
    // But keep data-theme so custom selectors can target early
    ensureStyleEl(THEME_STYLE_ID).textContent = BUILTIN_CSS["default"] ?? "";
  }

  // 2. Async reconcile with settings.json (authoritative) and load custom theme if needed
  try {
    const s = await window.shard?.getSettings?.();
    const settingsTheme = sanitizeThemeId(s?.appearance?.theme ?? (s?.app as any)?.theme ?? localId);
    if (settingsTheme !== localId) {
      await applyTheme(settingsTheme);
      return settingsTheme;
    }
    if (builtinCss === null) {
      // Local was custom — now properly load it
      await applyTheme(localId);
    } else {
      // Ensure custom.css is also loaded even for builtin
      const custom = await readCustomCss();
      if (custom && custom.css) {
        const el = ensureStyleEl(CUSTOM_CSS_ID);
        el.textContent = rewriteUrls(custom.css, custom.dir, true);
      }
    }
    return settingsTheme;
  } catch (e) {
    console.warn("[theme] initTheme settings reconcile failed", e);
    return localId;
  }
}

export async function reloadThemes(id: string = getSelectedId()): Promise<void> {
  await applyTheme(id);
}

export async function openThemesFolder(): Promise<void> {
  try {
    if (window.shardThemes?.openThemesFolder) await window.shardThemes.openThemesFolder();
    else if ((window as any).shard?.openThemesFolder) await (window as any).shard.openThemesFolder();
  } catch (e) {
    console.warn("[theme] openThemesFolder failed", e);
  }
}

// Convenience — for SettingsPage
export async function setTheme(id: string): Promise<void> {
  await applyTheme(id, { persist: true });
}
