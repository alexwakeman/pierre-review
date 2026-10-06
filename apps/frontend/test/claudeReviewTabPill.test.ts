// The Claude Review tab label's outcome pill, and the review preview's visible body.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewTabPill, visibleReviewBody } from '../src/lib/claudeReviewColumn.js';

const src = (p: string): string => readFileSync(join(__dirname, '..', 'src', p), 'utf8');
const run = (status: string, verdict: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES' | null = null) => ({
  review: { status, verdict },
});

describe('reviewTabPill', () => {
  it('says nothing before the read, with no review, or after a cancel', () => {
    expect(reviewTabPill(undefined, false)).toBeNull();
    expect(reviewTabPill({ review: null }, false)).toBeNull();
    expect(reviewTabPill(run('cancelled'), false)).toBeNull();
    expect(reviewTabPill(run('succeeded', null), false)).toBeNull();
  });
  it('the verdict of a finished run', () => {
    expect(reviewTabPill(run('succeeded', 'APPROVE'), false)).toEqual({ kind: 'verdict', verdict: 'APPROVE', label: 'Approve' });
    expect(reviewTabPill(run('succeeded', 'REQUEST_CHANGES'), false)?.label).toBe('Request changes');
  });
  it('in flight beats the last outcome; a start from any surface counts', () => {
    expect(reviewTabPill(run('running'), false)?.kind).toBe('running');
    expect(reviewTabPill(run('queued'), false)?.kind).toBe('queued');
    expect(reviewTabPill(run('succeeded', 'APPROVE'), true)?.kind).toBe('queued');
    expect(reviewTabPill({ ...run('succeeded', 'APPROVE'), autoReview: 'queued' }, false)?.kind).toBe('queued');
    expect(reviewTabPill({ review: null, autoReview: 'running' }, false)?.kind).toBe('running');
  });
  it('a failed run', () => {
    expect(reviewTabPill(run('failed'), false)).toEqual({ kind: 'failed', label: 'Failed' });
  });
  it('is mounted on the PR pane tab strip, from the tab’s own query', () => {
    expect(src('components/PrDetail.tsx')).toMatch(/t === 'claude_review' && reviewPill != null/);
    expect(src('hooks/useClaudeReview.ts')).toMatch(/useClaudeReviewTabPill[\s\S]*queryKey: \['claude-review', prId\]/);
  });
});

describe('the review preview', () => {
  it('drops the hidden provenance marker GitHub does not render', () => {
    expect(visibleReviewBody('Looks good.\n\n<!-- pierre:claude-review v=1 -->')).toBe('Looks good.');
    expect(visibleReviewBody('\n\n<!-- pierre:claude-review v=1 -->')).toBe('');
  });
  it('renders the body and every comment, not just the count', () => {
    const tab = src('components/ClaudeReviewTab.tsx');
    expect(tab).toMatch(/<PostReviewPreviewPanel preview=\{preview\} \/>/);
    expect(tab).toMatch(/preview\.comments\.map/);
    expect(tab).toMatch(/preview\.prComments\.map/);
  });
});
