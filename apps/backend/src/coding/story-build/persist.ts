import { and, desc, eq, inArray, asc, notInArray } from 'drizzle-orm';
import {
  aiRunProvider,
  isFlowDiagram,
  isLegacyDesignDiagram,
  isStoryBuildOpen,
  isStoryBuildRunning,
  storyBuildDocsEffectiveDecisions,
  type StoryBuild,
  type StoryBuildCandidate,
  type StoryBuildDocsStatus,
  type StoryBuildPhase,
  type StoryBuildRepo,
  type StoryBuildRepoStatus,
  type StoryBuildStatus,
  type StoryBuildSummary,
  type StoryDocsCriteriaSource,
  type StoryDocsCriterion,
} from '@pierre-review/shared';
import type { storyBuildRepos, storyBuilds } from '../../db/schema.sqlite.js';
import type { AgentContext } from '../../review/agent-context.js';

// "IMPLEMENT STORY" STORAGE (`story_builds` + `story_build_repos`, migration 0149; docs/STORY-BUILD.md
// § Data model). EVERY read and write is scoped by accountId: an id from another account reads as null and
// writes nothing (routes answer 404). Portable terminals only (`.execute()`, `.returning().execute()`).
//
// The WIRE mapper (`toStoryBuild`) is the ONE place a row becomes `StoryBuild`: it never carries a patch,
// the frozen prompt seed (`seed_json`) or a worktree path.

type Ctx = Pick<AgentContext, 'db' | 'schema'>;

/* eslint-disable @typescript-eslint/no-explicit-any */
const B = (ctx: Pick<AgentContext, 'schema'>): any => (ctx.schema as any).storyBuilds;
const R = (ctx: Pick<AgentContext, 'schema'>): any => (ctx.schema as any).storyBuildRepos;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---- row types ------------------------------------------------------------------------------------

type BuildSelect = typeof storyBuilds.$inferSelect;
type RepoSelect = typeof storyBuildRepos.$inferSelect;

/** A `story_builds` row as read (status/phase/criteria words narrowed to the shared vocabulary). */
export type StoryBuildRow = Omit<BuildSelect, 'status' | 'phase' | 'docsStatus' | 'criteriaSource' | 'seedJson'> & {
  status: StoryBuildStatus;
  phase: StoryBuildPhase | null;
  docsStatus: StoryBuildDocsStatus;
  criteriaSource: StoryDocsCriteriaSource | null;
  seedJson: StoryBuildSeed | null;
};

/** A `story_build_repos` row as read. */
export type StoryBuildRepoRow = Omit<RepoSelect, 'status'> & { status: StoryBuildRepoStatus };

/** Columns a writer may set on a session (never id / accountId / workspaceId / ident). */
export type StoryBuildSet = Partial<Omit<StoryBuildRow, 'id' | 'accountId' | 'workspaceId' | 'ident' | 'createdAt'>>;
/** Columns a writer may set on a repository row (never id / accountId / buildId / repoId). */
export type StoryBuildRepoSet = Partial<Omit<StoryBuildRepoRow, 'id' | 'accountId' | 'buildId' | 'repoId'>>;

/**
 * THE FROZEN PROMPT INPUTS (`story_builds.seed_json`), written once at assess time so every later pass
 * (chat re-plans, the build) reads the SAME story the plan was made from. UNTRUSTED text throughout —
 * every field is fenced (nonce) when it reaches a prompt. NEVER on the wire. WP1 (inputs.ts) writes it;
 * extra fields are additive (bump `version` on a change of meaning).
 */
export interface StoryBuildSeed {
  version: 1;
  story: { key: string; title: string; text: string; url: string | null };
  criteria: StoryDocsCriterion[];
  /** The ticket's comments, already folded to plain text (TRACKERS § Ticket comments); null when none. */
  comments: string | null;
  /** Contribution cards of the ticket's existing PRs ("already delivered" context). */
  cards: Array<{ prId: number; repoId: number; number: number; text: string }>;
}

// ---- reads (account-scoped) -------------------------------------------------------------------------

/** One session, or null when it is not this account's. */
export async function getStoryBuildRow(ctx: Ctx, accountId: number, id: number): Promise<StoryBuildRow | null> {
  const b = B(ctx);
  const rows = (await ctx.db
    .select()
    .from(b)
    .where(and(eq(b.id, id), eq(b.accountId, accountId)))
    .limit(1)
    .execute()) as StoryBuildRow[];
  return rows[0] ?? null;
}

/** The ticket's sessions, newest first (≤ `limit`). */
export async function listStoryBuildRowsFor(
  ctx: Ctx,
  accountId: number,
  workspaceId: number,
  ident: string,
  limit = 20,
): Promise<StoryBuildRow[]> {
  const b = B(ctx);
  return (await ctx.db
    .select()
    .from(b)
    .where(and(eq(b.accountId, accountId), eq(b.workspaceId, workspaceId), eq(b.ident, ident)))
    .orderBy(desc(b.id))
    .limit(limit)
    .execute()) as StoryBuildRow[];
}

/** A session's repository rows, in BUILD ORDER. [] for a session that is not this account's. */
export async function listStoryBuildRepoRows(ctx: Ctx, accountId: number, buildId: number): Promise<StoryBuildRepoRow[]> {
  const r = R(ctx);
  return (await ctx.db
    .select()
    .from(r)
    .where(and(eq(r.buildId, buildId), eq(r.accountId, accountId)))
    .orderBy(asc(r.buildOrder), asc(r.id))
    .execute()) as StoryBuildRepoRow[];
}

/** One repository row of a session, by REPO id (the route's `:repoId`), or null. */
export async function getStoryBuildRepoRow(ctx: Ctx, accountId: number, buildId: number, repoId: number): Promise<StoryBuildRepoRow | null> {
  const r = R(ctx);
  const rows = (await ctx.db
    .select()
    .from(r)
    .where(and(eq(r.buildId, buildId), eq(r.repoId, repoId), eq(r.accountId, accountId)))
    .limit(1)
    .execute()) as StoryBuildRepoRow[];
  return rows[0] ?? null;
}

/** owner/name per repo id (this account's repos only). */
export async function storyBuildRepoNames(ctx: Ctx, accountId: number, repoIds: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (repoIds.length === 0) return out;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const repos = (ctx.schema as any).repos;
  const rows = (await ctx.db
    .select({ id: repos.id, owner: repos.owner, name: repos.name })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), inArray(repos.id, [...new Set(repoIds)])))
    .execute()) as Array<{ id: number; owner: string; name: string }>;
  for (const x of rows) out.set(x.id, `${x.owner}/${x.name}`);
  return out;
}

// ---- writes -----------------------------------------------------------------------------------------

export interface InsertStoryBuildArgs {
  accountId: number;
  workspaceId: number;
  ident: string;
  ticketKey: string;
  ticketTitle: string | null;
  wantDiagram: boolean;
  wantDocs: boolean;
  /** What the first pass is expected to run on (`expectedRanOn` / the manual pick). */
  provider: string | null;
  model: string | null;
}

export type InsertStoryBuildOutcome = { outcome: 'started'; id: number } | { outcome: 'already_open'; id: number };

/**
 * THE CLAIM: insert a session in `assessing`. ONE OPEN SESSION PER TICKET is the partial unique index
 * `story_builds_one_open`: a second click while one is open answers that session's id (`already_open`),
 * never a second row. better-sqlite3 runs the insert synchronously, so two racing clicks cannot both win.
 * ⚠ The caller sets its in-memory "running" marker in the SAME tick as this returns `started`, before any
 * other await (CLAUDE-REVIEW.md § Plan mode, THE STREAM GAP).
 */
export async function insertStoryBuild(ctx: Ctx, a: InsertStoryBuildArgs): Promise<InsertStoryBuildOutcome> {
  const b = B(ctx);
  try {
    const rows = (await ctx.db
      .insert(b)
      .values({
        accountId: a.accountId,
        workspaceId: a.workspaceId,
        ident: a.ident,
        ticketKey: a.ticketKey,
        ticketTitle: a.ticketTitle,
        status: 'assessing' satisfies StoryBuildStatus,
        phase: 'reading_story' satisfies StoryBuildPhase,
        provider: a.provider,
        model: a.model,
        wantDiagram: a.wantDiagram,
        wantDocs: a.wantDocs,
        createdAt: new Date(),
        startedAt: new Date(),
      })
      .returning({ id: b.id })
      .execute()) as Array<{ id: number }>;
    return { outcome: 'started', id: rows[0]!.id };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const open = (await listStoryBuildRowsFor(ctx, a.accountId, a.workspaceId, a.ident, 20)).find((r) => isStoryBuildOpen(r.status));
    if (open == null) throw err;
    return { outcome: 'already_open', id: open.id };
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(String((err as Error)?.message ?? ''));
}

/** Update a session (scoped by account). Returns whether a row was written. */
export async function updateStoryBuild(ctx: Ctx, accountId: number, id: number, set: StoryBuildSet): Promise<boolean> {
  const b = B(ctx);
  const rows = (await ctx.db
    .update(b)
    .set(set)
    .where(and(eq(b.id, id), eq(b.accountId, accountId)))
    .returning({ id: b.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

export interface UpsertStoryBuildRepoArgs {
  accountId: number;
  buildId: number;
  repoId: number;
  ref: string;
  buildOrder: number;
  include: boolean;
  status: StoryBuildRepoStatus;
  baseRef: string;
  baseSha: string;
  stackedOnPrId: number | null;
  branch: string | null;
}

/** Insert or refresh a session's repository row (ON CONFLICT `(build_id, repo_id)`). Returns its id. */
export async function upsertStoryBuildRepo(ctx: Ctx, a: UpsertStoryBuildRepoArgs): Promise<number> {
  const r = R(ctx);
  const values = {
    accountId: a.accountId,
    buildId: a.buildId,
    repoId: a.repoId,
    ref: a.ref,
    buildOrder: a.buildOrder,
    include: a.include,
    status: a.status,
    baseRef: a.baseRef,
    baseSha: a.baseSha,
    stackedOnPrId: a.stackedOnPrId,
    branch: a.branch,
  };
  const rows = (await ctx.db
    .insert(r)
    .values(values)
    .onConflictDoUpdate({
      target: [r.buildId, r.repoId],
      // A separate object from `values` (CLAUDE.md: never share one between insert and `set:`).
      set: { ref: a.ref, buildOrder: a.buildOrder, include: a.include, status: a.status, baseRef: a.baseRef, baseSha: a.baseSha, stackedOnPrId: a.stackedOnPrId, branch: a.branch },
    })
    .returning({ id: r.id })
    .execute()) as Array<{ id: number }>;
  return rows[0]!.id;
}

/** Update one repository row by its OWN id (scoped by account). Returns whether a row was written. */
export async function updateStoryBuildRepo(ctx: Ctx, accountId: number, id: number, set: StoryBuildRepoSet): Promise<boolean> {
  const r = R(ctx);
  const rows = (await ctx.db
    .update(r)
    .set(set)
    .where(and(eq(r.id, id), eq(r.accountId, accountId)))
    .returning({ id: r.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

/**
 * A re-plan dropped these repositories: delete the session's repository rows NOT in `keepRepoIds` (only
 * rows that never built — a plan is re-made only before Accept, so none has). Scoped by account.
 */
export async function deleteStoryBuildRepoRowsExcept(ctx: Ctx, accountId: number, buildId: number, keepRepoIds: readonly number[]): Promise<number> {
  const r = R(ctx);
  const preds = [eq(r.buildId, buildId), eq(r.accountId, accountId)];
  if (keepRepoIds.length > 0) preds.push(notInArray(r.repoId, [...keepRepoIds]));
  const rows = (await ctx.db
    .delete(r)
    .where(and(...preds))
    .returning({ id: r.id })
    .execute()) as Array<{ id: number }>;
  return rows.length;
}

/** The stored patch of one repository (the `…/diff` route; never part of `StoryBuild`). */
export async function getStoryBuildRepoPatch(
  ctx: Ctx,
  accountId: number,
  buildId: number,
  repoId: number,
): Promise<{ baseSha: string; patch: string | null; filesChanged: string[] } | null> {
  const row = await getStoryBuildRepoRow(ctx, accountId, buildId, repoId);
  if (row == null) return null;
  return { baseSha: row.baseSha, patch: row.patch ?? null, filesChanged: row.filesChangedJson ?? [] };
}

// ---- the wire mapper --------------------------------------------------------------------------------

const iso = (d: Date | number | null | undefined): string | null =>
  d == null ? null : (d instanceof Date ? d : new Date(typeof d === 'number' && d < 1e12 ? d * 1000 : d)).toISOString();

const sumOrNull = (xs: ReadonlyArray<number | null | undefined>): number | null => {
  const got = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return got.length === 0 ? null : got.reduce((a, b) => a + b, 0);
};

/** One repository row → wire. `candidate` supplies the one-line base note; `fullName` the repo's name. */
export function toStoryBuildRepo(
  row: StoryBuildRepoRow,
  fullName: string,
  candidate: StoryBuildCandidate | null,
): StoryBuildRepo {
  return {
    id: row.id,
    repoId: row.repoId,
    fullName,
    ref: row.ref,
    include: row.include,
    status: row.status,
    order: row.buildOrder,
    baseRef: row.baseRef,
    baseSha: row.baseSha,
    stackedOnPrId: row.stackedOnPrId ?? null,
    baseNote: candidate?.baseNote ?? null,
    branch: row.branch ?? null,
    summary: row.summary ?? null,
    commitMessage: row.commitMessage ?? null,
    filesChanged: row.filesChangedJson ?? [],
    changeReport: row.changeReportJson ?? null,
    checksWanted: row.checksWantedJson ?? [],
    checks: row.checksJson ?? null,
    hasPatch: row.patch != null && row.patch.length > 0,
    prTitle: row.prTitle ?? null,
    pushedBranch: row.pushedBranch ?? null,
    pushedPrNumber: row.pushedPrNumber ?? null,
    pushedPrUrl: row.pushedPrUrl ?? null,
    pushedCommitSha: row.pushedCommitSha ?? null,
    pushedAt: iso(row.pushedAt),
    pushError: row.pushError ?? null,
    ...(row.model != null || row.provider != null ? { provider: aiRunProvider(row.provider, row.model) } : {}),
    model: row.model ?? null,
    effort: row.effort ?? null,
    costUsd: row.costUsd ?? null,
    numTurns: row.numTurns ?? null,
    error: row.error ?? null,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
  };
}

export interface ToStoryBuildOpts {
  /** owner/name per repo id (`storyBuildRepoNames`); an unknown id reads as `#<id>`. */
  repoNames: ReadonlyMap<number, string>;
  /** STORY_BUILD_SESSION_BUDGET_USD in force (`storyBuildLimits().sessionBudgetUsd`). */
  sessionBudgetUsd: number;
}

/** THE wire mapper. Never a patch, the seed, or a worktree path. */
export function toStoryBuild(row: StoryBuildRow, repoRows: readonly StoryBuildRepoRow[], opts: ToStoryBuildOpts): StoryBuild {
  const candidates = row.candidatesJson ?? [];
  const byRepo = new Map(candidates.map((c) => [c.repoId, c] as const));
  const repos = [...repoRows]
    .sort((a, b) => a.buildOrder - b.buildOrder || a.id - b.id)
    .map((r) => toStoryBuildRepo(r, opts.repoNames.get(r.repoId) ?? byRepo.get(r.repoId)?.fullName ?? `#${r.repoId}`, byRepo.get(r.repoId) ?? null));
  const built = repos.filter((r) => r.include && (r.status === 'ready' || r.status === 'pushed'));
  const running = isStoryBuildRunning(row.status) || row.docsStatus === 'running';
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ident: row.ident,
    ticketKey: row.ticketKey,
    ticketTitle: row.ticketTitle ?? null,
    status: row.status,
    phase: running ? (row.phase ?? null) : null,
    error: row.error ?? null,
    ...(row.model != null || row.provider != null ? { provider: aiRunProvider(row.provider, row.model) } : {}),
    model: row.model ?? null,
    effort: row.effort ?? null,
    wantDiagram: row.wantDiagram,
    wantDocs: row.wantDocs,
    criteriaSource: row.criteriaSource ?? null,
    coverage: row.coverageJson ?? null,
    candidates,
    plan: row.planJson ?? null,
    planRevision: row.planRevision,
    transcript: row.transcriptJson ?? [],
    flow: isFlowDiagram(row.designJson) ? row.designJson : null,
    design: isLegacyDesignDiagram(row.designJson) ? row.designJson : null,
    docsStatus: row.docsStatus,
    docsError: row.docsError ?? null,
    docs: row.docsJson ?? null,
    docsDecisions: storyBuildDocsEffectiveDecisions(row.docsJson ?? null, row.docsDecisionsJson ?? null),
    acceptedRevision: row.acceptedRevision ?? null,
    acceptedDocs: row.acceptedDocsJson ?? null,
    repos,
    planCostUsd: row.planCostUsd ?? null,
    docsCostUsd: row.docsCostUsd ?? null,
    totalCostUsd: sumOrNull([row.planCostUsd, row.docsCostUsd, ...repoRows.map((r) => r.costUsd)]),
    sessionBudgetUsd: opts.sessionBudgetUsd,
    pushedAll: built.length > 0 && built.every((r) => r.status === 'pushed'),
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
  };
}

/** A history row. */
export function toStoryBuildSummary(row: Pick<StoryBuildRow, 'id' | 'status' | 'createdAt'>): StoryBuildSummary {
  return { id: row.id, status: row.status, createdAt: iso(row.createdAt) ?? new Date(0).toISOString() };
}
