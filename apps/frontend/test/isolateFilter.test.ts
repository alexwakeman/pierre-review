// The PR Focus tab's filters — Events (categories + review verdicts) and Bots — applied CLIENT-side
// over the unfiltered `prIds=<id>` payload (components/Timeline/isolateFilter.ts).
//
// Each rule here mirrors the server's board predicate in getTimeline, because the same store fields
// drive both: a Focus tab and the board must hide the same things for the same settings.
//   • categories      → `types` (lifecycle + reviews always flow)
//   • reviewStates    → the EXISTS on the review row: a review event with no/deselected state goes
//   • excludeBots     → the UNION bot set of the PR's OWN workspace; a NULL actor is KEPT
//   • allowedBotIds   → subtracted from the bot set
// plus the Focus-only rule: the event a magnifier deep-linked to ALWAYS shows.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type {
  EventType,
  ReviewState,
  TimelineEvent,
  TimelinePr,
  User,
  WorkspaceReviewer,
} from '@pierre-review/shared';
import {
  filterIsolateEvents,
  isolateKeepGroupIds,
  makeIsolateEventFilter,
  matchFocusEvent,
  type IsolateFilterInput,
} from '../src/components/Timeline/isolateFilter.js';
import { makeUnionBotVerdict } from '../src/lib/unionBot.js';
import { boardSlotMode, prDetailKey, prFocusKey, type Tab } from '../src/store/pinnedTabs.js';
import {
  ALL_CATEGORIES,
  ALL_REVIEW_STATES,
  DEFAULT_CATEGORIES,
  DEFAULT_REVIEW_STATES,
} from '../src/store/filters.js';

const PR_ID = 10;
const REPO_ID = 3;
const AUTHOR = 1;
const HUMAN = 2;
const BOT = 50;
const BOT_2 = 51;

let nextId = 100;
function ev(over: Partial<TimelineEvent> & { type: EventType }): TimelineEvent {
  return {
    id: nextId++,
    repoId: REPO_ID,
    actorId: HUMAN,
    prId: PR_ID,
    occurredAt: '2026-09-01T10:00:00Z',
    threadId: null,
    derivedState: null,
    refId: null,
    reviewState: null,
    ...over,
  };
}

function pr(over: Partial<TimelinePr> = {}): TimelinePr {
  return { id: PR_ID, repoId: REPO_ID, authorId: AUTHOR, ...over } as TimelinePr;
}

const DEFAULTS: IsolateFilterInput = {
  categories: [...DEFAULT_CATEGORIES],
  reviewStates: [...DEFAULT_REVIEW_STATES],
  excludeBots: true,
  allowedBotIds: [],
};
const ALL_ON: IsolateFilterInput = {
  categories: [...ALL_CATEGORIES],
  reviewStates: [...ALL_REVIEW_STATES],
  excludeBots: false,
  allowedBotIds: [],
};

const noBots = (): boolean => false;
const isBotId = (id: number): boolean => id === BOT || id === BOT_2;

describe('categories — rows and markers share one gate', () => {
  it('drops a toggled-off category (Commits is off by default) and keeps the others', () => {
    const pass = makeIsolateEventFilter(DEFAULTS, noBots, null);
    expect(pass(ev({ type: 'commit_pushed' }))).toBe(false);
    expect(pass(ev({ type: 'review_comment' }))).toBe(true);
    expect(pass(ev({ type: 'pr_comment' }))).toBe(true);
  });

  it('lifecycle and review events always flow — they have no category toggle', () => {
    const pass = makeIsolateEventFilter({ ...ALL_ON, categories: [] }, noBots, null);
    expect(pass(ev({ type: 'pr_opened' }))).toBe(true);
    expect(pass(ev({ type: 'pr_merged' }))).toBe(true);
    expect(pass(ev({ type: 'review_submitted', reviewState: 'approved' }))).toBe(true);
    expect(pass(ev({ type: 'review_comment' }))).toBe(false);
    expect(pass(ev({ type: 'pr_comment' }))).toBe(false);
    expect(pass(ev({ type: 'commit_pushed' }))).toBe(false);
  });
});

describe('reviewStates — the verdict filter on review events only', () => {
  it('a FULL selection is no filter: even a review with no stored state passes', () => {
    const pass = makeIsolateEventFilter(ALL_ON, noBots, null);
    expect(pass(ev({ type: 'review_submitted', reviewState: null }))).toBe(true);
    expect(pass(ev({ type: 'review_submitted', reviewState: 'dismissed' }))).toBe(true);
  });

  it('a narrowed selection keeps only selected verdicts, and drops a NULL state', () => {
    const pass = makeIsolateEventFilter(
      { ...ALL_ON, reviewStates: ['approved'] as ReviewState[] },
      noBots,
      null,
    );
    expect(pass(ev({ type: 'review_submitted', reviewState: 'approved' }))).toBe(true);
    expect(pass(ev({ type: 'review_submitted', reviewState: 'commented' }))).toBe(false);
    // The server's EXISTS finds no review row to match — dropped, not kept.
    expect(pass(ev({ type: 'review_submitted', reviewState: null }))).toBe(false);
    // Every other type is untouched by the verdict filter.
    expect(pass(ev({ type: 'review_comment' }))).toBe(true);
  });

  it('an EMPTY selection hides every review event', () => {
    const pass = makeIsolateEventFilter({ ...ALL_ON, reviewStates: [] }, noBots, null);
    expect(pass(ev({ type: 'review_submitted', reviewState: 'approved' }))).toBe(false);
    expect(pass(ev({ type: 'pr_comment' }))).toBe(true);
  });
});

describe('excludeBots — the bots toggle', () => {
  it('hides a bot actor, keeps a human', () => {
    const pass = makeIsolateEventFilter({ ...ALL_ON, excludeBots: true }, isBotId, null);
    expect(pass(ev({ type: 'review_comment', actorId: BOT }))).toBe(false);
    expect(pass(ev({ type: 'review_comment', actorId: HUMAN }))).toBe(true);
  });

  // The server keeps `actor_id is null` under excludeBots (only the MEMBER filter drops it).
  it('keeps an event with a NULL actor', () => {
    const pass = makeIsolateEventFilter({ ...ALL_ON, excludeBots: true }, () => true, null);
    expect(pass(ev({ type: 'pr_comment', actorId: null }))).toBe(true);
  });

  it('an allow-listed bot stays visible; the others still go', () => {
    const pass = makeIsolateEventFilter(
      { ...ALL_ON, excludeBots: true, allowedBotIds: [BOT] },
      isBotId,
      null,
    );
    expect(pass(ev({ type: 'review_comment', actorId: BOT }))).toBe(true);
    expect(pass(ev({ type: 'review_comment', actorId: BOT_2 }))).toBe(false);
  });

  it('bots SHOWN hides nothing', () => {
    const pass = makeIsolateEventFilter({ ...ALL_ON, excludeBots: false }, isBotId, null);
    expect(pass(ev({ type: 'review_comment', actorId: BOT }))).toBe(true);
  });
});

describe('the union bot verdict — the workspace judgement over the wire flag', () => {
  const users = new Map<number, User>([
    [HUMAN, { id: HUMAN, githubLogin: 'alice', displayName: null, avatarUrl: null, isBot: false }],
    [BOT, { id: BOT, githubLogin: 'coderabbitai', displayName: null, avatarUrl: null, isBot: true }],
    [60, { id: 60, githubLogin: 'deepsource-io', displayName: null, avatarUrl: null, isBot: false }],
    [61, { id: 61, githubLogin: 'ops-robot', displayName: null, avatarUrl: null, isBot: true }],
  ]);
  const reviewers = [
    { userId: 60, automated: true, isManualOverride: false },
    { userId: 61, automated: false, isManualOverride: true },
  ] as WorkspaceReviewer[];

  it('falls back to User.isBot with no workspace row', () => {
    const isBot = makeUnionBotVerdict(reviewers, users);
    expect(isBot(BOT)).toBe(true);
    expect(isBot(HUMAN)).toBe(false);
    expect(isBot(999)).toBe(false); // unknown user: not a bot
  });

  it('a workspace `automated` row ADDS an in-house bot the global flag misses', () => {
    expect(makeUnionBotVerdict(reviewers, users)(60)).toBe(true);
  });

  it('a manual "human" judgement REMOVES an account the global flag calls a bot', () => {
    expect(makeUnionBotVerdict(reviewers, users)(61)).toBe(false);
  });

  it('with no listing loaded, the verdict is the wire flag alone', () => {
    const isBot = makeUnionBotVerdict(undefined, users);
    expect(isBot(60)).toBe(false);
    expect(isBot(61)).toBe(true);
  });

  it('drives the Focus filter: the in-house bot hides, the vouched-for human shows', () => {
    const pass = makeIsolateEventFilter(
      { ...ALL_ON, excludeBots: true },
      makeUnionBotVerdict(reviewers, users),
      null,
    );
    expect(pass(ev({ type: 'pr_comment', actorId: 60 }))).toBe(false);
    expect(pass(ev({ type: 'pr_comment', actorId: 61 }))).toBe(true);
  });
});

describe('the deep-linked event ALWAYS shows', () => {
  it('bypasses every rule — category, verdict and bots', () => {
    const commit = ev({ type: 'commit_pushed' });
    const botComment = ev({ type: 'review_comment', actorId: BOT });
    const commented = ev({ type: 'review_submitted', reviewState: 'commented' });
    const strict: IsolateFilterInput = {
      categories: [],
      reviewStates: ['approved'],
      excludeBots: true,
      allowedBotIds: [],
    };
    for (const target of [commit, botComment, commented]) {
      expect(makeIsolateEventFilter(strict, isBotId, null)(target)).toBe(false);
      expect(makeIsolateEventFilter(strict, isBotId, target.id)(target)).toBe(true);
    }
  });

  it('exempts ONLY that event — its siblings are still filtered', () => {
    const forced = ev({ type: 'commit_pushed' });
    const sibling = ev({ type: 'commit_pushed' });
    const out = filterIsolateEvents([forced, sibling], PR_ID, DEFAULTS, noBots, forced.id);
    expect(out).toEqual([forced]);
  });
});

describe('filterIsolateEvents', () => {
  it("keeps only the subject PR's events, in payload order", () => {
    const a = ev({ type: 'pr_comment' });
    const other = ev({ type: 'pr_comment', prId: 999 });
    const b = ev({ type: 'review_comment' });
    expect(filterIsolateEvents([a, other, b], PR_ID, ALL_ON, noBots, null)).toEqual([a, b]);
  });

  it('tolerates a missing events array (no error boundary in the SPA)', () => {
    expect(filterIsolateEvents(undefined, PR_ID, ALL_ON, noBots, null)).toEqual([]);
  });
});

describe('isolateKeepGroupIds — the rows a Focus tab keeps', () => {
  it("ALWAYS contains the author's row, even when a filter hid every event", () => {
    expect(isolateKeepGroupIds(pr(), [])).toEqual([`repo:${REPO_ID}:user:${AUTHOR}`]);
  });

  // An empty keep-set is read as "no focus" by applyContext / focusRows, which would drop the
  // isolation outright. A PR with no known author still keeps its bar's (repo) row.
  it('is never empty, even for a PR with no known author', () => {
    expect(isolateKeepGroupIds(pr({ authorId: null }), [])).toEqual([`repo:${REPO_ID}`]);
  });

  it('adds one row per surviving actor, deduped, skipping null actors and other PRs', () => {
    const events = [
      ev({ type: 'review_comment', actorId: HUMAN }),
      ev({ type: 'review_comment', actorId: HUMAN }),
      ev({ type: 'pr_comment', actorId: null }),
      ev({ type: 'pr_comment', actorId: 77, prId: 999 }),
      ev({ type: 'pr_merged', actorId: AUTHOR }),
    ];
    expect(isolateKeepGroupIds(pr(), events)).toEqual([
      `repo:${REPO_ID}:user:${AUTHOR}`,
      `repo:${REPO_ID}:user:${HUMAN}`,
    ]);
  });

  it('a bot hidden by the filter loses its row', () => {
    const events = [
      ev({ type: 'review_comment', actorId: BOT }),
      ev({ type: 'review_comment', actorId: HUMAN }),
    ];
    const kept = filterIsolateEvents(events, PR_ID, { ...ALL_ON, excludeBots: true }, isBotId, null);
    expect(isolateKeepGroupIds(pr(), kept)).toEqual([
      `repo:${REPO_ID}:user:${AUTHOR}`,
      `repo:${REPO_ID}:user:${HUMAN}`,
    ]);
  });
});

describe('matchFocusEvent — resolving a magnifier link to one event', () => {
  it('prefers the event at the requested instant among (pr, type, refId) matches', () => {
    const first = ev({ type: 'review_comment', refId: 5, occurredAt: '2026-09-01T10:00:00Z' });
    const reply = ev({ type: 'review_comment', refId: 5, occurredAt: '2026-09-02T10:00:00Z' });
    const found = matchFocusEvent(
      [first, reply],
      PR_ID,
      { type: 'review_comment', refId: 5 },
      '2026-09-02T10:00:00Z',
    );
    expect(found).toBe(reply);
  });

  it('falls back to the first match when the instant matches nothing (or is absent)', () => {
    const first = ev({ type: 'commit_pushed', refId: 9 });
    const second = ev({ type: 'commit_pushed', refId: 9 });
    expect(
      matchFocusEvent([first, second], PR_ID, { type: 'commit_pushed', refId: 9 }, 'nope'),
    ).toBe(first);
    expect(
      matchFocusEvent([first, second], PR_ID, { type: 'commit_pushed', refId: 9 }, null),
    ).toBe(first);
  });

  it('a null refId matches any event of the type; another PR never matches', () => {
    const other = ev({ type: 'pr_comment', prId: 999 });
    const mine = ev({ type: 'pr_comment', refId: 3 });
    expect(matchFocusEvent([other, mine], PR_ID, { type: 'pr_comment', refId: null }, null)).toBe(
      mine,
    );
    expect(matchFocusEvent([other], PR_ID, { type: 'pr_comment', refId: null }, null)).toBe(
      undefined,
    );
  });
});

// ── boardSlotMode: WHEN the Focus controls show ───────────────────────────────────────────────────
// ONE resolver decides what the board slot renders (App), whether the FilterBar shows the two
// Focus controls, and so where the isolate filters apply. A regression that parsed the key instead
// of looking it up in `tabs` would put Focus controls — with no effect — over the shared board.
describe('boardSlotMode', () => {
  const tab = (key: string, kind: Tab['kind'], prId: number): Tab => ({
    key,
    kind,
    prId,
    meta: null,
  });

  it('an open pr-focus tab is the isolate slot for its PR', () => {
    expect(boardSlotMode(prFocusKey(5), [tab(prFocusKey(5), 'pr-focus', 5)])).toEqual({
      kind: 'isolate',
      prId: 5,
    });
  });

  it('a stale pr-focus key (tab closed, not in `tabs`) falls back to the shared board', () => {
    expect(boardSlotMode(prFocusKey(5), [])).toBeNull();
    expect(boardSlotMode(prFocusKey(5), [tab(prFocusKey(6), 'pr-focus', 6)])).toBeNull();
  });

  it('the board, Activity and a pr-detail tab are never Focus', () => {
    const tabs = [tab(prDetailKey(5), 'pr-detail', 5), tab(prFocusKey(5), 'pr-focus', 5)];
    expect(boardSlotMode('timeline', tabs)).toBeNull();
    expect(boardSlotMode('activity', tabs)).toBeNull();
    expect(boardSlotMode(prDetailKey(5), tabs)).toBeNull();
  });
});
