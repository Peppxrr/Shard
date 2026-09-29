const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const ts = require("typescript");

const root = process.argv[2];
if (!root) throw new Error("Expected a temporary test directory");

const consoleMethods = ["log", "debug", "info", "warn", "error"];
const trackedStreams = [];
let currentUserData = root;
let chooser = async () => ({ canceled: true });
let failPriorLogUnlink = false;
const ipcHandlers = new Map();

const app = new EventEmitter();
app.getPath = name => name === "userData" ? currentUserData : path.join(root, "documents");
const ipcMain = {
  handle(channel, handler) { ipcHandlers.set(channel, handler); },
};
const dialog = {
  async showSaveDialog(...args) { return chooser(...args); },
};
class BrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.sent = [];
    this.webContents = {
      mainFrame: {},
      send: (...args) => this.sent.push(args),
    };
  }
  isDestroyed() { return this.destroyed; }
  show() {}
  destroy() { this.destroyed = true; this.emit("closed"); }
  async loadURL() {}
  async loadFile() {}
}

const electronStub = { app, BrowserWindow, dialog, ipcMain };
const fsProxy = new Proxy(fs, {
  get(target, key) {
    if (key === "createWriteStream") {
      return (...args) => {
        const stream = target.createWriteStream(...args);
        trackedStreams.push(stream);
        return stream;
      };
    }
    if (key === "unlinkSync") {
      return filePath => {
        if (failPriorLogUnlink && /^dev-console-.*\.jsonl$/i.test(path.basename(filePath))) {
          throw new Error("Injected locked log");
        }
        return target.unlinkSync(filePath);
      };
    }
    return target[key];
  },
});

function loadTs(file) {
  const absolute = path.resolve(file);
  const loaded = new Module(absolute, module);
  loaded.filename = absolute;
  loaded.paths = Module._nodeModulePaths(path.dirname(absolute));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = id => {
    if (id === "electron") return electronStub;
    if (id === "node:fs") return fsProxy;
    if (id === "../shared/dev-console") return loadTs("src/shared/dev-console.ts");
    return originalRequire(id);
  };
  const source = fs.readFileSync(absolute, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  loaded._compile(compiled, absolute);
  return loaded.exports;
}

const { DevConsole } = loadTs("src/main/dev-console.ts");

function ownedEvent(instance) {
  return { sender: instance.win.webContents, senderFrame: instance.win.webContents.mainFrame };
}

function invoke(instance, channel, ...args) {
  const handler = ipcHandlers.get(channel);
  assert.ok(handler, "IPC handler registered: " + channel);
  return handler(ownedEvent(instance), ...args);
}

async function flush(stream) {
  await new Promise((resolve, reject) => {
    stream.write("", error => error ? reject(error) : resolve());
  });
}

async function endTrackedStreams() {
  const unique = [...new Set(trackedStreams)];
  trackedStreams.length = 0;
  for (const stream of unique) {
    if (!stream.closed) {
      const closed = new Promise(resolve => stream.once("close", resolve));
      if (!stream.writableEnded) stream.end();
      await closed;
    }
  }
}

async function runCase(name, body, createInstance = true) {
  const savedConsole = Object.fromEntries(consoleMethods.map(method => [method, console[method]]));
  currentUserData = path.join(root, name);
  await fsp.mkdir(currentUserData, { recursive: true });
  let instance;
  try {
    if (createInstance) instance = new DevConsole();
    await body(instance);
  } finally {
    for (const method of consoleMethods) console[method] = savedConsole[method];
    if (instance) instance.close();
    await endTrackedStreams();
    chooser = async () => ({ canceled: true });
    failPriorLogUnlink = false;
    for (const method of consoleMethods) {
      assert.equal(console[method], savedConsole[method], "console." + method + " is restored after " + name);
    }
  }
}

async function readJsonLines(filePath) {
  const bytes = await fsp.readFile(filePath);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.ok(text === "" || text.endsWith("\n"), "JSONL ends on a complete record boundary");
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
}

async function main() {
  await fsp.mkdir(path.join(root, "documents"), { recursive: true });

  await runCase("locked-retention", async () => {
    const logs = path.join(currentUserData, "logs", "developer-console");
    await fsp.mkdir(logs, { recursive: true });
    for (let index = 0; index < 6; index++) {
      await fsp.writeFile(path.join(logs, "dev-console-old-" + index + ".jsonl"), "old log");
    }
    failPriorLogUnlink = true;
    const started = Date.now();
    const instance = new DevConsole();
    failPriorLogUnlink = false;
    assert.ok(Date.now() - started < 3000, "locked prior logs do not stall console startup");
    assert.equal((await fsp.readdir(logs)).filter(name => /^dev-console-old-.*\.jsonl$/.test(name)).length, 6);
    instance.close();
  }, false);

  await runCase("history", async instance => {
    instance.toggle();
    instance.feed({ t: 1, level: "core", stream: "stdout", text: "PORT 45678" });
    instance.feed({ t: 2, level: "core", stream: "stderr", text: "capture health stable" });
    console.log("developer console tap marker");
    let visible = await invoke(instance, "devconsole:history");
    assert.equal(visible[2].text, "developer console tap marker");
    assert.equal(visible[2].level, "app");
    assert.equal(visible[2].severity, "info");

    for (let index = 0; index < 20_001; index++) {
      instance.feed({ t: 100 + index, level: "core", stream: "stdout", text: "record-" + index });
    }
    visible = await invoke(instance, "devconsole:history");
    assert.equal(visible.length, 20_001, "history includes one overflow notice and 20,000 retained records");
    assert.equal(visible[0].id, 0);
    assert.match(visible[0].text, /removed 4 older lines/);
    assert.equal(visible[1].id, 5);
    assert.equal(visible.at(-1).id, 20_004);

    const sequence = await invoke(instance, "devconsole:clear");
    assert.equal(sequence, 20_004);
    assert.deepEqual(await invoke(instance, "devconsole:history"), []);
    await flush(instance.logStream);
    const stored = await readJsonLines(instance.sessionLogPath);
    assert.equal(stored.length, 20_004, "clearing the live view keeps the complete session log");
    assert.deepEqual([stored[0].stream, stored[1].stream], ["stdout", "stderr"]);
    assert.equal(stored[0].severity, "info");
    assert.equal(stored[1].severity, "info", "routine health text on stderr stays neutral");
    assert.equal(stored[2].text, "developer console tap marker");
  });

  await runCase("export-snapshot", async instance => {
    instance.toggle();
    const destination = path.join(root, "existing-session.jsonl");
    await fsp.writeFile(destination, "old destination contents");
    instance.feed({ t: 10, level: "app", text: "before dialog 🌲" });
    chooser = async (owner, options) => {
      assert.equal(owner, instance.win);
      assert.equal(options.defaultPath, path.join(root, "documents", path.basename(options.defaultPath)));
      instance.feed({ t: 11, level: "app", text: "while dialog was open 🌲" });
      return { canceled: false, filePath: destination };
    };

    const stream = instance.logStream;
    const originalWrite = stream.write;
    let addedAfterSnapshot = false;
    stream.write = function (chunk, encoding, callback) {
      if (chunk === "" && !addedAfterSnapshot) {
        addedAfterSnapshot = true;
        instance.feed({ t: 12, level: "app", text: "after snapshot 🌲" });
      }
      return originalWrite.call(this, chunk, encoding, callback);
    };
    let exported;
    try {
      exported = await invoke(instance, "devconsole:export");
    } finally {
      stream.write = originalWrite;
      chooser = async () => ({ canceled: true });
    }
    assert.equal(exported, destination);
    assert.equal(addedAfterSnapshot, true);
    const exportedLines = await readJsonLines(destination);
    assert.deepEqual(exportedLines.map(line => line.text), ["before dialog 🌲", "while dialog was open 🌲"]);
    assert.ok((await fsp.readFile(destination, "utf8")).includes("🌲"), "UTF-8 records survive byte-bounded export");
    await flush(stream);
    const sessionLines = await readJsonLines(instance.sessionLogPath);
    assert.deepEqual(sessionLines.map(line => line.text), ["before dialog 🌲", "while dialog was open 🌲", "after snapshot 🌲"]);
    const leftovers = (await fsp.readdir(root)).filter(name => /^\.existing-session\.jsonl\..*\.tmp$/.test(name));
    assert.deepEqual(leftovers, [], "successful export removes its sibling temp file by rename");
  });

  await runCase("active-file-rejection", async instance => {
    instance.toggle();
    const source = instance.sessionLogPath;
    instance.feed({ t: 20, level: "app", text: "protect active file" });
    await flush(instance.logStream);
    const normalizedAlias = path.dirname(source) + path.sep + "." + path.sep + path.basename(source);
    chooser = async () => ({ canceled: false, filePath: normalizedAlias });
    await assert.rejects(invoke(instance, "devconsole:export"), /Choose a different file/);
    const hardlink = path.join(root, "active-session-hardlink.jsonl");
    await fsp.link(source, hardlink);
    chooser = async () => ({ canceled: false, filePath: hardlink });
    await assert.rejects(invoke(instance, "devconsole:export"), /Choose a different file/);
    chooser = async () => ({ canceled: true });
  });

  await runCase("temp-cleanup", async instance => {
    instance.toggle();
    const destinationDirectory = path.join(root, "destination-directory");
    await fsp.mkdir(destinationDirectory);
    instance.feed({ t: 30, level: "app", text: "force rename failure" });
    chooser = async () => ({ canceled: false, filePath: destinationDirectory });
    await assert.rejects(invoke(instance, "devconsole:export"), /Could not export/);
    const leftovers = (await fsp.readdir(root)).filter(name => /^\.destination-directory\..*\.tmp$/.test(name));
    assert.deepEqual(leftovers, [], "failed export removes the sibling temp file");
    chooser = async () => ({ canceled: true });
  });

  await runCase("write-failure", async instance => {
    instance.toggle();
    const stream = instance.logStream;
    instance.feed({ t: 40, level: "app", text: "before failure" });
    stream.emit("error", new Error("disk full"));
    const history = await invoke(instance, "devconsole:history");
    assert.match(history.at(-1).text, /logging stopped.*disk full/);
    instance.feed({ t: 41, level: "app", text: "memory continues after failure" });
    assert.equal(instance.logStream, null);
    chooser = async () => ({ canceled: false, filePath: path.join(root, "incomplete-export.jsonl") });
    assert.doesNotThrow(() => stream.emit("error", new Error("late stream error")));
    await assert.rejects(invoke(instance, "devconsole:export"), /full-session log is incomplete/);
    assert.equal(await fsp.stat(path.join(root, "incomplete-export.jsonl")).then(() => true, () => false), false);
    chooser = async () => ({ canceled: true });
  });

  console.log("PASS real session logging, retention, bounded memory, exports, overwrite, and error handling");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
