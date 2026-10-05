const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const Database = require('better-sqlite3');
const ts = require('typescript');

const root = process.argv[2];
let storageSettings = { autoCleanup: true, clipsDir: root, limitGb: 1, deleteEdited: false };
let thumbNumber = 0;
const stubs = {
  electron: { app: { getPath: () => root } },
  './settings': { getSettings: () => ({ storage: storageSettings }) },
  './ffmpeg': {
    ffprobeAsync: async file => ({ durationSec: 5, sizeBytes: (await fs.stat(file)).size, width: 640, height: 360, fps: 60 }),
    ffprobe: () => ({ durationSec: 5, sizeBytes: 1, width: 640, height: 360, fps: 60 }),
    makeThumbnailAsync: async (_file, directory) => {
      await fs.mkdir(directory, { recursive: true });
      const thumbnail = path.join(directory, `thumb-${thumbNumber++}.jpg`);
      await fs.writeFile(thumbnail, 'thumbnail');
      return thumbnail;
    },
    makeThumbnail: () => null,
    removeEditorMedia: async () => {},
    editorTimelinePreviews: () => ({ warm() {}, remove: async () => {} }),
  },
};

function loadTs(file) {
  const absolute = path.resolve(file);
  const mod = new Module(absolute, module);
  mod.filename = absolute;
  mod.paths = Module._nodeModulePaths(path.dirname(absolute));
  const original = mod.require.bind(mod);
  mod.require = id => {
    if (id in stubs) return stubs[id];
    if (id === '../shared/storage-policy') return loadTs('src/shared/storage-policy.ts');
    if (id === '../shared/contracts') return loadTs('src/shared/contracts.ts');
    if (id === './library-import') return loadTs('src/main/library-import.ts');
    return original(id);
  };
  mod._compile(ts.transpileModule(readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, absolute);
  return mod.exports;
}

const DAY_MS = 86_400_000;
const GIB = 1024 ** 3;
function setLimit(bytes, extra = {}) {
  storageSettings = { ...storageSettings, limitGb: bytes / GIB, ...extra };
}
async function makeLibrary(name) {
  const profile = path.join(root, name);
  await fs.mkdir(profile, { recursive: true });
  return new Library(profile);
}
async function addClip(library, name, { source = 'clip', createdAt = Date.now(), importedAt = Date.now(), sizeBytes = 100, protected: isProtected = false } = {}) {
  const file = path.join(root, `${name}-${thumbNumber}.mp4`);
  await fs.writeFile(file, 'video');
  const record = await library.importMp4Async(file, source, 'Test Game');
  library.db.prepare('UPDATE clips SET created_at = ?, imported_at = ?, size_bytes = ?, protected = ? WHERE id = ?')
    .run(createdAt, importedAt, sizeBytes, isProtected ? 1 : 0, record.id);
  return library.get(record.id);
}
async function withLibrary(name, callback) {
  const profile = path.join(root, name);
  const library = await makeLibrary(name);
  try { await callback(library, profile); }
  finally { library.close(); }
}

const { Library } = loadTs('src/main/library.ts');
const { StorageWatchdog } = loadTs('src/main/storage.ts');
const { isAutoManagedClip } = loadTs('src/shared/storage-policy.ts');
const old = (now, days) => ({ createdAt: now - days * DAY_MS, importedAt: now - 3 * DAY_MS });
async function addOld(library, prefix, count, now, sizeBytes = 100) {
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(await addClip(library, `${prefix}-${i}`, { ...old(now, 100 - i), sizeBytes }));
  return rows;
}

(async () => {
  try {
    const now = Date.now();
    const kept = (library, rows) => rows.every(row => library.get(row.id));

    // Recordings and videos of at least a quarter of the target are kept and do not count.
    await withLibrary('large-recording', async library => {
      setLimit(2 * GIB);
      const recording = await addClip(library, 'recording', { source: 'recording', ...old(now, 40), sizeBytes: Math.floor(1.5 * GIB) });
      const replay = await addClip(library, 'oversized-replay', { ...old(now, 40), sizeBytes: Math.floor(0.6 * GIB) });
      const smallClips = [];
      for (let i = 0; i < 15; i++) smallClips.push(await addClip(library, `small-${i}`, { ...old(now, 30 - i), sizeBytes: Math.floor(0.09 * GIB) }));
      assert.equal(isAutoManagedClip(recording, storageSettings), false);
      assert.equal(isAutoManagedClip(replay, storageSettings), false);
      // A long replay is an ordinary clip under a large target.
      assert.equal(isAutoManagedClip(replay, { ...storageSettings, limitGb: 20 }), true);
      const watchdog = new StorageWatchdog(library);
      assert.equal(await watchdog.check(), 0);
      assert.ok(kept(library, [recording, replay, ...smallClips]));
      assert.equal(watchdog.status().keptBytes, recording.sizeBytes + replay.sizeBytes);
      await watchdog.stop();
    });

    // The target is literal: 95% full is not an instruction to shrink to 90%.
    await withLibrary('near-target', async library => {
      setLimit(2_000);
      await addOld(library, 'near', 20, now, 95);
      const watchdog = new StorageWatchdog(library);
      assert.equal(await watchdog.check(), 0);
      assert.equal(library.list().length, 20);
      assert.equal(watchdog.status().reason, 'within-target');
      await watchdog.stop();
    });

    // Ordinary growth removes exactly enough of the oldest clips, every time, with no daily stall.
    await withLibrary('routine-growth', async library => {
      setLimit(2_000);
      const rows = await addOld(library, 'routine', 20, now);
      const watchdog = new StorageWatchdog(library);
      for (let day = 0; day < 3; day++) {
        const arrivals = [];
        for (let i = 0; i < 4; i++) arrivals.push(await addClip(library, `arrival-${day}-${i}`, { sizeBytes: 100 }));
        assert.equal(await watchdog.check(), 4);
        assert.ok(kept(library, arrivals));
        assert.ok(rows.slice(0, 4 * (day + 1)).every(row => !library.get(row.id)));
        assert.ok(kept(library, rows.slice(4 * (day + 1))));
        assert.equal(watchdog.status().reason, 'within-target');
      }
      await watchdog.stop();
    });

    // New arrivals are kept for 24 hours even when their capture timestamps are old.
    await withLibrary('recent-arrivals', async library => {
      setLimit(900);
      const rows = [];
      for (let i = 0; i < 10; i++) rows.push(await addClip(library, `recent-${i}`, { createdAt: now - 30 * DAY_MS, importedAt: now, sizeBytes: 100 }));
      const watchdog = new StorageWatchdog(library);
      assert.equal(await watchdog.check(), 0);
      assert.equal(watchdog.status().reason, 'recent');
      assert.ok(kept(library, rows));
      await watchdog.stop();
    });

    // The five newest managed clips are never removed automatically.
    await withLibrary('minimum', async library => {
      setLimit(550);
      const rows = await addOld(library, 'minimum', 5, now, 120);
      const watchdog = new StorageWatchdog(library);
      assert.equal(await watchdog.check(), 0);
      assert.equal(watchdog.status().reason, 'minimum');
      assert.ok(kept(library, rows));
      await watchdog.stop();
    });

    // A large overage pauses until confirmed, and confirmation is bounded by the amount shown.
    await withLibrary('needs-review', async library => {
      setLimit(1_000);
      const rows = await addOld(library, 'review', 30, now);
      const watchdog = new StorageWatchdog(library);
      assert.equal(await watchdog.check(), 0);
      assert.equal(await watchdog.check(), 0);
      const status = watchdog.status();
      assert.equal(status.reason, 'needs-review');
      assert.deepEqual([status.reclaimCount, status.reclaimBytes], [20, 2_000]);
      assert.ok(kept(library, rows));
      assert.equal(await watchdog.cleanUpNow(1_999), 0);
      assert.ok(kept(library, rows));
      assert.equal(await watchdog.cleanUpNow(2_000), 20);
      assert.ok(rows.slice(0, 20).every(row => !library.get(row.id)));
      assert.ok(kept(library, rows.slice(20)));
      assert.equal(watchdog.status().reason, 'within-target');
      await watchdog.stop();
    });

    // Turning cleanup off keeps everything regardless of usage.
    await withLibrary('disabled', async library => {
      setLimit(100, { autoCleanup: false });
      const rows = await addOld(library, 'disabled', 10, now);
      const watchdog = new StorageWatchdog(library);
      assert.equal(await watchdog.check(), 0);
      assert.equal(await watchdog.cleanUpNow(Number.MAX_SAFE_INTEGER), 0);
      assert.equal(watchdog.status().reason, 'disabled');
      assert.ok(kept(library, rows));
      // A draft preview uses the supplied values without changing saved behavior.
      assert.equal(watchdog.status({ ...storageSettings, autoCleanup: true, limitGb: 950 / GIB }).reason, 'cleaning');
      await watchdog.stop();
      storageSettings.autoCleanup = true;
    });

    // Favorites, edited clips, and clips inside the arrival grace period are
    // revalidated on deletion even though each would otherwise be oldest.
    await withLibrary('eligibility', async library => {
      setLimit(1_000, { deleteEdited: false });
      const favorite = await addClip(library, 'favorite', { ...old(now, 300), protected: true });
      const edited = await addClip(library, 'edited', { source: 'edited', ...old(now, 300) });
      const fresh = await addClip(library, 'fresh', { createdAt: now - 300 * DAY_MS, importedAt: now });
      await addOld(library, 'eligibility-peer', 10, now);
      for (const row of [favorite, edited, fresh]) assert.equal(await library.deleteForStorage(row.id, storageSettings, now, true), false);
      assert.ok(kept(library, [favorite, edited, fresh]));
    });

    // Edited clips can be reclaimed after the user enables the setting.
    await withLibrary('edited-opt-in', async library => {
      setLimit(1_000, { deleteEdited: true });
      const edited = await addClip(library, 'edited-opt-in-target', { source: 'edited', ...old(now, 200) });
      await addOld(library, 'edited-peer', 10, now);
      assert.equal(await library.deleteForStorage(edited.id, storageSettings, now, false), true);
      assert.equal(library.get(edited.id), undefined);
      storageSettings.deleteEdited = false;
    });

    // A locked oldest candidate stops the pass without substituting newer clips.
    await withLibrary('locked', async library => {
      setLimit(900);
      const rows = await addOld(library, 'locked', 10, now);
      const unlock = library.tryLockPath(rows[0].path);
      const watchdog = new StorageWatchdog(library);
      const statuses = [];
      watchdog.on('status', status => statuses.push(status.reason));
      assert.equal(await watchdog.check(), 0);
      assert.deepEqual(statuses, ['busy']);
      assert.ok(kept(library, rows));
      unlock();
      assert.equal(await watchdog.check(), 1);
      assert.equal(library.get(rows[0].id), undefined);
      await watchdog.stop();
    });

    // A failed unlink keeps the clip and its record.
    await withLibrary('unlink-failure', async library => {
      setLimit(900);
      const rows = await addOld(library, 'unlink', 10, now);
      const originalUnlink = fs.unlink;
      fs.unlink = async file => {
        if (file === rows[0].path) throw Object.assign(Error('File busy'), { code: 'EBUSY' });
        return originalUnlink(file);
      };
      try {
        await assert.rejects(library.deleteForStorage(rows[0].id, storageSettings, now, false), /File busy/);
      } finally { fs.unlink = originalUnlink; }
      assert.ok(kept(library, rows));
      assert.equal(await library.deleteForStorage(rows[1].id, storageSettings, now, false), false);
      assert.equal(await library.deleteForStorage(rows[0].id, storageSettings, now, false), true);
    });

    // Concurrent callers share the active pass rather than racing separate deletions.
    await withLibrary('concurrent', async library => {
      setLimit(900);
      await addOld(library, 'concurrent', 10, now);
      const watchdog = new StorageWatchdog(library);
      const originalDelete = library.deleteForStorage.bind(library);
      let calls = 0;
      let releaseDelete;
      const gate = new Promise(resolve => { releaseDelete = resolve; });
      library.deleteForStorage = async (...args) => { calls++; await gate; return originalDelete(...args); };
      const first = watchdog.check();
      const second = watchdog.check();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, 1);
      releaseDelete();
      assert.deepEqual(await Promise.all([first, second]), [1, 1]);
      assert.equal(calls, 1);
      await watchdog.stop();
    });

    // Favorites before unlink invalidate the plan; after unlink is issued they
    // cannot report success for a file that is already being removed.
    await withLibrary('favorite-race', async library => {
      setLimit(900);
      const rows = await addOld(library, 'favorite-race', 10, now);
      library.setProtected(rows[0].id, true);
      assert.equal(await library.deleteForStorage(rows[0].id, storageSettings, now, false), false);
      library.setProtected(rows[0].id, false);
      const originalUnlink = fs.unlink;
      let releaseUnlink;
      const gate = new Promise(resolve => { releaseUnlink = resolve; });
      fs.unlink = async file => { if (file === rows[0].path) await gate; return originalUnlink(file); };
      try {
        const deleting = library.deleteForStorage(rows[0].id, storageSettings, now, false);
        assert.throws(() => library.setProtected(rows[0].id, true), /already being removed/);
        releaseUnlink();
        assert.equal(await deleting, true);
      } finally { releaseUnlink(); fs.unlink = originalUnlink; }
    });

    // An arrival during a routine pass that turns it into a large overage stops the pass.
    await withLibrary('changed-plan', async library => {
      setLimit(900);
      const rows = await addOld(library, 'changed', 10, now);
      const watchdog = new StorageWatchdog(library);
      const originalDelete = library.deleteForStorage.bind(library);
      let releaseDelete;
      const gate = new Promise(resolve => { releaseDelete = resolve; });
      library.deleteForStorage = async (...args) => { await gate; return originalDelete(...args); };
      const check = watchdog.check();
      await new Promise(resolve => setImmediate(resolve));
      const arrival = await addClip(library, 'changed-arrival', { sizeBytes: 200 });
      releaseDelete();
      assert.equal(await check, 0);
      assert.ok(kept(library, [...rows, arrival]));
      assert.equal(watchdog.status().reason, 'needs-review');
      await watchdog.stop();
    });

    // stop prevents later checks.
    await withLibrary('stopped', async library => {
      setLimit(100);
      await addOld(library, 'stopped', 10, now);
      const watchdog = new StorageWatchdog(library);
      await watchdog.stop();
      assert.equal(await watchdog.check(), 0);
      assert.equal(library.list().length, 10);
    });

    // A legacy database migration gives existing clips a fresh grace period.
    const legacyProfile = path.join(root, 'legacy-profile');
    await fs.mkdir(legacyProfile, { recursive: true });
    const legacyDb = new Database(path.join(legacyProfile, 'library.db'));
    legacyDb.exec(`CREATE TABLE clips(
      id TEXT PRIMARY KEY, path TEXT NOT NULL, thumb TEXT, game TEXT,
      created_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, size_bytes INTEGER NOT NULL,
      width INTEGER, height INTEGER, fps REAL, protected INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'clip'
    )`);
    const insertLegacy = legacyDb.prepare(`INSERT INTO clips(id,path,created_at,duration_ms,size_bytes,protected,source)
      VALUES(?,?,?,1000,100,0,'clip')`);
    for (let i = 0; i < 10; i++) insertLegacy.run(`legacy-${i}`, `legacy-${i}.mp4`, now - 30 * DAY_MS);
    legacyDb.close();
    const migrated = new Library(legacyProfile);
    try {
      setLimit(900);
      const importedAt = migrated.storageSnapshot().find(row => row.id === 'legacy-0').importedAt;
      assert.ok(importedAt >= now - 5_000 && importedAt <= Date.now());
      assert.equal(await migrated.deleteForStorage('legacy-0', storageSettings, Date.now(), true), false);
      assert.equal(migrated.storageSnapshot().length, 10);
    } finally { migrated.close(); }

    // A legacy zero limit meant "off"; it must not become an active tiny target.
    const settingsProfile = path.join(root, 'settings-profile');
    await fs.mkdir(settingsProfile, { recursive: true });
    await fs.writeFile(path.join(settingsProfile, 'settings.json'), JSON.stringify({ storage: { limitGb: 0, clipsDir: '', deleteEdited: false } }));
    stubs.electron = { app: { getPath: () => settingsProfile } };
    const { loadSettings } = loadTs('src/main/settings.ts');
    const loaded = (await loadSettings()).storage;
    assert.deepEqual([loaded.autoCleanup, loaded.limitGb], [false, 20]);

    console.log('PASS storage exclusions, routine growth, grace period, minimum, review gate, disabled, locks, races, migration and stop');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();
