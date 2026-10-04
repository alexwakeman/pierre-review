// PR REFERENCES → LOCAL PR IDS (CORE, free, both modes, DB-only).
//
// The Review tab links every PR reference in its prose ("bng-library#66", "acme/api#12") to that
// PR in Limn. Whatever it cannot resolve from data already on screen it sends here in ONE batch.
//
//   • "owner/name#N" resolves by the full name; a bare "name#N" only when EXACTLY ONE of the
//     account's repositories carries that name (two orgs' "api" would be a guess, so it is null).
//   • Both predicates carry `accountId`: another tenant's PR is indistinguishable from one never
//     synced (null), so the route is no existence oracle.
//   • Names compare case-insensitively, as GitHub's do.
import { and, eq, inArray } from 'drizzle-orm';
import type { PrRefQuery, ResolvedPrRef } from '@pierre-review/shared';
import { db, schema } from './client.js';

export async function resolvePrRefs(accountId: number, refs: readonly PrRefQuery[]): Promise<ResolvedPrRef[]> {
  if (refs.length === 0) return [];
  const repos = await db
    .select({ id: schema.repos.id, owner: schema.repos.owner, name: schema.repos.name })
    .from(schema.repos)
    .where(eq(schema.repos.accountId, accountId))
    .execute();
  const byFull = new Map<string, { id: number; fullName: string }>();
  const byName = new Map<string, Array<{ id: number; fullName: string }>>();
  for (const r of repos) {
    const entry = { id: r.id, fullName: `${r.owner}/${r.name}` };
    byFull.set(entry.fullName.toLowerCase(), entry);
    const k = r.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), entry]);
  }
  const repoOf = (repo: string): { id: number; fullName: string } | null => {
    const k = repo.trim().toLowerCase();
    if (k.includes('/')) return byFull.get(k) ?? null;
    const hits = byName.get(k) ?? [];
    return hits.length === 1 ? hits[0]! : null;
  };

  const wanted = refs.map((r) => ({ ref: r, repo: repoOf(r.repo) }));
  const repoIds = [...new Set(wanted.flatMap((w) => (w.repo != null ? [w.repo.id] : [])))];
  const numbers = [...new Set(wanted.flatMap((w) => (w.repo != null ? [w.ref.number] : [])))];
  const prs =
    repoIds.length === 0
      ? []
      : await db
          .select({
            id: schema.pullRequests.id,
            repoId: schema.pullRequests.repoId,
            number: schema.pullRequests.number,
            title: schema.pullRequests.title,
          })
          .from(schema.pullRequests)
          .where(
            and(
              eq(schema.pullRequests.accountId, accountId),
              inArray(schema.pullRequests.repoId, repoIds),
              inArray(schema.pullRequests.number, numbers),
            ),
          )
          .execute();
  // ⚠ Keyed on (repoId, number): a PR number is unique per REPO only.
  const prByKey = new Map(prs.map((p) => [`${p.repoId}#${p.number}`, p]));
  return wanted.map(({ ref, repo }) => {
    const pr = repo != null ? prByKey.get(`${repo.id}#${ref.number}`) : undefined;
    return {
      repo: ref.repo,
      number: ref.number,
      prId: pr?.id ?? null,
      repoFullName: pr != null ? repo!.fullName : null,
      title: pr?.title ?? null,
    };
  });
}
