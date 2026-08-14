// The emoji-reaction LOADER — the one mechanism the whole feature stands on.
//
// WHAT THIS FILE IS FOR. Reactions are fetched live from GitHub and never stored: there is no
// column, no migration and no sync cost. The only thing that makes that affordable is the
// microtask batcher in `hooks/useReactions.ts` — every mounted comment registers itself, and a
// tick's worth of registrations become ONE request. Break the batching and the feature does not
// merely get slower, it reproduces the exact regression this codebase records twice (a
// 60-thread PR firing 60 requests) while looking perfectly correct on screen, because every bar
// still renders. Nothing else pins it, so this does.
//
// The optimistic transform is here for the same reason: "the last reactor removes their
// reaction" is the case that leaves a permanent `0` chip on screen if it is wrong, and it is
// invisible until someone happens to un-react as the only reactor.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ReactionLookupBody,
  ReactionState,
  ReactionTargetRef,
} from '@pierre-review/shared';
import { applyReactionToggle, loadReactions } from '../src/hooks/useReactions.js';

interface Capture {
  url: string;
  body: ReactionLookupBody;
}

let calls: Capture[] = [];
let respondWith: (targets: ReactionTargetRef[]) => ReactionState[];

const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  // Default: every requested target comes back with one 👍.
  respondWith = (targets) =>
    targets.map((t) => ({
      kind: t.kind,
      id: t.id,
      groups: [{ content: 'thumbs_up' as const, count: 1, viewerHasReacted: false }],
      viewerCanReact: true,
    }));

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as ReactionLookupBody;
    calls.push({ url: String(input), body });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          results: respondWith(body.targets),
          generatedAt: new Date().toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const ref = (id: number): ReactionTargetRef => ({ kind: 'review_comment', id });

describe('loadReactions — microtask batching', () => {
  // THE load-bearing property. Sixty comments mounting in one React commit must cost ONE
  // request. If this ever becomes 60, every surface still looks right and the bill arrives
  // later — which is precisely why it is asserted rather than assumed.
  it('collapses a tick of registrations into a single request', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    const results = await Promise.all(ids.map((id) => loadReactions(ref(id))));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/reactions/lookup');
    expect(calls[0]?.body.targets).toHaveLength(40);
    expect(results).toHaveLength(40);
    expect(results[0]?.groups[0]?.count).toBe(1);
  });

  // Two mounts of the same comment (the Threads tab and the Feed can both be showing it) must
  // not put the same target on the wire twice.
  it('coalesces duplicate targets registered in the same tick', async () => {
    const [a, b, c] = await Promise.all([
      loadReactions(ref(7)),
      loadReactions(ref(7)),
      loadReactions(ref(8)),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.targets).toHaveLength(2);
    // Both waiters on the duplicate get the answer.
    expect(a?.id).toBe(7);
    expect(b?.id).toBe(7);
    expect(c?.id).toBe(8);
  });

  // The batch is BOUNDED. A very large commit must chunk rather than post an unbounded list at
  // a route that caps at 200 targets and a GitHub API that caps at 100 node ids.
  it('splits past the batch ceiling instead of growing one request without bound', async () => {
    const ids = Array.from({ length: 130 }, (_, i) => i + 1);
    await Promise.all(ids.map((id) => loadReactions(ref(id))));

    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.body.targets.length).toBeLessThanOrEqual(60);
    const total = calls.reduce((n, c) => n + c.body.targets.length, 0);
    expect(total).toBe(130);
  });

  // The three kinds are three separate id spaces, so id 5 can legitimately appear once per
  // kind and all three must survive the queue's dedupe key.
  it('keeps the same numeric id in different target kinds apart', async () => {
    await Promise.all([
      loadReactions({ kind: 'review_comment', id: 5 }),
      loadReactions({ kind: 'pr_comment', id: 5 }),
      loadReactions({ kind: 'review', id: 5 }),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.targets).toHaveLength(3);
  });

  // A target the server omits — unknown, another tenant's, deleted upstream, or simply
  // unreacted-and-invisible — resolves to null rather than hanging or throwing. All four cases
  // render identically (nothing), which is why the server deliberately does not distinguish
  // them: doing so would be an existence oracle.
  it('resolves an omitted target to null without failing its neighbours', async () => {
    respondWith = (targets) =>
      targets
        .filter((t) => t.id !== 2)
        .map((t) => ({ kind: t.kind, id: t.id, groups: [], viewerCanReact: false }));

    const [one, two] = await Promise.all([loadReactions(ref(1)), loadReactions(ref(2))]);
    expect(one).not.toBeNull();
    expect(two).toBeNull();
  });

  // THE RATE-LIMIT DEGRADE, from the client's side. When the account's GitHub window is
  // exhausted the server answers `results: []` instead of 502-ing (a reaction bar is a
  // decoration — erroring a request the user never knowingly made is the worse failure). That
  // arrives here as a wholly-empty response, and it must resolve to `null` — the "unknown"
  // value the hook maps to `undefined` and the bar renders as nothing — rather than throwing
  // or, worse, being read as "no reactions".
  it('resolves EVERY waiter to null on a wholly-empty response (the rate-limit degrade)', async () => {
    respondWith = () => [];

    const settled = await Promise.all([loadReactions(ref(1)), loadReactions(ref(2))]);
    expect(settled).toEqual([null, null]);
    expect(calls).toHaveLength(1);
  });

  // A failed batch rejects every waiter — the query layer turns that into "render nothing",
  // and `retry:false` stops it becoming a per-target retry storm.
  it('rejects every waiter when the batch fails, not just the first', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'GitHubError', message: 'boom' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof fetch;

    const settled = await Promise.allSettled([loadReactions(ref(1)), loadReactions(ref(2))]);
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
  });
});

describe('applyReactionToggle — the optimistic transform', () => {
  const base = (groups: ReactionState['groups']): ReactionState => ({
    kind: 'review_comment',
    id: 1,
    groups,
    viewerCanReact: true,
  });

  it('adds a brand-new chip at count 1', () => {
    const next = applyReactionToggle(base([]), 'rocket', true);
    expect(next.groups).toEqual([{ content: 'rocket', count: 1, viewerHasReacted: true }]);
  });

  it('joins an existing chip without disturbing the others', () => {
    const next = applyReactionToggle(
      base([
        { content: 'thumbs_up', count: 2, viewerHasReacted: false },
        { content: 'eyes', count: 1, viewerHasReacted: false },
      ]),
      'thumbs_up',
      true,
    );
    expect(next.groups).toContainEqual({
      content: 'thumbs_up',
      count: 3,
      viewerHasReacted: true,
    });
    expect(next.groups).toContainEqual({ content: 'eyes', count: 1, viewerHasReacted: false });
  });

  // Idempotent, exactly like GitHub's own mutation — a double click must not double count.
  it('does not double-count re-adding a reaction the viewer already has', () => {
    const next = applyReactionToggle(
      base([{ content: 'heart', count: 4, viewerHasReacted: true }]),
      'heart',
      true,
    );
    expect(next.groups).toEqual([{ content: 'heart', count: 4, viewerHasReacted: true }]);
  });

  // THE case worth a test: the viewer was the only reactor, so the chip must VANISH. Leaving a
  // `count: 0` pill on screen is the visible failure, and it survives until a refetch.
  it('removes the chip entirely when the viewer was the last reactor', () => {
    const next = applyReactionToggle(
      base([{ content: 'laugh', count: 1, viewerHasReacted: true }]),
      'laugh',
      false,
    );
    expect(next.groups).toEqual([]);
  });

  it('decrements but keeps the chip when others also reacted', () => {
    const next = applyReactionToggle(
      base([{ content: 'laugh', count: 3, viewerHasReacted: true }]),
      'laugh',
      false,
    );
    expect(next.groups).toEqual([{ content: 'laugh', count: 2, viewerHasReacted: false }]);
  });

  it('is a no-op when removing a reaction the viewer never had', () => {
    const next = applyReactionToggle(
      base([{ content: 'laugh', count: 3, viewerHasReacted: false }]),
      'laugh',
      false,
    );
    expect(next.groups).toEqual([{ content: 'laugh', count: 3, viewerHasReacted: false }]);
  });

  // A new chip lands in GitHub's canonical order rather than at the end, so the bar does not
  // reshuffle under the cursor between the optimistic update and the server's answer.
  it('keeps the bar in canonical order after an add', () => {
    const next = applyReactionToggle(
      base([{ content: 'eyes', count: 1, viewerHasReacted: false }]),
      'thumbs_up',
      true,
    );
    expect(next.groups.map((g) => g.content)).toEqual(['thumbs_up', 'eyes']);
  });
});
