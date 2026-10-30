import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialConfig, pathsFor, validateSettings, environment } from './config.mjs';
import { checkLinkSupport, inspect, transaction } from './files.mjs';
import { findCodex, launcherFiles, verifyCodex, shellProfile, installWindowsPath } from './platform.mjs';
import { checkSharing, syncShared } from './sharing.mjs';

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
 * Install into a clean home or safely verify an already managed installation.
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
    if (!existing && await inspect(path.join(paths.shared, 'config.toml'))) {
      throw new Error('Existing unmanaged config.toml found. Setup targets a clean Codex configuration and will not overwrite it.');
    }
    if (existing && !await inspect(path.join(paths.shared, 'config.toml'))) {
      throw new Error('The shared config.toml is missing. Restore it before rerunning setup.');
    }
    const inputs = validateSettings(options.baseUrl ?? existing?.baseUrl, options.model ?? existing?.model);
    if (existing && (inputs.baseUrl !== existing.baseUrl || inputs.model !== existing.model)) {
      throw new Error('This installation is already configured. Edit the shared config.toml to change URL/model; setup will not replace it.');
    }
    if (existing && options.codexBin && await findCodex(options.codexBin, paths.bin) !== existing.binary) {
      throw new Error('This installation already uses another Codex binary. Reruns do not switch binaries.');
    }
    const binary = existing?.binary ?? await findCodex(options.codexBin, paths.bin);
    const authPath = path.join(paths.shared, 'auth.json');
    if (!await inspect(authPath) && !options.apiKey) throw new Error('An API key is required. Use the hidden prompt or --api-key-stdin.');
    if (options.apiKey && (!options.apiKey.trim() || /[\r\n\x00]/.test(options.apiKey))) throw new Error('API key must be a non-empty single line.');
    if (await inspect(authPath)) {
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
    if (!existing) await tx.file(path.join(paths.shared, 'config.toml'), initialConfig(inputs));
    if (!await inspect(authPath)) await tx.file(authPath, JSON.stringify({ OPENAI_API_KEY: options.apiKey }) + '\n');
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
