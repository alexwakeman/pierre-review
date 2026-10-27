// THE REPLIES PASS ON SCREEN (lib/repliesCheck.ts) — the words, and that the AI Review tab mounts the
// line and labels a pass in the history (grep the source: a built-but-unmounted feature is the
// failure this guards).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeRepliesCheckRun } from '@pierre-review/shared';
import { canCheckReplies, checkRepliesButtonText, repliesCheckLine, repliesCountsText } from '../src/lib/repliesCheck.js';

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
  it('offers "Check replies" only while replies wait and nothing runs', () => {
    expect(canCheckReplies({ unjudged: 2, live: null, latest: null })).toBe(true);
    expect(canCheckReplies({ unjudged: 2, live: 'running', latest: null })).toBe(false);
    expect(canCheckReplies({ unjudged: 0, live: null, latest: null })).toBe(false);
    expect(canCheckReplies(null)).toBe(false);
    expect(checkRepliesButtonText(1)).toBe('Check replies');
    expect(checkRepliesButtonText(3)).toBe('Check 3 replies');
  });

  it('one line about the newest pass', () => {
    expect(repliesCountsText({ accepted: 2, disputed: 0, notChecked: 1 })).toBe('2 accepted, 1 not checked.');
    expect(repliesCheckLine(run())).toBe('Replies checked 2 hours ago: 1 accepted, 1 still open.');
    // A manual pass never posts: it says what the outcome WOULD be.
    expect(repliesCheckLine(run({ verdict: 'REQUEST_CHANGES' }))).toBe(
      'Replies checked 2 hours ago: 1 accepted, 1 still open. Would request changes.',
    );
    expect(repliesCheckLine(run({ verdict: 'APPROVE', disputed: 0 }))).toBe('Replies checked 2 hours ago: 1 accepted. Would approve.');
    // An auto pass says what its outcome review did.
    expect(
      repliesCheckLine(
        run({
          trigger: 'auto',
          verdict: 'APPROVE',
          autoPost: { status: 'posted', at: 'x', reason: null, error: null, postedCount: 0, verdict: { wanted: 'APPROVE', submitted: 'APPROVE', heldReason: null } },
        }),
      ),
    ).toBe('Replies checked 2 hours ago: 1 accepted, 1 still open. Approved automatically.');
    expect(repliesCheckLine(run({ status: 'failed', error: 'usage limit' }))).toBe('Replies check failed: usage limit');
    expect(repliesCheckLine(run({ status: 'running' }))).toBeNull();
    expect(repliesCheckLine(null)).toBeNull();
  });

  it('is mounted on the AI Review tab, and a pass is labelled in the history', () => {
    const src = (f: string) => readFileSync(join(import.meta.dirname, '../src/components', f), 'utf8');
    expect(src('ClaudeReviewTab.tsx')).toMatch(/<RepliesCheckLine\b/);
    expect(src('ReviewHistoryList.tsx')).toMatch(/REPLIES_CHECK_LABEL/);
    expect(src('RepliesCheckLine.tsx')).toMatch(/<AiRunGate kind="thread_check">/);
  });
});
