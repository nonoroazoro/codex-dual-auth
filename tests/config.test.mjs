import test from 'node:test';
import assert from 'node:assert/strict';
import { pathsFor, environment, invocation, validateSettings, initialConfig } from '../src/config.mjs';

test('both modes use one provider and SQLite path while scrubbing inherited identity', () => {
  const paths = pathsFor('/tmp/User Home');
  for (const mode of ['api', 'official']) {
    const args = invocation(mode, paths, ['resume', 'test-id']);
    assert.ok(args.includes('--no-daemon'));
    assert.ok(args.includes('model_provider="codex"'));
    assert.ok(args.includes(`sqlite_home=${JSON.stringify(paths.shared)}`));
    assert.deepEqual(args.slice(-2), ['resume', 'test-id']);
    const env = environment(mode, paths, { PATH: 'preserved', OPENAI_API_KEY: 'secret', OPENAI_BASE_URL: 'wrong', CODEX_HOME: 'wrong', OPENAI_IDENTITY_TOKEN_FILE: 'wrong' });
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.OPENAI_BASE_URL, undefined);
    assert.equal(env.OPENAI_IDENTITY_TOKEN_FILE, undefined);
    assert.equal(env.PATH, 'preserved');
    assert.equal(env.CODEX_HOME, mode === 'api' ? paths.shared : paths.official);
  }
  assert.ok(invocation('official', paths, []).some(arg => arg.startsWith('model_providers={"codex"={') && arg.includes('base_url="https://chatgpt.com/backend-api/codex"')));
  assert.ok(!invocation('api', paths, []).some(arg => arg.includes('base_url')));
});

test('provider environment credentials are available only to the API launcher', () => {
  const paths = pathsFor('/tmp/User Home');
  const original = { OPENAI_API_KEY: 'provider-secret' };
  assert.equal(environment('api', paths, original, 'OPENAI_API_KEY').OPENAI_API_KEY, 'provider-secret');
  assert.equal(environment('official', paths, original, 'OPENAI_API_KEY').OPENAI_API_KEY, undefined);
  const api = { provider: 'custom', authMode: 'provider' };
  assert.ok(invocation('api', paths, [], api).includes('model_provider="custom"'));
  const official = invocation('official', paths, [], api);
  assert.ok(official.some(arg => arg.startsWith('model_providers={"custom"={') && arg.includes('requires_openai_auth=true')));
});

test('URL and model inputs cannot inject TOML or contain URL credentials', () => {
  for (const url of ['file:///tmp/key', 'https://secret@example.test', 'https://example.test/?key=x', 'not a URL']) {
    assert.throws(() => validateSettings(url, 'model'));
  }
  assert.throws(() => validateSettings('https://example.test', 'model\nfoo=true'));
  const config = initialConfig(validateSettings('https://example.test/v1/', 'a"b'));
  assert.ok(config.includes('model = "a\\"b"'));
  assert.ok(config.includes('daemon_auto_start = false'));
});
