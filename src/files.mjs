import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Inspect a path, including a dangling symbolic link.
 * @param {string} target Filesystem path.
 */
export async function inspect(target) {
  try { return await fs.lstat(target); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Track only this invocation's writes so rollback cannot remove unrelated user data.
 */
export function transaction() {
  const undo = [];
  return {
    async directory(target) {
      if (await inspect(target)) {
        if (!(await fs.stat(target)).isDirectory()) throw new Error(`Not a directory: ${target}`);
        return;
      }
      await this.directory(path.dirname(target));
      await fs.mkdir(target, { mode: 0o700 });
      undo.push(() => fs.rmdir(target));
    },
    async file(target, contents, mode = 0o600) {
      await fs.writeFile(target, contents, { flag: 'wx', mode });
      const expected = _digest(contents);
      undo.push(async () => {
        if (_digest(await fs.readFile(target)) === expected) await fs.unlink(target);
      });
    },
    async link(source, target, platform = process.platform) {
      const kind = (await fs.stat(source)).isDirectory() ? (platform === 'win32' ? 'junction' : 'dir') : 'file';
      await fs.symlink(source, target, kind);
      undo.push(async () => {
        if ((await inspect(target))?.isSymbolicLink()) await fs.unlink(target);
      });
    },
    async replace(target, before, after) {
      // Refuse concurrent edits and roll back only content still owned by this transaction.
      if (await fs.readFile(target, 'utf8') !== before) throw new Error(`Changed during setup: ${target}`);
      await _replaceFile(target, before, after);
      undo.push(async () => {
        if (await fs.readFile(target, 'utf8') === after) await _replaceFile(target, after, before);
      });
    },
    async remove(target, before) {
      if (await fs.readFile(target, 'utf8') !== before) throw new Error(`Changed during setup: ${target}`);
      const mode = (await fs.stat(target)).mode & 0o777;
      await fs.unlink(target);
      undo.push(async () => {
        if (!await inspect(target)) await fs.writeFile(target, before, { flag: 'wx', mode });
      });
    },
    async rollback() {
      const errors = [];
      for (const action of undo.reverse()) {
        try { await action(); } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) errors.push(error.message);
        }
      }
      return errors;
    },
  };
}

/**
 * Detect unsupported Windows file links before installing or writing credentials.
 * @param {string} home Existing user home.
 */
export async function checkLinkSupport(home) {
  const temp = await fs.mkdtemp(path.join(home, '.codex-link-check-'));
  try {
    const source = path.join(temp, 'source');
    await fs.writeFile(source, 'link check');
    await fs.symlink(source, path.join(temp, 'link'), 'file');
  } catch (error) {
    throw new Error('File symbolic links are required. On Windows, enable Developer Mode or rerun setup from an Administrator terminal. No security policy was changed.', { cause: error });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

function _digest(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

async function _replaceFile(target, before, after) {
  const resolved = await fs.realpath(target);
  const temporary = resolved + '.codex-setup-' + crypto.randomBytes(8).toString('hex');
  try {
    const stat = await fs.stat(resolved);
    await fs.writeFile(temporary, after, { flag: 'wx', mode: stat.mode & 0o777 });
    if (await fs.readFile(resolved, 'utf8') !== before) throw new Error(`Changed during setup: ${target}`);
    await fs.rename(temporary, resolved);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
