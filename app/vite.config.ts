import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Renderer build only; the Electron main/preload are compiled with tsc
// (tsconfig.main.json) into dist/main.
export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname),
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Installer output can contain locked runtime DLLs. It is not source code
    // and must not trigger reloads or compete with electron-builder's renames.
    watch: { ignored: /[\\/]release(?:[\\/]|$)/ },
  },
});
