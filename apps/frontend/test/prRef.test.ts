// Tests for the trunk strip's headline cleanup.
//
// The frontend workspace ships NO vitest devDependency (it has never had a test), and adding one
// would touch the root lockfile. So these run the same way `packages/pro`'s suites do — from the
// one workspace that HAS vitest, pointed at this root:
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
//
// The file lives OUTSIDE `src/` on purpose: `apps/frontend/tsconfig.json` includes only `src`, so
// `pnpm typecheck` never tries to resolve the (uninstalled) `vitest` types from here — exactly the
// arrangement `packages/pro/tsconfig.json` uses for `packages/pro/test/`.
import { describe, expect, it } from 'vitest';
import { trimTrailingPrRef } from '../src/lib/prRef.js';

describe('trimTrailingPrRef', () => {
  it('drops a complete trailing ref for the same PR', () => {
    expect(trimTrailingPrRef('Fix the thing (#123)', 123)).toBe('Fix the thing');
  });

  it('leaves the headline alone when there is no PR', () => {
    expect(trimTrailingPrRef('Fix the thing (#123)', null)).toBe('Fix the thing (#123)');
  });

  it('leaves a trailing ref naming a different PR alone', () => {
    expect(trimTrailingPrRef('Revert "Fix the thing" (#99)', 123)).toBe(
      'Revert "Fix the thing" (#99)',
    );
  });

  // The regression. GitHub truncates `messageHeadline` itself, and the ref sits at the very end of
  // a squash subject, so it is the first thing eaten. Every input below is a REAL stored headline
  // from a live account's branch_commits table, verbatim.
  it.each([
    // ['stored headline', prNumber, expected]
    [
      'Reextract texture sliced `ImageNode`s on `CalculatedClip` removal (#2…',
      25207,
      'Reextract texture sliced `ImageNode`s on `CalculatedClip` removal',
    ],
    [
      'Remove `ui::Interaction` from doc in `ui_node.rs` (Extra Item 8) (#25…',
      25208,
      'Remove `ui::Interaction` from doc in `ui_node.rs` (Extra Item 8)',
    ],
    [
      'Make update_cursors run in a new CursorSystems::Update system set (#2…',
      25165,
      'Make update_cursors run in a new CursorSystems::Update system set',
    ],
    [
      'fix(sales): prevent crash when editing a product row with no name (#8…',
      8815,
      'fix(sales): prevent crash when editing a product row with no name',
    ],
  ])('drops a TRUNCATED trailing ref: %s', (headline, prNumber, expected) => {
    expect(trimTrailingPrRef(headline as string, prNumber as number)).toBe(expected);
  });

  it('drops a ref truncated at the closing paren', () => {
    expect(trimTrailingPrRef('Fix the thing (#123…', 123)).toBe('Fix the thing');
  });

  // The narrowness of the rule is the point: without at least one matching digit we cannot tell a
  // half-eaten ref from any other parenthetical, and there is no duplicated number to hide.
  it('keeps a truncation cut before the ref digits', () => {
    expect(
      trimTrailingPrRef('Inspector: Use absolute positioning and add alignment configuration (…', 34137),
    ).toBe('Inspector: Use absolute positioning and add alignment configuration (…');
  });

  // Reaches the digit-count guard specifically: the cases above bail earlier, on there being no
  // ' (#' at all. Cut at the '#', nothing is duplicated — there is no number on screen — so the
  // fragment stays as the truncation hint.
  it('keeps a ref truncated before any digits', () => {
    expect(trimTrailingPrRef('Fix the thing (#…', 123)).toBe('Fix the thing (#…');
  });

  it('keeps a truncated ref whose digits do not prefix this PR', () => {
    expect(trimTrailingPrRef('Revert "Fix the thing" (#9…', 123)).toBe(
      'Revert "Fix the thing" (#9…',
    );
  });

  it('keeps a truncated non-ref parenthetical', () => {
    expect(trimTrailingPrRef('Bump deps (see release notes…', 123)).toBe(
      'Bump deps (see release notes…',
    );
  });

  it('keeps a headline truncated mid-word', () => {
    expect(trimTrailingPrRef('Refactor the enormous configuration modu…', 123)).toBe(
      'Refactor the enormous configuration modu…',
    );
  });

  // Three dots are not GitHub's truncation marker, and a headline can legitimately end that way.
  it('does not treat literal "..." as truncation', () => {
    expect(trimTrailingPrRef('Work in progress (#12...', 123)).toBe('Work in progress (#12...');
  });

  it('leaves a leading "Merge pull request #N" headline alone', () => {
    expect(trimTrailingPrRef('Merge pull request #6001 from foo/bar-baz…', 6001)).toBe(
      'Merge pull request #6001 from foo/bar-baz…',
    );
  });
});
