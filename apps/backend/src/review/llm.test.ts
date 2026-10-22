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

// Which path the ladder's answer takes: the login → the Agent SDK, the key → the API, nothing →
// refused. No caller passes a key of its own any more.
describe('cheapRoute', () => {
  it('maps each rung of the ladder to its path', () => {
    expect(cheapRoute({ route: 'login', method: 'ambient' })).toBe('agent');
    expect(cheapRoute({ route: 'login', method: 'oauth_token' })).toBe('agent');
    expect(cheapRoute({ route: 'api_key', method: 'api_key', apiKey: 'k' })).toBe('api');
    expect(cheapRoute({ route: 'none' })).toBe('none');
  });
});
