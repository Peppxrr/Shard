// Real Chromium layout is required: DOM mocks cannot reproduce filter-created
// containing blocks or native top-layer dismissal/focus behavior.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import electron from "electron";

const app = fileURLToPath(new URL("../", import.meta.url));
const fixture = path.resolve(app, "../tmp/popover-tests");
await mkdir(fixture, { recursive: true });
await writeFile(path.join(fixture, "index.html"), '<div id="root"></div><script type="module" src="/entry.tsx"></script>');
await writeFile(path.join(fixture, "entry.tsx"), `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ShardSelect, ContextMenu, Modal} from '../../app/src/renderer/components/ui';
import '../../app/src/renderer/styles.css';
function Fixture() {
  const [value,setValue] = React.useState('0');
  const [menu,setMenu] = React.useState(null);
  const [count,setCount] = React.useState(4);
  const [modal,setModal] = React.useState(false);
  window.fixture = {context:setMenu, count:setCount, modal:setModal};
  return <div id="host" data-shard-page="settings" style={{position:'absolute',left:160,top:100,width:500,height:500,overflow:'hidden'}}>
    <div id="anchor" style={{position:'absolute',left:170,top:160}}>
      <ShardSelect ariaLabel="First" value={value} onChange={setValue} options={Array.from({length:count},(_,i)=>({value:String(i),label:'Choice '+i}))}/>
      <ShardSelect ariaLabel="Second" value="a" onChange={()=>{}} options={[{value:'a',label:'Another menu'}]}/>
    </div>
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={()=>setMenu(null)}><button>Context action</button><button>Another action</button></ContextMenu>}
    <Modal open={modal} onClose={()=>setModal(false)} title="Menu inside dialog">
      <ShardSelect ariaLabel="Modal select" value="a" onChange={()=>{}} options={[{value:'a',label:'Dialog choice'}]}/>
    </Modal>
  </div>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);
`);
await build({ root: fixture, configFile: false, logLevel: "warn", plugins: [react()],
  resolve: { alias: { react: path.join(app, "node_modules/react"), "react-dom": path.join(app, "node_modules/react-dom") } },
  base: "./", build: { outDir: "dist", emptyOutDir: true } });
const code = await new Promise((resolve, reject) => {
  const child = spawn(electron, [path.join(app, "scripts/test-ui-popovers.cjs"), fixture], { stdio: "inherit", windowsHide: true });
  child.once("error", reject);
  child.once("exit", resolve);
});
process.exitCode = code ?? 1;
