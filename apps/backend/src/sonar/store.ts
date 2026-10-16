import { and, desc, eq, isNull } from 'drizzle-orm';
import type {
  SonarIssue,
  SonarPostRecord,
  SonarQualityGate,
  SonarSnapshot,
  SonarSnapshotState,
} from '@pierre-review/shared';
import type { SonarGatherResult } from './gather.js';
import { sonarDashboardUrl } from './gather.js';
import type { SonarDb } from './settings.js';

// THE STORED SNAPSHOTS (`sonar_snapshots`, migration 0114 / pg 0101): ONE row per (account, PR,
// head). Every reader — the review tab, the review prompt, AI Fix's seed, the PR comment — reads a
// row here and never calls SonarCloud. Every query predicates on account_id.
//
// ⚠ `post` IS NEVER OVERWRITTEN BY A RE-READ. A refresh of the same head replaces the issues but
// keeps the comment's record, so a refreshed head can never be posted twice.

interface Row {
  id: number;
  prId: number;
  headSha: string;
  state: string;
  message: string | null;
  projectKey: string | null;
  qualityGate: SonarQualityGate | null;
  issues: SonarIssue[] | null;
  totalIssues: number;
  totalHotspots: number;
  fetchedAt: Date | number | string;
  post: SonarPostRecord | null;
}

const iso = (v: Date | number | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

export function toSnapshot(r: Row, prNumber: number | null): SonarSnapshot {
  return {
    prId: r.prId,
    headSha: r.headSha,
    state: r.state as SonarSnapshotState,
    message: r.message,
    projectKey: r.projectKey,
    qualityGate: r.qualityGate ?? null,
    issues: Array.isArray(r.issues) ? r.issues : [],
    totalIssues: r.totalIssues,
    totalHotspots: r.totalHotspots,
    fetchedAt: iso(r.fetchedAt),
    post: r.post ?? null,
    dashboardUrl: r.projectKey && prNumber != null ? sonarDashboardUrl(r.projectKey, prNumber) : null,
  };
}

async function prNumberOf(c: SonarDb, accountId: number, prId: number): Promise<number | null> {
  const prs = c.schema.pullRequests;
  const rows = (await c.db
    .select({ n: prs.number })
    .from(prs)
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ n: number }>;
  return rows[0]?.n ?? null;
}

async function readRow(c: SonarDb, accountId: number, prId: number, headSha: string | null): Promise<Row | null> {
  const t = c.schema.sonarSnapshots;
  const where = headSha
    ? and(eq(t.accountId, accountId), eq(t.prId, prId), eq(t.headSha, headSha))
    : and(eq(t.accountId, accountId), eq(t.prId, prId));
  const rows = (await c.db.select().from(t).where(where).orderBy(desc(t.fetchedAt), desc(t.id)).limit(1).execute()) as Row[];
  return rows[0] ?? null;
}

/** The snapshot at `headSha` (or the PR's newest when null). Account-scoped. */
export async function readSonarSnapshot(
  c: SonarDb,
  accountId: number,
  prId: number,
  headSha: string | null,
): Promise<SonarSnapshot | null> {
  const row = await readRow(c, accountId, prId, headSha);
  if (!row) return null;
  return toSnapshot(row, await prNumberOf(c, accountId, prId));
}

/** Store what a gather found for (PR, head), replacing an earlier read of the same head. */
export async function upsertSonarSnapshot(
  c: SonarDb,
  accountId: number,
  prId: number,
  headSha: string,
  projectKey: string | null,
  result: SonarGatherResult,
  at: Date = new Date(),
): Promise<void> {
  const t = c.schema.sonarSnapshots;
  const values = {
    state: result.state,
    message: result.message,
    projectKey,
    qualityGate: result.qualityGate,
    issues: result.issues,
    totalIssues: result.totalIssues,
    totalHotspots: result.totalHotspots,
    fetchedAt: at,
  };
  await c.db
    .insert(t)
    .values({ accountId, prId, headSha, ...values })
    // ⚠ `post` is deliberately absent from the update: a re-read never clears the comment's claim.
    .onConflictDoUpdate({ target: [t.accountId, t.prId, t.headSha], set: values })
    .execute();
}

/** Claim the (PR, head) comment: NULL → `rec`. false = already claimed (posted, posting or failed). */
export async function claimSonarPost(
  c: SonarDb,
  accountId: number,
  prId: number,
  headSha: string,
  rec: SonarPostRecord,
): Promise<boolean> {
  const t = c.schema.sonarSnapshots;
  const rows = (await c.db
    .update(t)
    .set({ post: rec })
    .where(and(eq(t.accountId, accountId), eq(t.prId, prId), eq(t.headSha, headSha), isNull(t.post)))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

/** Settle the claimed record (posted / failed). */
export async function writeSonarPost(
  c: SonarDb,
  accountId: number,
  prId: number,
  headSha: string,
  rec: SonarPostRecord,
): Promise<void> {
  const t = c.schema.sonarSnapshots;
  await c.db
    .update(t)
    .set({ post: rec })
    .where(and(eq(t.accountId, accountId), eq(t.prId, prId), eq(t.headSha, headSha)))
    .execute();
}

/**
 * AI Fix's SonarCloud half: the issues of the snapshot AT THE PR'S SYNCED HEAD, when that read
 * succeeded. [] when the head moved since, or nothing was read. Account-scoped.
 */
export async function getSonarIssuesForPrHead(c: SonarDb, accountId: number, prId: number): Promise<SonarIssue[]> {
  const prs = c.schema.pullRequests;
  const rows = (await c.db
    .select({ headSha: prs.headSha })
    .from(prs)
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ headSha: string | null }>;
  const head = rows[0]?.headSha;
  if (!head) return [];
  const row = await readRow(c, accountId, prId, head);
  return row && row.state === 'ok' && Array.isArray(row.issues) ? row.issues : [];
}
