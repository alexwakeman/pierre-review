// THE CLAUDE REVIEW TAB'S FOLLOW-UP + USER-STORY UI: the pure half, and the source guards that
// keep the tab honest about it.
//
// What this pins, and why each is an assertion rather than a comment:
//   1. ORDER. Still-open earlier comments lead (not addressed, then partly, then not checked);
//      within one severity, the findings that raise an earlier comment again lead.
//   2. ANCHORS NEVER ASSERT A STALE LINE. An earlier comment's own line is from an older head, so
//      once the head moved it points at the file only — unless this run raised it again, whose
//      anchor is current.
//   3. NOT CHECKED IS GREY, NOT AMBER — unknown is not "not addressed".
//   4. THE REQUEST SENDS ONLY A VALID, NON-EMPTY USER STORY, normalised by the SAME shared check
//      the route runs; the collapsed panel's header says when one will be sent or needs a fix.
//   5. THE PICKER OPENS ON THE DEFAULT and is never re-seeded from a stored run (a run stored
//      under a retired id, such as the old Opus 4.8, would otherwise be a select value with no
//      option).
//   6. EACH NEW COMPONENT IS MOUNTED EXACTLY ONCE (CLAUDE.md: "grep for the mount").
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAUDE_REVIEW_MAX_TICKETS,
  CLAUDE_REVIEW_TICKET_LIMITS,
  checkClaudeReviewTicket,
} from '@pierre-review/shared';
import type {
  ClaudeFinding,
  ClaudeFindingSeverity,
  ClaudeFollowUpItem,
  ClaudeFollowUpStatus,
} from '@pierre-review/shared';
import {
  ALREADY_POSTED_CHIP,
  EMPTY_TICKET_DRAFT,
  FOLLOW_UP_STATUS_CLASS,
  RERAISED_CHIP,
  alreadyPostedReraiseIds,
  checkTicketDrafts,
  createTicketDraftStore,
  fieldCounter,
  followUpAnchor,
  itemHeadMoved,
  notCheckedReason,
  partitionFollowUp,
  reraisedStatusByFindingId,
  resolveTicketDraft,
  resolveTicketDrafts,
  sortFindingsForDisplay,
  placeStoryFindings,
  storyChipLabel,
  storyFindingIdFor,
  storyFindingIds,
  storyItemChipLabel,
  ticketDraftFromStored,
  ticketDraftsFromReview,
  ticketPanelHint,
  ticketRequestFromCheck,
  ticketsPanelHint,
  ticketsRequestFromCheck,
} from '../src/lib/claudeReviewFollowUp.js';

function finding(
  id: number,
  severity: ClaudeFindingSeverity,
  extra: Partial<ClaudeFinding> = {},
): ClaudeFinding {
  return {
    id,
    reviewId: 1,
    path: 'src/a.ts',
    line: 10,
    side: 'RIGHT',
    diffAnchorId: 'x',
    severity,
    title: `f${id}`,
    body: 'b',
    editedBody: null,
    suggestion: null,
    diffHunk: null,
    anchored: true,
    fileInDiff: true,
    included: true,
    postedAt: null,
    githubCommentId: null,
    postedCommentKind: null,
    createdAt: '2026-09-24T00:00:00Z',
    ...extra,
  };
}

function item(
  priorFindingId: number,
  status: ClaudeFollowUpStatus,
  extra: Partial<ClaudeFollowUpItem> = {},
): ClaudeFollowUpItem {
  return {
    ref: `P${priorFindingId}`,
    priorFindingId,
    sent: true,
    carried: false,
    status,
    explanation: null,
    path: 'src/old.ts',
    line: 42,
    side: 'RIGHT',
    severity: 'warning',
    title: `p${priorFindingId}`,
    reraisedFindingId: null,
    ...extra,
  };
}

describe('sortFindingsForDisplay', () => {
  it('orders by severity, then re-raised first within a severity, stable otherwise', () => {
    const out = sortFindingsForDisplay([
      finding(1, 'nit'),
      finding(2, 'warning'),
      finding(3, 'warning', { priorFindingId: 99 }),
      finding(4, 'blocker'),
      finding(5, 'warning'),
      finding(6, 'praise'),
    ]);
    expect(out.map((f) => f.id)).toEqual([4, 3, 2, 5, 1, 6]);
  });

  it('does not mutate its input', () => {
    const input = [finding(1, 'nit'), finding(2, 'blocker')];
    sortFindingsForDisplay(input);
    expect(input.map((f) => f.id)).toEqual([1, 2]);
  });
});

describe('partitionFollowUp', () => {
  it('puts not addressed, then partly, then not checked first; addressed and gone in closed', () => {
    const { open, closed } = partitionFollowUp([
      item(1, 'addressed'),
      item(2, 'not_checked'),
      item(3, 'partly_addressed'),
      item(4, 'not_addressed'),
      item(5, 'no_longer_applies'),
      item(6, 'not_addressed'),
    ]);
    expect(open.map((i) => i.priorFindingId)).toEqual([4, 6, 3, 2]);
    expect(closed.map((i) => i.priorFindingId)).toEqual([1, 5]);
  });

  it('paints not checked grey, never amber or red', () => {
    expect(FOLLOW_UP_STATUS_CLASS.not_checked).toContain('gray');
    expect(FOLLOW_UP_STATUS_CLASS.not_checked).not.toMatch(/amber|red|orange/);
    expect(FOLLOW_UP_STATUS_CLASS.not_addressed).toContain('red');
  });
});

describe('followUpAnchor', () => {
  const changed = new Set(['src/old.ts', 'src/new.ts']);

  it('prefers the finding that raised it again (its path and line are current)', () => {
    const re = finding(7, 'warning', { path: 'src/new.ts', line: 5, side: 'LEFT' });
    const a = followUpAnchor(
      item(1, 'not_addressed', { reraisedFindingId: 7 }),
      new Map([[7, re]]),
      true,
      changed,
    );
    expect(a).toEqual({ path: 'src/new.ts', line: 5, side: 'LEFT', inChangeset: true });
  });

  it('drops the earlier line once the head moved; keeps it on the same head', () => {
    expect(followUpAnchor(item(1, 'addressed'), new Map(), true, changed).line).toBeNull();
    expect(followUpAnchor(item(1, 'addressed'), new Map(), false, changed).line).toBe(42);
  });

  it('reads the ITEM\'s own head flag first: a carried comment was raised at an older head', () => {
    // Same-head re-run (record headMoved false), but this comment came from an older review.
    expect(itemHeadMoved({ headMoved: true }, false)).toBe(true);
    expect(itemHeadMoved({ headMoved: false }, true)).toBe(false);
    // Rows from before the per-item flag fall back to the record's.
    expect(itemHeadMoved({}, true)).toBe(true);
    expect(followUpAnchor(item(1, 'not_checked', { carried: true, headMoved: true }), new Map(), false, changed).line).toBeNull();
    expect(followUpAnchor(item(1, 'not_checked', { headMoved: false }), new Map(), false, changed).line).toBe(42);
  });

  it('falls back to the earlier anchor when the re-raised finding is not in this run', () => {
    const a = followUpAnchor(
      item(1, 'not_addressed', { reraisedFindingId: 999 }),
      new Map(),
      false,
      new Set(),
    );
    expect(a).toEqual({ path: 'src/old.ts', line: 42, side: 'RIGHT', inChangeset: false });
  });
});

describe('notCheckedReason', () => {
  it('names the two different facts', () => {
    expect(notCheckedReason({ sent: false })).toBe(
      'Not sent to Claude: too many earlier comments.',
    );
    expect(notCheckedReason({ sent: true })).toBe("Claude didn't report on this one.");
  });
});

describe('reraisedStatusByFindingId', () => {
  it('chips only findings that raise a still-open earlier comment', () => {
    const m = reraisedStatusByFindingId({
      findings: [
        finding(10, 'warning', { priorFindingId: 1 }),
        finding(11, 'warning', { priorFindingId: 2 }),
        finding(12, 'warning', { priorFindingId: 3 }),
        finding(13, 'warning'),
      ],
      followUp: {
        priorReviewId: 1,
        priorHeadSha: 'abc',
        headMoved: true,
        changesSinceShown: false,
        items: [item(1, 'not_addressed'), item(2, 'partly_addressed'), item(3, 'addressed')],
      },
    });
    expect([...m.entries()]).toEqual([
      [10, 'not_addressed'],
      [11, 'partly_addressed'],
    ]);
    expect(RERAISED_CHIP.not_addressed.label).toBe('Not addressed since last review');
    expect(RERAISED_CHIP.partly_addressed.label).toBe('Partly addressed since last review');
  });

  it('is empty for a run with no follow-up (older rows omit the field)', () => {
    expect(reraisedStatusByFindingId({ findings: [finding(1, 'nit')] }).size).toBe(0);
    expect(reraisedStatusByFindingId({ findings: [], followUp: null }).size).toBe(0);
  });
});

describe('alreadyPostedReraiseIds', () => {
  const fu = (headMoved: boolean, items: ClaudeFollowUpItem[]) => ({
    priorReviewId: 1,
    priorHeadSha: 'abc',
    headMoved,
    changesSinceShown: false,
    items,
  });

  it('names a re-raise of a comment already posted on this same commit — and nothing else', () => {
    const findings = [
      finding(10, 'warning', { priorFindingId: 1, included: false }),
      finding(11, 'warning', { priorFindingId: 2 }),
      finding(12, 'warning', { priorFindingId: 3 }),
      finding(13, 'warning'),
    ];
    const ids = alreadyPostedReraiseIds({
      findings,
      followUp: fu(false, [
        item(1, 'not_addressed', { priorPosted: true, headMoved: false }),
        item(2, 'not_addressed', { priorPosted: false, headMoved: false }),
        // Posted, but raised at an older head: the reminder is on NEW code, so no chip.
        item(3, 'not_addressed', { priorPosted: true, headMoved: true, carried: true }),
      ]),
    });
    expect([...ids]).toEqual([10]);
    expect(ALREADY_POSTED_CHIP.label).toBe('Already posted');
    expect(ALREADY_POSTED_CHIP.cls).toContain('gray');
  });

  it('falls back to the record head flag, and is empty without a follow-up', () => {
    const findings = [finding(10, 'warning', { priorFindingId: 1 })];
    expect([...alreadyPostedReraiseIds({ findings, followUp: fu(false, [item(1, 'not_addressed', { priorPosted: true })]) })]).toEqual([10]);
    expect(alreadyPostedReraiseIds({ findings, followUp: fu(true, [item(1, 'not_addressed', { priorPosted: true })]) }).size).toBe(0);
    expect(alreadyPostedReraiseIds({ findings, followUp: null }).size).toBe(0);
  });
});

describe('the user story draft', () => {
  it('sends nothing when blank and nothing when invalid', () => {
    expect(ticketRequestFromCheck(checkClaudeReviewTicket(EMPTY_TICKET_DRAFT))).toBeUndefined();
    const tooLong = { ...EMPTY_TICKET_DRAFT, title: 'x'.repeat(CLAUDE_REVIEW_TICKET_LIMITS.titleChars + 1) };
    expect(ticketRequestFromCheck(checkClaudeReviewTicket(tooLong))).toBeUndefined();
  });

  it('sends the trimmed fields and omits the blank ones', () => {
    const check = checkClaudeReviewTicket({
      title: '  Reset password  ',
      description: '   ',
      acceptanceCriteria: '- a\n- b',
    });
    expect(ticketRequestFromCheck(check)).toEqual({
      title: 'Reset password',
      acceptanceCriteria: '- a\n- b',
    });
  });

  it('the collapsed header says what will be sent, or that it needs a fix', () => {
    const hint = (d: typeof EMPTY_TICKET_DRAFT): string =>
      ticketPanelHint(d, checkClaudeReviewTicket(d));
    expect(hint(EMPTY_TICKET_DRAFT)).toBe('');
    expect(hint({ ...EMPTY_TICKET_DRAFT, title: 'T' })).toBe(' · added');
    // No code-side split any more: criteria text in any format is just "added".
    expect(hint({ ...EMPTY_TICKET_DRAFT, acceptanceCriteria: '- a\n- b\n- c' })).toBe(' · added');
    const many = 'x'.repeat(CLAUDE_REVIEW_TICKET_LIMITS.acceptanceCriteriaChars + 1);
    expect(hint({ ...EMPTY_TICKET_DRAFT, acceptanceCriteria: many })).toBe(' · needs a fix');
  });

  it('the counter appears past 80% of the cap, measures the TRIMMED length, flags over', () => {
    const cap = CLAUDE_REVIEW_TICKET_LIMITS.titleChars;
    expect(fieldCounter('title', 'x'.repeat(Math.floor(cap * 0.8)))).toBeNull();
    expect(fieldCounter('title', `   ${'x'.repeat(cap)}   `)).toEqual({
      text: `${cap} / ${cap} characters`,
      over: false,
    });
    expect(fieldCounter('title', 'x'.repeat(cap + 1))?.over).toBe(true);
  });

  it('prefills from the stored ticket unless the reader has their own draft', () => {
    const stored = {
      title: 'T',
      description: null,
      acceptanceCriteria: '- a',
      criteria: ['a'],
    };
    expect(resolveTicketDraft(undefined, stored)).toEqual({
      title: 'T',
      description: '',
      acceptanceCriteria: '- a',
    });
    expect(resolveTicketDraft(EMPTY_TICKET_DRAFT, stored)).toEqual(EMPTY_TICKET_DRAFT);
    expect(resolveTicketDraft(undefined, null)).toEqual(EMPTY_TICKET_DRAFT);
    expect(ticketDraftFromStored(undefined)).toEqual(EMPTY_TICKET_DRAFT);
  });

  it('the draft store remembers a touched PR and drops the oldest past its cap', () => {
    const store = createTicketDraftStore(2);
    store.set(1, { ...EMPTY_TICKET_DRAFT, title: 'one' });
    store.set(2, { ...EMPTY_TICKET_DRAFT, title: 'two' });
    store.set(1, { ...EMPTY_TICKET_DRAFT, title: 'one again' }); // refreshes 1
    store.set(3, { ...EMPTY_TICKET_DRAFT, title: 'three' }); // evicts 2
    expect(store.has(2)).toBe(false);
    expect(store.get(1)?.title).toBe('one again');
    expect(store.get(3)?.title).toBe('three');
  });
});

describe('several user stories', () => {
  const jira = {
    title: 'Reset password',
    description: '*bold*',
    acceptanceCriteria: '- a',
    source: 'jira' as const,
    key: 'ENG-1',
    url: 'https://acme.atlassian.net/browse/ENG-1',
    fetchedAt: '2026-10-02T10:00:00.000Z',
  };
  const manual = { ...EMPTY_TICKET_DRAFT, title: 'Typed story' };

  it('sends every non-blank story, Jira provenance included, and drops blank ones', () => {
    const check = checkTicketDrafts([jira, EMPTY_TICKET_DRAFT, manual]);
    expect(ticketsRequestFromCheck(check)).toEqual([
      {
        title: 'Reset password',
        description: '*bold*',
        acceptanceCriteria: '- a',
        source: 'jira',
        key: 'ENG-1',
        url: 'https://acme.atlassian.net/browse/ENG-1',
        fetchedAt: '2026-10-02T10:00:00.000Z',
      },
      { title: 'Typed story' },
    ]);
    expect(ticketsRequestFromCheck(checkTicketDrafts([]))).toBeUndefined();
  });

  it('names the failing story by its position, and refuses over the count', () => {
    const tooLong = { ...EMPTY_TICKET_DRAFT, title: 'x'.repeat(CLAUDE_REVIEW_TICKET_LIMITS.titleChars + 1) };
    const check = checkTicketDrafts([manual, tooLong]);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.index).toBe(1);
      expect(check.field).toBe('title');
    }
    expect(ticketsRequestFromCheck(check)).toBeUndefined();
    const many = Array.from({ length: CLAUDE_REVIEW_MAX_TICKETS + 1 }, () => manual);
    const over = checkTicketDrafts(many);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.index).toBeNull();
  });

  it('the collapsed header counts the stories', () => {
    expect(ticketsPanelHint([], checkTicketDrafts([]))).toBe('');
    expect(ticketsPanelHint([jira, manual], checkTicketDrafts([jira, manual]))).toBe(' · 2 stories');
    expect(ticketsPanelHint([manual], checkTicketDrafts([manual]))).toBe(' · 1 story');
  });

  it('prefills from a run\'s entries (provenance kept), else its legacy single ticket', () => {
    const entry = (ticket: object, index: number) => ({
      index,
      ref: `T${index + 1}`,
      ticket: { title: null, description: null, acceptanceCriteria: null, ...ticket },
      assessment: null,
    });
    const drafts = ticketDraftsFromReview({ tickets: [entry(jira, 0), entry({ title: 'B' }, 1)] });
    expect(drafts.map((d) => [d.title, d.source, d.key])).toEqual([
      ['Reset password', 'jira', 'ENG-1'],
      ['B', undefined, undefined],
    ]);
    expect(
      ticketDraftsFromReview({ ticket: { title: 'Old', description: null, acceptanceCriteria: null } }),
    ).toHaveLength(1);
    expect(resolveTicketDrafts([manual], { tickets: [entry(jira, 0)] })).toEqual([manual]);
    expect(resolveTicketDrafts(undefined, null)).toEqual([]);
  });
});

// ---- story findings ----

describe('story findings — each unmet story item is a finding; the section links to it', () => {
  const findings = [
    finding(1, 'warning'),
    finding(2, 'warning', { story: { index: 0, ref: 'AC2' } }),
    finding(3, 'nit', { story: { index: 0, ref: 'AC3' } }),
    finding(4, 'warning', { path: '', line: null, story: { index: 0, ref: 'M1' } }),
    finding(5, 'warning', { story: { index: 1, ref: 'AC2' } }),
    // A second row for one item never happens server-side; the first one wins if it ever did.
    finding(6, 'warning', { story: { index: 0, ref: 'AC2' } }),
  ];
  const ids = storyFindingIds(findings);

  it('indexes this run\'s story findings by (story, item); ordinary findings are not in it', () => {
    expect([...ids.entries()]).toEqual([
      ['0:AC2', 2],
      ['0:AC3', 3],
      ['0:M1', 4],
      ['1:AC2', 5],
    ]);
  });

  it('a criterion row finds its card by ref, a not-done row by position; an older run finds none', () => {
    expect(storyFindingIdFor(ids, 0, { ref: 'AC2' })).toBe(2);
    expect(storyFindingIdFor(ids, 1, { ref: 'AC2' })).toBe(5);
    expect(storyFindingIdFor(ids, 0, { missingIndex: 0 })).toBe(4);
    expect(storyFindingIdFor(ids, 0, { missingIndex: 1 })).toBeNull();
    expect(storyFindingIdFor(storyFindingIds([finding(1, 'warning')]), 0, { ref: 'AC2' })).toBeNull();
  });

  it('places each unmet item\'s finding inside its story; the rest stay in the Findings list', () => {
    const crit = (ref: string, status: 'met' | 'not_met' | 'partly_met' | 'unclear') => ({
      ref, text: ref, status, explanation: null, path: null, line: null,
    });
    const tickets = [
      {
        index: 0, ref: 'T1', ticket: { title: 'A', description: null, acceptanceCriteria: null, key: 'BMD-1040' },
        assessment: {
          alignment: 'partly_aligned' as const, summary: null,
          criteria: [crit('AC1', 'met'), crit('AC2', 'not_met'), crit('AC3', 'partly_met')],
          missing: [{ title: 'M', explanation: null, path: null, line: null }],
          notRequested: [],
        },
      },
      // Not checked: nothing to place.
      { index: 1, ref: 'T2', ticket: { title: 'B', description: null, acceptanceCriteria: null }, assessment: null },
    ];
    const { placed } = placeStoryFindings(findings, tickets as never);
    // 1 is ordinary, 5 belongs to a story with no assessment, 6 is a duplicate of 2.
    expect([...placed].sort()).toEqual([2, 3, 4]);
    // A run stored before story findings: nothing placed, every row falls back.
    expect([...placeStoryFindings([finding(1, 'warning')], tickets as never).placed]).toEqual([]);
    expect(storyItemChipLabel('AC2', 'partly_met')).toBe('AC2 · Partly met');
    expect(storyItemChipLabel('M1', null)).toBe('Not done');
  });

  it('the card chip names the story item: key, else "Story N"; a not-done item says so', () => {
    const tickets = [
      { index: 0, ref: 'T1', ticket: { title: 'A', description: null, acceptanceCriteria: null, key: 'BMD-1040' }, assessment: null },
      { index: 1, ref: 'T2', ticket: { title: 'B', description: null, acceptanceCriteria: null }, assessment: null },
    ];
    expect(storyChipLabel({ index: 0, ref: 'AC2' }, tickets)).toBe('BMD-1040 · AC2');
    expect(storyChipLabel({ index: 0, ref: 'M1' }, tickets)).toBe('BMD-1040 · Not done');
    expect(storyChipLabel({ index: 1, ref: 'AC1' }, tickets)).toBe('Story 2 · AC1');
    // A re-raise of an older run's story finding whose ticket this run does not carry.
    expect(storyChipLabel({ index: 4, ref: 'AC1' }, tickets)).toBe('Story · AC1');
  });
});

// ---- source guards ----

const SRC = new URL('../src', import.meta.url).pathname;
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
// Comments explain the rules in the very words the guards look for, so scan code only.
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('source guards', () => {
  it('mounts each new component exactly once', () => {
    const all = walk(SRC)
      .map((f) => code(readFileSync(f, 'utf8')))
      .join('\n');
    for (const name of [
      'ClaudeReviewTicketPanel',
      'ClaudeReviewFollowUpSection',
      'ClaudeReviewTicketResults',
    ]) {
      const mounts = all.match(new RegExp(`<${name}\\b`, 'g')) ?? [];
      expect(mounts.length, name).toBe(1);
    }
  });

  it('the per-ticket "Post as comment" is gone: no post control, no hook, no client call', () => {
    const all = walk(SRC)
      .map((f) => code(readFileSync(f, 'utf8')))
      .join('\n');
    expect(all).not.toMatch(/TicketPostControl|usePostTicketAnalysis|useTicketPostPending/);
    expect(code(readFileSync(join(SRC, 'api/client.ts'), 'utf8'))).not.toMatch(/tickets\/\$\{index\}\/post|postClaudeTicketAnalysis/);
  });

  it('like for like: a story finding renders as THE finding card inside its story, and once', () => {
    const tab = code(read('components/ClaudeReviewTab.tsx'));
    // ONE card builder, used by the Findings list AND handed to Story check's older stories.
    expect(tab.match(/<FindingRow\b/g) ?? []).toHaveLength(1);
    expect(tab).toMatch(/renderFinding: findingCard/);
    expect(tab).toMatch(/findingIds: storyIds/);
    const cov = code(read('components/TicketCoverage.tsx'));
    expect(cov).toMatch(/renderFinding=\{legacy\.renderFinding\}/);
    expect(cov).toMatch(/findingIds=\{legacy\.findingIds\}/);
    // Only the stories Story check SHOWS are placed; the Findings list leaves out exactly those.
    expect(tab).toMatch(/placeStoryFindings\(review\.findings, legacyEntries\)/);
    expect(tab).toMatch(/legacyOnlyEntries\(review\.tickets \?\? \[\], ticketReviews\?\.tickets \?\? \[\]\)/);
    expect(tab).toMatch(/review\.findings\.filter\(\(f\) => !placement\.placed\.has\(f\.id\)\)/);
    // A story finding the stories cannot place keeps its chip in the list.
    expect(tab).toMatch(/f\.story != null \? storyChipLabel\(f\.story, review\.tickets\) : null/);
    const fu = code(read('components/ClaudeReviewFollowUp.tsx'));
    expect(fu).toMatch(/storyFindingIdFor\(findingIds, entry\.index, \{ ref: c\.ref \}\)/);
    expect(fu).toMatch(/storyFindingIdFor\(findingIds, entry\.index, \{ missingIndex: i \}\)/);
    expect(fu).toMatch(/renderFinding\(f, storyItemChipLabel\(/);
    // No "See it below" jump any more: the card is right there.
    expect(fu).not.toMatch(/See it below|StoryFindingJump/);
  });

  it('every section of the Claude Review pane renders through the ONE ReviewSection shell', () => {
    const files = [
      'components/ClaudeReviewTab.tsx',
      'components/ClaudeReviewFollowUp.tsx',
      'components/ClaudeReviewThreads.tsx',
      'components/ClaudeReviewCiFailures.tsx',
      'components/CiCheckSection.tsx',
      'components/ClaudeReviewChat.tsx',
    ];
    const titles = files.flatMap((f) => [...code(read(f)).matchAll(/<ReviewSection\s+title="([^"]+)"/g)].map((m) => m[1]));
    expect(titles.sort()).toEqual(
      [
        'CI check',
        "Claude's review",
        'Findings',
        'Post to GitHub',
        'Previous review',
        'Review chat',
        'Review threads',
        'Reviews and actions',
        'Run a review',
      ].sort(),
    );
    // ONE story section: Story check (TicketCoverage.tsx). The old "User stories" one is gone.
    expect(code(read('components/ClaudeReviewTab.tsx'))).not.toMatch(/'User stor(y|ies)'/);
    expect(code(read('components/TicketCoverage.tsx'))).toMatch(/<ReviewSection\s+title="Story check"/);
    // No hand-rolled <section> left in the pane's components.
    for (const f of files) expect(code(read(f)), f).not.toMatch(/<section\b/);
  });

  it('the "Already posted" chip is wired into the findings list', () => {
    const tab = code(read('components/ClaudeReviewTab.tsx'));
    expect(tab).toMatch(/alreadyPosted=\{alreadyPostedIds\.has\(f\.id\)\}/);
    expect(tab).toMatch(/ALREADY_POSTED_CHIP\.label/);
  });

  it('a posted finding offers no Post again, Reword or Ignore, and no finding has its own Ask', () => {
    const tab = code(read('components/ClaudeReviewTab.tsx'));
    expect(tab).toMatch(/const canPostComment = editable && !isPosted;/);
    expect(tab).toMatch(/const canIgnore = editable && !isPosted;/);
    expect(tab).toMatch(/editable && !isPosted && !rewording/);
    expect(tab).not.toMatch(/Post again/);
    expect(tab).not.toMatch(/Ask Claude/);
    expect(tab).not.toMatch(/ReviewChatThread/);
  });

  it('has no depth picker, no budget line and no review-memory panels', () => {
    const tab = code(read('components/ClaudeReviewTab.tsx'));
    expect(tab).not.toMatch(/REQUESTED_MODE_OPTIONS|reviewModeChoice/);
    expect(tab).not.toMatch(/Max budget/);
    expect(tab).not.toMatch(/useReviewLearnings|useReviewActions|ReviewLearningsPanel/);
  });

  it('opens the model picker on the default and never re-seeds it from a stored run', () => {
    const tab = code(read('components/ClaudeReviewTab.tsx'));
    expect(tab).toMatch(/useState<ClaudeReviewModel>\(DEFAULT_CLAUDE_REVIEW_MODEL\)/);
    expect(tab).not.toMatch(/setModel\(\s*review/);
  });

  it('no "Claude: " lead on generated text — it is all Claude\'s', () => {
    for (const f of [
      'components/ClaudeReviewFollowUp.tsx',
      'components/TicketCoverage.tsx',
      'components/ClaudeReviewCiFailures.tsx',
      'components/ClaudeReviewThreads.tsx',
      'components/ClaudeReviewTab.tsx',
    ]) {
      expect(code(read(f)), f).not.toMatch(/>\s*Claude:\s*</);
    }
  });

  it('renders model and user-story text as plain text: no Markdown, no href, no maxLength', () => {
    const src = code(read('components/ClaudeReviewFollowUp.tsx'));
    // ONE deliberate exception: a story's SUMMARY is markdown (a lead sentence + a bullet per gap),
    // through the sanitizing <Markdown>. Everything else stays plain text.
    expect(src.match(/<Markdown\b[^>]*>/g)).toEqual(['<Markdown prRefs>']);
    expect(src).toContain('<Markdown prRefs>{assessment.summary}</Markdown>');
    expect(src).not.toMatch(/\bhref=/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    // maxLength would silently cut a paste; the counter and the check's message say what is over.
    expect(src).not.toMatch(/maxLength/);
  });
});
