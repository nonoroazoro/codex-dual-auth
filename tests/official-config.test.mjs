import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { setup } from '../src/setup.mjs';
import { syncShared } from '../src/sharing.mjs';
import { fixture } from './helpers.mjs';

test('OAuth base and profile views remove provider credentials without changing API files', async t => {
  const options = await fixture(t);
  const { paths } = await setup(options);
  const source = path.join(paths.shared, 'work.config.toml');
  const contents = `
model = "profile-model"
[model_providers.custom]
base_url = "https://api.example.test/v1"
env_key = "API_SECRET"
experimental_bearer_token = "fake-token"
auth = { command = "credential-helper" }
aws = { profile = "private" }
http_headers = { Authorization = "fake-header" }
env_http_headers = { X-Api-Key = "OTHER_API_KEY" }
query_params = { api_key = "fake-query" }
`;
  await fs.writeFile(source, contents);
  await syncShared(paths);
  const view = parse(await fs.readFile(path.join(paths.official, 'work.config.toml'), 'utf8'));
  assert.deepEqual({ ...view.model_providers.custom }, {
    name: 'OpenAI', base_url: 'https://chatgpt.com/backend-api/codex', wire_api: 'responses', requires_openai_auth: true,
  });
  assert.equal(await fs.readFile(source, 'utf8'), contents);
});

test('disjoint API and OAuth edits merge, while conflicting edits preserve both files', async t => {
  const options = await fixture(t);
  const { paths } = await setup(options);
  const source = path.join(paths.shared, 'config.toml');
  const target = path.join(paths.official, 'config.toml');
  await fs.writeFile(source, (await fs.readFile(source, 'utf8')).replace('"high"', '"medium"'));
  await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace('daemon_auto_start = false', 'daemon_auto_start = false\napps = false'));
  await syncShared(paths);
  const merged = parse(await fs.readFile(source, 'utf8'));
  assert.equal(merged.model_reasoning_effort, 'medium');
  assert.equal(merged.features.apps, false);
  const apiEdit = (await fs.readFile(source, 'utf8')).replace('"medium"', '"low"');
  const oauthEdit = (await fs.readFile(target, 'utf8')).replace('"medium"', '"high"');
  await fs.writeFile(source, apiEdit);
  await fs.writeFile(target, oauthEdit);
  await assert.rejects(syncShared(paths), /Concurrent configuration edit/);
  assert.equal(await fs.readFile(source, 'utf8'), apiEdit);
  assert.equal(await fs.readFile(target, 'utf8'), oauthEdit);
});

test('credential edits to an OAuth view are rejected without modifying the API source', async t => {
  const options = await fixture(t);
  const { paths } = await setup(options);
  const source = path.join(paths.shared, 'config.toml');
  const target = path.join(paths.official, 'config.toml');
  const before = await fs.readFile(source, 'utf8');
  await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace('requires_openai_auth = true', 'requires_openai_auth = true\nenv_key = "WRONG_KEY"'));
  await assert.rejects(syncShared(paths), /Edit model_providers in the shared API config/);
  assert.equal(await fs.readFile(source, 'utf8'), before);
});

test('invalid TOML in a profile never exposes the credential line in the error', async t => {
  const options = await fixture(t);
  const { paths } = await setup(options);
  await fs.writeFile(path.join(paths.shared, 'broken.config.toml'), 'experimental_bearer_token = "fake-profile-secret" invalid');
  await assert.rejects(syncShared(paths), error => {
    assert.match(error.message, /Cannot parse configuration: broken.config.toml/);
    assert.ok(!error.message.includes('fake-profile-secret'));
    return true;
  });
});

test('deleting an API profile removes only its unchanged generated OAuth view', async t => {
  const options = await fixture(t);
  const { paths } = await setup(options);
  const source = path.join(paths.shared, 'work.config.toml');
  const target = path.join(paths.official, 'work.config.toml');
  await fs.writeFile(source, 'model = "profile-model"\n');
  await syncShared(paths);
  await fs.unlink(source);
  await syncShared(paths);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  assert.ok(await fs.stat(path.join(paths.official, 'config.toml')));
});
