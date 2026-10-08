const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const fixture = process.argv[2];
app.setPath("userData", path.join(fixture, "profile"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1200, height: 850,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  await win.loadFile(path.join(fixture, "dist/index.html"));
  const js = source => win.webContents.executeJavaScript(source);
  const until = async source => {
    for (let n = 0; n < 150; n++) { if (await js(source)) return; await wait(20); }
    throw new Error("Timed out: " + source);
  };
  await until("document.querySelector('video')?.readyState>=2 && document.querySelector('[data-clip-track=video]') && !document.querySelector('[data-shard-slot=player-seek]').disabled");
  await wait(100);
  const snapshot = () => js(`(()=>{
    const seek=document.querySelector('[data-shard-slot=player-seek]');
    const range=document.querySelector('[data-shard-slot=timeline-export-range]');
    const ruler=document.querySelector('.timeline__ruler').getBoundingClientRect();
    const px=parseFloat(range.style.width)/Number(seek.max);
    return {elapsed:Number(seek.value),duration:Number(seek.max),source:document.querySelector('video').currentTime,
      start:parseFloat(range.style.left)/px,head:(document.querySelector('.timeline__playhead').getBoundingClientRect().x-ruler.x)/px,
      label:document.querySelector('[data-shard-slot=player-time]').textContent};
  })()`);
  const near = (value, expected, tolerance = 0.09) => assert(Math.abs(value - expected) < tolerance, `${value} expected ${expected}`);
  const mouse = async (type, point, modifiers = []) => {
    win.webContents.sendInputEvent({type,...point,...(type === "mouseMove" ? {} : {button:"left",clickCount:1}),modifiers});
    await wait(35);
  };
  const click = async selector => {
    const point = await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    await mouse("mouseDown", point); await mouse("mouseUp", point);
  };
  const drag = async (selector, seconds) => {
    const box = await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();const range=document.querySelector('[data-shard-slot=timeline-export-range]');return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),px:parseFloat(range.style.width)/Number(document.querySelector('[data-shard-slot=player-seek]').max)}})()`);
    const from={x:box.x,y:box.y},to={x:Math.round(box.x+seconds*box.px),y:box.y};
    await mouse("mouseDown",from,["alt"]);
    await mouse("mouseMove",to,["leftButtonDown","alt"]);
    await mouse("mouseUp",to,["alt"]);
    await wait(100);
  };
  await click('[data-clip-track="video"]');
  await until("!!document.querySelector('[data-trim-edge=start]')");
  const beforeTrim = await js("(()=>{const r=document.querySelector('.timeline__ruler').getBoundingClientRect();return{x:Math.round(r.x+2),y:Math.round(r.y+r.height/2)}})()");
  await mouse("mouseDown",beforeTrim); await mouse("mouseUp",beforeTrim);
  await drag('[data-trim-edge="start"]', 2);
  // Trimming the start leaves free timeline space but previews source 2s as export 0.
  let current=await snapshot();
  near(current.start,2); near(current.elapsed,0); near(current.source,2); near(current.head,2);
  near(current.duration,4);
  assert.match(current.label,/0:00\.000\s*\//);
  await drag('[data-clip-track="video"]',1);
  current=await snapshot();
  near(current.start,3); near(current.elapsed,0); near(current.source,2); near(current.head,3);
  assert.equal(await js("document.querySelector('[data-shard-slot=timeline-export-origin]')"),null);
  // Player range input uses elapsed export time, then maps back to absolute timeline time.
  const seekPoint = await js("(()=>{const r=document.querySelector('[data-shard-slot=player-seek]').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
  await mouse("mouseDown",seekPoint); await mouse("mouseUp",seekPoint);
  await until("!document.querySelector('video').seeking");
  current=await snapshot();
  near(current.elapsed,2,0.14); near(current.head,current.start+current.elapsed); near(current.source,2+current.elapsed);
  // Inspect leading free space through the ruler, then play from the export origin.
  const rulerPoint = await js("(()=>{const r=document.querySelector('.timeline__ruler').getBoundingClientRect();const range=document.querySelector('[data-shard-slot=timeline-export-range]');const px=parseFloat(range.style.width)/Number(document.querySelector('[data-shard-slot=player-seek]').max);return{x:Math.round(r.x+px),y:Math.round(r.y+r.height/2)}})()");
  await mouse("mouseDown",rulerPoint); await mouse("mouseUp",rulerPoint);
  current=await snapshot(); near(current.head,1); near(current.elapsed,0);
  await click('[aria-label="Play (Space)"]');
  await until("!!document.querySelector('[aria-label=\"Pause (Space)\"]') && document.querySelector('video').currentTime>2.08");
  current=await snapshot();
  assert(current.head>=2.9 && current.head<4.5,JSON.stringify(current));
  assert(current.elapsed>0 && current.elapsed<1.5,JSON.stringify(current));
  near(current.source,2+current.elapsed,0.15);
  await click('[aria-label="Pause (Space)"]');
  console.log("PASS full Editor preview clock: native trim/move, export-relative seek, source seek, free timeline scrubbing and playback origin");
  win.destroy(); app.quit();
}).catch(error => { console.error(error); win?.destroy(); app.exit(1); });
