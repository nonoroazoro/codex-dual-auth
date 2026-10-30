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
 * @param {object} api Existing provider settings discovered by setup.
 */
export function invocation(mode, paths, args, api = {}) {
  if (!['api', 'official'].includes(mode)) throw new Error('Unknown authentication mode.');
  const provider = api.provider ?? PROVIDER;
  const overrides = [
    '--no-daemon', '-c', `model_provider=${JSON.stringify(provider)}`,
    '-c', `sqlite_home=${JSON.stringify(paths.shared)}`,
    '-c', `cli_auth_credentials_store="${mode === 'api' ? 'file' : 'keyring'}"`,
    '-c', `forced_login_method="${mode === 'api' ? 'api' : 'chatgpt'}"`,
  ];
  if (mode === 'official') {
    // Credential fields are removed from the OAuth config view before native overrides are merged.
    overrides.push('-c', `model_providers={${JSON.stringify(provider)}={name="OpenAI",base_url="${OFFICIAL_URL}",wire_api="responses",requires_openai_auth=true}}`);
    overrides.push('-c', `openai_base_url="${OFFICIAL_URL}"`);
  } else if (api.authMode === 'file') {
    overrides.push('-c', `model_providers={${JSON.stringify(provider)}={requires_openai_auth=true}}`);
  }
  return [...overrides, ...args];
}

/**
 * Prevent inherited credentials or a resumed shell snapshot from selecting the other identity.
 * @param {'api'|'official'} mode Authentication mode.
 * @param {ReturnType<typeof pathsFor>} paths Installed paths.
 * @param {NodeJS.ProcessEnv} original Parent environment.
 * @param {string|undefined} envKey Current API provider's credential variable.
 */
export function environment(mode, paths, original = process.env, envKey) {
  const env = { ...original };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_SELF_HOSTED_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ACCESS_TOKEN', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE']) delete env[key];
  if (envKey) {
    delete env[envKey];
    if (mode === 'api' && original[envKey]) env[envKey] = original[envKey];
  }
  env.CODEX_HOME = mode === 'api' ? paths.shared : paths.official;
  env.CODEX_SQLITE_HOME = paths.shared;
  return env;
}
