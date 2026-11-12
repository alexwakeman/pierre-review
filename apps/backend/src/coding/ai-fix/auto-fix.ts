// AUTO FIX — after an AUTO Claude review succeeds on the reader's OWN pull request, start ONE
// review-seeded AI Fix (CORE, free, local-only, like the rest of the agentic surface).
//
// THE GATE, in order (the first that fails decides; every skip is logged and kept in memory for the
// Claude Review tab's one line, `autoFixOutcomeFor`):
//   0. the PR's author IS the account's own GitHub user (pull_requests.author_id → users.github_login
//      vs accounts.github_login, case-insensitive). Anyone else's PR: nothing happens and nothing is
//      recorded — fixing someone else's branch is never automatic;
//   ½. `off`             — auto AI Fix is switched off for the workspace holding the PR's repo
//                          (`workspaces.auto_fix_enabled`, migration 0083 / pg 0070, Settings →
//                          Auto review). OFF by default (since 0084 / pg 0071): only a stored
//                          true is on, and a repo with no membership row reads OFF;
//   ¾. `no_sandbox`      — no container runtime on this computer: AI Fix runs ONLY as a sandboxed session
//                          (docs/SANDBOX.md § AI Fix sessions). Recorded, never queued; the next auto
//                          review asks again. `sandbox_busy` (every session taken, or another session
//                          is building) is the same, from the pre-check or from the start's own answer;
//   1. `nothing_to_fix`  — the review's seed is empty (the same refusal as the button's NothingToFix);
//   2. `head_moved`      — the PR's synced head is no longer the reviewed one (the next review decides);
//   3. `fix_in_progress` — a fix SESSION holds this PR (booting, building, a manual session open for
//                          follow-ups, or a Plan first waiting for Start fix — an auto fix would bury
//                          it), OR an older row's plan is still open (being made or waiting);
//   4. `fix_waiting`     — a finished fix with changes (or a valid merge), never pushed, sits on the PR's CURRENT head
//                          (the synced head, the REVIEWED head, or — only when an unpushed fix sits
//                          on neither — the LIVE head, so a lagging sync cannot hide one);
//   5. `cap`             — AUTO_FIX_DAILY_CAP auto fixes already started on this PR in the last 24h;
//   6. `already_tried`   — the latest auto fix AT THIS HEAD reported every item this review would
//                          send as not addressed (nobody has pushed since, so nothing changed).
// Then `startReviewFix(…, trigger: 'auto')` — the button's own start, as an UNATTENDED session: one
// build turn, then the session closes (the row stays resumable); the auto push follows the close.
// ⚠ AN AUTO FIX NEVER PLANS: plan mode is a person steering and approving, so only the manual
// "Plan first" route calls `startPlan`; `startReviewFix` always builds straight away.
//
// ⚠ WHAT IT CARRIES is the workspace's "Always include" sections (`workspaces.auto_fix_settings`,
// `resolveAutoFixSettings`; default every section but style-bot threads and merge conflicts) — the same
// sections as the manual fix picker, minus story items. The source review is the WHOLE Limn review:
// a Claude + Codex pair's two halves (`getReviewView`), and — when one half failed — what the other's
// cover pass found still open of the failed half's earlier findings (manager.ts `loadSourceReview`).
// ⚠ THE MERGE ITEM ("Resolve merge conflicts", `AutoFixInclude.conflicts`, OFF by default): with it on
// and the PR conflicting with its base, the unattended agent merges first (fix-merge.ts). The host's
// checks (two parents, no markers, fixes on top) still gate the push: an invalid merge pushes nothing,
// and "Push automatically" still decides whether a valid one is pushed or waits for the reader.
// ⚠ NOTHING IS PUSHED unless the workspace switched "Push automatically" on (`autoPush`, default
// OFF): then a SUCCEEDED auto fix is pushed onto the PR's existing branch by auto-push.ts (own PR
// only, never forced, a failure recorded and never retried). Otherwise it waits for a person's Push.
// ⚠ NO TICKET ITEMS, EVER. The seed here is the PR review's alone (`loadReviewSeed` without
// `withTicketItems`, and `startReviewFix` with trigger 'auto' does the same): whether a ticket's
// unmet criterion belongs in this PR is a person's call, made with the manual "Fix from review".
// ⚠ LOOP SAFETY. A pushed fix makes a new head, which earns an auto re-review, which may earn
// another fix. Without "Push automatically" the chain needs a PERSON pressing Push at every turn (an
// unpushed fix blocks the next one, rule 4); with it, rule 5 is the bound (≤ AUTO_FIX_DAILY_CAP per
// PR per 24h), plus the auto-review daily cap upstream. Rule 6 stops the one loop that needs no push: a
// fix that changed nothing, re-tried at the same head on every comment-triggered review. Item
// identity across reviews is (kind, thread / ticket index, path, title) — a finding re-worded by a
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
import type { loadCiOnlySeed, startFix } from './manager.js';
import { fixSandboxReadiness, type FixSandboxReadiness } from '../../sandbox/session/fix.js';
import { fixRowHasWork } from '../../sandbox/session/fix-merge.js';
import { parseChangeReport, parseReviewItems } from './persist.js';
import { getFixPrContext } from './pr-context.js';
import { readWorkspaceAutoFixSettingsForPr } from '../../review/claude-review/auto-settings.js';
import { automaticRunAllowed } from '../../review/budget-gate.js';
import { requestModelOf } from '../../ai/provider.js';
import { trueAuthorId } from '../../db/true-author.js';
import { automationAllowedForPr } from '../../db/external-repos.js';

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
      .innerJoin(users, eq(users.id, trueAuthorId(prs)))
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
  mergeJson?: unknown;
  mergeBundle?: string | null;
  pushedAt: unknown;
  trigger: string | null;
  createdAt: Date | number | null;
  reviewItems: string | null;
  changeReport: string | null;
  planStatus?: string | null;
}

const toMs = (v: Date | number | null): number =>
  v == null ? 0 : v instanceof Date ? v.getTime() : Number(v) * (Number(v) < 1e12 ? 1000 : 1);

export interface AutoFixDeps {
  startReviewFix: typeof startReviewFix;
  loadReviewSeed: typeof loadReviewSeed;
  /** THE CI-ONLY SOURCE (the auto fix queue: CI causes with no AI review of the head). Absent ⇒ the real one. */
  loadCiOnlySeed?: typeof loadCiOnlySeed;
  startFix?: typeof startFix;
  isFixRunning: typeof isFixRunning;
  /** The PR's head on GitHub right now; null when unknown. Absent ⇒ never asked. */
  liveHeadSha?: (ctx: AgentContext, accountId: number, prId: number) => Promise<string | null>;
  /** Could a sandboxed session start now (a runtime, a free session, the build slot)? Absent ⇒ never asked. */
  sandbox?: () => Promise<FixSandboxReadiness>;
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

// The CI-ONLY source's two calls, loaded when used (a test that mocks manager.js need not name them).
const lazyCiOnlySeed: typeof loadCiOnlySeed = async (...a) => (await import('./manager.js')).loadCiOnlySeed(...a);
const lazyStartFix: typeof startFix = async (...a) => (await import('./manager.js')).startFix(...a);

const defaultDeps: AutoFixDeps = { startReviewFix, loadReviewSeed, loadCiOnlySeed: lazyCiOnlySeed, startFix: lazyStartFix, isFixRunning, liveHeadSha, sandbox: fixSandboxReadiness };

// `not_auto`: the review was one a person started — an auto fix (which may then be pushed
// automatically) follows AUTO reviews only. The manager already calls this for auto runs alone;
// this re-reads the stored run so no other caller can start one off a manual review. Not recorded.
export type AutoFixDecision = { status: 'not_own' } | { status: 'not_auto' } | ClaudeAutoFixOutcome;

/**
 * Called by THE AUTO FIX QUEUE (auto-fix-queue.ts) when the PR's work is ready. Returns what it did;
 * never throws. `reviewId` null ⇒ THE CI-ONLY SOURCE: the CI review's causes at the PR's current head,
 * with no AI review (the same gates; the outcome is not kept per review).
 */
export async function maybeStartAutoFix(
  ctx: AgentContext,
  input: { accountId: number; prId: number; reviewId: number | null },
  deps: AutoFixDeps = defaultDeps,
  nowMs: number = Date.now(),
): Promise<AutoFixDecision> {
  const { accountId, prId, reviewId } = input;
  const skip = (reason: ClaudeAutoFixSkipReason): AutoFixDecision => {
    const outcome: ClaudeAutoFixOutcome = { reviewId: reviewId ?? 0, status: 'skipped', reason };
    if (reviewId != null) record(accountId, outcome);
    ctx.log.info(`auto fix pr ${prId} (review ${reviewId}) skipped: ${reason}`);
    return outcome;
  };
  try {
    if (!(await prAuthorIsAccount(ctx, accountId, prId))) return { status: 'not_own' };
    // EXTERNAL REPOS (db/external-repos.ts): no auto fix on an external repo's PR — read as off.
    if (!(await automationAllowedForPr(accountId, prId, ctx))) return skip('off');
    const ws = await readWorkspaceAutoFixSettingsForPr(ctx, accountId, prId);
    if (!ws?.enabled) return skip('off');
    // THE CLAUDE SPEND BUDGET (ai/budget.ts): over it, no auto fix — the next auto review decides again.
    if (!(await automaticRunAllowed(ctx, accountId, 'auto fix'))) return skip('over_budget');
    // THE SANDBOX, before the seed (which may wait on a SonarCloud read): no runtime, or no free slot.
    if (deps.sandbox) {
      const ready = await deps.sandbox();
      if (!ready.ok && ready.reason === 'no_runtime') return skip('no_sandbox');
      // Busy because THIS PR's own fix holds a session: say so. Busy otherwise: go on — the start waits in
      // THE FIX START QUEUE (start-queue.ts) and starts the moment a slot frees.
      if (!ready.ok && deps.isFixRunning(prId)) return skip('fix_in_progress');
    }
    // WHAT an auto fix carries is the workspace's "Always include" sections (AutoFixSettings).
    const include = ws.settings.include;

    const loaded =
      reviewId != null
        ? await deps.loadReviewSeed(ctx, { accountId, prId, reviewId, selection: { kind: 'sections', include } })
        : include.ciFailures
          ? { review: null, seed: await (deps.loadCiOnlySeed ?? lazyCiOnlySeed)(ctx, { accountId, prId, selection: { kind: 'sections', include } }) }
          : { review: null, seed: { items: [], sentRefs: [], text: '' } };
    if (!loaded) return skip('not_started');
    if (loaded.review != null && loaded.review.trigger !== 'auto') return { status: 'not_auto' };
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
    // A review seed is the REVIEWED head's; a CI-only seed is read at the synced head by construction.
    if (loaded.review != null && head && head !== loaded.review.headSha) return skip('head_moved');

    // The manager's in-memory claim is the authority (a queued/running ROW it no longer holds is an
    // orphan the next boot reconciles).
    if (deps.isFixRunning(prId)) return skip('fix_in_progress');

    const fixes = (await ctx.db
      .select({
        id: af.id,
        status: af.status,
        baseSha: af.baseSha,
        patch: af.patch,
        ...(af.mergeJson ? { mergeJson: af.mergeJson, mergeBundle: af.mergeBundle } : {}),
        pushedAt: af.pushedAt,
        trigger: af.trigger,
        createdAt: af.createdAt,
        reviewItems: af.reviewItems,
        changeReport: af.changeReport,
        planStatus: af.planStatus,
      })
      .from(af)
      .where(and(eq(af.accountId, accountId), eq(af.prId, prId)))
      .orderBy(desc(af.id))
      .execute()) as FixRow[];

    // A person's open plan (being made, or waiting for their approval) is a fix in progress.
    if (fixes.some((f) => f.status === 'planned' && (f.planStatus === 'planning' || f.planStatus === 'plan_ready')))
      return skip('fix_in_progress');

    // "Nobody has pushed since": the fix was built on the head the PR still has. The SYNCED head
    // can lag (or be unsynced) while the fixer builds on the LIVE head, so the reviewed head counts
    // too, and the live head is asked for — once, only when an unpushed fix sits on neither.
    const heads = new Set<string>();
    if (head) heads.add(head);
    if (loaded.review?.headSha) heads.add(loaded.review.headSha);
    const atHead = (f: FixRow): boolean => heads.has(f.baseSha);
    const waiting = fixes.filter(
      (f) => f.status === 'succeeded' && f.pushedAt == null && fixRowHasWork({ ...f, patch: (f.patch ?? '').trim() }),
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

    // The review stores what RAN (a Codex id on Codex): ask for the same depth again.
    const asked = loaded.review != null ? requestModelOf(loaded.review.model) : DEFAULT_AI_FIX_MODEL;
    const model: AiFixModel = (CLAUDE_REVIEW_MODELS as readonly string[]).includes(asked)
      ? (asked as AiFixModel)
      : DEFAULT_AI_FIX_MODEL;
    const r =
      reviewId != null
        ? await deps.startReviewFix(ctx, { accountId, prId, reviewId, model, trigger: 'auto', include, queueIfBusy: true })
        : await (deps.startFix ?? lazyStartFix)(ctx, { accountId, prId, model, seed: 'review', sourceReviewId: null, trigger: 'auto', selection: { kind: 'sections', include }, queueIfBusy: true });
    if (r.status === 'queued') {
      const outcome: ClaudeAutoFixOutcome = { reviewId: reviewId ?? 0, status: 'started', fixId: r.fixId };
      if (reviewId != null) record(accountId, outcome);
      ctx.log.info(`auto fix pr ${prId} (review ${reviewId}) started: fix ${r.fixId}`);
      return outcome;
    }
    if (r.status === 'nothing_to_fix') return skip('nothing_to_fix');
    if (r.status === 'already_running') return skip('fix_in_progress');
    if (r.status === 'no_runtime') return skip('no_sandbox');
    // Waiting in THE FIX START QUEUE (it starts by itself), or the line was full.
    if (r.status === 'waiting' || r.status === 'too_many' || r.status === 'build_busy') return skip('sandbox_busy');
    if (r.status === 'over_budget') return skip('over_budget');
    ctx.log.info(`auto fix pr ${prId} (review ${reviewId}) not started: ${r.status}`);
    return skip('not_started');
  } catch (err) {
    ctx.log.warn(
      `auto fix pr ${prId} (review ${reviewId}) failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
    return skip('not_started');
  }
}
