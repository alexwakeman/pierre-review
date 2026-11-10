// THE REPLIES PASS ON SCREEN (lib/repliesCheck.ts) — the words, and that the AI Review tab mounts the
// line and labels a pass in the history (grep the source: a built-but-unmounted feature is the
// failure this guards).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeRepliesCheckRun } from '@pierre-review/shared';
import {
  REPLIES_CHECK_LABEL,
  repliesCheckFailedLine,
  repliesRunLabel,
} from '../src/lib/repliesCheck.js';

const run = (over: Partial<ClaudeRepliesCheckRun> = {}): ClaudeRepliesCheckRun => ({
  reviewId: 9,
  status: 'succeeded',
  trigger: 'manual',
  createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  finishedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  error: null,
  accepted: 1,
  disputed: 1,
  notChecked: 0,
  verdict: 'COMMENT',
  autoPost: null,
  ...over,
});

describe('the replies pass, in words', () => {
  it('says only that the newest pass failed, with its error', () => {
    expect(repliesCheckFailedLine(run({ status: 'failed', error: 'usage limit' }))).toBe('Replies check failed: usage limit');
    expect(repliesCheckFailedLine(run({ status: 'failed', error: '  ' }))).toBe('Replies check failed.');
    expect(repliesCheckFailedLine(run())).toBeNull();
    expect(repliesCheckFailedLine(run({ status: 'running' }))).toBeNull();
    expect(repliesCheckFailedLine(null)).toBeNull();
  });

  it('is mounted on the AI Review tab, and a pass is labelled in Reviews on this PR', () => {
    const src = (f: string) => readFileSync(join(import.meta.dirname, '../src/components', f), 'utf8');
    expect(src('ClaudeReviewTab.tsx')).toMatch(/<RepliesCheckLine\b/);
    // Reviews on this PR labels a pass (lib/teamReview.ts `reviewsOnPr`).
    expect(readFileSync(join(import.meta.dirname, '../src/lib/teamReview.ts'), 'utf8')).toMatch(/REPLIES_CHECK_LABEL/);
    // No "Check replies" button (2026-11-10): the pass starts by itself; the line keeps Cancel.
    expect(src('RepliesCheckLine.tsx')).not.toMatch(/AiRunGate|start\.mutate|checkRepliesButtonText/);
    expect(src('RepliesCheckLine.tsx')).toMatch(/Cancel/);
    // A cover pass is labelled by whose findings it checked.
    expect(src('ClaudeReviewTab.tsx')).toMatch(/repliesRunLabel\(review\)/);
  });

  it('labels a cover pass by the provider whose findings it checked', () => {
    expect(repliesRunLabel({ followUp: { cover: { provider: 'codex' } } })).toBe("Checked Codex's findings");
    expect(repliesRunLabel({ followUp: null })).toBe(REPLIES_CHECK_LABEL);
  });
});
