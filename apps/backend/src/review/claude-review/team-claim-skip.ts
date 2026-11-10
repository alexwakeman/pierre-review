// THE SKIPPED LINE (docs/CLAUDE-REVIEW.md § Team claims → The skipped line, 2026-11-04).
//
// When the reader's Limn decides NOT to start an auto review of a PR head it would otherwise review,
// for a reason OTHER than a teammate's claim (those are visible already), it says so on the PR: ONE
// commit status on the head, under the provider's own `limn/review-<provider>` context, state
// SUCCESS (always settled and green — never pending, never failure/error):
//
//     "Cleared by alex: auto review skipped · AI budget used"
//     "Cleared by alex: auto review skipped · daily auto-review limit reached"
//     "Cleared by alex: auto review skipped · Codex over its usage limit until 15:40"
//     "Cleared by alex: auto review skipped · Claude not signed in"
//
// ⚠ It starts "Cleared by " like every free success line, so every teammate's Limn — an older one too —
//   reads it as FREE (it reviewed nothing); the fold also reads " skipped · " as free (team-claim.ts).
//   Limn's lines are never CI (shared `isLimnStatusContext`).
// ⚠ AT MOST ONCE per (PR, head, provider, reason): the row in `team_claim_skip_lines` (migration 0166)
//   is CLAIMED (insert, unique key) BEFORE the GitHub write; a failed write is recorded, never retried.
// ⚠ NEVER OVER ANOTHER LINE THAT MEANS SOMETHING: posted only when the context has no line at the head,
//   or its newest line is already free. A pending claim or a "reviewed" line (anyone's, ours too) is left
//   alone — the row is recorded 'not_needed'. And never at a head where this account already has a
//   review row (its own line may be there).
// ⚠ Only where team claims are on for the PR's workspace, only for open, non-draft PRs a PERSON opened.
//   A later run at the head posts its normal "is reviewing" / "reviewed" lines over it, as always.
// Never throws.
import type { AiProviderId } from '@pierre-review/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { AgentContext } from '../agent-context.js';
import {
  claimErrorKind,
  defaultTeamClaimGithub,
  isFreeTeamClaimLine,
  newestLine,
  skippedLine,
  teamClaimContext,
  type AutoSkipReason,
  type TeamClaimGithub,
} from './team-claim.js';
import { trueAuthorId } from '../../db/true-author.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** One skipped line to post: the provider's context and why. */
export interface AutoSkip {
  provider: AiProviderId;
  reason: AutoSkipReason;
  /** A usage limit's end, when known. */
  untilMs?: number | null;
  /** AI is not installed (else: not signed in). */
  notSetUp?: boolean;
}

export type AutoSkipOutcome =
  | 'posted'
  | 'not_eligible' // not open, a draft, a bot's PR, an unknown PR, or a review row at the head
  | 'already' // a row for this (PR, head, provider, reason) exists
  | 'not_needed' // another line already sits on the head
  | 'no_login'
  | 'failed';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The GitHub adapter (a test pins its own). Read at call time, never at import.
let githubOverride: TeamClaimGithub | null = null;
const gh = (): TeamClaimGithub => githubOverride ?? defaultTeamClaimGithub;
/** Test hook. */
export function _setSkipLineGithubForTest(g: TeamClaimGithub | null): void {
  githubOverride = g;
}

// Posts started without awaiting (the manager's drop paths): a test awaits them.
const inFlight = new Set<Promise<unknown>>();
/** Test hook: wait for every skipped line being written. */
export async function _skipLinesSettledForTest(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/** Post in the background (the manager must release its seat at once). Never throws. */
export function postAutoSkipLinesLater(
  ctx: AgentContext,
  a: { accountId: number; prId: number; headSha?: string | null },
  skips: readonly AutoSkip[] | (() => Promise<readonly AutoSkip[]>),
): void {
  const p = (async () => postAutoSkipLines(ctx, a, typeof skips === 'function' ? await skips() : skips))()
    .catch((err) => ctx.log.warn(`skipped line pr ${a.prId}: ${errText(err)}`))
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
}

interface PrFacts {
  owner: string;
  name: string;
  number: number;
  headSha: string | null;
  open: boolean;
  draft: boolean;
  authorId: number | null;
}

async function prFacts(ctx: AgentContext, accountId: number, prId: number): Promise<PrFacts | null> {
  const { pullRequests: prs, repos } = s(ctx);
  const rows = (await ctx.db
    .select({
      owner: repos.owner,
      name: repos.name,
      number: prs.number,
      headSha: prs.headSha,
      state: prs.state,
      draft: prs.isDraft,
      authorId: trueAuthorId(prs),
    })
    .from(prs)
    .innerJoin(repos, and(eq(repos.id, prs.repoId), eq(repos.accountId, accountId)))
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{
    owner: string;
    name: string;
    number: number;
    headSha: string | null;
    state: string | null;
    draft: boolean | null;
    authorId: number | null;
  }>;
  const r = rows[0];
  if (!r) return null;
  return {
    owner: r.owner,
    name: r.name,
    number: r.number,
    headSha: r.headSha,
    open: (r.state ?? '').toLowerCase() === 'open',
    draft: r.draft === true,
    authorId: r.authorId,
  };
}

/** Any review row (not a replies pass) of this PR at this head: this account's own line may be there. */
async function reviewRowAtHead(ctx: AgentContext, accountId: number, prId: number, headSha: string): Promise<boolean> {
  const cr = s(ctx).claudeReviews;
  const rows = (await ctx.db
    .select({ id: cr.id })
    .from(cr)
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), eq(cr.headSha, headSha), isNull(cr.kind)))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

async function isBotAuthor(authorId: number | null): Promise<boolean> {
  if (authorId == null) return false;
  try {
    const { globalAutomationUserIds } = await import('../../db/automation-ids.js');
    return (await globalAutomationUserIds()).has(authorId);
  } catch {
    return true; // unknown ⇒ the safe side: post nothing
  }
}

/**
 * Post the skipped lines for ONE PR head (each provider, each reason, at most once). `headSha`: the
 * head the decision was about; absent ⇒ the synced head. Never throws.
 */
export async function postAutoSkipLines(
  ctx: AgentContext,
  a: { accountId: number; prId: number; headSha?: string | null },
  skips: readonly AutoSkip[],
  nowMs: number = Date.now(),
): Promise<AutoSkipOutcome[]> {
  const t = s(ctx).teamClaimSkipLines;
  if (!t || skips.length === 0) return [];
  const { accountId, prId } = a;
  const all = (o: AutoSkipOutcome): AutoSkipOutcome[] => skips.map(() => o);
  try {
    const pr = await prFacts(ctx, accountId, prId);
    const headSha = a.headSha ?? pr?.headSha ?? null;
    if (!pr || !headSha || pr.headSha !== headSha || !pr.open || pr.draft) return all('not_eligible');
    if (await reviewRowAtHead(ctx, accountId, prId, headSha)) return all('not_eligible');
    if (await isBotAuthor(pr.authorId)) return all('not_eligible');
    const out: AutoSkipOutcome[] = [];
    let login: string | null | undefined;
    for (const sk of skips) {
      const key = and(
        eq(t.accountId, accountId),
        eq(t.prId, prId),
        eq(t.headSha, headSha),
        eq(t.provider, sk.provider),
        eq(t.reason, sk.reason),
      );
      const seen = (await ctx.db.select({ id: t.id }).from(t).where(key).limit(1).execute()) as unknown[];
      if (seen.length > 0) {
        out.push('already');
        continue;
      }
      if (login === undefined) login = await gh().login(accountId).catch(() => null);
      if (!login) {
        out.push('no_login');
        continue;
      }
      out.push(await postOne(ctx, { accountId, prId, headSha, pr, login, skip: sk, nowMs }));
    }
    return out;
  } catch (err) {
    ctx.log.warn(`skipped line pr ${prId}: ${errText(err)}`);
    return all('failed');
  }
}

async function postOne(
  ctx: AgentContext,
  a: { accountId: number; prId: number; headSha: string; pr: PrFacts; login: string; skip: AutoSkip; nowMs: number },
): Promise<AutoSkipOutcome> {
  const t = s(ctx).teamClaimSkipLines;
  const { accountId, prId, headSha, pr, login, skip } = a;
  const context = teamClaimContext(skip.provider);
  const description = skippedLine(login, skip.reason, skip.provider, {
    untilMs: skip.untilMs ?? null,
    notSetUp: skip.notSetUp === true,
    nowMs: a.nowMs,
  });
  // READ FIRST (a read is not a write): a line that means something stays the newest one.
  let needed = true;
  let readError: string | null = null;
  try {
    const newest = newestLine(await gh().listLines(accountId, pr.owner, pr.name, headSha, context));
    needed = newest == null || (newest.state === 'success' && isFreeTeamClaimLine(newest));
  } catch (err) {
    claimErrorKind(err, accountId); // tells the rate budget about a limit
    readError = errText(err);
  }
  // THE CLAIM, before any GitHub write: the unique key makes it once per (PR, head, provider, reason).
  const claimed = (await ctx.db
    .insert(t)
    .values({
      accountId,
      prId,
      headSha,
      provider: skip.provider,
      reason: skip.reason,
      state: readError != null ? 'failed' : needed ? 'posting' : 'not_needed',
      description,
      lastError: readError,
    })
    .onConflictDoNothing()
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  const id = claimed[0]?.id;
  if (id == null) return 'already';
  if (readError != null) return 'failed';
  if (!needed) return 'not_needed';
  const settle = (state: 'posted' | 'failed', lastError: string | null) =>
    ctx.db.update(t).set({ state, lastError, updatedAt: new Date() }).where(eq(t.id, id)).execute();
  try {
    await gh().postLine(accountId, pr.owner, pr.name, headSha, context, { state: 'success', description });
  } catch (err) {
    const kind = claimErrorKind(err, accountId);
    await settle('failed', kind === 'error' ? errText(err) : kind).catch(() => {});
    ctx.log.warn(`skipped line pr ${prId}: not written (${errText(err)}); not retried`);
    return 'failed';
  }
  await settle('posted', null).catch(() => {});
  return 'posted';
}

/**
 * The providers an auto review of this PR would run with right now (the workspace's pair, else the
 * default provider), ignoring usage limits — whose context a skipped line goes on. Never empty: the
 * default provider when none can review. Never throws.
 */
export async function autoProvidersForPr(ctx: AgentContext, accountId: number, prId: number): Promise<AiProviderId[]> {
  const [{ readAutoReviewProvidersForPr, PAIR_ORDER }, { automaticRunProviders }, { activeProviderId }, { preflightFor }] =
    await Promise.all([
      import('./pair.js'),
      import('../../ai/usage-lockout.js'),
      import('../../ai/provider-setting.js'),
      import('../../ai/run-choice.js'),
    ]);
  const fallback = activeProviderId();
  try {
    const detect = preflightFor(ctx);
    const pair = (await readAutoReviewProvidersForPr(ctx, accountId, prId)) === 'both';
    const out = automaticRunProviders({
      defaultProvider: fallback,
      pair,
      order: PAIR_ORDER,
      ready: (p) => detect(p, 'review').status === 'ok',
      locked: () => false,
    });
    return out.length > 0 ? out : [fallback];
  } catch {
    return [fallback];
  }
}
