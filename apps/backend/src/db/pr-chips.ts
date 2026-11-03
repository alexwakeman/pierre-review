import type { PrBranchStack, PrCriteriaCheck } from '@pierre-review/shared';
import { branchStacksFor } from './pr-stacks.js';
import { prCriteriaFor } from './pr-criteria.js';

// THE PR CHIPS' ONE ENRICHMENT (shared `pr-chips.ts`): GET /api/open-prs, GET /api/attention (the
// listed cards, live only) and GET /api/prs/:id all call this, so the three surfaces cannot read the
// stack or the criteria two ways. DB only. ⚠ Never on /api/timeline (kept lean).

export interface PrChipFields {
  branchStack: PrBranchStack | null;
  criteria: PrCriteriaCheck[];
}

/** Both chips for these PRs. A PR that is not open gets `branchStack: null` (stacks are open PRs). */
export async function prChipsFor(
  accountId: number,
  prs: readonly { id: number; repoId: number }[],
): Promise<Map<number, PrChipFields>> {
  const out = new Map<number, PrChipFields>();
  if (prs.length === 0) return out;
  const repoIds = [...new Set(prs.map((p) => p.repoId))];
  const [stacks, criteria] = await Promise.all([
    branchStacksFor(accountId, repoIds),
    prCriteriaFor(accountId, prs.map((p) => p.id)),
  ]);
  for (const p of prs) {
    out.set(p.id, { branchStack: stacks.get(p.id) ?? null, criteria: criteria.get(p.id) ?? [] });
  }
  return out;
}

/** Copy the chips onto rows that carry `id` (or `prId`) in place. */
export async function attachPrChips<T extends { repoId: number }>(
  accountId: number,
  rows: T[],
  idOf: (row: T) => number | null,
): Promise<void> {
  const prs = rows.flatMap((r) => {
    const id = idOf(r);
    return id != null ? [{ id, repoId: r.repoId }] : [];
  });
  const chips = await prChipsFor(accountId, prs);
  for (const r of rows) {
    const id = idOf(r);
    const c = id != null ? chips.get(id) : undefined;
    if (c != null) Object.assign(r, c);
  }
}
