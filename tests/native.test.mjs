import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { fixture } from './helpers.mjs';
import { setup } from '../src/setup.mjs';
import { initialConfig, pathsFor } from '../src/config.mjs';

test('real Codex reads the installed API auth and preserves shared config mappings', { skip: !process.env.CODEX_TEST_BINARY }, async t => {
  const options = await fixture(t);
  const { paths } = await setup({ ...options, codexBin: process.env.CODEX_TEST_BINARY });
  const cli = path.join(paths.runtime, 'src', 'cli.mjs');
  const result = spawnSync(process.execPath, [cli, 'run', 'api', paths.manifest, 'login', 'status'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /API key/i);
  const edit = spawnSync(process.execPath, [cli, 'run', 'official', paths.manifest, 'features', 'disable', 'apps'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(edit.status, 0, edit.stderr);
  assert.equal((await fs.lstat(path.join(paths.official, 'config.toml'))).isSymbolicLink(), false);
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

test('real Codex OAuth config contains no API bearer token, headers or query credentials', { skip: !process.env.CODEX_TEST_BINARY }, async t => {
  const options = await fixture(t);
  const paths = pathsFor(options.home);
  await fs.mkdir(paths.shared);
  const config = `
model = "test-model"
model_provider = "existing.api"
[model_providers."existing.api"]
name = "API"
base_url = "https://api.example.test/v1"
experimental_bearer_token = "fake-api-token"
http_headers = { X-Api-Key = "fake-api-header" }
env_http_headers = { X-Other-Key = "FAKE_API_HEADER" }
query_params = { api_key = "fake-query-key" }
`;
  await fs.writeFile(path.join(paths.shared, 'config.toml'), config);
  await setup({ home: options.home, codexBin: process.env.CODEX_TEST_BINARY });
  const cli = path.join(paths.runtime, 'src', 'cli.mjs');
  const effective = await _readOfficialConfig(cli, paths, options.directory);
  assert.equal(effective.model_provider, 'existing.api');
  const provider = effective.model_providers['existing.api'];
  assert.equal(provider.base_url, 'https://chatgpt.com/backend-api/codex');
  for (const field of ['experimental_bearer_token', 'env_key', 'auth', 'aws', 'http_headers', 'env_http_headers', 'query_params']) {
    assert.equal(provider[field], null, field);
  }
  assert.equal(await fs.readFile(path.join(paths.shared, 'config.toml'), 'utf8'), config);
});

test('real Codex reuses a preexisting API provider and doctor allows deferred OAuth', { skip: !process.env.CODEX_TEST_BINARY }, async t => {
  const options = await fixture(t);
  const paths = pathsFor(options.home);
  await fs.mkdir(paths.shared);
  const config = initialConfig(options).replaceAll('codex', 'existing-api');
  await fs.writeFile(path.join(paths.shared, 'config.toml'), config);
  await fs.writeFile(path.join(paths.shared, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: options.apiKey }));
  await setup({ home: options.home, codexBin: process.env.CODEX_TEST_BINARY });
  const cli = path.join(paths.runtime, 'src', 'cli.mjs');
  const status = spawnSync(process.execPath, [cli, 'run', 'api', paths.manifest, 'login', 'status'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout + status.stderr, /API key/i);
  const check = spawnSync(process.execPath, [cli, 'doctor', '--home', options.home], { encoding: 'utf8', timeout: 30000 });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /ChatGPT sign-in is handled/);
  assert.equal(await fs.readFile(path.join(paths.shared, 'config.toml'), 'utf8'), config);
});

async function _readOfficialConfig(cli, paths, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'run', 'official', paths.manifest, 'app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let response;
    let failure;
    let stderr = '';
    const timer = setTimeout(() => { failure = new Error('config/read timed out'); child.kill(); }, 10000);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.stderr.on('data', chunk => { stderr += chunk; });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.id === 1) {
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'config/read', params: { includeLayers: false } });
      }
      if (message.id === 2) {
        if (message.error) failure = new Error(JSON.stringify(message.error));
        response = message.result?.config;
        child.kill();
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => {
      clearTimeout(timer);
      lines.close();
      if (failure || !response) reject(failure ?? new Error(stderr));
      else resolve(response);
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '1' } } });
  });
}
