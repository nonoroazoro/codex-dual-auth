import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialConfig, pathsFor, validateSettings, environment } from './config.mjs';
import { checkLinkSupport, inspect, transaction } from './files.mjs';
import { findCodex, launcherFiles, verifyCodex, shellProfile, installWindowsPath } from './platform.mjs';
import { checkSharing, syncShared } from './sharing.mjs';
import { readApiConfiguration, completeApiConfiguration } from './api-config.mjs';

const SOURCE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read an installation manifest without trusting arbitrary paths from it.
 * @param {string} home User home.
 */
export async function readInstallation(home) {
  const paths = pathsFor(home);
  if (!await inspect(paths.manifest)) return null;
  const settings = JSON.parse(await fs.readFile(paths.manifest, 'utf8'));
  if (settings.schema !== 1 || settings.home !== paths.home || !path.isAbsolute(settings.binary)) {
    throw new Error(`Invalid installation manifest: ${paths.manifest}`);
  }
  return settings;
}

/**
 * Reuse existing API configuration or safely install into a clean home.
 * @param {object} options Installation inputs. API keys are never placed in the manifest.
 */
export async function setup(options) {
  const paths = pathsFor(options.home);
  if (!await inspect(paths.home)) throw new Error('The selected user home must already exist.');
  const lockPath = path.join(paths.home, '.codex-setup.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another setup may be running. If it has exited, remove ${lockPath} and retry.`);
    throw error;
  }
  const tx = transaction();
  try {
    const existing = await readInstallation(paths.home);
    const api = await readApiConfiguration(paths.home);
    if (existing && !await inspect(path.join(paths.shared, 'config.toml'))) {
      throw new Error('The shared config.toml is missing. Restore it before rerunning setup.');
    }
    const inputs = validateSettings(options.baseUrl ?? api.baseUrl ?? existing?.baseUrl, options.model ?? api.model ?? existing?.model);
    if ((api.baseUrl && inputs.baseUrl !== api.baseUrl.replace(/\/+$/, '')) || (api.model && inputs.model !== api.model)) {
      throw new Error('Supplied API settings differ from existing config.toml. Existing settings were preserved.');
    }
    if (existing && options.codexBin && await findCodex(options.codexBin, paths.bin) !== existing.binary) {
      throw new Error('This installation already uses another Codex binary. Reruns do not switch binaries.');
    }
    const binary = existing?.binary ?? await findCodex(options.codexBin, paths.bin);
    const authPath = path.join(paths.shared, 'auth.json');
    if (!api.hasApiKey && !options.apiKey) throw new Error(api.envKey ? `Set ${api.envKey} before running setup.` : 'An API key is required. Use the hidden prompt or --api-key-stdin.');
    if (api.envKey && !api.hasApiKey) throw new Error(`Set ${api.envKey} before running setup; credentials were not changed.`);
    if (options.apiKey && (!options.apiKey.trim() || /[\r\n\x00]/.test(options.apiKey))) throw new Error('API key must be a non-empty single line.');
    if (await inspect(authPath) && api.authMode === 'file') {
      const auth = JSON.parse(await fs.readFile(authPath, 'utf8'));
      if (!auth.OPENAI_API_KEY || (options.apiKey && auth.OPENAI_API_KEY !== options.apiKey)) {
        throw new Error('Existing auth.json differs from the supplied API credentials. It was not changed.');
      }
    }
    await checkSharing(paths);
    await checkLinkSupport(paths.home);
    const launchers = launcherFiles(paths);
    for (const file of launchers) {
      const target = path.join(paths.bin, file.name);
      if (await inspect(target) && (!existing || await fs.readFile(target, 'utf8') !== file.contents)) {
        throw new Error(`Refusing to overwrite an existing launcher: ${target}`);
      }
    }
    const probe = await fs.mkdtemp(path.join(paths.home, '.codex-probe-'));
    let version;
    try { version = verifyCodex(binary, { ...environment('api', paths), CODEX_HOME: probe }); }
    finally { await fs.rm(probe, { recursive: true, force: true }); }
    for (const directory of [paths.shared, paths.official, paths.runtime, path.join(paths.runtime, 'src'), paths.bin]) await tx.directory(directory);
    if (api.text === null) await tx.file(path.join(paths.shared, 'config.toml'), initialConfig(inputs));
    else {
      const completed = completeApiConfiguration(api, inputs);
      if (completed !== api.text) {
        await tx.file(path.join(paths.runtime, 'config.toml.before-setup'), api.text);
        await tx.replace(path.join(paths.shared, 'config.toml'), api.text, completed);
      }
    }
    if (!api.hasApiKey && !await inspect(authPath)) await tx.file(authPath, JSON.stringify({ OPENAI_API_KEY: options.apiKey }) + '\n');
    // Installed launchers must remain usable after the source checkout is removed.
    const dependency = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('smol-toml'))));
    await _installDependency(dependency, path.join(paths.runtime, 'node_modules', 'smol-toml'), tx);
    for (const name of (await fs.readdir(SOURCE)).filter(name => name.endsWith('.mjs'))) {
      const contents = await fs.readFile(path.join(SOURCE, name));
      const target = path.join(paths.runtime, 'src', name);
      if (!await inspect(target)) await tx.file(target, contents);
      else if (!(await fs.readFile(target)).equals(contents)) throw new Error(`Installed setup implementation differs: ${target}. This command will not overwrite it.`);
    }
    for (const file of launchers) {
      const target = path.join(paths.bin, file.name);
      if (!await inspect(target)) await tx.file(target, file.contents, 0o755);
    }
    await syncShared(paths, tx);
    if (options.installShell && process.platform !== 'win32') {
      const profile = path.join(paths.home, '.zshrc');
      const present = await inspect(profile);
      const before = present ? await fs.readFile(profile, 'utf8') : '';
      const after = shellProfile(before, paths.bin);
      if (!present) await tx.file(profile, after);
      else if (after !== before) await tx.replace(profile, before, after);
    }
    const settings = existing ?? { schema: 1, home: paths.home, binary, ...inputs };
    if (!existing) await tx.file(paths.manifest, JSON.stringify(settings, null, 2) + '\n');
    // This is last because it changes an external user setting rather than tracked files.
    if (options.installShell && process.platform === 'win32') installWindowsPath(paths.bin);
    return { paths, version, existing: Boolean(existing) };
  } catch (error) {
    const failures = await tx.rollback();
    if (failures.length) error.message += `\nRollback needs attention: ${failures.join('; ')}`;
    throw error;
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

async function _installDependency(source, target, tx) {
  await tx.directory(target);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await _installDependency(from, to, tx);
    else {
      const contents = await fs.readFile(from);
      if (!await inspect(to)) await tx.file(to, contents);
      else if (!(await fs.readFile(to)).equals(contents)) throw new Error(`Installed dependency differs: ${to}`);
    }
  }
}
