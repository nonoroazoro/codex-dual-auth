import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, readInstallation } from '../src/setup.mjs';
import { pathsFor } from '../src/config.mjs';
import { doctor } from '../src/launch.mjs';
import { fixture } from './helpers.mjs';

test('clean install shares conversations, preserves user edits and OAuth state on rerun', async t => {
  const options = await fixture(t);
  const result = await setup(options);
  const paths = result.paths;
  const configPath = path.join(paths.shared, 'config.toml');
  const config = (await fs.readFile(configPath, 'utf8')) + '\n# User customization\n';
  await fs.writeFile(configPath, config);
  const authBefore = await fs.readFile(path.join(paths.shared, 'auth.json'), 'utf8');
  await fs.writeFile(path.join(paths.official, 'auth.json'), '{"oauth_test":"keep"}');
  await fs.writeFile(path.join(paths.shared, 'sessions', 'conversation.jsonl'), 'first turn\n');
  await fs.appendFile(path.join(paths.official, 'sessions', 'conversation.jsonl'), 'second turn\n');
  assert.equal(await fs.readFile(path.join(paths.shared, 'sessions', 'conversation.jsonl'), 'utf8'), 'first turn\nsecond turn\n');
  const statBefore = await fs.stat(configPath);
  const repeated = await setup({ home: options.home });
  assert.equal(repeated.existing, true);
  assert.equal(await fs.readFile(configPath, 'utf8'), config);
  assert.equal((await fs.stat(configPath)).mtimeMs, statBefore.mtimeMs);
  assert.equal(await fs.readFile(path.join(paths.shared, 'auth.json'), 'utf8'), authBefore);
  assert.equal(await fs.readFile(path.join(paths.official, 'auth.json'), 'utf8'), '{"oauth_test":"keep"}');
  assert.ok(!(await fs.readFile(paths.manifest, 'utf8')).includes(options.apiKey));
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(paths.shared, 'auth.json'))).mode & 0o777, 0o600);
  assert.ok((await doctor(options.home)).every(check => check.ok));
});

test('unmanaged configuration is not overwritten and setup leaves no temporary directories', async t => {
  const options = await fixture(t);
  const paths = pathsFor(options.home);
  await fs.mkdir(paths.shared);
  await fs.writeFile(path.join(paths.shared, 'config.toml'), 'existing config');
  await assert.rejects(setup(options), /unmanaged/);
  assert.equal(await fs.readFile(path.join(paths.shared, 'config.toml'), 'utf8'), 'existing config');
  assert.deepEqual(await fs.readdir(options.home), ['.codex']);
});

test('existing OAuth data, different keys and edited launchers fail without destructive repair', async t => {
  const options = await fixture(t);
  const { paths } = await setup(options);
  await assert.rejects(setup({ ...options, apiKey: 'another-key' }), /Existing auth.json differs/);
  const target = path.join(paths.official, 'config.toml');
  await fs.unlink(target);
  await fs.writeFile(target, 'independent data');
  await assert.rejects(setup({ home: options.home }), /independent OAuth data/);
  assert.equal(await fs.readFile(target, 'utf8'), 'independent data');
});

test('shell profile conflict rolls back files and never touches the existing profile', async t => {
  const options = await fixture(t);
  if (process.platform === 'win32') return t.skip('POSIX profile rollback test');
  const profile = path.join(options.home, '.zshrc');
  await fs.writeFile(profile, 'alias codex="my-custom-codex"\n');
  await assert.rejects(setup({ ...options, installShell: true }), /alias\/function/);
  assert.equal(await fs.readFile(profile, 'utf8'), 'alias codex="my-custom-codex"\n');
  assert.deepEqual(await fs.readdir(options.home), ['.zshrc']);
});

test('runtime forwards arguments literally and selects only the intended credentials', async t => {
  const options = await fixture(t);
  const { paths } = await setup(options);
  const cli = path.join(paths.runtime, 'src', 'cli.mjs');
  for (const mode of ['api', 'official']) {
    const input = 'literal "quotes" & $HOME ; $(no-shell) %PATH%';
    const result = spawnSync(process.execPath, [cli, 'run', mode, paths.manifest, 'exec', input], {
      encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: 'wrong', OPENAI_BASE_URL: 'wrong', CODEX_HOME: 'wrong' },
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.args.at(-1), input);
    assert.equal(observed.home, mode === 'api' ? paths.shared : paths.official);
    assert.equal(observed.sqlite, paths.shared);
    assert.equal(observed.leakedApi, null);
    assert.equal(observed.leakedUrl, null);
  }
  const settings = await readInstallation(options.home);
  assert.equal(settings.binary, options.codexBin);
});

test('CLI accepts a key through stdin and installed codex setup is idempotent', async t => {
  const options = await fixture(t);
  const cli = path.resolve('src/cli.mjs');
  const result = spawnSync(process.execPath, [cli, 'setup', '--home', options.home, '--codex-bin', options.codexBin, '--base-url', options.baseUrl, '--model', options.model, '--api-key-stdin'], { input: options.apiKey + '\r\n\r\n', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(options.apiKey));
  const paths = pathsFor(options.home);
  const rerun = spawnSync(process.execPath, [path.join(paths.runtime, 'src/cli.mjs'), 'run', 'api', paths.manifest, 'setup'], { encoding: 'utf8' });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.ok(rerun.stdout.includes('Verified existing'));
});
