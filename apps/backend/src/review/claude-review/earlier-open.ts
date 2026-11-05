// EARLIER POINTS THE RUN HOLDS OPEN, BY SEVERITY (docs/CLAUDE-REVIEW.md § Auto-posting → AUTO VERDICT
// → Earlier points still open; decision D1, 2026-11-05).
//
// A review judges earlier points as well as raising its own: a follow-up item on an earlier Limn
// finding, and a thread judgement of a teammate's Limn finding or a person's comment. When a point is
// still open (shared `isStillOpenFollowUp` / `isStillOpenThread`, the ONE rule) and its severity is
// KNOWN, it holds the verdict exactly like one of the run's own findings: an earlier BLOCKER ⇒
// REQUEST_CHANGES, an earlier WARNING ⇒ never APPROVE, an earlier nit / question ⇒ the workspace's
// "Approve with open findings" leftovers rule.
//
// WHERE THE SEVERITY COMES FROM:
//   • a follow-up item: the earlier finding's own severity (`item.severity`);
//   • a thread judgement: the thread's ROOT comment, when it is a Limn finding (any Limn's — the
//     reader's or a teammate's: `limnFindingPost`'s lead). A person's comment, or another review
//     bot's, has no known severity: it counts in `total` (the "1 earlier point is still open." tail)
//     and never holds the verdict.
//
// ⚠ NEVER COUNTED TWICE: an open follow-up item is normally RAISED AGAIN as one of the run's findings
// (follow-up.ts `linkReraisedFindings`, `priorFindingId`), and that finding already holds the verdict
// (or the reader ignored it — the reader's word stands). Such an item counts only in `total`.
// ⚠ One word per thread: a pair's later half wins, and within a run the follow-up's word beats a
// thread judgement of the same thread (as `stillOpenCountOf` and still-open.ts read it).
import { and, eq, inArray } from 'drizzle-orm';
import {
  isStillOpenFollowUp,
  isStillOpenThread,
  limnFindingPost,
  type ClaudeFindingSeverity,
  type ClaudeFollowUpItemRecord,
  type ClaudeThreadAssessment,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

export type EarlierSeverity = Exclude<ClaudeFindingSeverity, 'praise'>;

/** Earlier points the run(s) hold open: all of them, and those of known severity not raised again. */
export interface EarlierOpen {
  // Every earlier point held open, one per thread (= `stillOpenCountOf`).
  total: number;
  blockers: number;
  warnings: number;
  nits: number;
  questions: number;
}

export const NO_EARLIER_OPEN: EarlierOpen = { total: 0, blockers: 0, warnings: 0, nits: 0, questions: 0 };

const sevOf = (s: string | null | undefined): EarlierSeverity | null =>
  s === 'blocker' || s === 'warning' || s === 'nit' || s === 'question' ? s : null;

/** One run as the fold reads it. */
export interface EarlierOpenRun {
  findings?: ReadonlyArray<{ priorFindingId?: number | null }> | null;
  followUpItems?: ReadonlyArray<Pick<ClaudeFollowUpItemRecord, 'status' | 'priorFindingId' | 'severity' | 'threadId'>> | null;
  threadAssessments?: ReadonlyArray<Pick<ClaudeThreadAssessment, 'validity' | 'addressed' | 'threadId'>> | null;
}

/**
 * THE FOLD (pure). `limnRoots`: thread id → the severity of its root Limn finding (absent = not a
 * Limn finding thread, or unknown). `settledPrior`: an earlier finding a reply has settled since
 * (the replies pass) — it holds nothing open.
 */
export function earlierOpenOf(
  runs: readonly EarlierOpenRun[],
  limnRoots: ReadonlyMap<number, EarlierSeverity | null> = new Map(),
  settledPrior: (priorFindingId: number) => boolean = () => false,
): EarlierOpen {
  // Raised again as a finding of any of the runs: that finding counts, never the item.
  const reraised = new Set<number>();
  for (const r of runs) for (const f of r.findings ?? []) if (typeof f?.priorFindingId === 'number') reraised.add(f.priorFindingId);
  // key → null when the latest word does not hold it open; else its severity (null = unknown) and
  // whether it holds the verdict.
  const word = new Map<string, { severity: EarlierSeverity | null; holds: boolean } | null>();
  for (const r of runs) {
    for (const a of r.threadAssessments ?? []) {
      if (a == null || typeof a.threadId !== 'number') continue;
      if (a.validity === 'not_checked' && a.addressed === 'not_checked') continue;
      word.set(`t${a.threadId}`, isStillOpenThread(a) ? { severity: limnRoots.get(a.threadId) ?? null, holds: true } : null);
    }
    for (const it of r.followUpItems ?? []) {
      if (it == null || it.status === 'not_checked') continue;
      const key = typeof it.threadId === 'number' ? `t${it.threadId}` : `f${it.priorFindingId}`;
      if (!isStillOpenFollowUp(it.status) || settledPrior(it.priorFindingId)) {
        word.set(key, null);
        continue;
      }
      word.set(key, { severity: sevOf(it.severity), holds: !reraised.has(it.priorFindingId) });
    }
  }
  const out: EarlierOpen = { ...NO_EARLIER_OPEN };
  for (const w of word.values()) {
    if (w == null) continue;
    out.total += 1;
    if (!w.holds || w.severity == null) continue;
    if (w.severity === 'blocker') out.blockers += 1;
    else if (w.severity === 'warning') out.warnings += 1;
    else if (w.severity === 'nit') out.nits += 1;
    else out.questions += 1;
  }
  return out;
}

/** The threads a fold would read a root severity for: every judged thread of the runs. */
function judgedThreadIds(runs: readonly EarlierOpenRun[]): number[] {
  const ids = new Set<number>();
  for (const r of runs) for (const a of r.threadAssessments ?? []) if (a != null && typeof a.threadId === 'number') ids.add(a.threadId);
  return [...ids];
}

/**
 * The severity of each thread's ROOT comment when it is a Limn finding (any Limn's), by thread id.
 * DB-only, scoped to the PR.
 */
export async function loadLimnRootSeverities(
  ctx: Pick<AgentContext, 'db' | 'schema'>,
  prId: number,
  threadIds: readonly number[],
): Promise<Map<number, EarlierSeverity | null>> {
  const out = new Map<number, EarlierSeverity | null>();
  if (threadIds.length === 0) return out;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rc = (ctx.schema as any).reviewComments;
  const rows = (await ctx.db
    .select({ id: rc.id, threadId: rc.threadId, body: rc.body, createdAt: rc.createdAt })
    .from(rc)
    .where(and(eq(rc.prId, prId), inArray(rc.threadId, [...threadIds])))
    .execute()) as Array<{ id: number; threadId: number; body: string | null; createdAt: Date | null }>;
  const root = new Map<number, (typeof rows)[number]>();
  for (const c of rows) {
    const had = root.get(c.threadId);
    const t = c.createdAt?.getTime() ?? 0;
    if (had == null || t < (had.createdAt?.getTime() ?? 0) || (t === (had.createdAt?.getTime() ?? 0) && c.id < had.id)) {
      root.set(c.threadId, c);
    }
  }
  for (const [threadId, c] of root) {
    const post = limnFindingPost(c.body, { threadRoot: true });
    // A teammate's reminder root ("**Warning** … **Reminder:** first raised …") keeps its severity, as
    // still-open.ts reads it: one point is never a warning there and a mere count here.
    if (post != null && !post.stillOpen) out.set(threadId, sevOf(post.severity));
  }
  return out;
}

/**
 * The fold over real runs, with the root severities read from the DB. A failed read keeps what the
 * follow-up items alone say (never throws).
 */
export async function earlierOpenForRuns(
  ctx: Pick<AgentContext, 'db' | 'schema' | 'log'>,
  prId: number,
  runs: ReadonlyArray<{
    findings: ReadonlyArray<{ priorFindingId?: number | null }>;
    followUp?: { items?: EarlierOpenRun['followUpItems'] } | null;
    threadAssessments?: EarlierOpenRun['threadAssessments'];
  }>,
  settledPrior?: (priorFindingId: number) => boolean,
): Promise<EarlierOpen> {
  const folded: EarlierOpenRun[] = runs.map((r) => ({
    findings: r.findings,
    followUpItems: r.followUp?.items ?? null,
    threadAssessments: r.threadAssessments ?? null,
  }));
  let roots = new Map<number, EarlierSeverity | null>();
  try {
    roots = await loadLimnRootSeverities(ctx, prId, judgedThreadIds(folded));
  } catch (err) {
    ctx.log.warn(`earlier points pr ${prId}: could not read the threads' severities: ${err instanceof Error ? err.message : String(err)}`);
  }
  return earlierOpenOf(folded, roots, settledPrior);
}
