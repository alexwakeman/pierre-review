// The two things a Pending card now says about a pull request beyond "it exists": WHO OPENED IT,
// and WHAT YOU CAN DO ABOUT IT. Both are decided by pure functions precisely so they can be pinned
// here rather than by reading JSX.
//
// WHAT THIS PINS, and why each is worth a test:
//
//   1. THE SOURCE CHIP ONLY EVER MAKES A POSITIVE CLAIM. A bot gets a chip; a person gets nothing,
//      because the author name and avatar already say "person" and a chip on every row of a
//      fifty-card board is noise. The consequence that needs pinning is the DEGRADATION: absent
//      fields must render NO chip, never "a person" and never a vendor.
//   2. `authorIsBot` WITH A NULL KIND IS A REAL, COMMON STATE — an unbranded CI service account
//      we recognise as automation but whose vendor we do not. It must render the generic "Bot",
//      never nothing (which would read as a person) and never an invented brand.
//   3. THE MERGE GATE IS `mergeVerdict`, NOT A SECOND READING OF THE SAME ENUM. `unstable` IS
//      mergeable (only non-required checks are red) and `behind` is NOT (GitHub 405s the merge) —
//      two rules that are counter-intuitive in opposite directions, and the reason exactly one
//      resolver is allowed to know them.
//   4. `viewerCanPush: false` HIDES, it does not disable — the ChecksTab rule. And it is a
//      VISIBILITY gate only: the routes re-check permission before anything irreversible happens.
//
//   5. AND THE ARM DRAFT SURVIVES THE CARD ID. The board's card id ENCODES THE MERGE KIND
//      (`wp:merge:<prId>` / `wp:update_branch:<prId>`), so a PR falling behind trunk re-keys its
//      card and React remounts the row — which used to wipe the half-finished "Merge when ready"
//      confirmation held in `useState` and drop the reader back to an unpressed button. The draft
//      is keyed by prId, the half that does not change, and `armControlPhase` is the one resolver
//      that decides what the control shows.
//
//   ⚠ AND THE WHOLE POINT OF THE GATE BEING PURE: it is fed the card's OWN synced fields and
//   nothing else. Every one of these assertions runs with no React, no query client and no
//   network, which is the same property that keeps fifty mounted cards from making ~150 GitHub
//   calls to paint a board.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type {
  AutomatedReviewerKind,
  ConflictsCard,
  InsightReviewer,
  MergeQueueEntryState,
  MergeReadyCard,
  MergeStateStatus,
  Mergeable,
  MyTurnCard,
  MyTurnRelevance,
  PrReviewDecision,
  ReviewStanding,
  UpdateBranchCard,
} from '@pierre-review/shared';
import {
  authorSourceLabel,
  cardKindLabel,
  conflictsStateChip,
  KIND_LABEL,
  clockSaysMore,
  openedAgeLabel,
  pendingCardIsPersonal,
  pendingMergeGate,
  pendingQueueBadge,
  pendingReviewerChips,
  pendingReviewLead,
  myTurnReasonLabel,
} from '../src/components/Activity/AttentionCards.js';
import {
  armControlPhase,
  armDraftFor,
  armDraftReducer,
  dispatchArmDraft,
} from '../src/hooks/useAutoMerge.js';

/** The `InsightPrRef` half every PR-bearing card carries, with the source pair varied per test. */
function prRef(
  over: {
    authorIsBot?: boolean;
    authorBotKind?: AutomatedReviewerKind | null;
    inMergeQueue?: boolean | null;
    mergeQueueEntryState?: MergeQueueEntryState | null;
    reviewDecision?: PrReviewDecision | null;
    reviewApprovals?: number;
    reviewChangesRequested?: boolean;
    reviewers?: InsightReviewer[];
    reviewerCount?: number;
  } = {},
) {
  return {
    prId: 101,
    repoId: 7,
    repoFullName: 'acme/api',
    prNumber: 42,
    prTitle: 'Bump the thing',
    authorId: 9,
    githubUrl: 'https://github.com/acme/api/pull/42',
    ciStatus: 'success' as const,
    changedFiles: 3,
    additions: 12,
    deletions: 4,
    openedAt: '2026-08-20T10:00:00.000Z',
    authorIsBot: false,
    authorBotKind: null,
    // ⚠ `null` IS THE HONEST DEFAULT for the queue pair: a PR synced before the columns existed,
    // or a walk that did not carry the selection. It is NOT "not queued".
    inMergeQueue: null as boolean | null,
    mergeQueueEntryState: null as MergeQueueEntryState | null,
    // The review half. `reviewDecision: null` is ~90% of open non-draft PRs and means the repo
    // requires no review — never "nobody looked", which is `reviewerCount`.
    reviewDecision: null as PrReviewDecision | null,
    reviewApprovals: 0,
    reviewChangesRequested: false,
    reviewers: [] as InsightReviewer[],
    reviewerCount: 0,
    ...over,
  };
}

function mergeCard(over: {
  mergeStateStatus?: MergeStateStatus;
  mergeable?: Mergeable | null;
  viewerCanPush?: boolean;
  inMergeQueue?: boolean | null;
  mergeQueueEntryState?: MergeQueueEntryState | null;
} = {}): MergeReadyCard {
  return {
    id: 'wp:merge:101',
    kind: 'merge',
    severity: 'info',
    ...prRef({
      inMergeQueue: over.inMergeQueue ?? null,
      mergeQueueEntryState: over.mergeQueueEntryState ?? null,
    }),
    mergeStateStatus: over.mergeStateStatus ?? 'clean',
    mergeable: over.mergeable === undefined ? 'mergeable' : over.mergeable,
    lastCommitAt: '2026-08-27T09:00:00.000Z',
    relevance: 'direct',
    detail: 'approved and clean',
    viewerCanPush: over.viewerCanPush ?? true,
  };
}

function updateBranchCard(over: {
  mergeable?: Mergeable | null;
  viewerCanPush?: boolean;
  inMergeQueue?: boolean | null;
} = {}): UpdateBranchCard {
  return {
    id: 'wp:update_branch:101',
    kind: 'update_branch',
    severity: 'info',
    ...prRef({ inMergeQueue: over.inMergeQueue ?? null }),
    mergeStateStatus: 'behind',
    mergeable: over.mergeable === undefined ? 'mergeable' : over.mergeable,
    lastCommitAt: '2026-08-27T09:00:00.000Z',
    relevance: 'direct',
    detail: 'behind trunk',
    viewerCanPush: over.viewerCanPush ?? true,
  };
}

/**
 * The `conflicts` card, as the server mints it (`conflicts:<prId>`).
 *
 * ⚠ THE TWO ARMS ARE KEPT DISTINCT ON PURPOSE. The kind is minted on an OR —
 * `mergeStateStatus === 'dirty'` OR `mergeable === 'conflicting'` — and `conflictsStateChip`
 * treats them differently, so a factory that always set 'dirty' would make half of the
 * assertions below unreachable.
 *
 * ⚠ AND IT CARRIES NEITHER `viewerCanPush` NOR `lastCommitAt`, matching the wire type. Write
 * access IS the population (`writableRepoIds`), so the flag would be a constant `true` and an
 * invitation to a merge control; and `lastCommitAt` is the FORWARD cards' ranker clock, which on
 * this kind would read as "conflicting since" — a fact nobody holds.
 */
function conflictsCard(
  over: {
    mergeStateStatus?: MergeStateStatus | null;
    mergeable?: Mergeable | null;
    relevance?: MyTurnRelevance;
    inMergeQueue?: boolean | null;
    mergeQueueEntryState?: MergeQueueEntryState | null;
    detail?: string;
  } = {},
): ConflictsCard {
  const relevance = over.relevance ?? 'maintained';
  return {
    id: 'conflicts:101',
    kind: 'conflicts',
    // The ci_failing split one object over: your own PR is 'high', somebody else's in a repo you
    // can push to is 'warn'.
    severity: relevance === 'direct' ? 'high' : 'warn',
    ...prRef({
      inMergeQueue: over.inMergeQueue ?? null,
      mergeQueueEntryState: over.mergeQueueEntryState ?? null,
    }),
    mergeStateStatus: over.mergeStateStatus === undefined ? 'dirty' : over.mergeStateStatus,
    mergeable: over.mergeable === undefined ? 'conflicting' : over.mergeable,
    relevance,
    detail: over.detail ?? 'Conflicts with main',
  };
}

describe('the source chip', () => {
  it('names the vendor on a bot-authored card', () => {
    expect(authorSourceLabel(prRef({ authorIsBot: true, authorBotKind: 'dependabot' }))).toBe(
      'Dependabot',
    );
    expect(authorSourceLabel(prRef({ authorIsBot: true, authorBotKind: 'coderabbit' }))).toBe(
      'CodeRabbit',
    );
  });

  it('renders NOTHING on a human-authored card', () => {
    // The author name + avatar already say "person"; a second chip on every one of fifty rows is
    // noise, and it is also the claim we are least entitled to make from a bot heuristic.
    expect(authorSourceLabel(prRef())).toBeNull();
  });

  it('⚠ renders the GENERIC bot chip when the kind is null but the flag is set', () => {
    // An unbranded CI service account: recognised as automation (users.isBot, or a workspace
    // judgement) with no vendor behind it. Rendering nothing here would silently promote it to
    // "a person" on the one screen that exists to tell the two apart.
    expect(authorSourceLabel(prRef({ authorIsBot: true, authorBotKind: null }))).toBe('Bot');
  });

  it('⚠ never paints a vendor chip without the flag', () => {
    // The server already gates the kind on the flag. Repeating the gate means a wire regression
    // costs a chip's BRAND, never a vendor chip over a colleague's name.
    expect(authorSourceLabel(prRef({ authorIsBot: false, authorBotKind: 'coderabbit' }))).toBeNull();
  });

  it('degrades to NO CHIP on a surface that carries neither field', () => {
    // The search card adapts a loaded PR detail and holds no workspace bot judgement. Absent must
    // mean "we said nothing", not "a person" — which is why the chip is positive-claim-only.
    expect(authorSourceLabel({})).toBeNull();
    expect(authorSourceLabel({ authorBotKind: 'renovate' })).toBeNull();
  });
});

describe('the merge gate follows mergeVerdict', () => {
  it('offers Merge on a clean PR', () => {
    const gate = pendingMergeGate(mergeCard({ mergeStateStatus: 'clean' }));
    expect(gate.show).toBe(true);
    expect(gate.action).toBe('merge');
    expect(gate.verdict.canMerge).toBe(true);
  });

  it('offers Merge on `unstable` — only NON-REQUIRED checks are red, so GitHub takes it', () => {
    const gate = pendingMergeGate(mergeCard({ mergeStateStatus: 'unstable' }));
    expect(gate.action).toBe('merge');
    expect(gate.verdict.verdict).toBe('unstable');
  });

  it('offers Merge on `has_hooks`', () => {
    expect(pendingMergeGate(mergeCard({ mergeStateStatus: 'has_hooks' })).action).toBe('merge');
  });

  it('offers UPDATE, never Merge, on a behind card — GitHub 405s the merge', () => {
    const gate = pendingMergeGate(updateBranchCard());
    expect(gate.show).toBe(true);
    expect(gate.action).toBe('update_branch');
    expect(gate.verdict.canMerge).toBe(false);
    expect(gate.verdict.verdict).toBe('behind');
  });

  it('offers NOTHING on a blocked PR, and says why', () => {
    // Not reachable from today's server fold (READY_MERGE_STATES excludes it), which is exactly
    // why the predicate has to be right rather than incidentally unused.
    const gate = pendingMergeGate(mergeCard({ mergeStateStatus: 'blocked' }));
    expect(gate.show).toBe(true);
    expect(gate.action).toBeNull();
    expect(gate.verdict.verdict).toBe('blocked');
    expect(gate.verdict.label).toBeTruthy();
  });

  it('offers nothing on conflicts, on EITHER kind', () => {
    // ⚠ AND THIS IS WHY THE `conflicts` KIND HAS NO BUTTON. It exists to say the thing these three
    // assertions imply: GitHub 405s a merge on a conflicting branch, "Update branch" cannot
    // resolve a conflict, and resolving one is a git operation this app does not perform. A
    // future "let the conflicts card reuse PendingMergeActions" refactor lands here — there is no
    // action to reuse, on any of the three shapes.
    expect(pendingMergeGate(mergeCard({ mergeStateStatus: 'dirty' })).action).toBeNull();
    expect(
      pendingMergeGate(mergeCard({ mergeStateStatus: 'clean', mergeable: 'conflicting' })).action,
    ).toBeNull();
    // A behind PR that also conflicts: updating the branch cannot resolve them, so the button
    // that would promise it is not offered.
    expect(pendingMergeGate(updateBranchCard({ mergeable: 'conflicting' })).action).toBeNull();
  });

  it('offers nothing while GitHub has not computed mergeability', () => {
    expect(pendingMergeGate(mergeCard({ mergeStateStatus: 'unknown' })).action).toBeNull();
  });

  it('⚠ treats a NULL `mergeable` as not-observed, not as not-conflicting', () => {
    // The three-state rule. A null column must not silently upgrade the row: the state status
    // still decides, and `clean` + null stays mergeable exactly because the status said so.
    expect(pendingMergeGate(mergeCard({ mergeable: null })).action).toBe('merge');
    expect(pendingMergeGate(mergeCard({ mergeStateStatus: 'behind', mergeable: null })).action).toBeNull();
  });
});

describe('viewerCanPush', () => {
  it('HIDES the whole row rather than disabling it', () => {
    for (const card of [
      mergeCard({ viewerCanPush: false }),
      mergeCard({ mergeStateStatus: 'unstable', viewerCanPush: false }),
      updateBranchCard({ viewerCanPush: false }),
    ]) {
      const gate = pendingMergeGate(card);
      expect(gate.show).toBe(false);
      // ⚠ AND NO ACTION EITHER. `show` is what the component branches on, but a gate that left a
      // live `action` behind a false `show` is one refactor away from rendering a Merge button to
      // someone GitHub will refuse.
      expect(gate.action).toBeNull();
    }
  });

  it('shows the row for a pusher even when nothing can be offered', () => {
    // The verdict line is the answer to "why can't I merge this?" and is worth the row on its own.
    const gate = pendingMergeGate(mergeCard({ mergeStateStatus: 'blocked', viewerCanPush: true }));
    expect(gate.show).toBe(true);
    expect(gate.action).toBeNull();
  });
});


// ── THE MERGE QUEUE ──────────────────────────────────────────────────────────────────────────
//
// GitHub's MergeStateStatus enum has NO queued member, so a PR sitting in the merge queue reports
// `mergeStateStatus: 'blocked'` and is indistinguishable from a protection-blocked one. The board
// may not fetch to find out, so the membership rides the card — and everything below is what the
// card is then allowed to say about it.

/** The card fields the queue badge reads, and nothing else — the resolver takes a Partial so a
 *  surface that never had them (a `ci_failing` card, whose subject can be a repo's trunk) answers
 *  null instead of being forced to invent `inMergeQueue: false`. */
const QUEUE_STATES: MergeQueueEntryState[] = [
  'queued',
  'awaiting_checks',
  'mergeable',
  'locked',
  'unmergeable',
];

describe('the merge-queue badge', () => {
  it('⚠ renders NOTHING when the queue was never observed', () => {
    // `null` is "we never looked", and a card that said "not queued" on no evidence would be
    // making a claim about GitHub that nobody made to us.
    expect(pendingQueueBadge({ inMergeQueue: null, mergeQueueEntryState: null })).toBeNull();
    expect(pendingQueueBadge({})).toBeNull();
  });

  it('⚠ renders nothing on a POSITIVE "not queued" either — the chip is positive-claim-only', () => {
    // `false` IS a statement from GitHub, and it is one worth exactly zero pixels: "this pull
    // request is not in a merge queue" is true of nearly every PR in the world.
    expect(pendingQueueBadge({ inMergeQueue: false, mergeQueueEntryState: null })).toBeNull();
  });

  it('names the queue on a queued PR whose entry state was not observed', () => {
    const badge = pendingQueueBadge({ inMergeQueue: true, mergeQueueEntryState: null });
    expect(badge?.label).toBe('In the merge queue');
    expect(badge?.tone).toBe('ok');
  });

  it('gives every entry state its own words, and none of them a raw enum', () => {
    for (const state of QUEUE_STATES) {
      const badge = pendingQueueBadge({ inMergeQueue: true, mergeQueueEntryState: state });
      expect(badge, state).not.toBeNull();
      expect(badge!.label, state).toBeTruthy();
      expect(badge!.title, state).toBeTruthy();
      // A label that still contains the wire spelling means somebody added a member and let the
      // enum through to the screen.
      expect(badge!.label, state).not.toContain('_');
    }
  });

  it('⚠ gives `unmergeable` its OWN wording and its own tone — GitHub is EJECTING it', () => {
    // This is the whole payload of the reported bug: a PR that silently falls out of the queue.
    // A reader has to be able to see it WITHOUT pressing Merge, which is why it is a header chip
    // and not a line in the merge row (that row is hidden outright without push access).
    const badge = pendingQueueBadge({ inMergeQueue: true, mergeQueueEntryState: 'unmergeable' });
    expect(badge?.tone).toBe('bad');
    expect(badge?.label).toBe('Leaving the merge queue');
    // Every OTHER state is calm — an ejection must not be one red chip among five.
    for (const state of QUEUE_STATES.filter((q) => q !== 'unmergeable')) {
      expect(pendingQueueBadge({ inMergeQueue: true, mergeQueueEntryState: state })?.tone).toBe('ok');
    }
  });
});

describe('a queued card keeps its cancel', () => {
  it('⚠ hides Merge while GitHub owns the landing — on a PR that is otherwise perfectly clean', () => {
    const gate = pendingMergeGate(mergeCard({ mergeStateStatus: 'clean', inMergeQueue: true }));
    expect(gate.queued).toBe(true);
    expect(gate.action).toBeNull();
    // ⚠ AND THE ROW STILL SHOWS. `show` is what strips the block, and stripping it would take
    // "Remove from queue" with it — the one thing still worth pressing.
    expect(gate.show).toBe(true);
    expect(gate.verdict.verdict).toBe('queued');
    expect(gate.verdict.canMerge).toBe(false);
  });

  it('hides Update branch too — the queue lands it from wherever it is', () => {
    const gate = pendingMergeGate(updateBranchCard({ inMergeQueue: true }));
    expect(gate.queued).toBe(true);
    expect(gate.action).toBeNull();
  });

  it('⚠ treats a NULL queue as not-observed, never as queued', () => {
    // The same three-state rule `mergeable` follows one field over. A null must not silently
    // remove a Merge button the reader can legitimately press.
    const gate = pendingMergeGate(mergeCard({ mergeStateStatus: 'clean', inMergeQueue: null }));
    expect(gate.queued).toBe(false);
    expect(gate.action).toBe('merge');
    expect(pendingMergeGate(mergeCard({ inMergeQueue: false })).queued).toBe(false);
  });

  it('⚠ never claims the queue for a reader who cannot push', () => {
    // `show: false` hides the whole block, and the gate must not leave a live action or a stale
    // queue claim behind it. The BADGE still renders — it lives in the header row for exactly
    // this reader, who has no button either way.
    const gate = pendingMergeGate(
      mergeCard({ mergeStateStatus: 'clean', inMergeQueue: true, viewerCanPush: false }),
    );
    expect(gate.show).toBe(false);
    expect(gate.action).toBeNull();
    expect(gate.queued).toBe(true);
  });
});

// ── RELEVANCE EMPHASIS ───────────────────────────────────────────────────────────────────────

function myTurnCard(
  over: { relevance?: MyTurnRelevance; muted?: boolean; reason?: MyTurnCard['reason']; ball?: MyTurnCard['ball'] } = {},
): MyTurnCard {
  return {
    id: 'mt:review_request:101',
    kind: 'my_turn',
    severity: 'warn',
    ...prRef(),
    reason: 'review_request',
    threadId: null,
    detail: 'asked 2d ago',
    since: '2026-08-25T10:00:00.000Z',
    personal: over.relevance !== 'none',
    ...over,
  };
}

describe('the section chip names what you are being asked to do', () => {
  it('⚠ says "Pushed since", not "New PR", once somebody pushed after you acted', () => {
    // THE REGRESSION. Since the ball rule, `watched_repo_pr` holds two different facts, and the
    // chip was a static map keyed on `reason` alone — so a PR the reader had approved three days
    // earlier wore "New PR" directly beside the detail "You approved · @robin-dunn pushed 2
    // commits since". Two adjacent elements on one card, contradicting each other.
    const card = myTurnCard({
      reason: 'watched_repo_pr',
      ball: { kind: 'commits_after', yourLastAction: 'approved', humanCommitsAfter: 2 },
    });
    expect(myTurnReasonLabel(card)).toBe('Pushed since');
  });

  it('still says "New PR" for a PR nobody has touched — the one place that is true', () => {
    expect(myTurnReasonLabel(myTurnCard({ reason: 'watched_repo_pr', ball: { kind: 'untouched' } }))).toBe(
      'New PR',
    );
  });

  it('⚠ an ABSENT ball falls back to the section label, never to a guess', () => {
    // `ball` is trailing-optional for wire tolerance. A response predating it must not have
    // "Pushed since" invented over a PR nobody has touched — the safe direction is the vaguer word.
    expect(myTurnReasonLabel(myTurnCard({ reason: 'watched_repo_pr' }))).toBe('New PR');
  });

  it('leaves every other section alone', () => {
    expect(myTurnReasonLabel(myTurnCard({ reason: 'review_request' }))).toBe('Review requested');
    expect(myTurnReasonLabel(myTurnCard({ reason: 'thread' }))).toBe('Reply needed');
    expect(myTurnReasonLabel(myTurnCard({ reason: 'claude_review' }))).toBe('Claude review');
  });
});

describe('which rows outrank the neutral ones', () => {
  it('emphasises BOTH personal tiers — the pair every badge counts as one population', () => {
    // `myTurnPersonal`, the Workspace badges, the "Elsewhere" rows and the browser notification
    // all count `relevance !== 'none'`. Emphasising only 'direct' would put a different
    // population on screen from the one the counts describe.
    expect(pendingCardIsPersonal(myTurnCard({ relevance: 'direct' }))).toBe(true);
    expect(pendingCardIsPersonal(myTurnCard({ relevance: 'maintained' }))).toBe(true);
  });

  it('leaves a "none" card neutral — including a MUTED one, which is how the mute lands', () => {
    // The Pending mute forces `relevance: 'none'` server-side, at the one fold where it is
    // derived. Nothing here knows the mute exists, and nothing here may re-introduce emphasis
    // for it.
    expect(pendingCardIsPersonal(myTurnCard({ relevance: 'none' }))).toBe(false);
    expect(pendingCardIsPersonal(myTurnCard({ relevance: 'none', muted: true }))).toBe(false);
  });

  it('⚠ renders an ABSENT relevance as neutral even when `personal` is true', () => {
    // The same rule `cardKindLabel` follows: a missing field may never invent an ownership claim
    // on screen, in words OR in weight. The only way here is a server too old to send it.
    const card = myTurnCard();
    delete (card as { relevance?: MyTurnRelevance }).relevance;
    card.personal = true;
    expect(pendingCardIsPersonal(card)).toBe(false);
  });

  it('⚠ never emphasises a FORWARD card, even one marked "direct"', () => {
    // The two forward kinds carry `relevance` for the RANKER's weight — it is explicitly not an
    // ownership claim, the board's relevance lens does not filter on it, and, decisively, the
    // Pending mute does NOT reach them. A muted repo's merge card still arrives 'direct', so
    // emphasising it would light up exactly the row the reader asked to stop being summoned by.
    expect(mergeCard().relevance).toBe('direct');
    expect(pendingCardIsPersonal(mergeCard())).toBe(false);
    expect(pendingCardIsPersonal(updateBranchCard())).toBe(false);
  });
});

// ── THE `conflicts` CARD ─────────────────────────────────────────────────────────────────────
//
// GitHub cannot merge this pull request: the head conflicts with the base. The third shape on the
// board — not a summons like `my_turn`, not an opportunity like the two forward kinds — and the
// ONLY one with no action behind it anywhere, GitHub's own UI included. So everything below is
// about what the card is allowed to SAY, and the one thing it may never grow.
//
//   ⚠ THE HEADER ALREADY SAYS "Merge conflicts". That is why the second-fact chip suppresses
//     itself on the `dirty` arm: `MERGE_STATE_LABEL.dirty` is the word "conflicts", and printing
//     it under a label reading "Merge conflicts" is one sentence twice on the one board where
//     every line has to earn its width.
//   ⚠ AND THE CHIP DOES NOT GO THROUGH `mergeVerdict`. That resolver's queue branch runs FIRST,
//     so a conflicting PR sitting in GitHub's merge queue would report 'queued' and lose the
//     conflict statement entirely — while the queue is already stated, in better words, by
//     `pendingQueueBadge` in the header row.

describe('the conflicts card', () => {
  it('⚠ says NOTHING under the header on the `dirty` arm — the header already said it', () => {
    expect(conflictsStateChip(conflictsCard({ mergeStateStatus: 'dirty' }))).toBeNull();
    // Spelled out: the suppressed word is the one already on the label above it.
    expect(KIND_LABEL.conflicts).toBe('Merge conflicts');
  });

  it('keeps GitHub’s OTHER word on the `mergeable: conflicting` arm', () => {
    // The row is minted off `mergeable` alone here, so GitHub's protection-aware state says
    // something the reader cannot get from anywhere else on the row.
    expect(
      conflictsStateChip(conflictsCard({ mergeStateStatus: 'blocked', mergeable: 'conflicting' })),
    ).toBe('blocked');
    expect(
      conflictsStateChip(conflictsCard({ mergeStateStatus: 'behind', mergeable: 'conflicting' })),
    ).toBe('behind trunk');
  });

  it('⚠ says nothing for a state GitHub has not computed, and nothing for one never observed', () => {
    // 'unknown' and null are the same fact one column apart — "we have not been told" — and
    // neither is something to print.
    expect(conflictsStateChip(conflictsCard({ mergeStateStatus: 'unknown' }))).toBeNull();
    expect(conflictsStateChip(conflictsCard({ mergeStateStatus: null }))).toBeNull();
  });

  it('⚠ is NEVER emphasised as the reader’s own, even in a repo they can push to', () => {
    // The kind is minted only for repos the viewer can WRITE to, and the card carries a
    // `relevance` for the ranker weight and the severity accent. Neither is an ownership claim:
    // write access to a repository is not ownership of a stranger's pull request, and
    // `pendingCardIsPersonal` narrows `my_turn` and nothing else.
    expect(pendingCardIsPersonal(conflictsCard())).toBe(false);
    expect(pendingCardIsPersonal(conflictsCard({ relevance: 'direct' }))).toBe(false);
    expect(pendingCardIsPersonal(conflictsCard({ relevance: 'maintained' }))).toBe(false);
  });

  it('wears the neutral kind label — it claims nothing about the reader to soften', () => {
    // `cardKindLabel` exists to soften OWNERSHIP claims (my_turn's relevance, ci_failing's arms).
    // This kind makes none, so it must pass straight through the label map.
    expect(cardKindLabel(conflictsCard({ relevance: 'direct' }))).toBe('Merge conflicts');
    expect(cardKindLabel(conflictsCard({ relevance: 'maintained' }))).toBe('Merge conflicts');
  });

  it('still carries the kind-blind queue badge — and a PR being EJECTED is where it matters', () => {
    // A conflicting PR that GitHub is throwing out of its merge queue is exactly the row a reader
    // has to be able to see without pressing anything.
    const badge = pendingQueueBadge(
      conflictsCard({ inMergeQueue: true, mergeQueueEntryState: 'unmergeable' }),
    );
    expect(badge?.label).toBe('Leaving the merge queue');
    expect(badge?.tone).toBe('bad');
    // …and the three-state rule holds here as everywhere: not observed says nothing.
    expect(pendingQueueBadge(conflictsCard({ inMergeQueue: null }))).toBeNull();
    expect(pendingQueueBadge(conflictsCard({ inMergeQueue: false }))).toBeNull();
  });

  it('⚠ IS NEVER HANDED A MERGE ACTION — there is no button, here or on GitHub', () => {
    // THE GUARD. `pendingMergeGate` is typed to the two FORWARD kinds, so wiring a conflicts card
    // into `PendingMergeActions` is a compile error today — but this directory is not typechecked
    // (CLAUDE.md § Known gaps), so the runtime consequence is pinned instead, three ways:
    //
    //  1. The card carries no `viewerCanPush`, so the gate HIDES the row outright rather than
    //     leaving a live action behind a false `show`.
    const card = conflictsCard();
    expect('viewerCanPush' in card).toBe(false);
    const gate = pendingMergeGate(card as unknown as MergeReadyCard);
    expect(gate.show).toBe(false);
    expect(gate.action).toBeNull();

    //  2. And even with write access invented, the card's OWN columns resolve to a verdict that
    //     offers nothing — on BOTH mint arms. A merge here is a 405, and "Update branch" cannot
    //     resolve a conflict.
    for (const arm of [
      conflictsCard({ mergeStateStatus: 'dirty', mergeable: 'unknown' }),
      conflictsCard({ mergeStateStatus: 'blocked', mergeable: 'conflicting' }),
    ]) {
      const forced = pendingMergeGate({
        ...arm,
        viewerCanPush: true,
      } as unknown as MergeReadyCard);
      expect(forced.verdict.verdict, arm.mergeStateStatus ?? 'null').toBe('conflicts');
      expect(forced.verdict.canMerge, arm.mergeStateStatus ?? 'null').toBe(false);
      expect(forced.action, arm.mergeStateStatus ?? 'null').toBeNull();
    }

    //  3. And it carries no `lastCommitAt` either — the forward cards' ranker clock, which on this
    //     kind would read as "conflicting since", a fact nobody holds. The card dates itself off
    //     `openedAt` like every other PR-bearing kind.
    expect('lastCommitAt' in card).toBe(false);
    expect(card.openedAt).toBeTruthy();
  });
});

// ── THE PR'S OWN AGE ON A PENDING CARD ───────────────────────────────────────────────────────
//
// "opened 3d", appended to the right-hand meta of the PR-bearing kinds whose own clock answers a
// different question (my_turn's "when the thing that needs you happened", the forward kinds'
// head-commit time, reviewer_routing's "unassigned", and the conflicts card, which has no clock
// of its own at all).
//
//   ⚠ TWO CLOCKS, ONE FORMATTER, AND THEY MUST NOT BE COLLAPSED. `ageLabel` — not exported — is
//     fed a SERVER-computed `ageHours` on `stalled_review` and `untouched_thread`; those two keep
//     saying "waiting 4d" / "6h old" because that IS the question they ask. `openedAgeLabel`
//     turns the wire's absolute `openedAt` into hours HERE-side, with the server's own rounding.
//   ⚠ AND `ageLabel` DOES NOT ROUND ITS ARGUMENT — it interpolates it. Its two existing callers
//     get a pre-rounded number off the wire, so nothing in the codebase would have caught a raw
//     float landing on a card as "opened 3.7166666666666663h".

/** The server's own spelling, restated because `ageLabel` is module-private: `stalled_review` is
 *  served `ageHours = Math.round((now - pull_requests.opened_at) / 3_600_000)` and rendered as
 *  `waiting ${ageLabel(ageHours)}`. */
const serverAgeLabel = (hours: number): string =>
  hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;

/** An ISO instant exactly `hours` in the past, as the wire would carry it. */
const agoIso = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

describe('the PR age on a Pending card', () => {
  it('reads in hours under two days', () => {
    expect(openedAgeLabel(agoIso(6))).toBe('opened 6h');
    expect(openedAgeLabel(agoIso(1))).toBe('opened 1h');
  });

  it('reads in days from two days out', () => {
    expect(openedAgeLabel(agoIso(3 * 24))).toBe('opened 3d');
    expect(openedAgeLabel(agoIso(21 * 24))).toBe('opened 21d');
  });

  it('⚠ ROUNDS — a raw float must never reach the card', () => {
    // THE LANDMINE. `${hours}h` interpolates whatever it is given, so an unrounded elapsed time
    // renders as "opened 3.7166666666666663h" on a live row.
    const label = openedAgeLabel(agoIso(3 + 43 / 60));
    expect(label).toMatch(/^opened \d+h$/);
    expect(label).not.toContain('.');
    expect(label).toBe('opened 4h'); // 3h43m rounds up, the server's own spelling
  });

  it('⚠ returns NULL for anything unreadable — never "0h"', () => {
    // A response predating the field, or a malformed date. The card then renders no age at all,
    // which is the honest answer for "we don't know"; a zero would be a claim.
    expect(openedAgeLabel(null)).toBeNull();
    expect(openedAgeLabel(undefined)).toBeNull();
    expect(openedAgeLabel('not-a-date')).toBeNull();
    expect(openedAgeLabel('')).toBeNull();
  });

  it('clamps clock skew to "opened 0h" rather than printing a negative age', () => {
    // A PR whose `openedAt` is a few seconds in this browser's future. "opened -1h" is nonsense;
    // "opened 0h" is a PR opened just now, which is what it is.
    expect(openedAgeLabel(new Date(Date.now() + 90 * 60_000).toISOString())).toBe('opened 0h');
  });

  it('cuts hours→days on the ROUNDED hour count, at 48', () => {
    // The boundary is `ageLabel`'s `< 48`, applied AFTER the rounding — so 47.5h is 48 hours is
    // two days, and 47.4h is still forty-seven hours.
    expect(openedAgeLabel(agoIso(47.5))).toBe('opened 2d');
    expect(openedAgeLabel(agoIso(47.4))).toBe('opened 47h');
  });

  it('⚠ agrees with the SERVER’s figure — which is why stalled_review does not render both', () => {
    // `stalled_review`'s `ageHours` IS the PR's age since `opened_at`, so "waiting 3d · opened 3d"
    // would be one number printed twice under two names. This assertion is what a future "finish
    // the migration" pass — adding `openedAt={card.openedAt}` to that case — lands on.
    for (const hours of [1, 6, 23, 47, 48, 72, 24 * 30]) {
      expect(openedAgeLabel(agoIso(hours)), `${hours}h`).toBe(`opened ${serverAgeLabel(hours)}`);
    }
  });

  it('⚠ IS SUPPRESSED WHEN THE CARD’S OWN CLOCK SAYS THE SAME THING — see clockSaysMore', () => {
    // FOUND BY RUNNING IT, not by a test: on the reporting account's own workspace, TEN OF TEN
    // Pending cards read "8 hours ago · opened 8h". `clockSaysMore` is what stops that, and the
    // rule lives in `CardShell` so no call site can forget it.
    expect(clockSaysMore(agoIso(8), agoIso(8))).toBe(false);
  });

  it('dates a conflicts card, which has no clock of its own', () => {
    // The kind carries no `lastCommitAt` by design, so this is its ENTIRE right-hand meta — the
    // shell's `right != null` guard drops the separator and the row reads a bare "opened 3d".
    const card = conflictsCard();
    expect(openedAgeLabel(card.openedAt)).toMatch(/^opened \d+[hd]$/);
  });
});

// ── WHERE THE REVIEW STANDS ──────────────────────────────────────────────────────────────────

function reviewer(over: Partial<InsightReviewer> & { userId: number }): InsightReviewer {
  return {
    standing: 'commented' as ReviewStanding,
    standingAt: '2026-08-26T09:00:00.000Z',
    isBot: false,
    botKind: null,
    ...over,
  };
}

describe('the review standing line', () => {
  it('⚠ says NOTHING when nothing has happened and nothing is required', () => {
    // ~90% of open non-draft PRs. A "No reviews · none required" line on ninety percent of a
    // fifty-row board is the unrequested caveat the product voice bans.
    expect(pendingReviewLead(prRef())).toBeNull();
    expect(pendingReviewLead({})).toBeNull();
  });

  it('counts approvals in OUR words', () => {
    expect(pendingReviewLead(prRef({ reviewApprovals: 1, reviewerCount: 1 }))?.ours).toBe(
      '1 approval',
    );
    expect(pendingReviewLead(prRef({ reviewApprovals: 3, reviewerCount: 3 }))?.ours).toBe(
      '3 approvals',
    );
  });

  it('⚠ leads with the block AND KEEPS the approvals — they coexist on real PRs', () => {
    const lead = pendingReviewLead(
      prRef({ reviewChangesRequested: true, reviewApprovals: 1, reviewerCount: 2 }),
    );
    expect(lead?.standing).toBe('changes_requested');
    expect(lead?.ours).toBe('Changes requested · 1 approval');
    // Deleting the approval count to make the block louder would be losing a fact to make a
    // point — the card would then disagree with the PR pane about the same PR.
    expect(lead?.ours).toContain('1 approval');
  });

  it('⚠ distinguishes "nobody looked" from "no review required" — two fields, two clauses', () => {
    // The single most dangerous conflation on this wire. `reviewDecision: null` is the REPO's
    // rule; `reviewerCount: 0` is what people did.
    const nobody = pendingReviewLead(prRef({ reviewerCount: 0, reviewDecision: 'review_required' }));
    expect(nobody?.ours).toBe('No reviews yet');
    expect(nobody?.github).toBe('GitHub: review required');

    const looked = pendingReviewLead(prRef({ reviewerCount: 2, reviewDecision: null }));
    // Somebody looked, nobody signed off — and GitHub is not asking anyone to.
    expect(looked?.ours).toBe('No approval yet');
    expect(looked?.github).toBe('GitHub: no review required');
    // ⚠ AND THE TWO NEVER SHARE A CLAUSE.
    expect(looked?.ours).not.toContain('required');
  });

  it('⚠ shows BOTH answers where our fold and GitHub disagree, labelled apart', () => {
    // GitHub approved, our fold counted none (an approval GitHub itself dismissed, or one from a
    // reviewer we cannot see). Merging them would pick a winner silently.
    const a = pendingReviewLead(prRef({ reviewApprovals: 0, reviewerCount: 1, reviewDecision: 'approved' }));
    expect(a?.ours).toBe('No approval yet');
    expect(a?.github).toBe('GitHub: approved');

    // GitHub blocks, our rows show nobody blocking.
    const b = pendingReviewLead(
      prRef({ reviewChangesRequested: false, reviewerCount: 1, reviewDecision: 'changes_requested' }),
    );
    expect(b?.github).toBe('GitHub: changes requested');
    expect(b?.ours).not.toContain('Changes requested');
  });

  it('stays quiet where GitHub only repeats us', () => {
    // Two chips saying "approved" is noise, and noise is what stops the disagreement above being
    // noticed when it matters.
    expect(
      pendingReviewLead(prRef({ reviewApprovals: 2, reviewerCount: 2, reviewDecision: 'approved' }))
        ?.github,
    ).toBeNull();
    expect(
      pendingReviewLead(
        prRef({ reviewChangesRequested: true, reviewerCount: 1, reviewDecision: 'changes_requested' }),
      )?.github,
    ).toBeNull();
    // And "no review required" is never said beside an approval count, which implies no
    // obligation on its own.
    expect(
      pendingReviewLead(prRef({ reviewApprovals: 1, reviewerCount: 1, reviewDecision: null }))?.github,
    ).toBeNull();
  });

  it('⚠ says "review required" even over a healthy-looking approval count', () => {
    // The one case where GitHub's field is worth more than ours: two approvals that do not
    // satisfy a CODEOWNERS rule. Suppressing it as "redundant" hides the reason the PR will not
    // merge.
    const lead = pendingReviewLead(
      prRef({ reviewApprovals: 2, reviewerCount: 2, reviewDecision: 'review_required' }),
    );
    expect(lead?.ours).toBe('2 approvals');
    expect(lead?.github).toBe('GitHub: review required');
  });
});

describe('the reviewer chips', () => {
  const dana = reviewer({ userId: 1, standing: 'changes_requested' });
  const sam = reviewer({ userId: 2, standing: 'approved' });
  const rabbit = reviewer({ userId: 3, isBot: true, botKind: 'coderabbit' });
  const copilot = reviewer({ userId: 4, isBot: true, botKind: 'copilot' });
  const nameless = reviewer({ userId: 5, isBot: true, botKind: null });

  it('names the humans in the order the server ranked them', () => {
    // The wire ranks changes_requested → approved → commented → dismissed, humans before bots.
    // The client must not re-sort: a second ranking is a second opinion.
    const chips = pendingReviewerChips(prRef({ reviewers: [dana, sam], reviewerCount: 2 }));
    expect(chips.humans.map((r) => r.userId)).toEqual([1, 2]);
    expect(chips.bots).toBeNull();
  });

  it('⚠ collapses EVERY bot into one chip that says what they did', () => {
    // Measured: 39% of reviewer standings on open PRs are bot-authored and 477 of 478 of those
    // are merely `commented`. A flat list buries the one human approval under four vendor rows.
    const chips = pendingReviewerChips(
      prRef({ reviewers: [sam, rabbit, copilot, nameless], reviewerCount: 4 }),
    );
    expect(chips.humans.map((r) => r.userId)).toEqual([2]);
    expect(chips.bots?.count).toBe(3);
    expect(chips.bots?.label).toBe('3 bots commented');
    expect(chips.bots?.standing).toBe('commented');
    // ⚠ An unbranded CI account is a REAL, common state — it is named "Bot", never dropped and
    // never given an invented brand.
    expect(chips.bots?.title).toContain('CodeRabbit commented');
    expect(chips.bots?.title).toContain('Bot commented');
  });

  it('⚠ draws the collapsed chip with the STRONGEST standing among the bots', () => {
    // A bot that blocked the PR must not be drawn as a comment just because three others chatted.
    const blocker = reviewer({ userId: 6, isBot: true, botKind: 'coderabbit', standing: 'changes_requested' });
    const chips = pendingReviewerChips(prRef({ reviewers: [blocker, copilot], reviewerCount: 2 }));
    expect(chips.bots?.standing).toBe('changes_requested');
    // Mixed standings: the chip says the shorter true thing, and the breakdown moves to the
    // tooltip rather than being flattened into a wrong verb.
    expect(chips.bots?.label).toBe('2 bots reviewed');
    expect(chips.bots?.title).toBe('CodeRabbit requested changes · Copilot commented');
  });

  it('collapses a single bot too, and keeps the count singular', () => {
    const chips = pendingReviewerChips(prRef({ reviewers: [rabbit], reviewerCount: 1 }));
    expect(chips.bots?.label).toBe('1 bot commented');
  });

  it('⚠ takes "+N" from the SERVER\'s total, never from a subtraction of its own lists', () => {
    // The cap disclosure gates on `complete`, exactly as `capFor`'s `shown === count` does. A
    // client that subtracted its way to a total would silently read 0 the moment the list were
    // filtered for any other reason — and a reviewer with no GitHub account left is COUNTED and
    // UNNAMEABLE, which is a gap no subtraction of the visible chips can find.
    const chips = pendingReviewerChips(
      prRef({ reviewers: [dana, sam, rabbit], reviewerCount: 9 }),
    );
    expect(chips.complete).toBe(false);
    expect(chips.total).toBe(9);
    expect(chips.moreCount).toBe(6);
    // The bot chip counts ONE seat on screen but THREE would-be rows; the "+6" is over the named
    // list, bots included, never over the chips drawn.
    expect(chips.humans.length + (chips.bots ? 1 : 0)).toBe(3);
  });

  it('discloses nothing when every reviewer is named', () => {
    const chips = pendingReviewerChips(prRef({ reviewers: [dana, sam], reviewerCount: 2 }));
    expect(chips.complete).toBe(true);
    expect(chips.moreCount).toBe(0);
  });

  it('degrades to an empty row on a surface that carries neither field', () => {
    const chips = pendingReviewerChips({});
    expect(chips.humans).toEqual([]);
    expect(chips.bots).toBeNull();
    expect(chips.complete).toBe(true);
    expect(chips.moreCount).toBe(0);
  });
});

// ── THE ARM DRAFT ────────────────────────────────────────────────────────────────────────────
//
// The bug this pins, in the words it was reported in: "'Merge when ready' after having armed 1 or
// 2 other PRs this way does not display the arm confirmation inline — it reverts to the unpressed
// button state."
//
// THE MECHANISM. The board keys every card on `card.id`, and the server builds the two forward
// ids as `wp:merge:<prId>` and `wp:update_branch:<prId>` — the MERGE KIND is in the key. Arming a
// PR hands it to the auto-merge runner, which lands it on its ~2-minute tick; trunk moves; the
// 60-second liveness sweep reports `changed > 0` and re-fetches the board; every PR that just
// fell behind comes back under a DIFFERENT card id. React unmounts that subtree and mounts a new
// one, and a confirmation held in `useState` is gone. It reads as a dead button rather than a
// remount because `useMergeOptions` is cached, so the fresh mount reads GitHub's answer straight
// back and renders the full un-pressed button instead of the compact "ask GitHub" trigger.
//
// So the draft is keyed by prId — the half that does NOT change — and every assertion below is
// about a PR id outliving a card id.
//
// ⚠ The store is module-level, so each test uses its own prIds rather than resetting it. That is
// the same property the app relies on: one reader's clicks, never a shared bucket.

/** The two card ids one pull request can be handed by the server, depending on its merge state. */
const cardId = (kind: 'merge' | 'update_branch', prId: number): string => `wp:${kind}:${prId}`;

describe('the arm draft reducer', () => {
  it('makes "ask" one-way — the reader never pays for the same answer twice', () => {
    expect(armDraftReducer('idle', { type: 'ask' })).toBe('asked');
    // Already past it: a stray second click (or a re-render racing the fetch) must not knock a
    // live confirmation back down to "asked", which would close the panel under the reader.
    expect(armDraftReducer('confirming', { type: 'ask' })).toBe('confirming');
  });

  it('opens and closes the confirm step, dropping back to "asked" and never to "idle"', () => {
    expect(armDraftReducer('asked', { type: 'confirm' })).toBe('confirming');
    // ⚠ NOT 'idle'. The merge-options call is already bought and paid for; returning to idle
    // would re-render the compact trigger and charge GitHub a second time for an answer we hold.
    expect(armDraftReducer('confirming', { type: 'cancel' })).toBe('asked');
    // Cancel is only meaningful against an open panel.
    expect(armDraftReducer('asked', { type: 'cancel' })).toBe('asked');
  });

  it('"settled" clears the draft outright — the armed intent owns the row from there', () => {
    for (const from of ['idle', 'asked', 'confirming'] as const) {
      expect(armDraftReducer(from, { type: 'settled' })).toBe('idle');
    }
  });
});

describe('the draft outlives the card id', () => {
  it('⚠ keeps a half-finished confirmation when the card is re-keyed under it', () => {
    const prId = 5101;
    dispatchArmDraft(prId, { type: 'ask' });
    dispatchArmDraft(prId, { type: 'confirm' });

    // The PR falls behind trunk. The board re-fetches and hands the SAME pull request back under
    // a different card id, so React remounts the row — the exact moment the old `useState` died.
    expect(cardId('merge', prId)).not.toBe(cardId('update_branch', prId));
    expect(armDraftFor(prId)).toBe('confirming');
    // And the control still renders the confirmation, not the unpressed button.
    expect(armControlPhase({ draft: armDraftFor(prId), intentArmed: false, posting: false })).toBe(
      'confirming',
    );
  });

  it('⚠ arming one PR leaves every other PR’s draft alone', () => {
    // The reported trigger is "after having armed 1 or 2 other PRs". Those arms move the world
    // (trunk, the board, the card ids) but they must not reach into a third PR's draft.
    const a = 5201;
    const b = 5202;
    const c = 5203;
    dispatchArmDraft(c, { type: 'ask' });
    dispatchArmDraft(c, { type: 'confirm' });
    for (const other of [a, b]) {
      dispatchArmDraft(other, { type: 'ask' });
      dispatchArmDraft(other, { type: 'confirm' });
      dispatchArmDraft(other, { type: 'settled' }); // its POST landed
    }
    expect(armDraftFor(a)).toBe('idle');
    expect(armDraftFor(b)).toBe('idle');
    expect(armDraftFor(c)).toBe('confirming');
  });

  it('an untouched PR has no entry at all — nothing on the board fetches on mount', () => {
    // `idle` is the ABSENCE of an entry, and idle is what gates `useMergeOptions` off. Fifty
    // cards nobody clicked hold fifty nothings and make zero GitHub calls.
    expect(armDraftFor(5301)).toBe('idle');
  });
});

describe('armControlPhase decides what the control shows', () => {
  it('⚠ still reports "armed" for a PR whose card was re-keyed after arming', () => {
    // The whole point: armed-ness lives in the server-backed intent, not in the mount. Arm PR A,
    // let the card come back under a new id, and the row still says armed.
    const prId = 5401;
    dispatchArmDraft(prId, { type: 'ask' });
    dispatchArmDraft(prId, { type: 'confirm' });
    dispatchArmDraft(prId, { type: 'settled' }); // the hook-level onSuccess, after the seed
    expect(armDraftFor(prId)).toBe('idle');
    expect(armControlPhase({ draft: armDraftFor(prId), intentArmed: true, posting: false })).toBe(
      'armed',
    );
  });

  it('⚠ never reports "armed" from the draft alone', () => {
    // A draft that remembered "armed" would keep claiming it after the watcher gave up — the one
    // thing this control may not do, because the claim is about what GitHub is going to do next.
    for (const draft of ['idle', 'asked', 'confirming'] as const) {
      expect(armControlPhase({ draft, intentArmed: false, posting: false })).not.toBe('armed');
    }
  });

  it('⚠ lets the confirmed intent OUTRANK the in-flight POST', () => {
    // Not theoretical: TanStack runs a mutation's hook-level onSuccess (which seeds the armed
    // list) BEFORE dispatching 'success', so for one render both are true. If `posting` won, the
    // row would say "Arming…" about a PR that is already armed.
    expect(armControlPhase({ draft: 'confirming', intentArmed: true, posting: true })).toBe('armed');
  });

  it('reports "arming" across the remount, so an in-flight POST is never invited twice', () => {
    // Read off the shared mutation key, so it holds even on a mount that did not start the POST.
    expect(armControlPhase({ draft: 'confirming', intentArmed: false, posting: true })).toBe(
      'arming',
    );
    expect(armControlPhase({ draft: 'idle', intentArmed: false, posting: true })).toBe('arming');
  });

  it('⚠ shows the UNPRESSED button for exactly one input triple — which is why order matters', () => {
    // `idle` is the reported failure state, and the only way to reach it is a cleared draft with
    // no intent and no POST. That is why `useArmAutoMerge` seeds the armed list BEFORE it clears
    // the draft: clearing first would put this triple on screen for a render, one frame after a
    // successful arm.
    expect(armControlPhase({ draft: 'idle', intentArmed: false, posting: false })).toBe('idle');
  });
});

// ── WHICH CLOCK SURVIVES WHEN A CARD HAS TWO ────────────────────────────────────────────────────
//
// `CardShell` renders the kind's own `right` (a bare relative time) and then "opened 3d". On a PR
// nobody has pushed to since it opened, those are THE SAME INSTANT, and the row printed one figure
// twice under two names — with only one of the names saying which clock it was.
//
// ⚠ THIS WAS NOT VISIBLE TO ANY TEST. It was found by opening the board: 10 of 10 cards on the
// reporting account's own workspace read "8 hours ago · opened 8h". Measured across the whole live
// database, 779 of 1,411 open non-draft PRs (55%) have no commit after the one they opened with.
//
// The rule: when the two round to the same label, the NAMED one wins and the bare relative time is
// dropped. Nothing is lost — it was the same number — and the survivor says what it measures.
describe('clockSaysMore — does a card’s own clock still add a fact?', () => {
  it('is FALSE when the two round to the same label, in hours and in days', () => {
    expect(clockSaysMore(agoIso(8), agoIso(8))).toBe(false);
    expect(clockSaysMore(agoIso(4 * 24), agoIso(4 * 24))).toBe(false);
    // ⚠ AND WHEN THEY MERELY ROUND TOGETHER. 30h and 30.4h are different instants that print the
    // same label, and it is the LABEL the reader compares — so a strict instant test would leave
    // the duplication on screen for exactly the rows it was written to remove.
    expect(clockSaysMore(agoIso(4 * 24 + 5), agoIso(4 * 24))).toBe(false);
  });

  it('is TRUE when the clock names a different span — the case the age exists for', () => {
    // A PR open three days, pushed to two hours ago: "2 hours ago · opened 3d" is two facts.
    expect(clockSaysMore(agoIso(2), agoIso(3 * 24))).toBe(true);
    expect(clockSaysMore(agoIso(6), agoIso(20 * 24))).toBe(true); // "6 hours ago · opened 20d"
  });

  it('⚠ is FALSE across the 48h boundary, where the two FORMATTERS disagree', () => {
    // FOUND BY REVIEW, after the first cut shipped. `right` renders through `relativeTime`, which
    // switches hours→days at 24h; the age renders through `ageLabel`, which switches at 48h. So a
    // head commit 40h old on a PR opened 50h ago gives DIFFERENT `ageLabel` strings ("40h" vs
    // "2d") — the first version's only test — while the screen prints "2 days ago · opened 2d".
    // A live 12-hour window, on the exact duplication this helper exists to remove.
    expect(clockSaysMore(agoIso(40), agoIso(50))).toBe(false);
    expect(clockSaysMore(agoIso(47), agoIso(48))).toBe(false);
    expect(clockSaysMore(agoIso(36), agoIso(59))).toBe(false);
  });

  it('⚠ is FALSE when two different-looking figures would imply a gap that is not there', () => {
    // The mirror case, and why the predicate ANDs two tests rather than replacing one with the
    // other. A 30.4h commit on a 30h-old PR prints "1 day ago · opened 30h": different figures, so
    // the figures test alone would keep both — and a reader subtracting them infers a six-hour gap
    // between opening and pushing that does not exist. The label test catches it.
    expect(clockSaysMore(agoIso(30.4), agoIso(30))).toBe(false);
  });

  it('is FALSE when there is no clock to compare — a null `right` is not a second number', () => {
    expect(clockSaysMore(null, agoIso(8))).toBe(false);
    expect(clockSaysMore(undefined, agoIso(8))).toBe(false);
    expect(clockSaysMore('not-a-date', agoIso(8))).toBe(false);
  });

  it('⚠ is TRUE when the AGE is unreadable — the clock must not vanish with it', () => {
    // A response predating `openedAt`, or a malformed one. The age renders nothing; suppressing
    // the clock as well would leave the row with no time on it at all.
    expect(clockSaysMore(agoIso(8), null)).toBe(true);
    expect(clockSaysMore(agoIso(8), 'not-a-date')).toBe(true);
  });
});
