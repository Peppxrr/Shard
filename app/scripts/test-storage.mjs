import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shard-storage-'));
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.resolve('scripts/test-storage.cjs'), root], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`Storage integration test exited with code ${code}`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
