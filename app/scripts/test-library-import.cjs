const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const root = process.argv[2];
const removedEditorMedia = [];
let thumbNumber = 0;
const stubs = {
  electron: { app: { getPath: () => root } },
  './settings': { getSettings: () => ({ storage: { clipsDir: root } }) },
  './ffmpeg': {
    ffprobeAsync: async file => {
      if ((await fs.readFile(file, 'utf8')) === 'bad') throw Error('Invalid video');
      return { durationSec: 6, sizeBytes: (await fs.stat(file)).size, width: 640, height: 360, fps: 60 };
    },
    makeThumbnailAsync: async (_file, directory) => {
      await fs.mkdir(directory, { recursive: true });
      const thumbnail = path.join(directory, `test-${thumbNumber++}.jpg`);
      await fs.writeFile(thumbnail, 'thumbnail');
      return thumbnail;
    },
    removeEditorMedia: async file => { removedEditorMedia.push(file); },
    editorTimelinePreviews: () => ({ warm() {}, remove: async () => {} }),
  },
};
function loadTs(file) {
  const absolute = path.resolve(file);
  const mod = new Module(absolute, module);
  mod.filename = absolute;
  mod.paths = Module._nodeModulePaths(path.dirname(absolute));
  const original = mod.require.bind(mod);
  mod.require = id => id in stubs ? stubs[id] : id === './library-import' ? loadTs('src/main/library-import.ts')
    : id === '../shared/storage-policy' ? loadTs('src/shared/storage-policy.ts')
    : id === '../shared/perf' ? loadTs('src/shared/perf.ts') : original(id);
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
    const waveformBlob = Buffer.alloc(4816, 7);
    library.waveformStorage(id, 1).put('source-v1', waveformBlob);
    assert.deepEqual(library.waveformStorage(id, 1).get('source-v1'), waveformBlob);
    assert.equal(library.waveformStorage(id, 1).get('source-v2'), undefined, 'stale identity invalidates SQLite waveform');
    library.waveformStorage(id, 1).put('source-v2', waveformBlob);
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
    assert.deepEqual(library.waveformStorage(id, 1).get('source-v2'), waveformBlob, 'SQLite waveform survives restart');
    assert.equal((await library.importCopiedMp4Async(source, destination, 'clip', { game: null, createdAt: 1 })).duplicate, true);
    await library.delete(id);
    assert.equal(library.waveformStorage(id, 1).get('source-v2'), undefined, 'clip delete trigger removes waveform');
    library.waveformStorage(id, 1).put('source-v2', waveformBlob);
    assert.equal(library.waveformStorage(id, 1).get('source-v2'), undefined, 'in-flight writes cannot resurrect deleted waveform');
    assert.equal(await fs.readFile(source, 'utf8'), 'original-video');
    assert.equal((await library.importCopiedMp4Async(source, destination, 'edited', { game: null, createdAt: 1 })).duplicate, false);
    library.startWatching();
    await new Promise(resolve => setTimeout(resolve, 450));
    // A recording becomes visible only after import has created its SQLite row.
    const recordingDirectory = path.join(root, 'old-storage', 'recordings');
    await fs.mkdir(recordingDirectory, { recursive: true });
    const recordingFile = path.join(recordingDirectory, 'recording.mp4');
    await fs.writeFile(recordingFile, 'recording-video');
    let recordingAdded = false;
    library.once('added', record => {
      assert.equal(record.source, 'recording');
      assert.equal(library.get(record.id).game, 'VRChat');
      recordingAdded = true;
    });
    const recording = await library.importMp4Async(recordingFile, 'recording', 'VRChat');
    assert.equal(recordingAdded, true);

    // Watch existing row directories, including earlier/custom storage paths.
    const movedRecording = path.join(root, 'moved-recording.mp4');
    const changed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Live missing-file reconciliation timed out')), 4000);
      library.on('removed', function removed(record) {
        if (record.id !== recording.id) return;
        clearTimeout(timeout); library.off('removed', removed); resolve();
      });
    });
    await fs.rename(recordingFile, movedRecording);
    await changed;
    assert.equal(library.get(recording.id), undefined);
    assert.equal(await fs.readFile(movedRecording, 'utf8'), 'recording-video');
    assert.equal(await fs.stat(recording.thumb).catch(() => null), null);
    assert.ok(removedEditorMedia.includes(recordingFile));
    await library.stopWatching();

    const clipFile = path.join(destination, 'locked-missing.mp4');
    await fs.writeFile(clipFile, 'clip-video');
    const clip = await library.importMp4Async(clipFile, 'clip', 'Game');
    const releaseMissing = library.tryLockPath(clipFile);
    await fs.unlink(clipFile);
    await library.reconcile();
    assert.ok(library.get(clip.id), 'busy paths survive reconciliation');
    releaseMissing();
    await library.reconcile();
    assert.equal(library.get(clip.id), undefined);
    assert.equal(await fs.stat(clip.thumb).catch(() => null), null);

    const editedFile = path.join(destination, 'edited.mp4');
    await fs.writeFile(editedFile, 'edited-video');
    const edited = await library.importMp4Async(editedFile, 'edited', 'Game');
    const originalStat = fs.stat;
    fs.stat = async (...args) => {
      if (args[0] === editedFile) throw Object.assign(Error('Temporary access failure'), { code: 'EACCES' });
      return originalStat(...args);
    };
    try { await library.reconcile(); }
    finally { fs.stat = originalStat; }
    assert.ok(library.get(edited.id), 'access errors do not discard metadata');
    const originalUnlink = fs.unlink;
    fs.unlink = async file => {
      if (file === editedFile) throw Object.assign(Error('File busy'), { code: 'EPERM' });
      return originalUnlink(file);
    };
    try { await assert.rejects(library.delete(edited.id), /File busy/); }
    finally { fs.unlink = originalUnlink; }
    assert.ok(library.get(edited.id), 'failed deletion preserves metadata');
    await fs.unlink(editedFile);
    await library.reconcile();
    assert.equal(library.get(edited.id), undefined);
    assert.ok(removedEditorMedia.includes(editedFile));
    const untracked = path.join(destination, 'untracked.mp4');
    await fs.writeFile(untracked, 'user-video');
    await library.reconcile();
    assert.equal(await fs.readFile(untracked, 'utf8'), 'user-video');
    library.startWatching();
    await library.stopWatching();
    assert.equal(library.watchers.size, 0);
    assert.equal(library.watchTimer, undefined);
    assert.equal(library.refreshTimer, undefined);
    console.log('PASS real SQLite import deduplication and filename rollback safety');
    console.log('PASS recording visibility, live moves, missing clip/edit cleanup, busy paths and access failures');
  } finally { library.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
