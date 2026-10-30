import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.mjs';
import { setup } from '../src/setup.mjs';
import { linkMatches } from '../src/sharing.mjs';

test('real Codex reads the installed API auth and preserves shared config mappings', { skip: !process.env.CODEX_TEST_BINARY }, async t => {
  const options = await fixture(t);
  const { paths } = await setup({ ...options, codexBin: process.env.CODEX_TEST_BINARY });
  const cli = path.join(paths.runtime, 'src', 'cli.mjs');
  const result = spawnSync(process.execPath, [cli, 'run', 'api', paths.manifest, 'login', 'status'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /API key/i);
  const edit = spawnSync(process.execPath, [cli, 'run', 'official', paths.manifest, 'features', 'disable', 'apps'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(edit.status, 0, edit.stderr);
  assert.equal(await linkMatches(path.join(paths.shared, 'config.toml'), path.join(paths.official, 'config.toml')), true);
  assert.match(await fs.readFile(path.join(paths.shared, 'config.toml'), 'utf8'), /apps = false/);
  const preserved = await fs.readFile(path.join(paths.shared, 'config.toml'), 'utf8');
  await setup({ home: options.home });
  assert.equal(await fs.readFile(path.join(paths.shared, 'config.toml'), 'utf8'), preserved);
  const auth = await fs.readFile(path.join(paths.shared, 'auth.json'), 'utf8');
  const oauth = spawnSync(process.execPath, [cli, 'run', 'official', paths.manifest, 'login', 'status'], { encoding: 'utf8', timeout: 30000 });
  assert.notEqual(oauth.status, 0);
  assert.ok(!/API key configured/i.test(oauth.stdout + oauth.stderr));
  assert.equal(await fs.readFile(path.join(paths.shared, 'auth.json'), 'utf8'), auth);
});
