// THE 'review' SEED (review-seed.ts): which items of a Claude review the fixer is given, their
// refs, the fence, the budget, and the validation of the agent's per-change report.
//   pnpm --filter @pierre-review/backend test review-seed
import { describe, expect, it } from 'vitest';
import type {
  ClaudeCiFailure,
  ClaudeFinding,
  ClaudeFollowUpItem,
  ClaudeReview,
  ClaudeReviewTicketEntry,
  ClaudeThreadAssessment,
} from '@pierre-review/shared';
import {
  buildReviewSeed,
  collectReviewItems,
  normalizeChangeReport,
  REVIEW_ITEM_BODY_MAX,
  type SeedTicketItem,
} from './review-seed.js';

const NONCE = 'abcdef0123456789';
const nonce = (): string => NONCE;

let nextId = 100;
const finding = (over: Partial<ClaudeFinding> = {}): ClaudeFinding => ({
  id: nextId++,
  reviewId: 1,
  path: 'src/a.ts',
  line: 10,
  side: 'RIGHT',
  diffAnchorId: 'x',
  severity: 'warning',
  title: 'A finding',
  body: 'Body text.',
  editedBody: null,
  suggestion: null,
  diffHunk: null,
  anchored: true,
  fileInDiff: true,
  included: true,
  postedAt: null,
  githubCommentId: null,
  postedCommentKind: null,
  createdAt: '2026-10-01T00:00:00Z',
  ...over,
});

const thread = (over: Partial<ClaudeThreadAssessment> = {}): ClaudeThreadAssessment => ({
  ref: 'R1',
  threadId: 7,
  sent: true,
  carried: false,
  authorLogin: 'bob',
  authorIsBot: false,
  path: 'src/b.ts',
  line: 3,
  excerpt: 'This leaks the handle.',
  commentCount: 1,
  lastCommentAt: null,
  url: null,
  validity: 'valid',
  addressed: 'not_addressed',
  explanation: 'Never closed on the error path.',
  draftReply: null,
  assessedAtHead: 'h',
  ...over,
});

const prior = (over: Partial<ClaudeFollowUpItem> = {}): ClaudeFollowUpItem => ({
  ref: 'P1',
  priorFindingId: 55,
  sent: true,
  carried: false,
  status: 'not_addressed',
  explanation: 'Still there.',
  path: 'src/c.ts',
  line: 4,
  side: 'RIGHT',
  severity: 'warning',
  title: 'Old finding',
  reraisedFindingId: null,
  ...over,
});

const ticket = (): ClaudeReviewTicketEntry => ({
  index: 0,
  ref: 'T1',
  ticket: { title: 'Export CSV', description: null, acceptanceCriteria: 'a\nb\nc' },
  assessment: {
    alignment: 'partly_aligned',
    summary: null,
    criteria: [
      { ref: 'AC1', index: 0, text: 'Has a button', status: 'met', explanation: null, path: null, line: null },
      { ref: 'AC2', index: 1, text: 'Escapes commas', status: 'not_met', explanation: 'No quoting.', path: 'src/csv.ts', line: 2 },
      { ref: 'AC3', index: 2, text: 'Has a header', status: 'partly_met', explanation: null, path: null, line: null },
    ],
    missing: [{ title: 'No download filename', explanation: null, path: null, line: null }],
    notRequested: [{ title: 'Extra logging', explanation: null, path: null, line: null }],
  },
});

const ci = (over: Partial<ClaudeCiFailure> = {}): ClaudeCiFailure => ({
  ref: 'F1',
  checkName: 'test (node 20)',
  jobId: 1,
  step: 'Run tests',
  url: null,
  sent: true,
  carried: false,
  status: 'diagnosed',
  notCheckedReason: null,
  cause: 'A snapshot is out of date.',
  explanation: null,
  category: 'test',
  fixableInPr: true,
  relatedFiles: [{ path: 'src/a.test.ts', line: 9 }],
  assessedAtHead: 'h',
  ...over,
});

const review = (over: Partial<ClaudeReview> = {}): ClaudeReview =>
  ({
    id: 1,
    prId: 2,
    headSha: 'h',
    status: 'succeeded',
    model: 'claude-opus-5-5',
    summary: 'Overall fine.',
    userBody: null,
    findings: [],
    ...over,
  }) as ClaudeReview;

describe('collectReviewItems — what the fixer is given', () => {
  it('takes every finding except praise and questions, posted or not, and skips ignored ones', () => {
    const items = collectReviewItems(
      review({
        findings: [
          finding({ title: 'blocker', severity: 'blocker' }),
          finding({ title: 'praise', severity: 'praise' }),
          finding({ title: 'question', severity: 'question' }),
          finding({ title: 'ignored', included: false }),
          finding({ title: 'posted-unticked', included: false, postedAt: '2026-10-01T00:00:00Z' }),
          finding({ title: 'nit', severity: 'nit' }),
        ],
      }),
    ).map((s) => s.item);
    // A question asks the author something — a reply, never a code change.
    expect(items.map((i) => i.title)).toEqual(['blocker', 'posted-unticked', 'nit']);
    expect(items.map((i) => i.ref)).toEqual(['F1', 'F2', 'F3']);
    expect(items.every((i) => i.kind === 'finding' && i.findingId != null)).toBe(true);
  });

  it('adds open earlier findings (not re-raised), threads to fix and fixable CI — never a legacy story', () => {
    const items = collectReviewItems(
      review({
        findings: [finding()],
        followUp: {
          priorReviewId: 9,
          priorHeadSha: 'g',
          headMoved: true,
          changesSinceShown: false,
          items: [
            prior({ title: 'open' }),
            prior({ title: 'partly', status: 'partly_addressed' }),
            prior({ title: 'done', status: 'addressed' }),
            prior({ title: 'reraised', reraisedFindingId: 123 }),
            prior({ title: 'asked', severity: 'question' }),
          ],
        },
        threadAssessments: [thread(), thread({ threadId: 8, validity: 'not_valid' })],
        tickets: [ticket()],
        ciFailures: [
          ci(),
          ci({ checkName: 'infra', fixableInPr: false }),
          ci({ checkName: 'unread', status: 'not_checked', fixableInPr: null }),
        ],
      }),
    ).map((s) => s.item);
    // The stored story assessment (`tickets`) is a legacy single-PR verdict: never seeded.
    expect(items.map((i) => `${i.ref}:${i.kind}`)).toEqual([
      'F1:finding',
      'P1:earlier_finding',
      'P2:earlier_finding',
      'T1:thread',
      'C1:ci_failure',
    ]);
    expect(items.find((i) => i.ref === 'T1')).toMatchObject({ threadId: 7, path: 'src/b.ts' });
    expect(items.find((i) => i.ref === 'P1')).toMatchObject({ findingId: 55 });
    expect(items.find((i) => i.ref === 'C1')?.title).toContain('test (node 20)');
  });

  it('a LEGACY story finding is not seeded, ignored or not — the ticket review owns that verdict', () => {
    const items = collectReviewItems(
      review({
        findings: [
          finding({ title: 'Escapes commas', story: { index: 0, ref: 'AC2' } }),
          finding({ title: 'No download filename', path: '', line: null, included: false, story: { index: 0, ref: 'M1' } }),
          finding({ title: 'ordinary' }),
        ],
        tickets: [ticket()],
      }),
    ).map((s) => `${s.item.ref}:${s.item.title}`);
    expect(items).toEqual(['F1:ordinary']);
  });

  it("a MANUAL fix's ticket items (this PR owns them) arrive as S<t>-<ref>, one S per ticket run", () => {
    const tItem = (ticketReviewId: number, ref: string, status: 'not_met' | 'partly_met' | 'missing', title: string): SeedTicketItem => ({
      ticketKey: ticketReviewId === 4 ? 'ENG-1' : null,
      ticketTitle: 'Export CSV',
      ticketReviewId,
      item: { ref, status, title, body: status === 'missing' ? '' : 'Why it is open.', path: ref === 'AC2' ? 'src/csv.ts' : null, line: ref === 'AC2' ? 2 : null },
    });
    const seeded = collectReviewItems(review({ findings: [finding()] }), [
      tItem(4, 'AC2', 'not_met', 'Escapes commas'),
      tItem(4, 'M1', 'missing', 'No download filename'),
      tItem(9, 'AC1', 'partly_met', 'Has a header'),
    ]);
    expect(seeded.map((s) => `${s.item.ref}:${s.item.kind}:${s.item.ticketIndex}`)).toEqual([
      'F1:finding:null',
      'S1-AC2:story:0',
      'S1-M1:story:0',
      'S2-AC1:story:1',
    ]);
    expect(seeded[1]!.item).toMatchObject({ path: 'src/csv.ts', line: 2 });
    expect(seeded[1]!.body).toContain('Ticket: ENG-1 Export CSV');
    expect(seeded[1]!.body).toContain('Status: not met');
    expect(seeded[2]!.body).toContain('Missing: No download filename');
    // Without ticket items (an auto fix), the same review seeds the PR review alone.
    expect(collectReviewItems(review({ findings: [finding()] })).map((s) => s.item.ref)).toEqual(['F1']);
  });

  it('buildReviewSeed fences ticket items like every other item', () => {
    const s = buildReviewSeed(review({ findings: [] }), {
      nonce,
      ticketItems: [
        { ticketKey: 'ENG-1', ticketTitle: null, ticketReviewId: 4, item: { ref: 'AC2', status: 'not_met', title: 'Escapes commas', body: 'x', path: null, line: null } },
      ],
    });
    expect(s.sentRefs).toEqual(['S1-AC2']);
    expect(s.text).toContain(`---BEGIN ITEM S1-AC2 ${NONCE}---`);
  });

  it('a re-raise saved left out on an unchanged head still reaches the fixer, exactly once', () => {
    // follow-up.ts saves a re-raise of a comment already posted on this same commit with
    // `included: false` and no postedAt — that is not the reader's ignore. P drops the earlier
    // finding because it was re-raised, so F must keep it or the open issue reaches neither.
    const reraise = finding({ title: 'still open', included: false, priorFindingId: 55 });
    const items = collectReviewItems(
      review({
        findings: [reraise],
        followUp: {
          priorReviewId: 9,
          priorHeadSha: 'h',
          headMoved: false,
          changesSinceShown: false,
          items: [prior({ title: 'still open', reraisedFindingId: reraise.id })],
        },
      }),
    ).map((s) => s.item);
    expect(items.map((i) => `${i.ref}:${i.title}`)).toEqual(['F1:still open']);
    expect(items[0]).toMatchObject({ findingId: reraise.id });
  });

  it('reads a review with none of the optional sections (an older row) as findings only', () => {
    expect(collectReviewItems(review({ findings: [finding({ severity: 'praise' })] }))).toEqual([]);
  });
});

describe('buildReviewSeed — refs, fences, budget', () => {
  const full = (): ClaudeReview =>
    review({
      findings: [finding({ title: 'one' }), finding({ title: 'two', severity: 'blocker' })],
      threadAssessments: [thread()],
    });

  it('refs are stable: the same stored review yields the same refs and text', () => {
    const a = buildReviewSeed(full(), { nonce });
    const b = buildReviewSeed(full(), { nonce });
    expect(a.items.map((i) => i.ref)).toEqual(['F1', 'F2', 'T1']);
    expect(b.items.map((i) => i.ref)).toEqual(a.items.map((i) => i.ref));
    expect(b.text).toBe(a.text);
  });

  it('fences every item and the summary, and lists items in ref order', () => {
    const s = buildReviewSeed(full(), { nonce });
    expect(s.text).toContain(`---BEGIN ITEM F1 ${NONCE}---`);
    expect(s.text).toContain(`---END ITEM T1 ${NONCE}---`);
    expect(s.text).toContain(`---BEGIN REVIEW SUMMARY ${NONCE}---\nOverall fine.`);
    expect(s.text.indexOf('ITEM F1')).toBeLessThan(s.text.indexOf('ITEM F2'));
    // The untrusted text sits INSIDE its fence.
    const f = s.text.indexOf(`---BEGIN ITEM T1 ${NONCE}---`);
    expect(s.text.indexOf('This leaks the handle.')).toBeGreaterThan(f);
    expect(s.sentRefs).toEqual(['F1', 'F2', 'T1']);
  });

  it('the nonce picker sees every fenced text', () => {
    let seen: string[] = [];
    buildReviewSeed(full(), {
      nonce: (t) => {
        seen = t;
        return NONCE;
      },
    });
    expect(seen.some((t) => t.includes('This leaks the handle.'))).toBe(true);
    expect(seen).toContain('Overall fine.');
  });

  it('over budget: keeps the highest priority, NAMES the rest, and marks them not included', () => {
    const r = review({
      findings: [
        finding({ title: 'nit', severity: 'nit', body: 'n'.repeat(800) }),
        finding({ title: 'blocker', severity: 'blocker', body: 'b'.repeat(800) }),
      ],
      threadAssessments: [thread({ excerpt: 't'.repeat(800) })],
    });
    const s = buildReviewSeed(r, { nonce, budgetChars: 1_000 });
    // Blocker (F2) first by priority; nothing else fits.
    expect(s.sentRefs).toEqual(['F2']);
    expect(s.items.filter((i) => !i.included).map((i) => i.ref)).toEqual(['F1', 'T1']);
    expect(s.text).toContain('Left out to fit the prompt (you were NOT shown these; do not report on them): F1, T1.');
    expect(s.text).not.toContain('n'.repeat(800));
  });

  it('always shows at least one item, and clips a huge body rather than dropping it', () => {
    const s = buildReviewSeed(review({ findings: [finding({ body: 'x'.repeat(50_000) })] }), {
      nonce,
      budgetChars: 100,
    });
    expect(s.sentRefs).toEqual(['F1']);
    expect(s.text).toContain('…(cut to fit)');
    expect(s.text.length).toBeLessThan(REVIEW_ITEM_BODY_MAX + 2_000);
  });

  it('nothing to fix ⇒ no items, no text', () => {
    expect(buildReviewSeed(review({ findings: [finding({ severity: 'praise' })] }), { nonce })).toEqual({
      items: [],
      sentRefs: [],
      text: '',
    });
  });
});

describe('normalizeChangeReport — the agent self-report, validated', () => {
  const sent = ['F1', 'F2', 'T1'];
  const files = ['src/a.ts', 'src/b.ts'];

  it('drops unknown refs, merges per file, keeps diff order, clips text', () => {
    const r = normalizeChangeReport(
      {
        changes: [
          { path: './src/b.ts', summary: 'Closed the handle.', refs: ['T1', 'Z9', 'F3'] },
          { path: 'src/a.ts', summary: 'x'.repeat(2_000), refs: ['F1'] },
          { path: 'src/b.ts', summary: 'Also renamed.', refs: ['F2', 'T1'] },
          { path: 'not/in/diff.ts', summary: 'Phantom.', refs: ['F2'] },
        ],
        unaddressed: [],
      },
      sent,
      files,
    );
    expect(r.changes.map((c) => c.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(r.changes[0]!.summary.length).toBeLessThanOrEqual(600);
    expect(r.changes[1]).toEqual({
      path: 'src/b.ts',
      summary: 'Closed the handle. Also renamed.',
      refs: ['T1', 'F2'],
    });
    expect(r.notReported).toEqual([]);
  });

  it('unaddressed: known refs only, first per ref wins; silent refs are notReported', () => {
    const r = normalizeChangeReport(
      {
        changes: [{ path: 'src/a.ts', summary: 'Fixed.', refs: ['F1'] }],
        unaddressed: [
          { ref: 'T1', reason: 'The comment is wrong: the handle is closed in finally.' },
          { ref: 'T1', reason: 'second' },
          { ref: 'Q7', reason: 'invented' },
        ],
      },
      sent,
      files,
    );
    expect(r.unaddressed).toEqual([
      { ref: 'T1', reason: 'The comment is wrong: the handle is closed in finally.' },
    ]);
    expect(r.notReported).toEqual(['F2']);
  });

  it('tolerates a missing or malformed report', () => {
    expect(normalizeChangeReport(undefined, sent, files)).toEqual({
      changes: [],
      unaddressed: [],
      notReported: sent,
    });
    const bad = normalizeChangeReport(
      { changes: [null, { path: 3 }, { path: 'src/a.ts' }] as never, unaddressed: 'no' as never },
      [],
      files,
    );
    expect(bad).toEqual({ changes: [], unaddressed: [], notReported: [] });
  });

  it('a plain run (no refs shown) keeps the per-file summaries and drops every ref', () => {
    const r = normalizeChangeReport(
      { changes: [{ path: 'src/a.ts', summary: 'Fixed the typo.', refs: ['F1'] }] },
      [],
      files,
    );
    expect(r.changes).toEqual([{ path: 'src/a.ts', summary: 'Fixed the typo.', refs: [] }]);
  });
});
