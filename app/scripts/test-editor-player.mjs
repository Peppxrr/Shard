import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import electron from "electron";
import { existsSync } from "node:fs";

const app = process.cwd();
const temporary = path.resolve(app, "../tmp");
await mkdir(temporary, { recursive: true });
const fixture = await mkdtemp(path.join(temporary, "editor-player-test-"));
let passed = false;
try {
  const source = path.join(fixture, "source.mp4");
  const staged = path.join(app, "resources/core-bin/ffmpeg.exe");
  const ffmpeg = existsSync(staged) ? staged : path.resolve(app, "../vendor/ffmpeg/bin/ffmpeg.exe");
  const media = spawnSync(ffmpeg, ["-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=6", "-an",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", source], { encoding: "utf8", windowsHide: true });
  if (media.status !== 0) throw new Error(media.stderr || "Player fixture media generation failed");
  await writeFile(path.join(fixture, "index.html"), '<div id="root"></div><script type="module" src="./fixture.tsx"></script>');
  await writeFile(path.join(fixture, "fixture.tsx"), `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Editor} from '../../app/src/renderer/components/Editor';
import '../../app/src/renderer/styles.css';
window.shard = {probeTracks:async()=>[],onExport:()=>()=>{},cancelEditorPreparation:()=>{},
  onTimelineFrames:()=>()=>{},generateTimelineFrames:async()=>[],cancelTimelineFrames:()=>{}};
const clip={id:'player-fixture',path:${JSON.stringify(source)},durationMs:6000,width:320,height:180,fps:30};
createRoot(document.getElementById('root')).render(<Editor clip={clip} onClose={()=>{}} onExport={()=>{}} onOpenExport={()=>{}}/>);
`);
  await build({ root: fixture, configFile: false, logLevel: "warn", plugins: [react()],
    resolve: { alias: { react: path.join(app, "node_modules/react"), "react-dom": path.join(app, "node_modules/react-dom") } },
    base: "./", build: { outDir: "dist", emptyOutDir: true } });
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(app, "scripts/test-editor-player.cjs"), fixture], { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  process.exitCode = code ?? 1;
  passed = process.exitCode === 0;
} finally {
  if (passed) await rm(fixture, { recursive: true, force: true });
  else console.error("Editor player fixture retained: " + fixture);
}
