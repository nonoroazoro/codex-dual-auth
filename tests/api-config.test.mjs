import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readApiConfiguration, completeApiConfiguration } from '../src/api-config.mjs';
import { pathsFor, initialConfig } from '../src/config.mjs';
import { fixture } from './helpers.mjs';

test('discovery selects the active profile instead of unrelated provider settings', async t => {
  const options = await fixture(t);
  const paths = pathsFor(options.home);
  await fs.mkdir(paths.shared);
  await fs.writeFile(path.join(paths.shared, 'config.toml'), `
profile = 'work'
model = 'other-model'
model_provider = 'other'
[profiles.work]
model = 'work-model'
model_provider = 'work'
[model_providers.work]
base_url = 'https://work.example.test/v1'
requires_openai_auth = true
`);
  const api = await readApiConfiguration(options.home);
  assert.equal(api.provider, 'work');
  assert.equal(api.model, 'work-model');
  assert.equal(api.baseUrl, 'https://work.example.test/v1');
  assert.equal(api.hasApiKey, false);
});

test('provider IDs cannot mutate Object.prototype when filling missing settings', async t => {
  const options = await fixture(t);
  const paths = pathsFor(options.home);
  await fs.mkdir(paths.shared);
  await fs.writeFile(path.join(paths.shared, 'config.toml'), 'model_provider = "__proto__"\nmodel = "test-model"\n');
  const api = await readApiConfiguration(options.home);
  const config = completeApiConfiguration(api, { baseUrl: options.baseUrl, model: options.model });
  assert.ok(config.includes('base_url = "https://api.example.test/v1"'));
  assert.equal(Object.prototype.base_url, undefined);
});

test('invalid credential JSON is reported without exposing its contents', async t => {
  const options = await fixture(t);
  const paths = pathsFor(options.home);
  await fs.mkdir(paths.shared);
  await fs.writeFile(path.join(paths.shared, 'auth.json'), '{"OPENAI_API_KEY":"test-secret"');
  await assert.rejects(readApiConfiguration(options.home), error => {
    assert.match(error.message, /Cannot parse existing auth.json/);
    assert.ok(!error.message.includes('test-secret'));
    return true;
  });
});

test('an explicitly unauthenticated API does not require an unused key', async t => {
  const options = await fixture(t);
  const paths = pathsFor(options.home);
  await fs.mkdir(paths.shared);
  await fs.writeFile(path.join(paths.shared, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'unused-old-key' }));
  await fs.writeFile(path.join(paths.shared, 'config.toml'), `
model = 'local-model'
model_provider = 'local'
[model_providers.local]
base_url = 'http://localhost:8080/v1'
requires_openai_auth = false
`);
  const api = await readApiConfiguration(options.home);
  assert.equal(api.authMode, 'provider');
  assert.equal(api.hasApiKey, true);
});

test('custom OpenAI-auth providers reuse OPENAI_API_KEY without auth.json', async t => {
  const options = await fixture(t);
  const paths = pathsFor(options.home);
  await fs.mkdir(paths.shared);
  await fs.writeFile(path.join(paths.shared, 'config.toml'), initialConfig(options));
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'environment-test-key';
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  const api = await readApiConfiguration(options.home);
  assert.equal(api.hasApiKey, true);
  assert.equal(api.envKey, 'OPENAI_API_KEY');
  assert.equal(api.authMode, 'provider');
});
