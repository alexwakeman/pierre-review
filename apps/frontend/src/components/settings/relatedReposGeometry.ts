// THE RELATED-REPOS MAP, PURE (Settings → AI review → Related repos; `RelatedReposSection.tsx`;
// docs/CLAUDE-REVIEW.md § Related repos). The curve geometry and the draft arithmetic, kept apart from
// React so `test/relatedReposGeometry.test.ts` pins them.
//
// A curve runs from the selected repo's row (left column, its RIGHT edge) to a related repo's row
// (right column, its LEFT edge). Both ends leave and arrive HORIZONTALLY, so the arrowhead always
// points right and the curve stops at the arrowhead's base, never under its tip.

export interface Pt {
  x: number;
  y: number;
}

/** The arrowhead: its length along the curve and half its width. */
export const ARROW = { length: 7, halfWidth: 4 } as const;

/** Smallest horizontal pull on each control point, so a short gutter still gives an S, not a kink. */
const MIN_PULL = 16;

const r = (n: number): number => Math.round(n * 10) / 10;

/**
 * The SVG path of a cubic bezier from `from` to the base of an arrowhead whose tip is `to`. Control
 * points sit level with each end, half the horizontal gap in (at least `MIN_PULL`), so the curve leaves
 * and arrives flat.
 */
export function curvePath(from: Pt, to: Pt, arrowLength: number = ARROW.length): string {
  const endX = to.x - arrowLength;
  const pull = Math.max((endX - from.x) / 2, MIN_PULL);
  return `M${r(from.x)} ${r(from.y)} C${r(from.x + pull)} ${r(from.y)} ${r(endX - pull)} ${r(to.y)} ${r(endX)} ${r(to.y)}`;
}

/** A closed, right-pointing triangle whose tip is `tip`. */
export function arrowHeadPath(tip: Pt, length: number = ARROW.length, halfWidth: number = ARROW.halfWidth): string {
  const baseX = r(tip.x - length);
  return `M${baseX} ${r(tip.y - halfWidth)} L${r(tip.x)} ${r(tip.y)} L${baseX} ${r(tip.y + halfWidth)} Z`;
}

/**
 * Where a row's anchor sits when its list is scrolled: `y` inside the visible band `[top, bottom]`
 * (inset so an arrowhead is never cut in half), else pinned to the nearer edge and marked `outside`,
 * which the map draws faded — the curve still says "this way", without pointing at a hidden row.
 */
export function clampToBand(y: number, top: number, bottom: number, inset = ARROW.halfWidth + 1): { y: number; outside: boolean } {
  const lo = top + inset;
  const hi = Math.max(lo, bottom - inset);
  if (y < lo) return { y: lo, outside: true };
  if (y > hi) return { y: hi, outside: true };
  return { y, outside: false };
}

/** What the draft changes against the stored relations, each list in draft/stored order. */
export function draftChanges(stored: readonly number[], draft: readonly number[]): { added: number[]; removed: number[] } {
  return {
    added: draft.filter((id) => !stored.includes(id)),
    removed: stored.filter((id) => !draft.includes(id)),
  };
}

/** The one short line beside Save; null when nothing is pending. */
export function pendingLine(added: number, removed: number): string | null {
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} to add`);
  if (removed > 0) parts.push(`${removed} to remove`);
  return parts.length > 0 ? `Not saved: ${parts.join(', ')}.` : null;
}

/** The repo selected on first view: the first (in list order) that has a relation, else the first. */
export function defaultSelectedRepo(
  orderedIds: readonly number[],
  pairs: ReadonlyArray<{ repoId: number; relatedRepoId: number }>,
): number | null {
  const linked = new Set<number>();
  for (const p of pairs) {
    linked.add(p.repoId);
    linked.add(p.relatedRepoId);
  }
  return orderedIds.find((id) => linked.has(id)) ?? orderedIds[0] ?? null;
}

/** Whether every `owner/name` shares one owner — the map then shows names only (the full name stays
 *  in the row's tooltip). */
export function sharesOneOwner(fullNames: readonly string[]): boolean {
  const owners = new Set(fullNames.map((n) => n.slice(0, Math.max(0, n.indexOf('/')))));
  return owners.size === 1 && !owners.has('');
}

/** Why a right-hand repo cannot be toggled ON: it is the selected repo itself, the PARTNER already has
 *  the most links (`partnerFull`, labelled "already has 8"), or the selected repo's draft is at the
 *  most (`cap`, not the partner's fault, so not labelled on the row). A repo in the draft can always
 *  be toggled off. */
export type BlockReason = 'self' | 'full' | 'cap' | null;
export function blockReason(
  id: number,
  current: number | null,
  draft: readonly number[],
  partnerFull: boolean,
  max: number,
): BlockReason {
  if (id === current) return 'self';
  if (draft.includes(id)) return null;
  if (partnerFull) return 'full';
  if (draft.length >= max) return 'cap';
  return null;
}
