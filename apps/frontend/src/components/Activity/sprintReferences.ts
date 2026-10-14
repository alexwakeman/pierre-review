import type { SprintReferenceRelation, SprintTicketReference } from '@pierre-review/shared';

// THE DRAWER'S "OTHER TICKETS" — pure (test/sprintReferences.test.ts). How the opened ticket's linked
// tickets are grouped, labelled and explained in SprintTicketDrawer. Its own module so the drawer does
// not depend on the graph model's ordering.
//
//   • ORDER: what this ticket WAITS on first (a blocking tracker link, then the text's "depends on"),
//     then work alongside, then history, then the loose ties: Related (a non-blocking tracker link),
//     Context, Out of scope.
//   • WITHIN a group: not-done first, then by key.
//   • THE REASON (`why`) is the row's sentence; the QUOTE is shown under it only when it ADDS
//     something — never when the reason already contains its words.

export const DRAWER_REFERENCE_ORDER: readonly SprintReferenceRelation[] = [
  'blocked_by',
  'depends_on',
  'concurrent',
  'builds_on',
  'supersedes',
  'linked',
  'context',
  'out_of_scope',
];

export const DRAWER_REFERENCE_LABEL: Record<SprintReferenceRelation, string> = {
  blocked_by: 'Blocked by',
  depends_on: 'Depends on',
  concurrent: 'Built alongside',
  builds_on: 'Builds on',
  supersedes: 'Replaces',
  linked: 'Related',
  context: 'Context',
  out_of_scope: 'Out of scope',
};

export interface DrawerReferenceGroup {
  relation: SprintReferenceRelation;
  label: string;
  refs: SprintTicketReference[];
}

/** References grouped by relation in DRAWER_REFERENCE_ORDER; within a group, not-done first, then key. */
export function drawerReferenceGroups(refs: readonly SprintTicketReference[]): DrawerReferenceGroup[] {
  const out: DrawerReferenceGroup[] = [];
  for (const relation of DRAWER_REFERENCE_ORDER) {
    const list = refs
      .filter((r) => r.relation === relation)
      .sort((a, b) => Number(a.done === true) - Number(b.done === true) || a.key.localeCompare(b.key, undefined, { numeric: true }));
    if (list.length > 0) out.push({ relation, label: DRAWER_REFERENCE_LABEL[relation], refs: list });
  }
  return out;
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The reason sentence to print, or null (none given, or blank). */
export function referenceWhy(r: Pick<SprintTicketReference, 'why'>): string | null {
  const w = r.why?.trim() ?? '';
  return w === '' ? null : w;
}

/** The quote to print under the reason, or null: absent, blank, or already inside the reason. */
export function referenceQuote(r: Pick<SprintTicketReference, 'why' | 'quote'>): string | null {
  const q = r.quote?.trim() ?? '';
  if (q === '') return null;
  const why = referenceWhy(r);
  if (why != null) {
    const nq = norm(q);
    if (nq === '' || norm(why).includes(nq)) return null;
  }
  return q;
}
