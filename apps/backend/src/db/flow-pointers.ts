// ── CHRONOLOGY POINTERS: the evidence the plugin's Haiku narration is allowed to see ──────────
//
// THE CODE PICKS THE EVIDENCE, THE MODEL WRITES THE SENTENCES. This fold is the whole of what the
// model knows: the same `getFlowCourts` pass the panel renders (so a pointer cannot describe a
// different population from the charts beside it), trimmed to a bounded set of rows, plus a few
// EXEMPLARS — the slowest and the quickest pull request in each size band, with the first thing a
// reviewer said on each. The plugin (packages/pro/src/flow-pointers/) validates every citation
// against `rows ∪ exemplars` and drops the rest, counted.
//
// ⚠ NO PERSON CROSSES THIS SEAM. `FlowPrRow` already carries no actor, and the exemplar text has
// every @handle masked. Chronology names no one; a model handed a login would, sooner or later.
//
// ⚠ COMMENT TEXT IS ATTACKER-AUTHORED. Anyone who can comment on a pull request writes it. It is
// trimmed and masked here and FENCED as data by the plugin's prompt; nothing it says can widen the
// output surface, because the parse admits only cited ids that were in this evidence and gates
// every string (no digits, no handles, capped length).
//
// Deterministic and free: no model, no GitHub call. The plugin's GET runs it to report staleness,
// so nothing clock-derived may leave here in a field the payload hash folds.
import { and, eq, inArray } from 'drizzle-orm';
import type {
  FlowPointerEvidence,
  FlowPointerExemplar,
  FlowPointerRow,
  FlowPrRow,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { resolveActorLanes } from './actor-lanes.js';
import { getFlowCourts } from './pr-intervals.js';
import { getResolvedFlowSettings } from './flow-settings.js';
import type { BotScope } from './queries.js';

const { prComments, pullRequests, reviewComments, reviews } = schema;

/** Rows handed to the model. The slowest are kept whole; the rest are sampled evenly. */
const POINTER_ROWS_SLOWEST = 25;
const POINTER_ROWS_FASTEST = 15;
const POINTER_ROWS_MIDDLE = 20;
/** A size band needs this many sized PRs before it offers a slow-and-quick pair. */
const EXEMPLAR_BAND_MIN = 4;
/** Characters of reviewer text and description per exemplar — enough to say what it was about. */
const EXEMPLAR_TEXT_CAP = 360;

/**
 * Mask every @handle, drop HTML comments and fenced code, and collapse whitespace. A handle is a
 * person; code is tokens the model does not need to say what a review was about.
 */
export function cleanEvidenceText(raw: string | null | undefined, cap = EXEMPLAR_TEXT_CAP): string | null {
  if (raw == null) return null;
  const s = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/(^|[^\w`/])@[A-Za-z0-9](?:[\w-]*[A-Za-z0-9])?(?:\[bot\])?/g, '$1@someone')
    .replace(/\s+/g, ' ')
    .trim();
  if (s === '') return null;
  return s.length > cap ? `${s.slice(0, cap - 1).trimEnd()}…` : s;
}

function rowOf(p: FlowPrRow, quarter: FlowPointerRow['quarter']): FlowPointerRow {
  return {
    prId: p.prId,
    repoFullName: p.repoFullName,
    prNumber: p.prNumber,
    prTitle: p.prTitle,
    githubUrl: p.githubUrl,
    quarter,
    leadWorkHours: p.leadWorkHours,
    workHours: p.workHours,
    firstLookWorkHours: p.firstLookWorkHours,
    rounds: p.rounds,
    lines: p.lines,
    files: p.files,
    reachAreas: p.reachAreas,
    ciRedHours: p.ciRedHours,
    openedWeekday: p.openedWeekday,
    ticketKey: p.ticketKey,
    selfMerged: p.selfMerged,
    requestKind: p.requestKind ?? null,
  };
}

export async function getFlowPointerEvidence(
  accountId: number,
  scope: BotScope,
  windowDaysRaw: number,
): Promise<FlowPointerEvidence> {
  const flow = await getFlowCourts(accountId, scope, windowDaysRaw);
  const settings = flow.settings ?? (await getResolvedFlowSettings(accountId, scope.workspaceId));
  const all = [...(flow.prs ?? [])].sort((a, b) => a.leadWorkHours - b.leadWorkHours || a.prId - b.prId);
  const q = Math.floor(all.length / 4);
  const quarterOf = (i: number): FlowPointerRow['quarter'] =>
    q > 0 && i < q ? 'fastest' : q > 0 && i >= all.length - q ? 'slowest' : 'middle';

  // ── Rows: the slowest whole, the fastest whole, an even stride over the middle ─────────────
  const picked = new Map<number, FlowPointerRow>();
  const take = (i: number): void => {
    const p = all[i];
    if (p && !picked.has(p.prId)) picked.set(p.prId, rowOf(p, quarterOf(i)));
  };
  for (let i = all.length - 1; i >= Math.max(0, all.length - POINTER_ROWS_SLOWEST); i -= 1) take(i);
  for (let i = 0; i < Math.min(all.length, POINTER_ROWS_FASTEST); i += 1) take(i);
  const midFrom = POINTER_ROWS_FASTEST;
  const midTo = all.length - POINTER_ROWS_SLOWEST;
  if (midTo > midFrom) {
    const span = midTo - midFrom;
    const n = Math.min(POINTER_ROWS_MIDDLE, span);
    for (let k = 0; k < n; k += 1) take(midFrom + Math.floor((k * span) / n));
  }

  // ── Exemplars: in each size band, its slowest and its quickest ─────────────────────────────
  const index = new Map(all.map((p, i) => [p.prId, i] as const));
  const exemplarIds: { prId: number; side: 'slow' | 'fast'; sizeBand: string }[] = [];
  for (const band of flow.sizeBands ?? []) {
    const inBand = all.filter(
      (p) =>
        p.lines != null &&
        p.lines >= band.minLines &&
        (band.maxLines == null || p.lines <= band.maxLines),
    );
    if (inBand.length < EXEMPLAR_BAND_MIN) continue;
    const slow = inBand[inBand.length - 1]!;
    const fast = inBand[0]!;
    exemplarIds.push({ prId: slow.prId, side: 'slow', sizeBand: band.label });
    exemplarIds.push({ prId: fast.prId, side: 'fast', sizeBand: band.label });
    // An exemplar is always citable, so it is always a row.
    take(index.get(slow.prId)!);
    take(index.get(fast.prId)!);
  }

  const exemplars: FlowPointerExemplar[] = [];
  if (exemplarIds.length > 0) {
    const ids = exemplarIds.map((e) => e.prId);
    const lanes = await resolveActorLanes(accountId, scope);
    const isHuman = (u: number | null): boolean => u != null && lanes.laneOf(u) === 'human';
    const prRows = await db
      .select({ id: pullRequests.id, authorId: pullRequests.authorId, body: pullRequests.body })
      .from(pullRequests)
      .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, ids)))
      .execute();
    const authorOf = new Map(prRows.map((r) => [r.id, r.authorId] as const));
    const bodyOf = new Map(prRows.map((r) => [r.id, r.body] as const));
    // The first thing a person other than the author SAID, from all three places a review is said.
    const said = new Map<number, { at: number; body: string }>();
    const offer = (prId: number, authorId: number | null, at: Date | null, body: string | null): void => {
      if (at == null || body == null || body.trim() === '') return;
      if (!isHuman(authorId) || authorId === authorOf.get(prId)) return;
      const cur = said.get(prId);
      if (cur == null || at.getTime() < cur.at) said.set(prId, { at: at.getTime(), body });
    };
    // Only ids that passed the account check above can have texts read for them.
    const owned = [...authorOf.keys()];
    if (owned.length > 0) {
      for (const r of await db
        .select({ prId: reviewComments.prId, authorId: reviewComments.authorId, at: reviewComments.createdAt, body: reviewComments.body })
        .from(reviewComments)
        .where(inArray(reviewComments.prId, owned))
        .execute()) {
        offer(r.prId, r.authorId, r.at, r.body);
      }
      for (const r of await db
        .select({ prId: prComments.prId, authorId: prComments.authorId, at: prComments.createdAt, body: prComments.body })
        .from(prComments)
        .where(inArray(prComments.prId, owned))
        .execute()) {
        offer(r.prId, r.authorId, r.at, r.body);
      }
      for (const r of await db
        .select({ prId: reviews.prId, authorId: reviews.authorId, at: reviews.submittedAt, body: reviews.body })
        .from(reviews)
        .where(inArray(reviews.prId, owned))
        .execute()) {
        offer(r.prId, r.authorId, r.at, r.body);
      }
    }
    for (const e of exemplarIds) {
      if (!authorOf.has(e.prId)) continue;
      exemplars.push({
        ...e,
        firstReview: cleanEvidenceText(said.get(e.prId)?.body),
        description: cleanEvidenceText(bodyOf.get(e.prId)),
      });
    }
  }

  const rows = [...picked.values()].sort(
    (a, b) => b.leadWorkHours - a.leadWorkHours || a.prId - b.prId,
  );
  return {
    workspaceId: flow.workspaceId,
    windowDays: flow.windowDays,
    measuredPrs: flow.measuredPrs,
    settings,
    budgets: flow.budgets ?? [],
    contrast: flow.contrast ?? null,
    sizeBands: flow.sizeBands ?? [],
    weekdays: flow.weekdays ?? [],
    landing:
      flow.landingTail == null
        ? null
        : {
            prsOver: flow.landingTail.prsOver,
            shareOfLanding: flow.landingTail.shareOfLanding,
            selfMergedOver: flow.landingTail.selfMergedOver,
          },
    concentration: flow.concentration ?? [],
    requests: flow.requests ?? null,
    rows,
    rowsCapped: rows.length < flow.measuredPrs,
    exemplars,
  };
}
