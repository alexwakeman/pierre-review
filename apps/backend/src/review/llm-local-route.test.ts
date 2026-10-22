// ONE LOCAL ROUTE, end to end: locally `cheapComplete` with an explicit key on a call marked
// `localRoute: 'agent'` must answer through the Agent SDK, and the metered Anthropic SDK must never be
// loaded or called. An UNMARKED call with a key (Reports, Bots Monitoring) keeps the key's route.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const messagesCreate = vi.fn();
const loadAnthropicSdk = vi.fn(async () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));
const query = vi.fn(() =>
  (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
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

describe('cheapComplete locally', () => {
  beforeEach(() => {
    messagesCreate.mockReset();
    loadAnthropicSdk.mockClear();
    query.mockClear();
  });

  it("ignores a passed key on a call marked localRoute 'agent' and answers through the Agent SDK", async () => {
    const res = await cheapComplete({ prompt: 'hi', apiKey: 'sk-ant-summary', localRoute: 'agent' });
    expect(res.text).toBe('hello');
    expect(query).toHaveBeenCalledTimes(1);
    expect(loadAnthropicSdk).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('keeps the metered key for an unmarked call with a key (Reports, Bots Monitoring)', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'from the api' }],
      usage: { input_tokens: 2, output_tokens: 1 },
    });
    const res = await cheapComplete({ prompt: 'hi', apiKey: 'sk-ant-summary' });
    expect(res.text).toBe('from the api');
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses locally when AI is switched off', async () => {
    const c = config as { aiEnabled: boolean };
    const was = c.aiEnabled;
    c.aiEnabled = false;
    try {
      await expect(cheapComplete({ prompt: 'hi' })).rejects.toThrow('Claude is switched off here.');
      expect(query).not.toHaveBeenCalled();
    } finally {
      c.aiEnabled = was;
    }
  });
});
