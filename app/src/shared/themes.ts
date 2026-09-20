// Theme API 1: data only. Values are validated before becoming CSS or attributes.
export const THEME_API_VERSION = 1;
export const BUILTIN_THEME_IDS = ["default", "oled", "midnight"] as const;
export type ThemeValue = string | number | boolean;
export type ThemeValues = Record<string, ThemeValue>;
type OptionBase = { name: string; description?: string };
export type ThemeOption = OptionBase & (
  | { type: "color"; default: string }
  | { type: "boolean"; default: boolean }
  | { type: "range"; default: number; min: number; max: number; step: number; unit: "" | "px" | "rem" | "%" | "ms" }
  | { type: "select"; default: string; choices: { value: string; label: string }[] }
);
export interface ThemeMeta {
  id: string;
  name: string;
  author?: string;
  version?: string;
  description?: string;
  kind: "builtin" | "custom";
  settings?: Record<string, ThemeOption>;
  error?: string;
}
export interface ThemeManifest {
  schema: 1;
  name?: string;
  author?: string;
  version?: string;
  description?: string;
  minShardVersion?: string;
  styles: string[];
  settings: Record<string, ThemeOption>;
}
export interface ThemeDocument {
  meta: ThemeMeta;
  styles: string[];
  values: ThemeValues;
}

export function sanitizeThemeId(id: string): string {
  return String(id ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "default";
}

export function parseThemeMeta(css: string, folder: string, kind: ThemeMeta["kind"] = "custom"): ThemeMeta {
  const comment = css.match(/^\s*\/\*\*([\s\S]*?)\*\//)?.[1] ?? "";
  const meta: ThemeMeta = { id: sanitizeThemeId(folder), name: folder, kind };
  for (const key of ["name", "author", "version", "description"] as const) {
    const value = comment.match(new RegExp(`@${key}[^\\S\\r\\n]+([^\\r\\n*]+)`, "i"))?.[1].trim();
    if (value) meta[key] = value.slice(0, 500);
  }
  return meta;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
const keyPattern = /^[a-z][a-z0-9-]{0,47}$/;
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new Error(`Invalid ${field}.`);
  return value.trim();
}

export function parseThemeManifest(input: unknown, appVersion: string): ThemeManifest {
  const raw = object(input);
  if (raw.schema !== THEME_API_VERSION) throw new Error(`Unsupported theme schema ${String(raw.schema)}; Shard supports schema 1.`);
  const manifest: ThemeManifest = { schema: 1, styles: ["theme.css"], settings: {} };
  for (const key of ["name", "author", "version", "description", "minShardVersion"] as const) {
    if (raw[key] !== undefined) manifest[key] = text(raw[key], key);
  }
  if (manifest.minShardVersion) {
    if (!/^\d+\.\d+\.\d+$/.test(manifest.minShardVersion)) throw new Error("minShardVersion must be a version such as 0.1.5.");
    const want = manifest.minShardVersion.split(".").map(Number);
    const have = appVersion.split(/[.-]/).slice(0, 3).map(Number);
    const first = want.findIndex((v, i) => v !== have[i]);
    if (first >= 0 && want[first] > have[first]) throw new Error(`Requires Shard ${manifest.minShardVersion} or newer.`);
  }
  if (raw.styles !== undefined) {
    if (!Array.isArray(raw.styles) || !raw.styles.length || raw.styles.length > 16) throw new Error("styles must contain 1–16 CSS paths.");
    manifest.styles = raw.styles.map(value => {
      const file = text(value, "stylesheet path");
      if (!/\.css$/i.test(file) || /[:\\?#]/.test(file) || file.startsWith("/") || file.split("/").some(p => !p || p === "..")) throw new Error(`Invalid stylesheet path: ${file}`);
      return file;
    });
  }
  if (raw.settings !== undefined) {
    const settings = object(raw.settings);
    if (Object.keys(settings).length > 32) throw new Error("A theme may declare at most 32 options.");
    for (const [key, value] of Object.entries(settings)) {
      if (!keyPattern.test(key) || ["constructor", "prototype"].includes(key)) throw new Error(`Invalid option key: ${key}`);
      const option = object(value);
      const base: OptionBase = { name: text(option.name, `${key}.name`) };
      if (option.description !== undefined) base.description = text(option.description, `${key}.description`);
      let parsed: ThemeOption;
      switch (option.type) {
        case "color":
          if (typeof option.default !== "string" || !/^#[0-9a-f]{6}$/i.test(option.default)) throw new Error(`${key}: use a six-digit hex color.`);
          parsed = { ...base, type: "color", default: option.default }; break;
        case "boolean":
          if (typeof option.default !== "boolean") throw new Error(`${key}: default must be true or false.`);
          parsed = { ...base, type: "boolean", default: option.default }; break;
        case "range": {
          const { min, max, default: initial } = option;
          const step = option.step ?? 1;
          const unit = option.unit ?? "";
          if (![min, max, initial, step].every(v => typeof v === "number" && Number.isFinite(v)) || Number(min) >= Number(max) || Number(step) <= 0 || Number(initial) < Number(min) || Number(initial) > Number(max)) throw new Error(`${key}: invalid range bounds, step, or default.`);
          if (!["", "px", "rem", "%", "ms"].includes(String(unit))) throw new Error(`${key}: unsupported range unit.`);
          parsed = { ...base, type: "range", default: initial as number, min: min as number, max: max as number, step: step as number, unit: unit as "px" }; break;
        }
        case "select": {
          if (!Array.isArray(option.choices) || !option.choices.length || option.choices.length > 20) throw new Error(`${key}: provide 1–20 choices.`);
          const choices = option.choices.map(c => {
            const choice = object(c);
            if (typeof choice.value !== "string" || !keyPattern.test(choice.value)) throw new Error(`${key}: choice values must be lowercase CSS identifiers.`);
            return { value: choice.value, label: text(choice.label, `${key}.label`) };
          });
          if (new Set(choices.map(c => c.value)).size !== choices.length || !choices.some(c => c.value === option.default)) throw new Error(`${key}: choices must be unique and include the default.`);
          parsed = { ...base, type: "select", default: option.default as string, choices }; break;
        }
        default: throw new Error(`${key}: unsupported option type ${String(option.type)}.`);
      }
      manifest.settings[key] = parsed;
    }
  }
  return manifest;
}

export function normalizeThemeValues(options: Record<string, ThemeOption>, input: unknown): ThemeValues {
  const values = input && typeof input === "object" ? input as ThemeValues : {};
  return Object.fromEntries(Object.entries(options).map(([key, option]) => {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    let result: ThemeValue = option.default;
    if (option.type === "color" && typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) result = value;
    if (option.type === "boolean" && typeof value === "boolean") result = value;
    if (option.type === "select" && option.choices.some(c => c.value === value)) result = value!;
    if (option.type === "range" && typeof value === "number" && Number.isFinite(value)) {
      result = Number(Math.max(option.min, Math.min(option.max, option.min + Math.round((value - option.min) / option.step) * option.step)).toFixed(6));
    }
    return [key, result];
  }));
}

export function themeOptionCss(options: Record<string, ThemeOption>, input: ThemeValues): string {
  const values = normalizeThemeValues(options, input);
  return `:root {\n${Object.entries(options).map(([key, option]) => `  --theme-${key}: ${typeof values[key] === "boolean" ? Number(values[key]) : values[key]}${option.type === "range" ? option.unit : ""};`).join("\n")}\n}`;
}

// Walk CSS lexical tokens, skipping comments and unrelated strings. Quoted URLs
// may contain parentheses; CSS escapes are decoded before URL resolution. This
// also makes image URLs stored in custom properties usable by the icon renderer.
export function rewriteThemeUrls(css: string, base: string): string {
  const unescape = (value: string) => value.replace(/\\(?:([0-9a-f]{1,6})\s?|([^\r\n])|\r?\n)/gi,
    (_match, hex: string | undefined, char: string | undefined) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : char ?? "");
  const resolve = (value: string) => {
    const url = unescape(value.trim());
    if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return url;
    return new URL(url, base).href;
  };
  return css.replace(/\/\*[\s\S]*?\*\/|url\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|((?:\\[\s\S]|[^)\\])*))\s*\)|@import\s+(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)')|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/gi,
    (full, double: string | undefined, single: string | undefined, bare: string | undefined, importDouble: string | undefined, importSingle: string | undefined) => {
      if (double !== undefined || single !== undefined || bare !== undefined) return `url(${JSON.stringify(resolve(double ?? single ?? bare!))})`;
      if (importDouble !== undefined || importSingle !== undefined) return `@import ${JSON.stringify(resolve(importDouble ?? importSingle!))}`;
      return full;
    });
}
