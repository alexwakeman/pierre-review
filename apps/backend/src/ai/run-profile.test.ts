// THE RUN PROFILES' ONE RESOLVER (ai/run-profile.ts + ai/effort.ts `agenticRunEffort(…, surface)`):
//   1. NULL = today, exactly: the default provider, the usual models, the old single level everywhere;
//   2. the review per vendor: its own model and effort (diff-only steps down per vendor), switched-off
//      vendors leave the pair, "one vendor" = the first on and signed in;
//   3. AI Fix / Implement story: their vendor, else (signed out or over its limit) the other signed-in
//      vendor at ITS usual model and Default effort; a manual pick of the other vendor runs at its Default;
//   4. REVIEW_EFFORT / REVIEW_DIFF_ONLY_EFFORT win everywhere;
//   5. the validator keeps one review vendor on; Build rounds default 5, from Settings.
import { afterEach, describe, expect, it } from 'vitest';
import { parseAiRunProfiles, resolveAiRunProfiles, STORY_BUILD_LOOP_ROUNDS_DEFAULT, type AiProviderId, type AiRunKind } from '@pierre-review/shared';
import { agenticRunEffort, setStoredAiEffort, surfaceEffortLevel } from './effort.js';
import {
  buildChoice,
  buildLoopRounds,
  fixChoice,
  reviewDefaultProvider,
  reviewPairProviders,
  reviewProfileFor,
  reviewProvidersEnabled,
  reviewRunModel,
  setStoredAiRunProfiles,
} from './run-profile.js';
import { activeProviderId } from './provider-setting.js';
import { pairProvidersReady } from '../review/claude-review/pair.js';

const NO_ENV = {} as NodeJS.ProcessEnv;
const both = (_p: AiProviderId, _k: AiRunKind) => ({ status: 'ok' as const });
const only = (who: AiProviderId) => (p: AiProviderId, _k: AiRunKind) => ({ status: p === who ? ('ok' as const) : ('none' as const) });
const free = () => false;

afterEach(() => {
  setStoredAiRunProfiles(null);
  setStoredAiEffort(null);
});

describe('NULL profiles = today', () => {
  it('every surface: the default provider, the usual model, the old level', () => {
    setStoredAiEffort('high');
    expect(reviewDefaultProvider(both)).toBe(activeProviderId());
    expect(reviewProvidersEnabled()).toEqual(['claude', 'codex']);
    expect(reviewRunModel('claude')).toBe('claude-opus-5-5');
    expect(reviewRunModel('codex')).toBe('claude-opus-5-5');
    expect(fixChoice(both, 'fix', free)).toEqual({ provider: activeProviderId(), model: null, configured: false, fellBack: false });
    expect(buildChoice(both, 'story_build', free)).toEqual({ provider: activeProviderId(), model: null, configured: false, fellBack: false });
    for (const surface of ['review', 'fix', 'build'] as const) {
      for (const p of ['claude', 'codex'] as const) expect(agenticRunEffort(p, { role: 'deep' }, 'worktree', NO_ENV, surface)).toBe('high');
    }
    expect(buildLoopRounds()).toBe(STORY_BUILD_LOOP_ROUNDS_DEFAULT);
    expect(STORY_BUILD_LOOP_ROUNDS_DEFAULT).toBe(5);
  });

  it('a block that names no effort still reads the old level', () => {
    setStoredAiEffort('low');
    setStoredAiRunProfiles({ review: { codex: { model: 'gpt-6.1-terra' } }, fix: { provider: 'claude' } });
    expect(surfaceEffortLevel('review', 'codex', NO_ENV)).toBe('low');
    expect(surfaceEffortLevel('fix', 'claude', NO_ENV)).toBe('low');
  });
});

describe('the review profile', () => {
  it('each vendor its own model and effort (the halves may differ)', () => {
    setStoredAiRunProfiles({ review: { claude: { model: 'claude-sonnet-5', effort: 'max' }, codex: { effort: 'low' } } });
    expect(reviewProfileFor('claude')).toEqual({ enabled: true, model: 'claude-sonnet-5', effort: 'max' });
    expect(reviewRunModel('claude')).toBe('claude-sonnet-5');
    expect(reviewRunModel('codex')).toBe('claude-opus-5-5');
    expect(agenticRunEffort('claude', { role: 'standard' }, 'worktree', NO_ENV)).toBe('max');
    expect(agenticRunEffort('codex', { role: 'deep' }, 'worktree', NO_ENV)).toBe('low');
  });

  it('diff-only steps down PER VENDOR, from that vendor\'s level', () => {
    setStoredAiRunProfiles({ review: { claude: { effort: 'xhigh' }, codex: { effort: 'max' } } });
    expect(agenticRunEffort('claude', { role: 'deep' }, 'diff_only', NO_ENV)).toBe('high');
    expect(agenticRunEffort('codex', { role: 'deep' }, 'diff_only', NO_ENV)).toBe('xhigh');
  });

  it('effort null is Default, not the old level', () => {
    setStoredAiEffort('max');
    setStoredAiRunProfiles({ review: { claude: { effort: null } } });
    expect(agenticRunEffort('claude', { role: 'deep' }, 'worktree', NO_ENV)).toBe('medium');
    expect(agenticRunEffort('codex', { role: 'deep' }, 'worktree', NO_ENV)).toBe('max');
  });

  it('THE PAIR RESOLVER: switched on AND signed in', () => {
    expect(reviewPairProviders(both)).toEqual(['claude', 'codex']);
    expect(reviewPairProviders(only('codex'))).toEqual(['codex']);
    setStoredAiRunProfiles({ review: { claude: { enabled: false } } });
    expect(reviewPairProviders(both)).toEqual(['codex']);
    expect(pairProvidersReady((p) => both(p, 'review'))).toEqual(['codex']);
    expect(reviewPairProviders(only('claude'))).toEqual([]);
  });

  it('"one vendor" = the first switched on and signed in (Claude before Codex)', () => {
    setStoredAiRunProfiles({ review: { claude: { enabled: true } } });
    expect(reviewDefaultProvider(both)).toBe('claude');
    expect(reviewDefaultProvider(only('codex'))).toBe('codex');
    setStoredAiRunProfiles({ review: { claude: { enabled: false } } });
    expect(reviewDefaultProvider(both)).toBe('codex');
    expect(reviewDefaultProvider(only('claude'))).toBe('codex');
  });

  it('"one vendor" moves off a vendor over its usage limit, as the default provider does', () => {
    setStoredAiRunProfiles({ review: { claude: { enabled: true } } });
    const claudeLocked = (p: 'claude' | 'codex') => p === 'claude';
    expect(reviewDefaultProvider(both, claudeLocked)).toBe('codex');
    // The other one cannot run ⇒ the locked one (the gate then skips an automatic run).
    expect(reviewDefaultProvider(only('claude'), claudeLocked)).toBe('claude');
    expect(reviewDefaultProvider(both, () => true)).toBe('claude');
  });
});

describe('AI Fix / Implement story', () => {
  it('the stored vendor, model and effort', () => {
    setStoredAiRunProfiles({ fix: { provider: 'codex', model: 'gpt-6.1-terra', effort: 'xhigh' } });
    expect(fixChoice(both, 'fix', free)).toEqual({ provider: 'codex', model: 'claude-sonnet-5', configured: true, fellBack: false });
    expect(agenticRunEffort('codex', { role: 'standard' }, 'worktree', NO_ENV, 'fix')).toBe('xhigh');
  });

  it('signed out ⇒ the other signed-in vendor at its usual model and Default effort', () => {
    setStoredAiEffort('max');
    setStoredAiRunProfiles({ build: { provider: 'codex', model: 'gpt-6.1-terra', effort: 'xhigh' } });
    expect(buildChoice(only('claude'), 'story_build', free)).toEqual({ provider: 'claude', model: null, configured: true, fellBack: true });
    expect(agenticRunEffort('claude', { role: 'deep' }, 'worktree', NO_ENV, 'build')).toBe('medium');
  });

  it('over its usage limit ⇒ the other vendor too; neither can run ⇒ the stored one (its pre-flight says why)', () => {
    setStoredAiRunProfiles({ fix: { provider: 'claude', model: 'claude-sonnet-5' } });
    expect(fixChoice(both, 'fix', (p) => p === 'claude').provider).toBe('codex');
    expect(fixChoice(() => ({ status: 'none' }), 'fix', free)).toEqual({ provider: 'claude', model: 'claude-sonnet-5', configured: true, fellBack: false });
  });

  it('a manual pick of the OTHER vendor runs at that vendor\'s Default', () => {
    setStoredAiRunProfiles({ fix: { provider: 'claude', effort: 'max' } });
    expect(agenticRunEffort('claude', { role: 'deep' }, 'worktree', NO_ENV, 'fix')).toBe('max');
    expect(agenticRunEffort('codex', { role: 'deep' }, 'worktree', NO_ENV, 'fix')).toBe('high');
  });

  it('the surfaces are separate: the fix profile never reaches the review or the build', () => {
    setStoredAiRunProfiles({ fix: { provider: 'claude', effort: 'max' } });
    expect(agenticRunEffort('claude', { role: 'deep' }, 'worktree', NO_ENV, 'review')).toBe('medium');
    expect(agenticRunEffort('claude', { role: 'deep' }, 'worktree', NO_ENV, 'build')).toBe('medium');
  });

  it('the Build rounds: Settings, else 5', () => {
    setStoredAiRunProfiles({ build: { rounds: 2 } });
    expect(buildLoopRounds()).toBe(2);
  });
});

describe('the environment wins everywhere', () => {
  it('REVIEW_EFFORT over every profile; REVIEW_DIFF_ONLY_EFFORT over every diff-only review', () => {
    setStoredAiRunProfiles({ review: { claude: { effort: 'low' } }, fix: { provider: 'claude', effort: 'low' }, build: { provider: 'claude', effort: 'low' } });
    const env = { REVIEW_EFFORT: 'xhigh' } as NodeJS.ProcessEnv;
    for (const s of ['review', 'fix', 'build'] as const) expect(agenticRunEffort('claude', { role: 'deep' }, 'worktree', env, s)).toBe('xhigh');
    expect(agenticRunEffort('claude', { role: 'deep' }, 'diff_only', { REVIEW_DIFF_ONLY_EFFORT: 'max' } as NodeJS.ProcessEnv)).toBe('max');
    expect(resolveAiRunProfiles({ review: { claude: { effort: 'low' } } }, { legacyEffort: null, envEffort: 'xhigh', defaultProvider: 'claude' }).effortSource).toBe('env');
  });
});

describe('the validator', () => {
  it('keeps at least one review vendor on', () => {
    expect(parseAiRunProfiles({ review: { claude: { enabled: false }, codex: { enabled: false } } }).ok).toBe(false);
    expect(parseAiRunProfiles({ review: { claude: { enabled: false } } }).ok).toBe(true);
  });

  it('compacts empty blocks and keeps an explicit null effort', () => {
    expect(parseAiRunProfiles({ review: { claude: {} }, fix: { effort: null } })).toEqual({ ok: true, value: { fix: { effort: null } } });
  });
});
