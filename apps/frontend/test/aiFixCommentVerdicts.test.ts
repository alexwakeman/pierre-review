// The pure half of the "fix from comments" per-comment report (`components/AiFix/
// CommentFixReport.tsx`). Everything tested here decides something that CANNOT be checked by
// looking at the rendered card:
//
//   1. WHERE A PUSHBACK REPLY POSTS. A double-post is not undoable and posting to the wrong
//      place is worse than not posting, so the thread/PR-comment/nowhere decision is pinned.
//      In particular: a verdict with no matched target must resolve to NOWHERE (the card
//      offers no reply at all), and a review comment whose thread never synced must fall back
//      rather than silently address the wrong comment.
//   2. THE ROLL-UP ARITHMETIC. It is the only place the run's shape is stated in words, and
//      every field it reads is MODEL output the server parsed out of a tool call — so an
//      unrecognised disposition must degrade to "counted in nothing but the total" instead of
//      poisoning a count with NaN.
//
// No JSX and no rendering: `apps/frontend/vitest.config.ts` exports a plain object with no React
// plugin and no jsdom, so the helpers are imported as functions (the precedent is
// `mentionSuggestions.test.ts`, which pulls `orderMentionSuggestions` out of a .tsx the same way).
//
// This directory runs in NEITHER CI workflow and is not typechecked — run it by hand, from the
// workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type {
  AiFixCommentDisposition,
  AiFixCommentTarget,
  AiFixCommentVerdict,
} from '@pierre-review/shared';
import {
  commentAnchorLabel,
  commentVerdictRollup,
  prefillPushbackReply,
  pushbackReplyTarget,
  summariseCommentVerdicts,
} from '../src/components/AiFix/CommentFixReport.js';

const target = (over: Partial<AiFixCommentTarget> = {}): AiFixCommentTarget => ({
  kind: 'review_comment',
  id: 1,
  ref: 'C1',
  authorId: 7,
  authorLogin: 'coderabbitai',
  isBot: true,
  path: 'src/app.ts',
  line: 42,
  threadId: 99,
  url: 'https://github.com/o/r/pull/1#discussion_r1',
  excerpt: 'This nil check is redundant.',
  ...over,
});

const verdict = (over: Partial<AiFixCommentVerdict> = {}): AiFixCommentVerdict => ({
  ref: 'C1',
  target: target(),
  verdict: 'fixed',
  valid: true,
  reasoning: 'Removed the redundant check.',
  pushback: null,
  learning: null,
  filesTouched: ['src/app.ts'],
  ...over,
});

describe('pushbackReplyTarget', () => {
  it('replies in the thread when the target has one', () => {
    expect(pushbackReplyTarget(target({ threadId: 99 }))).toEqual({
      kind: 'thread',
      threadId: 99,
    });
  });

  it('falls back to a PR-level comment for a top-level comment and a review body', () => {
    for (const kind of ['pr_comment', 'review'] as const) {
      expect(
        pushbackReplyTarget(target({ kind, threadId: null, path: null, line: null })),
      ).toEqual({ kind: 'pr_comment' });
    }
  });

  // A synced review comment normally HAS a thread; when it doesn't, the inline address is
  // unknown and guessing one would answer the wrong comment. The flat fallback is disclosed in
  // the composer.
  it('falls back for a review comment whose thread never synced', () => {
    expect(pushbackReplyTarget(target({ threadId: null }))).toEqual({
      kind: 'pr_comment',
    });
  });

  // The card for an unmatched ref must offer no reply action whatsoever.
  it('resolves to nowhere for a verdict with no matched target', () => {
    expect(pushbackReplyTarget(null)).toBeNull();
  });
});

describe('prefillPushbackReply', () => {
  it('is the rebuttal verbatim for a thread reply', () => {
    expect(prefillPushbackReply(target(), '  The check guards a real nil case.  ')).toBe(
      'The check guards a real nil case.',
    );
  });

  // A flat PR comment carries no threading, so the addressee has to be in the text.
  it('@mentions the author when it posts as a PR-level comment', () => {
    expect(
      prefillPushbackReply(target({ kind: 'pr_comment', threadId: null }), 'Not so.'),
    ).toBe('@coderabbitai Not so.');
  });

  it('omits the mention when the author login is unknown', () => {
    expect(
      prefillPushbackReply(
        target({ kind: 'pr_comment', threadId: null, authorLogin: null }),
        'Not so.',
      ),
    ).toBe('Not so.');
  });

  it('is empty when there is no rebuttal', () => {
    expect(prefillPushbackReply(target(), null)).toBe('');
  });
});

describe('commentAnchorLabel', () => {
  it('reads path:line when the comment is anchored', () => {
    expect(commentAnchorLabel(target())).toBe('src/app.ts:42');
  });

  it('drops the colon when there is no line', () => {
    expect(commentAnchorLabel(target({ line: null }))).toBe('src/app.ts');
  });

  it('names the kind when there is no file anchor', () => {
    expect(commentAnchorLabel(target({ kind: 'pr_comment', path: null, line: null }))).toBe(
      'PR-level comment',
    );
    expect(commentAnchorLabel(target({ kind: 'review', path: null, line: null }))).toBe(
      'Review body',
    );
  });
});

describe('summariseCommentVerdicts', () => {
  it('counts dispositions, sendable pushbacks and unmatched refs', () => {
    const verdicts = [
      verdict({ ref: 'C1', verdict: 'fixed' }),
      verdict({ ref: 'C2', verdict: 'fixed' }),
      verdict({ ref: 'C3', verdict: 'invalid', valid: false, pushback: 'It is guarded.' }),
      // A pushback that is only whitespace is not something the user can send.
      verdict({ ref: 'C4', verdict: 'out_of_scope', pushback: '   ' }),
      verdict({ ref: 'C9', verdict: 'needs_human', target: null }),
    ];
    const summary = summariseCommentVerdicts(verdicts, null);
    expect(summary.total).toBe(5);
    expect(summary.counts.fixed).toBe(2);
    expect(summary.counts.invalid).toBe(1);
    expect(summary.counts.out_of_scope).toBe(1);
    expect(summary.counts.needs_human).toBe(1);
    expect(summary.counts.partially_fixed).toBe(0);
    expect(summary.pushbacks).toBe(1);
    expect(summary.unmatched).toBe(1);
  });

  // The run stored what it was GIVEN; a comment the agent never mentioned is a fact about the
  // run, and silently dropping it would overstate the coverage.
  it('counts seeded comments the agent never reported on', () => {
    const summary = summariseCommentVerdicts([verdict({ ref: 'C1' })], [
      target({ ref: 'C1' }),
      target({ ref: 'C2', id: 2 }),
      target({ ref: 'C3', id: 3 }),
    ]);
    expect(summary.unreported).toBe(2);
  });

  // ⚠ THE JOIN IS THROUGH `target`, NEVER THE REF STRING. The server stores each verdict's `ref`
  // exactly as the model wrote it and matches it to a target through a normaliser (case, spaces,
  // trailing punctuation), precisely because an agent writes "c3", " C3 " and "C3." for one
  // comment. Keying the cited set on the raw string made this counter fire for comments that WERE
  // reported on — and since every genuinely unreported target arrives as a synthesized verdict
  // carrying the canonical ref, that was the ONLY way it could ever fire. A test whose refs match
  // exactly cannot catch it, which is why this case exists.
  it('does not call a comment unreported because the agent spelled its ref differently', () => {
    const summary = summariseCommentVerdicts(
      [
        verdict({ ref: 'c1.', target: target({ ref: 'C1' }) }),
        verdict({ ref: ' C2 ', target: target({ ref: 'C2', id: 2 }) }),
      ],
      [target({ ref: 'C1' }), target({ ref: 'C2', id: 2 })],
    );
    expect(summary.unreported).toBe(0);
  });

  // A fabricated ref carries no target, so it can neither mark a seeded comment as reported nor
  // be silently dropped: it counts as unmatched AND leaves the real target unreported.
  it('does not let a fabricated ref cover for a seeded comment', () => {
    const summary = summariseCommentVerdicts([verdict({ ref: 'C9', target: null })], [
      target({ ref: 'C1' }),
    ]);
    expect(summary.unmatched).toBe(1);
    expect(summary.unreported).toBe(1);
  });

  // Every field here came out of a model's tool call, and this app has no error boundary: an
  // unknown disposition must be inert, not a NaN that renders as "NaN fixed".
  it('leaves an unrecognised disposition out of every count but the total', () => {
    const rogue = verdict({
      ref: 'C1',
      verdict: 'exploded' as unknown as AiFixCommentDisposition,
    });
    const summary = summariseCommentVerdicts([rogue], null);
    expect(summary.total).toBe(1);
    expect(Object.values(summary.counts).every((n) => n === 0)).toBe(true);
    expect(commentVerdictRollup(summary)).toBe('1 comment');
  });

  it('treats a missing target list as no seeded comments', () => {
    expect(summariseCommentVerdicts([], null).unreported).toBe(0);
  });
});

describe('commentVerdictRollup', () => {
  it('lists only the non-zero groups, in disposition order', () => {
    const summary = summariseCommentVerdicts(
      [
        verdict({ ref: 'C1', verdict: 'needs_human' }),
        verdict({ ref: 'C2', verdict: 'fixed' }),
        verdict({ ref: 'C3', verdict: 'fixed' }),
        verdict({ ref: 'C4', verdict: 'invalid', pushback: 'no' }),
        verdict({ ref: 'C5', verdict: 'needs_human' }),
      ],
      null,
    );
    expect(commentVerdictRollup(summary)).toBe(
      '5 comments: 2 fixed · 1 pushed back · 2 need a human',
    );
  });

  it('reads grammatically at one', () => {
    const summary = summariseCommentVerdicts(
      [verdict({ ref: 'C1', verdict: 'needs_human' })],
      null,
    );
    expect(commentVerdictRollup(summary)).toBe('1 comment: 1 needs a human');
  });
});
