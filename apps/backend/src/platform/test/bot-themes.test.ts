// The revived Bots "What they're flagging" summary — the two properties that make it billable
// safely, pinned at the seams they live in:
//
//  1. THE PAYLOAD HASH HAS NO VOLATILE FIELD. The legacy formula folded in a day-quantised
//     windowKey, which re-billed every dormant scope daily ("a dormant scope must stay a cache
//     hit forever" — the synthesis hash header names that exact field as the violation). The
//     tests build the SAME corpus under two different fake clocks and demand byte-identical
//     hashes; counts-only drift (more near-identical comments) must stay a $0 hit while a
//     cluster-SET change must move the hash.
//
//  2. THE PER-THEME COMMENT COUNT IS A CODE FOLD (D4). The model picks WHICH clusters a theme
//     groups (memberIds); code says how many comments those clusters stand for. An id outside
//     the payload contributes 0 (the synthesis "ids ⊆ input" posture), and a repeated id counts
//     once.
//
// Also pinned: the scope-key serialiser (the isolation seeds and migration-0020 commentary
// depend on the unnarrowed spelling staying `ws:<id>`), and that an empty scope neither queries
// nor bills.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotWindowKind } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import { buildBotThemes } from '../bot-themes/build.js';
import { themeCommentCount, themesScopeKey } from '../bot-themes/routes.js';

// The host getBotReviewComments row shape (mirrored in build.ts; only the fields the fold reads
// matter here).
interface Row {
  id: number;
  source: 'review' | 'issue';
  prId: number;
  prNumber: number;
  repoId: number;
  repoFullName: string;
  path: string | null;
  authorUserId: number;
  reviewerKey: string;
  label: string;
  login: string | null;
  kind: string;
  body: string | null;
  createdAt: string;
  derivedState: string | null;
  threadId: number | null;
}

function row(id: number, body: string, over: Partial<Row> = {}): Row {
  return {
    id,
    source: 'review',
    prId: 100 + id,
    prNumber: id,
    repoId: 10,
    repoFullName: 'acme/api',
    path: 'src/app.ts',
    authorUserId: 7,
    reviewerKey: 'u7',
    label: 'CodeRabbit',
    login: 'coderabbitai[bot]',
    kind: 'coderabbit',
    body,
    createdAt: '2026-08-20T10:00:00.000Z',
    derivedState: 'untouched',
    threadId: 900 + id,
    ...over,
  };
}

function ctxFor(comments: Row[], truncated = false): ProContext {
  return {
    queries: { getBotReviewComments: async () => ({ comments, truncated }) },
  } as unknown as ProContext;
}

const SCOPE = { workspaceId: 5, repoIds: [10] };
const WINDOW: BotWindowKind = 'rolling_14';
const KEY = themesScopeKey(5, null);

async function hashOf(comments: Row[]): Promise<string> {
  const build = await buildBotThemes(ctxFor(comments), 1, SCOPE, WINDOW, KEY);
  if (build == null || build.empty) throw new Error('expected a non-empty build');
  return build.hash;
}

// Two distinctly-worded points (distinct dedup keys) + a near-duplicate of the first (same
// letters after normalisation — only numbers/punctuation differ, which dedupKey strips).
const NULL_CHECK_A = 'Add a null check before dereferencing the user, line 42.';
const NULL_CHECK_B = 'Add a null check before dereferencing the user — line 977!';
const UNUSED_IMPORT = 'This import is unused and can be removed.';

afterEach(() => {
  vi.useRealTimers();
});

describe('buildBotThemes payload hash', () => {
  it('is identical for the same corpus under two different clocks (no volatile field)', async () => {
    vi.useFakeTimers();
    const corpus = [row(1, NULL_CHECK_A), row(2, UNUSED_IMPORT)];
    vi.setSystemTime(new Date('2026-08-20T09:00:00Z'));
    const h1 = await hashOf(corpus);
    vi.setSystemTime(new Date('2026-09-03T23:59:00Z')); // another day, another fortnight
    const h2 = await hashOf(corpus);
    expect(h2).toBe(h1);
  });

  it('is stable under counts-only drift, and moves when the cluster set changes', async () => {
    const base = [row(1, NULL_CHECK_A), row(2, UNUSED_IMPORT)];
    const h = await hashOf(base);
    // A near-identical repeat (new PR, new thread) grows a cluster's count — a $0 cache hit.
    expect(await hashOf([...base, row(3, NULL_CHECK_B)])).toBe(h);
    // A distinctly-worded comment mints a NEW cluster key — the set moved, so the hash must.
    expect(await hashOf([...base, row(3, 'Unhandled promise rejection in the sync loop.')])).not.toBe(h);
  });

  it('an empty scope returns null without ever querying (nothing to answer, nothing billed)', async () => {
    const ctx = {
      queries: {
        getBotReviewComments: async () => {
          throw new Error('must not query an empty scope');
        },
      },
    } as unknown as ProContext;
    expect(await buildBotThemes(ctx, 1, { workspaceId: 5, repoIds: [] }, WINDOW, KEY)).toBeNull();
  });

  it('no comments in window → empty:true (the routes answer empty, unbilled)', async () => {
    const build = await buildBotThemes(ctxFor([]), 1, SCOPE, WINDOW, KEY);
    expect(build?.empty).toBe(true);
    expect(build?.countIndex.size).toBe(0);
  });

  it('countIndex carries each payload cluster\'s deterministic member count', async () => {
    const build = await buildBotThemes(
      ctxFor([row(1, NULL_CHECK_A), row(2, NULL_CHECK_B), row(3, UNUSED_IMPORT)]),
      1,
      SCOPE,
      WINDOW,
      KEY,
    );
    if (build == null || build.empty) throw new Error('expected a non-empty build');
    const clusters = (build.payload as { clusters: Array<{ id: number; count: number }> }).clusters;
    expect(clusters.length).toBe(2); // the two null-check spellings collapsed into one cluster
    for (const c of clusters) expect(build.countIndex.get(c.id)).toBe(c.count);
    expect([...build.countIndex.values()].sort()).toEqual([1, 2]);
  });
});

describe('themeCommentCount (D4 — the model never authors the figure)', () => {
  const countIndex = new Map<number, number>([
    [0, 4],
    [1, 1],
    [2, 7],
  ]);

  it('sums the cited clusters\' code-computed counts', () => {
    expect(themeCommentCount([0, 2], countIndex)).toBe(11);
  });

  it('an id outside the payload contributes 0, and a repeated id counts once', () => {
    expect(themeCommentCount([0, 99], countIndex)).toBe(4); // 99 was never in the payload
    expect(themeCommentCount([1, 1, 1], countIndex)).toBe(1); // deduplicated before summing
    expect(themeCommentCount([], countIndex)).toBe(0);
  });
});

describe('themesScopeKey', () => {
  it('unnarrowed stays the legacy `ws:<id>` spelling (isolation seeds + 0020 commentary)', () => {
    expect(themesScopeKey(5, null)).toBe('ws:5');
  });

  it('a narrowing appends a sorted, deduped `|r:` suffix — per-repo rows coexist with cross-repo', () => {
    expect(themesScopeKey(5, [9, 3, 9])).toBe('ws:5|r:3,9');
    expect(themesScopeKey(5, [3, 9])).toBe(themesScopeKey(5, [9, 3]));
  });
});
