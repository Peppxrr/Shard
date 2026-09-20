import type { ThemeDocument, ThemeValues } from "./shared/themes";
import type { ShardApi, ThemeMeta } from "./shared/contracts";

declare module "*.css?raw" {
  const content: string;
  export default content;
}

declare module "*.svg?raw" {
  const content: string;
  export default content;
}

declare global {
  interface Window {
    shard: ShardApi;
    shardThemes: {
      setValues(id: string, values: ThemeValues): Promise<ThemeValues>;
      refresh(): Promise<void>;
      onChanged(cb: () => void): () => void;
      listCustom(): Promise<ThemeMeta[]>;
      readTheme(id: string): Promise<ThemeDocument | null>;
      readCustomCss(): Promise<string | null>;
      getThemesDir(): Promise<string>;
      openThemesFolder(): Promise<void>;
      listCustomThemes(): Promise<ThemeMeta[]>;
      getThemesDirSync(): Promise<string>;
    };
  }
}

export {};
