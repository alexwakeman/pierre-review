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
import {
  autoLiftLine,
  autoPostFailureLine,
  autoPostSkipLine,
  autoResolveLabel,
  autoVerdictLine,
  canPostReminder,
  effectivePost,
  postedChipLabel,
  reminderChipLabel,
} from '../src/lib/autoPost.js';
import { isIgnoredFinding } from '../src/lib/findingsMarkdown.js';
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

describe('skips, verdicts and resolves', () => {
  it('only an already_posted skip speaks, with its count', () => {
    expect(autoPostSkipLine({ status: 'skipped', reason: 'already_posted', alreadyPostedCount: 3 })).toBe(
      'Not posted automatically: all 3 comments are already on GitHub.',
    );
    expect(autoPostSkipLine({ status: 'skipped', reason: 'already_posted', alreadyPostedCount: 1 })).toBe(
      'Not posted automatically: its one comment is already on GitHub.',
    );
    expect(autoPostSkipLine({ status: 'skipped', reason: 'nothing_new' })).toBeNull();
    expect(autoPostSkipLine({ status: 'posted', reason: null })).toBeNull();
  });

  it('the verdict: what was sent, or why it was held; a plain comment says nothing', () => {
    const v = (wanted: any, submitted: any, heldReason: any) => ({ wanted, submitted, heldReason });
    expect(autoVerdictLine({ status: 'posted', verdict: v('APPROVE', 'APPROVE', null) })).toBe('Approved automatically.');
    expect(autoVerdictLine({ status: 'posted', verdict: v('REQUEST_CHANGES', 'REQUEST_CHANGES', null) })).toBe('Requested changes automatically.');
    expect(autoVerdictLine({ status: 'failed', verdict: v('APPROVE', 'APPROVE', null) })).toBeNull();
    expect(autoVerdictLine({ status: 'posted', verdict: v('APPROVE', 'COMMENT', 'own_pr') })).toBe('Not approved: this is your own PR.');
    expect(autoVerdictLine({ status: 'skipped', verdict: v('REQUEST_CHANGES', 'COMMENT', 'prior_review') })).toBe(
      'Changes not requested: your own review on GitHub still stands.',
    );
    expect(autoVerdictLine({ status: 'posted', verdict: v('REQUEST_CHANGES', 'COMMENT', 'already_requested') })).toBe(
      'Changes already requested by Claude’s earlier review.',
    );
    expect(autoVerdictLine({ status: 'posted', verdict: v('REQUEST_CHANGES', 'COMMENT', 'refused') })).toBe(
      'Changes not requested: GitHub refused it, so the comments were posted on their own.',
    );
    expect(autoVerdictLine({ status: 'failed', verdict: v('APPROVE', 'COMMENT', 'refused') })).toBe('Not approved: GitHub refused it.');
    const held = (impact: any) => ({ wanted: 'APPROVE' as const, submitted: 'COMMENT' as const, heldReason: 'impact' as const, impact });
    expect(autoVerdictLine({ status: 'posted', verdict: held('high') })).toBe('Not approved: High impact.');
    expect(autoVerdictLine({ status: 'skipped', verdict: held('low') })).toBe('Not approved: Low impact.');
    expect(autoVerdictLine({ status: 'posted', verdict: held('unknown') })).toBe('Not approved: impact unknown.');
    expect(autoVerdictLine({ status: 'posted', verdict: v('COMMENT', 'COMMENT', null) })).toBeNull();
    expect(autoVerdictLine({ status: 'posted' })).toBeNull();
  });

  it("lifting Claude's own earlier request for changes: dismissed, or why not; a superseding approve says nothing more", () => {
    const l = (how: 'superseded' | 'dismissed' | 'dismiss_failed', error: string | null = null) => ({ reviewId: '1', how, error });
    expect(autoLiftLine({ liftedBlock: l('dismissed') })).toBe('Lifted Claude’s earlier request for changes.');
    expect(autoLiftLine({ liftedBlock: l('dismiss_failed', 'Restricted.') })).toBe('Couldn’t lift Claude’s earlier request for changes: Restricted.');
    expect(autoLiftLine({ liftedBlock: l('superseded') })).toBeNull();
    expect(autoLiftLine({})).toBeNull();
    // A lift-only run that failed prints the lift line, not a second "Couldn't post" line.
    expect(autoPostFailureLine({ status: 'failed', error: 'Restricted.', liftedBlock: l('dismiss_failed', 'Restricted.') })).toBeNull();
    expect(src('components/ClaudeReviewTab.tsx')).toContain('autoLiftLine(review.autoPost, aiRunProviderName(review))');
    // A run Codex made names Codex.
    expect(autoLiftLine({ liftedBlock: l('dismissed') }, 'Codex')).toBe('Lifted Codex’s earlier request for changes.');
  });

  it('auto resolve: resolved, or the error', () => {
    const r = { at: minsAgo(1), outcome: 'addressed' as const, byReviewId: 2, headSha: 'abc', replyCommentId: null };
    expect(autoResolveLabel({ ...r, status: 'resolved', error: null })).toBe('Resolved automatically');
    expect(autoResolveLabel({ ...r, status: 'failed', error: '403' })).toBe('Couldn’t resolve automatically: 403');
    expect(autoResolveLabel(null)).toBeNull();
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
    expect(s).toContain('Post AI reviews to GitHub automatically');
    expect(s).toContain('Your own PRs, and PRs you are asked to review or have reviewed or commented on');
    expect(s).toContain('Approve or request changes for me');
    expect(s).toContain('Resolve Limn’s threads once fixed');
    expect(s).toContain('Push automatically');
    expect(s).toContain('Every PR auto review covers');
    for (const k of ['blockers', 'warnings', 'nits', 'questions', 'storyGaps', 'notAskedFor']) {
      expect(s).toContain(`key: '${k}'`);
    }
    // Dimmed, never disabled, while the master switch is off.
    expect(s).toMatch(/postOn \? '' : 'opacity-60'/);
  });

  it('the Claude Review tab and Story check render the chip and the failure line', () => {
    const tab = src('components/ClaudeReviewTab.tsx');
    expect(tab).toContain('postedChipLabel(post!)');
    expect(tab).toContain('autoPostFailureLine(review.autoPost)');
    expect(tab).toContain('autoPostSkipLine(review.autoPost)');
    expect(tab).toContain('autoVerdictLine(review.autoPost, aiRunProviderName(review))');
    expect(tab).toContain('autoResolveLabel(finding.autoResolve)');
    const parts = src('components/TicketReviewParts.tsx');
    expect(parts).toContain('autoPostFailureLine(review.autoPost)');
    expect(parts).toContain('notRequestedPostedLabel(review, i)');
  });
});

// PR 163508: a re-raise of an auto-posted nit showed a Post button, and the reader posted it again.
// A finding whose point is already on GitHub (`earlierPost`) is shown POSTED, linked, and never ignored.
describe('a finding already on GitHub through an earlier post', () => {
  const unposted = { postedAt: null, postedAuto: false, githubCommentId: null, postedCommentKind: null } as const;

  it('its own post wins; else the earlier post; else nothing', () => {
    const at = minsAgo(30);
    expect(effectivePost({ ...unposted, earlierPost: null })).toBeNull();
    expect(effectivePost({ postedAt: at, postedAuto: true, githubCommentId: '9', postedCommentKind: 'inline', earlierPost: null })).toEqual({
      postedAt: at, postedAuto: true, githubCommentId: '9', postedCommentKind: 'inline', earlier: false,
    });
    const e = effectivePost({
      ...unposted,
      earlierPost: { findingId: 748, githubCommentId: '4272298808', postedCommentKind: 'inline', postedAt: at, postedAuto: true },
    })!;
    expect(e).toMatchObject({ githubCommentId: '4272298808', earlier: true });
    expect(postedChipLabel(e)).toBe('Posted automatically · 30 mins ago');
    expect(postedChipLabel({ postedAt: at, postedAuto: false, earlier: true })).toBe('Posted earlier');
  });

  it('is never "ignored", and the card reads it through effectivePost', () => {
    const earlierPost = { findingId: 1, githubCommentId: '1', postedCommentKind: 'inline' as const, postedAt: minsAgo(5), postedAuto: false };
    expect(isIgnoredFinding({ included: false, postedAt: null, earlierPost }, true)).toBe(false);
    expect(isIgnoredFinding({ included: false, postedAt: null, earlierPost: null }, true)).toBe(true);
    expect(src('components/ClaudeReviewTab.tsx')).toContain('const post = effectivePost(finding);');
  });
});

describe('Post reminder (a finding already on GitHub)', () => {
  it('offers only the reminder, on the editable run, for a posted or earlier-posted finding', () => {
    const own = effectivePost({ postedAt: minsAgo(5), postedAuto: true, githubCommentId: '9', postedCommentKind: 'inline', earlierPost: null });
    const earlier = effectivePost({
      postedAt: null,
      postedAuto: false,
      githubCommentId: null,
      postedCommentKind: null,
      earlierPost: { findingId: 1, githubCommentId: '1', postedCommentKind: 'inline', postedAt: minsAgo(30), postedAuto: true },
    });
    const none = effectivePost({ postedAt: null, postedAuto: false, githubCommentId: null, postedCommentKind: null, earlierPost: null });
    expect(canPostReminder(own, true)).toBe(true);
    expect(canPostReminder(earlier, true)).toBe(true);
    expect(canPostReminder(none, true)).toBe(false);
    expect(canPostReminder(own, false)).toBe(false);
    // The original chip is unchanged beside the reminder's.
    expect(postedChipLabel(earlier!)).toBe('Posted automatically · 30 mins ago');
  });
  it('says the reminder was posted, beside the original', () => {
    expect(reminderChipLabel(null)).toBeNull();
    expect(reminderChipLabel(undefined)).toBeNull();
    expect(reminderChipLabel({ postedAt: new Date(Date.now() - 2 * 60_000).toISOString() })).toBe('Reminder posted · 2 mins ago');
    expect(reminderChipLabel({ postedAt: null })).toBe('Reminder posted');
    const tab = src('components/ClaudeReviewTab.tsx');
    expect(tab).toContain('canPostReminder(post, editable)');
    expect(tab).toContain('reminderChipLabel(finding.reminder)');
    expect(tab).toContain("onPostFinding(f.id, { reminder: true })");
  });
});
