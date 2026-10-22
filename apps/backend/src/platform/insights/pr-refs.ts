import { and, eq, inArray } from 'drizzle-orm';
import type { CiStatus, DigestPrRef, PrState } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';

// Re-derive an answer's `owner/name#N` PR references from its Markdown on read, so Haiku answers
// (preset prompts + the ad-hoc sprint chat) linkify to clickable PR rows — the same treatment the
// Sprint report card gets. Cross-repo: the answer can span every repo in scope, and the system
// prompts force fully-qualified owner/name#N. Account-scoped: a token only resolves to a PR in a
// repo THIS account owns. Not stored — recomputed each GET/refresh. Shared by sprint-report.ts +
// chat.ts (one implementation).
const PR_REF_RE = /([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)/g;

export async function resolveScopePrRefs(
  ctx: ProContext,
  accountId: number,
  markdown: string,
): Promise<DigestPrRef[]> {
  const wanted = new Map<string, { fullName: string; number: number }>();
  for (const m of markdown.matchAll(PR_REF_RE)) {
    const fullName = m[1]!;
    const number = Number.parseInt(m[2]!, 10);
    if (Number.isInteger(number) && number > 0) {
      wanted.set(`${fullName}#${number}`, { fullName, number });
    }
  }
  if (wanted.size === 0) return [];

  // owner/name ⇄ repoId, account-scoped (a token can only resolve to a repo THIS account owns).
  const reposT = ctx.schema.repos;
  const repoRows = (await ctx.db
    .select({ id: reposT.id, owner: reposT.owner, name: reposT.name })
    .from(reposT)
    .where(eq(reposT.accountId, accountId))
    .execute()) as Array<{ id: number; owner: string; name: string }>;
  const repoIdByName = new Map<string, number>();
  const nameByRepoId = new Map<number, string>();
  for (const r of repoRows) {
    repoIdByName.set(`${r.owner}/${r.name}`, r.id);
    nameByRepoId.set(r.id, `${r.owner}/${r.name}`);
  }
  const referencedRepoIds = new Set<number>();
  for (const { fullName } of wanted.values()) {
    const rid = repoIdByName.get(fullName);
    if (rid != null) referencedRepoIds.add(rid);
  }
  if (referencedRepoIds.size === 0) return [];

  // Bound the fetch to the referenced (repo, number) space — the exact numbers are already known,
  // so filter on them (+ project only the columns we need) instead of loading every PR in each
  // referenced repo. A number can collide across repos; the byKey map below disambiguates by
  // owner/name#N. This runs on every chat answer + preset load, so keeping it bounded matters.
  const wantedNumbers = [...new Set([...wanted.values()].map((w) => w.number))];
  const prsT = ctx.schema.pullRequests;
  const rows = (await ctx.db
    .select({
      id: prsT.id,
      repoId: prsT.repoId,
      number: prsT.number,
      title: prsT.title,
      state: prsT.state,
      authorId: prsT.authorId,
      ciStatus: prsT.ciStatus,
      additions: prsT.additions,
      deletions: prsT.deletions,
      changedFiles: prsT.changedFiles,
      openedAt: prsT.openedAt,
    })
    .from(prsT)
    .where(
      and(
        eq(prsT.accountId, accountId),
        inArray(prsT.repoId, [...referencedRepoIds]),
        inArray(prsT.number, wantedNumbers),
      ),
    )
    .execute()) as Array<{
    id: number;
    repoId: number;
    number: number;
    title: string | null;
    state: PrState | null;
    authorId: number | null;
    ciStatus: CiStatus | null;
    additions: number | null;
    deletions: number | null;
    changedFiles: number | null;
    openedAt: Date | null;
  }>;

  const authorIds = [
    ...new Set(rows.map((r) => r.authorId).filter((id): id is number => id != null)),
  ];
  const loginById = new Map<number, string>();
  if (authorIds.length > 0) {
    const usersT = ctx.schema.users;
    const userRows = (await ctx.db
      .select()
      .from(usersT)
      .where(inArray(usersT.id, authorIds))
      .execute()) as Array<{ id: number; githubLogin: string }>;
    for (const u of userRows) loginById.set(u.id, u.githubLogin);
  }

  const byKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const fn = nameByRepoId.get(r.repoId);
    if (fn) byKey.set(`${fn}#${r.number}`, r);
  }

  const refs: DigestPrRef[] = [];
  for (const [refKey, { fullName, number }] of wanted) {
    const hit = byKey.get(refKey);
    if (!hit) continue; // unresolved token → plain text (buildPrRefIndex skips prId-null refs)
    refs.push({
      prNumber: number,
      prId: hit.id,
      repoId: hit.repoId,
      repoFullName: fullName,
      title: hit.title,
      authorLogin: hit.authorId != null ? loginById.get(hit.authorId) ?? null : null,
      authorId: hit.authorId,
      state: hit.state,
      ciStatus: hit.ciStatus ?? null,
      additions: hit.additions ?? 0,
      deletions: hit.deletions ?? 0,
      changedFiles: hit.changedFiles ?? 0,
      openedAt: hit.openedAt ? hit.openedAt.toISOString() : null,
    });
  }
  return refs;
}
