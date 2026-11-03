// The AI review on the PR Overview (lib/aiReviewOverview.ts, components/pr/AiReviewOverview.tsx), and
// the AI Review tab label with no icon (2026-11-03).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ClaudeReviewResponse } from '@pierre-review/shared';
import { aiReviewOverview } from '../src/lib/aiReviewOverview.js';

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

const own = (over: Record<string, unknown> = {}) => ({
  status: 'succeeded',
  verdict: 'REQUEST_CHANGES',
  summary: '**Two problems.** The cache key ignores `locale`.\n\n- one\n- two',
  createdAt: '2026-11-01T10:00:00Z',
  finishedAt: '2026-11-01T10:05:00Z',
  findings: [{ severity: 'blocker' }, { severity: 'warning' }, { severity: 'warning' }, { severity: 'praise' }, { severity: 'nit' }],
  ...over,
});
const mate = (reviewId: number, postedAt: string, findings: Array<{ severity: string | null }> = []) => ({
  reviewId,
  poster: { userId: 9, login: 'robin-dev', displayName: 'Robin Dunn', avatarUrl: null },
  headSha: 'abc1234',
  headInferred: false,
  postedAt,
  githubUrl: null,
  summary: 'Looks fine apart from the retry loop.',
  verdict: 'COMMENT',
  run: 'auto',
  pair: false,
  runs: [],
  limnVersion: null,
  findings,
});
const resp = (o: Record<string, unknown>): ClaudeReviewResponse => o as unknown as ClaudeReviewResponse;

describe('aiReviewOverview', () => {
  it('nothing before the read, with no review, or with only a running / failed run', () => {
    expect(aiReviewOverview(undefined)).toBeNull();
    expect(aiReviewOverview(resp({ review: null, history: [] }))).toBeNull();
    expect(aiReviewOverview(resp({ review: own({ status: 'running' }), history: [] }))).toBeNull();
    expect(aiReviewOverview(resp({ review: own({ status: 'failed' }), teammateReviews: [] }))).toBeNull();
  });

  it("the reader's own review: no name, its verdict, open findings by severity (praise is not one), plain summary", () => {
    const m = aiReviewOverview(resp({ review: own(), history: [] }));
    expect(m?.whose).toBeNull();
    expect(m?.verdict).toBe('REQUEST_CHANGES');
    expect(m?.counts.map((c) => c.label)).toEqual(['1 blocker', '2 warnings', '1 nit']);
    expect(m?.open).toBe(4);
    expect(m?.excerpt).toBe('Two problems. The cache key ignores locale. one two');
  });

  it("the merged view: a teammate's newer review leads and is named; their open findings join the reader's", () => {
    const m = aiReviewOverview(
      resp({
        review: own(),
        teammateReviews: [mate(7, '2026-11-02T09:00:00Z', [{ severity: 'warning' }])],
        teamView: { lead: 'teammate', teammateReviewId: 7, findings: [{ severity: 'warning' }, { severity: null }], alsoRaisedBy: [] },
      }),
    );
    expect(m?.whose).toBe('Robin’s review');
    expect(m?.verdict).toBe('COMMENT');
    expect(m?.at).toBe('2026-11-02T09:00:00Z');
    expect(m?.counts.map((c) => c.label)).toEqual(['1 blocker', '3 warnings', '1 nit']);
    expect(m?.unlabelled).toBe(1);
    expect(m?.open).toBe(6);
  });

  it('the merged view led by the reader keeps the reader as the lead', () => {
    const m = aiReviewOverview(
      resp({ review: own(), teammateReviews: [mate(7, '2026-10-30T09:00:00Z')], teamView: { lead: 'own', teammateReviewId: null, findings: [], alsoRaisedBy: [] } }),
    );
    expect(m?.whose).toBeNull();
  });

  it('an older server (no teamView): the newer of the two leads, with its own findings', () => {
    const newer = aiReviewOverview(resp({ review: own(), teammateReviews: [mate(7, '2026-11-02T09:00:00Z', [{ severity: 'nit' }])] }));
    expect(newer?.whose).toBe('Robin’s review');
    expect(newer?.counts.map((c) => c.label)).toEqual(['1 nit']);
    const older = aiReviewOverview(resp({ review: own(), teammateReviews: [mate(7, '2026-10-30T09:00:00Z')] }));
    expect(older?.whose).toBeNull();
    // Only a teammate's review exists.
    expect(aiReviewOverview(resp({ review: null, teammateReviews: [mate(7, '2026-10-30T09:00:00Z')] }))?.open).toBe(0);
  });
});

describe('mounted on Overview, from the query the tab pill already holds', () => {
  it('reads the same key, never refetches on mount, and hides with AI off', () => {
    const c = src('components/pr/AiReviewOverview.tsx');
    expect(c).toMatch(/queryKey: \['claude-review', prId\]/);
    expect(c).toMatch(/staleTime: Infinity/);
    expect(c).toMatch(/const m = enabled \? aiReviewOverview\(data\) : null/);
    const d = src('components/PrDetail.tsx');
    const overview = d.slice(d.indexOf("{effectiveTab === 'overview' ? ("), d.indexOf('<BotTriageCard'));
    expect(overview).toMatch(/<AiReviewOverview prId=\{pr\.id\} enabled=\{claudeReviewEnabled\} onOpen=\{\(\) => goToTab\('claude_review'\)\} \/>/);
  });

  it('the AI Review tab label keeps its icon and carries no verdict pill', () => {
    const d = src('components/PrDetail.tsx');
    expect(d).toMatch(/claude_review: <SparkleIcon/);
    expect(d).not.toMatch(/ReviewTabOutcome/);
    // The pill's read stays mounted: the Overview card reads its cache and fetches nothing itself.
    expect(d).toMatch(/useClaudeReviewTabPill\(prId, claudeReviewEnabled\)/);
  });
});
