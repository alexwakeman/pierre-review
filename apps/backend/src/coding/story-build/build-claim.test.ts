// THE BUILD CLAIM'S PURE FOLD (coding/story-build/build-claim.ts): only a pending line holds; the lease runs
// from the claimant's newest line; the earliest live claim wins; this machine's own heads are left out;
// a lapsed claim is still shown (Clear frees it); the placeholder trailer; the lines' free wording.
import { describe, expect, it } from 'vitest';
import {
  BUILD_CLAIM_LEASE_MS,
  buildClearedLine,
  buildExpiredLine,
  buildLostLine,
  buildReleaseLine,
  buildingLine,
  builtLine,
  claimWinner,
  claimsOf,
  decideBuildClaim,
  isFreeBuildLine,
  isPlaceholderMessage,
  placeholderMessage,
  toStoryBuildTeamClaim,
  type BuildClaimAnchor,
} from './build-claim.js';

const NOW = 10_000_000_000;
const MIN = 60_000;
let id = 1;
const line = (login: string, state: string, description: string, agoMs: number) => ({ id: id++, state, description, createdAtMs: NOW - agoMs, login });
const anchor = (name: string, lines: BuildClaimAnchor['lines'], sha = `${name}-sha`): BuildClaimAnchor => ({ owner: 'acme', name, sha, placeholder: true, lines });

describe('the lines', () => {
  it('reads every release and the done line as free, and only a plain pending line as a claim', () => {
    expect(isFreeBuildLine({ state: 'pending', description: buildingLine('robin', 'PAY-1') })).toBe(false);
    for (const d of [builtLine('robin', 'PAY-1'), buildReleaseLine('robin', 'build ended'), buildLostLine('robin', 'alex'), buildExpiredLine('alex', 'robin'), buildClearedLine('alex')]) {
      expect(isFreeBuildLine({ state: 'success', description: d }), d).toBe(true);
    }
    // A pending line in the free wording (an older build's) holds nothing either.
    expect(isFreeBuildLine({ state: 'pending', description: buildReleaseLine('robin', 'x') })).toBe(true);
  });
  it('marks a placeholder commit by its trailer, never by its subject alone', () => {
    expect(isPlaceholderMessage(placeholderMessage('alex', 'PAY-1'))).toBe(true);
    expect(isPlaceholderMessage('Ensemble: building PAY-1')).toBe(false);
    expect(isPlaceholderMessage('fix: things\n\nEnsemble-Claim: build')).toBe(true);
    expect(isPlaceholderMessage(null)).toBe(false);
  });
  it('keeps every line inside GitHub’s 140 characters', () => {
    expect(buildingLine('a'.repeat(100), 'K'.repeat(80)).length).toBeLessThanOrEqual(140);
  });
});

describe('the fold', () => {
  it('is free with no line, a settled line, or a released one', () => {
    expect(decideBuildClaim([], 'alex', NOW)).toEqual({ kind: 'free' });
    expect(decideBuildClaim([anchor('api', [line('robin', 'pending', buildingLine('robin', 'PAY-1'), 20 * MIN), line('robin', 'success', builtLine('robin', 'PAY-1'), MIN)])], 'alex', NOW)).toEqual({ kind: 'free' });
    expect(decideBuildClaim([anchor('api', [line('robin', 'success', buildReleaseLine('robin', 'build paused'), MIN)])], 'alex', NOW).kind).toBe('free');
  });

  it("holds the ticket for a teammate's live claim, the lease from their NEWEST line", () => {
    const d = decideBuildClaim(
      [anchor('api', [line('robin', 'pending', buildingLine('robin', 'PAY-1'), 50 * MIN), line('robin', 'pending', buildingLine('robin', 'PAY-1'), 5 * MIN)])],
      'alex',
      NOW,
    );
    expect(d.kind).toBe('held');
    if (d.kind !== 'held') return;
    expect(d.mine).toBe(false);
    expect(d.claim.live).toBe(true);
    expect(d.claim.sinceMs).toBe(NOW - 50 * MIN); // the run of pending lines started then
    expect(d.claim.leaseEndsAtMs).toBe(NOW - 5 * MIN + BUILD_CLAIM_LEASE_MS);
    expect(toStoryBuildTeamClaim(d)).toMatchObject({ login: 'robin', mine: false, live: true, repo: 'acme/api' });
  });

  it('shows a LAPSED claim as not live (Clear frees it) rather than hiding it', () => {
    const d = decideBuildClaim([anchor('api', [line('robin', 'pending', buildingLine('robin', 'PAY-1'), BUILD_CLAIM_LEASE_MS + MIN)])], 'alex', NOW);
    expect(d.kind === 'held' && d.claim.live).toBe(false);
    expect(d.kind === 'held' && d.claim.login).toBe('robin');
  });

  it('names the reader’s own claim from ANOTHER computer as mine, and leaves this machine’s own heads out', () => {
    const a = anchor('api', [line('Alex', 'pending', buildingLine('Alex', 'PAY-1'), MIN)]);
    const d = decideBuildClaim([a], 'alex', NOW);
    expect(d.kind === 'held' && d.mine).toBe(true);
    expect(decideBuildClaim([a], 'alex', NOW, (c) => c.sha === a.sha)).toEqual({ kind: 'free' });
  });

  it('the EARLIEST live claim wins across repositories; a lapsed one never beats a live one', () => {
    const anchors = [
      anchor('web', [line('robin', 'pending', buildingLine('robin', 'PAY-1'), 3 * MIN)]),
      anchor('api', [line('alex', 'pending', buildingLine('alex', 'PAY-1'), 2 * MIN)]),
      anchor('old', [line('sam', 'pending', buildingLine('sam', 'PAY-1'), BUILD_CLAIM_LEASE_MS + 5 * MIN)]),
    ];
    expect(claimWinner(anchors, NOW)?.login).toBe('robin');
    const d = decideBuildClaim(anchors, 'alex', NOW);
    expect(d.kind === 'held' && d.claim.login).toBe('robin');
    expect(claimsOf(anchors, NOW).map((c) => [c.login, c.live])).toEqual([
      ['robin', true],
      ['alex', true],
      ['sam', false],
    ]);
  });

  it('a claimant’s run of pending lines ends at a free line (a Clear, then a new claim)', () => {
    const d = decideBuildClaim(
      [
        anchor('api', [
          line('robin', 'pending', buildingLine('robin', 'PAY-1'), 40 * MIN),
          line('alex', 'success', buildExpiredLine('alex', 'robin'), 20 * MIN),
          line('robin', 'pending', buildingLine('robin', 'PAY-1'), 2 * MIN),
        ]),
      ],
      'alex',
      NOW,
    );
    expect(d.kind === 'held' && d.claim.sinceMs).toBe(NOW - 2 * MIN);
  });
});
