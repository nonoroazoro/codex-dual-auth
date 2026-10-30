import fs from 'node:fs/promises';
import path from 'node:path';
import { inspect, transaction } from './files.mjs';
import { isConfiguration, syncOfficialConfigurations } from './official-config.mjs';

const DIRECTORIES = ['sessions', 'archived_sessions', 'skills', 'plugins', 'rules', 'shell_snapshots', 'thread-writer-locks', 'tmp', '.tmp', 'log', 'cache'];

/**
 * Keep credentials, provider model catalogs and daemon endpoints isolated; SQLite has its own shared directory setting.
 * @param {string} name Top-level Codex home entry.
 */
export function isShared(name) {
  return !(isConfiguration(name) || /^auth\.json(?:\.|$)/.test(name) || /\.sqlite(?:-wal|-shm|-journal)?$/.test(name)
    || ['models_cache.json', 'app-server-control', 'app-server-daemon', '.DS_Store', 'backup', 'backup.zip'].includes(name));
}

/**
 * Verify that an existing entry refers to the authoritative shared path.
 * @param {string} source Authoritative entry.
 * @param {string} target OAuth home entry.
 */
export async function linkMatches(source, target) {
  const stat = await inspect(target);
  if (!stat?.isSymbolicLink()) return false;
  const linked = path.resolve(path.dirname(target), await fs.readlink(target));
  return _normalized(linked) === _normalized(source);
}

/**
 * Preflight all conflicts before creating any new mappings.
 * @param {object} paths Installation paths.
 */
export async function checkSharing(paths) {
  const entries = await fs.readdir(paths.official).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of entries.filter(isShared)) {
    if (!await linkMatches(path.join(paths.shared, name), path.join(paths.official, name))) {
      throw new Error(`Refusing to overwrite independent OAuth data: ${path.join(paths.official, name)}. Resolve this conflict manually; no files were merged.`);
    }
  }
}

/**
 * Link shared data without copying or replacing existing files.
 * @param {object} paths Installation paths.
 * @param {ReturnType<typeof transaction>} tx Optional setup transaction.
 */
export async function syncShared(paths, tx) {
  const own = !tx;
  tx ??= transaction();
  try {
    await checkSharing(paths);
    await tx.directory(paths.shared);
    await tx.directory(paths.official);
    for (const name of DIRECTORIES) await tx.directory(path.join(paths.shared, name));
    for (const name of ['history.jsonl', 'session_index.jsonl']) {
      const source = path.join(paths.shared, name);
      if (!await inspect(source)) await tx.file(source, '');
    }
    for (const name of (await fs.readdir(paths.shared)).filter(isShared)) {
      const source = path.join(paths.shared, name);
      const target = path.join(paths.official, name);
      if (!await inspect(target)) await tx.link(source, target);
      else if (!await linkMatches(source, target)) throw new Error(`Shared path conflict: ${target}`);
    }
    await syncOfficialConfigurations(paths, tx);
  } catch (error) {
    if (own) await tx.rollback();
    throw error;
  }
}

function _normalized(value) {
  const result = path.resolve(value).replace(/^\\\\\?\\/, '');
  return process.platform === 'win32' ? result.toLowerCase() : result;
}
