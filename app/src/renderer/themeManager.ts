import type { ThemeDocument, ThemeMeta, ThemeValues } from "../shared/themes";
import { parseThemeMeta, sanitizeThemeId, themeOptionCss, normalizeThemeValues, THEME_API_VERSION } from "../shared/themes";
import defaultCss from "./themes/default/theme.css?raw";
import oledCss from "./themes/oled/theme.css?raw";
import midnightCss from "./themes/midnight/theme.css?raw";
export { sanitizeThemeId } from "../shared/themes";
export type { ThemeMeta } from "../shared/themes";

const BUILTIN_CSS: Record<string, string> = { default: defaultCss, oled: oledCss, midnight: midnightCss };
const STORAGE_KEY = "shard:theme";
export const THEME_CHANGE_EVENT = "shard:theme-change";
export const THEME_LIST_EVENT = "shard:theme-list";
let generation = 0;
const iconUrls = new Map<string, string | null>();
let active: ThemeDocument = { meta: parseThemeMeta(defaultCss, "default", "builtin"), styles: [], values: {} };
let activeElements: HTMLElement[] = [];
let optionAttributes: string[] = [];
let lastError: string | null = null;
let stopWatching: (() => void) | undefined;
let pendingId: string | null = null;

export function getBuiltinThemes(): ThemeMeta[] {
  return Object.entries(BUILTIN_CSS).map(([id, css]) => parseThemeMeta(css, id, "builtin"));
}
export function getBuiltinCss(id: string): string | null { const key = sanitizeThemeId(id); return Object.hasOwn(BUILTIN_CSS, key) ? BUILTIN_CSS[key] : null; }
export async function getAllThemes(): Promise<ThemeMeta[]> {
  return [...getBuiltinThemes(), ...await window.shardThemes.listCustom()];
}
export function getSelectedId(): string { return active.meta.id; }
export function getThemeState(): { theme: ThemeDocument; error: string | null } { return { theme: active, error: lastError }; }
function notify(): void {
  iconUrls.clear();
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { id: active.meta.id, error: lastError } }));
}
export function getThemeIconUrl(token: string): string | null {
  if (iconUrls.has(token)) return iconUrls.get(token)!;
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--icon-${token}`).trim();
  const match = value.match(/^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)$/i);
  const url = match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() || null : null;
  iconUrls.set(token, url);
  return url;
}
function style(css: string): HTMLStyleElement {
  const el = document.createElement("style");
  el.textContent = css;
  return el;
}
function loadSheet(url: string, elements: HTMLElement[]): Promise<HTMLLinkElement> {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.media = "not all"; // Load completely before swapping; keep the old theme visible.
    link.href = url;
    elements.push(link);
    const timer = window.setTimeout(() => { link.remove(); reject(new Error("Theme stylesheet timed out.")); }, 8000);
    link.onload = () => { clearTimeout(timer); resolve(link); };
    link.onerror = () => { clearTimeout(timer); reject(new Error("A theme stylesheet could not be loaded.")); };
    document.head.append(link);
  });
}
function applyOptions(doc: ThemeDocument): void {
  for (const name of optionAttributes) document.documentElement.removeAttribute(name);
  optionAttributes = [];
  for (const [key, option] of Object.entries(doc.meta.settings ?? {})) {
    if (option.type !== "boolean" && option.type !== "select") continue;
    const name = `data-theme-${key}`;
    document.documentElement.setAttribute(name, String(doc.values[key]));
    optionAttributes.push(name);
  }
}

// Last request wins. No settings writes here: theme selection follows the same
// Save changes / Discard behavior as the rest of Appearance settings.
export async function applyTheme(id: string, opts: { keepOnError?: boolean } = {}): Promise<string> {
  const request = ++generation;
  const safe = sanitizeThemeId(id);
  pendingId = safe;
  const elements: HTMLElement[] = [];
  try {
    const builtin = getBuiltinCss(safe);
    let doc: ThemeDocument;
    if (builtin !== null) {
      doc = { meta: parseThemeMeta(builtin, safe, "builtin"), styles: [], values: {} };
      elements.push(style(builtin));
    } else {
      const loaded = await window.shardThemes.readTheme(safe);
      if (!loaded) throw new Error(`Theme “${safe}” is no longer installed.`);
      doc = loaded;
      await Promise.all(doc.styles.map(url => loadSheet(url, elements)));
    }
    const options = style(themeOptionCss(doc.meta.settings ?? {}, doc.values));
    options.dataset.shardThemeOptions = "";
    elements.push(options);
    const override = await window.shardThemes.readCustomCss();
    if (override) await loadSheet(override, elements);
    if (request !== generation) { elements.forEach(el => el.remove()); return active.meta.id; }
    // Reappend in declaration order, after base CSS and before personal overrides.
    for (const el of elements) {
      if (el instanceof HTMLLinkElement) el.media = "all";
      document.head.append(el);
    }
    activeElements.forEach(el => el.remove());
    activeElements = elements;
    active = doc;
    pendingId = null;
    lastError = null;
    applyOptions(doc);
    document.documentElement.dataset.theme = safe;
    document.documentElement.dataset.shardThemeApi = String(THEME_API_VERSION);
    document.body.dataset.theme = safe;
    try { localStorage.setItem(STORAGE_KEY, safe); } catch {}
    notify();
  } catch (error) {
    elements.forEach(el => el.remove());
    if (request !== generation) return active.meta.id;
    pendingId = null;
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[theme]", message);
    if (!opts.keepOnError) {
      activeElements.forEach(el => el.remove());
      const fallback = style(defaultCss);
      document.head.append(fallback);
      activeElements = [fallback];
      active = { meta: parseThemeMeta(defaultCss, "default", "builtin"), styles: [], values: {} };
      applyOptions(active);
      document.documentElement.dataset.theme = "default";
      document.documentElement.dataset.shardThemeApi = String(THEME_API_VERSION);
      document.body.dataset.theme = "default";
    }
    lastError = message;
    notify();
  }
  return active.meta.id;
}

export async function initTheme(): Promise<string> {
  const settings = await window.shard.getSettings().catch(() => null);
  let local = "default";
  try { local = localStorage.getItem(STORAGE_KEY) || local; } catch {}
  await applyTheme(settings?.appearance?.theme ?? local);
  stopWatching?.();
  stopWatching = window.shardThemes.onChanged(() => {
    window.dispatchEvent(new Event(THEME_LIST_EVENT));
    // Saving a file must not cancel a theme selection that is still loading.
    void applyTheme(pendingId ?? active.meta.id, { keepOnError: true });
  });
  return active.meta.id;
}
export async function reloadThemes(id = getSelectedId()): Promise<string> {
  await window.shardThemes.refresh();
  window.dispatchEvent(new Event(THEME_LIST_EVENT));
  return applyTheme(id, { keepOnError: true });
}
export async function openThemesFolder(): Promise<void> { await window.shardThemes.openThemesFolder(); }
export async function setTheme(id: string): Promise<string> { return applyTheme(id, { keepOnError: true }); }
export async function setThemeValues(input: ThemeValues): Promise<void> {
  const doc = active;
  const values = normalizeThemeValues(doc.meta.settings ?? {}, input);
  // Update locally without reloading images/fonts for every slider movement.
  doc.values = values;
  const el = activeElements.find(el => el.hasAttribute("data-shard-theme-options"));
  if (el) el.textContent = themeOptionCss(doc.meta.settings ?? {}, values);
  applyOptions(doc);
  notify();
  try { await window.shardThemes.setValues(doc.meta.id, values); }
  catch (error) {
    lastError = `Could not save theme options: ${error instanceof Error ? error.message : String(error)}`;
    notify();
    throw error;
  }
}
