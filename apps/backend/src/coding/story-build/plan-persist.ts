// PLAN FIRST STORAGE (`story_build_plans` + `story_build_prs`, migration 0179; docs/STORY-BUILD.md § Plan
// first → Data model). EVERY read and write is scoped by accountId: another account's build reads as
// nothing and writes nothing. Writes that must land together (Approve: the approved revision and the
// planned PR rows) go through `runTransaction`, with DB work only inside.
//
// THE DECISION LOG: each revision row holds its own answers (`decisions_json`) and the replies sent from
// it (`replies_json`). A new revision copies the previous one's answers for every contention whose id AND
// fingerprint are unchanged (`carryDecisions`); a changed point is unanswered again.
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  buildPlanUnanswered,
  type BuildPlanDecision,
  type BuildPlanRevision,
  type BuildPlanSource,
  type BuildPlanStage,
  type BuildPlanView,
  type StoryBuildPr,
  type StoryBuildPrStatus,
} from '@pierre-review/shared';
import type { storyBuildPlans, storyBuildPrs } from '../../db/schema.sqlite.js';
import type { AgentContext } from '../../review/agent-context.js';

type Ctx = Pick<AgentContext, 'db' | 'schema'> & Partial<Pick<AgentContext, 'runTransaction'>>;

/* eslint-disable @typescript-eslint/no-explicit-any */
const P = (ctx: Pick<AgentContext, 'schema'>): any => (ctx.schema as any).storyBuildPlans;
const PR = (ctx: Pick<AgentContext, 'schema'>): any => (ctx.schema as any).storyBuildPrs;
const B = (ctx: Pick<AgentContext, 'schema'>): any => (ctx.schema as any).storyBuilds;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type StoredDecisions = Record<string, { decision: BuildPlanDecision; fingerprint: string; at: string }>;
export type StoredReplies = Array<{ contentionId: string | null; text: string; at: string }>;

export type StoryBuildPlanRow = Omit<typeof storyBuildPlans.$inferSelect, 'source' | 'decisionsJson' | 'repliesJson'> & {
  source: BuildPlanSource;
  decisionsJson: StoredDecisions | null;
  repliesJson: StoredReplies | null;
};
export type StoryBuildPrRow = Omit<typeof storyBuildPrs.$inferSelect, 'status'> & { status: StoryBuildPrStatus };

async function tx<T>(ctx: Ctx, fn: (db: AgentContext['db']) => Promise<T>): Promise<T> {
  if (ctx.runTransaction) return ctx.runTransaction((t) => fn(t as AgentContext['db']));
  return fn(ctx.db);
}

// ---- revisions ------------------------------------------------------------------------------------------

export async function listPlanRows(ctx: Ctx, accountId: number, buildId: number): Promise<StoryBuildPlanRow[]> {
  const p = P(ctx);
  return (await ctx.db
    .select()
    .from(p)
    .where(and(eq(p.accountId, accountId), eq(p.buildId, buildId)))
    .orderBy(asc(p.revision))
    .execute()) as StoryBuildPlanRow[];
}

export async function latestPlanRow(ctx: Ctx, accountId: number, buildId: number): Promise<StoryBuildPlanRow | null> {
  const p = P(ctx);
  const rows = (await ctx.db
    .select()
    .from(p)
    .where(and(eq(p.accountId, accountId), eq(p.buildId, buildId)))
    .orderBy(desc(p.revision))
    .limit(1)
    .execute()) as StoryBuildPlanRow[];
  return rows[0] ?? null;
}

export async function getPlanRow(ctx: Ctx, accountId: number, buildId: number, revision: number): Promise<StoryBuildPlanRow | null> {
  const p = P(ctx);
  const rows = (await ctx.db
    .select()
    .from(p)
    .where(and(eq(p.accountId, accountId), eq(p.buildId, buildId), eq(p.revision, revision)))
    .limit(1)
    .execute()) as StoryBuildPlanRow[];
  return rows[0] ?? null;
}

/** The previous revision's answers that still apply: same contention id AND fingerprint. Pure. */
export function carryDecisions(prev: StoredDecisions | null, next: Pick<BuildPlanRevision, 'contentions'>): StoredDecisions {
  const out: StoredDecisions = {};
  if (prev == null) return out;
  for (const c of next.contentions) {
    const d = prev[c.id];
    if (d && d.fingerprint === c.fingerprint) out[c.id] = d;
  }
  return out;
}

/** A new revision (number = latest + 1), its answers carried forward. Returns the stored row. */
export async function insertPlanRevision(
  ctx: Ctx,
  a: { accountId: number; buildId: number; source: BuildPlanSource; plan: Omit<BuildPlanRevision, 'revision' | 'createdAt' | 'source'>; rawSha: string; now: Date },
): Promise<StoryBuildPlanRow> {
  return tx(ctx, async (db) => {
    const p = P(ctx);
    const prevRows = (await db
      .select()
      .from(p)
      .where(and(eq(p.accountId, a.accountId), eq(p.buildId, a.buildId)))
      .orderBy(desc(p.revision))
      .limit(1)
      .execute()) as StoryBuildPlanRow[];
    const prev = prevRows[0] ?? null;
    const planJson = { ...a.plan, source: a.source };
    const rows = (await db
      .insert(p)
      .values({
        accountId: a.accountId,
        buildId: a.buildId,
        revision: (prev?.revision ?? 0) + 1,
        source: a.source,
        planJson,
        rawSha: a.rawSha,
        decisionsJson: carryDecisions(prev?.decisionsJson ?? null, a.plan),
        repliesJson: [],
        createdAt: a.now,
      })
      .returning()
      .execute()) as StoryBuildPlanRow[];
    return rows[0]!;
  });
}

/** Set or clear one answer on a revision. False when the row is not this account's. */
export async function setPlanDecision(
  ctx: Ctx,
  accountId: number,
  planId: number,
  contentionId: string,
  value: { decision: BuildPlanDecision; fingerprint: string; at: string } | null,
): Promise<boolean> {
  return tx(ctx, async (db) => {
    const p = P(ctx);
    const rows = (await db.select().from(p).where(and(eq(p.id, planId), eq(p.accountId, accountId))).limit(1).execute()) as StoryBuildPlanRow[];
    const row = rows[0];
    if (!row) return false;
    const next: StoredDecisions = { ...(row.decisionsJson ?? {}) };
    if (value == null) delete next[contentionId];
    else next[contentionId] = value;
    await db.update(p).set({ decisionsJson: next }).where(and(eq(p.id, planId), eq(p.accountId, accountId))).execute();
    return true;
  });
}

export async function appendPlanReply(ctx: Ctx, accountId: number, planId: number, reply: StoredReplies[number]): Promise<boolean> {
  return tx(ctx, async (db) => {
    const p = P(ctx);
    const rows = (await db.select().from(p).where(and(eq(p.id, planId), eq(p.accountId, accountId))).limit(1).execute()) as StoryBuildPlanRow[];
    const row = rows[0];
    if (!row) return false;
    await db
      .update(p)
      .set({ repliesJson: [...(row.repliesJson ?? []), reply] })
      .where(and(eq(p.id, planId), eq(p.accountId, accountId)))
      .execute();
    return true;
  });
}

/** A stored row → the wire revision. */
export function toPlanRevision(row: StoryBuildPlanRow): BuildPlanRevision {
  const { source: _s, ...plan } = row.planJson as Omit<BuildPlanRevision, 'revision' | 'createdAt'>;
  return { ...plan, revision: row.revision, source: row.source, createdAt: new Date(row.createdAt).toISOString() };
}

const publicDecisions = (d: StoredDecisions | null): BuildPlanView['decisions'] =>
  Object.fromEntries(Object.entries(d ?? {}).map(([k, v]) => [k, { decision: v.decision, at: v.at }]));

export { publicDecisions };

/**
 * THE wire view of a session's plan stage (`StoryBuildSession.plan`). `stage` is the session's own word
 * (session_json.planStage); `approvedPlanId` from the build row. Pure on the rows.
 */
export function toPlanView(
  rows: readonly StoryBuildPlanRow[],
  o: { stage: BuildPlanStage; problem: string | null; withDocs: boolean; fillGaps: boolean; approvedPlanId: number | null; approvedAt: Date | null },
): BuildPlanView {
  const last = rows[rows.length - 1] ?? null;
  const latest = last ? toPlanRevision(last) : null;
  const decisions = publicDecisions(last?.decisionsJson ?? null);
  const approved = o.approvedPlanId != null ? rows.find((r) => r.id === o.approvedPlanId) ?? null : null;
  return {
    latest,
    revisions: rows.length,
    decisions,
    replies: rows.flatMap((r) => (r.repliesJson ?? []).map((x) => ({ ...x, revision: r.revision }))),
    unanswered: buildPlanUnanswered(latest, decisions),
    approvedRevision: approved?.revision ?? null,
    approvedAt: approved && o.approvedAt ? new Date(o.approvedAt).toISOString() : null,
    status: approved ? 'approved' : o.stage,
    problem: o.problem,
    withDocs: o.withDocs,
    fillGaps: o.fillGaps,
  };
}

// ---- approve: the approved revision + the planned PR rows, together -------------------------------------

export interface ApproveArgs {
  accountId: number;
  buildId: number;
  plan: StoryBuildPlanRow;
  now: Date;
}

/**
 * Approve: in ONE transaction, the build row names the approved revision and one `story_build_prs` row per
 * planned PR is written (status `planned`). False when the build is not this account's, or already approved.
 */
export async function approvePlanRevision(ctx: Ctx, a: ApproveArgs): Promise<boolean> {
  const revision = toPlanRevision(a.plan);
  return tx(ctx, async (db) => {
    const b = B(ctx);
    const pr = PR(ctx);
    const rows = (await db
      .select({ id: b.id, approvedPlanId: b.approvedPlanId })
      .from(b)
      .where(and(eq(b.id, a.buildId), eq(b.accountId, a.accountId)))
      .limit(1)
      .execute()) as Array<{ id: number; approvedPlanId: number | null }>;
    if (rows.length === 0 || rows[0]!.approvedPlanId != null) return false;
    await db.update(b).set({ approvedPlanId: a.plan.id, approvedAt: a.now }).where(and(eq(b.id, a.buildId), eq(b.accountId, a.accountId))).execute();
    for (const [position, p] of revision.stack.entries()) {
      await db
        .insert(pr)
        .values({
          accountId: a.accountId,
          buildId: a.buildId,
          repoId: p.repoId,
          planId: a.plan.id,
          prKey: p.key,
          position,
          stackIndex: p.stackIndex,
          dependsOnJson: p.dependsOn,
          criteriaJson: p.criteria,
          title: p.title,
          contains: p.contains,
          branch: p.branch,
          status: 'planned',
          createdAt: a.now,
          updatedAt: a.now,
        })
        .execute();
    }
    return true;
  });
}

// ---- planned PRs -------------------------------------------------------------------------------------------

export async function listPlannedPrRows(ctx: Ctx, accountId: number, buildId: number): Promise<StoryBuildPrRow[]> {
  const pr = PR(ctx);
  return (await ctx.db
    .select()
    .from(pr)
    .where(and(eq(pr.accountId, accountId), eq(pr.buildId, buildId)))
    .orderBy(asc(pr.position))
    .execute()) as StoryBuildPrRow[];
}

/** One planned PR of this account's build, or null (another account's id, another build's PR). */
export async function getStoryBuildPrRow(ctx: Ctx, accountId: number, buildId: number, prId: number): Promise<StoryBuildPrRow | null> {
  const pr = PR(ctx);
  const rows = (await ctx.db
    .select()
    .from(pr)
    .where(and(eq(pr.id, prId), eq(pr.accountId, accountId), eq(pr.buildId, buildId)))
    .limit(1)
    .execute()) as StoryBuildPrRow[];
  return rows[0] ?? null;
}

export async function updateStoryBuildPr(ctx: Ctx, accountId: number, prId: number, set: Partial<Omit<StoryBuildPrRow, 'id' | 'accountId' | 'buildId' | 'repoId' | 'planId'>>): Promise<boolean> {
  const pr = PR(ctx);
  const rows = (await ctx.db
    .update(pr)
    .set({ ...set, updatedAt: set.updatedAt ?? new Date() })
    .where(and(eq(pr.id, prId), eq(pr.accountId, accountId)))
    .returning({ id: pr.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

/** A row → the wire PR (never the patch). */
export function toStoryBuildPr(row: StoryBuildPrRow, fullName: string): StoryBuildPr {
  return {
    id: row.id,
    key: row.prKey,
    repoId: row.repoId,
    fullName,
    position: row.position,
    stackIndex: row.stackIndex,
    title: row.title,
    contains: row.contains,
    criteria: row.criteriaJson ?? [],
    dependsOn: row.dependsOnJson ?? [],
    branch: row.branch,
    status: row.status,
    error: row.error ?? null,
    stat: row.statJson ?? null,
    filesChanged: row.filesChangedJson ?? [],
    summary: row.summary ?? null,
    checks: row.checksJson?.checks ?? null,
    reported: row.checksJson?.status ?? null,
    pushedBranch: row.pushedBranch ?? null,
    pushedPrNumber: row.pushedPrNumber ?? null,
    pushedPrUrl: row.pushedPrUrl ?? null,
    pushError: row.pushError ?? null,
  };
}
