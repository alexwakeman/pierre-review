import { describe, expect, it } from 'vitest';
import { DOCS_WIZARD_STEPS, githubReviewSentence, nextStep, previousStep, wikiOverCapSentence, wikiReviewSentence } from '../src/lib/docsWizard.js';
import { docTreeNodes, docTreeTrail, slugOfLibraryPath } from '../src/lib/referenceDocs.js';
import { useDocsView } from '../src/store/docsView.js';

// The add-documents wizard's steps and sentences, the tree's reveal trail, and the list's accordion.

describe('the wizard', () => {
  it('starts at the type and ends at the review for every source', () => {
    for (const steps of Object.values(DOCS_WIZARD_STEPS)) {
      expect(steps[0]).toBe('type');
      expect(steps[steps.length - 1]).toBe('review');
    }
    expect(nextStep('confluence', 'connection')).toBe('page');
    expect(nextStep('github', 'repo')).toBe('folder');
    expect(previousStep('web', 'review')).toBe('address');
    expect(nextStep('web', 'review')).toBeNull();
    expect(previousStep('notion', 'type')).toBeNull();
  });

  it('says what it will add, counted', () => {
    expect(wikiReviewSentence({ pageCount: 12, rootTitle: 'Payments handbook', scope: { kind: 'tree' } })).toBe('This will add 12 pages from Payments handbook.');
    expect(wikiReviewSentence({ pageCount: 1, rootTitle: 'Home', scope: { kind: 'space', name: 'Engineering', key: 'ENG', id: '1' } })).toBe(
      'This will add 1 page from the whole Engineering wiki.',
    );
    expect(wikiOverCapSentence({ more: false })).toBeNull();
    expect(wikiOverCapSentence({ more: true })).toMatch(/first 100 pages/);
    expect(githubReviewSentence('acme/handbook', { path: 'docs', docs: 9 })).toBe('This will add 9 documents from acme/handbook/docs.');
    expect(githubReviewSentence('acme/handbook', { path: '', docs: 1 })).toBe('This will add 1 document from acme/handbook.');
  });
});

describe('revealing a cited section', () => {
  const rows = [
    { kind: 'group' as const, key: 'g:a', title: 'Payments', depth: 1 },
    { kind: 'section' as const, key: 's:h/sections/01-refunds.md', title: 'Refunds', depth: 2, path: 'h/sections/01-refunds.md', summary: '' },
    { kind: 'heading' as const, key: 'h:h/sections/01-refunds.md#windows', title: 'Windows', depth: 3, path: 'h/sections/01-refunds.md', anchor: 'windows' },
  ];
  const nodes = docTreeNodes(rows);
  it('opens every branch above the row, the heading when the anchor names one', () => {
    expect(docTreeTrail(nodes, 'h/sections/01-refunds.md', 'windows')).toEqual({ key: 'h:h/sections/01-refunds.md#windows', ancestors: ['g:a', 's:h/sections/01-refunds.md'] });
    expect(docTreeTrail(nodes, 'h/sections/01-refunds.md', null)).toEqual({ key: 's:h/sections/01-refunds.md', ancestors: ['g:a'] });
    expect(docTreeTrail(nodes, 'h/sections/01-refunds.md', 'gone')?.key).toBe('s:h/sections/01-refunds.md');
    expect(docTreeTrail(nodes, 'h/CONTENTS.md', null)).toBeNull();
    expect(slugOfLibraryPath('h/sections/01-refunds.md')).toBe('h');
    expect(slugOfLibraryPath('INDEX.md')).toBeNull();
  });
});

describe('the document list is an accordion', () => {
  it('expanding one document closes the other', () => {
    const s = useDocsView.getState();
    s.setExpanded(7, 1, true);
    s.setExpanded(7, 2, true);
    expect(useDocsView.getState().expanded[7]).toEqual([2]);
    s.toggleExpanded(7, 3);
    expect(useDocsView.getState().expanded[7]).toEqual([3]);
    s.toggleExpanded(7, 3);
    expect(useDocsView.getState().expanded[7]).toEqual([]);
    s.openPath(7, 'h/sections/01-x.md', null, null, true);
    expect(useDocsView.getState().open[7]?.reveal).toBe(true);
    s.openPath(7, 'h/sections/01-x.md');
    expect(useDocsView.getState().open[7]?.reveal).toBeUndefined();
  });
});
