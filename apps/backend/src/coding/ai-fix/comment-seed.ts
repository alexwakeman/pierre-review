import { and, eq, inArray } from 'drizzle-orm';
import type {
  AiFixCommentDisposition,
  AiFixCommentKind,
  AiFixCommentTarget,
  AiFixCommentTargetRef,
  AiFixCommentVerdict,
} from '@pierre-review/shared';
import type { FixItemVerdict } from '../../pro/contract.js';
import type { AgentContext } from '../../review/agent-context.js';

// The "fix from comments" seed: resolve the comments the user dragged into the basket, render
// them into the fixer's prompt, and map the agent's per-ref report back onto them.
//
// THREE THINGS LIVE HERE AND NOWHERE ELSE:
//   1. resolveCommentTargets — (kind, id) pairs from the client → server-owned facts. The client
//      sends ids and NOTHING else: a client-supplied body would be an unauthenticated way to put
//      arbitrary text into an agent's prompt, which is the whole reason this resolver exists.
//   2. buildCommentSeedText — the numbered, FENCED prompt block. Every body in it is
//      attacker-authored (see the security note on buildFixCommentsSystemPrompt in prompts.ts).
//   3. mapCommentVerdicts — the agent's `ref` labels → real comments, including the two failure
//      modes the report exists to catch (a fabricated ref, and a comment never reported on).
//
// ⚠ THE CAP IS MIRRORED, NOT IMPORTED — and the reason is a hard build constraint, not taste.
// `AI_FIX_MAX_COMMENT_TARGETS` is a runtime VALUE in @pierre-review/shared, but that package is
// TYPES-ONLY and is not shipped: every one of this plugin's ~23 imports from it is `import type`
// (stripped at emit), and scripts/build-release.mjs greps `release/pro` for a real runtime import
// and FAILS the build. Importing the value here would make the plugin the first runtime importer
// of an unshipped package.
//
// So it is a mirrored literal — and the mirror is PINNED BY A TEST rather than by this comment:
// test/ai-fix-comment-seed.test.ts imports the shared value (a test file is not shipped, so it
// may) and asserts the two are equal. Hence the export.
export const MAX_COMMENT_TARGETS = 25;

// Per-target caps. A bot-flooded PR is this app's normal workload, so 25 targets × an uncapped
// body would be the whole prompt budget before the diff gets a look in.
const BODY_CHAR_LIMIT = 1_600;
const HUNK_CHAR_LIMIT = 1_200;
// The whole rendered seed. Over budget we DROP FROM THE END and name what was dropped, because a
// silent mid-list truncation would leave the agent reporting on a comment whose text it never saw.
//
// ⚠ THIS NUMBER AND `MAX_COMMENT_TARGETS` ARE ONE DECISION, and they were briefly in open conflict:
// at 26k, a basket filled to the UI's advertised 25 dropped most of itself on a REALISTIC PR
// (measured against this renderer: 600-char bodies + 500-char hunks kept 17 of 25; at the per-target
// caps, 8 of 25). Truncation is meant to be the rare tail, not the normal case — a user who fills
// the basket to the stated limit, pays for an agent run and waits should not learn afterwards that
// two thirds of the scope was decided server-side. So the budget now covers 25 targets at the
// realistic size (~1.4k each) with room to spare, and the reference diff gave up the difference
// (FIX_COMMENTS_DIFF_BUDGET in prompts.ts) — the cheaper half of the window, since the worktree
// holds the full change and the diff is only orientation. Worst case (every target at both caps)
// still drops a tail; that is the guarantee, and shared/types.ts states it in those terms.
// Changing either literal without re-measuring the other reopens exactly this gap.
const SEED_CHAR_BUDGET = 60_000;

const KINDS: readonly AiFixCommentKind[] = ['review_comment', 'pr_comment', 'review'];

const DISPOSITIONS: readonly AiFixCommentDisposition[] = [
  'fixed',
  'partially_fixed',
  'already_addressed',
  'invalid',
  'out_of_scope',
  'needs_human',
];

/** One target as the PROMPT needs it. `body`/`hunk` are prompt-only and never reach the wire. */
export interface ResolvedCommentTarget {
  /** Exactly the shared shape, including the assigned `ref` — this is what gets persisted. */
  wire: AiFixCommentTarget;
  /** FULL (capped) body — prompt only. The wire carries `excerpt` instead. */
  body: string;
  /** The anchor diff hunk, hydrated or stored. Prompt only; review comments only. */
  hunk: string | null;
  /** A reply inside its thread rather than the comment that opened it. */
  isReply: boolean;
  /** The thread was marked resolved on GitHub — a CLAIM to verify, not evidence. */
  isResolvedThread: boolean;
  /** The thread's anchor no longer exists in the current diff. */
  isOutdatedThread: boolean;
  /** The thread's file, when the target has a thread. Mirrors `wire.path`. */
  threadPath: string | null;
}

const clamp = (s: string, n: number, marker: string): string =>
  s.length <= n ? s : `${s.slice(0, n)}\n${marker}`;

const asMs = (d: Date | number | null | undefined): number =>
  d == null ? 0 : d instanceof Date ? d.getTime() : Number(d) * (Number(d) > 1e12 ? 1 : 1000);

/**
 * Validate the client's `commentTargets` body field: known kind, finite positive integer id,
 * de-duplicated, order preserved, capped.
 *
 * Shape validation only — MEMBERSHIP is `resolveCommentTargets`' job (it is the thing that knows
 * which rows belong to this PR), and an id that survives this and resolves to nothing is dropped
 * there rather than raised. A forged id must be inert, not an error.
 */
export function parseCommentTargetRefs(raw: unknown): AiFixCommentTargetRef[] {
  if (!Array.isArray(raw)) return [];
  const out: AiFixCommentTargetRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const { kind, id } = item as { kind?: unknown; id?: unknown };
    if (typeof kind !== 'string' || !KINDS.includes(kind as AiFixCommentKind)) continue;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: kind as AiFixCommentKind, id });
    if (out.length >= MAX_COMMENT_TARGETS) break;
  }
  return out;
}

interface RcRow {
  id: number;
  githubNodeId: string;
  threadId: number;
  authorId: number | null;
  body: string | null;
  excerpt: string | null;
  diffHunk: string | null;
  databaseId: string | null;
  createdAt: Date | number | null;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
}

interface PrcRow {
  id: number;
  authorId: number | null;
  body: string | null;
  databaseId: string | null;
}

interface ReviewRow {
  id: number;
  authorId: number | null;
  body: string | null;
  databaseId: string | null;
  state: string;
}

/**
 * Resolve the client's (kind, id) pairs into everything the prompt and the stored report need.
 *
 * TENANCY. `review_comments` / `pr_comments` / `reviews` carry NO account_id — they reach their
 * account through `pr_id` — so every predicate here is `prId = <the caller's prId>`, and that prId
 * has ALREADY been ownership-checked by the route (getFixPrContext returns null for a foreign PR).
 * Nothing else about the client's ids is trusted: an id in another PR, another tenant, or no row
 * at all simply does not come back, and is DROPPED.
 *
 * Refs are assigned C1..Cn over the SURVIVORS, in the client's order, so the labels the prompt
 * uses are contiguous and the report can be rendered in list order.
 */
export async function resolveCommentTargets(
  ctx: AgentContext,
  args: {
    accountId: number;
    prId: number;
    owner: string;
    name: string;
    prNumber: number;
    refs: AiFixCommentTargetRef[];
  },
): Promise<ResolvedCommentTarget[]> {
  const refs = args.refs.slice(0, MAX_COMMENT_TARGETS);
  if (refs.length === 0) return [];

  const rcIds = refs.filter((r) => r.kind === 'review_comment').map((r) => r.id);
  const prcIds = refs.filter((r) => r.kind === 'pr_comment').map((r) => r.id);
  const rvIds = refs.filter((r) => r.kind === 'review').map((r) => r.id);

  const rcById = new Map<number, RcRow>();
  const threadRootId = new Map<number, number>(); // threadId → its OPENING comment's id
  if (rcIds.length > 0) {
    const rc = ctx.schema.reviewComments;
    const th = ctx.schema.reviewThreads;
    const rows = (await ctx.db
      .select({
        id: rc.id,
        githubNodeId: rc.githubNodeId,
        threadId: rc.threadId,
        authorId: rc.authorId,
        body: rc.body,
        excerpt: rc.excerpt,
        diffHunk: rc.diffHunk,
        databaseId: rc.databaseId,
        createdAt: rc.createdAt,
        path: th.path,
        line: th.line,
        isResolved: th.isResolved,
        isOutdated: th.isOutdated,
      })
      .from(rc)
      .innerJoin(th, eq(rc.threadId, th.id))
      .where(and(eq(rc.prId, args.prId), inArray(rc.id, rcIds)))
      .execute()) as RcRow[];
    for (const r of rows) rcById.set(r.id, r);

    // "Is this a REPLY?" — the opening comment of a thread is the oldest one in it, so it takes a
    // second (body-less, therefore cheap) pass over the involved threads. Worth the query: a
    // reply and the comment that started the thread read very differently to a model deciding
    // whether the concern is still live.
    const threadIds = [...new Set(rows.map((r) => r.threadId))];
    if (threadIds.length > 0) {
      const siblings = (await ctx.db
        .select({ id: rc.id, threadId: rc.threadId, createdAt: rc.createdAt })
        .from(rc)
        .where(and(eq(rc.prId, args.prId), inArray(rc.threadId, threadIds)))
        .execute()) as Array<{ id: number; threadId: number; createdAt: Date | number | null }>;
      const bestAt = new Map<number, number>();
      for (const s of siblings) {
        const at = asMs(s.createdAt);
        const prevAt = bestAt.get(s.threadId);
        const prevId = threadRootId.get(s.threadId);
        // Tie-break on the id so the answer can't flip between requests on two comments that
        // share a timestamp (rows come back in heap order).
        if (prevAt == null || at < prevAt || (at === prevAt && prevId != null && s.id < prevId)) {
          bestAt.set(s.threadId, at);
          threadRootId.set(s.threadId, s.id);
        }
      }
    }
  }

  const prcById = new Map<number, PrcRow>();
  if (prcIds.length > 0) {
    const prc = ctx.schema.prComments;
    const rows = (await ctx.db
      .select({
        id: prc.id,
        authorId: prc.authorId,
        body: prc.body,
        databaseId: prc.databaseId,
      })
      .from(prc)
      .where(and(eq(prc.prId, args.prId), inArray(prc.id, prcIds)))
      .execute()) as PrcRow[];
    for (const r of rows) prcById.set(r.id, r);
  }

  const rvById = new Map<number, ReviewRow>();
  if (rvIds.length > 0) {
    const rv = ctx.schema.reviews;
    const rows = (await ctx.db
      .select({
        id: rv.id,
        authorId: rv.authorId,
        body: rv.body,
        databaseId: rv.databaseId,
        state: rv.state,
      })
      .from(rv)
      .where(and(eq(rv.prId, args.prId), inArray(rv.id, rvIds)))
      .execute()) as ReviewRow[];
    for (const r of rows) rvById.set(r.id, r);
  }

  // Authors: login + the GLOBAL `users.isBot`. Deliberately NOT the UI's union rule (isBot ∪ the
  // workspace's automated reviewers, with a manual "human" judgement winning both directions):
  // that set is module-private in core's query layer and is not on ProHostQueries, so
  // reimplementing it here would fork a documented core invariant. `isBot` is a hint in the
  // prompt ("a bot's comment can be wrong"), never a gate — nothing depends on it being the
  // authoritative classification.
  const authorIds = [
    ...new Set(
      [...rcById.values(), ...prcById.values(), ...rvById.values()]
        .map((r) => r.authorId)
        .filter((x): x is number => x != null),
    ),
  ];
  const userById = new Map<number, { login: string; isBot: boolean }>();
  if (authorIds.length > 0) {
    const u = ctx.schema.users;
    const rows = (await ctx.db
      .select({ id: u.id, githubLogin: u.githubLogin, isBot: u.isBot })
      .from(u)
      .where(inArray(u.id, authorIds))
      .execute()) as Array<{ id: number; githubLogin: string; isBot: boolean }>;
    for (const r of rows) userById.set(r.id, { login: r.githubLogin, isBot: !!r.isBot });
  }

  // ANCHOR HUNKS. `review_comments.diff_hunk` is NULL for ~97% of rows under lean storage, so
  // without this the prompt shows no code at all and the agent can only guess. ONE call covers the
  // WHOLE PR (never per comment), it is skipped entirely when no review comment is in the basket,
  // and it never throws — `ok:false` just means we fall back to the stored column.
  //
  // ⚠ Unlike the annotations platform, AI Fix has NO payload-hash cache, so the hash trap
  // documented on that seam does not apply here. Do not invent one: the hunk is prompt context.
  const hunkByNodeId = new Map<string, string>();
  if (rcById.size > 0 && args.owner !== '' && args.name !== '') {
    if (typeof ctx.github?.fetchReviewCommentHunks === 'function') {
      try {
        const res = await ctx.github.fetchReviewCommentHunks(args.accountId, {
          owner: args.owner,
          name: args.name,
          prNumber: args.prNumber,
          maxHunkChars: HUNK_CHAR_LIMIT * 2,
        });
        if (res.ok) for (const [k, v] of res.hunkByNodeId) hunkByNodeId.set(k, v);
      } catch (err) {
        // The seam's contract is "never throws"; a violation must still not cost the run.
        ctx.log.warn({ err, prId: args.prId }, 'ai-fix comment seed: hunk hydration threw');
      }
    }
  }

  const prUrl = `https://github.com/${args.owner}/${args.name}/pull/${args.prNumber}`;
  const out: ResolvedCommentTarget[] = [];
  for (const ref of refs) {
    const author = (id: number | null): { login: string | null; isBot: boolean } => {
      const u = id == null ? undefined : userById.get(id);
      return { login: u?.login ?? null, isBot: u?.isBot ?? false };
    };
    // Bodies are ALWAYS persisted for comments/reviews now, but rows written during the 2026-06
    // lean window can still be NULL — fall back to the excerpt, and drop a target with no text at
    // all (there is nothing to assess, and an empty block invites the agent to invent one).
    const push = (t: ResolvedCommentTarget | null): void => {
      if (t != null && t.body !== '') out.push(t);
    };

    if (ref.kind === 'review_comment') {
      const r = rcById.get(ref.id);
      if (!r) continue;
      const a = author(r.authorId);
      const body = clamp((r.body ?? r.excerpt ?? '').trim(), BODY_CHAR_LIMIT, '…(comment truncated)');
      const rawHunk = hunkByNodeId.get(r.githubNodeId) ?? r.diffHunk;
      push({
        wire: {
          kind: 'review_comment',
          id: r.id,
          ref: '', // assigned below, over the survivors
          authorId: r.authorId,
          authorLogin: a.login,
          isBot: a.isBot,
          path: r.path,
          line: r.line,
          threadId: r.threadId,
          url: r.databaseId ? `${prUrl}#discussion_r${r.databaseId}` : null,
          excerpt: excerptOf(r.excerpt, body),
        },
        body,
        hunk:
          rawHunk == null || rawHunk.trim() === ''
            ? null
            : clamp(rawHunk, HUNK_CHAR_LIMIT, '…(hunk truncated)'),
        isReply: threadRootId.get(r.threadId) !== r.id,
        isResolvedThread: !!r.isResolved,
        isOutdatedThread: !!r.isOutdated,
        threadPath: r.path,
      });
    } else if (ref.kind === 'pr_comment') {
      const r = prcById.get(ref.id);
      if (!r) continue;
      const a = author(r.authorId);
      const body = clamp((r.body ?? '').trim(), BODY_CHAR_LIMIT, '…(comment truncated)');
      push({
        wire: {
          kind: 'pr_comment',
          id: r.id,
          ref: '',
          authorId: r.authorId,
          authorLogin: a.login,
          isBot: a.isBot,
          path: null,
          line: null,
          threadId: null,
          url: r.databaseId ? `${prUrl}#issuecomment-${r.databaseId}` : null,
          excerpt: excerptOf(null, body),
        },
        body,
        hunk: null,
        isReply: false,
        isResolvedThread: false,
        isOutdatedThread: false,
        threadPath: null,
      });
    } else {
      const r = rvById.get(ref.id);
      if (!r) continue;
      const a = author(r.authorId);
      const body = clamp((r.body ?? '').trim(), BODY_CHAR_LIMIT, '…(comment truncated)');
      push({
        wire: {
          kind: 'review',
          id: r.id,
          ref: '',
          authorId: r.authorId,
          authorLogin: a.login,
          isBot: a.isBot,
          path: null,
          line: null,
          threadId: null,
          url: r.databaseId ? `${prUrl}#pullrequestreview-${r.databaseId}` : null,
          excerpt: excerptOf(null, body),
        },
        body,
        hunk: null,
        isReply: false,
        isResolvedThread: false,
        isOutdatedThread: false,
        threadPath: null,
      });
    }
  }

  // Refs last, over the survivors, so they are contiguous C1..Cn even when ids were dropped.
  return out.map((t, i) => ({ ...t, wire: { ...t.wire, ref: `C${i + 1}` } }));
}

const EXCERPT_CHARS = 200;
function excerptOf(stored: string | null, body: string): string {
  const s = (stored ?? body).replace(/\s+/g, ' ').trim();
  return s.length <= EXCERPT_CHARS ? s : `${s.slice(0, EXCERPT_CHARS)}…`;
}

/**
 * The rendered seed plus the refs that did not fit in it. Two fields rather than a bare string so
 * the "we withheld it" case is carried in data instead of only in prose the model was shown.
 */
export interface CommentSeed {
  text: string;
  /** Refs present in `targets` but NOT rendered into `text` (over the char budget). */
  droppedRefs: string[];
}

/**
 * Render the seed: one numbered, fenced block per target, in prompt order.
 *
 * Every body in here is UNTRUSTED, attacker-authored text, so each one is wrapped in an explicit
 * ---BEGIN/---END marker (the annotations platform's convention) and the system prompt names those
 * markers as data. Metadata the model needs to judge the comment sits OUTSIDE the body fence.
 *
 * Over `SEED_CHAR_BUDGET` the tail is DROPPED AND NAMED — silently truncating mid-list would leave
 * the agent reporting on text it never received.
 *
 * ⚠ The dropped refs are RETURNED, not just named in the prose, because the report has to tell two
 * different facts apart: "the agent was shown this and said nothing about it" (a failure of the
 * run) and "this never made it into the prompt" (a budget decision of ours). Both end up
 * `needs_human`, but blaming the agent for a comment we withheld is a lie the reader cannot
 * detect. `mapCommentVerdicts` takes these refs for exactly that reason.
 */
export function buildCommentSeedText(targets: ResolvedCommentTarget[]): CommentSeed {
  const blocks: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const t of targets) {
    const block = renderTarget(t);
    if (blocks.length > 0 && used + block.length > SEED_CHAR_BUDGET) {
      dropped.push(t.wire.ref);
      continue;
    }
    blocks.push(block);
    used += block.length;
  }

  const head =
    blocks.length === 1
      ? 'The reviewer comment below was selected for you to work through.'
      : `The ${blocks.length} reviewer comments below were selected for you to work through, IN THIS ORDER.`;
  // Blank-line separated: the per-comment markers already delimit the blocks for a parser, but a
  // wall of adjacent ---END/---BEGIN pairs is what makes a model lose its place in a 25-item list.
  const out = [head, '', blocks.join('\n\n')];
  if (dropped.length > 0) {
    out.push(
      '',
      `NOTE: ${dropped.length} further selected comment(s) (${dropped.join(', ')}) are NOT included above — the combined comment text exceeded the prompt budget. Do not attempt to fix or report on them; they will be reported as needing a human.`,
    );
  }
  return { text: out.join('\n'), droppedRefs: dropped };
}

function renderTarget(t: ResolvedCommentTarget): string {
  const w = t.wire;
  const meta: string[] = [];
  meta.push(`ref: ${w.ref}`);
  meta.push(
    `written by: ${w.authorLogin ?? 'someone'} (${w.isBot ? 'BOT — its comments can be wrong, stale, or about code that is no longer here' : 'human'})`,
  );
  meta.push(
    w.kind === 'review_comment'
      ? `anchored at: ${w.path ?? '(unknown file)'}${w.line != null ? `:${w.line}` : ''}`
      : w.kind === 'pr_comment'
        ? 'anchored at: nothing — this is a PR-level comment, not tied to a line'
        : 'anchored at: nothing — this is a review body, not tied to a line',
  );
  if (t.isReply) {
    meta.push('position: a REPLY inside the thread, not the comment that opened it');
  }
  const state: string[] = [];
  if (t.isResolvedThread) state.push('RESOLVED — someone has already CLAIMED this was handled');
  if (t.isOutdatedThread) state.push('OUTDATED — the code it was written against has since changed');
  if (state.length > 0) meta.push(`thread state: ${state.join('; ')}`);
  if (t.hunk != null) {
    meta.push('the code this comment was written against:', '```diff', t.hunk, '```');
  }
  meta.push(`---BEGIN COMMENT TEXT ${w.ref}---`, t.body, `---END COMMENT TEXT ${w.ref}---`);
  return [`---BEGIN COMMENT ${w.ref}---`, ...meta, `---END COMMENT ${w.ref}---`].join('\n');
}

/**
 * Map the agent's self-reported per-ref dispositions back onto the comments it was given.
 *
 * THREE CASES, and the last two are why this function exists rather than a `Map` lookup:
 *   • matched — the normal path. Refs are matched TRIMMED and CASE-INSENSITIVELY, and with a
 *     trailing-punctuation fallback, because an agent writes "c3", " C3 " and "C3." for the same
 *     thing and losing a real verdict to formatting would be indistinguishable from silence.
 *   • fabricated — a ref that was never in the seed set is KEPT with `target: null`. It is
 *     information about the run (the agent invented a comment), not noise to discard.
 *   • unreported — a target the agent never mentioned gets a synthesized `needs_human` row. A
 *     silently missing comment is exactly the failure mode this report exists to prevent: the
 *     user dragged it into the basket and is entitled to an answer, even if the answer is "the
 *     agent didn't give one".
 *
 * ⚠ `droppedRefs` (from `buildCommentSeedText`) splits that last case in two, and the distinction
 * is ours to own rather than the reader's to guess: a target we cut for prompt budget was never
 * shown to the agent, so saying "the fixer did not report on this" would blame it for our decision.
 * Both are `needs_human`; only the sentence differs.
 *
 * Returns null (not []) only when there was nothing to report on at all — no raw report AND no
 * targets — so a caller can tell "not a comments run" from "a comments run with no verdicts".
 */
export function mapCommentVerdicts(
  targets: ResolvedCommentTarget[],
  raw: FixItemVerdict[] | undefined,
  droppedRefs: readonly string[] = [],
): AiFixCommentVerdict[] | null {
  if (raw === undefined && targets.length === 0) return null;
  const rows = Array.isArray(raw) ? raw : [];

  const byNorm = new Map<string, ResolvedCommentTarget>();
  for (const t of targets) byNorm.set(normRef(t.wire.ref), t);
  // Normalised, so a caller passing back the refs verbatim matches regardless of formatting.
  const dropped = new Set(droppedRefs.map(normRef));

  const out: AiFixCommentVerdict[] = [];
  const matchedByTarget = new Map<string, AiFixCommentVerdict[]>();
  const unmatched: AiFixCommentVerdict[] = [];

  for (const r of rows) {
    const ref = typeof r?.ref === 'string' ? r.ref.trim() : '';
    const t = byNorm.get(normRef(ref));
    const v: AiFixCommentVerdict = {
      ref: ref === '' ? '(no ref)' : ref,
      target: t ? t.wire : null,
      verdict: DISPOSITIONS.includes(r?.verdict) ? r.verdict : 'needs_human',
      // The agent's tool schema requires a boolean here, so anything else means it did not
      // actually answer — which is `null` (not assessed), never `false` (judged wrong).
      valid: typeof r?.valid === 'boolean' ? r.valid : null,
      reasoning: cap(r?.reasoning, 4_000),
      pushback: nullable(r?.pushback, 8_000),
      learning: nullable(r?.learning, 2_000),
      filesTouched: Array.isArray(r?.filesTouched)
        ? r.filesTouched
            .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
            .slice(0, 50)
            .map((p) => cap(p, 400))
        : [],
    };
    if (t) {
      const key = normRef(t.wire.ref);
      matchedByTarget.set(key, [...(matchedByTarget.get(key) ?? []), v]);
    } else {
      unmatched.push(v);
    }
  }

  // Target order first, so the report renders alongside the list the user built.
  for (const t of targets) {
    const matched = matchedByTarget.get(normRef(t.wire.ref));
    if (matched && matched.length > 0) {
      out.push(...matched);
      continue;
    }
    out.push({
      ref: t.wire.ref,
      target: t.wire,
      verdict: 'needs_human',
      // NOT ASSESSED — not "judged invalid". This row exists because nobody looked at the
      // comment, so `false` here would render as a positive claim that a reviewer was wrong,
      // directly above prose saying nothing is known. Hence the tri-state on the wire.
      valid: null,
      reasoning: dropped.has(normRef(t.wire.ref))
        ? 'This comment did not fit the prompt budget, so the fixer was never shown it — nothing was attempted and nothing is known about it. Run a fix with a smaller scope to include it.'
        : 'The fixer did not report on this comment, so nothing here is known about it — neither whether it is valid nor whether anything was changed for it. Review it by hand.',
      pushback: null,
      learning: null,
      filesTouched: [],
    });
  }
  out.push(...unmatched);
  return out;
}

/** `" C3. "` → `c3`. Punctuation and case are formatting, not identity. */
function normRef(ref: string): string {
  const s = ref.trim().toLowerCase();
  const compact = s.replace(/[^a-z0-9]/g, '');
  if (compact !== '') return compact;
  return s;
}

function cap(s: unknown, n: number): string {
  const v = typeof s === 'string' ? s.trim() : '';
  return v.length <= n ? v : `${v.slice(0, n)}…`;
}

function nullable(s: unknown, n: number): string | null {
  const v = cap(s, n);
  return v === '' ? null : v;
}
