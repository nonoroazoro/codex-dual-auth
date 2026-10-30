import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify, TomlError } from 'smol-toml';
import { OFFICIAL_URL } from './config.mjs';
import { inspect, transaction } from './files.mjs';

const HEADER = '# codex-setup OAuth configuration view\n';

/**
 * Identify native base and profile configuration files.
 * @param {string} name Codex home entry.
 */
export function isConfiguration(name) {
  return name === 'config.toml' || name.endsWith('.config.toml');
}

/**
 * Synchronize safe configuration edits while keeping API credentials out of OAuth.
 * @param {object} paths Resolved installation paths.
 * @param {ReturnType<typeof transaction>} tx Owning filesystem transaction.
 */
export async function syncOfficialConfigurations(paths, tx) {
  const lockPath = path.join(paths.home, '.codex-config-sync.lock');
  const lock = await fs.open(lockPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error('Another configuration sync is running. Retry after it finishes.');
    throw error;
  });
  try {
    const names = new Set([
      ...(await fs.readdir(paths.shared)).filter(isConfiguration),
      ...(await fs.readdir(paths.official)).filter(isConfiguration),
    ]);
    for (const name of names) {
      const source = path.join(paths.shared, name);
      const target = path.join(paths.official, name);
      const baseline = path.join(paths.runtime, 'official-config', name);
      const stat = await inspect(target);
      // Never replace an independent OAuth config or an old config symlink in place.
      if (stat?.isSymbolicLink() || (stat && !await inspect(baseline))) {
        throw new Error(`Refusing to overwrite independent OAuth data: ${target}`);
      }
      const current = stat ? await fs.readFile(target, 'utf8') : null;
      if (current !== null && !current.startsWith(HEADER)) throw new Error(`Refusing to overwrite independent OAuth data: ${target}`);
      if (!await inspect(source)) {
        if (name === 'config.toml') throw new Error('The shared config.toml is missing. Restore it before continuing.');
        const previous = await fs.readFile(baseline, 'utf8');
        if (current !== previous) throw new Error(`Concurrent configuration edit: ${name}. Restore the shared profile before continuing.`);
        await tx.remove(target, current);
        await tx.remove(baseline, previous);
        continue;
      }
      const before = await fs.readFile(source, 'utf8');
      let config;
      try {
        config = parse(before);
        if (current !== null) {
          const previous = parse(await fs.readFile(baseline, 'utf8'));
          const edited = parse(current);
          // Providers contain mode-specific transport and credentials, so edits belong in the API source.
          if (!isDeepStrictEqual(previous.model_providers, edited.model_providers)) {
            throw new Error('Edit model_providers in the shared API config instead of the OAuth view.');
          }
          delete previous.model_providers;
          delete edited.model_providers;
          _mergeEdits(previous, edited, config);
        }
      } catch (error) {
        // TOML parser errors may include a line containing credentials.
        if (error instanceof TomlError) throw new Error(`Cannot parse configuration: ${name}`);
        throw error;
      }
      const after = current !== null && !isDeepStrictEqual(parse(before), config) ? stringify(config) : before;
      if (after !== before) await tx.replace(source, before, after);
      const view = parse(after);
      if (view.model_providers) {
        view.model_providers = Object.fromEntries(Object.keys(view.model_providers).map(id => [id, {
          name: 'OpenAI', base_url: OFFICIAL_URL, wire_api: 'responses', requires_openai_auth: true,
        }]));
      }
      const contents = HEADER + stringify(view);
      await tx.directory(path.dirname(baseline));
      await _writeView(target, current, contents, tx);
      await _writeView(baseline, await inspect(baseline) ? await fs.readFile(baseline, 'utf8') : null, contents, tx);
    }
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

async function _writeView(target, before, after, tx) {
  if (before === null) await tx.file(target, after);
  else if (before !== after) await tx.replace(target, before, after);
}

function _mergeEdits(before, edited, current, prefix = '') {
  for (const key of new Set([...Object.keys(before), ...Object.keys(edited)])) {
    if (isDeepStrictEqual(before[key], edited[key])) continue;
    const name = prefix + key;
    if (_isTable(before[key]) && _isTable(edited[key]) && _isTable(current[key])) {
      _mergeEdits(before[key], edited[key], current[key], name + '.');
    } else {
      if (!isDeepStrictEqual(current[key], before[key]) && !isDeepStrictEqual(current[key], edited[key])) {
        throw new Error(`Concurrent configuration edit: ${name}. Resolve it in the shared config.`);
      }
      if (Object.hasOwn(edited, key)) current[key] = edited[key];
      else delete current[key];
    }
  }
}

function _isTable(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}
