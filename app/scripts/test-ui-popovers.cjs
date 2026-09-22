const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const fixture = process.argv[2];
app.setPath("userData", path.join(fixture, "profile"));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1000, height: 760,
    // Use Chromium's normal compositor path. Offscreen rendering has different
    // top-layer/fixed-position geometry around transformed ancestors.
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", ({ level, message }) => { if (level === "error" || level === 3) { errors.push(message); console.error(message); } });
  await win.loadFile(path.join(fixture, "dist/index.html"));
  const js = source => win.webContents.executeJavaScript(source).catch(error => { throw new Error(source, { cause: error }); });
  const until = async source => {
    for (let n = 0; n < 50; n++) { if (await js(source)) return; await wait(20); }
    console.error(await js("document.body.innerHTML")); throw new Error("Timed out: " + source);
  };
  await until("!!window.fixture");
  await wait(400); // Let the initial native window resize/paint settle.
  const closed = () => until("!document.querySelector('[popover]')");
  const open = async (name = "First") => {
    await js(`document.querySelector('[aria-label="${name}"]').focus();document.querySelector('[aria-label="${name}"]').click()`);
    await until("!!document.querySelector(':popover-open')");
    await wait(60);
  };
  const bounds = () => js(`(() => {
    const button = document.querySelector('[data-shard-component="select"][aria-expanded="true"]');
    const menu = document.querySelector(':popover-open');
    return {button:button?.getBoundingClientRect().toJSON(), menu:menu.getBoundingClientRect().toJSON(), width:innerWidth, height:innerHeight,
      inherited:getComputedStyle(menu).getPropertyValue('--fixture'), scoped:getComputedStyle(menu).borderTopColor};
  })()`);
  const inViewport = ({ menu, width, height }) => {
    assert.ok(menu.left >= 7.5 && menu.top >= 7.5 && menu.right <= width - 7.5 && menu.bottom <= height - 7.5, JSON.stringify({ menu, width, height }));
  };
  await js(`const style=document.createElement('style');style.textContent='[data-shard-page="settings"] {--fixture: inherited} [data-shard-page="settings"] [data-shard-component="select-menu"] {border-color:rgb(10, 20, 30)}';document.head.append(style)`);
  for (const effect of ["backdrop-filter:blur(14px)", "filter:brightness(.95)", "transform:translate(30px,20px)", "contain:paint", "backdrop-filter:blur(10px);transform:scale(.9);border-radius:30px"]) {
    await js(`document.getElementById('host').style.cssText='position:absolute;left:160px;top:100px;width:500px;height:500px;overflow:hidden;${effect}'`);
    await open();
    const result = await bounds();
    inViewport(result);
    assert.ok(Math.abs(result.menu.left - result.button.left) < 1, effect + ": horizontal anchor " + JSON.stringify(result));
    assert.ok(Math.abs(result.menu.top - result.button.bottom - 4) < 1, effect + ": vertical anchor " + JSON.stringify(result));
    assert.equal(result.inherited.trim(), "inherited");
    assert.equal(result.scoped, "rgb(10, 20, 30)");
    assert.equal(await js(`document.elementFromPoint(${result.menu.left + 20},${result.menu.top + 15}).closest('[popover]') !== null`), true);
    await js("document.querySelector('[role=option]').click()"); await closed();
    assert.equal(await js("document.activeElement.getAttribute('aria-label')"), "First");
  }
  // Body filters also break a plain body portal; the top layer must escape them.
  await js("document.body.style.backdropFilter='blur(2px)';document.getElementById('host').style.transform='none'");
  await open(); inViewport(await bounds());
  await open("Second");
  await until("document.querySelectorAll('[popover]').length===1");
  assert.equal(await js("document.querySelector('[aria-label=First]').getAttribute('aria-expanded')"), "false");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await closed();
  assert.equal(await js("document.activeElement.getAttribute('aria-label')"), "Second");
  // Fit a tall, scrollable list above a trigger near the bottom. Dynamic
  // option sources may update while open, but exact pixel re-anchoring after
  // an artificial list collapse is not a release invariant; Chromium can
  // commit top-layer intrinsic sizing independently of hidden-window layout.
  await js("document.getElementById('host').style.cssText='position:fixed;inset:0;backdrop-filter:blur(10px);overflow:hidden';document.getElementById('anchor').style.cssText='position:absolute;right:0;bottom:10px';window.fixture.count(30)");
  await open();
  const above = await bounds(); inViewport(above);
  assert.ok(Math.abs(above.menu.bottom - above.button.top + 4) < 1, JSON.stringify(above));
  await js("document.querySelector(':popover-open').scrollTop=120"); await wait(80);
  assert.equal(await js("document.querySelector(':popover-open').scrollTop > 0"), true);
  await js("document.getElementById('host').dispatchEvent(new Event('scroll'))"); await closed();
  await open();
  win.webContents.sendInputEvent({ type: "mouseDown", x: 30, y: 30, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: 30, y: 30, button: "left", clickCount: 1 });
  await closed();
  // A context menu inside a clipped, filtered panel remains on-screen and hittable.
  await js("window.fixture.context({x:innerWidth-2,y:innerHeight-2})");
  await until("!!document.querySelector(':popover-open')");
  inViewport(await bounds());
  // Native window resizes intentionally dismiss open menus. Exact geometry
  // immediately after resizing a hidden Electron window is compositor timing,
  // not a Shard release invariant; Escape still verifies clean dismissal here.
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await closed();
  // Escape closes only the dropdown, whether focus is on its trigger or option.
  await js("window.fixture.modal(true)");
  await until("!!document.querySelector('[data-shard-component=modal]')");
  for (const focusOption of [false, true]) {
    await open("Modal select");
    if (focusOption) await js("document.querySelector('[role=option]').focus()");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await closed();
    assert.equal(await js("!!document.querySelector('[data-shard-component=modal]')"), true);
  }
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await until("!document.querySelector('[data-shard-component=modal]')");
  assert.deepEqual(errors, []);
  console.log("PASS Chromium menus: filtered/transformed/clipped ancestors, inherited themes, viewport fitting, live sizing, selection, focus, Escape, outside click, scrolling and resize");
  win.destroy(); app.quit();
}).catch(error => { console.error(error); win?.destroy(); app.exit(1); });
