import { describe, expect, it, vi } from 'vitest';
import { extractCodexAccountId, resolveCodexAuth } from '../codex-auth.js';

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

describe('codex-auth', () => {
  it('extracts the ChatGPT account id from the access token', () => {
    const token = jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' },
    });
    expect(extractCodexAccountId(token)).toBe('acct-123');
  });

  it('resolves and refreshes Pi openai-codex authentication', async () => {
    const token = jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' },
    });
    const codexModel = { id: 'gpt-5-codex', provider: 'openai-codex' };
    const getApiKeyAndHeaders = vi.fn().mockResolvedValue({
      ok: true,
      apiKey: token,
      headers: { 'x-openai-client': 'pi-test' },
    });

    const auth = await resolveCodexAuth({
      getAvailable: () => [{ id: 'other', provider: 'openai' }, codexModel],
      getApiKeyAndHeaders,
    });

    expect(getApiKeyAndHeaders).toHaveBeenCalledWith(codexModel);
    expect(auth.headers).toMatchObject({
      authorization: `Bearer ${token}`,
      'ChatGPT-Account-ID': 'acct-123',
      'x-openai-client': 'pi-test',
    });
  });

  it('gives an actionable error when Pi has no Codex login', async () => {
    await expect(
      resolveCodexAuth({ getAvailable: () => [], getApiKeyAndHeaders: vi.fn() }),
    ).rejects.toThrow(/\/login.*ChatGPT Plus\/Pro/i);
  });

  it('rejects malformed or incomplete tokens without exposing them', () => {
    expect(() => extractCodexAccountId('secret-token')).toThrow(/sign in.*again/i);
  });
});
