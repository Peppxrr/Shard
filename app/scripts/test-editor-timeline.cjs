const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const fixture = process.argv[2];
app.setPath("userData", path.join(fixture, "profile"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const viewportWidth = 1100;
const viewportHeight = 600;
let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, frame: false, width: viewportWidth, height: viewportHeight,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.setContentSize(viewportWidth, viewportHeight);
  await win.loadFile(path.join(fixture, "dist/index.html"));
  const js = source => win.webContents.executeJavaScript(source);
  const until = async source => {
    for (let n = 0; n < 100; n++) { if (await js(source)) return; await wait(20); }
    throw new Error("Timed out: " + source + " " + JSON.stringify(await js("({width:innerWidth,height:innerHeight,scale:devicePixelRatio})")));
  };
  await until("!!window.fixture && !!document.querySelector('[data-shard-slot=timeline-export-range]')");
  await until(`innerWidth===${viewportWidth} && innerHeight===${viewportHeight}`);
  await js("document.fonts.ready.then(() => true)");
  // ResizeObserver replaces the timeline's initial fallback width after mount.
  // Pointer coordinates must be measured from the settled scale, including on
  // hosted desktops whose native window dimensions differ from local ones.
  const readyGeometry = async () => {
    await until("(()=>{const host=document.querySelector('.timeline__scroll');const ruler=document.querySelector('.timeline__ruler');return host && ruler && Math.abs(ruler.getBoundingClientRect().width-(host.clientWidth-128))<0.5})()");
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  };
  await readyGeometry();
  const starts = () => js("[window.fixture.state.videoClips[0].timelineStart,...window.fixture.state.audioTracks.map(t=>t.clips[0].timelineStart)]");
  const near = (actual, expected) => actual.forEach((value, i) => assert(Math.abs(value - expected[i]) < 0.09, `${actual} expected ${expected}`));
  const drag = async (seconds, modifiers = [], track = "video", modifierChange = null) => {
    await readyGeometry();
    const box = await js(`(()=>{const clip=document.querySelector('[data-clip-track="${track}"]'); const ruler=document.querySelector('.timeline__ruler').getBoundingClientRect(); const r=clip.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,px:ruler.width/66}})()`);
    const from = {x:Math.round(box.x), y:Math.round(box.y)};
    const to = {x:Math.round(box.x + seconds * box.px), y:from.y};
    win.webContents.sendInputEvent({type:"mouseDown",button:"left",clickCount:1,...from,modifiers});
    await wait(30);
    win.webContents.sendInputEvent({type:"mouseMove",...to,modifiers:["leftButtonDown",...modifiers]});
    await wait(40);
    if (modifierChange) {
      win.webContents.sendInputEvent({type:"keyDown",keyCode:modifierChange,modifiers:[modifierChange.toLowerCase()]});
      await wait(40);
      modifiers = [modifierChange.toLowerCase()];
    }
    win.webContents.sendInputEvent({type:"mouseUp",button:"left",clickCount:1,...to,modifiers});
    await wait(40);
  };
  await drag(5);
  near(await starts(), [15,17,15]);
  await drag(3, ["alt"]);
  near(await starts(), [18,17,15]);
  // Releasing a modifier never rewrites offsets from a previous edit.
  await drag(2);
  near(await starts(), [20,19,17]);
  await js("window.fixture.reset()"); await wait(40);
  await drag(4.7);
  near(await starts(), [15,17,15]); // video end snaps onto the playhead at 35.
  await js("window.fixture.reset()"); await wait(40);
  await drag(4.7, ["alt"]);
  near(await starts(), [14.7,12,10]);
  await js("window.fixture.reset()"); await wait(40);
  await drag(4.7, [], "video", "Alt");
  near(await starts(), [14.7,12,10]); // mid-gesture Alt recomputes from the original positions.
  await js("document.querySelector('[aria-label=\"Expand audio tracks\"]').click()");
  await until("document.querySelectorAll('[data-shard-component=audio-clip]').length===2");
  await drag(2, ["alt"], "1");
  near(await starts(), [14.7,14,10]);
  assert.equal(await js("document.querySelectorAll('[data-linked-selected=true]').length"), 2, "linked peers share a subtle selection highlight");
  await js("window.fixture.playhead(20)"); await wait(30);
  await js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Split').click()"); await wait(40);
  assert.deepEqual(await js("[window.fixture.state.videoClips.length,...window.fixture.state.audioTracks.map(t=>t.clips.length)]"), [2,2,2]);
  const range = await js("(()=>{const bar=document.querySelector('[data-shard-slot=timeline-export-range]');return {left:parseFloat(bar.style.left),width:parseFloat(bar.style.width),px:document.querySelector('.timeline__ruler').getBoundingClientRect().width/66}})()");
  assert(Math.abs(range.left / range.px - 10) < 0.05);
  assert(Math.abs(range.width / range.px - 24.7) < 0.09);
  const trim = async (edge, seconds, modifiers=[]) => {
    await readyGeometry();
    const box = await js(`(()=>{const handle=document.querySelector('[data-clip-track=video] [data-trim-edge=${edge}]').getBoundingClientRect(); return {x:handle.x+handle.width/2,y:handle.y+handle.height/2,px:document.querySelector('.timeline__ruler').getBoundingClientRect().width/66}})()`);
    const from = {x:Math.round(box.x),y:Math.round(box.y)};
    const to = {x:Math.round(box.x + seconds*box.px),y:from.y};
    win.webContents.sendInputEvent({type:"mouseDown",button:"left",clickCount:1,...from,modifiers}); await wait(30);
    win.webContents.sendInputEvent({type:"mouseMove",...to,modifiers:["leftButtonDown",...modifiers]}); await wait(30);
    win.webContents.sendInputEvent({type:"mouseUp",button:"left",clickCount:1,...to,modifiers}); await wait(30);
  };
  await js("window.fixture.soft();window.fixture.playhead(40)"); await wait(40);
  await trim("start", 8, ["shift"]);
  near(await starts(), [8,8,8]);
  await trim("start", -5, ["shift"]);
  near(await starts(), [3,5,3]);
  await trim("end", -18, ["alt"]);
  near(await js("[window.fixture.state.videoClips[0],...window.fixture.state.audioTracks.map(t=>t.clips[0])].map(c=>c.timelineStart+c.sourceEnd-c.sourceStart)"), [12,15,30]);
  assert.equal(await js("document.querySelector('[data-shard-slot=timeline-export-origin]')"), null);
  for (const theme of ["default", "oled", "midnight"]) {
    await js(`window.fixture.theme('${theme}')`); await wait(40);
    const style = await js("(()=>{const s=getComputedStyle(document.querySelector('[data-shard-slot=timeline-export-range]'));return {color:s.backgroundColor,height:parseFloat(s.height)}})()");
    assert.notEqual(style.color, "rgba(0, 0, 0, 0)");
    assert(style.height >= 3);
  }
  if (process.env.SHARD_EDITOR_SCREENSHOT) await fs.writeFile(process.env.SHARD_EDITOR_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  console.log("PASS timeline pointer interactions: linked/Alt moves, reversible video/audio trims, Alt trim, snapping, split groups, export range and three themes");
  win.destroy(); app.quit();
}).catch(error => { console.error(error); win?.destroy(); app.exit(1); });
