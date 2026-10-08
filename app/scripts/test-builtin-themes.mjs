// Audit the current React screens in Chromium, with isolated read-only IPC fixtures.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import electron from "electron";

const app = fileURLToPath(new URL("../", import.meta.url));
const tempRoot = path.resolve(app, "../tmp");
await mkdir(tempRoot, { recursive: true });
const fixture = await mkdtemp(path.join(tempRoot, "builtin-theme-tests-"));
let passed = false;
try {
  await writeFile(path.join(fixture, "index.html"), '<div id="root"></div><script type="module" src="/entry.tsx"></script>');
  await writeFile(path.join(fixture, "entry.tsx"), `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from '../../app/src/renderer/App';
import {DevConsole} from '../../app/src/renderer/DevConsole';
import {Editor} from '../../app/src/renderer/components/Editor';
import {DEFAULT_SETTINGS} from '../../app/src/shared/contracts';
import {applyTheme, getBuiltinThemes} from '../../app/src/renderer/themeManager';
import '../../app/src/renderer/styles.css';
import '../../app/src/renderer/dev-console.css';
const settings = structuredClone(DEFAULT_SETTINGS);
settings.app.clipSound = false;
const clip = {id:'fixture',path:'',thumb:'',game:'A long game name for the theme audit',createdAt:Date.now(),durationMs:60000,sizeBytes:12000000,width:1920,height:1080,fps:60,protected:0,source:'clip'};
const state = {...settings,capture:{...settings.capture,subject:{kind:'game',name:clip.game}},ring:{active:true,secondsBuffered:120,mbUsed:24},recording:{active:false,path:''}};
const storage = {totalBytes:3e9,managedBytes:2e9,keptBytes:1e9,limitBytes:1e9,reason:'needs-review',reclaimCount:3,reclaimBytes:1e9};
const exportListeners = new Set();
window.shard = new Proxy({
  windowControlsSupported:true,
  regionalLocale:'en-US',
  getSettings:async()=>settings,
  listClips:async()=>[clip,{...clip,id:'recording',source:'recording',protected:1}],
  version:async()=> '0.1.9',
  getDefaultClipsFolder:async()=> 'C:/Clips',
  getClipSoundDefaultPath:async()=>'',
  getStorageStatus:async()=>storage,
  getUpdateState:async()=>({status:'up-to-date',currentVersion:'0.1.9'}),
  getDevConsoleHistory:async()=>[{id:1,t:Date.now(),level:'core',severity:'info',text:'Capture initialized'}],
  probeTracks:async()=>[],
  generateTimelineFrames:async()=>[],
  onExport:callback=>{exportListeners.add(callback);return()=>exportListeners.delete(callback)},
  invoke:async(method)=>method==='state.get'?state:[],
}, {get:(target,key)=> key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
window.shardThemes = {listCustom:async()=>[],readCustomCss:async()=>null,onChanged:()=>()=>{}};
function Fixture() {
  const [screen,setScreen] = React.useState('app');
  window.fixture = {theme:applyTheme,themes:getBuiltinThemes().map(t=>t.id),screen:setScreen,
    export:()=>exportListeners.forEach(callback=>callback({clipId:clip.id,phase:'Encoding',percent:40}))};
  return screen==='console'?<DevConsole/>:screen==='editor'?<Editor clip={clip} onClose={()=>setScreen('app')} onExport={()=>{}}/>:<App/>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
  await build({ root: fixture, configFile: false, logLevel: "warn", plugins: [react()],
    resolve: { alias: { react: path.join(app, "node_modules/react"), "react-dom": path.join(app, "node_modules/react-dom") } },
    base: "./", build: { outDir: "dist", emptyOutDir: true } });
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(app, "scripts/test-builtin-themes.cjs"), fixture], { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  process.exitCode = code ?? 1;
  passed = process.exitCode === 0;
} finally {
  if (passed) await rm(fixture, { recursive: true, force: true });
  else console.error('Built-in theme fixture kept for diagnostics: ' + fixture);
}
