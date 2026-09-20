import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const cache = new Map();
function load(file, globals = {}) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { exports, Buffer, URL, console, setTimeout, clearTimeout, ...globals, require: name => {
    if (name.endsWith("?raw")) return readFileSync(path.resolve(path.dirname(file), name.slice(0, -4)), "utf8");
    return name.startsWith(".") ? load(path.resolve(path.dirname(file), `${name}.ts`), globals) : require(name);
  } }, { filename: file });
  cache.set(file, exports);
  return exports;
}
const root = path.resolve(import.meta.dirname, "../..");
const api = load(path.join(root, "app/src/shared/themes.ts"));
const { ThemeStore } = load(path.join(root, "app/src/main/themes.ts"));
const example = JSON.parse(await readFile(path.join(root, "examples/themes/afterglow/theme.json"), "utf8"));
const manifest = api.parseThemeManifest(example, "0.1.5");
assert.throws(() => api.parseThemeManifest(example, "0.1.4"), /Requires Shard/);
assert.throws(() => api.parseThemeManifest({ schema: 2 }, "0.1.5"), /Unsupported/);
for (const bad of ["../outside.css", "/outside.css", "C:\\outside.css", "https://example.org/theme.css", "foo.js", "foo.css?x"])
  assert.throws(() => api.parseThemeManifest({ schema: 1, styles: [bad] }, "0.1.5"), /Invalid/);
assert.throws(() => api.parseThemeManifest({ schema: 1, settings: { accent: { type: "color", name: "Accent", default: "red; } body { display:none" } } }, "0.1.5"), /hex/);
assert.throws(() => api.parseThemeManifest({ schema: 1, settings: { size: { type: "range", name: "Size", min: 2, max: 1, default: 1 } } }, "0.1.5"), /range/);
const values = api.normalizeThemeValues(manifest.settings, { accent: "url(https://bad)", "text-size": 100, navigation: "invalid", compact: true, injected: "bad" });
assert.equal(values.accent, "#85dcc4"); assert.equal(values["text-size"], 18); assert.equal(values.navigation, "sidebar"); assert.equal(values.compact, true); assert.equal(values.injected, undefined);
assert.match(api.themeOptionCss(manifest.settings, values), /--theme-text-size: 18px/);
assert.match(api.themeOptionCss(manifest.settings, values), /--theme-compact: 1/);
const base = "shard-theme://local/r123/With%20spaces/theme.css";
const css = api.rewriteThemeUrls('/* url(no.png) */ @import "./sub/style.css"; :root {--icon-capture:url("./a (b)#x.svg");} p{content:"url(no.png)";background:url(data:image/svg+xml;base64,abc);mask:url(#mask);src:url(./my\\20 font.woff2)}', base);
assert.match(css, /@import "shard-theme:\/\/local\/r123\/With%20spaces\/sub\/style.css"/);
assert.match(css, /a%20\(b\)#x.svg/); assert.match(css, /my%20font.woff2/);
assert.match(css, /\/\* url\(no.png\) \*\//); assert.match(css, /content:"url\(no.png\)"/);
assert.match(css, /url\("#mask"\)/);

const temp = await mkdtemp(path.join(tmpdir(), "shard-themes-"));
let store;
try {
  const dir = path.join(temp, "Themes"); await mkdir(dir);
  const add = async (folder, files) => {
    await mkdir(path.join(dir, folder), { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, folder, name), text);
  };
  await add("Old Theme", { "theme.css": "/** @name Old reliable */\n:root { --accent:#abcdef }" });
  await add("Afterglow", { "theme.json": JSON.stringify(example), "theme.css": ':root{--icon-capture:url("./orbit.svg")}', "pages.css": ".card{}", "orbit.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>' });
  await add("old-theme", { "theme.css": "/** @name Exact folder wins */" });
  await add("default", { "theme.css": "body{display:none}" });
  await add("broken", { "theme.json": "{unfinished", "theme.css": "" });
  store = new ThemeStore(dir, "0.1.5");
  const list = await store.list();
  assert.equal(list.filter(t => t.id === "old-theme").length, 1);
  assert.equal(list.find(t => t.id === "old-theme").name, "Exact folder wins", JSON.stringify(list));
  assert.equal(list.some(t => t.id === "default"), false);
  assert.ok(list.find(t => t.id === "broken").error);
  assert.equal((await store.read("old-theme")).meta.name, "Exact folder wins");
  const doc = await store.read("afterglow"); assert.equal(doc.styles.length, 2);
  const resource = await store.resource(doc.styles[0]); assert.match(Buffer.from(resource.data).toString(), /shard-theme:\/\/local\/r\d+\/Afterglow\/orbit.svg/);
  await Promise.all([store.saveValues("afterglow", { compact: true }), store.saveValues("afterglow", { compact: false, accent: "#123456" })]);
  const reopened = new ThemeStore(dir, "0.1.5");
  assert.equal((await reopened.read("afterglow")).values.accent, "#123456");
  assert.equal((await reopened.read("afterglow")).values.compact, false);
  await store.saveValues("afterglow", {}); assert.equal((await store.read("afterglow")).values.accent, "#85dcc4");
  await assert.rejects(store.resource("shard-theme://local/r123/%2e%2e%5coutside.css"));
  await assert.rejects(store.resource("shard-theme://local/r123/Afterglow/theme.json"));
  await assert.rejects(store.resource("shard-theme://remote/r123/Afterglow/theme.css"));
  const outside = path.join(temp, "outside"); await mkdir(outside); await writeFile(path.join(outside, "private.css"), "secret");
  await symlink(outside, path.join(dir, "escape"), "junction");
  await assert.rejects(store.resource("shard-theme://local/r123/escape/private.css"), /leaves/);
  assert.equal(await store.read("../../outside"), null);
  let changes;
  store = new ThemeStore(dir, "0.1.5", () => changes?.resolve());
  await store.startWatching();
  const watched = async mutation => {
    changes = Promise.withResolvers();
    let timer;
    try {
      await mutation();
      await Promise.race([changes.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Watcher missed theme change")), 3000); })]);
    } finally { clearTimeout(timer); }
  };
  await watched(() => writeFile(path.join(dir, "Afterglow", "orbit.svg"), "updated image"));
  assert.notEqual((await store.read("afterglow")).styles[0], doc.styles[0]);
  await watched(() => writeFile(path.join(dir, "Drop In.css"), "/** @name Dropped CSS */ :root { --accent: #112233; }"));
  assert.equal((await store.list()).find(t => t.id === "drop-in").name, "Dropped CSS");
  await watched(() => writeFile(path.join(dir, "Drop In.css"), ":root { --accent: #abcdef; }"));
  assert.match(Buffer.from((await store.resource((await store.read("drop-in")).styles[0])).data).toString(), /#abcdef/);
  await watched(() => add("New folder", { "theme.css": "/** @name New folder theme */" }));
  assert.equal((await store.list()).find(t => t.id === "new-folder").name, "New folder theme");
  await watched(() => writeFile(path.join(dir, "custom.css"), ".card { border-radius: 0; }"));
  assert.equal((await store.list()).some(t => t.id === "custom"), false);
  assert.ok(await store.customCss());
  await watched(() => writeFile(path.join(dir, "old-theme.css"), "/** @name File loses to folder */"));
  assert.equal((await store.read("old-theme")).meta.name, "Exact folder wins");
  await watched(() => rm(path.join(dir, "Drop In.css")));
  assert.equal((await store.list()).some(t => t.id === "drop-in"), false);

} finally { store?.close(); await rm(temp, { recursive: true, force: true }); }

// Renderer transaction tests: late reads and failed sheets cannot replace the
// latest selection or leave mixed old/new CSS or option attributes behind.
class Element {
  attrs = new Map(); dataset = {}; textContent = ""; media = "";
  remove() { const i = head.indexOf(this); if (i >= 0) head.splice(i, 1); }
  setAttribute(k, v) { this.attrs.set(k, v); }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return k === "data-shard-theme-options" && "shardThemeOptions" in this.dataset; }
}
class Link extends Element {}
const head = [], html = new Element();
const document = { documentElement: html, body: new Element(), createElement: tag => tag === "link" ? new Link() : new Element(), head: { append(el) { el.remove(); head.push(el); if (el instanceof Link && el.media === "not all") queueMicrotask(() => el.href.includes("broken") ? el.onerror() : el.onload()); } } };
const events = new EventTarget();
const slow = Promise.withResolvers();
let override = null;
const window = Object.assign(events, { setTimeout, shardThemes: { readTheme: async id => id === "slow" ? slow.promise : { meta: { id, name: id, kind: "custom", settings: manifest.settings }, styles: [`shard-theme://local/r1/${id}/theme.css`], values }, readCustomCss: async () => override, setValues: async () => {}, refresh: async () => {} } });
const manager = load(path.join(root, "app/src/renderer/themeManager.ts"), { window, document, HTMLLinkElement: Link, CustomEvent, Event, localStorage: { setItem() {} } });
await manager.applyTheme("afterglow"); assert.equal(html.attrs.get("data-theme-compact"), "true");
const old = manager.applyTheme("slow"); await manager.applyTheme("midnight");
slow.resolve({ meta: { id: "slow", name: "slow", kind: "custom" }, styles: [], values: {} }); await old;
assert.equal(manager.getSelectedId(), "midnight"); assert.equal(html.attrs.has("data-theme-compact"), false);
await manager.applyTheme("broken", { keepOnError: true }); assert.equal(manager.getSelectedId(), "midnight"); assert.ok(manager.getThemeState().error);
assert.equal(head.some(el => el.href?.includes("broken")), false);
override = "shard-theme://local/r1/custom.css";
await manager.applyTheme("afterglow"); assert.equal(head.at(-1).href, override); assert.equal(manager.getThemeState().error, null);
await manager.applyTheme("broken"); assert.equal(manager.getSelectedId(), "default"); assert.equal(html.attrs.has("data-theme-compact"), false);
console.log("PASS theme manifest, options, CSS URLs, legacy discovery, collisions, persistence, resource boundaries, live reload, switching races, failure recovery, and override order");
