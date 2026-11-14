// THE DEPENDENCY CLAIM LEDGER (`deps_claim_lines`, migration 0193; docs/MERGE-CI-TRUNK.md § Team claims
// for dependency work). The DB half of "never leave our `limn/deps` line pending" — the twin of the
// review claims' ledger (review/claude-review/team-claim-ledger.ts): every line this machine posts is
// written here BEFORE it is posted and moved on after every write, so a restart, a crash or a final
// write GitHub did not take leaves a row the reconciler (deps-claim-release.ts) can still find. DB
// only — no GitHub call ever runs in here.
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { ClaimAction, DepsClaimLedger, DepsLedgerPatch } from './deps-claim.js';

const { depsClaimLines: t, pullRequests } = schema;

export type DepsLineState = 'claiming' | 'pending' | 'armed' | 'finished' | 'released';
export const OPEN_DEPS_LINE_STATES: readonly DepsLineState[] = ['claiming', 'pending', 'armed'];
/** After this many failed writes a row is left (logged) and out of the reconciler's read. */
export const DEPS_RELEASE_MAX_ATTEMPTS = 5;

export type DepsLineAction = ClaimAction | 'ai_pushed';

export interface DepsLineRow {
  id: number;
  accountId: number;
  prId: number;
  repoId: number | null;
  owner: string | null;
  name: string | null;
  headSha: string;
  action: string;
  whose: 'mine' | 'teammate';
  state: DepsLineState;
  login: string | null;
  lastDescription: string | null;
  finalDescription: string | null;
  lastPostedAt: Date | null;
  releaseAttempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const clip = (s: string | null | undefined): string | null => (s == null ? null : s.slice(0, 300));

/**
 * The INTENT, written before the line is posted ('claiming'). Our new line replaces any older open row
 * of ours for the same (PR, head, action) — closed as 'released' ("superseded"). Returns the row id.
 */
export async function recordDepsClaimIntent(row: {
  accountId: number;
  prId: number;
  owner: string;
  name: string;
  headSha: string;
  action: DepsLineAction;
  login: string;
}): Promise<number> {
  const repo = (
    await db
      .select({ repoId: pullRequests.repoId })
      .from(pullRequests)
      .where(and(eq(pullRequests.id, row.prId), eq(pullRequests.accountId, row.accountId)))
      .limit(1)
      .execute()
  )[0];
  const now = new Date();
  // Two DB statements, no network.
  await db
    .update(t)
    .set({ state: 'released', lastError: 'superseded', updatedAt: now })
    .where(
      and(
        eq(t.accountId, row.accountId),
        eq(t.prId, row.prId),
        eq(t.headSha, row.headSha),
        eq(t.action, row.action),
        eq(t.whose, 'mine'),
        inArray(t.state, [...OPEN_DEPS_LINE_STATES]),
      ),
    )
    .execute();
  const [ins] = await db
    .insert(t)
    .values({
      accountId: row.accountId,
      prId: row.prId,
      repoId: repo?.repoId ?? null,
      owner: row.owner,
      name: row.name,
      headSha: row.headSha,
      action: row.action,
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
export async function updateDepsClaimLine(
  id: number,
  patch: DepsLedgerPatch & { releaseAttempts?: number },
  opts: { anyState?: boolean } = {},
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    set[k] = k === 'lastError' || k === 'lastDescription' || k === 'finalDescription' ? clip(v as string | null) : v;
  }
  await db
    .update(t)
    .set(set)
    .where(opts.anyState ? eq(t.id, id) : and(eq(t.id, id), inArray(t.state, [...OPEN_DEPS_LINE_STATES])))
    .execute();
}

/** The ledger the dependency automation's claims write through (deps-claim.ts `DepsClaimLedger`). */
export const dbDepsClaimLedger: DepsClaimLedger = {
  intent: (target, login) =>
    recordDepsClaimIntent({
      accountId: target.accountId,
      prId: target.prId,
      owner: target.owner,
      name: target.name,
      headSha: target.headSha,
      action: target.action,
      login,
    }),
  update: (id, patch) => updateDepsClaimLine(id, patch),
};

/** This machine's open rows the reconciler may still try, oldest first, capped. A row that used up its
 *  attempts is left out, so given-up rows never fill the window. */
export async function openDepsClaimLines(limit = 50): Promise<DepsLineRow[]> {
  return (await db
    .select()
    .from(t)
    .where(and(eq(t.whose, 'mine'), inArray(t.state, [...OPEN_DEPS_LINE_STATES]), lt(t.releaseAttempts, DEPS_RELEASE_MAX_ATTEMPTS)))
    .orderBy(asc(t.id))
    .limit(limit)
    .execute()) as DepsLineRow[];
}

/** This machine's newest rebase-ask row at a head (gap d: re-posting it as open to teammates). */
export async function ownRebaseLineAt(accountId: number, prId: number, headSha: string): Promise<DepsLineRow | null> {
  const rows = (await db
    .select()
    .from(t)
    .where(
      and(
        eq(t.accountId, accountId),
        eq(t.prId, prId),
        eq(t.headSha, headSha),
        eq(t.action, 'rebase_request'),
        eq(t.whose, 'mine'),
      ),
    )
    .orderBy(sql`${t.id} desc`)
    .limit(1)
    .execute()) as DepsLineRow[];
  return rows[0] ?? null;
}

/** Has this machine already released `login`'s expired line at this head (posted once, never again)? */
export async function teammateDepsLineReleased(accountId: number, prId: number, headSha: string, login: string): Promise<boolean> {
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.accountId, accountId),
        eq(t.prId, prId),
        eq(t.headSha, headSha),
        eq(t.whose, 'teammate'),
        sql`lower(${t.login}) = ${login.toLowerCase()}`,
      ),
    )
    .limit(1)
    .execute();
  return rows.length > 0;
}

/** Record a teammate's expired line this machine released (or tried to: `lastError`). Once. */
export async function recordTeammateDepsRelease(row: {
  accountId: number;
  prId: number;
  owner: string;
  name: string;
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
      prId: row.prId,
      owner: row.owner,
      name: row.name,
      headSha: row.headSha,
      action: 'release',
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
