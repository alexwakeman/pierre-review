// AUTO-POSTING ON SCREEN (lib/autoPost.ts + lib/ticketReview.ts) — the words for what auto-posting
// did, and that the Settings section, the Claude Review tab and Story check actually mount them.
//
//   1. A posted finding / item says "Posted", or "Posted automatically · <time ago>" when
//      auto-posting did it; a carried ticket item keeps "on an earlier check".
//   2. A failed or partial auto post earns ONE "Couldn't post automatically: …" line; posted,
//      skipped and posting say nothing.
//   3. "Not asked for" rows read their posting off the run's record by index.
//   4. The mounts: the Settings switch + scope + kinds, the Claude Review tab's chip and failure
//      line, Story check's failure line (grep the source — a built-but-unmounted feature is the
//      failure this guards).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/autoPost.test.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TicketReviewItem, TicketReviewMember } from '@pierre-review/shared';
import { autoPostFailureLine, postedChipLabel } from '../src/lib/autoPost.js';
import { notRequestedPostedLabel, postedLabel } from '../src/lib/ticketReview.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => readFileSync(join(here, '../src', p), 'utf8');
const minsAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

describe('the posted chip', () => {
  it('says automatically, with how long ago, only when auto-posting did it', () => {
    expect(postedChipLabel({ postedAt: minsAgo(5), postedAuto: true })).toBe('Posted automatically · 5 mins ago');
    expect(postedChipLabel({ postedAt: minsAgo(5), postedAuto: false })).toBe('Posted');
    expect(postedChipLabel({ postedAt: minsAgo(5) })).toBe('Posted');
    expect(postedChipLabel({ postedAt: null, postedAuto: true })).toBe('Posted');
  });

  it('a ticket item: automatically on its owner PR; carried keeps the earlier-check words', () => {
    const members = [{ prId: 2, repo: 'acme/api', number: 88 } as TicketReviewMember];
    const posted = { prId: 2, commentId: '1', postedAt: minsAgo(120), carried: false, auto: true };
    const item = (p: TicketReviewItem['posted']) => ({ posted: p });
    expect(postedLabel(item(posted), members, 1)).toBe('Posted automatically on api#88 · 2 hours ago');
    expect(postedLabel(item({ ...posted, prId: 1 }), members, 1)).toBe('Posted automatically · 2 hours ago');
    expect(postedLabel(item({ ...posted, carried: true }), members, 1)).toBe('Posted on api#88 on an earlier check');
    expect(postedLabel(item({ ...posted, auto: undefined }), members, 1)).toBe('Posted on api#88');
  });
});

describe('the failure line', () => {
  it('only a failed or partial post speaks, and it names the error', () => {
    expect(autoPostFailureLine({ status: 'failed', error: '403: Resource not accessible' })).toBe(
      'Couldn’t post automatically: 403: Resource not accessible',
    );
    expect(autoPostFailureLine({ status: 'partial', error: 'boom' })).toBe('Couldn’t post all of it automatically: boom');
    expect(autoPostFailureLine({ status: 'failed', error: null })).toBe('Couldn’t post automatically: GitHub did not accept it.');
    for (const status of ['posted', 'skipped', 'posting'] as const) {
      expect(autoPostFailureLine({ status, error: 'x' })).toBeNull();
    }
    expect(autoPostFailureLine(null)).toBeNull();
    expect(autoPostFailureLine(undefined)).toBeNull();
  });
});

describe('"Not asked for" postings', () => {
  it('are read off the run record by index', () => {
    const review = {
      autoPost: {
        status: 'posted' as const,
        at: minsAgo(1),
        reason: null,
        error: null,
        postedCount: 1,
        notRequested: [
          { index: 1, prId: 2, postedAt: minsAgo(3), carried: false },
          { index: 2, prId: 2, postedAt: minsAgo(3), carried: true },
        ],
      },
    };
    expect(notRequestedPostedLabel(review, 0)).toBeNull();
    expect(notRequestedPostedLabel(review, 1)).toBe('Posted automatically · 3 mins ago');
    expect(notRequestedPostedLabel(review, 2)).toBe('Posted on an earlier check');
    expect(notRequestedPostedLabel({ autoPost: null }, 1)).toBeNull();
  });
});

describe('the mounts', () => {
  it('Settings carries the master switch, the scope and every kind', () => {
    const s = src('components/settings/AutoReviewSection.tsx');
    expect(s).toContain('Post Claude reviews to GitHub automatically');
    expect(s).toContain('PRs you are asked to review, and your own');
    expect(s).toContain('Every PR auto review covers');
    for (const k of ['blockers', 'warnings', 'nits', 'questions', 'storyGaps', 'notAskedFor']) {
      expect(s).toContain(`key: '${k}'`);
    }
    // Dimmed, never disabled, while the master switch is off.
    expect(s).toMatch(/postOn \? '' : 'opacity-60'/);
  });

  it('the Claude Review tab and Story check render the chip and the failure line', () => {
    const tab = src('components/ClaudeReviewTab.tsx');
    expect(tab).toContain('postedChipLabel(finding)');
    expect(tab).toContain('autoPostFailureLine(review.autoPost)');
    const parts = src('components/TicketReviewParts.tsx');
    expect(parts).toContain('autoPostFailureLine(review.autoPost)');
    expect(parts).toContain('notRequestedPostedLabel(review, i)');
  });
});
