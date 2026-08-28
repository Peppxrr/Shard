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
      listCustom(): Promise<ThemeMeta[]>;
      readTheme(id: string): Promise<{ css: string; dir: string } | null>;
      readCustomCss(): Promise<{ css: string; dir: string } | null>;
      getThemesDir(): Promise<string>;
      openThemesFolder(): Promise<void>;
      listCustomThemes(): Promise<ThemeMeta[]>;
      getThemesDirSync(): Promise<string>;
    };
  }
}

export {};
