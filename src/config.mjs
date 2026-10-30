import path from 'node:path';

export const PROVIDER = 'codex';
export const OFFICIAL_URL = 'https://chatgpt.com/backend-api/codex';

/**
 * Resolve installation paths without consulting inherited Codex environment variables.
 * @param {string} home User home to configure.
 */
export function pathsFor(home) {
  const root = path.resolve(home);
  return {
    home: root,
    shared: path.join(root, '.codex'),
    official: path.join(root, '.codex-official'),
    runtime: path.join(root, '.codex-setup'),
    bin: path.join(root, '.local', 'bin'),
    manifest: path.join(root, '.codex-setup', 'settings.json'),
  };
}

/**
 * Validate inputs before any filesystem or credential changes.
 * @param {string} baseUrl API-compatible service URL.
 * @param {string} model Model ID supported by that service.
 */
export function validateSettings(baseUrl, model) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('A valid --base-url is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('The API URL must use HTTP(S), without embedded credentials, a query, or a fragment.');
  }
  if (typeof model !== 'string' || !model.trim() || /[\x00-\x1f]/.test(model)) {
    throw new Error('A non-empty --model without control characters is required.');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), model };
}

/**
 * Generate only clean-install configuration; reruns never regenerate this file.
 * @param {{baseUrl:string, model:string}} settings Validated inputs.
 */
export function initialConfig({ baseUrl, model }) {
  return `# Managed initially by codex-setup. Edit this shared file normally.\ncli_auth_credentials_store = "file"\nmodel_provider = "${PROVIDER}"\nmodel = ${JSON.stringify(model)}\nmodel_reasoning_effort = "high"\n\n[model_providers.${PROVIDER}]\nname = "OpenAI-compatible API"\nbase_url = ${JSON.stringify(baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = true\n\n[features]\ndaemon_auto_start = false\n`;
}

/**
 * Build the same provider identity for both modes while selecting credentials and transport.
 * @param {'api'|'official'} mode Authentication mode.
 * @param {ReturnType<typeof pathsFor>} paths Installed paths.
 * @param {string[]} args User arguments, forwarded without a shell.
 */
export function invocation(mode, paths, args) {
  if (!['api', 'official'].includes(mode)) throw new Error('Unknown authentication mode.');
  const overrides = [
    '--no-daemon', '-c', `model_provider="${PROVIDER}"`,
    '-c', `sqlite_home=${JSON.stringify(paths.shared)}`,
    '-c', `cli_auth_credentials_store="${mode === 'api' ? 'file' : 'keyring'}"`,
    '-c', `forced_login_method="${mode === 'api' ? 'api' : 'chatgpt'}"`,
  ];
  if (mode === 'official') overrides.push('-c', `model_providers.${PROVIDER}.base_url="${OFFICIAL_URL}"`);
  return [...overrides, ...args];
}

/**
 * Prevent inherited credentials or a resumed shell snapshot from selecting the other identity.
 * @param {'api'|'official'} mode Authentication mode.
 * @param {ReturnType<typeof pathsFor>} paths Installed paths.
 * @param {NodeJS.ProcessEnv} original Parent environment.
 */
export function environment(mode, paths, original = process.env) {
  const env = { ...original };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_SELF_HOSTED_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ACCESS_TOKEN', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE']) delete env[key];
  env.CODEX_HOME = mode === 'api' ? paths.shared : paths.official;
  env.CODEX_SQLITE_HOME = paths.shared;
  return env;
}
