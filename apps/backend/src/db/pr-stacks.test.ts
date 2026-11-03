import { describe, expect, it } from 'vitest';
import { deriveBranchStacks, stackParents, type StackPrRow } from './pr-stacks.js';

// STACKED PRs — the pure fold (docs/FRONTEND.md § PR chips).

const row = (id: number, head: string | null, base: string | null, extra: Partial<StackPrRow> = {}): StackPrRow => ({
  id,
  repoId: 1,
  number: id * 10,
  title: `PR ${id}`,
  headRefName: head,
  baseRefName: base,
  isCrossRepository: false,
  ...extra,
});
const defaults = new Map<number, string | null>([[1, 'main'], [2, 'main']]);

describe('stackParents', () => {
  it('a PR whose base is another open PR’s head lands after it', () => {
    const p = stackParents([row(1, 'a', 'main'), row(2, 'b', 'a')], defaults);
    expect([...p]).toEqual([[2, 1]]);
  });

  it('never across repos', () => {
    const p = stackParents([row(1, 'a', 'main'), row(2, 'b', 'a', { repoId: 2 })], defaults);
    expect(p.size).toBe(0);
  });

  it('a fork’s branch is never a parent; null (not observed) is accepted', () => {
    expect(stackParents([row(1, 'a', 'main', { isCrossRepository: true }), row(2, 'b', 'a')], defaults).size).toBe(0);
    expect(stackParents([row(1, 'a', 'main', { isCrossRepository: null }), row(2, 'b', 'a')], defaults).get(2)).toBe(1);
  });

  it('a PR from the default branch (e.g. main → release) is never a parent', () => {
    const p = stackParents([row(1, 'main', 'release'), row(2, 'b', 'main')], defaults);
    expect(p.size).toBe(0);
  });

  it('two open PRs from the same branch is ambiguous: no parent', () => {
    const p = stackParents([row(1, 'a', 'main'), row(3, 'a', 'release'), row(2, 'b', 'a')], defaults);
    expect(p.has(2)).toBe(false);
  });

  it('a cycle is not a stack', () => {
    const p = stackParents([row(1, 'a', 'b'), row(2, 'b', 'a'), row(3, 'c', 'a')], defaults);
    expect(p.size).toBe(0);
  });

  it('a missing branch name is no claim', () => {
    expect(stackParents([row(1, null, 'main'), row(2, 'b', null)], defaults).size).toBe(0);
  });
});

describe('deriveBranchStacks', () => {
  it('a chain of three: positions 1, 2, 3 of 3, parents and children named', () => {
    const s = deriveBranchStacks([row(1, 'a', 'main'), row(2, 'b', 'a'), row(3, 'c', 'b'), row(4, 'x', 'main')], defaults);
    expect(s.has(4)).toBe(false);
    expect(s.get(1)).toMatchObject({ position: 1, parent: null, children: [{ prId: 2, number: 20 }] });
    expect(s.get(2)).toMatchObject({ position: 2, parent: { prId: 1, number: 10 }, children: [{ prId: 3 }] });
    expect(s.get(3)).toMatchObject({ position: 3, parent: { prId: 2 }, children: [] });
    for (const id of [1, 2, 3]) expect(s.get(id)!.chain.map((m) => m.prId)).toEqual([1, 2, 3]);
  });

  it('a branch with two PRs on it ends the chain there; both are children', () => {
    const s = deriveBranchStacks([row(1, 'a', 'main'), row(2, 'b', 'a'), row(3, 'c', 'a')], defaults);
    expect(s.get(1)).toMatchObject({ position: 1, chain: [{ prId: 1 }], children: [{ prId: 2 }, { prId: 3 }] });
    expect(s.get(2)!.chain.map((m) => m.prId)).toEqual([1, 2]);
    expect(s.get(3)!.chain.map((m) => m.prId)).toEqual([1, 3]);
  });
});
