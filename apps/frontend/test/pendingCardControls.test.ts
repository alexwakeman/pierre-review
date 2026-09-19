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
//   6. EVERY CARD NAMES WHO OPENED IT. The byline reads `automation` — the same resolution the
//      People / Automation lens filters on — so a person gets their name, a branded bot its vendor
//      chip, an unbranded one what it does plus its login, and a tool on a person's account says
//      "<tool> via <person>". A missing account says so, and is never a bot.
//   7. A DEPENDENCIES CARD LANDS LIKE A FORWARD CARD. One card per dependency PR carries its merge
//      actions, decided by the same `mergeVerdict`; a person's PR a security tool flagged carries
//      none (its own cards do).
//   8. A PROMOTED MY TURN CARD KEEPS ITS CONTROLS. Settings → My Turn can move your own work into
//      My turn; the adapters rebuild the home card's shape so the same merge row, resolver entry
//      and trunk body render it — and the same gate decides what they offer.
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
  DependencyBumpCard,
  DependencyPrState,
  InsightReviewer,
  MergeQueueEntryState,
  MergeReadyCard,
  MergeStateStatus,
  Mergeable,
  MyTurnCard,
  MyTurnOwnWork,
  MyTurnRelevance,
  MyTurnTrunkCard,
  PrAutomation,
  PrReviewDecision,
  ReviewStanding,
  SecurityAlert,
  SecurityCard,
  UpdateBranchCard,
  User,
} from '@pierre-review/shared';
import {
  advisoryChips,
  advisoryParts,
  asCiFailingCard,
  asConflictsCard,
  asForwardCard,
  authorByline,
  authorSourceLabel,
  bylineParts,
  cardKindLabel,
  securityAlertLine,
  conflictsStateChip,
  KIND_LABEL,
  clockSaysMore,
  openedAgeLabel,
  pendingCardIsPersonal,
  pendingMergeGate,
  pendingQueueBadge,
  pendingReviewerChips,
  pendingReviewLead,
  landingPrByline,
  myTurnReasonLabel,
} from '../src/components/Activity/AttentionCards.js';
import {
  armControlPhase,
  armDraftFor,
  armDraftReducer,
  dispatchArmDraft,
} from '../src/hooks/useAutoMerge.js';
import { advisoryUrl } from '../src/lib/ui.js';
import {
  AUTHOR_ROLE_CHIP,
  DEP_STATE_LABEL,
  depStateSentence,
  SECURITY_ALERT_SOURCE_LABEL,
} from '../src/components/Activity/pendingLabels.js';

/** The `InsightPrRef` half every PR-bearing card carries, with the source pair varied per test. */
function prRef(
  over: {
    authorIsBot?: boolean;
    authorBotKind?: AutomatedReviewerKind | null;
    automation?: PrAutomation | null;
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
    // REQUIRED on the wire: null is "a person opened it", a statement rather than a gap.
    automation: null as PrAutomation | null,
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
  over: {
    relevance?: MyTurnRelevance;
    muted?: boolean;
    reason?: MyTurnCard['reason'];
    ball?: MyTurnCard['ball'];
    own?: MyTurnOwnWork;
  } = {},
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

/** A red default branch promoted into My turn — the ci_failing trunk arm's fields, as a my_turn. */
function trunkCard(over: Partial<MyTurnTrunkCard> = {}): MyTurnTrunkCard {
  return {
    id: 'myturn:trunk_red:7:abc1234',
    kind: 'my_turn',
    reason: 'trunk_red',
    severity: 'warn',
    repoId: 7,
    repoFullName: 'acme/api',
    branchName: 'main',
    ciStatus: 'failure',
    headSha: 'abc1234def',
    prId: 55,
    prNumber: 12,
    prTitle: 'Land the thing',
    mergedById: 3,
    viewerMerged: false,
    maintained: false,
    observedAt: '2026-08-27T09:00:00.000Z',
    githubUrl: 'https://github.com/acme/api/commit/abc1234def',
    detail: 'main is red at abc1234',
    since: '2026-08-27T09:00:00.000Z',
    personal: true,
    relevance: 'direct',
    threadId: null,
    authorId: 9,
    authorIsBot: true,
    authorBotKind: 'dependabot',
    automation: { role: 'dependency', kind: 'dependabot', source: 'account' },
    ...over,
  };
}

describe('the type chip names what you are being asked to do', () => {
  it('says "Pushed since" on its own type — no longer a second reading of "New PR"', () => {
    // Since Settings → My Turn, "somebody pushed after you acted" is its own type with its own
    // switch, so the chip is the map. The regression it replaced: a PR the reader had approved
    // wore "New PR" beside "You approved · @robin-dunn pushed 2 commits since".
    expect(myTurnReasonLabel(myTurnCard({ reason: 'pushed_since' }))).toBe('Pushed since');
    expect(
      myTurnReasonLabel(myTurnCard({ reason: 'watched_repo_pr', ball: { kind: 'untouched' } })),
    ).toBe('New PR');
  });

  it('says which kind of ready a promoted PR is — the words its home tab uses', () => {
    const ready = (forward: 'merge' | 'update_branch'): MyTurnOwnWork => ({
      kind: 'ready',
      forward,
      mergeStateStatus: forward === 'merge' ? 'clean' : 'behind',
      mergeable: 'mergeable',
      lastCommitAt: null,
      viewerCanPush: true,
    });
    expect(myTurnReasonLabel(myTurnCard({ reason: 'own_ready', own: ready('merge') }))).toBe(
      KIND_LABEL.merge,
    );
    expect(myTurnReasonLabel(myTurnCard({ reason: 'own_ready', own: ready('update_branch') }))).toBe(
      KIND_LABEL.update_branch,
    );
  });

  it('names every other type from the one map, the trunk card included', () => {
    expect(myTurnReasonLabel(myTurnCard({ reason: 'review_request' }))).toBe('Review requested');
    expect(myTurnReasonLabel(myTurnCard({ reason: 'mention' }))).toBe('Mentioned');
    expect(myTurnReasonLabel(myTurnCard({ reason: 'thread_reply' }))).toBe('Reply to you');
    expect(myTurnReasonLabel(myTurnCard({ reason: 'own_ci_red' }))).toBe('Build failed');
    expect(myTurnReasonLabel(trunkCard())).toBe('Trunk red');
  });
});

// ── A PROMOTED CARD KEEPS ITS CONTROLS ──────────────────────────────────────────────────────

describe('a promoted card, rebuilt as its home card', () => {
  const ready = (over: Partial<Extract<MyTurnOwnWork, { kind: 'ready' }>> = {}) =>
    ({
      kind: 'ready',
      forward: 'merge',
      mergeStateStatus: 'clean',
      mergeable: 'mergeable',
      lastCommitAt: '2026-08-27T09:00:00.000Z',
      viewerCanPush: true,
      ...over,
    }) as Extract<MyTurnOwnWork, { kind: 'ready' }>;

  it('offers Merge on a PR GitHub will merge, through the SAME gate as a merge card', () => {
    const own = ready();
    const f = asForwardCard(myTurnCard({ reason: 'own_ready', own }), own);
    expect(f.kind).toBe('merge');
    expect(f.prId).toBe(101);
    expect(pendingMergeGate(f)).toMatchObject({ show: true, action: 'merge' });
  });

  it('offers Update branch on a PR that is behind — never Merge', () => {
    const own = ready({ forward: 'update_branch', mergeStateStatus: 'behind' });
    const f = asForwardCard(myTurnCard({ reason: 'own_ready', own }), own);
    expect(f).toMatchObject({ kind: 'update_branch', mergeStateStatus: 'behind' });
    expect(pendingMergeGate(f).action).toBe('update_branch');
    // The home card's contract is `mergeStateStatus: 'behind'` BY TYPE, and the gate reads the
    // state, not the kind — so the adapter pins it rather than trusting the promoted row's copy.
    const drifted = ready({ forward: 'update_branch', mergeStateStatus: 'unknown' });
    const g = asForwardCard(myTurnCard({ reason: 'own_ready', own: drifted }), drifted);
    expect(pendingMergeGate(g).action).toBe('update_branch');
  });

  it('hides the row where you cannot push — the promoted fact, never a constant', () => {
    const own = ready({ viewerCanPush: false });
    expect(pendingMergeGate(asForwardCard(myTurnCard({ reason: 'own_ready', own }), own)).show).toBe(
      false,
    );
  });

  it('carries a promoted conflict’s merge state to the resolver entry', () => {
    const own: Extract<MyTurnOwnWork, { kind: 'conflicts' }> = {
      kind: 'conflicts',
      mergeStateStatus: 'dirty',
      mergeable: 'conflicting',
    };
    const c = asConflictsCard(myTurnCard({ reason: 'own_conflicts', own, relevance: 'direct' }), own);
    expect(c).toMatchObject({ kind: 'conflicts', mergeStateStatus: 'dirty', mergeable: 'conflicting' });
    expect(c.prId).toBe(101);
    // The header already says "Merge conflicts" — the `dirty` arm adds no second chip.
    expect(conflictsStateChip(c)).toBeNull();
  });

  it('rebuilds a red default branch as the trunk card, with the landing PR’s byline', () => {
    const t = trunkCard();
    const c = asCiFailingCard(t);
    expect(c).toMatchObject({
      kind: 'ci_failing',
      arm: 'trunk',
      repoId: 7,
      prId: 55,
      headSha: 'abc1234def',
      mergedById: 3,
      githubUrl: t.githubUrl,
    });
    // The four author fields are COPIED — never re-resolved — so the two cards for one red trunk
    // cannot disagree about who opened the landing PR.
    expect(landingPrByline(c)).toEqual({ authorId: 9, automation: t.automation });
    expect(c.authorIsBot).toBe(true);
    expect(c.authorBotKind).toBe('dependabot');
  });

  it('names no landing PR when the red head resolved to none — a direct push', () => {
    const c = asCiFailingCard(
      trunkCard({ prId: null, prNumber: null, prTitle: null, mergedById: null, authorId: null, authorIsBot: false, authorBotKind: null, automation: null }),
    );
    expect(landingPrByline(c)).toBeNull();
  });
});

describe('what a red default branch in My turn is called', () => {
  it('says "Your turn" like any type you added — and never "Review or reply" when muted', () => {
    expect(cardKindLabel(trunkCard())).toBe('Your turn');
    expect(cardKindLabel(trunkCard({ relevance: 'none', personal: false, muted: true }))).toBe(
      'Trunk CI failing',
    );
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

// ── AN INTENT THE WATCHER GAVE UP ON MUST BE VISIBLE SOMEWHERE ────────────────────────────────
//
// The reported bug: "the arming is disarmed for unknown reasons". It was not unknown to the
// server — `auto_merge_requests.last_reason` names it — but nothing on screen read that column
// once the intent stopped being `armed`. `usePrArmedIntent` filters to `state === 'armed'`, so
// the PR pane's chip, the Pending card's headline and the merge panel all simply lost their row;
// and the global banner's outcome card needs a prior in-tab observation, which a background tab
// or a reload does not have. `usePrStoppedIntent` is the selector that closes it.
//
// Pure selector logic, restated here — the hook itself is a one-line filter over the polled list
// and this pins the RULES, which is where the decisions are.
type StubIntent = { prId: number; state: string; lastReason: string | null };

function stoppedIntentOf(rows: StubIntent[], prId: number): StubIntent | null {
  const mine = rows.filter((r) => r.prId === prId);
  if (mine.some((r) => r.state === 'armed')) return null;
  return mine.find((r) => r.state !== 'armed' && r.state !== 'merged') ?? null;
}

describe('which auto-merge intent a PR surface should show', () => {
  const failed: StubIntent = { prId: 7, state: 'failed', lastReason: 'github: 2 of 3 checks' };

  it('surfaces a failed intent — the case that had no surface at all', () => {
    expect(stoppedIntentOf([failed], 7)?.state).toBe('failed');
  });

  it('surfaces every other giving-up state', () => {
    for (const state of ['disarmed_head_moved', 'disarmed_blocked', 'expired']) {
      expect(stoppedIntentOf([{ prId: 7, state, lastReason: null }], 7)?.state).toBe(state);
    }
  });

  it('⚠ says NOTHING about a MERGED intent — a success is not a notice', () => {
    // The banner announces the landing. A standing "auto-merge finished" line on a merged PR is
    // clutter, and on the Pending card it would sit under a row that is about to disappear.
    expect(stoppedIntentOf([{ prId: 7, state: 'merged', lastReason: null }], 7)).toBeNull();
  });

  it('⚠ a RE-ARM supersedes its own history', () => {
    // The list keeps resolved rows for 24h. A user who re-armed after a disarm must see the LIVE
    // state, not last night's obituary next to it.
    const rows = [failed, { prId: 7, state: 'armed', lastReason: null }];
    expect(stoppedIntentOf(rows, 7)).toBeNull();
  });

  it('never crosses PRs', () => {
    expect(stoppedIntentOf([failed], 8)).toBeNull();
  });
});


// ── WHO OPENED IT: the byline ────────────────────────────────────────────────────────────────
const user = (id: number, githubLogin: string, displayName: string | null = null): User => ({
  id,
  githubLogin,
  displayName,
  avatarUrl: null,
  isBot: false,
});
const USERS = new Map<number, User>([
  [9, user(9, 'alice', 'Alice Liddell')],
  [12, user(12, 'dependabot[bot]')],
  [13, user(13, 'erxes-dev-agent')],
  [14, { ...user(14, 'renovate[bot]'), avatarUrl: 'https://avatars.githubusercontent.com/in/2740' }],
]);

describe('the byline', () => {
  it('names a person by name, with their avatar', () => {
    expect(authorByline({ authorId: 9, automation: null }, USERS)).toEqual({
      mode: 'person',
      chip: null,
      chipKind: null,
      name: 'Alice Liddell',
      avatarUserId: 9,
    });
  });

  it('says "Deleted account" when GitHub has no account left — never a bot, never blank', () => {
    const b = authorByline({ authorId: null, automation: null }, USERS);
    expect(b.mode).toBe('person');
    expect(b.name).toBe('Deleted account');
    expect(b.avatarUserId).toBeNull();
  });

  it('names a BRANDED bot by its vendor chip alone — the chip is the name', () => {
    const b = authorByline(
      { authorId: 14, automation: { role: 'dependency', kind: 'renovate', source: 'account' } },
      USERS,
    );
    expect(b).toEqual({
      mode: 'automation',
      chip: 'Renovate',
      chipKind: 'renovate',
      name: null,
      avatarUserId: 14,
    });
  });

  it('⚠ draws a bot’s avatar only when it has a PICTURE — never initials beside the chip', () => {
    // Every GitHub-typed Bot row in the real DB has a NULL avatar_url, and the Avatar fallback is
    // two 10px initials: "DE" beside "Dependabot" says nothing, below the 11px floor.
    const bot = authorByline(
      { authorId: 12, automation: { role: 'dependency', kind: 'dependabot', source: 'account' } },
      USERS,
    );
    expect(bot.avatarUserId).toBeNull();
    expect(bot.chip).toBe('Dependabot');
    expect(
      authorByline({ authorId: 13, automation: { role: 'code_agent', kind: null, source: 'account' } }, USERS)
        .avatarUserId,
    ).toBeNull();
    // A PERSON keeps the initials — they are that person's mark, and nothing else names them twice.
    expect(authorByline({ authorId: 9, automation: null }, USERS).avatarUserId).toBe(9);
  });

  it('⚠ names an UNBRANDED bot by what it does, plus its login — never a person, never "Bot"', () => {
    const b = authorByline(
      { authorId: 13, automation: { role: 'code_agent', kind: null, source: 'account' } },
      USERS,
    );
    expect(b.mode).toBe('automation');
    expect(b.chip).toBe(AUTHOR_ROLE_CHIP.code_agent);
    expect(b.chip).toBe('Coding agent');
    expect(b.chipKind).toBeNull();
    expect(b.name).toBe('erxes-dev-agent');
    // `in_house` is a classification, not a brand: it reads by role too.
    expect(
      authorByline(
        { authorId: 13, automation: { role: 'dependency', kind: 'in_house', source: 'account' } },
        USERS,
      ).chip,
    ).toBe('Dependency bot');
  });

  it('⚠ says "<tool> via <person>" when a tool opened the PR on a person’s account', () => {
    // Snyk opens fix PRs with a member's credentials: the account is Alice's, the work is Snyk's.
    const b = authorByline(
      { authorId: 9, automation: { role: 'dependency', kind: 'snyk', source: 'marker' } },
      USERS,
    );
    expect(b).toEqual({
      mode: 'via',
      chip: 'Snyk',
      chipKind: 'snyk',
      name: 'Alice Liddell',
      avatarUserId: 9,
    });
    // …and an unbranded marker falls back to the role chip, still "via" the person.
    expect(
      authorByline({ authorId: 9, automation: { role: 'dependency', kind: null, source: 'marker' } }, USERS)
        .chip,
    ).toBe('Dependency bot');
  });

  it('⚠ DRAWS every piece it returns — a branded bot keeps its avatar — in the order it reads', () => {
    // The drawing maps `bylineParts` and nothing else. A branded bot's avatar used to be dropped,
    // because the avatar was drawn only beside a NAME, and the chip IS a branded bot's name.
    const draw = (pr: { authorId: number | null; automation: PrAutomation | null }) =>
      bylineParts(authorByline(pr, USERS));
    expect(draw({ authorId: 9, automation: null })).toEqual(['avatar', 'name']);
    expect(draw({ authorId: null, automation: null })).toEqual(['name']);
    expect(
      draw({ authorId: 14, automation: { role: 'dependency', kind: 'renovate', source: 'account' } }),
    ).toEqual(['avatar', 'chip']);
    // …and one with no picture draws its chip alone (see the avatar rule above).
    expect(
      draw({ authorId: 12, automation: { role: 'dependency', kind: 'dependabot', source: 'account' } }),
    ).toEqual(['chip']);
    expect(draw({ authorId: 13, automation: { role: 'code_agent', kind: null, source: 'account' } })).toEqual([
      'chip',
      'name',
    ]);
    // A tool on a person's account: the tool first, then whose account it used.
    expect(draw({ authorId: 9, automation: { role: 'dependency', kind: 'snyk', source: 'marker' } })).toEqual([
      'chip',
      'via',
      'avatar',
      'name',
    ]);
  });

  it('has a chip for every role', () => {
    for (const label of Object.values(AUTHOR_ROLE_CHIP)) expect(label.length).toBeGreaterThan(0);
    expect(Object.keys(AUTHOR_ROLE_CHIP).sort()).toEqual(
      ['code_agent', 'dependency', 'housekeeping', 'quality_check', 'release', 'review'].sort(),
    );
  });
});

// ── THE DEPENDENCIES CARDS ───────────────────────────────────────────────────────────────────
const DEPENDABOT: PrAutomation = { role: 'dependency', kind: 'dependabot', source: 'account' };

function bumpCard(over: {
  depState?: DependencyPrState;
  mergeStateStatus?: MergeStateStatus | null;
  mergeable?: Mergeable | null;
  viewerCanPush?: boolean;
  inMergeQueue?: boolean | null;
} = {}): DependencyBumpCard {
  return {
    id: 'deps:101',
    kind: 'dependency_bump',
    severity: 'info',
    ...prRef({ authorIsBot: true, authorBotKind: 'dependabot', automation: DEPENDABOT, inMergeQueue: over.inMergeQueue ?? null }),
    mergeStateStatus: over.mergeStateStatus === undefined ? 'clean' : over.mergeStateStatus,
    mergeable: over.mergeable === undefined ? 'mergeable' : over.mergeable,
    lastCommitAt: '2026-08-27T09:00:00.000Z',
    relevance: 'maintained',
    viewerCanPush: over.viewerCanPush ?? true,
    depState: over.depState ?? 'ready',
    detail: 'Nothing is blocking this — it can land now',
  };
}

function securityCard(over: Partial<SecurityCard> = {}): SecurityCard {
  return {
    id: 'security:101',
    kind: 'security',
    severity: 'high',
    ...prRef({ authorIsBot: true, authorBotKind: 'dependabot', automation: DEPENDABOT }),
    mergeStateStatus: 'clean',
    mergeable: 'mergeable',
    lastCommitAt: '2026-08-27T09:00:00.000Z',
    relevance: 'maintained',
    viewerCanPush: true,
    dependencyUpdate: true,
    depState: 'ready',
    fix: 'proven',
    alerts: [],
    alertCount: 0,
    advisoryIds: ['GHSA-9qr9-h5gf-34mp'],
    detail: 'Fixes GHSA-9qr9-h5gf-34mp',
    stateDetail: 'Nothing is blocking this — it can land now',
    ...over,
  };
}

describe('a Dependencies card’s merge row', () => {
  it('offers Merge on a ready dependency update — bump or security fix', () => {
    expect(pendingMergeGate(bumpCard()).action).toBe('merge');
    expect(pendingMergeGate(securityCard()).action).toBe('merge');
    // `unstable` is mergeable here too: one resolver, one answer.
    expect(pendingMergeGate(bumpCard({ mergeStateStatus: 'unstable' })).action).toBe('merge');
  });

  it('offers Update branch, never Merge, on a behind one', () => {
    const gate = pendingMergeGate(bumpCard({ depState: 'behind', mergeStateStatus: 'behind' }));
    expect(gate.show).toBe(true);
    expect(gate.action).toBe('update_branch');
  });

  it('offers no merge verb on conflicts — the resolver entry is a different row', () => {
    expect(
      pendingMergeGate(bumpCard({ depState: 'conflicts', mergeStateStatus: 'dirty', mergeable: 'conflicting' }))
        .action,
    ).toBeNull();
  });

  it('HIDES the row for a reader who cannot push', () => {
    const gate = pendingMergeGate(bumpCard({ viewerCanPush: false }));
    expect(gate.show).toBe(false);
    expect(gate.action).toBeNull();
  });

  it('⚠ gives a person’s PR a security tool flagged NO merge row — its own cards carry one', () => {
    const flagged = securityCard({
      dependencyUpdate: false,
      depState: null,
      fix: null,
      automation: null,
      authorIsBot: false,
      authorBotKind: null,
      stateDetail: null,
      detail: '',
    });
    const gate = pendingMergeGate(flagged);
    expect(gate.show).toBe(false);
    expect(gate.action).toBeNull();
  });

  it('⚠ treats a NULL merge state as not observed — no verb, and no throw', () => {
    const gate = pendingMergeGate(bumpCard({ depState: 'unknown', mergeStateStatus: null, mergeable: null }));
    expect(gate.show).toBe(true);
    expect(gate.action).toBeNull();
  });

  it('hides Merge while GitHub’s queue holds the PR', () => {
    const gate = pendingMergeGate(bumpCard({ inMergeQueue: true }));
    expect(gate.queued).toBe(true);
    expect(gate.action).toBeNull();
  });

  it('⚠ never says the merge state twice — the card’s state row says it, so the merge row does not', () => {
    // A blocked update printed "Blocked · Required checks or reviews aren’t satisfied" and, under
    // it, "blocked — required checks or reviews aren’t satisfied": one sentence, twice.
    const blocked = pendingMergeGate(bumpCard({ depState: 'blocked', mergeStateStatus: 'blocked' }));
    expect(blocked.show).toBe(true);
    expect(blocked.action).toBeNull();
    expect(blocked.verdictLine).toBe(false);
    expect(
      pendingMergeGate(securityCard({ depState: 'ci_red', mergeStateStatus: 'blocked' })).verdictLine,
    ).toBe(false);
    // A forward card has no state row: its merge row is the one place an absent button is explained.
    expect(pendingMergeGate(mergeCard({ mergeStateStatus: 'blocked' })).verdictLine).toBe(true);
    expect(pendingMergeGate(updateBranchCard()).verdictLine).toBe(true);
  });
});

describe('what a Dependencies card is called', () => {
  it('says which kind of security item it is — a fix, or an alert', () => {
    expect(cardKindLabel(securityCard())).toBe('Security fix');
    // An inferred fix is headed as what is known, never as a fix the card cannot back.
    expect(cardKindLabel(securityCard({ fix: 'inferred' }))).toBe('Likely security fix');
    expect(cardKindLabel(securityCard({ fix: null }))).toBe('Security alert');
    expect(cardKindLabel(bumpCard())).toBe('Dependency update');
  });

  it('names the two chips as the tab names them', () => {
    expect(KIND_LABEL.security).toBe('Security');
    expect(KIND_LABEL.dependency_bump).toBe('Bumps');
  });

  it('has a state chip decision for EVERY state — and says nothing where the chip would repeat or guess', () => {
    const states: DependencyPrState[] = ['conflicts', 'ci_red', 'behind', 'ready', 'needs_review', 'blocked', 'unknown'];
    expect(Object.keys(DEP_STATE_LABEL).sort()).toEqual([...states].sort());
    expect(DEP_STATE_LABEL.ready).toBe(KIND_LABEL.merge);
    expect(DEP_STATE_LABEL.behind).toBe(KIND_LABEL.update_branch);
    // The sentence says "Conflicts with main" / "Needs an approving review" (and the review row
    // says "GitHub: review required" above it); the meta row's CI dot says "CI failing"; GitHub has
    // not worked `unknown` out.
    expect(DEP_STATE_LABEL.conflicts).toBeNull();
    expect(DEP_STATE_LABEL.needs_review).toBeNull();
    expect(DEP_STATE_LABEL.ci_red).toBeNull();
    expect(DEP_STATE_LABEL.unknown).toBeNull();
  });

  it('prints the state sentence once — and none for a red build, which the CI dot already says', () => {
    expect(depStateSentence({ ...bumpCard({ depState: 'ci_red' }), detail: 'CI is failing' })).toBeNull();
    expect(
      depStateSentence(securityCard({ depState: 'ci_red', stateDetail: 'CI is failing' })),
    ).toBeNull();
    expect(
      depStateSentence({
        ...bumpCard({ depState: 'needs_review' }),
        detail: 'Needs an approving review',
      }),
    ).toBe('Needs an approving review');
    expect(depStateSentence(securityCard({ stateDetail: 'Nothing is blocking this — it can land now' }))).toBe(
      'Nothing is blocking this — it can land now',
    );
    // A person's PR a tool flagged has no dependency state, and so no sentence.
    expect(depStateSentence(securityCard({ depState: null, stateDetail: null }))).toBeNull();
  });
});

describe('the advisory links', () => {
  it('points each scheme at its public page', () => {
    expect(advisoryUrl('CVE-2026-30827')).toBe('https://nvd.nist.gov/vuln/detail/CVE-2026-30827');
    expect(advisoryUrl('GHSA-9qr9-h5gf-34mp')).toBe('https://github.com/advisories/GHSA-9qr9-h5gf-34mp');
    expect(advisoryUrl('RUSTSEC-2024-0001')).toBe('https://rustsec.org/advisories/RUSTSEC-2024-0001');
    expect(advisoryUrl('GO-2024-2887')).toBe('https://pkg.go.dev/vuln/GO-2024-2887');
    expect(advisoryUrl('PYSEC-2024-12')).toBe('https://osv.dev/vulnerability/PYSEC-2024-12');
    expect(advisoryUrl('OSV-2024-3')).toBe('https://osv.dev/vulnerability/OSV-2024-3');
    expect(advisoryUrl('SNYK-JS-LODASH-1018905')).toBe('https://security.snyk.io/vuln/SNYK-JS-LODASH-1018905');
  });

  it('gives NO link for a scheme with no public page', () => {
    expect(advisoryUrl('AIKIDO-2024-10001')).toBeNull();
    expect(advisoryUrl('ssc-0f4a2b6c-1d2e-4f50-8a9b-0c1d2e3f4a5b')).toBeNull();
    expect(advisoryUrl('CWE-79')).toBeNull();
  });

  it('shows the first three, and counts the rest from the full list', () => {
    (globalThis as unknown as { window: unknown }).window ??= { location: { origin: 'http://localhost' } };
    const { chips, more } = advisoryChips(['CVE-2026-1', 'GHSA-aaaa-bbbb-cccc', 'AIKIDO-2024-1', 'CVE-2026-2', 'CVE-2026-3']);
    expect(chips.map((c) => c.id)).toEqual(['CVE-2026-1', 'GHSA-aaaa-bbbb-cccc', 'AIKIDO-2024-1']);
    expect(chips[0]!.href).toBe('https://nvd.nist.gov/vuln/detail/CVE-2026-1');
    // No public page: a chip with no link, never a link to nowhere.
    expect(chips[2]!.href).toBeUndefined();
    expect(more).toBe(2);
    expect(advisoryChips(['CVE-2026-1']).more).toBe(0);
  });

  it('⚠ writes each id ONCE — linked in the sentence that names it, never again as a chip', () => {
    (globalThis as unknown as { window: unknown }).window ??= { location: { origin: 'http://localhost' } };
    // "Fixes GHSA-…" used to be followed by a "GHSA-…" chip: the same id twice, one line apart.
    const ids = ['GHSA-9qr9-h5gf-34mp'];
    expect(advisoryParts('Fixes GHSA-9qr9-h5gf-34mp', ids)).toEqual([
      { text: 'Fixes ' },
      { id: 'GHSA-9qr9-h5gf-34mp', href: 'https://github.com/advisories/GHSA-9qr9-h5gf-34mp' },
    ]);
    const named = new Set(['GHSA-9qr9-h5gf-34mp']);
    expect(advisoryChips(ids, named)).toEqual({ chips: [], more: 0 });
    // "and 2 more" in the sentence — the chip row lists exactly those two, and counts from THEM.
    const five = ['CVE-2026-1', 'CVE-2026-2', 'CVE-2026-3', 'CVE-2026-4', 'CVE-2026-5'];
    const fix = advisoryParts('Fixes CVE-2026-1 and 4 more', five);
    expect(fix.flatMap((p) => ('id' in p ? [p.id] : []))).toEqual(['CVE-2026-1']);
    const rest = advisoryChips(five, new Set(['CVE-2026-1']));
    expect(rest.chips.map((c) => c.id)).toEqual(['CVE-2026-2', 'CVE-2026-3', 'CVE-2026-4']);
    expect(rest.more).toBe(1);
  });

  it('matches WHOLE ids only, the longest first, and only the card’s own', () => {
    (globalThis as unknown as { window: unknown }).window ??= { location: { origin: 'http://localhost' } };
    // CVE-2026-1 is a prefix of CVE-2026-12: neither may swallow, or split, the other.
    const idsOf = (text: string, ids: string[]): string[] =>
      advisoryParts(text, ids).flatMap((p) => ('id' in p ? [p.id] : []));
    expect(idsOf('Socket flagged CVE-2026-12', ['CVE-2026-1'])).toEqual([]);
    expect(idsOf('Socket flagged CVE-2026-12', ['CVE-2026-1', 'CVE-2026-12'])).toEqual(['CVE-2026-12']);
    expect(idsOf('Fixes CVE-2026-1.', ['CVE-2026-1'])).toEqual(['CVE-2026-1']);
    // An id the card does not carry stays words: no link is invented.
    expect(advisoryParts('Fixes CVE-2026-9', ['CVE-2026-1'])).toEqual([{ text: 'Fixes CVE-2026-9' }]);
    // A sentence with no id is one plain part, unchanged.
    const plain = 'Fixes a known security advisory';
    expect(advisoryParts(plain, ['CVE-2026-1'])).toEqual([{ text: plain }]);
  });
});

describe('an alert, as a sentence', () => {
  // What the reader reads: the lead, then — as its own button when there is a thread — where it is.
  const securityAlertSentence = (a: SecurityAlert, users: Map<number, User>): string => {
    const line = securityAlertLine(a, users);
    return line.where == null ? line.lead : `${line.lead} ${line.where}`;
  };
  const alert = (over: Partial<SecurityAlert>): SecurityAlert => ({
    source: 'socket',
    authorId: 12,
    vendorKind: null,
    surface: 'comment',
    threadId: null,
    advisoryIds: ['GHSA-9qr9-h5gf-34mp'],
    at: '2026-09-01T00:00:00.000Z',
    ...over,
  });

  it('names the tool and the advisory', () => {
    expect(securityAlertSentence(alert({}), USERS)).toBe(
      `${SECURITY_ALERT_SOURCE_LABEL.socket} flagged GHSA-9qr9-h5gf-34mp`,
    );
    expect(securityAlertSentence(alert({ advisoryIds: ['CVE-2026-1', 'CVE-2026-2', 'CVE-2026-3'] }), USERS)).toBe(
      'Socket flagged CVE-2026-1 and 2 more',
    );
  });

  it('says where a review-thread alert lives', () => {
    expect(
      securityAlertSentence(alert({ source: 'code_scanning', surface: 'thread', threadId: 4 }), USERS),
    ).toBe('Code scanning flagged GHSA-9qr9-h5gf-34mp in a review thread');
  });

  it('⚠ keeps "where" OUT of the lead — the lead’s ids are links, and a link may not sit in the thread’s button', () => {
    const line = securityAlertLine(alert({ source: 'code_scanning', surface: 'thread', threadId: 4 }), USERS);
    expect(line).toEqual({ lead: 'Code scanning flagged GHSA-9qr9-h5gf-34mp', where: 'in a review thread' });
    expect(securityAlertLine(alert({}), USERS).where).toBeNull();
  });

  it('names a reviewer alert by its author’s brand, else its login — never "a reviewer"', () => {
    expect(
      securityAlertSentence(alert({ source: 'reviewer', vendorKind: 'coderabbit', surface: 'thread', threadId: 1 }), USERS),
    ).toBe('CodeRabbit flagged GHSA-9qr9-h5gf-34mp in a review thread');
    expect(
      securityAlertSentence(alert({ source: 'reviewer', vendorKind: 'in_house', authorId: 13 }), USERS),
    ).toBe('erxes-dev-agent flagged GHSA-9qr9-h5gf-34mp');
  });
});
