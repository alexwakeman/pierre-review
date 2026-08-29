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
  MergeReadyCard,
  MergeStateStatus,
  Mergeable,
  UpdateBranchCard,
} from '@pierre-review/shared';
import { authorSourceLabel, pendingMergeGate } from '../src/components/Activity/AttentionCards.js';

/** The `InsightPrRef` half every PR-bearing card carries, with the source pair varied per test. */
function prRef(over: { authorIsBot?: boolean; authorBotKind?: AutomatedReviewerKind | null } = {}) {
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
    ...over,
  };
}

function mergeCard(over: {
  mergeStateStatus?: MergeStateStatus;
  mergeable?: Mergeable | null;
  viewerCanPush?: boolean;
} = {}): MergeReadyCard {
  return {
    id: 'wp:merge:101',
    kind: 'merge',
    severity: 'info',
    ...prRef(),
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
} = {}): UpdateBranchCard {
  return {
    id: 'wp:update_branch:101',
    kind: 'update_branch',
    severity: 'info',
    ...prRef(),
    mergeStateStatus: 'behind',
    mergeable: over.mergeable === undefined ? 'mergeable' : over.mergeable,
    lastCommitAt: '2026-08-27T09:00:00.000Z',
    relevance: 'direct',
    detail: 'behind trunk',
    viewerCanPush: over.viewerCanPush ?? true,
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
