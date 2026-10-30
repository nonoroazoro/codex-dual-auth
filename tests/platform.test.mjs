import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launcherFiles, shellProfile, findCodex } from '../src/platform.mjs';
import { setup } from '../src/setup.mjs';
import { pathsFor } from '../src/config.mjs';
import { fixture } from './helpers.mjs';

test('PATH integration is idempotent and preserves unrelated configuration', () => {
  const before = 'export MY_SETTING=keep\n';
  const after = shellProfile(before, "/tmp/one user's bin");
  assert.ok(after.startsWith(before));
  assert.equal(shellProfile(after, "/tmp/one user's bin"), after);
  assert.throws(() => shellProfile(after.replace('export PATH=', 'export CUSTOM='), "/tmp/one user's bin"), /edited/);
});

test('generated native launcher works with a home containing spaces', async t => {
  const options = await fixture(t);
  const { paths } = await setup(options);
  for (const { name } of launcherFiles(paths)) {
    const target = path.join(paths.bin, name);
    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${target}" --version"`], { encoding: 'utf8', windowsVerbatimArguments: true })
      : spawnSync(target, ['--version'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('codex-cli 0.166.0'));
  }
});

test('Windows wrappers quote executable paths and never enable delayed expansion', () => {
  const files = launcherFiles(pathsFor('/tmp/User Home'), 'win32');
  assert.deepEqual(files.map(file => file.name), ['codex.cmd', 'codex-official.cmd']);
  assert.ok(files.every(file => file.contents.includes('DisableDelayedExpansion')));
});

test('binary discovery preserves stable symlinks across package-manager upgrades', async t => {
  if (process.platform === 'win32') return t.skip('POSIX package-manager symlink test');
  const options = await fixture(t);
  const link = path.join(options.directory, 'stable-codex');
  await fs.symlink(options.codexBin, link);
  assert.equal(await findCodex(link, path.join(options.directory, 'other-bin')), link);
});
