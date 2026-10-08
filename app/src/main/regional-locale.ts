import { app } from "electron";

// Shard ships only Chromium's en-US UI strings, which makes the renderer's
// default locale en-US. Pass the Windows display language so dates and numbers
// keep the user's format (read by preload.ts as window.shard.regionalLocale).
export function regionalLocaleArgument(): string {
  let locale = "en-US";
  try {
    const [preferred] = app.getPreferredSystemLanguages();
    if (preferred) [locale] = Intl.getCanonicalLocales(preferred);
  } catch {
    // Unknown or malformed language tag: keep en-US.
  }
  return `--shard-regional-locale=${locale}`;
}
