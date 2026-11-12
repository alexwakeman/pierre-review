import { describe, expect, it } from 'vitest';
import type { Workspace } from '@pierre-review/shared';
import { membershipsOf, nextGridState } from '../src/components/Activity/workspaceMembership.js';

const ws = (id: number, name: string, repoIds: number[], externalRepoIds: number[] = []): Workspace =>
  ({ id, name, repoIds, externalRepoIds, repoCount: repoIds.length, isDefault: id === 1 }) as unknown as Workspace;

describe('membershipsOf', () => {
  it('reads Maintained and External per workspace', () => {
    const list = [ws(1, 'Default', [10]), ws(2, 'Platform', [10, 11], [10]), ws(3, 'Mobile', [])];
    expect(membershipsOf(10, list)).toEqual([
      { workspaceId: 1, name: 'Default', state: 'watched' },
      { workspaceId: 2, name: 'Platform', state: 'external' },
    ]);
    expect(membershipsOf(12, list)).toEqual([]);
  });
});

describe('nextGridState', () => {
  it('cycles none → External → Maintained → none', () => {
    expect(nextGridState(null, 1)).toBe('external');
    expect(nextGridState('external', 2)).toBe('watched');
    expect(nextGridState('watched', 2)).toBeNull();
  });
  it('never empties the only membership', () => {
    expect(nextGridState('watched', 1)).toBe('external');
    expect(nextGridState('external', 1)).toBe('watched');
  });
});
