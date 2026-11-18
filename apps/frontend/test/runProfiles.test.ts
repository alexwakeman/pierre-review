// SETTINGS → AI's RUN PROFILES on the SPA side (docs/CLAUDE-REVIEW.md § The run profiles):
//   1. the run menus OPEN on the surface's profile (AI Review: the "one vendor" at its model, or the pair;
//      AI Fix and Implement story: their vendor and model) and a pick overrides the model for one run;
//   2. the pair = the review vendors switched on AND signed in (the server's `reviewPairProviders`);
//   3. a Settings block writes back ITS surface only (a missing AI Fix block stays missing), never the
//      environment's effort, and the last review vendor on cannot be switched off.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend runProfiles
import { describe, expect, it } from 'vitest';
import { resolveAiRunProfiles, type AiKindStatus, type AiRunKind, type AiRunProfiles, type MeResponse } from '@pierre-review/shared';
import { pairReviewReady, reviewOneVendor, reviewPairVendors } from '../src/lib/aiCapabilities.js';
import { PAIR_PICK_VALUE, profileOpening, resolveModelPick, resolveReviewModelPick } from '../src/lib/modelPick.js';
import { isLastReviewVendorOn, meWithRunProfiles, withReviewVendor, withSurfaceChoice } from '../src/lib/runProfiles.js';

const KINDS: AiRunKind[] = ['review', 'review_chat', 'fix', 'plan', 'story_build', 'story_plan', 'complete'];
const kinds = (s: AiKindStatus): Record<AiRunKind, AiKindStatus> =>
  Object.fromEntries(KINDS.map((k) => [k, s])) as Record<AiRunKind, AiKindStatus>;

function me(stored: AiRunProfiles | null, o: { codex?: boolean; envEffort?: boolean } = {}): MeResponse {
  const ok = { auth: 'ok' as const, message: null };
  const none = { auth: 'none' as const, message: 'no' };
  return {
    ai: {
      enabled: true,
      runtime: 'ready',
      runtimeMessage: null,
      auth: 'ok',
      authMessage: null,
      provider: 'claude',
      providerSetting: { value: 'auto', source: 'settings' },
      runProfiles: resolveAiRunProfiles(stored, { legacyEffort: null, envEffort: o.envEffort ? 'high' : null, defaultProvider: 'claude' }),
      providers: {
        claude: { auth: 'ok', route: 'login', message: null, runtime: 'ready' },
        codex: {
          runtime: 'ready',
          runtimeMessage: null,
          auth: o.codex ? 'ok' : 'none',
          route: o.codex ? 'login' : 'none',
          signedIn: !!o.codex,
          plan: null,
          available: !!o.codex,
          message: null,
          kinds: kinds(o.codex ? ok : none),
        },
      },
    },
  } as unknown as MeResponse;
}

describe('the run menus open on Settings', () => {
  it('AI Fix and Implement story open on their profile; a pick overrides it for one run', () => {
    const m = me({ fix: { provider: 'codex', model: 'gpt-6.1-terra' }, build: { provider: 'claude', model: 'claude-sonnet-5' } }, { codex: true });
    expect(resolveModelPick(m, 'fix', 'claude-opus-5-5', null).chosen).toMatchObject({ provider: 'codex', model: 'gpt-6.1-terra' });
    expect(resolveModelPick(m, 'plan', 'claude-opus-5-5', null).chosen).toMatchObject({ provider: 'codex', model: 'gpt-6.1-terra' });
    expect(resolveModelPick(m, 'story_build', 'claude-opus-5-5', null).chosen).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5' });
    expect(resolveModelPick(m, 'fix', 'claude-opus-5-5', 'claude:claude-sonnet-5').chosen).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5' });
  });

  it('a profile vendor that cannot run ⇒ the first ready provider at the usual depth', () => {
    const m = me({ fix: { provider: 'codex', model: 'gpt-6.1-terra' } });
    expect(resolveModelPick(m, 'fix', 'claude-opus-5-5', null).chosen).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
  });

  it('no profiles (an older server) ⇒ as before', () => {
    const m = me(null);
    delete (m.ai as { runProfiles?: unknown }).runProfiles;
    expect(profileOpening(m, 'fix')).toBeNull();
    expect(resolveModelPick(m, 'fix', 'claude-opus-5-5', null).chosen).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
  });

  it('AI Review: the pair while both are on and signed in, else the one vendor at its model', () => {
    expect(resolveReviewModelPick(me(null, { codex: true }), 'claude-opus-5-5', null).chosen.value).toBe(PAIR_PICK_VALUE);
    const claudeOff = me({ review: { claude: { enabled: false }, codex: { model: 'gpt-6.1-terra' } } }, { codex: true });
    const pick = resolveReviewModelPick(claudeOff, 'claude-opus-5-5', null);
    expect(pick.pairOffered).toBe(false);
    expect(pick.chosen).toMatchObject({ provider: 'codex', model: 'gpt-6.1-terra' });
  });
});

describe('the pair and the one vendor', () => {
  it('switched on AND signed in', () => {
    expect(reviewPairVendors(me(null, { codex: true }))).toEqual(['claude', 'codex']);
    expect(pairReviewReady(me(null, { codex: true }))).toBe(true);
    expect(reviewPairVendors(me(null))).toEqual(['claude']);
    expect(pairReviewReady(me({ review: { codex: { enabled: false } } }, { codex: true }))).toBe(false);
  });

  it('"one vendor": the default provider with no Review block, else the first on and signed in', () => {
    expect(reviewOneVendor(me(null, { codex: true }))).toBe('claude');
    expect(reviewOneVendor(me({ review: { claude: { enabled: false } } }, { codex: true }))).toBe('codex');
  });
});

describe('a Settings block writes its own surface', () => {
  const status = (stored: AiRunProfiles | null, envEffort = false) => me(stored, { codex: true, envEffort }).ai.runProfiles!;

  it('a review change leaves a missing AI Fix block missing', () => {
    const next = withReviewVendor(status(null), 'codex', { effort: 'low' });
    expect(next).toEqual({
      review: { claude: { enabled: true, model: 'claude-opus-5-5', effort: null }, codex: { enabled: true, model: 'gpt-6.1-sol', effort: 'low' } },
    });
  });

  it('a new vendor opens on its usual model; the rounds stay', () => {
    expect(withSurfaceChoice(status({ build: { rounds: 2 } }), 'build', { provider: 'codex' })).toEqual({
      build: { provider: 'codex', model: 'gpt-6.1-sol', effort: null, rounds: 2 },
    });
  });

  it('under REVIEW_EFFORT the env level is never copied in', () => {
    const next = withSurfaceChoice(status(null, true), 'fix', { model: 'claude-sonnet-5' });
    expect(next).toEqual({ fix: { provider: 'claude', model: 'claude-sonnet-5' } });
  });

  it('the last vendor on is locked on', () => {
    const s = status({ review: { codex: { enabled: false } } });
    expect(isLastReviewVendorOn(s, 'claude')).toBe(true);
    expect(isLastReviewVendorOn(s, 'codex')).toBe(false);
  });
});

describe('the save shows its new value at once (no jump back mid-save)', () => {
  it('the optimistic /api/me carries the profiles about to be saved, resolved by the shared fold', () => {
    const before = me(null);
    const next = withSurfaceChoice(before.ai!.runProfiles!, 'build', { rounds: 3 });
    const after = meWithRunProfiles(before, next)!;
    expect(after.ai!.runProfiles!.build.rounds).toBe(3);
    expect(after.ai!.runProfiles!.stored).toEqual(next);
    // Everything else in /api/me is kept as it was.
    expect(after.ai!.provider).toBe(before.ai!.provider);
    // No profiles on the wire (an older server): unchanged.
    const old = { ai: { ...before.ai, runProfiles: undefined } } as unknown as MeResponse;
    expect(meWithRunProfiles(old, next)).toBe(old);
  });
});
