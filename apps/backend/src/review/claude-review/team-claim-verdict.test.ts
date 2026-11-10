// A TEAMMATE'S VERDICT ON A PR ITS AUTHOR'S OWN LIMN APPROVED (docs/TEAM-REVIEW.md § 4): exactly one
// teammate's Limn takes the head, through the ordinary team claim, and another may take over once the
// claimer goes quiet past the lease. The claim fold is `decideTeamClaim` (team-claim.ts).
//
//   pnpm --filter @pierre-review/backend test claude-review/team-claim-verdict
import { describe, expect, it } from 'vitest';
import { decideTeamClaim, reviewingLine, TEAM_CLAIM_LEASE_MS, type TeamClaimLine } from './team-claim.js';

const T0 = Date.UTC(2026, 10, 10, 9, 0);
let nextId = 1;
const line = (login: string, atMs: number, state = 'pending', description = reviewingLine(login, 'claude')): TeamClaimLine => ({
  id: nextId++,
  state,
  description,
  createdAtMs: atMs,
  login,
});

describe("a teammate's verdict on an author-approved PR", () => {
  // alex wrote the PR; his own Limn reviewed it (and claimed, as every Limn does). robin and sam both
  // have auto review on.
  const authorClaim = line('alex', T0);
  const authorDone = line('alex', T0 + 60_000, 'success', 'alex reviewed · no comments');

  it("the author's own Limn never holds the head: the first teammate is free to claim", () => {
    expect(decideTeamClaim([authorClaim, authorDone], 'robin', T0 + 120_000, 'alex')).toEqual({ kind: 'free' });
  });

  it('exactly one teammate takes it: the earliest live claim wins, the other stands down', () => {
    const lines = [authorClaim, authorDone, line('robin', T0 + 120_000), line('sam', T0 + 120_500)];
    expect(decideTeamClaim(lines, 'robin', T0 + 121_000, 'alex')).toEqual({ kind: 'mine' });
    expect(decideTeamClaim(lines, 'sam', T0 + 121_000, 'alex')).toMatchObject({ kind: 'reviewing', login: 'robin' });
  });

  it('a claimer who goes quiet past the lease is taken over; a renewed one is not', () => {
    const lines = [authorClaim, authorDone, line('robin', T0 + 120_000)];
    expect(decideTeamClaim(lines, 'sam', T0 + 120_000 + TEAM_CLAIM_LEASE_MS - 1, 'alex')).toMatchObject({ kind: 'reviewing' });
    expect(decideTeamClaim(lines, 'sam', T0 + 120_000 + TEAM_CLAIM_LEASE_MS, 'alex')).toEqual({ kind: 'free' });
    const renewed = [...lines, line('robin', T0 + 120_000 + 8 * 60_000)];
    expect(decideTeamClaim(renewed, 'sam', T0 + 120_000 + TEAM_CLAIM_LEASE_MS, 'alex')).toMatchObject({ kind: 'reviewing', login: 'robin' });
  });

  it("the teammate's finished review holds the head for every other Limn", () => {
    const lines = [authorClaim, authorDone, line('robin', T0 + 120_000), line('robin', T0 + 600_000, 'success', 'robin reviewed · approved')];
    expect(decideTeamClaim(lines, 'sam', T0 + 700_000, 'alex')).toMatchObject({ kind: 'reviewed', login: 'robin' });
  });
});
