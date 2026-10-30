import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Create a fake installed CLI, never using the developer's real credentials or homes.
 * @param {import('node:test').TestContext} t Owning test.
 */
export async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-setup-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'User Home');
  await fs.mkdir(home);
  const codexBin = path.join(directory, 'fake codex.mjs');
  await fs.writeFile(codexBin, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('codex-cli 0.166.0');
else if (args.includes('--help')) console.log('Usage: codex --no-daemon');
else if (args.includes('login') && args.includes('status')) {
  console.log(args.includes('cli_auth_credentials_store="keyring"') ? 'Logged in using ChatGPT' : 'API key configured');
} else {
  console.log(JSON.stringify({ args, home: process.env.CODEX_HOME, sqlite: process.env.CODEX_SQLITE_HOME,
    leakedApi: process.env.OPENAI_API_KEY ?? null, leakedUrl: process.env.OPENAI_BASE_URL ?? null }));
}
`);
  return { directory, home, codexBin, baseUrl: 'https://api.example.test/v1', model: 'test-model', apiKey: 'test-only-api-key' };
}
