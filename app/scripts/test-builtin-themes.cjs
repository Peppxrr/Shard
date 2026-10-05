const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const fixture = process.argv[2];
app.setPath("userData", path.join(fixture, "profile"));
// This fixture audits CSS and layout; software compositing also permits
// screenshots on machines whose GPU driver cannot service capturePage.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, frame: false, width: 1440, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  win.webContents.on("console-message", ({ level, message }) => {
    if (level === "error" || level === 3) errors.push(message);
  });
  await win.loadFile(path.join(fixture, "dist/index.html"));
  const js = source => win.webContents.executeJavaScript(source);
  const until = async source => {
    for (let n = 0; n < 100; n++) { if (await js(source)) return; await wait(20); }
    throw new Error("Timed out: " + source + " " + JSON.stringify({viewport:await js("({width:innerWidth,height:innerHeight,scale:devicePixelRatio})"),bounds:win.getContentBounds()}));
  };
  await until("!!window.fixture && !!document.querySelector('[data-shard-page=capture]')");
  const results = [];
  const check = async label => {
    await wait(100);
    assert.equal(await js("innerWidth"), Number(label.split('-')[1]), label + " viewport width");
    assert.equal(await js("document.documentElement.dataset.theme"), label.split('-')[0], label + " active theme");
    const overflow = await js(`Array.from(document.querySelectorAll('[data-shard-page], [data-shard-slot=content]')).map(el=>({page:el.dataset.shardPage||'content',width:el.clientWidth,scroll:el.scrollWidth})).filter(el=>el.scroll>el.width+1)`);
    assert.deepEqual(overflow, [], label + " horizontal overflow");
    results.push(label);
    if (process.env.SHARD_THEME_SCREENSHOTS) {
      const dir = process.env.SHARD_THEME_SCREENSHOTS;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, label + ".png"), (await win.webContents.capturePage()).toPNG());
    }
  };
  const themes = await js("window.fixture.themes");
  for (const width of [1440, 640]) {
    win.setContentSize(width, 1000);
    await until("innerWidth===" + width);
    for (const theme of themes) {
      await js(`window.fixture.screen('app')`);
      await until("!!document.querySelector('[data-shard-nav=capture]')");
      await js(`window.fixture.theme('${theme}')`);
      await js("document.querySelector('[data-shard-nav=capture]').click()");
      await until("!!document.querySelector('[data-shard-slot=capture-primary]')");
      const surfaces = await js(`(()=>{const panel=getComputedStyle(document.querySelector('[data-shard-slot=capture-primary]')); const hero=getComputedStyle(document.querySelector('[data-shard-component=capture-hero]')); return {radius:parseFloat(panel.borderTopLeftRadius),heroColor:hero.backgroundColor,heroImage:hero.backgroundImage}})()`);
      assert.ok(surfaces.radius > 0, theme + " rounded capture panel");
      assert.equal(surfaces.heroColor, "rgba(0, 0, 0, 0)", theme + " inner capture surface");
      assert.equal(surfaces.heroImage, "none", theme + " no rectangular inner gradient");
      await check(theme + "-" + width + "-capture");
      for (const page of ["library", "games", "settings"]) {
        await js(`document.querySelector('[data-shard-nav=${page}]').click()`);
        await until(`!!document.querySelector('[data-shard-page=${page}]')`);
        await check(theme + "-" + width + "-" + page);
        if (page === "library") {
          await js("document.querySelector('[data-shard-slot=clip-thumbnail]').click()");
          await until("!!document.querySelector('[data-shard-component=clip-viewer]')");
          await check(theme + "-" + width + "-viewer");
          await js("document.querySelector('[aria-label=\"Playback speed\"]').click()");
          await until("!!document.querySelector(':popover-open')");
          await check(theme + "-" + width + "-menu");
          await js("document.querySelector('[role=option]').click();document.querySelector('[data-shard-component=modal] [aria-label=Close]').click()");
          await until("!document.querySelector('[data-shard-component=modal]')");
        }
      }
      for (const [index, section] of ["appearance", "capture", "video", "export", "audio", "hotkeys", "storage", "app"].entries()) {
        await js(`document.querySelectorAll('.settings__nav-item')[${index}].click()`);
        await until(`!!document.querySelector('[data-shard-page=settings][data-shard-section=${section}]')`);
        await check(theme + "-" + width + "-settings-" + section);
      }
      await js("window.fixture.export()");
      await until("!!document.querySelector('.exportbar')");
      // A surface override must reach the export overlay, just as it does cards.
      await js("document.documentElement.style.setProperty('--bg-3', 'rgb(1, 2, 3)')");
      assert.ok((await js("getComputedStyle(document.querySelector('.exportbar')).backgroundImage")).includes("rgb(1, 2, 3)"), theme + " export surface token");
      await js("document.documentElement.style.removeProperty('--bg-3')");
      await check(theme + "-" + width + "-export");
      await js("window.fixture.screen('editor')");
      await until("!!document.querySelector('[data-shard-component=timeline]')");
      await check(theme + "-" + width + "-editor");
      await js("window.fixture.screen('console')");
      await until("!!document.querySelector('[data-shard-component=developer-console]')");
      await check(theme + "-" + width + "-console");
    }
  }
  assert.deepEqual(errors, []);
  console.log("PASS built-in themes: " + themes.join(", ") + "; " + results.length + " screen/width checks, capture corners and horizontal overflow");
  win.destroy(); app.quit();
}).catch(error => { console.error(error); win?.destroy(); app.exit(1); });
