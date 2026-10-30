import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { findCodex } from '../src/platform.mjs';

const binary = await findCodex(process.env.CODEX_TEST_BINARY, path.join(os.tmpdir(), 'not-a-launcher-directory'));
const result = spawnSync(process.execPath, ['--test', 'tests/native.test.mjs'], {
  stdio: 'inherit', env: { ...process.env, CODEX_TEST_BINARY: binary },
});
process.exitCode = result.status ?? 1;
