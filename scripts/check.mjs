import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

for (const directory of ['src', 'tests', 'scripts']) {
  for (const entry of await fs.readdir(directory)) {
    if (!entry.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${entry}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log('JavaScript syntax checks passed.');
