import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { pathsFor, PROVIDER } from './config.mjs';
import { inspect } from './files.mjs';

/**
 * Discover API inputs without printing credentials or changing user files.
 * @param {string} home User home, resolved by {@link pathsFor}.
 */
export async function readApiConfiguration(home) {
  const paths = pathsFor(home);
  const configPath = path.join(paths.shared, 'config.toml');
  const text = await inspect(configPath) ? await fs.readFile(configPath, 'utf8') : null;
  let config = {};
  try { if (text !== null) config = parse(text); }
  catch { throw new Error('Cannot parse existing config.toml. Fix its TOML syntax before setup.'); }
  const profile = config.profile ? config.profiles?.[config.profile] : undefined;
  if (config.profile && !profile) throw new Error('The selected Codex profile does not exist.');
  const provider = profile?.model_provider ?? config.model_provider ?? (text === null ? PROVIDER : 'openai');
  if (typeof provider !== 'string' || !provider.trim() || /[\x00-\x1f]/.test(provider)) throw new Error('Invalid model_provider ID.');
  const info = config.model_providers?.[provider] ?? {};
  const authPath = path.join(paths.shared, 'auth.json');
  let auth;
  try { if (await inspect(authPath)) auth = JSON.parse(await fs.readFile(authPath, 'utf8')); }
  catch { throw new Error('Cannot parse existing auth.json. Fix it before setup.'); }
  const fileKey = typeof auth?.OPENAI_API_KEY === 'string' && Boolean(auth.OPENAI_API_KEY.trim());
  if (fileKey && /[\r\n\x00]/.test(auth.OPENAI_API_KEY)) throw new Error('Existing auth.json contains an invalid API key. Fix it before setup.');
  const envKey = info.env_key ?? (!fileKey && (provider === 'openai' || info.requires_openai_auth === true) && process.env.OPENAI_API_KEY?.trim() ? 'OPENAI_API_KEY' : undefined);
  const providerAuth = Boolean(envKey || info.experimental_bearer_token || info.auth || info.aws);
  const noAuth = !providerAuth && info.requires_openai_auth === false;
  const hasApiKey = providerAuth
    ? Boolean(envKey ? process.env[envKey]?.trim() : true)
    : fileKey || noAuth;
  return {
    text, config, profile, provider, info, authExists: auth !== undefined,
    baseUrl: info.base_url ?? (provider === 'openai' ? process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' : undefined),
    model: profile?.model ?? config.model,
    hasApiKey, envKey,
    authMode: providerAuth || noAuth ? 'provider' : 'file',
  };
}

/**
 * Fill missing API settings, retaining the original bytes when nothing is missing.
 * @param {Awaited<ReturnType<typeof readApiConfiguration>>} api Discovered configuration.
 * @param {{baseUrl:string, model:string}} inputs Validated inputs.
 */
export function completeApiConfiguration(api, inputs) {
  if (api.baseUrl && api.model) return api.text;
  if (!api.model) (api.profile ?? api.config).model = inputs.model;
  if (!api.baseUrl) {
    api.config.model_providers ??= Object.create(null);
    api.config.model_providers[api.provider] ??= { name: 'OpenAI-compatible API', wire_api: 'responses' };
    api.config.model_providers[api.provider].base_url = inputs.baseUrl;
  }
  return stringify(api.config);
}
