// THE ENTRY INTO THE IN-APP MERGE-CONFLICT RESOLVER, and the client state behind it.
//
// WHAT THIS PINS, and why each is worth an assertion rather than a comment:
//
//   1. ⚠ THE ORDERING FIX IN `mergeVerdict`. The conflict test used to sit BELOW the
//      `autoMergeArmed` branch, so an armed conflicting pull request resolved to `'armed'` —
//      "it lands by itself once the blockers clear", which is false, because rule 1 of the
//      auto-merge runner disarms an armed intent the moment the PR conflicts. The visible
//      consequence: `conflictsRowVisible` shut the pane's Conflicts row while the Pending
//      `conflicts` card — minted from the raw columns in SQL — still showed the PR. Two answers
//      to "can this land?" on two screens, which `conflictsRowVisible`'s own header forbids by
//      name. Nothing else in the SPA would catch it.
//   2. THE QUEUE STAYS ON TOP. A queued PR is genuinely GitHub's problem, and GitHub ejects a
//      conflicting entry itself. The reorder must not have promoted conflicts past the queue.
//   3. THE GATE IS FOUR-WAY AND EVERY ARM IS LOAD-BEARING — flip one input at a time. A
//      three-arm gate passes with the PUSH arm deleted, and that is the IDOR-shaped mistake this
//      entry can make: 470 of 474 measured conflicting pull requests live in repos the account
//      only READS, so the button would appear on other people's stuck work.
//   4. THE STORE PINS THE MERGE. Decisions are consent to ONE three-way merge, so they are filed
//      under `${prId}:${headSha}:${baseSha}:${modelHash}` and a moved head simply does not find
//      them — never migrates them onto a merge the reader did not see.
//   5. AND THE LRU CANNOT EVICT THE SESSION YOU ARE LOOKING AT.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { MergeVerdict, PrState } from '@pierre-review/shared';
import { conflictResolverEntryVisible, conflictsRowVisible, mergeVerdict } from '../src/lib/ui.js';
import {
  RESOLVER_SESSION_LIMIT,
  pruneResolverSessions,
  regionKey,
  resolverSessionKey,
  useConflictResolverStore,
  type ResolverSession,
  type ResolverTarget,
} from '../src/store/conflictResolver.js';

/* ───────────────────────────── the `mergeVerdict` reorder ───────────────────────────── */

describe('⚠ conflicts outrank an armed auto-merge intent', () => {
  it('resolves an ARMED, CONFLICTING pull request to `conflicts`', () => {
    // THE REGRESSION. With the branches in their old order this returns 'armed', the pane's
    // Conflicts row never opens, the entry button has no host at all, and the Pending card
    // contradicts the pane. Both conflict columns are exercised, because either alone mints the
    // card in SQL.
    expect(
      mergeVerdict({ autoMergeArmed: true, mergeable: 'conflicting', mergeStateStatus: 'unknown' })
        .verdict,
    ).toBe('conflicts');
    expect(
      mergeVerdict({ autoMergeArmed: true, mergeable: 'unknown', mergeStateStatus: 'dirty' })
        .verdict,
    ).toBe('conflicts');
  });

  it('and the Conflicts row — and with it the button — therefore has a host', () => {
    const verdict = mergeVerdict({
      autoMergeArmed: true,
      mergeable: 'conflicting',
      mergeStateStatus: 'dirty',
    }).verdict;
    expect(conflictsRowVisible('open', verdict)).toBe(true);
  });

  it('still reports `armed` when there is nothing wrong with the PR', () => {
    // The reorder must not have taken the armed verdict away from the PRs it is true of.
    expect(
      mergeVerdict({ autoMergeArmed: true, mergeable: 'mergeable', mergeStateStatus: 'blocked' })
        .verdict,
    ).toBe('armed');
    expect(
      mergeVerdict({ autoMergeArmed: true, mergeable: 'mergeable', mergeStateStatus: 'clean' })
        .verdict,
    ).toBe('armed');
  });

  it('⚠ THE QUEUE IS STILL FIRST — a queued PR gets ONE answer and GitHub owns it', () => {
    // The reorder moved conflicts above ARMED, not above the queue. A queued conflicting PR must
    // still report `queued`, or the pane sprouts a resolve button under a "in merge queue" chip.
    expect(
      mergeVerdict({
        inMergeQueue: true,
        autoMergeArmed: true,
        mergeable: 'conflicting',
        mergeStateStatus: 'dirty',
      }).verdict,
    ).toBe('queued');
  });
});

/* ───────────────────────────── the four-way entry gate ───────────────────────────── */

/** The gate's inputs at their PASSING values, so each test flips exactly one. */
const OPEN_GATE = {
  state: 'open' as PrState,
  verdict: 'conflicts' as MergeVerdict,
  viewerCanPush: true,
  resolverAvailable: true,
};

describe('⚠ the entry gate is four-way and every arm is load-bearing', () => {
  it('offers the button when all four say yes', () => {
    expect(conflictResolverEntryVisible(OPEN_GATE)).toBe(true);
  });

  it('hides it on each arm ALONE', () => {
    // One at a time: a test that flipped two would pass with one of the two gates deleted.
    expect(conflictResolverEntryVisible({ ...OPEN_GATE, viewerCanPush: false })).toBe(false);
    expect(conflictResolverEntryVisible({ ...OPEN_GATE, resolverAvailable: false })).toBe(false);
    expect(conflictResolverEntryVisible({ ...OPEN_GATE, state: 'merged' })).toBe(false);
    expect(conflictResolverEntryVisible({ ...OPEN_GATE, state: 'closed' })).toBe(false);
    expect(conflictResolverEntryVisible({ ...OPEN_GATE, verdict: 'blocked' })).toBe(false);
  });

  it('⚠ THE PUSH ARM. It is the one a three-arm gate silently drops', () => {
    // 470 of 474 measured conflicting pull requests are in repos the account only READS. Without
    // this arm the button appears on all of them — an action that cannot succeed, offered to
    // somebody who is not the person stuck.
    expect(conflictResolverEntryVisible({ ...OPEN_GATE, viewerCanPush: false })).toBe(false);
    // And it is not merely redundant with the verdict: the verdict is identical either way.
    expect(OPEN_GATE.verdict).toBe('conflicts');
  });

  it('hides it for every verdict except `conflicts`', () => {
    const verdicts: MergeVerdict[] = [
      'clean',
      'blocked',
      'conflicts',
      'behind',
      'unstable',
      'queued',
      'armed',
      'draft',
      'unknown',
    ];
    for (const verdict of verdicts) {
      expect(conflictResolverEntryVisible({ ...OPEN_GATE, verdict }), verdict).toBe(
        verdict === 'conflicts',
      );
    }
  });

  it('a QUEUED conflicting PR gets no button, through the verdict rather than a second rule', () => {
    const verdict = mergeVerdict({
      inMergeQueue: true,
      mergeable: 'conflicting',
      mergeStateStatus: 'dirty',
    }).verdict;
    expect(conflictResolverEntryVisible({ ...OPEN_GATE, verdict })).toBe(false);
  });

  it('an ARMED conflicting PR DOES get one — the reorder’s regression test, end to end', () => {
    const verdict = mergeVerdict({
      autoMergeArmed: true,
      mergeable: 'conflicting',
      mergeStateStatus: 'dirty',
    }).verdict;
    expect(conflictResolverEntryVisible({ ...OPEN_GATE, verdict })).toBe(true);
  });
});

/* ───────────────────────────── the store ───────────────────────────── */

const TARGET: ResolverTarget = {
  prId: 42,
  repoId: 7,
  repoFullName: 'acme/widgets',
  prNumber: 128,
  prTitle: 'Rework the token cache',
  githubUrl: 'https://github.com/acme/widgets/pull/128',
};

/** Every test starts from a store with nothing in it — it is module-level and shared. */
function resetStore(): void {
  useConflictResolverStore.setState({
    target: null,
    sessions: {},
    order: [],
    lastClosed: null,
    confirming: false,
  });
}

describe('⚠ the session key IS the pins', () => {
  it('is `prId:head:base:modelHash`, in that order', () => {
    expect(resolverSessionKey(42, 'aaa', 'bbb', 'hhh')).toBe('42:aaa:bbb:hhh');
  });

  it('a moved head, base or model mints a DIFFERENT key', () => {
    // A session is consent to ONE three-way merge. Decisions taken against a merge that no longer
    // exists must not be found, ever — the same reasoning as the auto-merge intent's pinned
    // `expectedHeadOid`.
    const base = resolverSessionKey(42, 'aaa', 'bbb', 'hhh');
    expect(resolverSessionKey(42, 'ZZZ', 'bbb', 'hhh')).not.toBe(base);
    expect(resolverSessionKey(42, 'aaa', 'ZZZ', 'hhh')).not.toBe(base);
    expect(resolverSessionKey(42, 'aaa', 'bbb', 'ZZZ')).not.toBe(base);
  });

  it('a region is addressed WITHIN its file — region ids are not globally unique', () => {
    expect(regionKey(0, 3)).toBe('0:3');
    expect(regionKey(1, 3)).not.toBe(regionKey(0, 3));
  });
});

describe('decisions survive a close and are dropped by a pin change', () => {
  it('keeps the reader’s choices when the SAME model is reopened', () => {
    resetStore();
    const api = useConflictResolverStore.getState();
    const key = resolverSessionKey(TARGET.prId, 'head1', 'base1', 'model1');
    api.openConflictResolver(TARGET);
    api.seedSession({ key, sessionId: 's1', conflictCount: 3 });
    api.decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'ours' });
    api.closeConflictResolver({ reason: 'user' });

    expect(useConflictResolverStore.getState().target).toBeNull();
    // ⚠ The decisions are still there. Closing the overlay drops the SERVER session (there is
    // nothing stored on it) but not the reader's work.
    const kept = useConflictResolverStore.getState().sessions[key];
    expect(kept?.decisions['0:1']).toBe('ours');
    expect(kept?.decidedCount).toBe(1);

    // Reopening onto the same merge re-seeds the SAME key — under a NEW server session — and
    // still finds them.
    useConflictResolverStore.getState().seedSession({ key, sessionId: 's2', conflictCount: 3 });
    expect(useConflictResolverStore.getState().sessions[key]?.decisions['0:1']).toBe('ours');
  });

  it('⚠ a REOPEN drops an accepted suggestion and keeps every other decision', () => {
    // A `'suggestion'` handle addresses a Map in ONE server session's memory. The pins can be
    // identical — same key, same model — and the handle still dead, because the reopen minted a
    // new session. Carried across, the file menu counts the region decided while the centre pane
    // draws it undecided, and the commit then refuses the WHOLE request with `UnknownSuggestion`.
    resetStore();
    const api = useConflictResolverStore.getState();
    const key = resolverSessionKey(TARGET.prId, 'head1', 'base1', 'model1');
    api.seedSession({ key, sessionId: 'server-a', conflictCount: 2 });
    api.decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'ours' });
    api.decideRegion({
      key,
      fileIndex: 0,
      regionId: 2,
      decision: 'suggestion',
      suggestionId: 'sug-1',
    });
    expect(useConflictResolverStore.getState().sessions[key]?.decidedCount).toBe(2);

    useConflictResolverStore.getState().seedSession({
      key,
      sessionId: 'server-b',
      conflictCount: 2,
    });
    const after = useConflictResolverStore.getState().sessions[key];
    expect(after?.decisions['0:1']).toBe('ours');
    expect(after?.decisions['0:2']).toBeUndefined();
    expect(after?.suggestionIds).toEqual({});
    // ⚠ The counter moves WITH the map, or the footer keeps counting a region nothing renders.
    expect(after?.decidedCount).toBe(1);
    expect(after?.sessionId).toBe('server-b');
  });

  it('⚠ a REOPEN drops a HAND-EDITED region too — the identical bug, verbatim', () => {
    // `'edited'` is a handle into the same kind of in-memory map as `'suggestion'`, minted by
    // the same server session, and dead the same instant. Carrying it across gives the file menu
    // a "Resolved" row the centre pane renders as undecided, and a commit refused whole with
    // `UnknownEdit`. Dropping it back to undecided asks the reader again, on a region they can
    // see is unanswered — and their text is still in the box when they reopen it.
    resetStore();
    const api = useConflictResolverStore.getState();
    const key = resolverSessionKey(TARGET.prId, 'head1', 'base1', 'model1');
    api.seedSession({ key, sessionId: 'server-a', conflictCount: 2 });
    api.decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'theirs' });
    api.decideRegion({ key, fileIndex: 0, regionId: 2, decision: 'edited', editId: 'edit-1' });
    expect(useConflictResolverStore.getState().sessions[key]?.editIds['0:2']).toBe('edit-1');
    expect(useConflictResolverStore.getState().sessions[key]?.decidedCount).toBe(2);

    useConflictResolverStore
      .getState()
      .seedSession({ key, sessionId: 'server-b', conflictCount: 2 });
    const after = useConflictResolverStore.getState().sessions[key];
    expect(after?.decisions['0:1']).toBe('theirs');
    expect(after?.decisions['0:2']).toBeUndefined();
    expect(after?.editIds).toEqual({});
    expect(after?.decidedCount).toBe(1);
  });

  it('⚠ a RE-SEED under the SAME server session keeps the handles — the poll must not wipe them', () => {
    // ⚠ THE CASE EVERY TEST ABOVE MISSES, AND THE ONE THAT ACTUALLY HAPPENS. Those two re-seed
    // with a DIFFERENT `sessionId`, which is a reopen. `ConflictResolverOverlay`'s seed effect
    // depends on the whole `session` object, and `useConflictSession` hands back a NEW object on
    // every SSE frame (including the commit's own `commit_progress`) and again every
    // `POLL_IDLE_MS` once the server ends the stream at ten minutes — all under the SAME id. An
    // unconditional drop therefore deleted every hand-typed region within eight seconds of minute
    // ten, and again the instant Commit was pressed, with nothing on screen saying why.
    resetStore();
    const api = useConflictResolverStore.getState();
    const key = resolverSessionKey(TARGET.prId, 'head1', 'base1', 'model1');
    api.seedSession({ key, sessionId: 'server-a', conflictCount: 3 });
    api.decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'edited', editId: 'edit-1' });
    api.decideRegion({
      key,
      fileIndex: 0,
      regionId: 2,
      decision: 'suggestion',
      suggestionId: 'sug-1',
    });
    api.decideRegion({ key, fileIndex: 0, regionId: 3, decision: 'ours' });
    expect(useConflictResolverStore.getState().sessions[key]?.decidedCount).toBe(3);

    useConflictResolverStore
      .getState()
      .seedSession({ key, sessionId: 'server-a', conflictCount: 3 });
    const after = useConflictResolverStore.getState().sessions[key];
    expect(after?.decisions['0:1']).toBe('edited');
    expect(after?.editIds['0:1']).toBe('edit-1');
    expect(after?.decisions['0:2']).toBe('suggestion');
    expect(after?.suggestionIds['0:2']).toBe('sug-1');
    expect(after?.decisions['0:3']).toBe('ours');
    expect(after?.decidedCount).toBe(3);
  });

  it('⚠ a MOVED HEAD finds nothing — decisions are never migrated onto a new merge', () => {
    resetStore();
    const api = useConflictResolverStore.getState();
    const oldKey = resolverSessionKey(TARGET.prId, 'head1', 'base1', 'model1');
    api.seedSession({ key: oldKey, sessionId: 's1', conflictCount: 3 });
    api.decideRegion({ key: oldKey, fileIndex: 0, regionId: 1, decision: 'theirs' });

    const newKey = resolverSessionKey(TARGET.prId, 'head2', 'base1', 'model2');
    useConflictResolverStore.getState().seedSession({ key: newKey, sessionId: 's2', conflictCount: 3 });
    const fresh = useConflictResolverStore.getState().sessions[newKey];
    expect(fresh?.decisions).toEqual({});
    expect(fresh?.decidedCount).toBe(0);
  });

  it('⚠ a re-seed never re-applies a default over a reader’s own choice', () => {
    resetStore();
    const api = useConflictResolverStore.getState();
    const key = resolverSessionKey(TARGET.prId, 'head1', 'base1', 'model1');
    api.seedSession({ key, sessionId: 's1', conflictCount: 2, defaults: { '0:1': 'ours' } });
    api.decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'base' });
    // The same defaults arrive again on a reopen. Re-applying them would silently undo the reader.
    useConflictResolverStore
      .getState()
      .seedSession({ key, sessionId: 's1', conflictCount: 2, defaults: { '0:1': 'ours' } });
    expect(useConflictResolverStore.getState().sessions[key]?.decisions['0:1']).toBe('base');
  });
});

describe('the decision map and its counter cannot disagree', () => {
  it('counts what is decided, and clearing a region takes the count back down', () => {
    resetStore();
    const api = useConflictResolverStore.getState();
    const key = resolverSessionKey(TARGET.prId, 'h', 'b', 'm');
    api.seedSession({ key, sessionId: 's1', conflictCount: 4 });
    api.decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'ours' });
    api.decideRegion({ key, fileIndex: 0, regionId: 2, decision: 'theirs' });
    expect(useConflictResolverStore.getState().sessions[key]?.decidedCount).toBe(2);

    // `null` is UNDECIDED — the absence of an entry, never a member of the enum.
    useConflictResolverStore
      .getState()
      .decideRegion({ key, fileIndex: 0, regionId: 1, decision: null });
    const s = useConflictResolverStore.getState().sessions[key];
    expect(s?.decidedCount).toBe(1);
    expect(s?.decisions['0:1']).toBeUndefined();
  });

  it('⚠ a suggestion handle is dropped the moment the region stops being a suggestion', () => {
    // A stale suggestionId under a region the reader has since taken a side on would be sent to
    // the commit route, which answers `UnknownSuggestion` — an error about a decision they have
    // already changed their mind about.
    resetStore();
    const api = useConflictResolverStore.getState();
    const key = resolverSessionKey(TARGET.prId, 'h', 'b', 'm');
    api.seedSession({ key, sessionId: 's1', conflictCount: 1 });
    api.decideRegion({
      key,
      fileIndex: 0,
      regionId: 1,
      decision: 'suggestion',
      suggestionId: 'sug-1',
    });
    expect(useConflictResolverStore.getState().sessions[key]?.suggestionIds['0:1']).toBe('sug-1');
    useConflictResolverStore
      .getState()
      .decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'ours' });
    expect(useConflictResolverStore.getState().sessions[key]?.suggestionIds['0:1']).toBeUndefined();
  });

  it('⚠ an EDIT handle is dropped the same way, and Undo clears it like any other decision', () => {
    resetStore();
    const api = useConflictResolverStore.getState();
    const key = resolverSessionKey(TARGET.prId, 'h', 'b', 'm');
    api.seedSession({ key, sessionId: 's1', conflictCount: 1 });
    api.decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'edited', editId: 'edit-1' });
    expect(useConflictResolverStore.getState().sessions[key]?.editIds['0:1']).toBe('edit-1');

    // Taking a side instead drops the handle — a stale one goes to a commit route that answers
    // `UnknownEdit` about a decision the reader has already changed their mind about.
    useConflictResolverStore
      .getState()
      .decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'theirs' });
    expect(useConflictResolverStore.getState().sessions[key]?.editIds['0:1']).toBeUndefined();

    // ...and clearing back to undecided drops decision and handle together.
    useConflictResolverStore
      .getState()
      .decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'edited', editId: 'edit-2' });
    useConflictResolverStore
      .getState()
      .decideRegion({ key, fileIndex: 0, regionId: 1, decision: null });
    const s = useConflictResolverStore.getState().sessions[key];
    expect(s?.decisions['0:1']).toBeUndefined();
    expect(s?.editIds['0:1']).toBeUndefined();
    expect(s?.decidedCount).toBe(0);
  });

  it('⚠ the two handles never cross: an editId cannot ride a `suggestion` decision', () => {
    // Two stores, two provenances, two refusal sentences. One map would let a `'suggestion'`
    // redeem an `editId` and be told "that suggestion has expired. Ask Claude again." about text
    // the reader typed themselves.
    resetStore();
    const api = useConflictResolverStore.getState();
    const key = resolverSessionKey(TARGET.prId, 'h', 'b', 'm');
    api.seedSession({ key, sessionId: 's1', conflictCount: 1 });
    api.decideRegion({
      key,
      fileIndex: 0,
      regionId: 1,
      decision: 'suggestion',
      suggestionId: 'sug-1',
      editId: 'edit-1',
    });
    const s = useConflictResolverStore.getState().sessions[key];
    expect(s?.suggestionIds['0:1']).toBe('sug-1');
    expect(s?.editIds['0:1']).toBeUndefined();
  });

  it('the wand’s whole run is ONE write, so the counter is never seen half-updated', () => {
    resetStore();
    const api = useConflictResolverStore.getState();
    const key = resolverSessionKey(TARGET.prId, 'h', 'b', 'm');
    api.seedSession({ key, sessionId: 's1', conflictCount: 3 });
    api.decideRegions({
      key,
      decisions: [
        { fileIndex: 0, regionId: 1, decision: 'ours' },
        { fileIndex: 0, regionId: 2, decision: 'theirs' },
        { fileIndex: 1, regionId: 1, decision: 'both_ours_first' },
      ],
    });
    const s = useConflictResolverStore.getState().sessions[key];
    expect(s?.decidedCount).toBe(3);
    // ⚠ Region 1 in file 0 and region 1 in file 1 are DIFFERENT regions.
    expect(s?.decisions['0:1']).toBe('ours');
    expect(s?.decisions['1:1']).toBe('both_ours_first');
  });
});

describe('⚠ the LRU never evicts the session you are looking at', () => {
  const session = (key: string): ResolverSession => ({
    key,
    decisions: {},
    suggestionIds: {},
    editIds: {},
    decidedCount: 0,
    conflictCount: 0,
  });

  it('keeps the most-recently-touched four and drops the rest', () => {
    const order = ['e', 'd', 'c', 'b', 'a'];
    const sessions = Object.fromEntries(order.map((k) => [k, session(k)]));
    const pruned = pruneResolverSessions(order, sessions);
    expect(pruned.order).toHaveLength(RESOLVER_SESSION_LIMIT);
    expect(pruned.order[0]).toBe('e');
    expect(Object.keys(pruned.sessions).sort()).toEqual(['b', 'c', 'd', 'e']);
    expect(pruned.sessions['a']).toBeUndefined();
  });

  it('a fifth pull request evicts the oldest, never the one just opened', () => {
    resetStore();
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5'];
    for (const key of keys) {
      useConflictResolverStore.getState().seedSession({ key, sessionId: 's1', conflictCount: 1 });
    }
    const state = useConflictResolverStore.getState();
    expect(state.order[0]).toBe('k5');
    expect(state.sessions['k5']).toBeDefined();
    expect(state.sessions['k1']).toBeUndefined();
    expect(Object.keys(state.sessions)).toHaveLength(RESOLVER_SESSION_LIMIT);
  });
});

describe('closing hands the reopen toast something true, or nothing at all', () => {
  it('offers a way back when decisions are still on the table', () => {
    resetStore();
    const api = useConflictResolverStore.getState();
    const key = resolverSessionKey(TARGET.prId, 'h', 'b', 'm');
    api.openConflictResolver(TARGET);
    api.seedSession({ key, sessionId: 's1', conflictCount: 2 });
    api.decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'ours' });
    api.closeConflictResolver({ reason: 'navigated' });
    const closed = useConflictResolverStore.getState().lastClosed;
    expect(closed?.target.prId).toBe(TARGET.prId);
    expect(closed?.reason).toBe('navigated');
    expect(closed?.decidedCount).toBe(1);
  });

  it('offers nothing when nothing was decided', () => {
    resetStore();
    const api = useConflictResolverStore.getState();
    api.openConflictResolver(TARGET);
    api.seedSession({ key: resolverSessionKey(TARGET.prId, 'h', 'b', 'm'), conflictCount: 2 });
    api.closeConflictResolver({ reason: 'user' });
    expect(useConflictResolverStore.getState().lastClosed).toBeNull();
  });

  it('⚠ offers nothing after a COMMIT — the pins have moved, so reopening would be a lie', () => {
    resetStore();
    const api = useConflictResolverStore.getState();
    const key = resolverSessionKey(TARGET.prId, 'h', 'b', 'm');
    api.openConflictResolver(TARGET);
    api.seedSession({ key, sessionId: 's1', conflictCount: 2 });
    api.decideRegion({ key, fileIndex: 0, regionId: 1, decision: 'ours' });
    api.closeConflictResolver({ reason: 'committed' });
    expect(useConflictResolverStore.getState().lastClosed).toBeNull();
  });
});
