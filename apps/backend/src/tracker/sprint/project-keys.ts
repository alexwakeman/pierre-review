import { and, eq } from 'drizzle-orm';
import type { TrackerProvider } from '@pierre-review/shared';
import type { TrackerContext } from '../context.js';
import { parseProjectKeys } from '../detect.js';

// WHICH PROJECTS A SPRINT READ ASKS ABOUT. A Jira site or a Linear workspace holds many teams'
// work; this workspace's sprint is the one its OWN tickets live in. So the keys are the prefixes of
// the tickets already stored for this workspace's pull requests (Jira `ENG-12` → ENG, Linear the team
// key), plus the workspace's own project-key allowlist when it has one. Nothing seen yet → [] and the
// read records `no_projects` rather than guessing a project.

const PREFIX_RE = /^([A-Z][A-Z0-9_]{0,19})-\d+$/;
const MAX_KEYS = 40;

export async function sprintProjectKeys(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  provider: TrackerProvider,
  apiRoot?: string,
): Promise<string[]> {
  if (provider === 'github') return [];
  const tt = ctx.schema.trackerTickets;
  const rows = (await ctx.db
    .selectDistinct({ issueKey: tt.issueKey })
    .from(tt)
    .where(
      and(
        eq(tt.accountId, accountId),
        eq(tt.workspaceId, workspaceId),
        eq(tt.provider, provider),
        ...(apiRoot != null ? [eq(tt.apiRoot, apiRoot)] : []),
      ),
    )
    .execute()) as Array<{ issueKey: string }>;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = PREFIX_RE.exec(r.issueKey.toUpperCase())?.[1];
    if (k != null) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const w = ctx.schema.workspaceTrackers;
  const allow = (await ctx.db
    .select({ projectKeys: w.projectKeys })
    .from(w)
    .where(and(eq(w.accountId, accountId), eq(w.workspaceId, workspaceId)))
    .limit(1)
    .execute()) as Array<{ projectKeys: string | null }>;
  const listed = parseProjectKeys(allow[0]?.projectKeys);
  // Most-used first, so a cap keeps the projects this workspace actually works in.
  const seen = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  return [...new Set([...listed, ...seen])].slice(0, MAX_KEYS);
}

/** The workspace's repos as `owner/name`, sorted (GitHub Issues reads milestones from these). */
export async function workspaceRepoNames(ctx: TrackerContext, accountId: number, workspaceId: number): Promise<string[]> {
  const r = ctx.schema.repos;
  const wr = ctx.schema.workspaceRepos;
  const rows = (await ctx.db
    .select({ owner: r.owner, name: r.name })
    .from(wr)
    .innerJoin(r, and(eq(r.id, wr.repoId), eq(r.accountId, wr.accountId)))
    .where(and(eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId)))
    .execute()) as Array<{ owner: string; name: string }>;
  return rows.map((x) => `${x.owner}/${x.name}`).sort();
}
