// The Changes tab's inline-thread OPEN default. `inlineThreadStartsOpen` (lib/diff.ts) is the ONE
// place that decides whether a review-thread pill starts open: the reader's remembered decision
// (`DiffThreadContext.openMemory`, keyed by thread id, owned by PrDetail) wins in both directions,
// else the thread's CURRENT state — open unless resolved. The write-through half (every click,
// reveal and posted self-focus recording a decision) lives in the InlineThread component, which
// this suite cannot render (vitest.config pins `test/**/*.test.ts`, no JSX). Below it: who owns
// the scroll on an "In Changes" jump (`revealScrollsFileHeader`), and the FileDiffView memo guard,
// pinned from source because an open-by-default diff is exactly what makes a missed memo slow.
// Run by hand:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DERIVED_STATES } from '@pierre-review/shared';
import { inlineThreadStartsOpen, revealScrollsFileHeader } from '../src/lib/diff.js';

describe('inlineThreadStartsOpen', () => {
  it('opens every unresolved state and shuts only resolved — a new DerivedState must be decided here', () => {
    const open = DERIVED_STATES.filter((s) => inlineThreadStartsOpen({ id: 1, derivedState: s }));
    expect([...open].sort()).toEqual(['likely_addressed', 'replied_unresolved', 'untouched']);
  });

  it('no memory (undefined / null): the state decides', () => {
    for (const memory of [undefined, null]) {
      expect(inlineThreadStartsOpen({ id: 1, derivedState: 'untouched' }, memory)).toBe(true);
      expect(inlineThreadStartsOpen({ id: 1, derivedState: 'resolved' }, memory)).toBe(false);
    }
  });

  it("keeps the reader's collapse of an unresolved thread", () => {
    const memory = new Map([[7, false]]);
    expect(inlineThreadStartsOpen({ id: 7, derivedState: 'untouched' }, memory)).toBe(false);
    expect(inlineThreadStartsOpen({ id: 7, derivedState: 'likely_addressed' }, memory)).toBe(false);
  });

  it("keeps the reader's open of a resolved thread", () => {
    const memory = new Map([[7, true]]);
    expect(inlineThreadStartsOpen({ id: 7, derivedState: 'resolved' }, memory)).toBe(true);
  });

  it('a decision taken while unresolved survives the thread resolving', () => {
    const memory = new Map([[7, true]]);
    expect(inlineThreadStartsOpen({ id: 7, derivedState: 'untouched' }, memory)).toBe(true);
    // The ~5s poll (or a bulk resolve in Threads) flips the state; the reader's open stands.
    expect(inlineThreadStartsOpen({ id: 7, derivedState: 'resolved' }, memory)).toBe(true);
  });

  it('an undecided thread follows its CURRENT state — one resolved elsewhere comes back shut', () => {
    const memory = new Map([[8, true]]);
    expect(inlineThreadStartsOpen({ id: 7, derivedState: 'resolved' }, memory)).toBe(false);
  });

  it('reads the decision for THIS thread id only', () => {
    const memory = new Map([[8, false]]);
    expect(inlineThreadStartsOpen({ id: 7, derivedState: 'untouched' }, memory)).toBe(true);
  });
});

// ---- the "In Changes" jump when pills start open ------------------------------------------------
// A thread reveal whose target has no addressable row (file grain, a reconstructed line not in this
// patch, the LEFT-only anchor) used to scroll TWICE: the pill to its own header, then the block to
// the file header — child-first effects, so the block won. Harmless while pills started shut; with
// unresolved pills open, every open card above the target pushed it below the fold.
describe('revealScrollsFileHeader', () => {
  const threads = [{ id: 1 }, { id: 2 }];

  it('a row the reveal addresses scrolls itself — never the file header', () => {
    expect(revealScrollsFileHeader({ threadId: null }, 12, threads)).toBe(false);
    expect(revealScrollsFileHeader({ threadId: 2 }, 12, threads)).toBe(false);
  });

  it('a thread this block renders owns the scroll, even with no addressable row', () => {
    expect(revealScrollsFileHeader({ threadId: 2 }, null, threads)).toBe(false);
  });

  it('a file / unaddressable-line reveal with no thread scrolls the header — never do nothing', () => {
    expect(revealScrollsFileHeader({}, null, threads)).toBe(true);
    expect(revealScrollsFileHeader({ threadId: null }, null, threads)).toBe(true);
  });

  it('a thread this block does NOT render cannot scroll itself, so the header does', () => {
    expect(revealScrollsFileHeader({ threadId: 9 }, null, threads)).toBe(true);
    // No thread context ⇒ FileDiffBlock passes [] — no pill exists to own the scroll.
    expect(revealScrollsFileHeader({ threadId: 1 }, null, [])).toBe(true);
  });
});

// ---- the memo guard, pinned from source -----------------------------------------------------------
// FileDiffView is memo'd so a PR-detail refetch that leaves the threads alone (a CI check finishing,
// a merge-state move — the ~5s live poll) does not re-render every diff row and every open thread
// card: MEASURED 1.3–1.5s of long tasks on a 532-thread PR when it missed. Nothing fails when a new
// unstable prop sneaks in; it just gets slow. So the inputs are pinned here.
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/components/${rel}`, import.meta.url)), 'utf8')
    // Comments out: the ⚠ notes NAME the old dependency in order to forbid it.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** The dependency list of the hook call assigned to `name` (`const name = useX(…, [deps]);`). */
function depsOf(src: string, name: string): string[] {
  const start = src.indexOf(`const ${name} = use`);
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
  const m = /\[([^\]]*)\],?\s*\);/.exec(src.slice(start));
  expect(m, `${name} has no dependency list`).not.toBeNull();
  return (m?.[1] ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d !== '');
}

describe('FileDiffView memo guard', () => {
  it('FileDiffView is memo-wrapped', () => {
    expect(read('diff/FileDiffView.tsx')).toMatch(
      /export const FileDiffView = memo\(function FileDiffView\(/,
    );
  });

  it("ChangesTab's threadCtx depends only on data and stable-by-construction values", () => {
    // Deliberately an ALLOW-list: a new dependency must be argued stable, then added here.
    // `onOpenThread` (the caller's callback) is read through a ref precisely so it is NOT here.
    expect(depsOf(read('ChangesTab.tsx'), 'threadCtx').sort()).toEqual(
      [
        'canOpenThread',
        'openThread',
        'pr.githubUrl',
        'threadOpenMemory',
        'threadsByPath',
        'usersById',
      ].sort(),
    );
  });

  it("ChangesTab's other memo'd props key on stable values", () => {
    const src = read('ChangesTab.tsx');
    expect(depsOf(src, 'commenting')).toEqual(['pr.id']);
    expect(depsOf(src, 'openThread')).toEqual([]);
  });

  it("PrDetail's openThreadInThreads keys on the id, never the whole `pr` object", () => {
    const deps = depsOf(read('PrDetail.tsx'), 'openThreadInThreads');
    expect(deps).not.toContain('pr');
    expect(deps).toContain('prId');
  });
});
