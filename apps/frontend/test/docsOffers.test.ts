import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_OFFER_SNOOZE_DAYS, type RepoDocsOffer } from '@pierre-review/shared';
import { addableOffers, chosenOffers, offerFiles, offerHeading, offerLabel, offersAddProblem } from '../src/lib/docsOffers.js';

const offer = (id: number, extra: Partial<RepoDocsOffer> = {}): RepoDocsOffer => ({
  id,
  repoId: 1,
  repoFullName: 'acme/api',
  path: `docs${id}`,
  docs: 4,
  words: 2400,
  tooLarge: false,
  ...extra,
});

describe('the docs offer', () => {
  it('asks about the folders it can add, by count', () => {
    expect(offerHeading([offer(1), offer(2)])).toBe('Add 2 docs collections from your repositories?');
    expect(offerHeading([offer(1), offer(2, { tooLarge: true })])).toBe('Add a docs collection from your repositories?');
    expect(offerHeading([offer(2, { tooLarge: true })])).toBe('Docs folders in your repositories');
  });

  it('never lets a too-large folder be chosen', () => {
    const list = [offer(1), offer(2, { tooLarge: true }), offer(3)];
    expect(addableOffers(list).map((o) => o.id)).toEqual([1, 3]);
    expect(chosenOffers(list, new Set())).toEqual([1, 3]);
    expect(chosenOffers(list, new Set([3, 2]))).toEqual([1]);
  });

  it('names a folder by repository and path, with its file count', () => {
    expect(offerLabel(offer(1))).toBe('acme/api › docs1');
    expect(offerFiles({ docs: 1 })).toBe('1 file');
    expect(offerFiles({ docs: 12 })).toBe('12 files');
  });

  it('says what was not added', () => {
    expect(offersAddProblem({ added: [{ offerId: 1, docId: 9 }], failed: [] })).toBeNull();
    expect(offersAddProblem({ added: [], failed: [{ offerId: 1, message: 'Gone.' }] })).toBe('Gone.');
    expect(offersAddProblem({ added: [], failed: [{ offerId: 1, message: 'Gone.' }, { offerId: 2, message: 'Full.' }] })).toBe(
      '2 folders were not added. Gone.',
    );
  });
});

describe('"Not now" is temporary', () => {
  const card = readFileSync(fileURLToPath(new URL('../src/components/Activity/DocsOfferCard.tsx', import.meta.url)), 'utf8');
  it('the ⓘ says the card hides for DOCS_OFFER_SNOOZE_DAYS and the folders stay in the wizard', () => {
    expect(DOCS_OFFER_SNOOZE_DAYS).toBe(30);
    expect(card).toContain('Not now hides this card for {DOCS_OFFER_SNOOZE_DAYS} days.');
    expect(card).toContain('From your repositories');
    expect(card).not.toContain('for good');
  });
});
