import { ImageGenError } from './errors.js';
import type { ImageModelRegistry } from './types.js';

const AUTH_CLAIM = 'https://api.openai.com/auth';

export type CodexAuth = {
  headers: Record<string, string>;
};

export function extractCodexAccountId(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) throw new Error('malformed JWT');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const claim = payload[AUTH_CLAIM];
    if (!claim || typeof claim !== 'object') throw new Error('missing auth claim');
    const accountId = (claim as Record<string, unknown>).chatgpt_account_id;
    if (typeof accountId !== 'string' || accountId.trim() === '') {
      throw new Error('missing account id');
    }
    return accountId;
  } catch {
    throw invalidLoginError();
  }
}

export async function resolveCodexAuth(registry: ImageModelRegistry): Promise<CodexAuth> {
  const model = registry
    .getAvailable()
    .filter((candidate) => candidate.provider === 'openai-codex')
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!model || !isConfirmedOAuth(registry, model)) {
    throw new ImageGenError(
      'No ChatGPT Plus/Pro Codex login is available. Run /login and select ChatGPT Plus/Pro (Codex).',
      'Codex login missing',
    );
  }

  let resolved: Awaited<ReturnType<ImageModelRegistry['getApiKeyAndHeaders']>>;
  try {
    resolved = await registry.getApiKeyAndHeaders(model);
  } catch {
    throw invalidLoginError();
  }
  if (!resolved.ok || !resolved.apiKey) throw invalidLoginError();

  const token = resolved.apiKey;
  return {
    headers: {
      ...withoutProtectedHeaders(resolved.headers),
      authorization: `Bearer ${token}`,
      'ChatGPT-Account-ID': extractCodexAccountId(token),
      originator: 'pi',
      'content-type': 'application/json',
      accept: 'application/json',
    },
  };
}

export function withoutProtectedCodexHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return withoutProtectedHeaders(headers);
}

function withoutProtectedHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const protectedNames = new Set([
    'authorization',
    'content-type',
    'chatgpt-account-id',
    'originator',
    'accept',
  ]);
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => !protectedNames.has(name.toLowerCase())),
  );
}

function isConfirmedOAuth(
  registry: ImageModelRegistry,
  model: ReturnType<ImageModelRegistry['getAvailable']>[number],
): boolean {
  if (!registry.isUsingOAuth) return false;
  try {
    return registry.isUsingOAuth(model);
  } catch {
    return false;
  }
}

function invalidLoginError(): ImageGenError {
  return new ImageGenError(
    'The ChatGPT Codex login is invalid or expired. Run /login and sign in to ChatGPT Plus/Pro again.',
    'Codex login invalid',
  );
}
