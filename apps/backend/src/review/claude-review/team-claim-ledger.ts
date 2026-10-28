// THE TEAM-CLAIM LEDGER (`team_claim_lines`, migration 0138; docs/CLAUDE-REVIEW.md § Team claims →
// Releasing stale lines). The DB half of "never leave our line pending": every claim this machine
// makes is written here BEFORE its pending line is posted, and moved on after every write, so a
// restart, a dropped run or a failed final write leaves a row the reconciler (team-claim-release.ts)
// can still find and release. DB only — no GitHub call ever runs in here.
import type { AiProviderId } from '@pierre-review/shared';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import type { AgentContext } from '../agent-context.js';

export type ClaimLineState = 'claiming' | 'pending' | 'finished' | 'released';
export const OPEN_CLAIM_STATES: readonly ClaimLineState[] = ['claiming', 'pending'];
/** After this many failed releases a row is left (logged) — and out of the reconciler's read; the tab's
 *  Clear still finds it (`openClaimLinesAtHead`). */
export const RELEASE_MAX_ATTEMPTS = 5;

export interface ClaimLineRow {
  id: number;
  accountId: number;
  prId: number;
  repoId: number | null;
  // The repo's owner/name when the row was written: a line can still be released after the PR or the
  // repo is gone from Limn (NULL on a row backfilled where the repo was unknown).
  owner: string | null;
  name: string | null;
  headSha: string;
  provider: AiProviderId;
  reviewId: number | null;
  whose: 'mine' | 'teammate';
  state: ClaimLineState;
  login: string | null;
  finalDescription: string | null;
  finalTargetUrl: string | null;
  releaseAttempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const t = (ctx: AgentContext) => ctx.schema.teamClaimLines;
const now = (): Date => new Date();
const clipErr = (s: string | null | undefined): string | null => (s == null ? null : s.slice(0, 300));

/**
 * The INTENT, written before the pending line is posted ('claiming'). Our new line replaces any older
 * line of ours at the same (PR, head, provider), so those rows are closed ('released', "superseded")
 * in the same transaction. Returns the new row's id.
 */
export async function recordClaimIntent(
  ctx: AgentContext,
  row: { accountId: number; prId: number; headSha: string; provider: AiProviderId; login: string; owner?: string; name?: string },
): Promise<number> {
  const tl = t(ctx);
  const prs = ctx.schema.pullRequests;
  const repo = (await ctx.db
    .select({ repoId: prs.repoId })
    .from(prs)
    .where(and(eq(prs.id, row.prId), eq(prs.accountId, row.accountId)))
    .limit(1)
    .execute()) as Array<{ repoId: number | null }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const write = async (tx: any): Promise<number> => {
    await tx
      .update(tl)
      .set({ state: 'released', lastError: 'superseded', updatedAt: now() })
      .where(
        and(
          eq(tl.accountId, row.accountId),
          eq(tl.prId, row.prId),
          eq(tl.headSha, row.headSha),
          eq(tl.provider, row.provider),
          eq(tl.whose, 'mine'),
          inArray(tl.state, [...OPEN_CLAIM_STATES]),
        ),
      )
      .execute();
    const [ins] = (await tx
      .insert(tl)
      .values({
        accountId: row.accountId,
        prId: row.prId,
        repoId: repo[0]?.repoId ?? null,
        owner: row.owner ?? null,
        name: row.name ?? null,
        headSha: row.headSha,
        provider: row.provider,
        whose: 'mine',
        state: 'claiming',
        login: row.login,
        createdAt: now(),
        updatedAt: now(),
      })
      .returning({ id: tl.id })
      .execute()) as Array<{ id: number }>;
    return ins!.id;
  };
  // Two DB statements, no network: close the older rows, then write the intent.
  return write(ctx.db);
}

/** Move a row on (and stamp it). `patch` may set the run, the error, the counters. */
export async function setClaimLine(
  ctx: AgentContext,
  id: number,
  patch: Partial<Pick<ClaimLineRow, 'state' | 'reviewId' | 'lastError' | 'releaseAttempts' | 'finalDescription' | 'finalTargetUrl'>>,
): Promise<void> {
  const tl = t(ctx);
  const set: Record<string, unknown> = { updatedAt: now() };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = k === 'lastError' ? clipErr(v as string | null) : v;
  await ctx.db.update(tl).set(set).where(eq(tl.id, id)).execute();
}

/**
 * The open rows (ours: 'claiming' / 'pending') the reconciler may still try, oldest first, capped.
 * ⚠ A row that used up its RELEASE_MAX_ATTEMPTS is left OUT here, so given-up rows can never fill the
 * window and starve newer ones.
 */
export async function openClaimLines(ctx: AgentContext, limit = 50): Promise<ClaimLineRow[]> {
  const tl = t(ctx);
  return (await ctx.db
    .select()
    .from(tl)
    .where(and(eq(tl.whose, 'mine'), inArray(tl.state, [...OPEN_CLAIM_STATES]), lt(tl.releaseAttempts, RELEASE_MAX_ATTEMPTS)))
    .orderBy(asc(tl.id))
    .limit(limit)
    .execute()) as ClaimLineRow[];
}

/** This machine's open rows at one PR head (the tab's "Clear" offer). */
export async function openClaimLinesAtHead(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  headSha: string,
): Promise<ClaimLineRow[]> {
  const tl = t(ctx);
  return (await ctx.db
    .select()
    .from(tl)
    .where(
      and(
        eq(tl.accountId, accountId),
        eq(tl.prId, prId),
        eq(tl.headSha, headSha),
        eq(tl.whose, 'mine'),
        inArray(tl.state, [...OPEN_CLAIM_STATES]),
      ),
    )
    .orderBy(asc(tl.id))
    .execute()) as ClaimLineRow[];
}

/** A Clear (or anything else that settled the head for one provider): close every open row there. */
export async function releaseClaimLinesAtHead(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  headSha: string,
  provider: AiProviderId,
  why: string | null,
): Promise<number> {
  const tl = t(ctx);
  const rows = (await ctx.db
    .update(tl)
    .set({ state: 'released', lastError: clipErr(why), updatedAt: now() })
    .where(
      and(
        eq(tl.accountId, accountId),
        eq(tl.prId, prId),
        eq(tl.headSha, headSha),
        eq(tl.provider, provider),
        inArray(tl.state, [...OPEN_CLAIM_STATES]),
      ),
    )
    .returning({ id: tl.id })
    .execute()) as Array<{ id: number }>;
  return rows.length;
}

/** Has this machine already released `login`'s line at this head (posted once, never again)? */
export async function teammateLineReleased(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  headSha: string,
  provider: AiProviderId,
  login: string,
): Promise<boolean> {
  const tl = t(ctx);
  const rows = (await ctx.db
    .select({ id: tl.id, login: tl.login })
    .from(tl)
    .where(
      and(
        eq(tl.accountId, accountId),
        eq(tl.prId, prId),
        eq(tl.headSha, headSha),
        eq(tl.provider, provider),
        eq(tl.whose, 'teammate'),
      ),
    )
    .execute()) as Array<{ id: number; login: string | null }>;
  return rows.some((r) => (r.login ?? '').toLowerCase() === login.toLowerCase());
}

/** Record a teammate's line this machine released (or tried to: `lastError`). */
export async function recordTeammateRelease(
  ctx: AgentContext,
  row: { accountId: number; prId: number; headSha: string; provider: AiProviderId; login: string; lastError: string | null },
): Promise<void> {
  const tl = t(ctx);
  const prs = ctx.schema.pullRequests;
  const repo = (await ctx.db
    .select({ repoId: prs.repoId })
    .from(prs)
    .where(and(eq(prs.id, row.prId), eq(prs.accountId, row.accountId)))
    .limit(1)
    .execute()) as Array<{ repoId: number | null }>;
  await ctx.db
    .insert(tl)
    .values({
      accountId: row.accountId,
      prId: row.prId,
      repoId: repo[0]?.repoId ?? null,
      headSha: row.headSha,
      provider: row.provider,
      whose: 'teammate',
      state: 'released',
      login: row.login,
      lastError: clipErr(row.lastError),
      createdAt: now(),
      updatedAt: now(),
    })
    .execute();
}
