// The "Needs attention" single-KIND isolation (`attentionIsolation`) and the ordering rule every
// caller of it has to obey.
//
// The daily brief's four workspace lines each count ONE card kind, so each must land the reader
// on that kind's cards — not on an undifferentiated board. The lens that does it is transient by
// design, and there is exactly one way to set it wrong:
//
//   ⚠ `setActivityRepo` CLEARS the isolation, and RETURNS AN EMPTY PATCH when the rail id is
//     unchanged. So a caller that isolates FIRST and switches SECOND is wiped on the click that
//     actually changes rail and works on every click that doesn't — i.e. it looks correct the
//     second time you press it, and only ever fails from a cold Feed. That asymmetry is what
//     makes this worth a test rather than a comment: both orders "work" in the common case.
//
// The rest is the transience contract. `attentionIsolation` must stay OUT of FilterDefaults —
// persisting a lens set by one click of a brief line would restore a filtered board on a fresh
// tab with no memory of why — which also means no FILTER_STORAGE_VERSION bump was owed for it.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import {
  pickFilterBarState,
  sanitizePersistedFilters,
  useFilters,
  type FilterState,
} from '../src/store/filters.js';
import { usePinnedTabs } from '../src/store/pinnedTabs.js';

describe('attentionIsolation', () => {
  beforeEach(() => {
    useFilters.setState({
      workspaceId: 3,
      activityRepoId: 'feed',
      attentionIsolation: null,
      attentionRelevance: null,
      feedIsolatedPrId: null,
    });
  });

  it('defaults to null — a fresh board shows every kind', () => {
    expect(useFilters.getState().attentionIsolation).toBeNull();
  });

  it('holds the kind it is set to', () => {
    useFilters.getState().setAttentionIsolation('stalled_review');
    expect(useFilters.getState().attentionIsolation).toBe('stalled_review');
  });

  // ── the ordering rule ────────────────────────────────────────────────────────────────────
  it('SWITCH FIRST, ISOLATE SECOND survives (the rule)', () => {
    const s = useFilters.getState();
    s.setActivityRepo('attention'); // rail changes: clears any stale isolation
    s.setAttentionIsolation('my_turn'); // then the new one is seated
    expect(useFilters.getState().activityRepoId).toBe('attention');
    expect(useFilters.getState().attentionIsolation).toBe('my_turn');
  });

  it('ISOLATE FIRST, SWITCH SECOND is silently wiped — the bug the rule exists for', () => {
    const s = useFilters.getState();
    s.setAttentionIsolation('my_turn');
    s.setActivityRepo('attention'); // rail CHANGED (from 'feed') → the clear fires
    expect(useFilters.getState().activityRepoId).toBe('attention');
    expect(useFilters.getState().attentionIsolation).toBeNull();
  });

  it('…and the wrong order APPEARS to work whenever the rail is already right', () => {
    // The asymmetry that hides the bug: setActivityRepo early-returns an empty patch when the id
    // is unchanged, so the same wrong-ordered code keeps its isolation on a second press.
    useFilters.setState({ activityRepoId: 'attention' });
    const s = useFilters.getState();
    s.setAttentionIsolation('untouched_thread');
    s.setActivityRepo('attention'); // no-op patch: nothing is cleared
    expect(useFilters.getState().attentionIsolation).toBe('untouched_thread');
  });

  // ── cleared exactly where feedIsolatedPrId is ────────────────────────────────────────────
  it('a rail switch to any OTHER entry clears it', () => {
    useFilters.setState({ activityRepoId: 'attention', attentionIsolation: 'reviewer_routing' });
    useFilters.getState().setActivityRepo('feed');
    expect(useFilters.getState().attentionIsolation).toBeNull();
  });

  it('a workspace switch clears it (the new workspace may have none of that kind)', () => {
    useFilters.setState({ attentionIsolation: 'stalled_review' });
    useFilters.getState().setWorkspace(9, null);
    expect(useFilters.getState().workspaceId).toBe(9);
    expect(useFilters.getState().attentionIsolation).toBeNull();
  });

  it('is cleared alongside feedIsolatedPrId, never instead of it', () => {
    useFilters.setState({
      activityRepoId: 'attention',
      attentionIsolation: 'my_turn',
      feedIsolatedPrId: 42,
    });
    useFilters.getState().setActivityRepo('bots');
    const after = useFilters.getState();
    expect(after.attentionIsolation).toBeNull();
    expect(after.feedIsolatedPrId).toBeNull();
  });

  // ── transience: never persisted, never restored ──────────────────────────────────────────
  it('is NOT persisted with the filter bar', () => {
    useFilters.setState({ attentionIsolation: 'my_turn' });
    const persisted = pickFilterBarState(useFilters.getState()) as Record<string, unknown>;
    expect('attentionIsolation' in persisted).toBe(false);
  });

  it('is dropped from a restored blob that somehow carries it', () => {
    const restored = sanitizePersistedFilters({
      attentionIsolation: 'my_turn',
    } as unknown as Partial<FilterState>) as Record<string, unknown>;
    expect('attentionIsolation' in restored).toBe(false);
  });

  // ── openMyTurnInWorkspace: the banner's one-gesture cross-workspace deep-link ────────────
  //
  // The Welcome-back banner names My Turn work sitting in workspaces the reader is NOT in, so a
  // line's click has to change scope AND land on that workspace's my_turn cards. Every step of
  // that sequence clears the step after it, which is why it is ONE store action and why the
  // cases below pin the outcome rather than the calls.
  describe('openMyTurnInWorkspace', () => {
    beforeEach(() => {
      usePinnedTabs.setState({ activeTab: 'timeline' });
    });

    it('switches workspace, opens the console, and isolates to my_turn — from a cold Timeline', () => {
      useFilters.setState({ workspaceId: 3, activityRepoId: 'feed', repoIds: [7, 9] });
      useFilters.getState().openMyTurnInWorkspace(9);
      const after = useFilters.getState();
      expect(after.workspaceId).toBe(9);
      // A subset belongs to the workspace being LEFT — the destination shows all of itself.
      expect(after.repoIds).toBeNull();
      expect(usePinnedTabs.getState().activeTab).toBe('activity');
      expect(after.activityRepoId).toBe('attention');
      // The whole point: the isolation SURVIVES both clears above it.
      expect(after.attentionIsolation).toBe('my_turn');
    });

    it('leaves a Timeline repo narrowing alone when the target IS the active workspace', () => {
      // Re-writing the same id would run setWorkspace's clear for nothing, throwing away a
      // per-repo selection the user made on the board they are standing on.
      useFilters.setState({ workspaceId: 3, activityRepoId: 'feed', repoIds: [7] });
      useFilters.getState().openMyTurnInWorkspace(3);
      const after = useFilters.getState();
      expect(after.workspaceId).toBe(3);
      expect(after.repoIds).toEqual([7]);
      expect(after.activityRepoId).toBe('attention');
      expect(after.attentionIsolation).toBe('my_turn');
    });

    it('re-isolates when the rail is ALREADY attention (setActivityRepo returns an empty patch)', () => {
      // The asymmetry that hides ordering bugs: this path never runs setActivityRepo's clear, so
      // it must still end isolated — and it must not inherit the PREVIOUS kind.
      useFilters.setState({
        workspaceId: 3,
        activityRepoId: 'attention',
        attentionIsolation: 'stalled_review',
      });
      useFilters.getState().openMyTurnInWorkspace(3);
      expect(useFilters.getState().attentionIsolation).toBe('my_turn');
    });

    it('clears an isolated feed PR on the way (a switch re-scopes everything)', () => {
      useFilters.setState({ workspaceId: 3, activityRepoId: 'feed', feedIsolatedPrId: 42 });
      useFilters.getState().openMyTurnInWorkspace(11);
      expect(useFilters.getState().feedIsolatedPrId).toBeNull();
      expect(useFilters.getState().attentionIsolation).toBe('my_turn');
    });
  });

  // ── the RELEVANCE lens: the sibling field, and the divergence rule it enforces ─────────────
  //
  // The welcome-back banner, the Workspace badges and the brief's "Elsewhere" rows count the
  // PERSONAL subset of my_turn (`myTurnPersonal` = direct + maintained); the brief's second
  // my-turn line counts the REST (`myTurnOther`); the board holds every card. A line reading 4
  // whose click opened a board of 50 would be the "the strip says 5, the board lists 3" defect
  // (747c9c9) in a new place — so every one of those surfaces navigates through a gesture that
  // seats ITS OWN half.
  //
  // ⚠ THREE-VALUED, NOT A BOOLEAN. It shipped as `attentionPersonalOnly: boolean`, which can say
  // "what involves me" but has no way to say "the rest" — so the two mutually exclusive brief
  // lines could not both land on a board filtered to their own number. Two lines + the un-lensed
  // board is three views; a boolean has two states.
  //
  // ⚠ IT IS A SIBLING OF `attentionIsolation`, NOT A MEMBER OF IT: that field is compared against
  // `card.kind`, and these two predicates are orthogonal.
  describe('attentionRelevance', () => {
    beforeEach(() => {
      useFilters.setState({ attentionRelevance: null });
      usePinnedTabs.setState({ activeTab: 'timeline' });
    });

    it('defaults to null — the board is BROAD, because those PRs do need a review', () => {
      expect(useFilters.getState().attentionRelevance).toBeNull();
    });

    it('holds either half', () => {
      useFilters.getState().setAttentionRelevance('mine');
      expect(useFilters.getState().attentionRelevance).toBe('mine');
      useFilters.getState().setAttentionRelevance('others');
      expect(useFilters.getState().attentionRelevance).toBe('others');
      useFilters.getState().setAttentionRelevance(null);
      expect(useFilters.getState().attentionRelevance).toBeNull();
    });

    it('openMyTurnInWorkspace seats MINE — the count and the list are one population', () => {
      // Every caller of that action is a NOTIFICATION surface counting `myTurnPersonal`, which is
      // exactly direct + maintained. Landing them on 'others' — or on the broad board — would show
      // a different list than the number they clicked.
      useFilters.setState({ workspaceId: 3, activityRepoId: 'feed' });
      useFilters.getState().openMyTurnInWorkspace(9);
      const after = useFilters.getState();
      expect(after.attentionRelevance).toBe('mine');
      // …alongside, never instead of, the kind isolation.
      expect(after.attentionIsolation).toBe('my_turn');
    });

    it('…and seats it even when the rail is ALREADY attention (the empty-patch asymmetry)', () => {
      useFilters.setState({
        workspaceId: 3,
        activityRepoId: 'attention',
        attentionRelevance: null,
      });
      useFilters.getState().openMyTurnInWorkspace(3);
      expect(useFilters.getState().attentionRelevance).toBe('mine');
    });

    it('…and OVERWRITES the opposite half rather than leaving it seated', () => {
      // The failure this guards: a reader on the "review or reply" board clicks a workspace badge
      // (a personal count) and lands on a board still filtered to the backlog — a smaller, wholly
      // different list than the number they clicked.
      useFilters.setState({
        workspaceId: 3,
        activityRepoId: 'attention',
        attentionRelevance: 'others',
      });
      useFilters.getState().openMyTurnInWorkspace(3);
      expect(useFilters.getState().attentionRelevance).toBe('mine');
    });

    it('a rail switch clears it', () => {
      useFilters.setState({ activityRepoId: 'attention', attentionRelevance: 'mine' });
      useFilters.getState().setActivityRepo('feed');
      expect(useFilters.getState().attentionRelevance).toBeNull();
    });

    it('a workspace switch clears it (the count that seated it was another workspace’s)', () => {
      useFilters.setState({ attentionRelevance: 'others' });
      useFilters.getState().setWorkspace(9, null);
      expect(useFilters.getState().attentionRelevance).toBeNull();
    });

    it('is cleared alongside the kind isolation, never instead of it', () => {
      useFilters.setState({
        activityRepoId: 'attention',
        attentionIsolation: 'my_turn',
        attentionRelevance: 'mine',
        feedIsolatedPrId: 42,
      });
      useFilters.getState().setActivityRepo('bots');
      const after = useFilters.getState();
      expect(after.attentionIsolation).toBeNull();
      expect(after.attentionRelevance).toBeNull();
      expect(after.feedIsolatedPrId).toBeNull();
    });

    it('is NOT persisted with the filter bar (so no FILTER_STORAGE_VERSION bump is owed)', () => {
      useFilters.setState({ attentionRelevance: 'mine' });
      const persisted = pickFilterBarState(useFilters.getState()) as Record<string, unknown>;
      expect('attentionRelevance' in persisted).toBe(false);
    });

    it('is dropped from a restored blob that somehow carries it', () => {
      const restored = sanitizePersistedFilters({
        attentionRelevance: 'mine',
      } as unknown as Partial<FilterState>) as Record<string, unknown>;
      expect('attentionRelevance' in restored).toBe(false);
    });

    // ── the brief strip's two mutually exclusive lines, rendered as the strip renders them ────
    //
    // Each line SEATS its own value — including `null` for the whole-kind lines — because
    // `setActivityRepo` returns an empty patch when the rail is already 'attention', so a lens
    // left over from an earlier click would survive and open a different list than the number.
    it('the "need your attention" line seats MINE', () => {
      useFilters.setState({ activityRepoId: 'attention', attentionRelevance: 'others' });
      const s = useFilters.getState();
      s.setActivityRepo('attention'); // empty patch — the trap
      s.setAttentionIsolation('my_turn');
      s.setAttentionRelevance('mine');
      const after = useFilters.getState();
      expect(after.attentionRelevance).toBe('mine');
      expect(after.attentionIsolation).toBe('my_turn');
    });

    it('the "need review or reply" line seats OTHERS — the two lines are exclusive', () => {
      useFilters.setState({ activityRepoId: 'attention', attentionRelevance: 'mine' });
      const s = useFilters.getState();
      s.setActivityRepo('attention');
      s.setAttentionIsolation('my_turn');
      s.setAttentionRelevance('others');
      const after = useFilters.getState();
      expect(after.attentionRelevance).toBe('others');
      expect(after.attentionIsolation).toBe('my_turn');
    });

    it('a WHOLE-KIND entry point clears it explicitly — the brief strip’s other rule', () => {
      // The strip's non-my-turn lines count a whole kind, so they must widen the board rather than
      // inherit whichever half was last seated.
      useFilters.setState({ activityRepoId: 'attention', attentionRelevance: 'mine' });
      const s = useFilters.getState();
      s.setActivityRepo('attention'); // empty patch — the trap
      s.setAttentionIsolation('stalled_review');
      s.setAttentionRelevance(null);
      const after = useFilters.getState();
      expect(after.attentionRelevance).toBeNull();
      expect(after.attentionIsolation).toBe('stalled_review');
    });
  });

  it('survives "Clear filters", exactly like feedIsolatedPrId', () => {
    // Neither transient isolation is in freshFilterDefaults(), so resetAllFilters does not touch
    // them: they are cleared by rail/scope changes instead. Pinned so the two stay consistent —
    // a lens that one control clears and its twin doesn't is the kind of drift nothing reports.
    useFilters.setState({
      attentionIsolation: 'my_turn',
      attentionRelevance: 'mine',
      feedIsolatedPrId: 42,
    });
    useFilters.getState().resetAllFilters();
    const after = useFilters.getState();
    expect(after.attentionIsolation).toBe('my_turn');
    expect(after.attentionRelevance).toBe('mine');
    expect(after.feedIsolatedPrId).toBe(42);
  });
});
