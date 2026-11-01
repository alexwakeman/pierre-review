import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_SOURCE_LABEL, DOCS_WIZARD_STEPS, githubReviewSentence, nextStep, previousStep, wikiOverCapSentence, wikiReviewSentence } from '../src/lib/docsWizard.js';
import { docTreeNodes, docTreeTrail, slugOfLibraryPath } from '../src/lib/referenceDocs.js';
import { useDocsView } from '../src/store/docsView.js';

// The add-documents wizard's steps and sentences, the tree's reveal trail, and the list's accordion.

describe('the wizard', () => {
  it('starts at the type and ends at the review for every source but an upload', () => {
    for (const [type, steps] of Object.entries(DOCS_WIZARD_STEPS)) {
      expect(steps[0]).toBe('type');
      expect(steps[steps.length - 1]).toBe(type === 'upload' ? 'files' : 'review');
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

// Adding ANY document goes through the wizard: the Library's old "Choose files" box is gone, and the
// wizard's first choice, "Upload a document", does what it did (same call, same accepted types, the
// same per-file refusals and failures).
describe('uploading goes through the wizard', () => {
  const src = (rel: string): string => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
  const wizard = src('components/Activity/DocsAddWizard.tsx');
  const view = src('components/Activity/DocsView.tsx');

  it('offers "Upload a document" first, and its one step is the files', () => {
    expect(Object.keys(DOCS_WIZARD_STEPS)[0]).toBe('upload');
    expect(DOCS_SOURCE_LABEL.upload).toBe('Upload a document');
    expect(DOCS_WIZARD_STEPS.upload).toEqual(['type', 'files']);
    expect(nextStep('upload', 'type')).toBe('files');
    expect(nextStep('upload', 'files')).toBeNull();
  });

  it('the wizard sends files through the same upload call and checks', () => {
    expect(wizard).toContain('useUploadReferenceDoc(workspaceId)');
    expect(wizard).toContain('accept={DOC_UPLOAD_ACCEPT}');
    expect(wizard).toContain('uploadRefusal(f.name, f.size, maxBytes)');
    expect(wizard).toContain('data-testid="docs-drop-zone"');
    expect(wizard).toContain('data-ai-run');
  });

  it('the Library has no file picker or drop zone of its own', () => {
    expect(view).not.toContain('Choose files');
    expect(view).not.toContain('docs-drop-zone');
    expect(view).not.toContain('type="file"');
    expect(view).not.toContain('useUploadReferenceDoc');
  });

  it('a built document opens from anywhere on its row (the hand shows)', () => {
    const row = view.slice(view.indexOf('data-testid="doc-row-open"') - 400, view.indexOf('data-testid="doc-row-open"') + 400);
    expect(row).toContain('cursor-pointer');
    expect(row).toContain('<DocMetaLine');
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
