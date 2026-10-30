import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { transaction } from '../src/files.mjs';
import { fixture } from './helpers.mjs';

test('a partial replacement write never truncates the original configuration', async t => {
  const { home } = await fixture(t);
  const target = path.join(home, 'config.toml');
  await fs.writeFile(target, 'original configuration');
  const resolved = await fs.realpath(target);
  const writeFile = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (file, contents, options) => {
    if (String(file).startsWith(resolved + '.codex-setup-')) {
      await writeFile(file, 'partial', options);
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return writeFile(file, contents, options);
  });
  const tx = transaction();
  await assert.rejects(tx.replace(target, 'original configuration', 'new configuration'), /disk full/);
  await tx.rollback();
  assert.equal(await fs.readFile(target, 'utf8'), 'original configuration');
  assert.deepEqual(await fs.readdir(home), ['config.toml']);
});
