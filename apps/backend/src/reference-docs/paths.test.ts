import { describe, expect, it } from 'vitest';
import { parseLibraryPath, slugify, uniqueDocSlug } from './paths.js';

describe('parseLibraryPath — the strict grammar every requested or cited path goes through', () => {
  it('accepts the three levels, and strips an anchor', () => {
    expect(parseLibraryPath('INDEX.md')?.path).toEqual({ kind: 'index', path: 'INDEX.md' });
    expect(parseLibraryPath('billing/CONTENTS.md')?.path).toMatchObject({ kind: 'contents', slug: 'billing' });
    const s = parseLibraryPath('billing/sections/04-refunds.md#partial-refunds');
    expect(s?.path).toMatchObject({ kind: 'section', slug: 'billing', file: '04-refunds.md', path: 'billing/sections/04-refunds.md' });
    expect(s?.anchor).toBe('partial-refunds');
    expect(parseLibraryPath('./billing/CONTENTS.md')?.path.path).toBe('billing/CONTENTS.md');
  });

  it.each([
    '../INDEX.md',
    '../../etc/passwd',
    '/etc/passwd',
    'billing/../other/CONTENTS.md',
    'billing/sections/../../x.md',
    'billing\\sections\\01-a.md',
    'billing/sections/01-a.md\u0000.png',
    'billing/sections/%2e%2e/01-a.md',
    'Billing/CONTENTS.md',
    'billing/sections/a.md',
    'billing/sections/01-a.txt',
    'billing/notes.md',
    'billing/sections/sub/01-a.md',
    '',
    `${'a'.repeat(300)}/CONTENTS.md`,
  ])('refuses %j', (p) => {
    expect(parseLibraryPath(p)).toBeNull();
  });

  it('drops an anchor that is not a plain anchor', () => {
    expect(parseLibraryPath('billing/CONTENTS.md#"><script>')?.anchor).toBeNull();
  });
});

describe('slugs', () => {
  it('folds to lower-case ASCII with single hyphens', () => {
    expect(slugify('Café Menu — 2026 (Final)!')).toBe('cafe-menu-2026-final');
    expect(slugify('***')).toBe('');
  });
  it('is unique in the workspace and never empty', () => {
    expect(uniqueDocSlug('Handbook', new Set(['handbook', 'handbook-2']))).toBe('handbook-3');
    expect(uniqueDocSlug('', new Set())).toBe('document');
  });
});
