#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { setup, readInstallation } from './setup.mjs';
import { launch, doctor } from './launch.mjs';
import { pathsFor } from './config.mjs';
import { readApiConfiguration } from './api-config.mjs';

const HELP = `Usage:
  node src/cli.mjs setup [options]
  node src/cli.mjs doctor [--home PATH]
  codex setup [options]                 (after installation)
  codex doctor                         (setup diagnostics)

Setup options:
  --base-url URL       Your OpenAI-compatible API endpoint
  --model ID           A model available on both services
  --api-key-stdin      Read the API key from stdin, never from command arguments
  --codex-bin PATH     Existing Codex executable or npm codex.js
  --home PATH          User home to configure (default: OS user home)
  --install-shell     Add launchers to zsh/user PATH (default)
  --no-install-shell  Leave shell/user PATH unchanged
  --login             Start the normal browser OAuth login after setup

Requires Node.js 22+ and an installed Codex CLI supporting --no-daemon.
Windows file links require Developer Mode or an Administrator terminal.
Existing API settings and credentials are reused. Only missing API inputs are requested.
`;

/**
 * Dispatch setup commands separately from native Codex arguments.
 * @param {string[]} argv Command-line arguments.
 * @param {object} io Optional terminal interaction overrides.
 */
export async function main(argv, io = {}) {
  if (argv[0] === 'run') {
    const [, mode, manifest, ...args] = argv;
    const home = path.dirname(path.dirname(manifest));
    if (pathsFor(home).manifest !== path.resolve(manifest)) throw new Error('Invalid launcher manifest path.');
    if (mode === 'api' && ['setup', 'doctor'].includes(args[0])) return main([args[0], '--home', home, ...args.slice(1)], io);
    return launch(mode, home, args);
  }
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  const [command, ...args] = argv;
  if (!['setup', 'doctor'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const { values } = parseArgs({ args, options: {
    home: { type: 'string', default: os.homedir() },
    'base-url': { type: 'string' }, model: { type: 'string' },
    'api-key-stdin': { type: 'boolean' }, 'codex-bin': { type: 'string' },
    'install-shell': { type: 'boolean' }, 'no-install-shell': { type: 'boolean' }, login: { type: 'boolean' },
  } });
  if (command === 'doctor') {
    const checks = await doctor(values.home);
    for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.message}`);
    return checks.every(check => check.ok) ? 0 : 1;
  }
  const existing = await readInstallation(values.home);
  const api = await readApiConfiguration(values.home);
  const options = {
    home: values.home, baseUrl: values['base-url'] ?? api.baseUrl ?? existing?.baseUrl,
    model: values.model ?? api.model ?? existing?.model,
    codexBin: values['codex-bin'], installShell: values['install-shell'],
  };
  if (values['api-key-stdin']) options.apiKey = (await _readStdin()).replace(/(?:\r?\n)+$/, '');
  const interactive = io.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (interactive) {
    await promptApiInputs(options, api, io.question);
  }
  if (values['install-shell'] && values['no-install-shell']) throw new Error('Choose either --install-shell or --no-install-shell.');
  options.installShell = !values['no-install-shell'];
  const result = await setup(options);
  console.log(`${result.existing ? 'Verified existing' : 'Installed'} configuration for ${result.version}.`);
  console.log(`Shared data: ${result.paths.shared}`);
  console.log(`Launchers: ${result.paths.bin}`);
  console.log('Open a new terminal after changing PATH. Existing aliases/functions may shadow the launchers.');
  if (!options.installShell) console.log(`Add ${result.paths.bin} before the existing Codex directory in PATH.`);
  if (values.login) {
    return launch('official', values.home, ['login']);
  }
  console.log('Run codex for API access or codex-official for ChatGPT. ChatGPT sign-in is handled when needed.');
  return 0;
}

/**
 * Ask only for missing API inputs discovered by {@link readApiConfiguration}.
 * @param {object} options Setup inputs, filled in place.
 * @param {object} api Existing API configuration.
 * @param {Function} question Prompt implementation, including hidden credential input.
 */
export async function promptApiInputs(options, api, question = _question) {
  if (!api.hasApiKey && !options.apiKey) {
    if (api.envKey) throw new Error(`Set ${api.envKey} before running setup; the existing provider uses this environment variable.`);
    if (api.authExists) throw new Error('Existing auth.json has no API key. Configure API authentication before setup; existing credentials were preserved.');
  }
  options.baseUrl ??= api.baseUrl ?? await question('API base URL: ');
  options.model ??= api.model ?? await question('Shared model ID: ');
  if (!options.apiKey && !api.hasApiKey) options.apiKey = await question('API key (hidden): ', true);
}

async function _question(prompt, secret = false) {
  const output = secret ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
  if (secret) process.stdout.write(prompt);
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController();
  rl.on('SIGINT', () => controller.abort());
  try { return await rl.question(secret ? '' : prompt, { signal: controller.signal }); }
  finally { rl.close(); if (secret) process.stdout.write('\n'); }
}

async function _readStdin() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 65536) throw new Error('API key input is too large.');
  }
  return input;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(`Setup error: ${error.message}`);
    process.exitCode = 1;
  });
}
