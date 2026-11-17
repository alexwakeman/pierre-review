// STORY CHAT — THE STORY'S BUILD WORK (docs/STORY-CHAT.md § The build's work). The newest Implement story
// build of the ticket (a workspace session, not discarded) keeps each repository's work as a patch
// (`story_build_repos.patch`), or one per planned PR (`story_build_prs.patch`) on a plan-first build. Work
// that is not pushed is in no pull request, so without this the chat could not see it — and "How to test"
// right after a build would answer from the ticket alone. DB only; no GitHub, no sandbox.
import { and, asc, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { BuildWork } from './live.js';

/** Where a piece of work is, in plain words. Pure. */
export function whereOf(r: { pushedPrNumber: number | null; pushedBranch: string | null; loopBranch: string | null }): string {
  if (r.pushedPrNumber != null) return `pushed as PR #${r.pushedPrNumber}`;
  const branch = r.pushedBranch ?? r.loopBranch;
  if (branch != null) return `pushed to the branch ${branch}, with no pull request yet`;
  return 'not pushed';
}

/** The newest build of (workspace, ticket) and its stored work, repositories in build order. */
export async function storyBuildWorkFor(accountId: number, workspaceId: number, ident: string): Promise<BuildWork[]> {
  const b = schema.storyBuilds;
  const [build] = await db
    .select({ id: b.id })
    .from(b)
    .where(and(eq(b.accountId, accountId), eq(b.workspaceId, workspaceId), eq(b.ident, ident), ne(b.status, 'discarded'), isNotNull(b.sessionPhase)))
    .orderBy(desc(b.id))
    .limit(1)
    .execute();
  if (!build) return [];
  return buildWorkOf(accountId, build.id);
}

/** One build's stored work. */
export async function buildWorkOf(accountId: number, buildId: number): Promise<BuildWork[]> {
  const r = schema.storyBuildRepos;
  const p = schema.storyBuildPrs;
  const repoRows = await db
    .select({ repoId: r.repoId, patch: r.patch, pushedPrNumber: r.pushedPrNumber, pushedBranch: r.pushedBranch, loopBranch: r.loopBranch })
    .from(r)
    .where(and(eq(r.accountId, accountId), eq(r.buildId, buildId), isNotNull(r.patch)))
    .orderBy(asc(r.buildOrder), asc(r.id))
    .execute();
  const prRows = await db
    .select({ repoId: p.repoId, prKey: p.prKey, title: p.title, patch: p.patch, pushedPrNumber: p.pushedPrNumber, pushedBranch: p.pushedBranch, loopBranch: p.loopBranch })
    .from(p)
    .where(and(eq(p.accountId, accountId), eq(p.buildId, buildId), isNotNull(p.patch)))
    .orderBy(asc(p.position), asc(p.id))
    .execute();
  const ids = [...new Set([...repoRows, ...prRows].map((x) => x.repoId))];
  if (ids.length === 0) return [];
  const names = new Map(
    (
      await db
        .select({ id: schema.repos.id, owner: schema.repos.owner, name: schema.repos.name })
        .from(schema.repos)
        .where(and(eq(schema.repos.accountId, accountId), inArray(schema.repos.id, ids)))
        .execute()
    ).map((x) => [x.id, `${x.owner}/${x.name}`]),
  );
  const out: BuildWork[] = [];
  for (const x of repoRows) {
    const repo = names.get(x.repoId);
    if (repo == null || !x.patch) continue;
    out.push({ repo, label: "the build's work", where: whereOf(x), patch: x.patch });
  }
  for (const x of prRows) {
    const repo = names.get(x.repoId);
    if (repo == null || !x.patch) continue;
    out.push({ repo, label: `planned PR ${x.prKey} "${x.title}"`, where: whereOf(x), patch: x.patch });
  }
  return out;
}
