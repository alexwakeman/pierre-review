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
//   5. THE PICKER OPENS ON THE DEFAULT and is never re-seeded from a stored run (a stored
//      'claude-opus-4-8' would otherwise be a select value with no option).
//   6. EACH NEW COMPONENT IS MOUNTED EXACTLY ONCE (CLAUDE.md: "grep for the mount").
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
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
  createTicketDraftStore,
  fieldCounter,
  followUpAnchor,
  itemHeadMoved,
  notCheckedReason,
  partitionFollowUp,
  reraisedStatusByFindingId,
  resolveTicketDraft,
  sortFindingsForDisplay,
  ticketDraftFromStored,
  ticketPanelHint,
  ticketRequestFromCheck,
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

  it('the "Already posted" chip is wired into the findings list', () => {
    const tab = code(read('components/ClaudeReviewTab.tsx'));
    expect(tab).toMatch(/alreadyPosted=\{alreadyPostedIds\.has\(f\.id\)\}/);
    expect(tab).toMatch(/ALREADY_POSTED_CHIP\.label/);
  });

  it('opens the model picker on the default and never re-seeds it from a stored run', () => {
    const tab = code(read('components/ClaudeReviewTab.tsx'));
    expect(tab).toMatch(/useState<ClaudeReviewModel>\(DEFAULT_CLAUDE_REVIEW_MODEL\)/);
    expect(tab).not.toMatch(/setModel\(\s*review/);
  });

  it('renders model and user-story text as plain text: no Markdown, no href, no maxLength', () => {
    const src = code(read('components/ClaudeReviewFollowUp.tsx'));
    expect(src).not.toMatch(/Markdown/);
    expect(src).not.toMatch(/\bhref=/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    // maxLength would silently cut a paste; the counter and the check's message say what is over.
    expect(src).not.toMatch(/maxLength/);
  });
});
