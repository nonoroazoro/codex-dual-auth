import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspect } from './files.mjs';

const START = '# >>> codex-setup >>>';
const END = '# <<< codex-setup <<<';

/**
 * Resolve one real Codex executable for both launchers, including npm installations on Windows.
 * @param {string|undefined} explicit Optional path to an executable or npm JavaScript entry.
 * @param {string} bin Managed launcher directory, excluded from discovery.
 */
export async function findCodex(explicit, bin) {
  const candidates = explicit ? [path.resolve(explicit)] : (process.env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir))
    .flatMap(dir => process.platform === 'win32'
      ? ['codex.exe', 'codex.cmd', 'codex.ps1'].map(name => path.join(dir, name))
      : [path.join(dir, 'codex')]);
  for (let candidate of candidates) {
    if (path.resolve(path.dirname(candidate)) === path.resolve(bin) || !await inspect(candidate)) continue;
    if (/\.(cmd|ps1)$/i.test(candidate)) {
      candidate = path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (!await inspect(candidate)) continue;
    }
    const resolved = await fs.realpath(candidate);
    const fd = await fs.open(resolved);
    const bytes = Buffer.alloc(256);
    try { await fd.read(bytes, 0, bytes.length, 0); } finally { await fd.close(); }
    if (bytes.toString().includes('codex-setup managed launcher')) continue;
    // Preserve a package manager's stable symlink so upgrades do not strand the launcher.
    return path.resolve(candidate);
  }
  throw new Error('Codex was not found. Install @openai/codex first, or pass --codex-bin pointing to the real executable or codex.js.');
}

/**
 * Launch npm JavaScript entries without cmd.exe or a shell interpreting user arguments.
 * @param {string} binary Real Codex entry point.
 * @param {string[]} args Codex arguments.
 */
export function binaryCommand(binary, args) {
  return /\.[cm]?js$/i.test(binary) ? { command: process.execPath, args: [binary, ...args] } : { command: binary, args };
}

/**
 * Require the native no-daemon interface used by the installed wrappers.
 * @param {string} binary Real Codex entry.
 * @param {NodeJS.ProcessEnv} env Isolated probe environment.
 */
export function verifyCodex(binary, env) {
  const version = _probe(binary, ['--version'], env);
  const help = _probe(binary, ['--help'], env);
  if (!/codex/i.test(version) || !help.includes('--no-daemon')) {
    throw new Error('This Codex version does not support --no-daemon. Update Codex before setup.');
  }
  return version.trim();
}

/**
 * Render launchers using the same Node runtime and installed implementation.
 * @param {object} paths Installation paths.
 * @param {string} platform Target platform.
 */
export function launcherFiles(paths, platform = process.platform) {
  const cli = path.join(paths.runtime, 'src', 'cli.mjs');
  const commands = [['codex', 'api'], ['codex-official', 'official']];
  return commands.map(([name, mode]) => ({
    name: name + (platform === 'win32' ? '.cmd' : ''),
    contents: platform === 'win32'
      ? `@echo off\r\nrem codex-setup managed launcher\r\nsetlocal DisableDelayedExpansion\r\n"${_batch(process.execPath)}" "${_batch(cli)}" run ${mode} "${_batch(paths.manifest)}" %*\r\nexit /b %errorlevel%\r\n`
      : `#!/bin/sh\n# codex-setup managed launcher\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} run ${mode} ${shellQuote(paths.manifest)} "$@"\n`,
  }));
}

/**
 * Quote one POSIX shell argument.
 * @param {string} value Literal value.
 */
export function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/**
 * Add a single managed PATH block, preserving unrelated profile content.
 * @param {string} contents Current shell profile.
 * @param {string} bin Launcher directory.
 */
export function shellProfile(contents, bin) {
  const block = `${START}\nexport PATH=${shellQuote(bin)}:"$PATH"\n${END}`;
  if (contents.includes(START) || contents.includes(END)) {
    if (!contents.includes(block)) throw new Error('The managed shell profile block was edited. Restore it or configure PATH manually.');
    return contents;
  }
  if (/^\s*(?:alias\s+codex=|(?:function\s+)?codex\s*\(\))/m.test(contents)) {
    throw new Error('An existing codex alias/function shadows the launcher. Remove it yourself or omit --install-shell.');
  }
  return contents + (contents && !contents.endsWith('\n') ? '\n' : '') + `\n${block}\n`;
}

/**
 * Update only the current user's Windows PATH, without admin elevation or execution-policy changes.
 * @param {string} bin Launcher directory.
 */
export function installWindowsPath(bin) {
  const literal = "'" + bin.replaceAll("'", "''") + "'";
  const script = `$ErrorActionPreference = 'Stop'; $b = ${literal}; $old = [Environment]::GetEnvironmentVariable('Path', 'User'); $parts = @($old -split ';' | Where-Object { $_ -and $_ -ne $b }); $new = (@($b) + $parts) -join ';'; if ($new -ne $old) { [Environment]::SetEnvironmentVariable('Path', $new, 'User') }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Could not update the user PATH. Add ${bin} to your user PATH manually.`);
}

function _batch(value) {
  if (/[\r\n"]/.test(value)) throw new Error('Unsupported character in a Windows launcher path.');
  return value.replaceAll('%', '%%');
}

function _probe(binary, args, env) {
  const command = binaryCommand(binary, args);
  const result = spawnSync(command.command, command.args, { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (result.status !== 0) throw new Error(`Codex ${args[0]} could not run. Check --codex-bin and the Codex installation.`);
  return result.stdout;
}
