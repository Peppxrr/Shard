import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { medalImportMetadata, validateClipBasename, scanMp4Tree, copyMp4ToUniquePath } from '../src/main/library-import.ts';

const root = await fs.mkdtemp(path.resolve('../tmp/library-import-'));
try {
  const source = path.join(root, 'Medal', 'Clips');
  const game = path.join(source, 'American Truck Simulator');
  await fs.mkdir(game, { recursive: true });
  const file = path.join(game, 'MedalTVAmericanTruckSimulator20260731034932782.mp4');
  await fs.writeFile(file, 'video-content');
  await fs.writeFile(path.join(game, 'ignore.txt'), 'ignore');
  const parsed = medalImportMetadata(source, file, 1);
  assert.equal(parsed.game, 'American Truck Simulator');
  assert.equal(parsed.createdAt, new Date(2026, 6, 31, 3, 49, 32, 782).getTime());
  assert.equal(medalImportMetadata(game, file, 1).game, 'American Truck Simulator');
  assert.equal(medalImportMetadata(source, path.join(source, 'MedalTVGame20260230010101000.mp4'), 123).createdAt, 123);
  assert.equal(medalImportMetadata(source, path.join(source, 'id-render.mp4'), 123).game, null);
  for (const name of ['', '.', '..', '../escape', 'a/b', 'a\\b', 'NUL', 'con.txt', 'COM1', 'bad.', 'a:b', 'a\0b']) {
    assert.throws(() => validateClipBasename(name), undefined, name);
  }
  assert.equal(validateClipBasename('Evening drive.mp4'), 'Evening drive');
  const scan = await scanMp4Tree(source);
  assert.deepEqual(scan.files, [await fs.realpath(file)]);
  const destination = path.join(root, 'copies');
  const first = await copyMp4ToUniquePath(file, destination);
  const second = await copyMp4ToUniquePath(file, destination);
  assert.notEqual(first, second);
  assert.equal(await fs.readFile(first, 'utf8'), 'video-content');
  assert.equal(await fs.readFile(file, 'utf8'), 'video-content');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.resolve('scripts/test-library-import.cjs'), root], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit',
    });
    child.once('error', reject); child.once('exit', resolve);
  });
  assert.equal(code, 0, 'library disk/SQLite integration');
  console.log('PASS library import metadata, copies, renaming, locks, and rollback');
} finally { await fs.rm(root, { recursive: true, force: true }); }
