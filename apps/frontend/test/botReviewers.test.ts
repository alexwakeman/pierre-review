// The bot listing of ONE WORKSPACE: the shaping rules whose wrong version type-checks and ships.
//
// The model these pin: a bot object is ONE `workspace_reviewers` row keyed
// (account, workspace, actor), carrying the judgement (`automated` / `role`), the identity
// (`kind` / `label`), the price (`costMonthlyUsd`) and the evidence (`footprint` +
// `repoFootprints`) together. The old two-grain wire — `rows` per (repo, actor) plus `reviewers`
// per actor — is gone, and with it `groupRowsByRepo` / `identityIndex` / `actorSummaries` /
// `mixedRoleRowKeys`, which existed only to join the two halves back up.
//
// What is left is four decisions that are each wrong in a way nothing shouts about:
//   • the marked-not-bots PREDICATE   — a renamed actor stranded in NO bucket, reset unreachable
//   • the empty-state PREDICATE       — an empty screen painted over a pin whose only reset is
//                                       in the list being hidden
//   • the money DEDUPE                — kept though trivially satisfied, as the standing guard
//                                       that two workspaces' listings are never totalled
//   • the per-repo tab's FILTER       — a display filter, never a scope
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { RepoReviewerFootprintEntry, WorkspaceReviewer } from '@pierre-review/shared';
import {
  bucketReviewers,
  emptyStateCopy,
  humanCandidates,
  monthlyCostTotal,
  reviewerListEmptyKind,
  reviewersWithFootprintIn,
} from '../src/lib/botReviewers.js';

const WS = 3;

function footprintIn(repoId: number): RepoReviewerFootprintEntry {
  return { repoId, reviews: 1, threads: 2, comments: 3, lastActiveAt: null };
}

function reviewer(
  over: Partial<WorkspaceReviewer> & { userId: number },
): WorkspaceReviewer {
  return {
    workspaceId: WS,
    login: `user${over.userId}`,
    displayName: null,
    avatarUrl: null,
    automated: true,
    role: 'review',
    confidence: 'high',
    source: 'vendor_login',
    reasons: [],
    isManualOverride: false,
    kind: 'coderabbit',
    label: 'CodeRabbit',
    identitySource: 'auto',
    costMonthlyUsd: null,
    costModel: 'flat',
    // Mirrors the server's flat derivation (effective = the price itself); a per-seat fixture
    // overrides BOTH fields explicitly, like the wire does.
    effectiveMonthlyUsd: over.costMonthlyUsd ?? null,
    footprint: { reviews: 1, threads: 2, comments: 3, lastActiveAt: null },
    repoFootprints: [footprintIn(1)],
    sampleReviewBody: null,
    ...over,
  };
}

describe('bucketReviewers — three lists, one row per actor', () => {
  it('splits automated reviewers by role, keeping the server’s order in each', () => {
    const b = bucketReviewers([
      reviewer({ userId: 7, role: 'review' }),
      reviewer({ userId: 8, role: 'quality_check' }),
      reviewer({ userId: 9, role: 'review' }),
    ]);
    expect(b.reviewBots.map((r) => r.userId)).toEqual([7, 9]);
    expect(b.qualityChecks.map((r) => r.userId)).toEqual([8]);
    expect(b.markedNotBots).toEqual([]);
  });

  // ⚠ THE COHORT TEST IS `=== 'review'`, NOT `!== 'quality_check'`.
  //
  // Those were the same answer while `review` and `quality_check` were the only two roles, and
  // they stopped being the same answer the moment the union widened. Written the old way, every
  // one of the four newer roles falls into `reviewBots` — the list whose entire purpose is "the
  // reviewers every bot metric counts" — so Dependabot would appear as a review bot on the
  // settings screen while the period report correctly filed it as a dependency lane.
  it('keeps EVERY non-review role out of the reviewer cohort, not just quality_check', () => {
    const b = bucketReviewers([
      reviewer({ userId: 1, role: 'review' }),
      reviewer({ userId: 2, role: 'quality_check' }),
      reviewer({ userId: 3, role: 'dependency' }),
      reviewer({ userId: 4, role: 'code_agent' }),
      reviewer({ userId: 5, role: 'release' }),
      reviewer({ userId: 6, role: 'housekeeping' }),
    ]);
    expect(b.reviewBots.map((r) => r.userId)).toEqual([1]);
    // The bucket's NAME is historical and narrower than its contents — it now holds every
    // non-reviewer automation. See the note on `ReviewerBuckets.qualityChecks`.
    expect(b.qualityChecks.map((r) => r.userId)).toEqual([2, 3, 4, 5, 6]);
  });

  // ⚠ ONE ROW PER ACTOR IS THE WHOLE POINT OF THE COLLAPSE. A vendor running in six of the
  // workspace's repos is ONE card whose `repoFootprints` names all six — not six cards to group,
  // and not a list something has to dedupe.
  it('a vendor active in six repos is ONE row carrying six footprints', () => {
    const r = reviewer({ userId: 7, repoFootprints: [1, 2, 3, 4, 5, 6].map(footprintIn) });
    const b = bucketReviewers([r]);
    expect(b.reviewBots).toHaveLength(1);
    expect(b.reviewBots[0]?.repoFootprints.map((f) => f.repoId)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  // ── THE DISMISSED ROWS MUST STAY VISIBLE ──────────────────────────────────────────────────
  // "Not a bot" writes a `source: 'manual'` judgement the classifier honours forever. Filtered
  // out with every other non-automated row, the pin leaves the screen the moment it is made:
  // permanent AND unreachable, since the search box can only offer to re-promote it (another
  // manual write), never to hand it back to detection.
  it('keeps a MANUAL "not a bot" row, in its own bucket', () => {
    const b = bucketReviewers([
      reviewer({ userId: 7, automated: false, isManualOverride: true, source: 'manual' }),
    ]);
    expect(b.markedNotBots.map((r) => r.userId)).toEqual([7]);
    expect(b.reviewBots).toEqual([]);
    expect(b.qualityChecks).toEqual([]);
  });

  // ⚠ THE PREDICATE CHANGE THIS REFACTOR CLAIMS TO SHIP. `isManualOverride` is `source ===
  // 'manual'`; a RENAMED actor carries `identitySource === 'manual'` with `source === 'auto'`. On
  // `!automated && isManualOverride` alone it lands in NO bucket at all — invisible, identity
  // pinned to manual, its "Reset name" control unreachable. That was the standing known gap; the
  // second disjunct is the fix, and without it the claim is false.
  it('keeps a RENAMED actor that is automated nowhere — the gap this refactor closes', () => {
    const b = bucketReviewers([
      reviewer({
        userId: 7,
        automated: false,
        isManualOverride: false,
        source: 'auto',
        identitySource: 'manual',
        label: 'Our linter',
      }),
    ]);
    expect(b.markedNotBots.map((r) => r.userId)).toEqual([7]);
  });

  // …but ONLY the deliberate ones. The classifier writes a low-confidence not-automated row for
  // every ordinary human commenter (the row IS the bot object), so listing those would bury the
  // handful of real dismissals under the whole contributor roster.
  it('still drops an AUTO, un-renamed, not-automated row — that is every human in the account', () => {
    const b = bucketReviewers([
      reviewer({ userId: 7, automated: false, isManualOverride: false, identitySource: 'auto' }),
      reviewer({ userId: 8, automated: false, isManualOverride: true, source: 'manual' }),
    ]);
    expect(b.markedNotBots.map((r) => r.userId)).toEqual([8]);
    expect(b.reviewBots).toEqual([]);
  });
});

describe('reviewersWithFootprintIn — a DISPLAY filter, never a scope', () => {
  // The per-repo Bots tab fetches the WHOLE workspace listing and narrows here on purpose: every
  // edit on that panel is workspace-wide (it is literally the same row), so each card has to be
  // able to show its full `repoFootprints[]`, i.e. the real blast radius. Asking the server for
  // `repoIds: [repoId]` would leave one entry in that array and reduce the disclosure to a line of
  // copy asserting something the UI cannot show.
  const rs = [
    reviewer({ userId: 7, repoFootprints: [footprintIn(1), footprintIn(2)] }),
    reviewer({ userId: 8, repoFootprints: [footprintIn(2)] }),
  ];

  it('keeps the reviewers that actually touched the repo', () => {
    expect(reviewersWithFootprintIn(rs, 2).map((r) => r.userId)).toEqual([7, 8]);
    expect(reviewersWithFootprintIn(rs, 1).map((r) => r.userId)).toEqual([7]);
  });

  it('does NOT truncate the surviving cards’ footprints — the blast radius stays on screen', () => {
    const [only] = reviewersWithFootprintIn(rs, 1);
    expect(only?.repoFootprints.map((f) => f.repoId)).toEqual([1, 2]);
  });

  it('omits a reviewer with no footprint here rather than showing it at zero', () => {
    expect(reviewersWithFootprintIn(rs, 99)).toEqual([]);
  });
});

describe('monthlyCostTotal — one workspace’s prices, deduped by actor', () => {
  // ⚠ THE DEDUPE IS TRIVIALLY SATISFIED AND KEPT ANYWAY. The server emits exactly one row per
  // actor per workspace, so it can never fire on a well-formed listing — which is precisely what
  // makes it the cheap standing guard that this figure is never handed two workspaces' listings
  // concatenated "to show everything". Prices are per workspace: six workspaces each listing a
  // $120 CodeRabbit is either six subscriptions or one seen six ways, and the app must not assert
  // which. So this asserts the malformed input too, deliberately.
  it('counts a price ONCE per actor even if two workspaces’ rows are concatenated', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((workspaceId) =>
      reviewer({ userId: 7, workspaceId, costMonthlyUsd: 120 }),
    );
    const t = monthlyCostTotal(rows);
    expect(t.totalUsd).toBe(120);
    expect(t.pricedActors).toBe(1);
    expect(t.unpricedActors).toBe(0);
  });

  it('sums distinct actors', () => {
    const t = monthlyCostTotal([
      reviewer({ userId: 7, costMonthlyUsd: 120 }),
      reviewer({ userId: 8, costMonthlyUsd: 30 }),
    ]);
    expect(t.totalUsd).toBe(150);
    expect(t.pricedActors).toBe(2);
  });

  // 0 is a deliberate price. Counting it as unpriced turns "3 of 5 bots have no price" into a nag
  // about a bot someone marked free on purpose.
  it('treats a price of ZERO as priced, not as missing', () => {
    const t = monthlyCostTotal([reviewer({ userId: 7, costMonthlyUsd: 0 })]);
    expect(t.totalUsd).toBe(0);
    expect(t.pricedActors).toBe(1);
    expect(t.unpricedActors).toBe(0);
  });

  it('null total (not 0) when nothing is priced, so the caption can say "none set"', () => {
    const t = monthlyCostTotal([reviewer({ userId: 7 })]);
    expect(t.totalUsd).toBeNull();
    expect(t.pricedActors).toBe(0);
    expect(t.unpricedActors).toBe(1);
  });

  it('ignores a non-automated actor, priced or not', () => {
    const t = monthlyCostTotal([
      reviewer({ userId: 7, automated: false, costMonthlyUsd: 999 }),
    ]);
    expect(t.totalUsd).toBeNull();
    expect(t.pricedActors).toBe(0);
    expect(t.unpricedActors).toBe(0);
  });

  // Binary64 dollars accumulate representation error; a raw sum prints $0.30000000000000004.
  it('re-rounds the sum to the cent', () => {
    const t = monthlyCostTotal([
      reviewer({ userId: 1, costMonthlyUsd: 0.1 }),
      reviewer({ userId: 2, costMonthlyUsd: 0.2 }),
    ]);
    expect(t.totalUsd).toBe(0.3);
  });

  // ⚠ THE PER-SEAT RULE: the total sums the SERVER's `effectiveMonthlyUsd` (unit × seats,
  // multiplied once, on read, server-side) — never the raw unit, and never a client-side
  // unit × seats of its own. Summing the unit would print $29 for a $203 bot; multiplying here
  // too would double-charge.
  it('sums the server-computed effective figure for a per-seat row, not the unit', () => {
    const t = monthlyCostTotal([
      reviewer({
        userId: 7,
        costModel: 'per_seat',
        costMonthlyUsd: 29,
        effectiveMonthlyUsd: 203, // 29 × 7 seats, as the server serves it
      }),
      reviewer({ userId: 8, costMonthlyUsd: 30 }),
    ]);
    expect(t.totalUsd).toBe(233);
    expect(t.pricedActors).toBe(2);
  });
});

describe('humanCandidates — promoting is now ONE workspace-wide gesture', () => {
  // No repo list, in or out: "Mark as a bot" is one write against the row that already exists for
  // this actor in this workspace. There is no repo to pick and no row to fabricate.
  const people = [
    reviewer({
      userId: 1,
      login: 'alice',
      displayName: 'Alice A',
      automated: false,
      kind: null,
      label: 'alice',
    }),
  ];

  it('matches on login', () => {
    expect(humanCandidates(people, 'ali', 8).map((r) => r.userId)).toEqual([1]);
  });

  it('returns nothing for an empty query — the human list is never rendered unprompted', () => {
    expect(humanCandidates(people, '   ', 8)).toEqual([]);
  });

  it('matches on display name as well as login, case-insensitively', () => {
    expect(humanCandidates(people, 'ALICE A', 8)).toHaveLength(1);
  });

  // Already automated ⇒ it has an editable card in the lists above; a second control for the same
  // fact is how two surfaces come to disagree.
  it('excludes an actor that is already automated here', () => {
    expect(humanCandidates([reviewer({ userId: 1, login: 'alice' })], 'ali', 8)).toEqual([]);
  });

  // A dismissed actor stays findable by name — that is how you re-promote one you cannot remember
  // dismissing. The two surfaces then offer the two different actions.
  it('still offers a MANUALLY dismissed actor', () => {
    const dismissed = [
      reviewer({
        userId: 1,
        login: 'alice',
        automated: false,
        isManualOverride: true,
        source: 'manual',
      }),
    ];
    expect(humanCandidates(dismissed, 'ali', 8).map((r) => r.userId)).toEqual([1]);
  });

  it('respects the limit', () => {
    const many = [1, 2, 3].map((n) =>
      reviewer({ userId: n, login: `alice${n}`, automated: false, kind: null }),
    );
    expect(humanCandidates(many, 'alice', 2)).toHaveLength(2);
  });
});

describe('reviewerListEmptyKind / emptyStateCopy — two empties that look identical', () => {
  // `repoIds` is why the response carries the id LIST and not a count: `[]` is "this workspace has
  // no repos — move some in", which no reviewer count could distinguish from "nothing detected
  // yet". The two need different copy because they need different actions.
  it('no repos in the workspace', () => {
    expect(reviewerListEmptyKind([], [])).toBe('no-repos');
  });

  it('repos in the workspace, but nothing automated seen in them', () => {
    expect(reviewerListEmptyKind([reviewer({ userId: 1, automated: false })], [1])).toBe(
      'no-reviewers',
    );
  });

  it('not empty once a single automated reviewer exists', () => {
    expect(reviewerListEmptyKind([reviewer({ userId: 1 })], [1])).toBeNull();
  });

  // ⚠ A PINNED ROW IS CONTENT. It is not automated, so the obvious `some(r => r.automated)`
  // renders the empty state over a screen that has a PIN on it — and the pin's only reset control
  // lives in the list that would be hidden. A workspace that dismissed its one detected bot would
  // land on "no automated reviewers seen yet" with no way back at all. Its predicate and
  // bucketReviewers' are the SAME test for exactly this reason.
  it('is NOT empty when the only row is a manual "not a bot"', () => {
    expect(
      reviewerListEmptyKind(
        [reviewer({ userId: 1, automated: false, isManualOverride: true, source: 'manual' })],
        [1],
      ),
    ).toBeNull();
  });

  it('is NOT empty when the only row is a renamed, un-automated actor', () => {
    expect(
      reviewerListEmptyKind(
        [reviewer({ userId: 1, automated: false, identitySource: 'manual' })],
        [1],
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

  // The 'no-repos' fix is a MOVE, not an add: under one-workspace-per-repo the repos exist, they
  // are simply somewhere else, so the copy has to name the one place that can be changed.
  it('the no-repos copy names the move, not an add', () => {
    expect(emptyStateCopy('no-repos', 0).toLowerCase()).toContain('workspace');
  });

  it('pluralises the repo count', () => {
    expect(emptyStateCopy('no-reviewers', 1)).toContain('1 repo —');
    expect(emptyStateCopy('no-reviewers', 3)).toContain('3 repos');
  });
});
