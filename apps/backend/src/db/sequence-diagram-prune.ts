import { and, eq, inArray } from 'drizzle-orm';
import type { SequenceDiagramMember } from '@pierre-review/shared';
import { schema, type Executor } from './client.js';

// THE SEQUENCE-DIAGRAM HALF OF BOTH PR DELETE PATHS (deleteRepo in queries.ts, retention's
// deletePrSubtree). Migration 0115 / pg 0102 / 0118 / pg 0105 / 0119 / pg 0106; no FKs, so nothing cascades.
//   • 'pr' rows carry pr_id: they go with their PR.
//   • 'story' rows carry pr_id NULL, but their `members` JSON names every member PR (title, repo, head)
//     and their design is drawn from that code. A story row naming ANY deleted PR goes too —
//     the next review of a surviving member draws the story again from what is left.
// The story rows are found through the deleted PRs' ACCOUNTS (read before the PRs go, so the caller
// must run this BEFORE it deletes pull_requests), then filtered on `members` in code: the JSON column
// is text on SQLite and jsonb on Postgres, and a story table is small. Runs inside the caller's
// transaction.
export async function pruneSequenceDiagramsForPrs(tx: Executor, prIds: readonly number[]): Promise<void> {
  if (prIds.length === 0) return;
  const ids = [...prIds];
  const d = schema.sequenceDiagrams;
  const pr = schema.pullRequests;
  await tx.delete(d).where(inArray(d.prId, ids)).execute();

  const owners = (await tx
    .selectDistinct({ accountId: pr.accountId })
    .from(pr)
    .where(inArray(pr.id, ids))
    .execute()) as Array<{ accountId: number }>;
  const accountIds = owners.map((o) => o.accountId);
  if (accountIds.length === 0) return;
  const gone = new Set(ids);
  const stories = (await tx
    .select({ id: d.id, members: d.members })
    .from(d)
    .where(and(eq(d.kind, 'story'), inArray(d.accountId, accountIds)))
    .execute()) as Array<{ id: number; members: SequenceDiagramMember[] | string | null }>;
  const doomed = stories
    .filter((r) => membersOf(r.members).some((m) => gone.has(m.prId)))
    .map((r) => r.id);
  for (let i = 0; i < doomed.length; i += 500) {
    await tx.delete(d).where(inArray(d.id, doomed.slice(i, i + 500))).execute();
  }
}

function membersOf(v: SequenceDiagramMember[] | string | null): SequenceDiagramMember[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? (parsed as SequenceDiagramMember[]) : [];
  } catch {
    return [];
  }
}
