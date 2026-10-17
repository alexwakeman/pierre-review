import type { SprintTicketReference } from '@pierre-review/shared';

// A REFERENCE'S WORDS — pure (test/sprintReferences.test.ts). The graph's edge popovers print a
// tie's reason (`why`) and, under it, the ticket's own words (the QUOTE) only when they ADD something —
// never when the reason already contains them. (The drawer's grouped "Other tickets" list was removed
// with the drawer: the story view shows no dependency or reference cards.)

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
