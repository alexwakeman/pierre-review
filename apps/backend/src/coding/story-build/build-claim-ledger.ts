// THE STORY-BUILD CLAIM LEDGER (`story_build_claim_lines`, migration 0194; docs/STORY-BUILD.md § The team
// claim). The DB half of "never leave our line pending" — the twin of the review and dependency ledgers
// (review/claude-review/team-claim-ledger.ts, merge/deps-claim-ledger.ts): every line a story build of this
// machine posts is written here BEFORE it is posted and moved on after every write, so a restart, a crash
// or a final write GitHub did not take leaves a row the reconciler (build-claim-release.ts) can still find.
// DB only — no GitHub call ever runs in here.
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { BUILD_CLAIM_CONTEXT, anchorKey } from './build-claim.js';

const { storyBuildClaimLines: t } = schema;

export type BuildClaimLineState = 'claiming' | 'pending' | 'finished' | 'released';
export const OPEN_BUILD_CLAIM_STATES: readonly BuildClaimLineState[] = ['claiming', 'pending'];
/** After this many failed writes a row is left (logged) and out of the reconciler's read. */
export const BUILD_CLAIM_RELEASE_MAX_ATTEMPTS = 5;

export interface BuildClaimLineRow {
  id: number;
  accountId: number;
  buildId: number | null;
  workspaceId: number | null;
  ident: string | null;
  kind: 'build' | 'review';
  context: string;
  owner: string;
  name: string;
  branch: string | null;
  headSha: string;
  provider: string | null;
  whose: 'mine' | 'teammate';
  state: BuildClaimLineState;
  login: string | null;
  lastDescription: string | null;
  finalDescription: string | null;
  lastPostedAt: Date | null;
  releaseAttempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type BuildClaimLinePatch = Partial<
  Pick<BuildClaimLineRow, 'state' | 'headSha' | 'lastDescription' | 'finalDescription' | 'lastPostedAt' | 'releaseAttempts' | 'lastError'>
>;

const clip = (s: string | null | undefined): string | null => (s == null ? null : s.slice(0, 300));

/** The INTENT, written before the line (and, for a build, its placeholder) goes up ('claiming'). */
export async function recordBuildClaimIntent(row: {
  accountId: number;
  buildId: number | null;
  workspaceId: number | null;
  ident: string | null;
  kind: 'build' | 'review';
  context: string;
  owner: string;
  name: string;
  branch: string | null;
  headSha: string;
  provider?: string | null;
  login: string;
}): Promise<number> {
  const now = new Date();
  const [ins] = await db
    .insert(t)
    .values({
      accountId: row.accountId,
      buildId: row.buildId,
      workspaceId: row.workspaceId,
      ident: row.ident,
      kind: row.kind,
      context: row.context,
      owner: row.owner,
      name: row.name,
      branch: row.branch,
      headSha: row.headSha,
      provider: row.provider ?? null,
      whose: 'mine',
      state: 'claiming',
      login: row.login,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: t.id })
    .execute();
  return ins!.id;
}

/** Move an OPEN row on; a closed row ('finished' / 'released') is never reopened. */
export async function updateBuildClaimLine(id: number, patch: BuildClaimLinePatch): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    set[k] = k === 'lastError' || k === 'lastDescription' || k === 'finalDescription' ? clip(v as string | null) : v;
  }
  await db
    .update(t)
    .set(set)
    .where(and(eq(t.id, id), inArray(t.state, [...OPEN_BUILD_CLAIM_STATES])))
    .execute();
}

/** This machine's open rows the reconciler may still try, oldest first, capped (given-up rows left out). */
export async function openBuildClaimLines(limit = 50): Promise<BuildClaimLineRow[]> {
  return (await db
    .select()
    .from(t)
    .where(and(eq(t.whose, 'mine'), inArray(t.state, [...OPEN_BUILD_CLAIM_STATES]), lt(t.releaseAttempts, BUILD_CLAIM_RELEASE_MAX_ATTEMPTS)))
    .orderBy(asc(t.id))
    .limit(limit)
    .execute()) as BuildClaimLineRow[];
}

/** This machine's open BUILD rows of one build (a session holds at most one). */
export async function openBuildRowsOf(accountId: number, buildId: number): Promise<BuildClaimLineRow[]> {
  return (await db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.buildId, buildId), eq(t.kind, 'build'), eq(t.whose, 'mine'), inArray(t.state, [...OPEN_BUILD_CLAIM_STATES])))
    .orderBy(asc(t.id))
    .execute()) as BuildClaimLineRow[];
}

/** The heads this machine's build claims hang on, open or not (the fold leaves them out: the session speaks). */
export async function ownBuildHeads(accountId: number): Promise<Set<string>> {
  const rows = (await db
    .select({ owner: t.owner, name: t.name, headSha: t.headSha, state: t.state })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.kind, 'build'), eq(t.whose, 'mine'), inArray(t.state, [...OPEN_BUILD_CLAIM_STATES])))
    .execute()) as Array<{ owner: string; name: string; headSha: string }>;
  return new Set(rows.map((r) => anchorKey(r.owner, r.name, r.headSha)));
}

/** Any build row of this machine (open or closed) whose placeholder sat at this head of this branch. */
export async function ownBuildRowAt(accountId: number, owner: string, name: string, branch: string, sha: string): Promise<BuildClaimLineRow | null> {
  const rows = (await db
    .select()
    .from(t)
    .where(
      and(
        eq(t.accountId, accountId),
        eq(t.kind, 'build'),
        eq(t.whose, 'mine'),
        sql`lower(${t.owner}) = ${owner.toLowerCase()}`,
        sql`lower(${t.name}) = ${name.toLowerCase()}`,
        eq(t.branch, branch),
        eq(t.headSha, sha),
      ),
    )
    .orderBy(sql`${t.id} desc`)
    .limit(1)
    .execute()) as BuildClaimLineRow[];
  return rows[0] ?? null;
}

/** Record a teammate's line this machine released (a Clear of their lapsed claim). Once. */
export async function recordTeammateBuildRelease(row: {
  accountId: number;
  workspaceId: number | null;
  ident: string | null;
  owner: string;
  name: string;
  branch: string | null;
  headSha: string;
  login: string;
  description: string;
  lastError: string | null;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(t)
    .values({
      accountId: row.accountId,
      buildId: null,
      workspaceId: row.workspaceId,
      ident: row.ident,
      kind: 'build',
      context: BUILD_CLAIM_CONTEXT,
      owner: row.owner,
      name: row.name,
      branch: row.branch,
      headSha: row.headSha,
      whose: 'teammate',
      state: 'released',
      login: row.login,
      lastDescription: clip(row.description),
      lastPostedAt: row.lastError == null ? now : null,
      lastError: clip(row.lastError),
      createdAt: now,
      updatedAt: now,
    })
    .execute();
}
