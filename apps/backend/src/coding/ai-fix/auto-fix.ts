// AUTO FIX — after an AUTO Claude review succeeds on the reader's OWN pull request, start ONE
// review-seeded AI Fix (CORE, free, local-only, like the rest of the agentic surface).
//
// THE GATE, in order (the first that fails decides; every skip is logged and kept in memory for the
// Claude Review tab's one line, `autoFixOutcomeFor`):
//   0. the PR's author IS the account's own GitHub user (pull_requests.author_id → users.github_login
//      vs accounts.github_login, case-insensitive). Anyone else's PR: nothing happens and nothing is
//      recorded — fixing someone else's branch is never automatic;
//   1. `nothing_to_fix`  — the review's seed is empty (the same refusal as the button's NothingToFix);
//   2. `head_moved`      — the PR's synced head is no longer the reviewed one (the next review decides);
//   3. `fix_in_progress` — a fix for this PR (auto or manual) is queued or running;
//   4. `fix_waiting`     — a finished fix with changes, never pushed, sits on the PR's CURRENT head
//                          (the synced head, the REVIEWED head, or — only when an unpushed fix sits
//                          on neither — the LIVE head, so a lagging sync cannot hide one);
//   5. `cap`             — AUTO_FIX_DAILY_CAP auto fixes already started on this PR in the last 24h;
//   6. `already_tried`   — the latest auto fix AT THIS HEAD reported every item this review would
//                          send as not addressed (nobody has pushed since, so nothing changed).
// Then `startReviewFix(…, trigger: 'auto')` — the same queue, slot and worktree as the button.
//
// ⚠ NOTHING IS PUSHED. A fix waits for a person's Push like any other.
// ⚠ LOOP SAFETY. A pushed fix makes a new head, which earns an auto re-review, which may earn
// another fix. The chain needs a PERSON pressing Push at every turn (an unpushed fix blocks the next
// one, rule 4), and is bounded anyway by rule 5. Rule 6 stops the one loop that needs no push: a
// fix that changed nothing, re-tried at the same head on every comment-triggered review. Item
// identity across reviews is (kind, thread / story index, path, title) — a finding re-worded by a
// later review counts as new, so rule 6 can miss it; rule 5 still bounds it.
// ⚠ Never throws: an auto fix failing must never touch the review.
import { and, desc, eq, gte } from 'drizzle-orm';
import {
  AUTO_FIX_DAILY_CAP,
  CLAUDE_REVIEW_MODELS,
  DEFAULT_AI_FIX_MODEL,
  type AiFixModel,
  type AiFixReviewItem,
  type ClaudeAutoFixOutcome,
  type ClaudeAutoFixSkipReason,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { isFixRunning, loadReviewSeed, startReviewFix } from './manager.js';
import { parseChangeReport, parseReviewItems } from './persist.js';
import { getFixPrContext } from './pr-context.js';

// At most AUTO_FIX_DAILY_CAP (shared) AUTO fixes per PR in any rolling AUTO_FIX_WINDOW_MS.
export { AUTO_FIX_DAILY_CAP };
export const AUTO_FIX_WINDOW_MS = 24 * 60 * 60 * 1000;

// reviewId → the outcome, with its owner. Bounded: the oldest entry goes first.
const OUTCOMES_MAX = 500;
const outcomes = new Map<number, { accountId: number; outcome: ClaudeAutoFixOutcome }>();

function record(accountId: number, outcome: ClaudeAutoFixOutcome): void {
  outcomes.delete(outcome.reviewId);
  outcomes.set(outcome.reviewId, { accountId, outcome });
  while (outcomes.size > OUTCOMES_MAX) {
    const first = outcomes.keys().next().value;
    if (first === undefined) break;
    outcomes.delete(first);
  }
}

/** The recorded auto-fix outcome of one review, for its owner only. */
export function autoFixOutcomeFor(reviewId: number, accountId: number): ClaudeAutoFixOutcome | null {
  const o = outcomes.get(reviewId);
  return o && o.accountId === accountId ? o.outcome : null;
}

/** Test hook. */
export function _resetAutoFixForTest(): void {
  outcomes.clear();
}

/** Is the PR's author the account's own GitHub user? Unknown on either side ⇒ false. */
export async function prAuthorIsAccount(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<boolean> {
  const { pullRequests: prs, users, accounts } = ctx.schema;
  const [author, account] = await Promise.all([
    ctx.db
      .select({ login: users.githubLogin })
      .from(prs)
      .innerJoin(users, eq(users.id, prs.authorId))
      .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
      .limit(1)
      .execute() as Promise<Array<{ login: string | null }>>,
    ctx.db
      .select({ login: accounts.githubLogin })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1)
      .execute() as Promise<Array<{ login: string | null }>>,
  ]);
  const a = author[0]?.login;
  const b = account[0]?.login;
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** One review item's identity ACROSS reviews (refs and finding ids are per review). */
export function autoFixItemKey(i: AiFixReviewItem): string {
  const kind = i.kind === 'earlier_finding' ? 'finding' : i.kind;
  return [
    kind,
    i.threadId ?? '',
    i.ticketIndex ?? '',
    i.path ?? '',
    i.title.trim().replace(/\s+/g, ' ').toLowerCase(),
  ].join('|');
}

interface FixRow {
  id: number;
  status: string;
  baseSha: string;
  patch: string | null;
  pushedAt: unknown;
  trigger: string | null;
  createdAt: Date | number | null;
  reviewItems: string | null;
  changeReport: string | null;
}

const toMs = (v: Date | number | null): number =>
  v == null ? 0 : v instanceof Date ? v.getTime() : Number(v) * (Number(v) < 1e12 ? 1000 : 1);

export interface AutoFixDeps {
  startReviewFix: typeof startReviewFix;
  loadReviewSeed: typeof loadReviewSeed;
  isFixRunning: typeof isFixRunning;
  /** The PR's head on GitHub right now; null when unknown. Absent ⇒ never asked. */
  liveHeadSha?: (ctx: AgentContext, accountId: number, prId: number) => Promise<string | null>;
}

/** One `GET /pulls/{n}`. Never throws (a failed read is "unknown", never "no fix waiting"). */
async function liveHeadSha(ctx: AgentContext, accountId: number, prId: number): Promise<string | null> {
  try {
    const pr = await getFixPrContext(ctx, accountId, prId);
    if (!pr) return null;
    return (await ctx.github.fetchPrHeadInfo(accountId, pr.owner, pr.name, pr.number)).headSha ?? null;
  } catch {
    return null;
  }
}

const defaultDeps: AutoFixDeps = { startReviewFix, loadReviewSeed, isFixRunning, liveHeadSha };

export type AutoFixDecision = { status: 'not_own' } | ClaudeAutoFixOutcome;

/**
 * Called once per SUCCEEDED auto review (manager.ts). Returns what it did; never throws.
 */
export async function maybeStartAutoFix(
  ctx: AgentContext,
  input: { accountId: number; prId: number; reviewId: number },
  deps: AutoFixDeps = defaultDeps,
  nowMs: number = Date.now(),
): Promise<AutoFixDecision> {
  const { accountId, prId, reviewId } = input;
  const skip = (reason: ClaudeAutoFixSkipReason): AutoFixDecision => {
    const outcome: ClaudeAutoFixOutcome = { reviewId, status: 'skipped', reason };
    record(accountId, outcome);
    ctx.log.info(`auto fix pr ${prId} (review ${reviewId}) skipped: ${reason}`);
    return outcome;
  };
  try {
    if (!(await prAuthorIsAccount(ctx, accountId, prId))) return { status: 'not_own' };

    const loaded = await deps.loadReviewSeed(ctx, { accountId, prId, reviewId });
    if (!loaded) return skip('not_started');
    if (loaded.seed.sentRefs.length === 0) return skip('nothing_to_fix');

    const { pullRequests: prs, aiFixes: af } = ctx.schema;
    const prRow = (
      (await ctx.db
        .select({ headSha: prs.headSha })
        .from(prs)
        .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
        .limit(1)
        .execute()) as Array<{ headSha: string | null }>
    )[0];
    const head = prRow?.headSha ?? null;
    if (head && head !== loaded.review.headSha) return skip('head_moved');

    // The manager's in-memory claim is the authority (a queued/running ROW it no longer holds is an
    // orphan the next boot reconciles).
    if (deps.isFixRunning(prId)) return skip('fix_in_progress');

    const fixes = (await ctx.db
      .select({
        id: af.id,
        status: af.status,
        baseSha: af.baseSha,
        patch: af.patch,
        pushedAt: af.pushedAt,
        trigger: af.trigger,
        createdAt: af.createdAt,
        reviewItems: af.reviewItems,
        changeReport: af.changeReport,
      })
      .from(af)
      .where(and(eq(af.accountId, accountId), eq(af.prId, prId)))
      .orderBy(desc(af.id))
      .execute()) as FixRow[];

    // "Nobody has pushed since": the fix was built on the head the PR still has. The SYNCED head
    // can lag (or be unsynced) while the fixer builds on the LIVE head, so the reviewed head counts
    // too, and the live head is asked for — once, only when an unpushed fix sits on neither.
    const heads = new Set<string>();
    if (head) heads.add(head);
    if (loaded.review.headSha) heads.add(loaded.review.headSha);
    const atHead = (f: FixRow): boolean => heads.has(f.baseSha);
    const waiting = fixes.filter(
      (f) => f.status === 'succeeded' && f.pushedAt == null && (f.patch ?? '').trim() !== '',
    );
    if (waiting.length > 0 && !waiting.some(atHead) && deps.liveHeadSha) {
      const live = await deps.liveHeadSha(ctx, accountId, prId);
      if (live) heads.add(live);
    }
    if (waiting.some(atHead)) return skip('fix_waiting');

    const since = nowMs - AUTO_FIX_WINDOW_MS;
    const recentAuto = fixes.filter((f) => f.trigger === 'auto' && toMs(f.createdAt) >= since);
    if (recentAuto.length >= AUTO_FIX_DAILY_CAP) return skip('cap');

    // Rule 6: the latest auto fix at this head said "not addressed" to everything we would send.
    const lastAutoHere = fixes.find((f) => f.trigger === 'auto' && f.status === 'succeeded' && atHead(f));
    if (lastAutoHere) {
      const items = parseReviewItems(lastAutoHere.reviewItems) ?? [];
      const report = parseChangeReport(lastAutoHere.changeReport);
      const byRef = new Map(items.map((i) => [i.ref, i]));
      const refused = new Set(
        (report?.unaddressed ?? []).flatMap((u) => {
          const i = byRef.get(u.ref);
          return i ? [autoFixItemKey(i)] : [];
        }),
      );
      const sent = new Set(loaded.seed.sentRefs);
      const now = loaded.seed.items.filter((i) => sent.has(i.ref)).map(autoFixItemKey);
      if (now.length > 0 && now.every((k) => refused.has(k))) return skip('already_tried');
    }

    const model: AiFixModel = (CLAUDE_REVIEW_MODELS as readonly string[]).includes(loaded.review.model)
      ? (loaded.review.model as AiFixModel)
      : DEFAULT_AI_FIX_MODEL;
    const r = await deps.startReviewFix(ctx, { accountId, prId, reviewId, model, trigger: 'auto' });
    if (r.status === 'queued') {
      const outcome: ClaudeAutoFixOutcome = { reviewId, status: 'started', fixId: r.fixId };
      record(accountId, outcome);
      ctx.log.info(`auto fix pr ${prId} (review ${reviewId}) started: fix ${r.fixId}`);
      return outcome;
    }
    if (r.status === 'nothing_to_fix') return skip('nothing_to_fix');
    if (r.status === 'already_running') return skip('fix_in_progress');
    ctx.log.info(`auto fix pr ${prId} (review ${reviewId}) not started: ${r.status}`);
    return skip('not_started');
  } catch (err) {
    ctx.log.warn(
      `auto fix pr ${prId} (review ${reviewId}) failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
    return skip('not_started');
  }
}
