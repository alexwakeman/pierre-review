// The AI-Fix comment picker's model (src/lib/aiFixCommentModel.ts). Pure on purpose: this suite
// has no React plugin, no jsdom and no @testing-library (vitest.config exports a plain object and
// pins `test/**/*.test.ts`), so the component over it cannot be rendered here — which is exactly
// why every decision that could plausibly be wrong lives in the model.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import { AI_FIX_MAX_COMMENT_TARGETS } from '@pierre-review/shared';
import type {
  AiFixCommentTargetRef,
  CommentDetail,
  MlCategory,
  MlLabel,
  MlSeverity,
  PrCommentDetail,
  PrDetail,
  ReviewDetail,
  ThreadDetail,
  User,
} from '@pierre-review/shared';
import {
  buildPickerModel,
  capNotice,
  movableAll,
  pickerKey,
  type PickerModel,
} from '../src/lib/aiFixCommentModel.js';
import { useAiFixCommentActions, useAiFixComments } from '../src/store/aiFixComments.js';

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────

const user = (id: number, login: string, isBot = false): User => ({
  id,
  githubLogin: login,
  displayName: null,
  avatarUrl: null,
  isBot,
});

const comment = (
  id: number,
  authorId: number,
  createdAt: string,
  extra: Partial<CommentDetail> = {},
): CommentDetail => ({
  id,
  authorId,
  body: `body ${id}`,
  diffHunk: null,
  createdAt,
  url: null,
  ...extra,
});

const thread = (
  id: number,
  comments: CommentDetail[],
  extra: Partial<ThreadDetail> = {},
): ThreadDetail => ({
  id,
  prId: 1,
  path: `src/f${id}.ts`,
  line: 10,
  isResolved: false,
  isOutdated: false,
  derivedState: 'untouched',
  addressedConfidence: 'none',
  addressedReason: null,
  originalCommenterId: comments[0]?.authorId ?? null,
  createdAt: comments[0]?.createdAt ?? '2026-08-01T00:00:00.000Z',
  comments,
  url: null,
  ...extra,
});

const prComment = (id: number, authorId: number, createdAt: string): PrCommentDetail => ({
  id,
  authorId,
  body: `pr comment ${id}`,
  createdAt,
  url: null,
});

const review = (
  id: number,
  authorId: number,
  submittedAt: string,
  body: string | null,
): ReviewDetail => ({
  id,
  authorId,
  state: 'commented',
  body,
  submittedAt,
  url: null,
});

function pr(partial: Partial<PrDetail> = {}): PrDetail {
  return {
    id: 1,
    repoId: 2,
    repoFullName: 'acme/web',
    number: 7,
    title: 'A PR',
    body: null,
    tickets: null,
    authorId: 1,
    state: 'open',
    isDraft: false,
    isStalled: false,
    openedAt: '2026-08-01T00:00:00.000Z',
    firstReviewAt: null,
    lastCommitAt: null,
    mergedAt: null,
    mergedById: null,
    closedAt: null,
    updatedAt: '2026-08-05T00:00:00.000Z',
    githubUrl: 'https://github.com/acme/web/pull/7',
    headSha: null,
    ciStatus: 'none',
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    reviewDecision: null,
    labels: [],
    checkRuns: [],
    additions: 0,
    deletions: 0,
    changedFilesCount: 0,
    files: [],
    requestedReviewers: [],
    viewerCanApprove: false,
    viewerCanPush: true,
    viewerCanClose: false,
    viewerHasApprovedStanding: false,
    threads: [],
    reviews: [],
    comments: [],
    commits: [],
    users: [],
    lastViewedAt: null,
    newSinceLastViewed: null,
    ...partial,
  };
}

const label = (
  kind: MlLabel['targetKind'],
  targetId: number,
  severity: MlSeverity,
  severityOrd: number,
  extra: Partial<MlLabel> = {},
): MlLabel => ({
  targetKind: kind,
  targetId,
  severity,
  severityOrd,
  severityProb: 0.9,
  vendorSeverity: null,
  vendorSeverityConfidence: null,
  categories: ['correctness_bug'] as MlCategory[],
  isSummary: false,
  backend: 'modernbert-onnx',
  modelVersion: 'v2',
  createdAt: '2026-08-02T00:00:00.000Z',
  ...extra,
});

const index = (labels: MlLabel[]): Map<string, MlLabel> =>
  new Map(labels.map((l) => [pickerKey(l.targetKind, l.targetId), l]));

/** The default verdict: `users.isBot` only, i.e. no workspace judgement in play. */
const isBotFrom = (users: User[]) => {
  const byId = new Map(users.map((u) => [u.id, u]));
  return (id: number | null): boolean => (id == null ? false : (byId.get(id)?.isBot ?? false));
};

const keys = (rows: PickerModel['bots']): string[] => rows.map((r) => r.key);

// ── roots vs replies ───────────────────────────────────────────────────────────────────────────

describe('buildPickerModel — roots and replies', () => {
  const users = [user(1, 'alice'), user(2, 'bob')];
  const p = pr({
    users,
    threads: [
      thread(10, [
        comment(100, 1, '2026-08-01T10:00:00.000Z'),
        comment(101, 2, '2026-08-01T11:00:00.000Z'),
        comment(102, 1, '2026-08-01T12:00:00.000Z'),
      ]),
    ],
  });

  it('treats comments[0] as the root and everything after it as a reply', () => {
    const m = buildPickerModel(p, {
      labels: undefined,
      isBot: isBotFrom(users),
      includeReplies: true,
    });
    expect(keys(m.humans)).toEqual([
      'review_comment|100',
      'review_comment|101',
      'review_comment|102',
    ]);
    expect(m.humans.map((r) => r.isReply)).toEqual([false, true, true]);
  });

  it('hides replies by default while still reporting how many there are', () => {
    const m = buildPickerModel(p, {
      labels: undefined,
      isBot: isBotFrom(users),
      includeReplies: false,
    });
    expect(keys(m.humans)).toEqual(['review_comment|100']);
    // The toggle's promise: the count must not collapse just because they are hidden.
    expect(m.replyCount).toBe(2);
  });

  it('keeps hidden replies in byKey, so the basket can still render a selected one', () => {
    const m = buildPickerModel(p, {
      labels: undefined,
      isBot: isBotFrom(users),
      includeReplies: false,
    });
    // A selection that stops rendering is a selection the user cannot remove.
    expect(m.byKey.get('review_comment|101')?.isReply).toBe(true);
    expect(m.byKey.size).toBe(3);
  });

  it('copies the thread anchor onto every comment of the thread', () => {
    const m = buildPickerModel(p, {
      labels: undefined,
      isBot: isBotFrom(users),
      includeReplies: true,
    });
    for (const row of m.humans) {
      expect(row.path).toBe('src/f10.ts');
      expect(row.line).toBe(10);
      expect(row.threadId).toBe(10);
    }
  });

  it('reconstructs an approximate line only when GitHub has none', () => {
    const hunk = ['@@ -10,3 +10,4 @@', ' ctx', '+added', ' ctx2'].join('\n');
    const withLine = buildPickerModel(
      pr({ users, threads: [thread(11, [comment(110, 1, 'x', { diffHunk: hunk })])] }),
      { labels: undefined, isBot: isBotFrom(users), includeReplies: false },
    );
    expect(withLine.humans[0]?.line).toBe(10);
    expect(withLine.humans[0]?.approxLine).toBeNull();

    const outdated = buildPickerModel(
      pr({
        users,
        threads: [
          thread(11, [comment(110, 1, 'x', { diffHunk: hunk })], {
            line: null,
            isOutdated: true,
          }),
        ],
      }),
      { labels: undefined, isBot: isBotFrom(users), includeReplies: false },
    );
    expect(outdated.humans[0]?.line).toBeNull();
    expect(outdated.humans[0]?.approxLine).toBe(12);
  });

  it('drops a thread with no comments rather than emitting a rootless unit', () => {
    const m = buildPickerModel(pr({ users, threads: [thread(12, [])] }), {
      labels: undefined,
      isBot: isBotFrom(users),
      includeReplies: true,
    });
    expect(m.bots).toEqual([]);
    expect(m.humans).toEqual([]);
  });

  it('orders replies CHRONOLOGICALLY under their root, whatever order they arrive in', () => {
    // The newest-first rule picks which CONVERSATION to look at; a conversation itself only reads
    // in one direction, so a reply must never sort above the reply it answers. `review_comments`
    // are selected with no orderBy, so arrival order is not a guarantee.
    const m = buildPickerModel(
      pr({
        users,
        threads: [
          thread(10, [
            comment(100, 1, '2026-08-01T10:00:00.000Z'),
            comment(103, 1, '2026-08-01T13:00:00.000Z'),
            comment(101, 1, '2026-08-01T11:00:00.000Z'),
          ]),
        ],
      }),
      { labels: undefined, isBot: isBotFrom(users), includeReplies: true },
    );
    expect(keys(m.humans)).toEqual([
      'review_comment|100',
      'review_comment|101',
      'review_comment|103',
    ]);
  });
});

// ── the bot / human split ──────────────────────────────────────────────────────────────────────

describe('buildPickerModel — bot/human split', () => {
  const users = [user(1, 'alice'), user(9, 'coderabbitai[bot]', true)];

  it('splits by the ROOT author, keeping a human reply under the bot thread it answers', () => {
    const m = buildPickerModel(
      pr({
        users,
        threads: [
          thread(10, [
            comment(100, 9, '2026-08-01T10:00:00.000Z'),
            comment(101, 1, '2026-08-01T11:00:00.000Z'),
          ]),
        ],
      }),
      { labels: undefined, isBot: isBotFrom(users), includeReplies: true },
    );
    // Both rows are in the BOTS group — the reply is part of that conversation, and hoisting it
    // into People would strip the anchor and the question it answers.
    expect(keys(m.bots)).toEqual(['review_comment|100', 'review_comment|101']);
    expect(m.humans).toEqual([]);
    // …while each row still reports its OWN author's verdict.
    expect(m.bots.map((r) => r.isBot)).toEqual([true, false]);
  });

  it('honours a workspace "this is a human" override against the global isBot flag', () => {
    // The union rule: a stored workspace judgement wins in BOTH directions. Here the actor is
    // flagged `users.isBot` globally and marked human in this workspace.
    const m = buildPickerModel(
      pr({ users, threads: [thread(10, [comment(100, 9, '2026-08-01T10:00:00.000Z')])] }),
      { labels: undefined, isBot: () => false, includeReplies: false },
    );
    expect(m.bots).toEqual([]);
    expect(keys(m.humans)).toEqual(['review_comment|100']);
  });
});

// ── ordering ───────────────────────────────────────────────────────────────────────────────────

describe('buildPickerModel — ordering', () => {
  const bot = user(9, 'coderabbitai[bot]', true);
  const users = [user(1, 'alice'), bot];

  const severityPr = (): PrDetail =>
    pr({
      users,
      threads: [
        // Deliberately NOT in the expected output order: `pr.threads` arrives in heap order.
        thread(10, [comment(100, 9, '2026-08-01T10:00:00.000Z')]),
        thread(11, [comment(101, 9, '2026-08-02T10:00:00.000Z')]),
        thread(12, [comment(102, 9, '2026-08-03T10:00:00.000Z')]),
        thread(13, [comment(103, 9, '2026-08-04T10:00:00.000Z')]),
      ],
    });

  const severityLabels = index([
    label('review_comment', 100, 'critical', 3),
    label('review_comment', 101, 'nit', 0),
    label('review_comment', 102, 'major', 2),
    // 103 deliberately unlabelled.
  ]);

  it('sorts bots by severity DESCENDING with unlabelled last', () => {
    const m = buildPickerModel(severityPr(), {
      labels: severityLabels,
      isBot: isBotFrom(users),
      includeReplies: false,
    });
    expect(keys(m.bots)).toEqual([
      'review_comment|100', // critical
      'review_comment|102', // major
      'review_comment|101', // nit
      'review_comment|103', // unlabelled — "we don't know" is not "lowest severity"
    ]);
    expect(m.botsSortedBySeverity).toBe(true);
  });

  it('sinks a summary and a praise row instead of ranking their severity', () => {
    // A `major`-scored walkthrough outranking real findings is the whole reason `findingSeverity`
    // exists (the worstSeverity trap).
    const m = buildPickerModel(severityPr(), {
      labels: index([
        label('review_comment', 100, 'major', 2, { isSummary: true }),
        label('review_comment', 101, 'critical', 3, { categories: ['praise'] }),
        label('review_comment', 102, 'nit', 0),
        label('review_comment', 103, 'minor', 1),
      ]),
      isBot: isBotFrom(users),
      includeReplies: false,
    });
    expect(keys(m.bots)).toEqual([
      'review_comment|103', // minor  — a real finding
      'review_comment|102', // nit    — a real finding
      // the two non-findings, newest first among themselves
      'review_comment|101',
      'review_comment|100',
    ]);
    expect(m.bots[0]?.severity).toBe('minor');
    expect(m.bots[2]?.severity).toBeNull(); // praise carries a severity; it is not a finding one
    expect(m.bots[2]?.label?.severity).toBe('critical'); // …but the badge still shows what it is
  });

  it('falls back to newest-first when there are no labels at all, and says so', () => {
    const m = buildPickerModel(severityPr(), {
      labels: undefined,
      isBot: isBotFrom(users),
      includeReplies: false,
    });
    expect(keys(m.bots)).toEqual([
      'review_comment|103',
      'review_comment|102',
      'review_comment|101',
      'review_comment|100',
    ]);
    // The UI must not label an arbitrary order "worst first".
    expect(m.botsSortedBySeverity).toBe(false);
  });

  it('reports no severity sort when the index holds only non-findings', () => {
    const m = buildPickerModel(severityPr(), {
      labels: index([label('review_comment', 100, 'major', 2, { isSummary: true })]),
      isBot: isBotFrom(users),
      includeReplies: false,
    });
    expect(m.botsSortedBySeverity).toBe(false);
  });

  it('sorts humans newest-first', () => {
    const m = buildPickerModel(
      pr({
        users,
        threads: [
          thread(10, [comment(100, 1, '2026-08-01T10:00:00.000Z')]),
          thread(11, [comment(101, 1, '2026-08-03T10:00:00.000Z')]),
          thread(12, [comment(102, 1, '2026-08-02T10:00:00.000Z')]),
        ],
      }),
      { labels: undefined, isBot: isBotFrom(users), includeReplies: false },
    );
    expect(keys(m.humans)).toEqual([
      'review_comment|101',
      'review_comment|102',
      'review_comment|100',
    ]);
  });

  it('is a pure function of the DATA, not of arrival order', () => {
    // ⚠ `getPrDetail` selects review_threads with NO orderBy, so this array arrives in heap order
    // — which flips on Postgres after any UPDATE, and sync updates derived_state every tick. Equal
    // timestamps must therefore not fall back to input order (a stable sort would).
    const same = '2026-08-01T10:00:00.000Z';
    const threads = [
      thread(10, [comment(100, 9, same)]),
      thread(11, [comment(101, 9, same)]),
      thread(12, [comment(102, 9, same)]),
      thread(13, [comment(103, 9, same)]),
    ];
    const opts = { labels: undefined, isBot: isBotFrom(users), includeReplies: false };
    const forwards = buildPickerModel(pr({ users, threads }), opts);
    const shuffled = buildPickerModel(
      pr({ users, threads: [threads[2]!, threads[0]!, threads[3]!, threads[1]!] }),
      opts,
    );
    expect(keys(shuffled.bots)).toEqual(keys(forwards.bots));
  });
});

// ── the three kinds ────────────────────────────────────────────────────────────────────────────

describe('buildPickerModel — the three comment kinds', () => {
  const users = [user(1, 'alice')];

  it('includes PR comments and review BODIES, and excludes a review with no body', () => {
    const m = buildPickerModel(
      pr({
        users,
        comments: [prComment(200, 1, '2026-08-02T10:00:00.000Z')],
        reviews: [
          review(300, 1, '2026-08-03T10:00:00.000Z', 'please rename this'),
          review(301, 1, '2026-08-04T10:00:00.000Z', null), // a bare approval
          review(302, 1, '2026-08-05T10:00:00.000Z', '   '), // whitespace only
        ],
      }),
      { labels: undefined, isBot: isBotFrom(users), includeReplies: false },
    );
    expect(keys(m.humans)).toEqual(['review|300', 'pr_comment|200']);
  });

  it('leaves PR comments and review bodies unanchored', () => {
    const m = buildPickerModel(
      pr({
        users,
        comments: [prComment(200, 1, '2026-08-02T10:00:00.000Z')],
        reviews: [review(300, 1, '2026-08-03T10:00:00.000Z', 'a summary')],
      }),
      { labels: undefined, isBot: isBotFrom(users), includeReplies: false },
    );
    for (const row of m.humans) {
      expect(row.path).toBeNull();
      expect(row.line).toBeNull();
      expect(row.approxLine).toBeNull();
      expect(row.threadId).toBeNull();
      expect(row.isResolved).toBe(false);
      expect(row.isOutdated).toBe(false);
    }
  });

  it('falls back through the login for an unknown author', () => {
    const m = buildPickerModel(
      pr({ users: [], comments: [prComment(200, 42, '2026-08-02T10:00:00.000Z')] }),
      { labels: undefined, isBot: () => false, includeReplies: false },
    );
    expect(m.humans[0]?.authorLogin).toBe('user 42');
  });
});

// ── movableAll ─────────────────────────────────────────────────────────────────────────────────

describe('movableAll', () => {
  const users = [user(1, 'alice')];

  it('skips resolved AND outdated rows, which a deliberate drag can still include', () => {
    const m = buildPickerModel(
      pr({
        users,
        threads: [
          thread(10, [comment(100, 1, '2026-08-01T10:00:00.000Z')]),
          thread(11, [comment(101, 1, '2026-08-02T10:00:00.000Z')], { isResolved: true }),
          thread(12, [comment(102, 1, '2026-08-03T10:00:00.000Z')], { isOutdated: true }),
        ],
        comments: [prComment(200, 1, '2026-08-04T10:00:00.000Z')],
      }),
      { labels: undefined, isBot: isBotFrom(users), includeReplies: false },
    );
    // All four are LISTED…
    expect(m.humans).toHaveLength(4);
    // …and only the two live ones are bulk-movable.
    expect(movableAll(m)).toEqual([
      { kind: 'pr_comment', id: 200 },
      { kind: 'review_comment', id: 100 },
    ]);
  });

  it('moves only what is on screen — replies while they are hidden are not swept in', () => {
    const p = pr({
      users,
      threads: [
        thread(10, [
          comment(100, 1, '2026-08-01T10:00:00.000Z'),
          comment(101, 1, '2026-08-01T11:00:00.000Z'),
        ]),
      ],
    });
    const base = { labels: undefined, isBot: isBotFrom(users) };
    expect(movableAll(buildPickerModel(p, { ...base, includeReplies: false }))).toEqual([
      { kind: 'review_comment', id: 100 },
    ]);
    expect(movableAll(buildPickerModel(p, { ...base, includeReplies: true }))).toEqual([
      { kind: 'review_comment', id: 100 },
      { kind: 'review_comment', id: 101 },
    ]);
  });
});

// ── the page cap ───────────────────────────────────────────────────────────────────────────────

describe('atPageCap / capNotice', () => {
  const users = [user(1, 'alice')];

  it('says nothing when no kind is at GitHub’s page size', () => {
    const m = buildPickerModel(
      pr({ users, threads: [thread(10, [comment(100, 1, '2026-08-01T10:00:00.000Z')])] }),
      { labels: undefined, isBot: isBotFrom(users), includeReplies: false },
    );
    expect(m.atPageCap).toEqual({ threads: false, prComments: false, reviews: false });
    expect(capNotice(m.atPageCap)).toBeNull();
  });

  it('discloses a truncated view rather than implying the list is everything', () => {
    // A PR sitting at exactly 50 threads may have more that were never fetched, and nothing on
    // the wire says which — so "Move all" must not read as a claim of completeness.
    const threads = Array.from({ length: 50 }, (_, i) =>
      thread(i + 1, [comment(1000 + i, 1, `2026-08-01T10:00:${String(i).padStart(2, '0')}.000Z`)]),
    );
    const m = buildPickerModel(pr({ users, threads }), {
      labels: undefined,
      isBot: isBotFrom(users),
      includeReplies: false,
    });
    expect(m.atPageCap.threads).toBe(true);
    expect(capNotice(m.atPageCap)).toContain('review threads');
    expect(capNotice(m.atPageCap)).toContain('there may be more');
  });
});

// ── the selection store ────────────────────────────────────────────────────────────────────────
// Not the model, but the same kind of decision: pure state transitions whose wrong version compiles
// perfectly. Plain zustand with no React in the path, so it runs here directly.

describe('store/aiFixComments', () => {
  const ref = (id: number): AiFixCommentTargetRef => ({ kind: 'review_comment', id });
  const read = (prId: number): AiFixCommentTargetRef[] =>
    useAiFixComments.getState().byPr[prId] ?? [];
  const actions = useAiFixCommentActions();

  beforeEach(() => {
    actions.clear(1);
    actions.clear(2);
  });

  it('appends in insertion order and dedups', () => {
    actions.add(1, [ref(10), ref(11)]);
    actions.add(1, [ref(11), ref(12)]);
    // Insertion order IS the contract: the run assigns its C1/C2/… prompt labels positionally.
    expect(read(1).map((r) => r.id)).toEqual([10, 11, 12]);
  });

  it('STOPS at AI_FIX_MAX_COMMENT_TARGETS rather than letting the server drop the tail', () => {
    // The boundary "Move all" hits on a bot-flooded PR. The server truncates, and a silently
    // dropped tail means watching a paid run work through a scope missing what mattered most.
    actions.add(1, Array.from({ length: AI_FIX_MAX_COMMENT_TARGETS + 5 }, (_, i) => ref(i + 1)));
    expect(read(1)).toHaveLength(AI_FIX_MAX_COMMENT_TARGETS);
    expect(read(1).at(-1)?.id).toBe(AI_FIX_MAX_COMMENT_TARGETS);
    // A further add is a NO-OP that keeps the array identity — that reference is the render
    // identity for every `useAiFixSelection` consumer.
    const before = read(1);
    actions.add(1, [ref(999)]);
    expect(read(1)).toBe(before);
  });

  it('keeps each PR independent, and clear() removes only its own', () => {
    actions.add(1, [ref(10)]);
    actions.add(2, [ref(20)]);
    actions.clear(1);
    expect(read(1)).toEqual([]);
    expect(read(2).map((r) => r.id)).toEqual([20]);
  });

  it('removes by (kind, id) — the three id spaces do not collide', () => {
    actions.add(1, [ref(10), ref(11)]);
    const before = read(1);
    // Same numeric id, DIFFERENT id space: review_comments / pr_comments / reviews are distinct
    // tables, so a bare-id match here would silently drop the wrong comment.
    actions.remove(1, [{ kind: 'pr_comment', id: 10 }]);
    expect(read(1)).toBe(before);
    actions.remove(1, [ref(10)]);
    expect(read(1).map((r) => r.id)).toEqual([11]);
  });

  it('holds NO key for an untouched or cleared PR, which is what lets the hook return one stable []', () => {
    // `useAiFixSelection` falls back to a module-level EMPTY; if `clear` left a fresh `[]` behind
    // instead of deleting the key, the fallback would stop being the value and zustand v5's
    // Object.is snapshot check would see a new array on every store write.
    expect(useAiFixComments.getState().byPr[99]).toBeUndefined();
    actions.add(99, [ref(1)]);
    actions.clear(99);
    expect(useAiFixComments.getState().byPr[99]).toBeUndefined();
  });
});
