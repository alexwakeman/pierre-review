import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deriveThreadState,
  type CommitInput,
  type DerivedState,
  type ThreadInput,
} from './derive-thread-state.js';

interface Fixture {
  name: string;
  expected: DerivedState;
  thread: ThreadInput;
  commits: CommitInput[];
  commitFiles: Record<string, string[]>;
}

const fixturesDir = resolve(import.meta.dirname, '__fixtures__/threads');

function loadFixtures(): Fixture[] {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(fixturesDir, f), 'utf-8')) as Fixture);
}

describe('deriveThreadState — fixtures', () => {
  for (const fx of loadFixtures()) {
    it(fx.name, () => {
      const map = new Map(Object.entries(fx.commitFiles));
      expect(deriveThreadState(fx.thread, fx.commits, map)).toBe(fx.expected);
    });
  }
});

describe('deriveThreadState — units', () => {
  it('classifies an empty thread as untouched', () => {
    expect(
      deriveThreadState({ isResolved: false, path: 'a.ts', comments: [] }, [], new Map()),
    ).toBe('untouched');
  });

  it('ignores commits to the file made before the last comment', () => {
    const thread: ThreadInput = {
      isResolved: false,
      path: 'a.ts',
      comments: [{ author: { login: 'anna' }, createdAt: '2026-01-02T00:00:00Z' }],
    };
    const commits: CommitInput[] = [
      { oid: 'old', committedDate: '2026-01-01T00:00:00Z' },
    ];
    expect(deriveThreadState(thread, commits, new Map([['old', ['a.ts']]]))).toBe(
      'untouched',
    );
  });

  it('uses the LAST comment as the cutoff, not the first', () => {
    const thread: ThreadInput = {
      isResolved: false,
      path: 'a.ts',
      comments: [
        { author: { login: 'anna' }, createdAt: '2026-01-01T00:00:00Z' },
        { author: { login: 'bob' }, createdAt: '2026-01-03T00:00:00Z' },
      ],
    };
    // Commit lands after the first comment but before the second -> not addressed.
    const commits: CommitInput[] = [
      { oid: 'mid', committedDate: '2026-01-02T00:00:00Z' },
    ];
    expect(deriveThreadState(thread, commits, new Map([['mid', ['a.ts']]]))).toBe(
      'replied_unresolved',
    );
  });

  it('treats a null-author comment without crashing', () => {
    const thread: ThreadInput = {
      isResolved: false,
      path: 'a.ts',
      comments: [
        { author: null, createdAt: '2026-01-01T00:00:00Z' },
        { author: { login: 'bob' }, createdAt: '2026-01-02T00:00:00Z' },
      ],
    };
    expect(deriveThreadState(thread, [], new Map())).toBe('replied_unresolved');
  });
});
