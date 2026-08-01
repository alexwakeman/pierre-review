// The two-grain bot listing: the shaping rules whose wrong version type-checks and ships.
//
// The model these pin: a bot is a PER-REPO object (`repo_reviewers`), its vendor identity and its
// price are PER-ACTOR facts (`account_reviewers`). Every assertion below is one of the four ways
// that gets confused in a renderer:
//   • dedupe by userId in the LIST  — collapsing six intended rows into one
//   • forget to dedupe by userId in the TOTAL — one $120 subscription billed as $720
//   • drop a row whose repo isn't in the echoed repoIds — an unreachable, un-editable setting
//   • treat "automated in some repos, quality in others" as impossible — it is legal now
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { RepoReviewer, ReviewerIdentity } from '@pierre-review/shared';
import {
  actorSummaries,
  emptyStateCopy,
  groupRowsByRepo,
  humanCandidates,
  identityIndex,
  mixedRoleRowKeys,
  monthlyCostTotal,
  reviewerListEmptyKind,
} from '../src/lib/botReviewers.js';

function ident(over: Partial<ReviewerIdentity> & { userId: number }): ReviewerIdentity {
  return {
    login: `user${over.userId}`,
    displayName: null,
    avatarUrl: null,
    kind: 'coderabbit',
    label: 'CodeRabbit',
    identitySource: 'auto',
    costMonthlyUsd: null,
    ...over,
  };
}

function row(over: Partial<RepoReviewer> & { repoId: number; userId: number }): RepoReviewer {
  return {
    automated: true,
    role: 'review',
    confidence: 'high',
    source: 'vendor_login',
    reasons: [],
    isManualOverride: false,
    footprint: { reviews: 1, threads: 2, comments: 3, lastActiveAt: null },
    sampleReviewBody: null,
    ...over,
  };
}

describe('groupRowsByRepo — one group per repo, and NO deduplication', () => {
  // The central claim of the whole refactor: the same vendor in six repos is six rows, shown six
  // times. A `dedupe by userId` "cleanup" would silently delete five of them.
  it('keeps one row per (repo, actor) — the same vendor appears once per repo', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((repoId) => row({ repoId, userId: 7 }));
    const g = groupRowsByRepo(rows, [1, 2, 3, 4, 5, 6]);
    expect(g).toHaveLength(6);
    expect(g.every((x) => x.reviewBots.length === 1)).toBe(true);
    expect(g.flatMap((x) => x.reviewBots.map((r) => r.userId))).toEqual([7, 7, 7, 7, 7, 7]);
  });

  it('renders groups in the server’s repo order, not the row order', () => {
    const rows = [row({ repoId: 9, userId: 1 }), row({ repoId: 4, userId: 1 })];
    expect(groupRowsByRepo(rows, [4, 9]).map((g) => g.repoId)).toEqual([4, 9]);
  });

  // A repo in scope with no bots is a real answer ("nothing automated has spoken here"), and it
  // must not be indistinguishable from the repo not being in scope.
  it('emits an EMPTY group for a repo with no rows', () => {
    const g = groupRowsByRepo([], [4, 9]);
    expect(g).toEqual([
      { repoId: 4, reviewBots: [], qualityChecks: [], markedNotBots: [] },
      { repoId: 9, reviewBots: [], qualityChecks: [], markedNotBots: [] },
    ]);
  });

  // ── THE DISMISSED ROWS MUST STAY VISIBLE ──────────────────────────────────────────────────
  // "Not a bot here" writes a `source: 'manual'` row the classifier honours forever. While these
  // were filtered out with every other non-automated row, the pin left the screen the moment it
  // was made: permanent AND unreachable, since the search box can only offer to re-promote it
  // (another manual write), never to hand it back to detection.
  it('keeps a MANUAL "not a bot" row, in its own bucket', () => {
    const g = groupRowsByRepo(
      [row({ repoId: 1, userId: 7, automated: false, isManualOverride: true })],
      [1],
    );
    expect(g[0]?.markedNotBots.map((r) => r.userId)).toEqual([7]);
    expect(g[0]?.reviewBots).toEqual([]);
    expect(g[0]?.qualityChecks).toEqual([]);
  });

  // …but ONLY the deliberate ones. The classifier writes a low-confidence not-automated row for
  // every ordinary human commenter (the row IS the bot object), so listing those would bury the
  // handful of real dismissals under the whole contributor roster.
  it('still drops an AUTO not-automated row — that is every human in the account', () => {
    const g = groupRowsByRepo(
      [
        row({ repoId: 1, userId: 7, automated: false, isManualOverride: false }),
        row({ repoId: 1, userId: 8, automated: false, isManualOverride: true }),
      ],
      [1],
    );
    expect(g[0]?.markedNotBots.map((r) => r.userId)).toEqual([8]);
  });

  it('a dismissal in one repo does not remove the bot from the others', () => {
    const g = groupRowsByRepo(
      [
        row({ repoId: 1, userId: 7, automated: false, isManualOverride: true }),
        row({ repoId: 2, userId: 7 }),
      ],
      [1, 2],
    );
    expect(g[0]?.markedNotBots.map((r) => r.userId)).toEqual([7]);
    expect(g[0]?.reviewBots).toEqual([]);
    expect(g[1]?.reviewBots.map((r) => r.userId)).toEqual([7]);
    expect(g[1]?.markedNotBots).toEqual([]);
  });

  // This listing is the ONLY surface a stored judgement can be edited from, so a dropped row is
  // an unreachable setting. Visible-and-unexpected beats invisible.
  it('APPENDS a row whose repo is missing from repoIds rather than dropping it', () => {
    const g = groupRowsByRepo([row({ repoId: 99, userId: 1 })], [4]);
    expect(g.map((x) => x.repoId)).toEqual([4, 99]);
    expect(g[1]?.reviewBots).toHaveLength(1);
  });

  it('splits by role WITHIN a repo, and the split can differ between repos', () => {
    const rows = [
      row({ repoId: 1, userId: 7, role: 'review' }),
      row({ repoId: 2, userId: 7, role: 'quality_check' }),
    ];
    const g = groupRowsByRepo(rows, [1, 2]);
    expect(g[0]?.reviewBots.map((r) => r.userId)).toEqual([7]);
    expect(g[0]?.qualityChecks).toEqual([]);
    expect(g[1]?.reviewBots).toEqual([]);
    expect(g[1]?.qualityChecks.map((r) => r.userId)).toEqual([7]);
  });

  it('excludes an AUTO non-automated row from every bucket', () => {
    const g = groupRowsByRepo([row({ repoId: 1, userId: 7, automated: false })], [1]);
    expect(g[0]).toEqual({ repoId: 1, reviewBots: [], qualityChecks: [], markedNotBots: [] });
  });
});

describe('identityIndex', () => {
  it('keys identities by userId — the join between the two grains', () => {
    const m = identityIndex([ident({ userId: 1 }), ident({ userId: 2 })]);
    expect(m.get(2)?.login).toBe('user2');
    expect(m.get(3)).toBeUndefined();
  });
});

describe('actorSummaries — the account-wide half', () => {
  it('reports the repos an actor is automated in, in the listing’s repo order', () => {
    const rows = [row({ repoId: 9, userId: 7 }), row({ repoId: 4, userId: 7 })];
    const [a] = actorSummaries([ident({ userId: 7 })], rows, [4, 9]);
    expect(a?.repoIds).toEqual([4, 9]);
    expect(a?.reviewRepoCount).toBe(2);
    expect(a?.qualityRepoCount).toBe(0);
  });

  // Mixed roles are legal (role is per repo), so both counters can be non-zero at once — the UI
  // reads that to explain why one bot shows up in two lists.
  it('counts both roles when an actor is roled differently per repo', () => {
    const rows = [
      row({ repoId: 1, userId: 7, role: 'review' }),
      row({ repoId: 2, userId: 7, role: 'quality_check' }),
    ];
    const [a] = actorSummaries([ident({ userId: 7 })], rows, [1, 2]);
    expect(a?.reviewRepoCount).toBe(1);
    expect(a?.qualityRepoCount).toBe(1);
  });

  it('omits an actor that is automated nowhere', () => {
    const rows = [row({ repoId: 1, userId: 7, automated: false })];
    expect(actorSummaries([ident({ userId: 7 })], rows, [1])).toEqual([]);
  });

  it('sorts by repo footprint, then login', () => {
    const rows = [
      row({ repoId: 1, userId: 1 }),
      row({ repoId: 1, userId: 2 }),
      row({ repoId: 2, userId: 2 }),
    ];
    const out = actorSummaries([ident({ userId: 1 }), ident({ userId: 2 })], rows, [1, 2]);
    expect(out.map((a) => a.identity.userId)).toEqual([2, 1]);
  });
});

describe('monthlyCostTotal — the ONE thing that must be deduped', () => {
  // The bug this function exists to prevent, stated as a number: six CodeRabbit repo rows, one
  // $120 subscription. Summing the rendered rows gives $720.
  it('counts a price ONCE per actor, however many repos it runs in', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((repoId) => row({ repoId, userId: 7 }));
    const t = monthlyCostTotal([ident({ userId: 7, costMonthlyUsd: 120 })], rows);
    expect(t.totalUsd).toBe(120);
    expect(t.pricedActors).toBe(1);
    expect(t.unpricedActors).toBe(0);
  });

  it('sums DISTINCT actors', () => {
    const rows = [row({ repoId: 1, userId: 7 }), row({ repoId: 1, userId: 8 })];
    const t = monthlyCostTotal(
      [ident({ userId: 7, costMonthlyUsd: 120 }), ident({ userId: 8, costMonthlyUsd: 30 })],
      rows,
    );
    expect(t.totalUsd).toBe(150);
    expect(t.pricedActors).toBe(2);
  });

  // 0 is a deliberate price. Counting it as unpriced turns "3 of 5 bots have no price" into a nag
  // about a bot someone marked free on purpose.
  it('treats a price of ZERO as priced, not as missing', () => {
    const t = monthlyCostTotal([ident({ userId: 7, costMonthlyUsd: 0 })], [row({ repoId: 1, userId: 7 })]);
    expect(t.totalUsd).toBe(0);
    expect(t.pricedActors).toBe(1);
    expect(t.unpricedActors).toBe(0);
  });

  it('null total (not 0) when nothing is priced, so the caption can say "none set"', () => {
    const t = monthlyCostTotal([ident({ userId: 7 })], [row({ repoId: 1, userId: 7 })]);
    expect(t.totalUsd).toBeNull();
    expect(t.pricedActors).toBe(0);
    expect(t.unpricedActors).toBe(1);
  });

  it('ignores an actor that is automated in no repo, priced or not', () => {
    const t = monthlyCostTotal(
      [ident({ userId: 7, costMonthlyUsd: 999 })],
      [row({ repoId: 1, userId: 7, automated: false })],
    );
    expect(t.totalUsd).toBeNull();
    expect(t.pricedActors).toBe(0);
    expect(t.unpricedActors).toBe(0);
  });

  // Binary64 dollars accumulate representation error; a raw sum prints $0.30000000000000004.
  it('re-rounds the sum to the cent', () => {
    const t = monthlyCostTotal(
      [ident({ userId: 1, costMonthlyUsd: 0.1 }), ident({ userId: 2, costMonthlyUsd: 0.2 })],
      [row({ repoId: 1, userId: 1 }), row({ repoId: 1, userId: 2 })],
    );
    expect(t.totalUsd).toBe(0.3);
  });
});

describe('humanCandidates — promoting is a PER-REPO gesture', () => {
  const reviewers = [ident({ userId: 1, login: 'alice', kind: null, displayName: 'Alice A' })];

  it('offers the repos where the actor actually has a footprint', () => {
    const rows = [
      row({ repoId: 9, userId: 1, automated: false }),
      row({ repoId: 4, userId: 1, automated: false }),
    ];
    const out = humanCandidates(reviewers, rows, 'ali', 8, [4, 9]);
    expect(out).toHaveLength(1);
    expect(out[0]?.repoIds).toEqual([4, 9]);
  });

  it('returns nothing for an empty query — the human list is never rendered unprompted', () => {
    const rows = [row({ repoId: 1, userId: 1, automated: false })];
    expect(humanCandidates(reviewers, rows, '   ', 8)).toEqual([]);
  });

  it('matches on display name as well as login, case-insensitively', () => {
    const rows = [row({ repoId: 1, userId: 1, automated: false })];
    expect(humanCandidates(reviewers, rows, 'ALICE A', 8)).toHaveLength(1);
  });

  // Already automated SOMEWHERE ⇒ it has an editable row in the lists above; a second control for
  // the same fact is how two surfaces come to disagree.
  it('excludes an actor already automated in any repo', () => {
    const rows = [
      row({ repoId: 1, userId: 1, automated: true }),
      row({ repoId: 2, userId: 1, automated: false }),
    ];
    expect(humanCandidates(reviewers, rows, 'ali', 8)).toEqual([]);
  });

  it('excludes an actor with no rows at all — there is no repo to promote them in', () => {
    expect(humanCandidates(reviewers, [], 'ali', 8)).toEqual([]);
  });

  it('respects the limit', () => {
    const many = [1, 2, 3].map((n) => ident({ userId: n, login: `alice${n}`, kind: null }));
    const rows = [1, 2, 3].map((n) => row({ repoId: 1, userId: n, automated: false }));
    expect(humanCandidates(many, rows, 'alice', 2)).toHaveLength(2);
  });
});

describe('reviewerListEmptyKind / emptyStateCopy — two empties that look identical', () => {
  it('no repos in scope', () => {
    expect(reviewerListEmptyKind([], [])).toBe('no-repos');
  });

  it('repos, but nothing automated in them', () => {
    expect(reviewerListEmptyKind([1], [row({ repoId: 1, userId: 1, automated: false })])).toBe(
      'no-reviewers',
    );
  });

  it('not empty once a single automated row exists', () => {
    expect(reviewerListEmptyKind([1], [row({ repoId: 1, userId: 1 })])).toBeNull();
  });

  // ⚠ A MANUAL "not a bot" ROW IS CONTENT. It is not automated, so the obvious
  // `rows.some(r => r.automated)` renders the empty state over a screen that has a PIN on it —
  // and the pin's only reset control lives in the list that would be hidden. An account that
  // dismissed its one detected bot would land on "no automated reviewers seen yet" with no way
  // back at all.
  it('is NOT empty when the only row is a manual "not a bot" (its reset lives in the list)', () => {
    expect(
      reviewerListEmptyKind(
        [1],
        [row({ repoId: 1, userId: 1, automated: false, isManualOverride: true })],
      ),
    ).toBeNull();
  });

  // The copy rule: neither string may point at the search box, which filters the same empty
  // listing and could only ever render a control that matches nobody.
  it('neither empty message points the user at the search box', () => {
    for (const kind of ['no-repos', 'no-reviewers'] as const) {
      const s = emptyStateCopy(kind, 3).toLowerCase();
      expect(s).not.toContain('search');
      expect(s).not.toContain('below');
    }
  });

  it('pluralises the repo count', () => {
    expect(emptyStateCopy('no-reviewers', 1)).toContain('1 repo —');
    expect(emptyStateCopy('no-reviewers', 3)).toContain('3 repos');
  });
});

describe('mixedRoleRowKeys — one actor, two roles, is LEGAL', () => {
  it('flags a key present in both the ROI table and the quality-check section', () => {
    const s = mixedRoleRowKeys([{ key: 'u7' }, { key: 'u8' }], [{ key: 'u7' }, { key: 'u9' }]);
    expect([...s]).toEqual(['u7']);
  });

  it('is empty when the two lists are disjoint (the ordinary case)', () => {
    expect(mixedRoleRowKeys([{ key: 'u7' }], [{ key: 'u9' }]).size).toBe(0);
  });

  // Guards both "return every quality key" and "return every vendor key": only the INTERSECTION
  // may be flagged, or every quality check would wear a mixed-role chip.
  it('returns the intersection only — never one whole list', () => {
    const s = mixedRoleRowKeys(
      [{ key: 'u7' }, { key: 'u8' }],
      [{ key: 'u8' }, { key: 'u7' }, { key: 'u9' }],
    );
    expect([...s].sort()).toEqual(['u7', 'u8']);
    expect(s.has('u9')).toBe(false);
  });
});
