import { and, eq, inArray } from 'drizzle-orm';
import type { SprintGraphPr, SprintTicketCheck, TicketAssessment } from '@pierre-review/shared';

// THIS SPRINT → "n of m met" (docs/API.md § This sprint; docs/CLAUDE-REVIEW.md § Sprint briefs). Each
// sprint card's ticket-check half, read from the DB on the graph GET — never a model, tracker or GitHub
// call, and BATCHED: one query on `ticket_reviews`, one on `ticket_review_members`, one on
// `pull_requests`, whatever the sprint's size.
//
//   • `check` is the LATEST SUCCEEDED ticket review (the Story check) of the ticket, ANY currency, with
//     its criteria verdicts counted the way the Story check counts them (`criteriaCounts`).
//   • `stale` is a DB-ONLY compare: a member PR the run read is gone, closed, pushed or merged since,
//     or this workspace's graph lists an open / merged PR the run did not read. ⚠ An edit to the ticket
//     TEXT is NOT detected here (that needs the story read per ticket — a query per card); the Story
//     check's own state on the PR pane says so.
//   • `running` = a run of the ticket is queued or running (its DB row; the boot reconcile fails any a
//     restart orphaned).
//
// ⚠ PURE AT IMPORT: the DB client is reached LAZILY (the pure fold below is unit-tested without one).

const CHUNK = 400;

export interface CheckRun {
  id: number;
  status: string;
  assessment: TicketAssessment | null;
  completedAt: Date | null;
}

export interface CheckMember {
  prId: number;
  headSha: string;
  prState: 'open' | 'merged';
}

/** The verdict counts of one assessment (the shared rule: `unclear` and anything unknown are unsettled). */
function countsOf(a: TicketAssessment): Pick<SprintTicketCheck, 'met' | 'partlyMet' | 'notMet' | 'unsettled' | 'total'> {
  const c = { met: 0, partlyMet: 0, notMet: 0, unsettled: 0, total: a.criteria.length };
  for (const x of a.criteria) {
    if (x.status === 'met') c.met += 1;
    else if (x.status === 'partly_met') c.partlyMet += 1;
    else if (x.status === 'not_met') c.notMet += 1;
    else c.unsettled += 1;
  }
  return c;
}

/** One ticket's card check from its latest succeeded run. Pure. `live` = today's synced row of every
 *  member PR (missing = gone); `graphPrs` = the ticket's PRs in this workspace (the graph's list). */
export function sprintTicketCheckOf(
  run: CheckRun | null,
  members: readonly CheckMember[],
  live: ReadonlyMap<number, { headSha: string; state: string }>,
  graphPrs: readonly Pick<SprintGraphPr, 'prId' | 'state'>[],
): SprintTicketCheck | null {
  if (run == null || run.assessment == null || !Array.isArray(run.assessment.criteria)) return null;
  const read = new Set(members.map((m) => m.prId));
  let stale = false;
  for (const m of members) {
    const now = live.get(m.prId);
    if (now == null || now.state !== m.prState || now.headSha !== m.headSha) {
      stale = true;
      break;
    }
  }
  if (!stale) stale = graphPrs.some((p) => (p.state === 'open' || p.state === 'merged') && !read.has(p.prId));
  return {
    ...countsOf(run.assessment),
    checkedAt: (run.completedAt ?? new Date(0)).toISOString(),
    stale,
  };
}

const asDate = (d: unknown): Date | null => (d instanceof Date ? d : d == null ? null : new Date(d as string | number));

/** Every listed ident's card check + running flag, this account only. Batched (three queries). */
export async function sprintTicketChecksFor(
  accountId: number,
  idents: readonly string[],
  prsByIdent: ReadonlyMap<string, readonly SprintGraphPr[]>,
): Promise<Map<string, { check: SprintTicketCheck | null; running: boolean }>> {
  const out = new Map<string, { check: SprintTicketCheck | null; running: boolean }>();
  const list = [...new Set(idents)];
  if (list.length === 0) return out;
  const { db, schema } = await import('./client.js');
  const { ticketReviews: tr, ticketReviewMembers: trm, pullRequests: pr } = schema;
  const latest = new Map<string, CheckRun>();
  const running = new Set<string>();
  for (let i = 0; i < list.length; i += CHUNK) {
    const rows = (await db
      .select({ id: tr.id, ident: tr.ticketIdent, status: tr.status, assessment: tr.assessment, completedAt: tr.completedAt })
      .from(tr)
      .where(
        and(
          eq(tr.accountId, accountId),
          inArray(tr.ticketIdent, list.slice(i, i + CHUNK)),
          inArray(tr.status, ['succeeded', 'queued', 'running']),
        ),
      )
      .execute()) as Array<{ id: number; ident: string; status: string; assessment: TicketAssessment | null; completedAt: unknown }>;
    for (const r of rows) {
      if (r.status !== 'succeeded') {
        running.add(r.ident);
        continue;
      }
      const prev = latest.get(r.ident);
      if (prev == null || r.id > prev.id) {
        latest.set(r.ident, { id: r.id, status: r.status, assessment: r.assessment ?? null, completedAt: asDate(r.completedAt) });
      }
    }
  }
  const runIds = [...latest.values()].map((r) => r.id);
  const membersByRun = new Map<number, CheckMember[]>();
  for (let i = 0; i < runIds.length; i += CHUNK) {
    const rows = (await db
      .select({ runId: trm.ticketReviewId, prId: trm.prId, headSha: trm.headSha, prState: trm.prState })
      .from(trm)
      .where(and(eq(trm.accountId, accountId), inArray(trm.ticketReviewId, runIds.slice(i, i + CHUNK))))
      .execute()) as Array<{ runId: number } & CheckMember>;
    for (const m of rows) {
      const arr = membersByRun.get(m.runId) ?? [];
      arr.push({ prId: m.prId, headSha: m.headSha, prState: m.prState });
      membersByRun.set(m.runId, arr);
    }
  }
  const memberPrIds = [...new Set([...membersByRun.values()].flat().map((m) => m.prId))];
  const live = new Map<number, { headSha: string; state: string }>();
  for (let i = 0; i < memberPrIds.length; i += CHUNK) {
    const rows = (await db
      .select({ id: pr.id, headSha: pr.headSha, state: pr.state })
      .from(pr)
      .where(and(eq(pr.accountId, accountId), inArray(pr.id, memberPrIds.slice(i, i + CHUNK))))
      .execute()) as Array<{ id: number; headSha: string | null; state: string }>;
    for (const r of rows) live.set(r.id, { headSha: r.headSha ?? '', state: r.state });
  }
  for (const ident of list) {
    const run = latest.get(ident) ?? null;
    out.set(ident, {
      check: sprintTicketCheckOf(run, run != null ? (membersByRun.get(run.id) ?? []) : [], live, prsByIdent.get(ident) ?? []),
      running: running.has(ident),
    });
  }
  return out;
}
