// RESOLVING YOUR LIMN THREADS ON A TEAMMATE'S WORD (gap 13, docs/TEAM-REVIEW.md § 6 Resolving;
// docs/CLAUDE-REVIEW.md § Auto-posting → Auto resolve).
//
// On the reader's OWN PR, a teammate's Limn may hold the commit (a team claim) and the reader's Limn
// steps aside, so no run of the reader's judges the reader's own earlier Limn findings at that commit
// and their threads were never resolved. The teammate's POSTED review still says what it found: its
// hidden marker's `j=` judges earlier Limn findings by their comment id (shared limn-review-meta.ts),
// imported as `TeammateReviewRecord.judged` (db/teammate-reviews-import.ts). This module acts on it.
//
// THE RULE, in order (every one must hold):
//   1. "Resolve my Limn threads when addressed" (`resolveOwnPrs`, ON by default) is on for the PR's
//      workspace; the PR is the READER'S OWN, OPEN (a draft too, as path B), and its author is not a bot;
//   2. a TEAMMATE'S imported review (`kind = 'teammate'`, a stated head — never `headInferred`) AT THE
//      PR'S CURRENT HEAD judged the finding comment `a` (addressed) or `x` (no longer applies); the
//      NEWEST such teammate word per comment wins (a later `n` / `o` at the same head keeps it open);
//   2b. ⚠ THE TRUST GATE — a review marker is text ANYONE who can submit a review can type, so a word
//      counts ONLY from a reviewer who is NOT a bot (`users.is_bot`, or the workspace's automation
//      judgement) AND has WRITE access to the repo, read LIVE (`GET …/collaborators/{login}/permission`
//      is `admin` or `write`; any failure refuses) — checked only for a reviewer with an `a` / `x`
//      word (a word that can only keep a thread open needs no check). A refused reviewer's words are
//      dropped, reported in the result (`untrusted`) and logged — never a resolve. The import itself
//      stays display-only and ungated;
//   3. no run of the reader's own at that head finished AFTER that post (the reader's own newer word
//      stands; path B in auto-resolve.ts acts on it);
//   4. the thread is rooted on the READER'S OWN posted Limn finding (`ownRunsOnly`; never a teammate's
//      thread, never a person's), is found locally and is still unresolved; the finding has no
//      auto-resolve record yet;
//   5. ⚠ THE CLAIM — `claude_review_findings.auto_resolve` NULL → 'resolving' (compare-and-set) BEFORE
//      any GitHub write; ⚠ NEVER RETRIED: a failure is recorded and shown;
//   6. ONE reply crediting the teammate ("Addressed in abc1234 (checked by Robin’s Limn).") + the
//      finding marker (so sync stores it under the reader's `limn:` bot — never the reader's own
//      answer), then the resolve, the local stamp, and ONE settle + change signal for the PR.
// DB reads and one GitHub write per thread; never inside the sync transaction (a kick from
// sync/teammate-review-hooks.ts). Never throws.
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  continuationThreadMap,
  stillOpenByName,
  stillOpenReasonText,
  type FindingAutoResolveRecord,
  type TeammateReviewRecord,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { readWorkspaceAutoPostForPr } from './auto-settings.js';
import { defaultAutoPostDeps, readAutoPostPrFacts, type AutoPostDeps } from './auto-post.js';
import { defaultAutoResolveDeps, findFindingThread, type AutoResolveDeps } from './auto-resolve.js';
import { followOwnContinuation, isClearReplyRefusal, loadPrThreads } from './finding-replies.js';
import { ownRunsOnly, TEAMMATE_KIND } from '../../db/teammate-reviews.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const nowIso = (): string => new Date().toISOString();
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
// post-review.ts FINDING_COMMENT_MARKER (inlined: post-review.ts pulls in the GitHub client at import).
const FINDING_MARKER = '<!-- pierre:claude-review-finding v=1 -->';

export type TeammateResolveOutcome = 'addressed' | 'no_longer_applies';

/** "Robin’s Limn" for a reply: the first word of the display name, else the login, in a safe alphabet. */
export function teammateCheckerName(login: string, name: string | null): string {
  const safe = (v: string): string => v.replace(/[^\p{L}\p{N} ._'’-]/gu, '').trim();
  return stillOpenByName({ you: false, login: safe(login) || 'a teammate', name: name != null ? safe(name) || null : null });
}

/**
 * The reply posted before the thread is resolved, crediting the teammate's Limn. `how`: that Limn's
 * one-line "how" from its marker (`jr=`) — untrusted text, made safe like every posted reason; absent
 * on a word from an older Limn (the bare line, as before). Pure.
 */
export function teammateResolveReplyBody(
  outcome: TeammateResolveOutcome,
  headSha: string,
  checker: string,
  how: string | null = null,
): string {
  const short = headSha.slice(0, 7);
  const text = stillOpenReasonText(how);
  const base = outcome === 'addressed' ? `Addressed in ${short}` : `No longer applies as of ${short}`;
  const lead = text ? `${base} (checked by ${checker}): ${text}` : `${base} (checked by ${checker}).`;
  return `${lead}\n\n_Resolved by Limn._\n\n${FINDING_MARKER}`;
}

/** One teammate review at the head, as the rule reads it. */
export interface TeammateWord {
  reviewId: number;
  login: string;
  name: string | null;
  at: number; // ms
  judged: NonNullable<TeammateReviewRecord['judged']>;
}

/**
 * The newest teammate word per judged comment id, from reviews already filtered to the head. Only an
 * `a` / `x` word resolves; a newer `n` / `o` on the same comment keeps it open. Pure.
 */
export function teammateResolveWords(
  words: readonly TeammateWord[],
  ownNewerThan: number | null,
): Map<string, { outcome: TeammateResolveOutcome; word: TeammateWord; how?: string | null }> {
  const newest = new Map<string, { outcome: string; word: TeammateWord; how: string | null }>();
  for (const w of [...words].sort((a, b) => a.at - b.at || a.reviewId - b.reviewId)) {
    for (const j of w.judged) newest.set(j.commentId, { outcome: j.outcome, word: w, how: j.reason ?? null });
  }
  const out = new Map<string, { outcome: TeammateResolveOutcome; word: TeammateWord; how?: string | null }>();
  for (const [id, v] of newest) {
    if (ownNewerThan != null && ownNewerThan >= v.word.at) continue;
    if (v.outcome === 'addressed' || v.outcome === 'no_longer_applies') {
      out.set(id, { outcome: v.outcome, word: v.word, ...(v.how ? { how: v.how } : {}) });
    }
  }
  return out;
}

export interface TeammateResolveResult {
  resolved: number[];
  failed: number[];
  // Logins whose words were refused by the trust gate (rule 2b): never a resolve.
  untrusted: string[];
}

/** Rule 2b's live read. */
export interface TeammateTrustDeps {
  // True only when GitHub says `login` has write (or admin) access to owner/name. Never throws.
  canWrite(accountId: number, owner: string, name: string, login: string): Promise<boolean>;
}

export const defaultTeammateTrustDeps: TeammateTrustDeps = {
  async canWrite(accountId, owner, name, login) {
    try {
      const [{ getAccessToken }, { ghRestGetFor }] = await Promise.all([
        import('../../auth/account.js'),
        import('../../github/client.js'),
      ]);
      const enc = encodeURIComponent;
      const r = await ghRestGetFor<{ permission?: string }>(
        await getAccessToken(accountId),
        `/repos/${enc(owner)}/${enc(name)}/collaborators/${enc(login)}/permission`,
      );
      return r.permission === 'admin' || r.permission === 'write';
    } catch {
      return false;
    }
  },
};

const inFlight = new Set<number>();

/** The kick sync calls after importing a PR's teammate reviews. Never throws; one at a time per PR. */
export async function maybeResolveOnTeammateWord(
  ctx: AgentContext,
  a: { accountId: number; prId: number },
  postDeps: Pick<AutoPostDeps, 'isAutomation' | 'accountUserId' | 'accountLogin' | 'settle'> = defaultAutoPostDeps,
  deps: AutoResolveDeps = defaultAutoResolveDeps,
  trust: TeammateTrustDeps = defaultTeammateTrustDeps,
): Promise<TeammateResolveResult | null> {
  if (inFlight.has(a.prId)) return null;
  inFlight.add(a.prId);
  try {
    return await resolveOnTeammateWord(ctx, a, postDeps, deps, trust);
  } catch (err) {
    ctx.log.warn(`teammate resolve pr ${a.prId}: ${errText(err)}`);
    return null;
  } finally {
    inFlight.delete(a.prId);
  }
}

async function resolveOnTeammateWord(
  ctx: AgentContext,
  { accountId, prId }: { accountId: number; prId: number },
  postDeps: Pick<AutoPostDeps, 'isAutomation' | 'accountUserId' | 'accountLogin' | 'settle'>,
  deps: AutoResolveDeps,
  trust: TeammateTrustDeps,
): Promise<TeammateResolveResult | null> {
  const ws = await readWorkspaceAutoPostForPr(ctx, accountId, prId);
  if (!ws || !ws.settings.resolveOwnPrs) return null;
  const facts = await readAutoPostPrFacts(ctx, postDeps, accountId, ws.workspaceId, prId);
  if (!facts || !facts.authorIsMe || facts.authorIsBot || facts.state !== 'open') return null;

  const t = s(ctx);
  const { claudeReviews: cr, claudeReviewFindings: crf, pullRequests: prs, repos, users } = t;
  const prRow = (
    (await ctx.db
      .select({ headSha: prs.headSha, owner: repos.owner, name: repos.name })
      .from(prs)
      .innerJoin(repos, eq(repos.id, prs.repoId))
      .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
      .limit(1)
      .execute()) as Array<{ headSha: string | null; owner: string; name: string }>
  )[0];
  const head = prRow?.headSha;
  if (!prRow || !head) return null;
  const sameHead = (h: string | null | undefined): boolean => !!h && h.toLowerCase() === head.toLowerCase();

  // The teammates' imported reviews on this PR (rule 2).
  const mates = (await ctx.db
    .select({
      id: cr.id,
      headSha: cr.headSha,
      postedAt: cr.postedAt,
      teammate: cr.teammate,
      userId: users.id,
      isBot: users.isBot,
      login: users.githubLogin,
      name: users.displayName,
    })
    .from(cr)
    .innerJoin(users, eq(users.id, cr.sourceUserId))
    .where(and(eq(cr.accountId, accountId), eq(cr.prId, prId), eq(cr.kind, TEAMMATE_KIND), eq(cr.status, 'succeeded')))
    .execute()) as Array<{
    id: number;
    headSha: string;
    postedAt: Date | null;
    teammate: TeammateReviewRecord | null;
    userId: number;
    isBot: boolean | null;
    login: string | null;
    name: string | null;
  }>;
  const atHead = mates.filter(
    (m) => sameHead(m.headSha) && m.teammate != null && !m.teammate.headInferred && (m.teammate.judged ?? []).length > 0 && m.login,
  );
  if (atHead.length === 0) return null;

  // Rule 3: the reader's own newest run at this head.
  const own = (
    (await ctx.db
      .select({ finishedAt: cr.finishedAt })
      .from(cr)
      .where(and(eq(cr.accountId, accountId), eq(cr.prId, prId), isNull(cr.kind), eq(cr.status, 'succeeded'), eq(cr.headSha, head)))
      .orderBy(desc(cr.finishedAt))
      .limit(1)
      .execute()) as Array<{ finishedAt: Date | null }>
  )[0];

  // Rule 4: the reader's own posted inline findings with no auto-resolve record yet.
  const findings = (await ctx.db
    .select({
      id: crf.id,
      path: crf.path,
      line: crf.line,
      body: crf.body,
      editedBody: crf.editedBody,
      githubCommentId: crf.githubCommentId,
    })
    .from(crf)
    .innerJoin(cr, eq(cr.id, crf.reviewId))
    .where(
      and(
        eq(cr.accountId, accountId),
        eq(cr.prId, prId),
        ownRunsOnly(cr.kind),
        eq(crf.postedCommentKind, 'inline'),
        isNull(crf.autoResolve),
      ),
    )
    .orderBy(crf.id)
    .execute()) as Array<{ id: number; path: string; line: number | null; body: string; editedBody: string | null; githubCommentId: string | null }>;
  if (findings.length === 0) return null;

  // Rule 2b: THE TRUST GATE. A word that can only HOLD a thread (`n` / `o`) needs no check; a reviewer
  // with any `a` / `x` word must not be a bot and must have write access (one live read per login).
  const trusted = new Map<number, boolean>();
  const untrusted: string[] = [];
  for (const m of atHead) {
    if (trusted.has(m.userId)) continue;
    const canClose = m.teammate!.judged!.some((j) => j.outcome === 'addressed' || j.outcome === 'no_longer_applies');
    if (!canClose) continue;
    let ok = !m.isBot && !(await postDeps.isAutomation(accountId, ws.workspaceId, m.userId));
    if (ok) ok = await trust.canWrite(accountId, prRow.owner, prRow.name, m.login!);
    trusted.set(m.userId, ok);
    if (!ok) untrusted.push(m.login!);
  }
  if (untrusted.length > 0) {
    ctx.log.warn(`teammate resolve pr ${prId}: ignored the Limn word of ${untrusted.join(', ')} (a bot, or no write access)`);
  }
  const words: TeammateWord[] = atHead
    .filter((m) => trusted.get(m.userId) !== false)
    .map((m) => ({ reviewId: m.id, login: m.login!, name: m.name ?? null, at: m.postedAt?.getTime() ?? 0, judged: m.teammate!.judged! }));
  const wanted = teammateResolveWords(words, own?.finishedAt?.getTime() ?? null);
  if (wanted.size === 0) return untrusted.length > 0 ? { resolved: [], failed: [], untrusted } : null;

  const { threads, comments } = await loadPrThreads(ctx, prId);
  const accountLogin = await postDeps.accountLogin(accountId);
  if (!accountLogin) return null;
  const continuations = continuationThreadMap(comments);
  const rootOf = new Map<number, string | null>();
  for (const c of comments) if (!rootOf.has(c.threadId)) rootOf.set(c.threadId, c.databaseId ?? null); // oldest first

  const result: TeammateResolveResult = { resolved: [], failed: [], untrusted };
  const taken = new Set<number>();
  let wroteAny = false;
  for (const f of findings) {
    const found = findFindingThread(f, threads, comments, accountLogin, taken);
    if (!found) continue;
    // The teammate judged the finding's own comment (the thread root); a point continued in a new
    // thread of the reader's own is resolved THERE.
    const rootId = rootOf.get(found.id) ?? f.githubCommentId;
    const want = rootId != null ? wanted.get(rootId) : undefined;
    if (!want) continue;
    taken.add(found.id);
    const thread = followOwnContinuation(found, threads, comments, continuations, accountLogin);
    if (thread.isResolved) continue;

    const rec: FindingAutoResolveRecord = {
      status: 'resolving',
      at: nowIso(),
      outcome: want.outcome,
      byReviewId: want.word.reviewId,
      headSha: head,
      replyCommentId: null,
      error: null,
      why: 'teammate',
      checkedBy: want.word.login,
    };
    // ⚠ THE CLAIM, BEFORE ANY WRITE.
    const claimed = (await ctx.db
      .update(crf)
      .set({ autoResolve: rec })
      .where(and(eq(crf.id, f.id), isNull(crf.autoResolve)))
      .returning({ id: crf.id })
      .execute()) as Array<{ id: number }>;
    if (claimed.length === 0) continue;

    let final: FindingAutoResolveRecord = rec;
    let resolvedAt: Date | null = null;
    try {
      const body = teammateResolveReplyBody(want.outcome, head, teammateCheckerName(want.word.login, want.word.name), want.how ?? null);
      const { commentId } = await deps.reply(accountId, thread.githubNodeId, body);
      wroteAny = true;
      final = { ...final, replyCommentId: commentId };
      try {
        await deps.resolve(accountId, thread.githubNodeId);
        resolvedAt = new Date();
        final = { ...final, status: 'resolved', at: nowIso() };
        await deps.stamp(thread.id, accountId).catch((err) =>
          ctx.log.warn(`teammate resolve finding ${f.id}: could not stamp the thread: ${errText(err)}`),
        );
      } catch (err) {
        final = { ...final, status: 'failed', at: nowIso(), error: errText(err) };
      }
    } catch (err) {
      final = { ...final, status: 'failed', at: nowIso(), error: errText(err), refused: isClearReplyRefusal(err) };
    }
    (final.status === 'resolved' ? result.resolved : result.failed).push(f.id);
    await ctx.db
      .update(crf)
      .set({ autoResolve: final, ...(resolvedAt ? { autoResolvedAt: resolvedAt } : {}) })
      .where(eq(crf.id, f.id))
      .execute()
      .catch((err: unknown) => ctx.log.warn(`teammate resolve finding ${f.id}: could not record the result: ${errText(err)}`));
  }
  if (wroteAny) {
    await deps.notePrChanged(accountId, [prId]).catch(() => {});
    await postDeps.settle({ accountId, prId, log: ctx.log }).catch(() => ({ visible: false }));
  }
  return result;
}

/** Register the kick (review/agentic.ts, boot). */
export async function bindTeammateResolve(ctx: AgentContext): Promise<void> {
  const { registerTeammateReviewsImportedHook } = await import('../../sync/teammate-review-hooks.js');
  registerTeammateReviewsImportedHook((a) => maybeResolveOnTeammateWord(ctx, a).then(() => undefined));
}
