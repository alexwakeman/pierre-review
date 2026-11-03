import type { PrCriteriaCheck, TicketAssessment } from '@pierre-review/shared';

// THE "Criteria 3/4" CHIP (docs/FRONTEND.md § PR chips; docs/CLAUDE-REVIEW.md § Ticket review).
// CORE, DB only — never a model, tracker or GitHub call.
//
// For each PR, per TICKET: the latest SUCCEEDED ticket review (Story check) of that ticket that had
// this PR as a MEMBER, and its criteria verdicts. "Met" is `status === 'met'` only — `partly_met`,
// `not_met`, `unclear` and `not_checked` are not met (shared `PrCriteriaCheck`). A check whose
// assessment lists no criteria is NO chip (unknown is never zero), and a PR never checked has none.
//
// `olderHead`: the run read this PR at a head other than its current synced head.
//
// BATCHED: three queries whatever the number of PRs — the members (no JSON), the chosen runs'
// assessments, the PRs' current heads.
//
// ⚠ PURE AT IMPORT: the DB client is reached LAZILY (the fold is unit-tested without one).

const CHUNK = 400;

export interface CriteriaMemberRow {
  prId: number;
  runId: number;
  ident: string;
  /** The head the run read this PR at. */
  headSha: string;
}

export interface CriteriaRun {
  id: number;
  key: string | null;
  title: string | null;
  assessment: TicketAssessment | null;
  completedAt: Date | null;
}

/** Per PR, per ticket ident: the newest run (highest id) that had the PR as a member. Pure. */
export function latestRunPerTicket(rows: readonly CriteriaMemberRow[]): Map<number, Map<string, CriteriaMemberRow>> {
  const out = new Map<number, Map<string, CriteriaMemberRow>>();
  for (const r of rows) {
    const byIdent = out.get(r.prId) ?? new Map<string, CriteriaMemberRow>();
    const prev = byIdent.get(r.ident);
    if (prev == null || r.runId > prev.runId) byIdent.set(r.ident, r);
    out.set(r.prId, byIdent);
  }
  return out;
}

/** One chip's figures from one run, or null when the run judged no criteria. Pure. */
export function criteriaCheckOf(
  member: CriteriaMemberRow,
  run: CriteriaRun | null | undefined,
  currentHeadSha: string | null | undefined,
): PrCriteriaCheck | null {
  const criteria = run?.assessment?.criteria;
  if (run == null || !Array.isArray(criteria) || criteria.length === 0) return null;
  let met = 0;
  let partlyMet = 0;
  let notMet = 0;
  let unsettled = 0;
  for (const c of criteria) {
    if (c.status === 'met') met += 1;
    else if (c.status === 'partly_met') partlyMet += 1;
    else if (c.status === 'not_met') notMet += 1;
    else unsettled += 1;
  }
  return {
    ident: member.ident,
    key: run.key,
    title: run.title,
    reviewId: run.id,
    met,
    partlyMet,
    notMet,
    unsettled,
    total: criteria.length,
    checkedAt: (run.completedAt ?? new Date(0)).toISOString(),
    // An unknown current head is not "older" — say nothing rather than guess.
    olderHead: currentHeadSha != null && currentHeadSha !== '' && currentHeadSha !== member.headSha,
  };
}

/** Order on the chip row: by key (numerically), pasted stories last. Pure. */
export function compareCriteriaChecks(a: PrCriteriaCheck, b: PrCriteriaCheck): number {
  if (a.key == null || b.key == null) return a.key == null ? (b.key == null ? a.reviewId - b.reviewId : 1) : -1;
  return a.key.localeCompare(b.key, undefined, { numeric: true });
}

const asDate = (d: unknown): Date | null => (d instanceof Date ? d : d == null ? null : new Date(d as string | number));

/** Every listed PR's criteria chips (this account only). Every asked id gets an entry ([] = none). */
export async function prCriteriaFor(
  accountId: number,
  prIds: readonly number[],
): Promise<Map<number, PrCriteriaCheck[]>> {
  const ids = [...new Set(prIds)];
  const out = new Map<number, PrCriteriaCheck[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const { and, eq, inArray } = await import('drizzle-orm');
  const { db, schema } = await import('./client.js');
  const { ticketReviews: tr, ticketReviewMembers: trm, pullRequests: pr } = schema;

  const memberRows: CriteriaMemberRow[] = [];
  const heads = new Map<number, string | null>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    memberRows.push(
      ...((await db
        .select({ prId: trm.prId, runId: tr.id, ident: tr.ticketIdent, headSha: trm.headSha })
        .from(trm)
        .innerJoin(tr, and(eq(tr.id, trm.ticketReviewId), eq(tr.accountId, trm.accountId)))
        .where(and(eq(trm.accountId, accountId), inArray(trm.prId, slice), eq(tr.status, 'succeeded')))
        .execute()) as CriteriaMemberRow[]),
    );
    const headRows = (await db
      .select({ id: pr.id, headSha: pr.headSha })
      .from(pr)
      .where(and(eq(pr.accountId, accountId), inArray(pr.id, slice)))
      .execute()) as Array<{ id: number; headSha: string | null }>;
    for (const h of headRows) heads.set(h.id, h.headSha);
  }
  const latest = latestRunPerTicket(memberRows);
  const runIds = [...new Set([...latest.values()].flatMap((m) => [...m.values()].map((r) => r.runId)))];
  const runs = new Map<number, CriteriaRun>();
  for (let i = 0; i < runIds.length; i += CHUNK) {
    const rows = (await db
      .select({ id: tr.id, key: tr.ticketKey, title: tr.ticketTitle, assessment: tr.assessment, completedAt: tr.completedAt })
      .from(tr)
      .where(and(eq(tr.accountId, accountId), inArray(tr.id, runIds.slice(i, i + CHUNK))))
      .execute()) as Array<Omit<CriteriaRun, 'completedAt'> & { completedAt: unknown }>;
    for (const r of rows) runs.set(r.id, { ...r, completedAt: asDate(r.completedAt) });
  }
  for (const [prId, byIdent] of latest) {
    const chips: PrCriteriaCheck[] = [];
    for (const m of byIdent.values()) {
      const c = criteriaCheckOf(m, runs.get(m.runId), heads.get(prId));
      if (c != null) chips.push(c);
    }
    out.set(prId, chips.sort(compareCriteriaChecks));
  }
  return out;
}
