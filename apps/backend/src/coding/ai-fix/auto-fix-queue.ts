// THE AUTO FIX QUEUE (docs/CLAUDE-REVIEW.md § AI Fix → The auto fix queue; wire + words: shared
// auto-fix-queue.ts). ONE decision per PR, made again whenever the PR's work may have changed:
//
//   • an AUTO AI review succeeded (claude-review/manager.ts)   • a CI review succeeded (ci-review/manager.ts)
//   • a fix's session closed, or its automatic push ended (sandbox/session/fix.ts, auto-push.ts)
//   • THE SWEEP, once a minute (`registerAutoFixQueue`): the PULL that catches what an event missed and
//     ends each bounded wait. A restart loses only the in-memory waits' clocks (they start again).
//
// THE RULE, on the reader's OWN open, non-draft PR in a workspace with auto AI Fix on (else nothing):
//   1. A FIX RUNS on the PR ⇒ `fix_running`. The next decision is made when it closes, at THE PR'S
//      CURRENT HEAD — what it fixed (and pushed) is no longer sent: the queue's re-validation.
//   2. THE HEAD'S CI JOBS STILL RUN (a live read, `fetchPrHeadCheckCounts`; the synced `ci_status` reads
//      FAILURE as soon as ONE job fails) ⇒ `ci_running`, at most AUTO_FIX_CI_WAIT_MAX_MS.
//   3. CI FAILED and the CI review of this head is running or due ⇒ `ci_review`, at most
//      AUTO_FIX_CI_REVIEW_WAIT_MS (its causes are what a CI fix works from).
//   4. THE SOURCE. A succeeded AUTO AI review of THIS head ⇒ a review fix (its seed carries the CI
//      causes too). Else CI causes at this head: an AI review of this head running or expected ⇒
//      `review_running` / `review_due`, at most AUTO_FIX_REVIEW_WAIT_MS after the CI was ready (one fix
//      covers both); then a CI-ONLY fix. Neither ⇒ `nothing_to_fix`.
//   5. `maybeStartAutoFix` (auto-fix.ts) — every gate of the auto fix (budget, sandbox, a fix waiting
//      for Push, the daily cap, already tried). A TRANSIENT refusal (sandbox busy, over budget, no
//      sandbox, a fix still holding the PR) is a wait the sweep retries; the rest end until the PR changes.
//
// Each fix is its own run, its own commit and (under "Push automatically") its own push.
// ⚠ Never throws. ⚠ Starts nothing on a PR that is not the reader's own (`prAuthorIsAccount`).
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  AUTO_FIX_CI_REVIEW_WAIT_MS,
  AUTO_FIX_CI_WAIT_MAX_MS,
  AUTO_FIX_QUEUE_LINE,
  AUTO_FIX_REVIEW_WAIT_MS,
  type AutoFixQueueReason,
  type AutoFixQueueState,
  type ClaudeAutoFixSkipReason,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import type { PrHeadCheckCounts } from '../../github/mutations.js';

export type AutoFixQueueCause = 'review' | 'ci_review' | 'fix_closed' | 'sweep';

/** What the queue reads besides the DB (tests replace them). */
export interface AutoFixQueueDeps {
  isOwn(ctx: AgentContext, accountId: number, prId: number): Promise<boolean>;
  settings(ctx: AgentContext, accountId: number, prId: number): Promise<{ workspaceId: number; enabled: boolean; ciFailures: boolean; autoReviewOn: boolean } | null>;
  fixRunning(prId: number): boolean;
  reviewHeld(prId: number): boolean;
  reviewWaiting(prId: number, accountId: number): boolean;
  ciReviewHeld(accountId: number, prId: number): boolean;
  liveChecks(ctx: AgentContext, accountId: number, pr: { owner: string; name: string; number: number }): Promise<PrHeadCheckCounts | null>;
  ciItemsAtHead(ctx: AgentContext, accountId: number, prId: number): Promise<number>;
  start(ctx: AgentContext, input: { accountId: number; prId: number; reviewId: number | null }): Promise<{ status: string; fixId?: number; reason?: ClaudeAutoFixSkipReason }>;
}

const defaultDeps: AutoFixQueueDeps = {
  isOwn: async (ctx, a, p) => (await import('./auto-fix.js')).prAuthorIsAccount(ctx, a, p),
  async settings(ctx, accountId, prId) {
    const { readWorkspaceAutoFixSettingsForPr } = await import('../../review/claude-review/auto-settings.js');
    const ws = await readWorkspaceAutoFixSettingsForPr(ctx, accountId, prId);
    if (!ws) return null;
    const { workspaces: w } = ctx.schema;
    const rows = (await ctx.db
      .select({ on: w.autoReviewEnabled })
      .from(w)
      .where(and(eq(w.id, ws.workspaceId), eq(w.accountId, accountId)))
      .limit(1)
      .execute()) as Array<{ on: boolean | null }>;
    return { workspaceId: ws.workspaceId, enabled: ws.enabled, ciFailures: ws.settings.include.ciFailures, autoReviewOn: rows[0]?.on === true };
  },
  fixRunning: (prId) => fixRunningNow(prId),
  reviewHeld: (prId) => reviewHeldNow(prId),
  reviewWaiting: (prId, accountId) => reviewWaitingNow(prId, accountId),
  ciReviewHeld: (a, p) => ciHeldNow(a, p),
  async liveChecks(_ctx, accountId, pr) {
    const [{ getAccessToken }, { fetchPrHeadCheckCounts }] = await Promise.all([import('../../auth/account.js'), import('../../github/mutations.js')]);
    const token = await getAccessToken(accountId).catch(() => null);
    return token ? fetchPrHeadCheckCounts(token, pr.owner, pr.name, pr.number) : null;
  },
  async ciItemsAtHead(ctx, accountId, prId) {
    const { getFixableCiItemsForPr } = await import('../../review/ci-review/persist.js');
    return (await getFixableCiItemsForPr(ctx, accountId, prId).catch(() => [])).length;
  },
  async start(ctx, input) {
    const { maybeStartAutoFix } = await import('./auto-fix.js');
    const d = await maybeStartAutoFix(ctx, input);
    if (d.status === 'started') return { status: 'started', fixId: d.fixId };
    if (d.status === 'skipped') return { status: 'skipped', reason: d.reason };
    return { status: d.status };
  },
};

// The in-process facts the managers hold. ⚠ REGISTERED BY THE MANAGERS when they load
// (`bindAutoFixQueueFacts`): the queue never imports a manager, which would make its fire-and-forget import
// chain wait on the managers' own (a fix's close then never reached its automatic push).
let fixRunningNow: (prId: number) => boolean = () => false;
let reviewHeldNow: (prId: number) => boolean = () => false;
let reviewWaitingNow: (prId: number, accountId: number) => boolean = () => false;
let ciHeldNow: (accountId: number, prId: number) => boolean = () => false;

export function bindAutoFixQueueFacts(f: {
  fixRunning?: (prId: number) => boolean;
  reviewHeld?: (prId: number) => boolean;
  reviewWaiting?: (prId: number, accountId: number) => boolean;
  ciReviewHeld?: (accountId: number, prId: number) => boolean;
}): void {
  if (f.fixRunning) fixRunningNow = f.fixRunning;
  if (f.reviewHeld) reviewHeldNow = f.reviewHeld;
  if (f.reviewWaiting) reviewWaitingNow = f.reviewWaiting;
  if (f.ciReviewHeld) ciHeldNow = f.ciReviewHeld;
}

// ---- the state (in memory; the sweep re-derives it) --------------------------------------------------------

interface Entry {
  state: AutoFixQueueState;
  /** The head the clocks below belong to. */
  head: string | null;
  /** When this head's CI was first seen still running / failed with no CI review / ready. */
  ciWaitFrom: number | null;
  ciReviewWaitFrom: number | null;
  readyAt: number | null;
  /** What the decision was made on; the sweep skips a PR whose facts did not change (and is not waiting). */
  sig: string;
}
const entries = new Map<string, Entry>();
const keyOf = (accountId: number, prId: number): string => `${accountId}:${prId}`;
const inFlight = new Set<string>();

/** The AI Review tab's line (shared `AutoFixQueueState`), for its owner; null when the queue has nothing. */
export function autoFixQueueFor(accountId: number, prId: number): AutoFixQueueState | null {
  return entries.get(keyOf(accountId, prId))?.state ?? null;
}

/** Test hook. */
export function _resetAutoFixQueueForTest(): void {
  entries.clear();
  inFlight.clear();
}

const TRANSIENT: ReadonlySet<AutoFixQueueReason> = new Set(['push_settling', 'sandbox_busy', 'over_budget', 'no_sandbox', 'fix_running', 'ci_running', 'ci_review', 'review_running', 'review_due']);
const SKIP_REASON: Partial<Record<ClaudeAutoFixSkipReason, AutoFixQueueReason>> = {
  fix_in_progress: 'fix_running',
  fix_waiting: 'fix_waiting',
  cap: 'cap',
  already_tried: 'already_tried',
  nothing_to_fix: 'nothing_to_fix',
  sandbox_busy: 'sandbox_busy',
  no_sandbox: 'no_sandbox',
  over_budget: 'over_budget',
  head_moved: 'review_due',
  not_started: 'not_started',
};

interface PrFacts {
  headSha: string | null;
  ciStatus: string | null;
  open: boolean;
  draft: boolean;
  owner: string;
  name: string;
  number: number;
}

async function prFacts(ctx: AgentContext, accountId: number, prId: number): Promise<PrFacts | null> {
  const { pullRequests: prs, repos } = ctx.schema;
  const rows = (await ctx.db
    .select({ headSha: prs.headSha, ciStatus: prs.ciStatus, state: prs.state, draft: prs.isDraft, number: prs.number, owner: repos.owner, name: repos.name })
    .from(prs)
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ headSha: string | null; ciStatus: string | null; state: string; draft: boolean | null; number: number; owner: string; name: string }>;
  const r = rows[0];
  if (!r) return null;
  return { headSha: r.headSha, ciStatus: r.ciStatus, open: r.state === 'open', draft: r.draft === true, owner: r.owner, name: r.name, number: r.number };
}

/** The newest FULL AI review of this head (any status), and whether a succeeded AUTO one exists. */
async function reviewAtHead(ctx: AgentContext, accountId: number, prId: number, head: string): Promise<{ anyId: number | null; autoSucceededId: number | null }> {
  const { claudeReviews: cr } = ctx.schema;
  const rows = (await ctx.db
    .select({ id: cr.id, status: cr.status, trigger: cr.trigger })
    .from(cr)
    .where(and(eq(cr.accountId, accountId), eq(cr.prId, prId), eq(cr.headSha, head), isNull(cr.kind)))
    .orderBy(desc(cr.id))
    .limit(10)
    .execute()) as Array<{ id: number; status: string; trigger: string }>;
  return { anyId: rows[0]?.id ?? null, autoSucceededId: rows.find((r) => r.status === 'succeeded' && r.trigger === 'auto')?.id ?? null };
}

/** The newest CI review of this head: its id and status ('none' when there is none). */
async function ciReviewAtHead(ctx: AgentContext, accountId: number, prId: number, head: string): Promise<{ id: number | null; status: string }> {
  const { ciReviews: c } = ctx.schema;
  const rows = (await ctx.db
    .select({ id: c.id, status: c.status })
    .from(c)
    .where(and(eq(c.accountId, accountId), eq(c.prId, prId), eq(c.headSha, head)))
    .orderBy(desc(c.id))
    .limit(1)
    .execute()) as Array<{ id: number; status: string }>;
  return rows[0] ? { id: rows[0].id, status: rows[0].status } : { id: null, status: 'none' };
}

async function latestFix(ctx: AgentContext, accountId: number, prId: number): Promise<{ sig: string; pushedFrom: string | null }> {
  const { aiFixes: af } = ctx.schema;
  const rows = (await ctx.db
    .select({ id: af.id, status: af.status, pushedAt: af.pushedAt, baseSha: af.baseSha })
    .from(af)
    .where(and(eq(af.accountId, accountId), eq(af.prId, prId)))
    .orderBy(desc(af.id))
    .limit(1)
    .execute()) as Array<{ id: number; status: string; pushedAt: unknown; baseSha: string }>;
  const r = rows[0];
  if (!r) return { sig: '-', pushedFrom: null };
  return { sig: `${r.id}:${r.status}:${r.pushedAt == null ? 0 : 1}`, pushedFrom: r.pushedAt != null ? r.baseSha : null };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

// THE FIX START QUEUE's place of a PR (registered by start-queue.ts's owner, the AI Fix manager, through the
// same binding as the other facts; null when it is not waiting).
let startPlace: (accountId: number, prId: number) => number | null = () => null;
export function bindAutoFixStartPlace(fn: (accountId: number, prId: number) => number | null): void {
  startPlace = fn;
}

/**
 * Decide for one PR now. Returns the state (also kept for the AI Review tab), or null when the queue has
 * nothing to say (not the reader's PR, auto fix off, closed or draft). Never throws.
 */
export async function evaluateAutoFix(
  ctx: AgentContext,
  input: { accountId: number; prId: number; cause: AutoFixQueueCause },
  deps: AutoFixQueueDeps = defaultDeps,
  nowMs: number = Date.now(),
): Promise<AutoFixQueueState | null> {
  const { accountId, prId } = input;
  const key = keyOf(accountId, prId);
  // One decision per PR at a time: a second trigger meanwhile is answered by the first's result (the sweep
  // decides again within the minute).
  if (inFlight.has(key)) return entries.get(key)?.state ?? null;
  inFlight.add(key);
  try {
    if (!(await deps.isOwn(ctx, accountId, prId))) {
      entries.delete(key);
      return null;
    }
    const ws = await deps.settings(ctx, accountId, prId);
    const pr = await prFacts(ctx, accountId, prId);
    if (!ws?.enabled || pr == null || !pr.open || pr.draft || pr.headSha == null) {
      entries.delete(key);
      return null;
    }
    const head = pr.headSha;
    const prev = entries.get(key);
    const e: Entry = prev && prev.head === head ? prev : { state: prev?.state as AutoFixQueueState, head, ciWaitFrom: null, ciReviewWaitFrom: null, readyAt: null, sig: '' };

    const [rev, ci, last] = await Promise.all([reviewAtHead(ctx, accountId, prId, head), ciReviewAtHead(ctx, accountId, prId, head), latestFix(ctx, accountId, prId)]);
    const fixSig = last.sig;
    const running = deps.fixRunning(prId);
    const sig = [head, pr.ciStatus ?? '', rev.anyId ?? '', rev.autoSucceededId ?? '', ci.id ?? '', ci.status, fixSig, running ? 1 : 0].join('|');

    // THE SWEEP'S ECONOMY: nothing changed and the last decision was final ⇒ keep it (no reads, no start).
    if (input.cause === 'sweep' && prev != null && prev.head === head && prev.sig === sig && prev.state.status !== 'waiting' && prev.state.reason !== 'not_started') {
      return prev.state;
    }

    const put = (status: AutoFixQueueState['status'], reason: AutoFixQueueReason | null, o: { until?: number | null; fixId?: number | null; source?: AutoFixQueueState['source']; line?: string } = {}): AutoFixQueueState => {
      const state: AutoFixQueueState = {
        prId,
        headSha: head,
        status,
        reason,
        line: o.line ?? (reason != null ? AUTO_FIX_QUEUE_LINE[reason] : 'Auto fix started. See the AI Fix tab.'),
        until: o.until != null ? iso(o.until) : null,
        fixId: o.fixId ?? null,
        source: o.source ?? null,
        at: iso(nowMs),
      };
      entries.set(key, { ...e, state, sig });
      return state;
    };
    const wait = (reason: AutoFixQueueReason, until: number | null): AutoFixQueueState => put('waiting', reason, { until });

    // 1. A fix runs: the next one waits for it (and is read again at the head it leaves).
    if (running) return wait('fix_running', null);
    // 1¼. Its start already waits in THE FIX START QUEUE (start-queue.ts) for a free sandbox: say where.
    const inLine = startPlace(accountId, prId);
    if (inLine != null) return put('waiting', 'sandbox_busy', { line: `Waiting for a free sandbox (${ordinal(inLine)} in line).` });
    // 1½. The last fix was PUSHED from this very head: the synced head has not caught up with the push yet.
    // Deciding now would read that head's review and CI causes again and fix them twice.
    if (last.pushedFrom === head) return wait('push_settling', null);

    // 2. The head's CI jobs, live (only when the synced rollup is not a final green / absent).
    const ciSynced = pr.ciStatus ?? '';
    if (ciSynced === 'pending' || ciSynced === 'expected' || ciSynced === 'failure' || ciSynced === 'error') {
      const live = await deps.liveChecks(ctx, accountId, pr);
      const stillRunning = live == null ? ciSynced === 'pending' || ciSynced === 'expected' : live.headSha != null && live.headSha !== head ? true : live.running > 0;
      if (stillRunning) {
        e.ciWaitFrom ??= nowMs;
        const until = e.ciWaitFrom + AUTO_FIX_CI_WAIT_MAX_MS;
        if (nowMs < until) return wait('ci_running', until);
      }
    }
    e.readyAt ??= nowMs;

    // 3. CI failed: wait for the CI review's causes.
    const red = ciSynced === 'failure' || ciSynced === 'error';
    if (red && ci.status !== 'succeeded' && ws.ciFailures && (deps.ciReviewHeld(accountId, prId) || (ci.status === 'none' && ws.autoReviewOn))) {
      e.ciReviewWaitFrom ??= nowMs;
      const until = e.ciReviewWaitFrom + AUTO_FIX_CI_REVIEW_WAIT_MS;
      if (nowMs < until) return wait('ci_review', until);
    }

    // 4. The source.
    let reviewId: number | null = rev.autoSucceededId;
    if (reviewId == null) {
      const ciItems = ws.ciFailures ? await deps.ciItemsAtHead(ctx, accountId, prId) : 0;
      const reviewRunning = deps.reviewHeld(prId);
      // An AI review of this head is coming: running, settling, or due (auto review on and none at this head).
      const reviewExpected = reviewRunning || deps.reviewWaiting(prId, accountId) || (ws.autoReviewOn && rev.anyId == null);
      if (reviewExpected) {
        const until = (e.readyAt ?? nowMs) + AUTO_FIX_REVIEW_WAIT_MS;
        // Nothing for CI to fix: the review alone decides, however long it takes (no limit shown).
        if (ciItems === 0) return wait(reviewRunning ? 'review_running' : 'review_due', null);
        if (nowMs < until) return wait(reviewRunning ? 'review_running' : 'review_due', until);
      }
      if (ciItems === 0) return put('idle', 'nothing_to_fix');
    }

    // 5. Start (every auto fix gate applies).
    const r = await deps.start(ctx, { accountId, prId, reviewId });
    const source = reviewId != null ? 'review' : 'ci';
    if (r.status === 'started') return put('started', null, { fixId: r.fixId ?? null, source });
    if (r.status === 'skipped' && r.reason != null) {
      const reason = SKIP_REASON[r.reason] ?? 'not_started';
      return TRANSIENT.has(reason) ? wait(reason, null) : put('idle', reason, { source });
    }
    return null;
  } catch (err) {
    ctx.log.warn(`auto fix queue pr ${prId}: ${err instanceof Error ? err.message : String(err)}`);
    return entries.get(key)?.state ?? null;
  } finally {
    inFlight.delete(key);
  }
}

/** Fire and forget (the managers' hooks): never throws, never awaited by a run. */
export function kickAutoFix(ctx: AgentContext, input: { accountId: number; prId: number; cause: AutoFixQueueCause }): void {
  void evaluateAutoFix(ctx, input).catch(() => {});
}

// ---- the sweep ------------------------------------------------------------------------------------------

/** Every account's own open, non-draft PRs in workspaces with auto AI Fix on. */
async function candidates(ctx: AgentContext): Promise<Array<{ accountId: number; prId: number }>> {
  const { workspaces: w, workspaceRepos: wr, pullRequests: prs, accounts, users } = ctx.schema;
  const { trueAuthorId } = await import('../../db/true-author.js');
  const rows = (await ctx.db
    .select({ accountId: prs.accountId, prId: prs.id, login: users.githubLogin, me: accounts.githubLogin })
    .from(prs)
    .innerJoin(wr, and(eq(wr.repoId, prs.repoId), eq(wr.accountId, prs.accountId)))
    .innerJoin(w, and(eq(w.id, wr.workspaceId), eq(w.accountId, prs.accountId)))
    .innerJoin(accounts, eq(accounts.id, prs.accountId))
    .innerJoin(users, eq(users.id, trueAuthorId(prs)))
    .where(and(eq(prs.state, 'open'), eq(prs.isDraft, false), eq(w.autoFixEnabled, true)))
    .execute()) as Array<{ accountId: number; prId: number; login: string | null; me: string | null }>;
  return rows.filter((r) => r.login != null && r.me != null && r.login.toLowerCase() === r.me.toLowerCase()).map(({ accountId, prId }) => ({ accountId, prId }));
}

let sweeping = false;

/** One pass over every candidate PR; PRs no longer candidates lose their line. */
export async function runAutoFixQueueSweep(ctx: AgentContext, nowMs: number = Date.now()): Promise<number> {
  if (sweeping) return 0;
  sweeping = true;
  try {
    // THE FIX START QUEUE: start what waits if a slot is free (a missed "slot freed" signal costs a minute).
    const sq = await import('./start-queue.js');
    sq.bindStartQueue({ ctx });
    sq.pumpStartQueue();
    const list = await candidates(ctx);
    const keep = new Set(list.map((c) => keyOf(c.accountId, c.prId)));
    for (const k of [...entries.keys()]) if (!keep.has(k)) entries.delete(k);
    for (const c of list) await evaluateAutoFix(ctx, { ...c, cause: 'sweep' }, defaultDeps, nowMs);
    return list.length;
  } catch (err) {
    ctx.log.warn(`auto fix queue sweep: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  } finally {
    sweeping = false;
  }
}

export const AUTO_FIX_SWEEP_MS = 60_000;

/** Boot: the sweep, every minute (unref'd). */
export function registerAutoFixQueue(ctx: AgentContext): void {
  const t = setInterval(() => void runAutoFixQueueSweep(ctx), AUTO_FIX_SWEEP_MS);
  t.unref?.();
}

/** PRs with a queue line, for the auto fixes toast (the account's, in these PR ids). */
export function autoFixQueueStates(accountId: number, prIds: readonly number[]): AutoFixQueueState[] {
  const ids = new Set(prIds);
  const out: AutoFixQueueState[] = [];
  for (const [k, v] of entries) if (k.startsWith(`${accountId}:`) && ids.has(v.state.prId)) out.push(v.state);
  return out;
}

