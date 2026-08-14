import { useMutation, useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ReactionContent,
  ReactionState,
  ReactionTargetKind,
  ReactionTargetRef,
} from '@pierre-review/shared';
import { REACTION_CONTENTS } from '@pierre-review/shared';
import { api } from '../api/client.js';

// Emoji reactions (CORE, free tier). Nothing about them is synced or stored — they are read
// live from GitHub — and THIS FILE is what makes that affordable.
//
// ── THE MECHANISM ────────────────────────────────────────────────────────────────────────
// A MICROTASK-BATCHED LOADER. Every mounted comment asks for its own reactions through an
// ordinary per-target React Query; the query function does not issue a request, it drops the
// target into a shared queue and returns a promise. Everything registered within one tick is
// flushed as ONE `POST /api/reactions/lookup`, and each waiter is resolved from that single
// response.
//
// That is the whole reason the feature can render EVERYWHERE without a sync column:
//   • a 60-thread PR costs one request, not sixty — the exact storm CLAUDE.md records
//     (`ThreadAssessment`: 60 requests to paint 60 empty boxes),
//   • and the Feed, which spans MANY PRs, works unchanged: a per-PR index route (the shape
//     `useMlLabelIndex` uses) could not have served it, because there is no single PR to key
//     on. Nothing in Activity/FeedView.tsx had to be touched — the shared comment renderer
//     inherits the behaviour.
//
// React 18 flushes a commit's passive effects together, so every card mounted in one render
// registers before the microtask drains. A commit that legitimately splits (a virtualised list
// paging in) simply costs one more batch — bounded, never per-comment.
//
// ── WHY REACT QUERY UNDERNEATH ───────────────────────────────────────────────────────────
// Caching per target is what stops a re-render from refetching, and the shared cache entry is
// also what keeps TWO MOUNTS OF THE SAME COMMENT in agreement: the Threads tab and the Feed can
// both be showing one bot comment, and a toggle in either writes the one `['reactions', kind,
// id]` entry that both read. The mutation carries a per-target key for the same reason at the
// in-flight level (the `CiAnalysisCard` rule).
//
// These queries are deliberately NOT in main.tsx's `shouldDehydrateQuery` allowlist: a reaction
// is other people's live state, and a week-old persisted copy would be a confident lie.

/** Per-target cache key. NO workspace segment — a comment id names its own scope server-side. */
export function reactionKey(kind: ReactionTargetKind, id: number): unknown[] {
  return ['reactions', kind, id];
}

/** Per-target MUTATION key, so two mounts of one comment share the in-flight state. */
export function reactionMutationKey(kind: ReactionTargetKind, id: number): unknown[] {
  return ['reaction-toggle', kind, id];
}

const refKey = (kind: ReactionTargetKind, id: number): string => `${kind}:${id}`;

/**
 * Targets per request. Comfortably under the route's 200 ceiling and GitHub's 100-node
 * `nodes(ids:)` cap (which the server chunks to anyway), and small enough that one slow batch
 * cannot hold a whole screen's bars hostage.
 */
const MAX_BATCH = 60;

/**
 * How long a fetched set stays fresh. Reactions are other people's writes, so they DO drift —
 * but nothing in this UI can observe that drift, and refetching on a whim spends the tenant's
 * GitHub quota. Five minutes means a long-lived tab re-reads on the next mount rather than on
 * every scroll.
 */
const REACTION_STALE_MS = 5 * 60_000;

/**
 * How long an UNKNOWN answer (`null` — see `dispatch`) stays fresh. Much shorter, because the
 * server deliberately cannot tell us WHY a target was absent, and one of the reasons is
 * temporary: when the account's GitHub rate window is exhausted the lookup degrades to an
 * empty result set rather than a 502, so every target on screen comes back `null`. Caching
 * that for the full five minutes would turn a transient degrade into a stale "no reactions"
 * long after the window reopened. A known answer — including a genuinely unreacted comment,
 * which arrives as an ENTRY with zero groups, not as an absence — is unaffected.
 *
 * Cheap: `refetchOnWindowFocus` is off app-wide, so the only trigger is a re-mount, and a
 * re-mount goes through the same batcher — one request for the screen, never one per comment.
 */
const UNKNOWN_STALE_MS = 30_000;

interface Waiter {
  resolve: (state: ReactionState | null) => void;
  reject: (err: unknown) => void;
}

/** Keyed so a duplicate registration in the same tick coalesces onto one queue slot. */
const pending = new Map<string, { target: ReactionTargetRef; waiters: Waiter[] }>();
let scheduled = false;

async function dispatch(
  entries: Array<{ target: ReactionTargetRef; waiters: Waiter[] }>,
): Promise<void> {
  try {
    const res = await api.reactionLookup({ targets: entries.map((e) => e.target) });
    const byKey = new Map<string, ReactionState>();
    for (const r of res.results) byKey.set(refKey(r.kind, r.id), r);
    for (const e of entries) {
      // ABSENT means unknown / not ours / invisible to the token / genuinely no reactions.
      // All four render identically (nothing), so `null` is the honest single answer — the
      // server deliberately does not distinguish them (that would be an existence oracle).
      const hit = byKey.get(refKey(e.target.kind, e.target.id)) ?? null;
      for (const w of e.waiters) w.resolve(hit);
    }
  } catch (err) {
    for (const e of entries) for (const w of e.waiters) w.reject(err);
  }
}

function flush(): void {
  scheduled = false;
  if (pending.size === 0) return;
  const entries = [...pending.values()];
  pending.clear();
  for (let i = 0; i < entries.length; i += MAX_BATCH) {
    void dispatch(entries.slice(i, i + MAX_BATCH));
  }
}

/**
 * Register one target and get its state when the batch lands.
 *
 * Exported for tests; components go through `useReactionState`. A queue that reaches MAX_BATCH
 * flushes IMMEDIATELY rather than waiting for the microtask — a very large commit should start
 * its first request straight away instead of accumulating a queue it will only chunk anyway.
 */
export function loadReactions(target: ReactionTargetRef): Promise<ReactionState | null> {
  return new Promise((resolve, reject) => {
    const key = refKey(target.kind, target.id);
    const existing = pending.get(key);
    if (existing) {
      existing.waiters.push({ resolve, reject });
      return;
    }
    pending.set(key, { target, waiters: [{ resolve, reject }] });
    if (pending.size >= MAX_BATCH) {
      // Leaves any already-queued microtask in place; it will find the map empty and no-op.
      flush();
      return;
    }
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  });
}

/**
 * This target's reactions, or `undefined` while unknown (in flight, failed, absent from the
 * response, or never fetched).
 *
 * `undefined` and "no reactions" are NOT the same thing and the bar must not conflate them:
 * the first renders nothing because we do not know, the second renders nothing (or just the
 * add affordance) because there is nothing to show. That distinction is what makes the
 * server's rate-limit degrade — an empty result set instead of a 502 — safe: an absent target
 * lands in the first bucket, so the bar disappears rather than asserting zero reactions.
 */
export function useReactionState(
  kind: ReactionTargetKind,
  id: number,
): ReactionState | undefined {
  const q = useQuery<ReactionState | null>({
    queryKey: reactionKey(kind, id),
    queryFn: () => loadReactions({ kind, id }),
    // Freshness depends on WHAT we learned: a real answer holds for the full window, an
    // unknown one ages out quickly so a transient degrade heals on the next mount.
    staleTime: (query) => (query.state.data == null ? UNKNOWN_STALE_MS : REACTION_STALE_MS),
    // A failed batch must not turn into a retry per target. The bar is cosmetic; the honest
    // response to a 502 here is to render nothing and cost nothing.
    //
    // `refetchOnMount` is left at its DEFAULT on purpose: a card scrolling back into view
    // inside the freshness window is served from cache (no request at all), and one that has
    // aged out re-registers with the batcher — so a stale refresh is still one request for the
    // whole screen, never one per comment.
    retry: false,
  });
  return q.data ?? undefined;
}

/** True while a toggle on this exact target is in flight — SHARED across every mount of it. */
export function useReactionPending(kind: ReactionTargetKind, id: number): boolean {
  return useIsMutating({ mutationKey: reactionMutationKey(kind, id) }) > 0;
}

/**
 * Apply a toggle to a cached state locally — the optimistic half.
 *
 * Kept pure and exported so a test can pin it: this is the function that decides whether the
 * chip count moves before the round trip, and getting the "last reactor removes the chip" case
 * wrong leaves a permanent `0` pill on screen.
 */
export function applyReactionToggle(
  state: ReactionState,
  content: ReactionContent,
  add: boolean,
): ReactionState {
  const groups = state.groups.filter((g) => g.content !== content);
  const current = state.groups.find((g) => g.content === content);
  if (add) {
    // Idempotent, like GitHub's own mutation: re-adding what the viewer already has is a no-op
    // rather than a double count.
    const already = current?.viewerHasReacted === true;
    groups.push({
      content,
      count: (current?.count ?? 0) + (already ? 0 : 1),
      viewerHasReacted: true,
    });
  } else if (current) {
    const next = current.viewerHasReacted ? current.count - 1 : current.count;
    if (next > 0) groups.push({ content, count: next, viewerHasReacted: false });
    // next <= 0 ⇒ the viewer was the last reactor; the chip disappears entirely.
  }
  // Canonical order so a newly-added chip lands in a stable place rather than at the end.
  groups.sort((a, b) => REACTION_CONTENTS.indexOf(a.content) - REACTION_CONTENTS.indexOf(b.content));
  return { ...state, groups };
}

/**
 * Toggle one reaction on one target.
 *
 * Optimistic with rollback. On success the server's response REPLACES the cache entry rather
 * than invalidating it — the mutation payload already carries GitHub's authoritative post-write
 * groups, so a refetch would be a second GraphQL call for information we were just handed.
 * Only a FAILURE invalidates, because after a rollback our copy is a guess.
 */
export function useToggleReaction(kind: ReactionTargetKind, id: number) {
  const qc = useQueryClient();
  const key = reactionKey(kind, id);
  return useMutation<
    ReactionState,
    Error,
    { content: ReactionContent; add: boolean },
    { prev: ReactionState | null | undefined }
  >({
    mutationKey: reactionMutationKey(kind, id),
    mutationFn: (vars) => api.setReaction({ kind, id, content: vars.content, add: vars.add }),
    onMutate: async (vars) => {
      // An in-flight batch resolving mid-toggle would otherwise overwrite the optimistic state
      // with the pre-write server copy.
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ReactionState | null>(key);
      if (prev) qc.setQueryData<ReactionState>(key, applyReactionToggle(prev, vars.content, vars.add));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) qc.setQueryData<ReactionState | null>(key, ctx.prev ?? null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onSuccess: (data) => {
      qc.setQueryData<ReactionState>(key, data);
    },
  });
}
