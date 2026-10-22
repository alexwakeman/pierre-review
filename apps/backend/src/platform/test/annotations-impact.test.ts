// The blast-radius IMPACT NOTE — the one kind left on the annotations platform.
//
// Pins three things: the parser reads the impact verdict and falls back to `none` (never an
// invented `concern`); the cached read skips DORMANT rows of the removed comment kinds; and a
// stored note goes stale when the pull request it describes changes.
//
// Runs from the backend workspace (@pierre/pro ships no vitest devDep):
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test
import { describe, expect, it } from 'vitest';
import type { BlastSignals } from '@pierre-review/shared';
import { parseSingle } from '../annotations/prompts.js';
import { projectAnnotations } from '../annotations/runner.js';
import { currentHashFor, impactForPr, type PrCorpus } from '../annotations/targets.js';

const AT = new Date('2026-07-01T00:00:00Z');

function blast(): BlastSignals {
  return {
    codeFiles: 2,
    testFiles: 1,
    nonCodeFiles: 0,
    dirs: 2,
    subsystems: 1,
    surfaces: [],
    allNew: false,
    truncated: false,
    hubDegree: null,
    hubBar: null,
    hubPath: null,
    contentKind: null,
  } as unknown as BlastSignals;
}

function corpus(over: Partial<PrCorpus> = {}): PrCorpus {
  return {
    prId: 100,
    repoId: 10,
    prNumber: 7,
    prTitle: 'Tighten the null check',
    repoFullName: 'acme/app',
    headSha: 'f00dcafe',
    prBody: 'Fixes a crash.',
    files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }],
    blast: blast(),
    ...over,
  };
}

const row = (o: { kind: string; targetKind: string; targetId: number; payloadHash: string }) => ({
  ...o,
  prId: 100,
  verdict: 'none',
  confidence: null,
  body: 'Text.',
  model: 'm',
  createdAt: AT,
});

describe('parseSingle — impact', () => {
  it('reads the verdict line and keeps the prose as the body', () => {
    const p = parseSingle('impact', 'verdict: concern\nThe flag default turns this on for everyone.');
    expect(p.verdict).toBe('concern');
    expect(p.confidence).toBeNull();
    expect(p.body).toBe('The flag default turns this on for everyone.');
  });

  it('falls back to none, never concern, on an unreadable first line', () => {
    const p = parseSingle('impact', 'This renames a helper.');
    expect(p.verdict).toBe('none');
    expect(p.body).toBe('This renames a helper.');
  });
});

describe('projectAnnotations — impact only', () => {
  it('returns an empty projection when nothing is stored', () => {
    const read = projectAnnotations(corpus(), []);
    expect(read.annotations).toEqual([]);
    expect(read.counts).toEqual({ impact: 0 });
    expect(read.staleCount).toBe(0);
  });

  it('skips DORMANT rows of the removed comment kinds', () => {
    const c = corpus();
    const hash = impactForPr(c)!.payloadHash;
    const read = projectAnnotations(c, [
      row({ kind: 'validity', targetKind: 'review_comment', targetId: 900, payloadHash: 'x' }),
      row({ kind: 'addressed', targetKind: 'thread', targetId: 500, payloadHash: 'y' }),
      row({ kind: 'impact', targetKind: 'pull_request', targetId: 100, payloadHash: hash }),
    ]);
    expect(read.annotations.map((a) => a.kind)).toEqual(['impact']);
    expect(read.counts).toEqual({ impact: 1 });
    expect(read.staleCount).toBe(0);
  });

  it('marks a stored note stale once the pull request changes', () => {
    const before = impactForPr(corpus())!.payloadHash;
    const after = corpus({ headSha: 'beefbeef' });
    expect(currentHashFor(after, 'impact', 'pull_request', 100)).not.toBe(before);
    const read = projectAnnotations(after, [
      row({ kind: 'impact', targetKind: 'pull_request', targetId: 100, payloadHash: before }),
    ]);
    expect(read.staleCount).toBe(1);
  });

  it('enumerates no target for an unmeasured pull request', () => {
    expect(impactForPr(corpus({ blast: null }))).toBeNull();
    expect(impactForPr(corpus({ files: [] }))).toBeNull();
  });
});
