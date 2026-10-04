// THE PENDING CARD'S FIRST TWO LINES (layout B) — `lib/pendingHeadings.ts`, pure.
//
// What this pins, and why each is worth a test:
//
//   1. EVERY CARD TYPE GETS AN EVENT HEADING — what happened, who did it, the quote — and the time
//      once. A type that falls through to a generic heading is the "the card does not say why the
//      ball is yours" defect, so each reason has its own assertion.
//   2. ABSENT IS "NOT KNOWN". Every optional heading fact (`mentionExcerpt`, `threadPath`,
//      `committerId`, `firstComment`, `newActorIds`, `requesterId`) drops its clause; nothing prints a placeholder,
//      an @login or "user 12". An unknown actor is "Someone".
//   3. THE RELEVANCE LABEL. Inside My turn, "Your turn" is dropped (the tab says it); "In your
//      repos" and the neutral label stay; an ABSENT relevance is neutral even with `personal: true`.
//   4. A RED DEFAULT BRANCH IS NOT A PR. Its heading names the branch and repository, and its action
//      line prints no PR title.
//   5. THE SERVER'S `detail` IS NEVER PRINTED WHOLE (it carries an @login and a second clock).
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type {
  CiFailingCard,
  ConflictsCard,
  DependencyBumpCard,
  InsightCard,
  MergeReadyCard,
  MyTurnCard,
  MyTurnTrunkCard,
  ReviewerLoadCard,
  ReviewerRoutingCard,
  SecurityCard,
  StalledReviewCard,
  UntouchedThreadCard,
  UpdateBranchCard,
} from '@pierre-review/shared';
import {
  clipText,
  collapseCheckName,
  compactAge,
  isLikelyAddressed,
  joinNames,
  lastLandedLine,
  markdownToPlain,
  pendingActionLine,
  pendingCardEvent,
  pendingCardPrLabel,
  factDropsNoReviews,
  factShowsStanding,
  pendingFactPlan,
  pendingHeading,
  pendingRelevanceLabel,
  replyBlockShown,
  repoRef,
  restOfFailingChecks,
  sharedRepoOwner,
  type HeadingContext,
} from '../src/lib/pendingHeadings.js';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();

const NAMES = new Map<number, string>([
  [1, 'Alex Wakeman'],
  [2, 'David Buckley'],
  [3, 'Robin Dunn'],
  [4, 'Priya Shah'],
  [9, 'dependabot[bot]'],
]);
const ctx = (over: Partial<HeadingContext> = {}): HeadingContext => ({
  nameOf: (id) => (id == null ? null : (NAMES.get(id) ?? null)),
  tab: 'my_turn',
  viewerId: 1,
  sharedOwner: 'DEFRA',
  now: NOW,
  ...over,
});

function prRef(over: Record<string, unknown> = {}) {
  return {
    prId: 352,
    repoId: 6,
    repoFullName: 'DEFRA/bng-metric-frontend',
    prNumber: 352,
    prTitle: 'BMD-1043: Open project summary',
    authorId: 3,
    githubUrl: 'https://github.com/DEFRA/bng-metric-frontend/pull/352',
    ciStatus: 'success',
    changedFiles: 3,
    additions: 10,
    deletions: 2,
    openedAt: hoursAgo(72),
    authorIsBot: false,
    authorBotKind: null,
    automation: null,
    inMergeQueue: false,
    mergeQueueEntryState: null,
    reviewDecision: null,
    reviewApprovals: 0,
    reviewChangesRequested: false,
    reviewers: [],
    reviewerCount: 0,
    ...over,
  };
}

function myTurn(over: Partial<MyTurnCard> & { reason: MyTurnCard['reason'] }): MyTurnCard {
  return {
    ...prRef(),
    id: `myturn:${over.reason}:1`,
    kind: 'my_turn',
    severity: 'high',
    threadId: null,
    detail: '',
    since: hoursAgo(48),
    personal: true,
    relevance: 'direct',
    ...over,
  } as MyTurnCard;
}

function trunk(over: Partial<MyTurnTrunkCard> = {}): MyTurnTrunkCard {
  return {
    id: 'myturn:trunk_red:6:f48aec5',
    kind: 'my_turn',
    severity: 'warn',
    reason: 'trunk_red',
    repoId: 6,
    repoFullName: 'DEFRA/bng-metric-frontend',
    branchName: 'main',
    ciStatus: 'failure',
    headSha: 'f48aec54f7559889',
    prId: 354,
    prNumber: 354,
    prTitle: 'chore(deps-dev): bump the tools group',
    mergedById: 3,
    viewerMerged: false,
    maintained: true,
    observedAt: hoursAgo(0.25),
    githubUrl: 'https://github.com/DEFRA/bng-metric-frontend/commit/f48aec5',
    detail: 'You maintain this repo — main is red at f48aec5',
    since: hoursAgo(0.25),
    personal: true,
    relevance: 'direct',
    threadId: null,
    authorId: 9,
    authorIsBot: true,
    authorBotKind: 'dependabot',
    automation: { role: 'dependency', kind: 'dependabot', source: 'account' },
    failingChecks: ['Run Journey Tests / Run Journey Tests', 'lint'],
    failingCheckTotal: 4,
    ...over,
  } as MyTurnTrunkCard;
}

const lead = (card: InsightCard, c: HeadingContext = ctx()): string => pendingHeading(card, c).lead;

// ── the helpers ──────────────────────────────────────────────────────────────────────────────

describe('plain-text quotes', () => {
  it('strips markdown, HTML and quote-reply lines to one line of words', () => {
    expect(
      markdownToPlain('> your old words\n**Agreed** — see [the doc](https://x.y) and `foo()`.\n\n```ts\ncode\n```\n<img src=x>'),
    ).toBe('Agreed — see the doc and foo().');
  });

  it('cuts on a word boundary and marks the cut', () => {
    const q = clipText('one two three four five six', 14);
    expect(q.cut).toBe(true);
    expect(q.text).toBe('one two three…');
    expect(clipText('short', 14)).toEqual({ text: 'short', cut: false });
  });

  it('a short reply sits whole in the heading, so no block repeats it underneath', () => {
    const card = myTurn({
      reason: 'thread',
      threadId: 7,
      reply: { authorId: 2, body: 'Fine by me.', at: hoursAgo(2), truncated: false },
    });
    const h = pendingHeading(card, ctx());
    expect(replyBlockShown(h, card.reply)).toBe(false);
    const long = myTurn({
      reason: 'thread',
      threadId: 7,
      reply: { authorId: 2, body: 'word '.repeat(60), at: hoursAgo(2), truncated: false },
    });
    expect(replyBlockShown(pendingHeading(long, ctx()), long.reply)).toBe(true);
  });
});

describe('the small formatters', () => {
  it('ages read 14m, 4h, 2d — once, at the end', () => {
    expect(compactAge(hoursAgo(0.25), NOW)).toBe('15m');
    expect(compactAge(hoursAgo(4), NOW)).toBe('4h');
    expect(compactAge(hoursAgo(49), NOW)).toBe('2d');
    expect(compactAge('not a date', NOW)).toBeNull();
    expect(compactAge(null, NOW)).toBeNull();
  });

  it('drops the org prefix only when every repository shares it', () => {
    expect(sharedRepoOwner(['DEFRA/a', 'DEFRA/b'])).toBe('DEFRA');
    expect(sharedRepoOwner(['DEFRA/a', 'acme/b'])).toBeNull();
    expect(repoRef('DEFRA/bng-metric-frontend', 352, 'DEFRA')).toBe('bng-metric-frontend#352');
    expect(repoRef('acme/x', 3, 'DEFRA')).toBe('acme/x#3');
  });

  it('joins names, and says how many it left out from the uncapped total', () => {
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', 'B'], 5)).toBe('A, B and 3 others');
  });

  it('collapses a workflow name that repeats its job name', () => {
    expect(collapseCheckName('Run Journey Tests / Run Journey Tests')).toBe('Run Journey Tests');
    expect(collapseCheckName('build / test / build')).toBe('build / test / build');
  });
});

// ── every My turn type ───────────────────────────────────────────────────────────────────────

describe('My turn — people events', () => {
  it('a reply in your thread: who, the quote, the time; your comment’s path on line two', () => {
    const card = myTurn({
      reason: 'thread',
      threadId: 7,
      detail: '@TheLordDave replied 2d ago',
      reply: { authorId: 2, body: 'that probably **makes sense**', at: hoursAgo(50), truncated: false },
      threadPath: 'app/routes/summary.ts',
      threadLine: 40,
    });
    const h = pendingHeading(card, ctx());
    expect(h.lead).toBe('David Buckley replied');
    expect(h.quote?.text).toBe('that probably makes sense');
    expect(compactAge(h.at, NOW)).toBe('2d');
    const line = pendingActionLine(card, ctx());
    expect(line.verb).toBe('Reply or resolve');
    expect(line.where).toEqual([{ text: 'your comment on app/routes/summary.ts:40', mono: true }]);
    // ⚠ The server sentence (an @login and a second clock) is never printed.
    expect(JSON.stringify({ h, line })).not.toContain('@TheLordDave');
  });

  it('…without the path fact, the "your comment on" clause is dropped, not invented', () => {
    const card = myTurn({
      reason: 'thread',
      threadId: 7,
      reply: { authorId: 2, body: 'ok', at: hoursAgo(1), truncated: false },
    });
    expect(pendingActionLine(card, ctx()).where).toEqual([]);
  });

  it('a commit after your comment: "A commit" when the committer is unknown — never "addressed"', () => {
    const card = myTurn({
      reason: 'thread',
      threadId: 7,
      detail: 'A later commit touched app/x.ts — check it answers your comment',
    });
    expect(isLikelyAddressed(card)).toBe(true);
    expect(lead(card)).toBe('A commit changed app/x.ts after your comment');
    expect(lead({ ...card, committerId: 3 })).toBe('A commit by Robin Dunn changed app/x.ts after your comment');
    expect(lead(card)).not.toMatch(/addressed/i);
    expect(pendingActionLine(card, ctx()).verb).toBe('Check it answers you, then resolve');
  });

  it('a reply to your comment in someone else’s thread', () => {
    const card = myTurn({
      reason: 'thread_reply',
      threadId: 8,
      reply: { authorId: 2, body: 'Agreed, I’ll drop the legacy route.', at: hoursAgo(24), truncated: false },
    });
    expect(lead(card)).toBe('David Buckley replied to your comment');
    expect(pendingHeading(card, ctx()).quote?.text).toBe('Agreed, I’ll drop the legacy route.');
  });

  it('a PR comment after yours', () => {
    const card = myTurn({
      reason: 'comment_reply',
      reply: { authorId: 2, body: 'Can we ship this behind the flag first?', at: hoursAgo(3), truncated: false },
    });
    expect(lead(card)).toBe('David Buckley commented after you');
    expect(pendingActionLine(card, ctx()).verb).toBe('Answer on the PR');
    // No body rode the card: no name lifted from the server sentence.
    expect(lead(myTurn({ reason: 'comment_reply', detail: '@dave commented after you 3h ago' }))).toBe(
      'New comment after yours',
    );
  });

  it('a mention: who and what they wrote; "You were mentioned" when the actor is unknown', () => {
    const card = myTurn({
      reason: 'mention',
      mentionedById: 2,
      mentionExcerpt: { text: '@alex can you confirm the schema?', truncated: false },
    });
    expect(lead(card)).toBe('David Buckley mentioned you');
    expect(pendingHeading(card, ctx()).quote?.text).toBe('@alex can you confirm the schema?');
    const bare = myTurn({ reason: 'mention' });
    expect(lead(bare)).toBe('You were mentioned');
    expect(pendingHeading(bare, ctx()).quote).toBeNull();
  });

  it('a review request: the author on line two, and how many others were asked', () => {
    const card = myTurn({
      reason: 'review_request',
      detail: 'Review requested from you · 1 other reviewer also requested',
    });
    expect(lead(card)).toBe('Your review was requested');
    const line = pendingActionLine(card, ctx());
    expect(line.verb).toBe('Review it');
    expect(line.by).toBe('Robin Dunn');
    expect(line.after).toEqual([{ text: '1 other asked' }]);
  });

  it('a review request names who asked, and drops "by" when the author asked', () => {
    // David asked you to review Robin's PR: both names stay.
    const byOther = myTurn({ reason: 'review_request', requesterId: 2, since: hoursAgo(4) });
    expect(lead(byOther)).toBe('David Buckley asked you to review');
    expect(pendingHeading(byOther, ctx()).at).toBe(hoursAgo(4));
    expect(pendingActionLine(byOther, ctx()).by).toBe('Robin Dunn');
    // Robin asked for a review of their own PR: the heading already names them.
    const byAuthor = myTurn({ reason: 'review_request', requesterId: 3 });
    expect(lead(byAuthor)).toBe('Robin Dunn asked you to review');
    expect(pendingActionLine(byAuthor, ctx()).by).toBeNull();
    // A requester the users table cannot name: the passive sentence, and "by" comes back.
    const unknown = myTurn({ reason: 'review_request', requesterId: 77 });
    expect(lead(unknown)).toBe('Your review was requested');
    expect(pendingActionLine(unknown, ctx()).by).toBe('Robin Dunn');
  });

  it('pushed since you acted: who pushed how many, since what', () => {
    const card = myTurn({
      reason: 'pushed_since',
      ball: { kind: 'commits_after', yourLastAction: 'approved', humanCommitsAfter: 2, pusherId: 3 },
    });
    expect(lead(card)).toBe('Robin Dunn pushed 2 commits since you approved');
    expect(lead(myTurn({ reason: 'pushed_since', ball: { kind: 'commits_after', humanCommitsAfter: 1 } }))).toBe(
      '1 commit pushed since you last looked',
    );
  });

  it('a new PR: the author is the actor — named in the heading, not again on line two', () => {
    const card = myTurn({ reason: 'watched_repo_pr', ball: { kind: 'untouched' }, relevance: 'maintained' });
    expect(lead(card)).toBe('Robin Dunn opened a new PR');
    const line = pendingActionLine(card, ctx());
    expect(line.label).toBe('In your repos');
    expect(line.by).toBeNull();
    // A bot's new PR names its brand.
    expect(
      lead({ ...card, authorId: 9, automation: { role: 'dependency', kind: 'dependabot', source: 'account' } }),
    ).toBe('Dependabot opened a new PR');
  });
});

describe('My turn — your own PR', () => {
  it('your_pr: the counts, who did them, and the clearing rule', () => {
    const card = myTurn({
      reason: 'your_pr',
      detail: '3 new comments · 1 new commit',
      newActorIds: [2, 3],
      newActorTotal: 4,
    });
    expect(lead(card)).toBe('3 new comments and 1 new commit on your PR');
    expect(pendingActionLine(card, ctx()).where).toEqual([
      { text: 'from David Buckley, Robin Dunn and 2 others' },
      { text: 'clears when you open it' },
    ]);
    // No actors on the wire: the "from" clause is dropped.
    expect(pendingActionLine({ ...card, newActorIds: undefined }, ctx()).where).toEqual([
      { text: 'clears when you open it' },
    ]);
  });

  it('pr_approved: the approvers by name, and the standing is not repeated in the fact line', () => {
    const card = myTurn({
      reason: 'pr_approved',
      detail: 'Approved by 2 reviewers · 2d ago',
      reviewApprovals: 2,
      reviewers: [
        { userId: 2, standing: 'approved', standingAt: hoursAgo(48), isBot: false, botKind: null },
        { userId: 3, standing: 'approved', standingAt: hoursAgo(49), isBot: false, botKind: null },
      ],
      reviewerCount: 2,
    });
    expect(lead(card)).toBe('David Buckley and Robin Dunn approved your PR');
    expect(pendingActionLine(card, ctx()).verb).toBe('Open to merge');
  });

  it('own_ready: can land / behind / queued — the queue line leads while queued', () => {
    const own = {
      kind: 'ready',
      forward: 'merge',
      mergeStateStatus: 'clean',
      mergeable: 'mergeable',
      lastCommitAt: hoursAgo(3),
      viewerCanPush: true,
    } as const;
    const card = myTurn({ reason: 'own_ready', own });
    expect(lead(card)).toBe('Your PR can land now');
    expect(pendingActionLine(card, ctx()).after).toEqual([{ text: 'last commit 3h' }]);
    expect(lead(myTurn({ reason: 'own_ready', own: { ...own, forward: 'update_branch', mergeStateStatus: 'behind' } }))).toBe(
      'Your PR is behind its base branch',
    );
    const queued = myTurn({ reason: 'own_ready', own, inMergeQueue: true, mergeQueueEntryState: 'awaiting_checks' });
    expect(lead(queued)).toBe('Your PR is in the merge queue · running checks');
    expect(pendingActionLine(queued, ctx()).verb).toBe('Let it land');
    // The merge row's newer-wins answer overrules the card's own field.
    expect(lead(queued, ctx({ queueLine: null }))).toBe('Your PR can land now');
  });

  it('own_conflicts names the base branch from the sentence, or says "its base branch"', () => {
    expect(lead(myTurn({ reason: 'own_conflicts', detail: 'Conflicts with main' }))).toBe('Your PR conflicts with main');
    expect(lead(myTurn({ reason: 'own_conflicts', detail: 'Conflicts with the base branch' }))).toBe(
      'Your PR conflicts with its base branch',
    );
  });

  it('own_ci_red: the first failing check in the heading, the rest in the content', () => {
    const card = myTurn({ reason: 'own_ci_red', ciStatus: 'failure', failingChecks: ['SonarCloud', 'lint'], failingCheckTotal: 3 });
    expect(lead(card)).toBe('Your build failed: SonarCloud');
    expect(restOfFailingChecks(card)).toEqual({ names: ['lint'], more: 1 });
    expect(lead(myTurn({ reason: 'own_ci_red', ciStatus: 'failure' }))).toBe('Your build failed');
    expect(pendingFactPlan(card)).toBe('none');
  });

  it('own_thread: whose comment, on which file — a bot by its brand', () => {
    const own = { kind: 'thread', path: 'app/x.ts', originalCommenterId: 2, botKind: null, botLabel: null } as const;
    expect(lead(myTurn({ reason: 'own_thread', threadId: 5, own }))).toBe('David Buckley’s comment on app/x.ts has no reply');
    expect(
      lead(myTurn({ reason: 'own_thread', threadId: 5, own: { ...own, botKind: 'coderabbit', originalCommenterId: 77 } })),
    ).toBe('CodeRabbit’s comment on app/x.ts has no reply');
  });

  it('claude_review: the verdict in words, never the raw enum', () => {
    expect(lead(myTurn({ reason: 'claude_review', detail: 'Claude review ready · REQUEST_CHANGES' }))).toBe(
      'Claude reviewed: Request changes',
    );
    expect(lead(myTurn({ reason: 'claude_review', trigger: 'auto', detail: 'Claude review ready · COMMENT' }))).toBe(
      'Claude’s auto review: Comment',
    );
    expect(lead(myTurn({ reason: 'claude_review', detail: 'Claude review ready' }))).toBe('Claude finished a review');
    expect(
      pendingActionLine(myTurn({ reason: 'claude_review', detail: 'Claude review ready · COMMENT · head moved since' }), ctx())
        .where,
    ).toEqual([{ text: 'new commits since' }]);
  });
});

describe('a red default branch is a repository, not a PR', () => {
  it('heads with the branch, the repo and the first check — and prints no PR title', () => {
    const t = trunk();
    expect(lead(t)).toBe('main is red in bng-metric-frontend: Run Journey Tests');
    const line = pendingActionLine(t, ctx());
    expect(line.showTitle).toBe(false);
    expect(line.verb).toBe('Fix it or chase it');
    expect(line.where[0]).toEqual({ text: 'you maintain this repo' });
    expect(line.where[1]).toMatchObject({ text: 'at f48aec5', mono: true, href: t.githubUrl });
    expect(JSON.stringify({ h: pendingHeading(t, ctx()), line })).not.toMatch(/\bPR\b/);
    expect(pendingCardEvent(t)).toEqual({ kind: 'external' });
  });

  it('the ci_failing trunk arm reads the branch from its sentence', () => {
    const c: CiFailingCard = {
      id: 'ci:trunk:6',
      kind: 'ci_failing',
      severity: 'warn',
      arm: 'trunk',
      repoId: 6,
      repoFullName: 'DEFRA/bng-metric-backend',
      ciStatus: 'failure',
      prId: null,
      prNumber: null,
      prTitle: null,
      headSha: 'abc1234def',
      mergedById: null,
      viewerMerged: false,
      authorId: null,
      authorIsBot: false,
      authorBotKind: null,
      automation: null,
      detail: 'You maintain this repo — develop is red at abc1234',
      observedAt: hoursAgo(1),
      githubUrl: 'https://github.com/x/commit/abc',
      failingChecks: null,
      failingCheckTotal: null,
    };
    expect(lead(c)).toBe('develop is red in bng-metric-backend');
    expect(pendingActionLine(c, ctx()).showTitle).toBe(false);
    // A direct push: no landing PR, nothing named.
    expect(lastLandedLine(c, ctx().nameOf)).toBeNull();
  });

  it('the last-landed line names who opened and who merged the landing PR', () => {
    const t = trunk();
    expect(lastLandedLine({ ...t, prId: 354 } as unknown as CiFailingCard, ctx().nameOf)).toEqual({
      pr: '#354 chore(deps-dev): bump the tools group',
      by: 'Dependabot',
      mergedBy: 'Robin Dunn',
    });
  });

  it('your own red PR on the Needs fixing tab', () => {
    const c = {
      id: 'ci:pr:1',
      kind: 'ci_failing',
      severity: 'high',
      arm: 'your_pr',
      repoId: 6,
      repoFullName: 'DEFRA/a',
      ciStatus: 'failure',
      prId: 5,
      prNumber: 5,
      prTitle: 'Fix it',
      headSha: null,
      mergedById: null,
      viewerMerged: false,
      authorId: 1,
      authorIsBot: false,
      authorBotKind: null,
      automation: null,
      detail: 'You opened this PR — its head commit is red',
      observedAt: hoursAgo(2),
      githubUrl: 'https://github.com/DEFRA/a/pull/5',
      failingChecks: ['build'],
      failingCheckTotal: 1,
    } as CiFailingCard;
    expect(lead(c)).toBe('Your build failed: build');
    expect(pendingCardEvent(c)).toEqual({ kind: 'landing_pr' });
  });

  it('a red build on YOUR PR still names the PR and its repo#N; a red trunk names none', () => {
    const c: CiFailingCard = {
      id: 'ci:pr:352',
      kind: 'ci_failing',
      severity: 'high',
      arm: 'your_pr',
      repoId: 6,
      repoFullName: 'DEFRA/bng-metric-frontend',
      ciStatus: 'failure',
      prId: 352,
      prNumber: 352,
      prTitle: 'BMD-1043: Open project summary',
      headSha: null,
      mergedById: null,
      viewerMerged: false,
      authorId: 1,
      authorIsBot: false,
      authorBotKind: null,
      automation: null,
      detail: 'Your PR is red',
      observedAt: hoursAgo(2),
      githubUrl: 'https://github.com/DEFRA/bng-metric-frontend/pull/352',
      failingChecks: ['lint'],
      failingCheckTotal: 1,
    };
    expect(pendingCardPrLabel(c, 'DEFRA')).toEqual({
      title: 'BMD-1043: Open project summary',
      ref: 'bng-metric-frontend#352',
    });
    expect(pendingActionLine(c, ctx())).toMatchObject({ verb: 'Fix the build', showTitle: true });
    expect(pendingCardPrLabel({ ...c, arm: 'trunk', prId: null, prNumber: null, prTitle: null }, 'DEFRA')).toBeNull();
    expect(pendingCardPrLabel(myTurn({ reason: 'mention' }), 'DEFRA')).toEqual({
      title: 'BMD-1043: Open project summary',
      ref: 'bng-metric-frontend#352',
    });
  });
});

describe('the relevance label on line two', () => {
  it('drops "Your turn" inside My turn, keeps it elsewhere', () => {
    expect(pendingRelevanceLabel(myTurn({ reason: 'mention', relevance: 'direct' }), 'my_turn')).toBeNull();
    expect(pendingRelevanceLabel(myTurn({ reason: 'mention', relevance: 'direct' }), null)).toBe('Your turn');
  });

  it('keeps "In your repos" and the neutral label', () => {
    expect(pendingRelevanceLabel(myTurn({ reason: 'watched_repo_pr', relevance: 'maintained' }), 'my_turn')).toBe(
      'In your repos',
    );
    expect(pendingRelevanceLabel(myTurn({ reason: 'watched_repo_pr', relevance: 'none' }), 'my_turn')).toBe(
      'Review or reply',
    );
  });

  it('⚠ an ABSENT relevance is neutral, even when `personal` is true', () => {
    const card = myTurn({ reason: 'watched_repo_pr' });
    delete (card as { relevance?: unknown }).relevance;
    card.personal = true;
    expect(pendingRelevanceLabel(card, 'my_turn')).toBe('Review or reply');
  });

  it('muted is one word on line two, and display only', () => {
    const line = pendingActionLine(myTurn({ reason: 'watched_repo_pr', relevance: 'none', muted: true }), ctx());
    expect(line.muted).toBe(true);
    expect(line.label).toBe('Review or reply');
  });
});

// ── the other five tabs ──────────────────────────────────────────────────────────────────────

describe('the other tabs', () => {
  it('conflicts: whose PR — "Your PR" for the viewer’s own', () => {
    const c = { ...prRef(), id: 'c', kind: 'conflicts', severity: 'high', mergeStateStatus: 'dirty', mergeable: 'conflicting', relevance: 'direct', detail: 'Conflicts with main' } as ConflictsCard;
    expect(lead(c)).toBe('Robin Dunn’s PR conflicts with main');
    expect(lead({ ...c, authorId: 1 })).toBe('Your PR conflicts with main');
    expect(pendingActionLine(c, ctx()).verb).toBe('Resolve conflicts');
  });

  it('stalled_review names who it waits on, and the wait', () => {
    const c = { ...prRef(), id: 's', kind: 'stalled_review', severity: 'warn', ageHours: 96, requestedReviewerIds: [4], requestedTeamNames: ['bng-reviewers'] } as StalledReviewCard;
    expect(lead(c)).toBe('Waiting 4d on Priya Shah and @bng-reviewers');
    expect(pendingHeading(c, ctx()).at).toBeNull();
    expect(lead({ ...c, requestedReviewerIds: [], requestedTeamNames: [] })).toBe('Waiting 4d for a review');
    expect(pendingFactPlan(c)).toBe('review');
  });

  it('reviewer_routing: nobody asked, and how long it has been open', () => {
    const c = { ...prRef(), id: 'r', kind: 'reviewer_routing', severity: 'warn', topPaths: [], suggestedReviewers: [], viewerCanPush: true } as ReviewerRoutingCard;
    const h = pendingHeading(c, ctx());
    expect(h.lead).toBe('Nobody was asked to review this');
    expect(h.atPrefix).toBe('opened');
    expect(pendingActionLine(c, ctx()).by).toBe('Robin Dunn');
  });

  it('reviewer_load: a person, not a PR', () => {
    const c = { id: 'l', kind: 'reviewer_load', severity: 'info', reviewerId: 4, pendingCount: 4, reviewsThisSprint: 2, pendingPrs: [] } as ReviewerLoadCard;
    expect(lead(c)).toBe('Priya Shah has 4 reviews waiting');
    expect(pendingActionLine(c, ctx())).toMatchObject({ verb: null, showTitle: false, where: [{ text: '2 done this sprint' }] });
    expect(pendingCardEvent(c)).toEqual({ kind: 'none' });
  });

  it('untouched_thread: whose comment, on which file, quoted below — and it opens the thread', () => {
    const c = { ...prRef(), id: 'u', kind: 'untouched_thread', severity: 'warn', threadId: 11, path: 'src/api/tariff.ts', ageHours: 6, originalCommenterId: 77, botKind: 'coderabbit', botLabel: 'CodeRabbit' } as UntouchedThreadCard;
    expect(lead(c)).toBe('CodeRabbit’s comment on src/api/tariff.ts has no reply');
    expect(compactAge(pendingHeading(c, ctx()).at, NOW)).toBe('6h');
    expect(pendingCardEvent(c)).toEqual({ kind: 'thread', threadId: 11 });
    expect(lead({ ...c, botKind: null, originalCommenterId: 404 })).toBe('A reviewer’s comment on src/api/tariff.ts has no reply');
  });

  it('merge / update_branch: ready, unstable, behind, queued', () => {
    const m = { ...prRef(), id: 'm', kind: 'merge', severity: 'warn', mergeStateStatus: 'clean', mergeable: 'mergeable', lastCommitAt: hoursAgo(3), relevance: 'none', detail: '', viewerCanPush: true } as MergeReadyCard;
    expect(lead(m)).toBe('Ready to merge');
    expect(lead({ ...m, mergeStateStatus: 'unstable' })).toBe('Ready to merge · non-required checks are red');
    expect(lead({ ...m, inMergeQueue: true, mergeQueueEntryState: 'mergeable' })).toBe('In the merge queue · lands next');
    const u = { ...m, kind: 'update_branch', mergeStateStatus: 'behind' } as UpdateBranchCard;
    expect(lead(u)).toBe('Behind its base branch — GitHub blocks the merge');
    expect(pendingActionLine(u, ctx()).verb).toBe('Update branch');
    expect(pendingActionLine(m, ctx())).toMatchObject({ verb: 'Merge', by: 'Robin Dunn', after: [{ text: 'last commit 3h' }] });
  });

  it('security: a fix by its bot and advisory; "likely" when inferred; an alert by its tool', () => {
    const base = {
      ...prRef({ authorId: 9, automation: { role: 'dependency', kind: 'dependabot', source: 'account' } }),
      id: 'sec',
      kind: 'security',
      severity: 'high',
      dependencyUpdate: true,
      depState: 'ready',
      fix: 'proven',
      alerts: [],
      alertCount: 0,
      advisoryIds: ['GHSA-4w2v-q235-vp99'],
      detail: 'Fixes GHSA-4w2v-q235-vp99',
      stateDetail: null,
      mergeStateStatus: 'clean',
      mergeable: 'mergeable',
      lastCommitAt: hoursAgo(24),
      relevance: 'none',
      viewerCanPush: true,
    } as SecurityCard;
    expect(lead(base)).toBe('Dependabot fixes GHSA-4w2v-q235-vp99');
    expect(pendingActionLine(base, ctx()).verb).toBe('Merge the fix');
    expect(lead({ ...base, fix: 'inferred' })).toBe('Dependabot likely fixes GHSA-4w2v-q235-vp99');
    const alert = {
      ...base,
      dependencyUpdate: false,
      depState: null,
      fix: null,
      alerts: [{ source: 'snyk', authorId: 50, vendorKind: null, surface: 'comment', threadId: null, advisoryIds: ['CVE-2026-1'], at: hoursAgo(5) }],
      alertCount: 1,
    } as SecurityCard;
    expect(lead(alert)).toBe('Snyk flagged CVE-2026-1');
    expect(pendingActionLine(alert, ctx()).verb).toBe('Check the alert');
  });

  it('dependency_bump: the bump’s state, from its bot', () => {
    const b = {
      ...prRef({ authorId: 9, automation: { role: 'dependency', kind: 'dependabot', source: 'account' } }),
      id: 'd',
      kind: 'dependency_bump',
      severity: 'info',
      depState: 'behind',
      detail: '',
      mergeStateStatus: 'behind',
      mergeable: 'mergeable',
      lastCommitAt: hoursAgo(6),
      relevance: 'none',
      viewerCanPush: true,
    } as DependencyBumpCard;
    expect(lead(b)).toBe('Dependabot bump is behind its base branch');
    expect(pendingActionLine(b, ctx()).verb).toBe('Update branch');
    expect(lead({ ...b, depState: 'ci_red', failingChecks: ['test / test'] })).toBe('Dependabot bump failed: test');
    expect(lead({ ...b, inMergeQueue: true, mergeQueueEntryState: null })).toBe('In the merge queue');
  });
});

describe('what a whole-card click opens — the event', () => {
  it('a thread card opens its thread, commits open Activity, a Claude card opens the review', () => {
    expect(pendingCardEvent(myTurn({ reason: 'thread_reply', threadId: 9 }))).toEqual({ kind: 'thread', threadId: 9 });
    expect(pendingCardEvent(myTurn({ reason: 'pushed_since' }))).toEqual({ kind: 'pr', tab: 'activity' });
    expect(pendingCardEvent(myTurn({ reason: 'claude_review' }))).toEqual({ kind: 'claude_review' });
    expect(pendingCardEvent(myTurn({ reason: 'review_request' }))).toEqual({ kind: 'pr', tab: 'overview' });
    // "3 new comments and 1 new commit on your PR" — the new things live on Activity.
    expect(pendingCardEvent(myTurn({ reason: 'your_pr' }))).toEqual({ kind: 'pr', tab: 'activity' });
  });
});

describe('no imperative without its button, and every fact once', () => {
  it('a merge card the viewer cannot push to carries no "Merge" verb (its row is hidden)', () => {
    const m = { ...prRef(), id: 'm', kind: 'merge', severity: 'warn', mergeStateStatus: 'clean', mergeable: 'mergeable', lastCommitAt: hoursAgo(3), relevance: 'none', detail: '', viewerCanPush: false } as MergeReadyCard;
    expect(pendingActionLine(m, ctx()).verb).toBeNull();
    expect(pendingActionLine({ ...m, kind: 'update_branch', mergeStateStatus: 'behind' } as UpdateBranchCard, ctx()).verb).toBeNull();
    // A queued PR still says what happens next — it needs no button from the reader.
    expect(pendingActionLine({ ...m, inMergeQueue: true, mergeQueueEntryState: 'mergeable' }, ctx()).verb).toBe('Let it land');
    const b = {
      ...prRef({ authorId: 9, automation: { role: 'dependency', kind: 'dependabot', source: 'account' } }),
      id: 'd',
      kind: 'dependency_bump',
      severity: 'info',
      depState: 'ready',
      detail: '',
      mergeStateStatus: 'clean',
      mergeable: 'mergeable',
      lastCommitAt: hoursAgo(6),
      relevance: 'none',
      viewerCanPush: false,
    } as DependencyBumpCard;
    expect(pendingActionLine(b, ctx()).verb).toBeNull();
    expect(pendingActionLine({ ...b, depState: 'needs_review' }, ctx()).verb).toBe('Review it');
  });

  it('a heading that says "needs an approving review" is not followed by the standing again', () => {
    const b = {
      ...prRef({ authorId: 9, automation: { role: 'dependency', kind: 'dependabot', source: 'account' } }),
      id: 'd',
      kind: 'dependency_bump',
      severity: 'info',
      depState: 'needs_review',
      detail: '',
      mergeStateStatus: 'blocked',
      mergeable: 'mergeable',
      lastCommitAt: hoursAgo(6),
      relevance: 'none',
      viewerCanPush: true,
    } as DependencyBumpCard;
    expect(factShowsStanding(b)).toBe(false);
    expect(factShowsStanding({ ...b, depState: 'blocked' })).toBe(true);
    const r = { ...prRef(), id: 'r', kind: 'reviewer_routing', severity: 'warn', topPaths: [], suggestedReviewers: [], viewerCanPush: true } as ReviewerRoutingCard;
    expect(factDropsNoReviews(r)).toBe(true);
    expect(factDropsNoReviews(b)).toBe(false);
  });

  it('a heading that names no check gets every failing name below it', () => {
    const c = { failingChecks: ['build', 'lint', 'test'], failingCheckTotal: 3 };
    expect(restOfFailingChecks(c).names).toEqual(['lint', 'test']);
    expect(restOfFailingChecks(c, { headingNamedFirst: false }).names).toEqual(['build', 'lint', 'test']);
  });
});

describe('an unknown actor is "Someone", never an id or a login', () => {
  it('reads Someone when the user is not in the response', () => {
    const card = myTurn({
      reason: 'thread',
      threadId: 7,
      reply: { authorId: 999, body: 'hi', at: hoursAgo(1), truncated: false },
    });
    expect(lead(card)).toBe('Someone replied');
    expect(lead(card)).not.toMatch(/999|user /);
  });
});
