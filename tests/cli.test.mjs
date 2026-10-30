import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { main, promptApiInputs } from '../src/cli.mjs';
import { setup } from '../src/setup.mjs';
import { pathsFor, initialConfig } from '../src/config.mjs';
import { fixture } from './helpers.mjs';

test('complete existing API access requires no questions', async () => {
  const options = {};
  await promptApiInputs(options, { baseUrl: 'https://example.test/v1', model: 'existing', hasApiKey: true }, () => {
    assert.fail('No prompt is needed, including OAuth and PATH prompts');
  });
  assert.deepEqual(options, { baseUrl: 'https://example.test/v1', model: 'existing' });
});

test('interactive setup with complete existing API access asks no questions', async t => {
  const options = await fixture(t);
  const paths = pathsFor(options.home);
  await fs.mkdir(paths.shared);
  await fs.writeFile(path.join(paths.shared, 'config.toml'), initialConfig(options));
  await fs.writeFile(path.join(paths.shared, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: options.apiKey }));
  const result = await main(['setup', '--home', options.home, '--codex-bin', options.codexBin, '--no-install-shell'], {
    interactive: true, question: () => assert.fail('Complete setup needs no questions'),
  });
  assert.equal(result, 0);
});

test('interactive rerun asks only for a removed API key and restores it', async t => {
  const options = await fixture(t);
  const { paths } = await setup(options);
  await fs.unlink(path.join(paths.shared, 'auth.json'));
  const prompts = [];
  await main(['setup', '--home', options.home, '--no-install-shell'], {
    interactive: true,
    question: async (prompt, secret) => {
      prompts.push(prompt);
      assert.equal(secret, true);
      return options.apiKey;
    },
  });
  assert.deepEqual(prompts, ['API key (hidden): ']);
  assert.equal(JSON.parse(await fs.readFile(path.join(paths.shared, 'auth.json'), 'utf8')).OPENAI_API_KEY, options.apiKey);
});

test('only missing API inputs are requested and key entry is hidden', async () => {
  for (const [api, expected] of [
    [{ baseUrl: 'https://example.test', hasApiKey: true }, ['Shared model ID: ']],
    [{ model: 'existing', hasApiKey: true }, ['API base URL: ']],
    [{ baseUrl: 'https://example.test', model: 'existing' }, ['API key (hidden): ']],
  ]) {
    const prompts = [];
    await promptApiInputs({}, api, async (prompt, secret) => {
      prompts.push(prompt);
      if (prompt.includes('key')) assert.equal(secret, true);
      return 'test-input';
    });
    assert.deepEqual(prompts, expected);
  }
});

test('existing OAuth credentials are preserved instead of asking for another key', async () => {
  await assert.rejects(promptApiInputs({}, { authExists: true }, () => assert.fail('No prompt expected')), /existing credentials were preserved/);
});
