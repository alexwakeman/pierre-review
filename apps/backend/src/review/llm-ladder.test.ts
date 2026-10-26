// THE ONE LADDER, end to end through `cheapComplete` and the platform's clients (makeHaikuClient,
// makeReportClient — every report, synthesis, work-plan, pointer, bot-theme, impact-note, refine
// and Slack call goes through one of the two):
//   • login present → the Agent SDK, with ANTHROPIC_API_KEY hidden from the run;
//   • no login + key → the Anthropic API with that key;
//   • LIMN_AI_USE_API_KEY=true → the key first, even with a login;
//   • LIMN_AI_DISABLED (config.aiEnabled false) → refused, nothing loaded.
// HOME points at an empty temp dir so the real machine's Claude login never leaks in; the login is
// simulated with CLAUDE_CODE_OAUTH_TOKEN.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messagesCreate = vi.fn();
const anthropicCtor = vi.fn();
const loadAnthropicSdk = vi.fn(async () => ({
  default: class {
    messages = { create: messagesCreate };
    constructor(opts: unknown) {
      anthropicCtor(opts);
    }
  },
}));
const query = vi.fn((_args: { options: { env?: Record<string, string | undefined> } }) =>
  (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'from the login' }] } };
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 3, output_tokens: 1 } };
  })(),
);
const loadAgentSdk = vi.fn(async () => ({ query }));

vi.mock('../ai/runtime.js', () => ({
  loadAnthropicSdk,
  loadAgentSdk,
  claudeExecutableOptions: () => ({}),
}));

const { cheapComplete } = await import('./llm.js');
const { config } = await import('../config.js');
const { makeHaikuClient, makeReportClient } = await import('../platform/llm/seam.js');
type Ctx = Parameters<typeof makeHaikuClient>[0];
const ctx = { llm: { complete: cheapComplete, detectAuth: () => ({ status: 'ok' }) } } as unknown as Ctx;

const KEYS = ['HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'LIMN_AI_USE_API_KEY'] as const;
let saved: Record<string, string | undefined> = {};
let home = '';

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), 'limn-ladder-'));
  process.env.HOME = home;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.LIMN_AI_USE_API_KEY;
  messagesCreate.mockReset();
  messagesCreate.mockResolvedValue({
    content: [{ type: 'text', text: 'from the api' }],
    usage: { input_tokens: 2, output_tokens: 1 },
  });
  anthropicCtor.mockClear();
  loadAnthropicSdk.mockClear();
  query.mockClear();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

describe('cheapComplete — the ladder', () => {
  it('login present → the Agent SDK, and the run never sees the API key', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const res = await cheapComplete({ prompt: 'hi' });
    expect(res.text).toBe('from the login');
    expect(query).toHaveBeenCalledTimes(1);
    const env = query.mock.calls[0]![0].options.env!;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
    expect(loadAnthropicSdk).not.toHaveBeenCalled();
  });

  it('no login + key → the Anthropic API with that key, loaded through ai/runtime.ts', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const res = await cheapComplete({ prompt: 'hi' });
    expect(res.text).toBe('from the api');
    expect(loadAnthropicSdk).toHaveBeenCalledTimes(1);
    expect(anthropicCtor).toHaveBeenCalledWith({ apiKey: 'sk-ant-env' });
    expect(query).not.toHaveBeenCalled();
  });

  it('LIMN_AI_USE_API_KEY=true → the key first, even with a login', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    process.env.LIMN_AI_USE_API_KEY = 'true';
    const res = await cheapComplete({ prompt: 'hi' });
    expect(res.text).toBe('from the api');
    expect(query).not.toHaveBeenCalled();
  });

  it('no credential at all → refused with the one auth line, nothing loaded', async () => {
    await expect(cheapComplete({ prompt: 'hi' })).rejects.toThrow('Sign in to Claude Code or set ANTHROPIC_API_KEY');
    expect(query).not.toHaveBeenCalled();
    expect(loadAnthropicSdk).not.toHaveBeenCalled();
  });

  it('switched off → refused on every rung', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const c = config as { aiEnabled: boolean };
    const was = c.aiEnabled;
    c.aiEnabled = false;
    try {
      await expect(cheapComplete({ prompt: 'hi' })).rejects.toThrow('AI is switched off here.');
      process.env.LIMN_AI_USE_API_KEY = 'true';
      await expect(cheapComplete({ prompt: 'hi' })).rejects.toThrow('AI is switched off here.');
      expect(query).not.toHaveBeenCalled();
      expect(messagesCreate).not.toHaveBeenCalled();
    } finally {
      c.aiEnabled = was;
    }
  });
});

describe('the platform clients take the same ladder', () => {
  it('makeHaikuClient: login → the Agent SDK, even with a key set (no per-feature key)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const out = await makeHaikuClient(ctx).complete({ system: 's', user: 'u', maxTokens: 100 });
    expect(out.text).toBe('from the login');
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('makeHaikuClient: no login + key → the API', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const out = await makeHaikuClient(ctx).complete({ system: 's', user: 'u', maxTokens: 100 });
    expect(out.text).toBe('from the api');
    expect(query).not.toHaveBeenCalled();
  });

  it('makeReportClient (Reports): login → the Agent SDK, not a meter', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const out = await makeReportClient(ctx, 'claude-haiku-5-5').complete({ system: 's', user: 'u', maxTokens: 100 });
    expect(out.text).toBe('from the login');
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('makeReportClient: opt-in → the key', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    process.env.LIMN_AI_USE_API_KEY = 'true';
    const out = await makeReportClient(ctx, 'claude-haiku-5-5').complete({ system: 's', user: 'u', maxTokens: 100 });
    expect(out.text).toBe('from the api');
  });

  it('nothing in the backend reads SUMMARY_ANTHROPIC_API_KEY any more', async () => {
    const { readFileSync } = await import('node:fs');
    const seam = readFileSync(new URL('../platform/llm/seam.ts', import.meta.url), 'utf8');
    expect(seam).not.toContain('SUMMARY_ANTHROPIC_API_KEY');
  });
});
