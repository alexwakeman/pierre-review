// THE DOCS CONTENTS NAME CLICK (lib/referenceDocs.ts `contentsNameClick`, Activity/DocsView.tsx): a
// document's or a section's NAME in the Library works like its chevron AND opens it in the viewer.
//   closed                     → open it in the viewer and expand it
//   expanded and on show       → collapse it (it stays on show)
//   expanded, something else on show → open it, still expanded (a second click collapses it)
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend docsContentsNameClick
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentsNameClick } from '../src/lib/referenceDocs.js';

const view = readFileSync(join(__dirname, '..', 'src', 'components', 'Activity', 'DocsView.tsx'), 'utf8');

describe('contentsNameClick', () => {
  it('a closed row opens in the viewer and expands', () => {
    expect(contentsNameClick({ expanded: false, current: false })).toEqual({ open: true, expanded: true });
    expect(contentsNameClick({ expanded: false, current: true })).toEqual({ open: false, expanded: true });
  });
  it('the expanded row on show collapses and stays on show', () => {
    expect(contentsNameClick({ expanded: true, current: true })).toEqual({ open: false, expanded: false });
  });
  it('an expanded row not on show opens and stays expanded', () => {
    expect(contentsNameClick({ expanded: true, current: false })).toEqual({ open: true, expanded: true });
  });
});

describe('the Library uses it for both kinds of row', () => {
  it('a section name and a document name both go through it (buttons, so Enter and Space too)', () => {
    expect(view).toMatch(/contentsNameClick\(\{ expanded: isOpen, current: on \}\)/);
    expect(view).toMatch(/contentsNameClick\(\{ expanded, current: onContents \}\)/);
    expect(view).toMatch(/aria-expanded=\{hasChildren \? isOpen : undefined\}/);
  });
});
