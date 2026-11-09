import { and, eq, inArray } from 'drizzle-orm';
import {
  criterionCounts,
  criterionDone,
  isTrackerIdent,
  parseTicketIdent,
  trackerTicketRow,
  type SprintGraphPr,
  type SprintTicketCheck,
  type TicketAssessment,
} from '@pierre-review/shared';

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
//     check's own state on the PR pane says so. ALSO stale: a person's stored comment the run did not
//     see, while it still has a criterion not done (the rule of tracker/comments.ts
//     `newCommentsMakeStale`, applied here on the batched rows — one more query).
//   • Outside-code criteria (`met_outside_code`) are DONE (shared `criterionDone`), counted apart.
//   • `missing` counts the run's items outside the criteria and `reviewId` names the run: with the
//     verdicts they decide "Fill gaps" (shared `storyBuildOffered`), and its start state reads that run.
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
  /** The people comments the run was given (null = before comments were read). */
  commentsSeen?: { ids: string[] } | null;
}

export interface CheckMember {
  prId: number;
  headSha: string;
  prState: 'open' | 'merged';
}

/** The verdict counts of one assessment (the shared rule: `unclear` and anything unknown are unsettled). */
function countsOf(
  a: TicketAssessment,
): Pick<SprintTicketCheck, 'met' | 'metOutsideCode' | 'partlyMet' | 'notMet' | 'unsettled' | 'total' | 'missing'> {
  const missing = Array.isArray(a.missing) ? a.missing.length : 0;
  const c = criterionCounts(a.criteria);
  return { met: c.met, metOutsideCode: c.metOutsideCode, partlyMet: c.partlyMet, notMet: c.notMet, unsettled: c.unsettled, total: c.total, missing };
}

/** One ticket's card check from its latest succeeded run. Pure. `live` = today's synced row of every
 *  member PR (missing = gone); `graphPrs` = the ticket's PRs in this workspace (the graph's list). */
export function sprintTicketCheckOf(
  run: CheckRun | null,
  members: readonly CheckMember[],
  live: ReadonlyMap<number, { headSha: string; state: string }>,
  graphPrs: readonly Pick<SprintGraphPr, 'prId' | 'state'>[],
  // The ticket's people comment ids now (stored rows); absent = not known (never stale by comments).
  commentIds?: readonly string[],
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
  // A person's comment the run did not see, while a criterion is not done (comments.ts
  // `newCommentsMakeStale` — the same rule, inlined to keep this module free of the tracker).
  if (!stale && commentIds != null && Array.isArray(run.commentsSeen?.ids)) {
    const had = new Set(run.commentsSeen!.ids);
    stale = commentIds.some((id) => !had.has(id)) && run.assessment.criteria.some((c) => !criterionDone(c.status));
  }
  return {
    ...countsOf(run.assessment),
    reviewId: run.id,
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
      .select({
        id: tr.id,
        ident: tr.ticketIdent,
        status: tr.status,
        assessment: tr.assessment,
        completedAt: tr.completedAt,
        commentsSeen: tr.commentsSeen,
      })
      .from(tr)
      .where(
        and(
          eq(tr.accountId, accountId),
          inArray(tr.ticketIdent, list.slice(i, i + CHUNK)),
          inArray(tr.status, ['succeeded', 'queued', 'running']),
        ),
      )
      .execute()) as Array<{
      id: number;
      ident: string;
      status: string;
      assessment: TicketAssessment | null;
      completedAt: unknown;
      commentsSeen: { ids: string[] } | null;
    }>;
    for (const r of rows) {
      if (r.status !== 'succeeded') {
        running.add(r.ident);
        continue;
      }
      const prev = latest.get(r.ident);
      if (prev == null || r.id > prev.id) {
        latest.set(r.ident, {
          id: r.id,
          status: r.status,
          assessment: r.assessment ?? null,
          completedAt: asDate(r.completedAt),
          commentsSeen: r.commentsSeen ?? null,
        });
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
  // The people's stored comment ids of every ticket whose latest run recorded what it saw.
  const commentIdsOf = await peopleCommentIds(
    accountId,
    [...latest.entries()].filter(([, r]) => r.commentsSeen != null).map(([ident]) => ident),
  );
  for (const ident of list) {
    const run = latest.get(ident) ?? null;
    out.set(ident, {
      check: sprintTicketCheckOf(
        run,
        run != null ? (membersByRun.get(run.id) ?? []) : [],
        live,
        prsByIdent.get(ident) ?? [],
        commentIdsOf.get(ident) ?? (run?.commentsSeen != null ? [] : undefined),
      ),
      running: running.has(ident),
    });
  }
  return out;
}

/** ident → the people's stored comment ids (bots out), for tracker idents. Batched by issue key. */
async function peopleCommentIds(accountId: number, idents: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const byRow = new Map<string, string>();
  for (const ident of idents) {
    const parsed = parseTicketIdent(ident);
    if (!isTrackerIdent(parsed)) continue;
    const r = trackerTicketRow(parsed);
    byRow.set(`${r.provider}|${r.apiRoot}|${r.issueKey}`, ident);
  }
  if (byRow.size === 0) return out;
  const keys = [...new Set([...byRow.keys()].map((k) => k.slice(k.lastIndexOf('|') + 1)))];
  const { db, schema } = await import('./client.js');
  const c = schema.trackerTicketComments;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const rows = (await db
      .select({ provider: c.provider, apiRoot: c.apiRoot, issueKey: c.issueKey, commentId: c.commentId })
      .from(c)
      .where(and(eq(c.accountId, accountId), eq(c.isBot, false), inArray(c.issueKey, keys.slice(i, i + CHUNK))))
      .execute()) as Array<{ provider: string; apiRoot: string; issueKey: string; commentId: string }>;
    for (const r of rows) {
      const ident = byRow.get(`${r.provider}|${r.apiRoot}|${r.issueKey}`);
      if (ident == null) continue;
      const arr = out.get(ident) ?? [];
      arr.push(r.commentId);
      out.set(ident, arr);
    }
  }
  return out;
}
