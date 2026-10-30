import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathsFor, environment, invocation } from './config.mjs';
import { binaryCommand, launcherFiles } from './platform.mjs';
import { readInstallation } from './setup.mjs';
import { checkSharing, syncShared, linkMatches, isShared } from './sharing.mjs';

/**
 * Execute a mode with shared state and process-local authentication overrides.
 * @param {'api'|'official'} mode Authentication mode.
 * @param {string} home Installed user home.
 * @param {string[]} args Codex CLI arguments.
 */
export async function launch(mode, home, args) {
  const settings = await readInstallation(home);
  if (!settings) throw new Error('Run codex-setup setup first.');
  const paths = pathsFor(home);
  await syncShared(paths);
  const command = binaryCommand(settings.binary, invocation(mode, paths, args));
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, { stdio: 'inherit', env: environment(mode, paths), windowsHide: false });
    // The terminal sends Ctrl+C to both processes. Keep the wrapper alive for the child's exit.
    const interrupt = () => {};
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}

/**
 * Check installation structure and local login status without sending inference requests.
 * @param {string} home Installed user home.
 */
export async function doctor(home) {
  const settings = await readInstallation(home);
  if (!settings) throw new Error('No managed installation found.');
  const paths = pathsFor(home);
  await checkSharing(paths);
  const checks = [];
  for (const name of (await fs.readdir(paths.shared)).filter(isShared)) {
    if (!await linkMatches(path.join(paths.shared, name), path.join(paths.official, name))) {
      checks.push({ ok: false, message: `Missing shared mapping: ${name}. Run setup again.` });
    }
  }
  for (const file of launcherFiles(paths)) {
    const installed = await fs.readFile(path.join(paths.bin, file.name), 'utf8').catch(() => '');
    checks.push({ ok: installed === file.contents, message: `${file.name} launcher` });
  }
  checks.push({ ok: true, message: 'Both launchers use the same Codex binary, provider ID, and SQLite home; --no-daemon is enforced.' });
  for (const mode of ['api', 'official']) {
    const command = binaryCommand(settings.binary, invocation(mode, paths, ['login', 'status']));
    const result = spawnSync(command.command, command.args, { env: environment(mode, paths), encoding: 'utf8', timeout: 15000, windowsHide: true });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    const ok = result.status === 0 && (mode === 'api' ? /API key/i : /ChatGPT/i).test(output);
    checks.push({ ok, message: `${mode} authentication${ok ? '' : `: run ${mode === 'api' ? 'codex login --with-api-key' : 'codex-official login'}`}` });
  }
  return checks;
}
