import { describe, it, expect } from 'vitest';
import { globToRegExp } from './codeowners.js';

// Locks the CODEOWNERS glob semantics (a best-effort subset of GitHub's rules). The
// load-bearing cases are the ones the adversarial review caught: `dir/*` is SINGLE-LEVEL
// (must not match nested files) and `**/name` must preserve the `/` boundary (must not
// match a basename that merely ends in the substring).
const matches = (pattern: string, path: string): boolean =>
  globToRegExp(pattern).test(path);

describe('globToRegExp — CODEOWNERS pattern matching', () => {
  it('`*` (bare) matches every file at any depth', () => {
    expect(matches('*', 'README.md')).toBe(true);
    expect(matches('*', 'src/deep/nested/file.ts')).toBe(true);
  });

  it('`dir/*` is single-level (matches direct children, NOT nested)', () => {
    expect(matches('docs/*', 'docs/getting-started.md')).toBe(true);
    expect(matches('docs/*', 'docs/build-app/troubleshooting.md')).toBe(false);
    expect(matches('src/*', 'src/a.ts')).toBe(true);
    expect(matches('src/*', 'src/a/deep/nested.ts')).toBe(false);
  });

  it('`**/name` preserves the segment boundary (no substring match)', () => {
    expect(matches('**/logs', 'logs')).toBe(true);
    expect(matches('**/logs', 'build/logs')).toBe(true);
    expect(matches('**/logs', 'deeply/nested/logs')).toBe(true);
    expect(matches('**/logs', 'mylogs')).toBe(false);
    expect(matches('/**/logs', 'x/logs')).toBe(true);
    expect(matches('/**/logs', 'mylogs')).toBe(false);
  });

  it('a trailing-slash directory owns everything under it', () => {
    expect(matches('apps/backend/', 'apps/backend/src/x.ts')).toBe(true);
    expect(matches('apps/backend/', 'apps/frontend/src/x.ts')).toBe(false);
  });

  it('a bare literal path owns the path AND its contents', () => {
    expect(matches('apps/backend', 'apps/backend/src/x.ts')).toBe(true);
    expect(matches('apps/backend', 'apps/backend')).toBe(true);
    expect(matches('apps/backend', 'apps/backendx')).toBe(false);
  });

  it('an extension glob matches at any depth', () => {
    expect(matches('*.ts', 'x.ts')).toBe(true);
    expect(matches('*.ts', 'a/b/x.ts')).toBe(true);
    expect(matches('*.ts', 'x.tsx')).toBe(false);
  });

  it('`dir/**/*.ext` matches nested files of that extension', () => {
    expect(matches('apps/**/*.test.ts', 'apps/backend/src/x.test.ts')).toBe(true);
    expect(matches('apps/**/*.test.ts', 'apps/x.test.ts')).toBe(true);
    expect(matches('apps/**/*.test.ts', 'apps/backend/src/x.ts')).toBe(false);
    expect(matches('apps/**/*.test.ts', 'other/x.test.ts')).toBe(false);
  });

  it('an unanchored bare name matches at any depth', () => {
    expect(matches('CODEOWNERS', '.github/CODEOWNERS')).toBe(true);
    expect(matches('CODEOWNERS', 'CODEOWNERS')).toBe(true);
  });
});
