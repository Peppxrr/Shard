const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const root = process.argv[2];
const stubs = {
  electron: { app: { getPath: () => root } },
  './settings': { getSettings: () => ({ storage: { clipsDir: root } }) },
  './ffmpeg': {
    ffprobeAsync: async file => {
      if ((await fs.readFile(file, 'utf8')) === 'bad') throw Error('Invalid video');
      return { durationSec: 6, sizeBytes: (await fs.stat(file)).size, width: 640, height: 360, fps: 60 };
    },
    makeThumbnailAsync: async () => null,
    editorTimelinePreviews: () => ({ warm() {}, remove: async () => {} }),
  },
};
function loadTs(file) {
  const absolute = path.resolve(file);
  const mod = new Module(absolute, module);
  mod.filename = absolute;
  mod.paths = Module._nodeModulePaths(path.dirname(absolute));
  const original = mod.require.bind(mod);
  mod.require = id => id in stubs ? stubs[id] : id === './library-import' ? loadTs('src/main/library-import.ts') : original(id);
  mod._compile(ts.transpileModule(readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, absolute);
  return mod.exports;
}
(async () => {
  const { Library } = loadTs('src/main/library.ts');
  const profile = path.join(root, 'profile'); await fs.mkdir(profile);
  const source = path.join(root, 'original.mp4'); await fs.writeFile(source, 'original-video');
  const destination = path.join(root, 'managed');
  let library = new Library(profile);
  try {
    const imported = await library.importCopiedMp4Async(source, destination, 'clip', { game: 'VRChat', createdAt: 123 });
    const id = imported.record.id;
    assert.equal(library.get(id).importedFrom, 'medal');
    assert.equal(library.get(id).createdAt, 123);
    assert.equal((await library.importCopiedMp4Async(source, destination, 'clip', { game: null, createdAt: 1 })).duplicate, true);
    await library.renameClip(id, 'Drive');
    assert.equal(await fs.readFile(library.get(id).path, 'utf8'), 'original-video');
    await library.renameClip(id, 'drive');
    assert.equal(path.basename(library.get(id).path), 'drive.mp4');
    const occupied = path.join(destination, 'occupied.mp4'); await fs.writeFile(occupied, 'other-video');
    await assert.rejects(library.renameClip(id, 'occupied'), /already exists/);
    assert.equal(await fs.readFile(occupied, 'utf8'), 'other-video');
    const originalUpdate = library.updatePath.bind(library);
    library.updatePath = () => { throw Error('Injected database failure'); };
    await assert.rejects(library.renameClip(id, 'rollback'), /Injected database failure/);
    assert.equal(await fs.readFile(library.get(id).path, 'utf8'), 'original-video');
    await assert.rejects(library.renameClip(id, 'DRIVE'), /Injected database failure/);
    assert.equal(await fs.readFile(library.get(id).path, 'utf8'), 'original-video');
    library.updatePath = originalUpdate;
    const oldPath = library.get(id).path;
    let updateCalls = 0;
    library.updatePath = (...args) => { if (updateCalls++ === 0) throw Error('Injected database failure'); return originalUpdate(...args); };
    const originalLink = fs.link, originalCopy = fs.copyFile;
    fs.link = async (a, b) => { if (b === oldPath) throw Error('Injected rollback failure'); return originalLink(a, b); };
    fs.copyFile = async (a, b, flags) => { if (b === oldPath) throw Error('Injected rollback failure'); return originalCopy(a, b, flags); };
    try { await assert.rejects(library.renameClip(id, 'preserved'), /preserved at/); }
    finally { fs.link = originalLink; fs.copyFile = originalCopy; library.updatePath = originalUpdate; }
    assert.equal(await fs.readFile(library.get(id).path, 'utf8'), 'original-video');
    const unlock = library.tryLockPath(library.get(id).path);
    await assert.rejects(library.renameClip(id, 'locked'), /another operation/);
    await assert.rejects(library.deleteForStorage(id), /another operation/);
    unlock();
    const bad = path.join(root, 'bad.mp4'); await fs.writeFile(bad, 'bad');
    const before = await fs.readdir(destination);
    await assert.rejects(library.importCopiedMp4Async(bad, destination, 'edited', { game: null, createdAt: 1 }), /Invalid video/);
    assert.deepEqual(await fs.readdir(destination), before);
    library.close(); library = new Library(profile);
    assert.equal((await library.importCopiedMp4Async(source, destination, 'clip', { game: null, createdAt: 1 })).duplicate, true);
    await library.delete(id);
    assert.equal(await fs.readFile(source, 'utf8'), 'original-video');
    assert.equal((await library.importCopiedMp4Async(source, destination, 'edited', { game: null, createdAt: 1 })).duplicate, false);
    console.log('PASS real SQLite import deduplication and filename rollback safety');
  } finally { library.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
