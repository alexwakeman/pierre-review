import { and, eq } from 'drizzle-orm';
import type { AgentContext } from '../../review/agent-context.js';

// Resolve a PR's coordinates from its id, SCOPED to the caller's account (the plugin's
// IDOR guarantee — a PR that isn't the caller's returns null → the route 404s). Reads
// the host's core tables directly via ctx.db + ctx.schema, exactly like review-memory.
export interface FixPrContext {
  prId: number;
  repoId: number;
  owner: string;
  name: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  headSha: string | null;
  baseRefName: string | null;
  defaultBranch: string | null;
  authorId: number | null;
  state: string;
}

export async function getFixPrContext(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<FixPrContext | null> {
  const pr = ctx.schema.pullRequests;
  const repos = ctx.schema.repos;
  const rows = (await ctx.db
    .select({
      prId: pr.id,
      repoId: pr.repoId,
      owner: repos.owner,
      name: repos.name,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      headSha: pr.headSha,
      baseRefName: pr.baseRefName,
      defaultBranch: repos.defaultBranch,
      authorId: pr.authorId,
      state: pr.state,
    })
    .from(pr)
    .innerJoin(repos, eq(pr.repoId, repos.id))
    .where(and(eq(pr.id, prId), eq(pr.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{
    prId: number;
    repoId: number;
    owner: string;
    name: string;
    number: number;
    title: string;
    body: string | null;
    headSha: string | null;
    baseRefName: string | null;
    defaultBranch: string | null;
    authorId: number | null;
    state: string;
  }>;

  const row = rows[0];
  if (!row) return null;
  return {
    prId: row.prId,
    repoId: row.repoId,
    owner: row.owner,
    name: row.name,
    repoFullName: `${row.owner}/${row.name}`,
    number: row.number,
    title: row.title,
    body: row.body,
    headSha: row.headSha,
    baseRefName: row.baseRefName,
    defaultBranch: row.defaultBranch,
    authorId: row.authorId,
    state: row.state,
  };
}

// The viewer's WRITE permission on the PR's repo (for the push gate + branch picker).
// Read from the synced repos.viewerPermission; the actual push still fails loud if the
// token can't push, but this hides the controls / server-guards early.
export async function getViewerCanPush(
  ctx: AgentContext,
  accountId: number,
  repoId: number,
): Promise<boolean> {
  const repos = ctx.schema.repos;
  const rows = (await ctx.db
    .select({ perm: repos.viewerPermission })
    .from(repos)
    .where(and(eq(repos.id, repoId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ perm: string | null }>;
  const perm = rows[0]?.perm ?? '';
  return ['WRITE', 'MAINTAIN', 'ADMIN'].includes(perm);
}
