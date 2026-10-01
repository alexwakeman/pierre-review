// The CI-analysis fix seed's head pin.
//
// `startFix({ seed: 'ci_analysis' })` reads the stored diagnosis and hands it to the agent. The
// stored row names the commit it diagnosed; if the branch has moved since, that text describes
// code that is gone — and an agent seeded with it costs exactly as much as one seeded with the
// truth. The SPA refuses the click too, but this is the half a direct POST, or a push landing
// between the analysis and the click, still meets.
//
// ⚠ THE REFUSAL SITS BELOW `claimed.add(prId)` IN startFix AND RELEASES THE CLAIM. Nothing
// here can see that (it is the pure decision), so the reminder lives beside the call.
//
//   pnpm --filter @pierre-review/backend test ci-seed-staleness
import { describe, expect, it } from 'vitest';
import { CI_ANALYSIS_CONTRACT_EPOCH_MS } from '@pierre-review/shared';
import { ciSeedDecision } from './manager.js';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

describe('ciSeedDecision', () => {
  it('accepts a diagnosis written against the live head', () => {
    const r = ciSeedDecision({ summary: 'The build fails because…', headSha: HEAD }, HEAD);
    expect(r.ok).toBe(true);
  });

  it('refuses a diagnosis from an earlier commit', () => {
    const r = ciSeedDecision({ summary: 'The build fails because…', headSha: OLD }, HEAD);
    expect(r).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses when there is no stored analysis at all', () => {
    // An empty seed is a PLAIN run wearing the ci_analysis label — not what the caller asked
    // for, and it bills the same.
    expect(ciSeedDecision(undefined, HEAD)).toEqual({ ok: false, reason: 'missing' });
    // No plugin (OSS / npm) or no stored analysis: the provider answers null — still `missing`.
    expect(ciSeedDecision(null, HEAD)).toEqual({ ok: false, reason: 'missing' });
    expect(ciSeedDecision({ summary: '', headSha: HEAD }, HEAD)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('accepts a row with NO head sha — it predates the column and cannot be disproved', () => {
    const r = ciSeedDecision({ summary: 'The build fails because…', headSha: null }, HEAD);
    expect(r.ok).toBe(true);
  });

  it('⚠ refuses a row written under the OLD CAPABILITY CONTRACT, head sha or no head sha', () => {
    // The stored answer describes what this fixer can do, and the payload hash does not include
    // the prompt — so a pre-epoch row still tells the agent to "run the repository's linter/build
    // to validate the fix locally" and to "commit and push", against a run whose tool list denies
    // Bash outright. 17 of 19 rows on one real database said exactly that, 3 of them against a
    // live head. The card marks the same rows out of date off the SAME constant.
    const before = new Date(CI_ANALYSIS_CONTRACT_EPOCH_MS - 1);
    expect(
      ciSeedDecision({ summary: 'The build fails…', headSha: HEAD, createdAt: before }, HEAD),
    ).toEqual({ ok: false, reason: 'stale' });
    const after = new Date(CI_ANALYSIS_CONTRACT_EPOCH_MS);
    expect(
      ciSeedDecision({ summary: 'The build fails…', headSha: HEAD, createdAt: after }, HEAD).ok,
    ).toBe(true);
    // ⚠ AN ABSENT TIMESTAMP IS NOT A CLAIM, the same reading the null head sha gets.
    expect(
      ciSeedDecision({ summary: 'The build fails…', headSha: HEAD, createdAt: null }, HEAD).ok,
    ).toBe(true);
  });

  it('passes the provider text through UNCHANGED — the Pro provider already stripped it', () => {
    // The CONFIDENCE line is display metadata the card renders as chips; feeding it back to the
    // agent invites it to reason about its own scores. The diagnosis is a Pro card, so the plugin's
    // `readCiAnalysisSeed` strips it before it crosses (plugin-providers.ts); pinned plugin-side in
    // packages/pro/test/ci-analysis-brand.test.ts. Core must not re-strip or rewrite it.
    const r = ciSeedDecision({ summary: 'Root cause: the lockfile drifted.', headSha: HEAD }, HEAD);
    expect(r).toEqual({ ok: true, text: 'Root cause: the lockfile drifted.' });
  });
});
