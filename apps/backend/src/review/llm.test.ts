// The cheap seam's per-model request shape. The current Haiku thinks by default and its thinking
// counts toward max_tokens, so a small cap would stop before any text: it must go out at low
// effort with headroom added. Any other model keeps the plain request.
import { describe, expect, it } from 'vitest';
import { cheapRequestShape, cheapRoute } from './llm.js';

describe('cheapRequestShape', () => {
  it('gives the current Haiku low effort and thinking headroom', () => {
    expect(cheapRequestShape('claude-haiku-5-5', 700)).toEqual({ maxTokens: 1724, effort: 'low' });
  });

  it('leaves another model untouched', () => {
    expect(cheapRequestShape('claude-sonnet-5', 700)).toEqual({ maxTokens: 700 });
  });
});

// ONE LOCAL ROUTE for the one-shot features: locally a call marked `localRoute: 'agent'` never
// reaches the metered API, even with SUMMARY_ANTHROPIC_API_KEY. Reports / Bots Monitoring (unmarked)
// keep the key's route.
describe('cheapRoute', () => {
  it("takes the Agent SDK for a call marked localRoute 'agent', even with a key", () => {
    expect(cheapRoute('sk-ant-summary', 'agent')).toBe('agent');
    expect(cheapRoute(undefined, 'agent')).toBe('agent');
  });

  it('keeps the API for an unmarked call with a key; no key is always the Agent SDK', () => {
    expect(cheapRoute('sk-ant-summary')).toBe('api');
    expect(cheapRoute(undefined)).toBe('agent');
    expect(cheapRoute('')).toBe('agent');
  });
});
