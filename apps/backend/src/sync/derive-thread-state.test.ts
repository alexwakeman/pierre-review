import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AddressedConfidence } from '@pierre-review/shared';
import {
  deriveThreadState,
  type CommitInput,
  type DerivedState,
  type ThreadInput,
} from './derive-thread-state.js';

interface Fixture {
  name: string;
  expected: DerivedState;
  // Optional — asserted only when present, so pre-existing fixtures need no confidence field.
  expectedConfidence?: AddressedConfidence;
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
      const result = deriveThreadState(fx.thread, fx.commits, map);
      expect(result.state).toBe(fx.expected);
      if (fx.expectedConfidence) {
        expect(result.addressedConfidence).toBe(fx.expectedConfidence);
      }
    });
  }
});

describe('deriveThreadState — units', () => {
  it('classifies an empty thread as untouched', () => {
    const r = deriveThreadState(
      { isResolved: false, path: 'a.ts', comments: [] },
      [],
      new Map(),
    );
    expect(r.state).toBe('untouched');
    expect(r.addressedConfidence).toBe('none');
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
    expect(
      deriveThreadState(thread, commits, new Map([['old', ['a.ts']]])).state,
    ).toBe('untouched');
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
    expect(
      deriveThreadState(thread, commits, new Map([['mid', ['a.ts']]])).state,
    ).toBe('replied_unresolved');
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
    expect(deriveThreadState(thread, [], new Map()).state).toBe('replied_unresolved');
  });

  it('promotes an outdated thread to likely_addressed (medium) with no commit', () => {
    const thread: ThreadInput = {
      isResolved: false,
      isOutdated: true,
      path: 'a.ts',
      comments: [{ author: { login: 'anna' }, createdAt: '2026-01-01T00:00:00Z' }],
    };
    const r = deriveThreadState(thread, [], new Map());
    expect(r.state).toBe('likely_addressed');
    expect(r.addressedConfidence).toBe('medium');
  });

  it('grades outdated + a subsequent commit as high confidence', () => {
    const thread: ThreadInput = {
      isResolved: false,
      isOutdated: true,
      path: 'a.ts',
      comments: [{ author: { login: 'anna' }, createdAt: '2026-01-01T00:00:00Z' }],
    };
    const commits: CommitInput[] = [
      { oid: 'x', committedDate: '2026-01-02T00:00:00Z' },
    ];
    const r = deriveThreadState(thread, commits, new Map([['x', ['a.ts']]]));
    expect(r.state).toBe('likely_addressed');
    expect(r.addressedConfidence).toBe('high');
    expect(r.addressedReason).toBe('outdated+commit');
  });

  it('detects a bot resolution marker as high confidence', () => {
    const thread: ThreadInput = {
      isResolved: false,
      path: 'a.ts',
      comments: [
        {
          author: { login: 'coderabbitai' },
          createdAt: '2026-01-01T00:00:00Z',
          body: 'Consider adding a null check here.',
        },
        {
          author: { login: 'coderabbitai' },
          createdAt: '2026-01-02T00:00:00Z',
          body: '✅ Addressed in a1b2c3d4',
        },
      ],
    };
    const r = deriveThreadState(thread, [], new Map());
    expect(r.state).toBe('likely_addressed');
    expect(r.addressedConfidence).toBe('high');
    expect(r.addressedReason).toBe('bot-marker:coderabbit');
  });

  it('grades a bot self-resolve as high confidence', () => {
    const thread: ThreadInput = {
      isResolved: true,
      path: 'a.ts',
      resolvedByLogin: 'coderabbitai',
      comments: [{ author: { login: 'coderabbitai' }, createdAt: '2026-01-01T00:00:00Z' }],
    };
    const r = deriveThreadState(thread, [], new Map());
    expect(r.state).toBe('resolved');
    expect(r.addressedConfidence).toBe('high');
    expect(r.addressedReason).toBe('self-resolved');
  });
});
