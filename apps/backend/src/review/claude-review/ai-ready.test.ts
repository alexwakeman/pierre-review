// THE GATES ASK ABOUT THE VENDOR THE RUN WILL USE (Settings → AI → Review), never the default provider:
// `singleReviewProvider` is what the single-run review kinds' readiness, pre-flight and budget gates ask
// about, and `automaticRunAllowed` refuses on THAT vendor's usage limit.
import { afterEach, describe, expect, it } from 'vitest';
import { setStoredAiRunProfiles } from '../../ai/run-profile.js';
import { clearUsageLockout, noteProviderFailure } from '../../ai/usage-lockout.js';
import { automaticRunAllowed } from '../budget-gate.js';
import { singleReviewProvider } from './ai-ready.js';

const ctxWith = (signedIn: ReadonlyArray<'claude' | 'codex'>) => ({
  llm: {
    detectAuth: () => ({ status: 'ok' as const }),
    detectProviderAuth: (p: 'claude' | 'codex') =>
      signedIn.includes(p) ? { status: 'ok' as const } : { status: 'none' as const, message: `${p} is not signed in.` },
  },
});

afterEach(() => {
  setStoredAiRunProfiles(null);
  clearUsageLockout();
});

describe('singleReviewProvider — the vendor the gates ask about', () => {
  it('the first switched-on, signed-in Review vendor (a review block stored)', () => {
    setStoredAiRunProfiles({ review: { claude: { enabled: false } } });
    expect(singleReviewProvider(ctxWith(['claude', 'codex']))).toBe('codex');
    setStoredAiRunProfiles({ review: { claude: { model: 'claude-opus-5-5' } } });
    expect(singleReviewProvider(ctxWith(['codex']))).toBe('codex');
    expect(singleReviewProvider(ctxWith(['claude', 'codex']))).toBe('claude');
  });

  it('⚠ a vendor over its usage limit is passed over for one with capacity', () => {
    setStoredAiRunProfiles({ review: { claude: { model: 'claude-opus-5-5' } } });
    noteProviderFailure('claude', "You've hit your usage limit");
    expect(singleReviewProvider(ctxWith(['claude', 'codex']))).toBe('codex');
  });
});

describe('automaticRunAllowed — the budget and usage-limit gate', () => {
  it('⚠ refuses on the NAMED vendor\'s usage limit, not the default provider\'s', async () => {
    noteProviderFailure('codex', "You've hit your usage limit");
    expect(await automaticRunAllowed({}, 1, 'test', 'codex')).toBe(false);
    expect(await automaticRunAllowed({}, 1, 'test', 'claude')).toBe(true);
    // null ⇒ the caller asks the lock itself.
    expect(await automaticRunAllowed({}, 1, 'test', null)).toBe(true);
  });
});
