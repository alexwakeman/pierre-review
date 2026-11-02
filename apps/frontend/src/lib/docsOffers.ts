import { docsOfferQuestion, type RepoDocsOffer, type RepoDocsOffersAddResponse } from '@pierre-review/shared';

// THE DOCS OFFER, AS DATA (docs/REFERENCE-DOCS.md § Docs offered from your repositories). The card
// (components/Activity/DocsOfferCard.tsx) renders it on the Docs page and on Pending;
// `test/docsOffers.test.ts` pins it.

/** The folders the card can add (a too-large one only points at the add-documents wizard). */
export const addableOffers = (offers: readonly RepoDocsOffer[]): RepoDocsOffer[] => offers.filter((o) => !o.tooLarge);

/** The card's heading: the question over what it can add, or a plain title when it can add none. */
export function offerHeading(offers: readonly RepoDocsOffer[]): string {
  const n = addableOffers(offers).length;
  return n === 0 ? 'Docs folders in your repositories' : docsOfferQuestion(n);
}

/** "acme/api › docs" */
export const offerLabel = (o: Pick<RepoDocsOffer, 'repoFullName' | 'path'>): string => `${o.repoFullName} › ${o.path}`;

/** "12 files" */
export const offerFiles = (o: Pick<RepoDocsOffer, 'docs'>): string => `${o.docs} ${o.docs === 1 ? 'file' : 'files'}`;

/** Every addable folder starts chosen; a folder that left the list leaves the choice. */
export function chosenOffers(offers: readonly RepoDocsOffer[], unticked: ReadonlySet<number>): number[] {
  return addableOffers(offers)
    .map((o) => o.id)
    .filter((id) => !unticked.has(id));
}

/** The line after an Add that did not add everything, or null. */
export function offersAddProblem(res: RepoDocsOffersAddResponse): string | null {
  if (res.failed.length === 0) return null;
  const first = res.failed[0]!.message;
  return res.failed.length === 1 ? first : `${res.failed.length} folders were not added. ${first}`;
}
