import { and, eq, inArray } from 'drizzle-orm';
import { SPRINT_REPOS_PER_TICKET_MAX, type SprintRepoRef } from '@pierre-review/shared';
import { db, runTransaction, schema } from './client.js';
import { readSprintTicket } from './sprint-store.js';

// REPORTS → THIS SPRINT — THE ACCEPTED CANDIDATE REPOS per ticket (`sprint_ticket_repos`). Only
// ACCEPTED rows are stored; a suggestion is computed on read (db/sprint-repo-suggest.ts) and never
// stored, and only accepted repos reach the assessment.
//
//   • TENANCY IS STRUCTURAL: `repo_id` arrives in a request body, and the table's NAMED COMPOSITE
//     FK onto `repos (id, account_id)` makes a cross-account pair fail in the database. The
//     membership check below is the friendlier first line (a clean `bad_repo` instead of a
//     constraint error) and also refuses another WORKSPACE's repo, which no FK can express.
//   • A REPLACE is one transaction: delete the ticket's rows, insert the new set (conflict target
//     exactly the table's 4-column unique, DO NOTHING).
//   • A read lists only repos STILL in the workspace: a repo moved elsewhere drops out of the
//     accepted set (its row stays until the next replace or the repo's deletion).

export interface AcceptedRepoDetail extends SprintRepoRef {
  owner: string;
  name: string;
  /** The default branch's name (synced), or null = the remote's HEAD. */
  defaultBranch: string | null;
  /** The SYNCED default-branch head sha (`repos.default_branch_head_sha`) — the currency input. */
  syncedSha: string | null;
}

/** Accepted repos per ident, with the repo columns the assessment needs. Membership-filtered. */
export async function acceptedSprintRepoDetails(
  accountId: number,
  workspaceId: number,
  idents: readonly string[],
): Promise<Map<string, AcceptedRepoDetail[]>> {
  const out = new Map<string, AcceptedRepoDetail[]>();
  const list = [...new Set(idents)];
  if (list.length === 0) return out;
  const { sprintTicketRepos: str, repos: r, workspaceRepos: wr } = schema;
  for (let i = 0; i < list.length; i += 400) {
    const rows = await db
      .select({
        ident: str.ident,
        repoId: r.id,
        owner: r.owner,
        name: r.name,
        defaultBranch: r.defaultBranch,
        defaultBranchName: r.defaultBranchName,
        syncedSha: r.defaultBranchHeadSha,
      })
      .from(str)
      .innerJoin(r, and(eq(r.id, str.repoId), eq(r.accountId, accountId)))
      .innerJoin(wr, and(eq(wr.repoId, r.id), eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId)))
      .where(and(eq(str.accountId, accountId), eq(str.workspaceId, workspaceId), inArray(str.ident, list.slice(i, i + 400))))
      .execute();
    for (const row of rows) {
      const arr = out.get(row.ident) ?? [];
      arr.push({
        repoId: row.repoId,
        fullName: `${row.owner}/${row.name}`,
        owner: row.owner,
        name: row.name,
        defaultBranch: row.defaultBranchName ?? row.defaultBranch ?? null,
        syncedSha: row.syncedSha ?? null,
      });
      out.set(row.ident, arr);
    }
  }
  for (const arr of out.values()) arr.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return out;
}

/** Accepted repos per ident (wire shape). */
export async function acceptedSprintRepos(
  accountId: number,
  workspaceId: number,
  idents: readonly string[],
): Promise<Map<string, SprintRepoRef[]>> {
  const detailed = await acceptedSprintRepoDetails(accountId, workspaceId, idents);
  const out = new Map<string, SprintRepoRef[]>();
  for (const [ident, arr] of detailed) out.set(ident, arr.map((d) => ({ repoId: d.repoId, fullName: d.fullName })));
  return out;
}

/**
 * Replace the accepted set for one ticket. Every repoId must be in THIS workspace's membership, else
 * `bad_repo` and nothing is written. `via` says whether each id was a one-click suggestion.
 */
export async function setSprintRepos(
  accountId: number,
  workspaceId: number,
  ident: string,
  repoIds: number[],
  via: (repoId: number) => 'suggested' | 'manual',
): Promise<{ ok: true; accepted: SprintRepoRef[] } | { ok: false; error: 'bad_repo' | 'too_many' | 'no_ticket' }> {
  const ids = [...new Set(repoIds)];
  if (ids.length > SPRINT_REPOS_PER_TICKET_MAX) return { ok: false, error: 'too_many' };
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) return { ok: false, error: 'bad_repo' };
  if ((await readSprintTicket(accountId, workspaceId, ident)) == null) return { ok: false, error: 'no_ticket' };
  const { sprintTicketRepos: str, workspaceRepos: wr } = schema;
  if (ids.length > 0) {
    const members = await db
      .select({ repoId: wr.repoId })
      .from(wr)
      .where(and(eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId), inArray(wr.repoId, ids)))
      .execute();
    const have = new Set(members.map((m) => m.repoId));
    if (!ids.every((id) => have.has(id))) return { ok: false, error: 'bad_repo' };
  }
  const now = new Date();
  await runTransaction(async (tx) => {
    await tx
      .delete(str)
      .where(and(eq(str.accountId, accountId), eq(str.workspaceId, workspaceId), eq(str.ident, ident)))
      .execute();
    if (ids.length > 0) {
      await tx
        .insert(str)
        .values(ids.map((repoId) => ({ accountId, workspaceId, ident, repoId, via: via(repoId), acceptedAt: now })))
        .onConflictDoNothing({ target: [str.accountId, str.workspaceId, str.ident, str.repoId] })
        .execute();
    }
  });
  const accepted = (await acceptedSprintRepos(accountId, workspaceId, [ident])).get(ident) ?? [];
  return { ok: true, accepted };
}
