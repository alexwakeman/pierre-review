import type { PrBranchStack, PrStackMember } from '@pierre-review/shared';

// STACKED PRs (docs/FRONTEND.md § PR chips; docs/API.md § PR chips). CORE, deterministic, DB only.
//
// A PR whose BASE branch is another OPEN PR's HEAD branch in the SAME repository is stacked on it:
// merging it lands it in that branch, not the trunk, so it "lands after" that PR. Derived on read
// from synced columns (`head_ref_name`, `base_ref_name`, `is_cross_repository`, `repos.default_branch`)
// — nothing is stored, and nothing is fetched.
//
// THE PARENT RULE (`stackParents`), every clause load-bearing:
//   • same repo, both open, the child's base === the parent's head (both non-null);
//   • the parent's head is NOT in a fork (`isCrossRepository !== true`): a fork's `feature-x` is not
//     the base repo's `feature-x`. NULL (a row synced before migration 0163) is accepted — the next
//     clause removes the case that matters (a fork PR from its own `main`);
//   • the parent's head is NOT the repo's default branch: a release PR from `main` would otherwise
//     make every PR into `main` "stacked" on it;
//   • exactly ONE such PR: two open PRs from the same head branch (to two bases) is ambiguous, and an
//     ambiguous parent is not asserted;
//   • no cycles (A → B → A is not a stack).
//
// ⚠ PURE AT IMPORT: the DB client is reached LAZILY, so the folds are unit-tested without one.

export interface StackPrRow {
  id: number;
  repoId: number;
  number: number;
  title: string;
  headRefName: string | null;
  baseRefName: string | null;
  isCrossRepository: boolean | null;
}

/** child id → parent id, for every open PR with exactly one admissible parent. Pure. */
export function stackParents(
  rows: readonly StackPrRow[],
  defaultBranchByRepo: ReadonlyMap<number, string | null>,
): Map<number, number> {
  // (repoId, head branch) → the open same-repo PRs from that branch.
  const byHead = new Map<string, StackPrRow[]>();
  for (const r of rows) {
    if (r.headRefName == null || r.headRefName === '') continue;
    if (r.isCrossRepository === true) continue;
    if (defaultBranchByRepo.get(r.repoId) === r.headRefName) continue;
    const k = `${r.repoId}\u0000${r.headRefName}`;
    const arr = byHead.get(k) ?? [];
    arr.push(r);
    byHead.set(k, arr);
  }
  const out = new Map<number, number>();
  for (const r of rows) {
    if (r.baseRefName == null || r.baseRefName === '') continue;
    const cands = (byHead.get(`${r.repoId}\u0000${r.baseRefName}`) ?? []).filter((p) => p.id !== r.id);
    if (cands.length === 1) out.set(r.id, cands[0]!.id);
  }
  // Drop every PR whose parent walk revisits a PR — the cycle and anything leading into it.
  // Decided against the WHOLE map first, then deleted, so the order of the walk cannot matter.
  const onCycle = new Set<number>();
  for (const start of out.keys()) {
    const seen = new Set<number>([start]);
    for (let cur = out.get(start); cur != null; cur = out.get(cur)) {
      if (seen.has(cur)) {
        for (const id of seen) onCycle.add(id);
        break;
      }
      seen.add(cur);
    }
  }
  for (const id of onCycle) out.delete(id);
  return out;
}

const member = (r: StackPrRow): PrStackMember => ({ prId: r.id, number: r.number, title: r.title });

/** Every open PR's stack (only PRs with a parent or a child are in the map). Pure. */
export function deriveBranchStacks(
  rows: readonly StackPrRow[],
  defaultBranchByRepo: ReadonlyMap<number, string | null>,
): Map<number, PrBranchStack> {
  const parents = stackParents(rows, defaultBranchByRepo);
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const children = new Map<number, StackPrRow[]>();
  for (const [child, parent] of parents) {
    const arr = children.get(parent) ?? [];
    arr.push(byId.get(child)!);
    children.set(parent, arr);
  }
  for (const arr of children.values()) arr.sort((a, b) => a.number - b.number);

  const out = new Map<number, PrBranchStack>();
  for (const r of rows) {
    const parentId = parents.get(r.id);
    const kids = children.get(r.id) ?? [];
    if (parentId == null && kids.length === 0) continue;
    // Down to the bottom (cycles were removed above, so this ends).
    const below: StackPrRow[] = [];
    for (let p = parentId; p != null; p = parents.get(p)) below.unshift(byId.get(p)!);
    // Up while exactly one PR targets the branch above.
    const above: StackPrRow[] = [];
    for (let k = children.get(r.id); k != null && k.length === 1; k = children.get(k[0]!.id)) above.push(k[0]!);
    const chain = [...below, r, ...above].map(member);
    out.set(r.id, {
      position: below.length + 1,
      chain,
      parent: parentId != null ? member(byId.get(parentId)!) : null,
      children: kids.map(member),
    });
  }
  return out;
}

/** The open PRs of these repos, as the fold reads them, plus each repo's default branch. */
async function loadStackRows(
  accountId: number,
  repoIds: readonly number[],
): Promise<{ rows: StackPrRow[]; defaults: Map<number, string | null> }> {
  const defaults = new Map<number, string | null>();
  if (repoIds.length === 0) return { rows: [], defaults };
  const { and, eq, inArray } = await import('drizzle-orm');
  const { db, schema } = await import('./client.js');
  const pr = schema.pullRequests;
  const rows = (await db
    .select({
      id: pr.id,
      repoId: pr.repoId,
      number: pr.number,
      title: pr.title,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      isCrossRepository: pr.isCrossRepository,
    })
    .from(pr)
    .where(and(eq(pr.accountId, accountId), eq(pr.state, 'open'), inArray(pr.repoId, [...repoIds])))
    .execute()) as StackPrRow[];
  const repoRows = (await db
    .select({ id: schema.repos.id, defaultBranch: schema.repos.defaultBranch, defaultBranchName: schema.repos.defaultBranchName })
    .from(schema.repos)
    .where(and(eq(schema.repos.accountId, accountId), inArray(schema.repos.id, [...repoIds])))
    .execute()) as Array<{ id: number; defaultBranch: string | null; defaultBranchName: string | null }>;
  for (const r of repoRows) defaults.set(r.id, r.defaultBranch ?? r.defaultBranchName ?? null);
  return { rows, defaults };
}

/** Every open PR's stack in these repos (this account only). Two queries. */
export async function branchStacksFor(
  accountId: number,
  repoIds: readonly number[],
): Promise<Map<number, PrBranchStack>> {
  const { rows, defaults } = await loadStackRows(accountId, repoIds);
  return deriveBranchStacks(rows, defaults);
}

/** The ids of the open PRs in these repos that land after another open PR (have a stack parent). */
export async function prIdsLandingAfter(accountId: number, repoIds: readonly number[]): Promise<Set<number>> {
  const { rows, defaults } = await loadStackRows(accountId, repoIds);
  return new Set(stackParents(rows, defaults).keys());
}

/**
 * The open PR a branch belongs to, for the auto-merge watcher and the arm route: would merging a PR
 * whose LIVE base is `baseRef` land it in another open PR's branch? Same parent rule as the fold
 * (`stackParents`), asked for one PR. Null = it would not (or it cannot be told).
 */
export async function openStackParentFor(
  accountId: number,
  prId: number,
  baseRef: string | null,
): Promise<PrStackMember | null> {
  if (baseRef == null || baseRef === '') return null;
  const { and, eq } = await import('drizzle-orm');
  const { db, schema } = await import('./client.js');
  const own = (await db
    .select({ repoId: schema.pullRequests.repoId })
    .from(schema.pullRequests)
    .where(and(eq(schema.pullRequests.accountId, accountId), eq(schema.pullRequests.id, prId)))
    .limit(1)
    .execute()) as Array<{ repoId: number }>;
  const repoId = own[0]?.repoId;
  if (repoId == null) return null;
  const { rows, defaults } = await loadStackRows(accountId, [repoId]);
  // The live base, not the synced one: the caller has just read it from GitHub.
  const self = rows.find((r) => r.id === prId);
  const asked: StackPrRow[] = self
    ? rows.map((r) => (r.id === prId ? { ...r, baseRefName: baseRef } : r))
    : [...rows, { id: prId, repoId, number: -1, title: '', headRefName: null, baseRefName: baseRef, isCrossRepository: null }];
  const parentId = stackParents(asked, defaults).get(prId);
  if (parentId == null) return null;
  const p = rows.find((r) => r.id === parentId)!;
  return member(p);
}
