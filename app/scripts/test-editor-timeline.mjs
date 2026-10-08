import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import electron from "electron";

const app = process.cwd();
const temporary = path.resolve(app, "../tmp");
await mkdir(temporary, { recursive: true });
const fixture = await mkdtemp(path.join(temporary, "editor-timeline-test-"));
let passed = false;
try {
  await writeFile(path.join(fixture, "index.html"), '<div id="root"></div><script type="module" src="./fixture.tsx"></script>');
  await writeFile(path.join(fixture, "fixture.tsx"), `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Timeline} from '../../app/src/renderer/editor/Timeline';
import * as model from '../../app/src/renderer/editor/model';
import {applyTheme} from '../../app/src/renderer/themeManager';
import '../../app/src/renderer/styles.css';
const tracks = [1,2].map((streamIndex,i)=>({streamIndex,audioIndex:i,name:i?'Microphone':'Game',kind:i?'input':'output',channels:2,sampleRate:48000,codec:'aac'}));
function initial() {
  let state = model.createEditorState(60, tracks);
  state = model.trimClip(state,'video','clip-0','end',20);
  state = model.moveLinkedClips(state,'video','clip-0',10);
  state = model.separateAudio(state);
  state = model.moveLinkedClips(state,1,state.audioTracks[0].clips[0].id,12,true);
  return state;
}
function Fixture() {
  const [state,setState] = React.useState(initial);
  const [playhead,setPlayhead] = React.useState(35);
  const [zoom,setZoom] = React.useState(1);
  window.fixture = {state,reset:()=>setState(initial()),playhead:setPlayhead,theme:applyTheme,soft:()=>{
    let next=model.separateAudio(model.createEditorState(60,tracks));
    next=model.trimClip(next,1,next.audioTracks[0].clips[0].id,'start',5);
    next=model.trimClip(next,1,next.audioTracks[0].clips[0].id,'end',15);
    next=model.trimClip(next,'video','clip-0','end',30);
    setState(next);
  }};
  return <div style={{padding:24}}><Timeline state={state} waveforms={new Map()} filmstrip={[]} playhead={playhead} zoom={zoom} canUndo={false} canRedo={false}
    onZoomChange={setZoom} onScrub={setPlayhead} onScrubEnd={setPlayhead} onSelect={selection=>setState(current=>({...current,selection}))}
    onCommit={change=>setState(change)} onUndo={()=>{}} onRedo={()=>{}} onTrackChange={()=>{}} onDeleteAudioTrack={()=>{}}/></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
  await build({ root: fixture, configFile: false, logLevel: "warn", plugins: [react()],
    resolve: { alias: { react: path.join(app, "node_modules/react"), "react-dom": path.join(app, "node_modules/react-dom") } },
    base: "./", build: { outDir: "dist", emptyOutDir: true } });
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(app, "scripts/test-editor-timeline.cjs"), fixture], { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  process.exitCode = code ?? 1;
  passed = process.exitCode === 0;
} finally {
  if (passed) await rm(fixture, { recursive: true, force: true });
  else console.error("Editor timeline fixture retained: " + fixture);
}
