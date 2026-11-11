import { and, desc, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import type { AgentContext } from '../review/agent-context.js';
import { NOT_ANALYZED_RETRY_MS, RETRY_AFTER_MS } from './snapshot.js';

// THE LATE SONARCLOUD POST (docs/SONARCLOUD.md § Posting → Auto, 2026-11-11).
//
// The auto post of a head's SonarCloud issues is tried ONCE, when the auto review of that head ends
// (claude-review/manager.ts → post.ts `maybeAutoPostSonar`). The review starts on the push, and
// SonarCloud's PR analysis usually lands minutes later — often after the review ended. That one try
// then found "SonarCloud has not analysed this commit yet", posted nothing, and nothing tried again:
// AI Fix (which re-reads the PR's head) listed the issues, yet no Limn ever posted them.
//
// THIS SWEEP (every minute, where auto review can run) tries that post again while it could still
// land: a head this account's Limn AUTO-reviewed (a succeeded full review, `kind IS NULL`, trigger
// 'auto') in the last SONAR_LATE_WINDOW_MS, still the PR's synced head on an OPEN PR, in a workspace
// with SonarCloud saved, whose snapshot is missing or read `not_analyzed` / `error` and is due a
// re-read (snapshot.ts's own clocks). `maybeAutoPostSonar` then decides exactly as at the run's end
// (the auto-post switch and its `sonar` kind, the PR's eligibility, the claim before the write —
// never twice). Once the head reads `ok` it leaves this list, posted or not; a state that will not
// change by waiting (`no_project`, `unauthorized`, …) is never in it. A restart loses nothing: the
// list is read from rows.

export const SONAR_LATE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const SONAR_LATE_PER_TICK = 10;
export const SONAR_LATE_CRON = '* * * * *';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: Pick<AgentContext, 'schema'>): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface LateSonarCandidate {
  accountId: number;
  prId: number;
  headSha: string;
}

const RETRYABLE = new Set(['not_analyzed', 'error']);

/** Is a head with this stored snapshot due another try now? null = never read. Pure. */
export function lateSonarDue(snap: { state: string; fetchedAtMs: number } | null, nowMs: number): boolean {
  if (snap == null) return true;
  if (!RETRYABLE.has(snap.state)) return false;
  const wait = snap.state === 'not_analyzed' ? NOT_ANALYZED_RETRY_MS : RETRY_AFTER_MS;
  return nowMs - snap.fetchedAtMs >= wait;
}

/** The heads to try now (DB only), newest review first, at most `limit`. */
export async function lateSonarCandidates(
  ctx: Pick<AgentContext, 'db' | 'schema'>,
  nowMs: number,
  limit: number = SONAR_LATE_PER_TICK,
): Promise<LateSonarCandidate[]> {
  const t = s(ctx);
  const cr = t.claudeReviews;
  const pr = t.pullRequests;
  const wr = t.workspaceRepos;
  const ws = t.workspaceSonar;
  const rows = (await ctx.db
    .select({ accountId: cr.accountId, prId: cr.prId, headSha: cr.headSha })
    .from(cr)
    .innerJoin(pr, and(eq(pr.id, cr.prId), eq(pr.accountId, cr.accountId), eq(pr.headSha, cr.headSha)))
    .innerJoin(wr, and(eq(wr.repoId, pr.repoId), eq(wr.accountId, pr.accountId)))
    .innerJoin(ws, and(eq(ws.workspaceId, wr.workspaceId), eq(ws.accountId, wr.accountId)))
    .where(
      and(
        eq(cr.status, 'succeeded'),
        eq(cr.trigger, 'auto'),
        isNull(cr.kind),
        gte(cr.finishedAt, new Date(nowMs - SONAR_LATE_WINDOW_MS)),
        eq(pr.state, 'open'),
        isNotNull(ws.organization),
        isNotNull(ws.authToken),
      ),
    )
    .orderBy(desc(cr.id))
    .limit(200)
    .execute()) as LateSonarCandidate[];
  const out: LateSonarCandidate[] = [];
  const seen = new Set<string>();
  const sn = t.sonarSnapshots;
  for (const r of rows) {
    const k = `${r.accountId}:${r.prId}:${r.headSha}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const snap = (await ctx.db
      .select({ state: sn.state, fetchedAt: sn.fetchedAt })
      .from(sn)
      .where(and(eq(sn.accountId, r.accountId), eq(sn.prId, r.prId), eq(sn.headSha, r.headSha)))
      .limit(1)
      .execute()) as Array<{ state: string; fetchedAt: Date }>;
    const row = snap[0];
    if (!lateSonarDue(row ? { state: row.state, fetchedAtMs: new Date(row.fetchedAt).getTime() } : null, nowMs)) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

let running = false;

/** One tick: try each due head's auto post again. Never throws; one tick at a time. */
export async function runLateSonarPosts(
  ctx: AgentContext,
  nowMs: number = Date.now(),
  post?: (ctx: AgentContext, a: LateSonarCandidate) => Promise<unknown>,
): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const due = await lateSonarCandidates(ctx, nowMs);
    const send = post ?? (async (c: AgentContext, a: LateSonarCandidate) => (await import('./post.js')).maybeAutoPostSonar(c, a));
    for (const a of due) {
      try {
        await send(ctx, a);
      } catch (err) {
        ctx.log.warn(`sonar late post pr ${a.prId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return due.length;
  } catch (err) {
    ctx.log.warn(`sonar late post sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  } finally {
    running = false;
  }
}

/** Register the sweep (agentic background, where auto review can run). */
export function registerLateSonarPosts(ctx: AgentContext): void {
  ctx.registerScheduledJob(
    SONAR_LATE_CRON,
    async () => {
      await runLateSonarPosts(ctx);
    },
    'sonar-late-post',
  );
}
