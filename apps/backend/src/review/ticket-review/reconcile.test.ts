// The ticket review's server reconcile (reconcile.ts) — pure, no DB. What this pins:
//   1. `deliveredBy` and `evidence` keep ONLY member refs; a `met` left with nobody to point at is
//      demoted to `unclear`; evidence alone fills `deliveredBy`.
//   2. ⚠ While any member could not be checked out, no criterion is `not_met` — it reads `unclear` —
//      and no missing item is postable.
//   3. Unreported ⇒ `not_checked`; unknown statuses and empty texts are dropped and refs renumber.
//   4. Items: every not_met / partly_met criterion and every missing item, owned by the member
//      Claude named in `expectedIn` (else null), with a path only when a member owns it.
//   5. `met_outside_code` survives only with a citation of a comment IN THE PROMPT; `metBy` is the
//      stored comment; a delivering PR makes it `met`; it is never an item.
//   6. Code outside the ticket: a met only it delivers stays met, labelled apart; expectedIn may name an
//      outside repository, which owns no PR and is never a post target.
//
//   pnpm --filter @pierre-review/backend test ticket-review/reconcile
import { describe, expect, it } from 'vitest';
import { criterionCounts, criterionOutsideWords, ticketCriteriaSentence } from '@pierre-review/shared';
import { namePrRefs, reconcileTicketReview, type ReconcileMember } from './reconcile.js';
import { withNoPrIn } from './persist.js';
import { storyGapTarget } from './post-item.js';

const members: ReconcileMember[] = [
  { ref: 'PR1', prId: 11, repoId: 1, repo: 'acme/api', checkedOut: true },
  { ref: 'PR2', prId: 22, repoId: 2, repo: 'acme/web', checkedOut: true },
];
const ticket = { acceptanceCriteria: '- CSV\n- PDF\n- Email' };

describe('reconcileTicketReview — deliveredBy', () => {
  it('keeps only member refs and demotes a met nobody delivers', () => {
    const { assessment } = reconcileTicketReview(ticket, members, {
      alignment: 'partly_aligned',
      summary: 'ok',
      criteria: [
        { text: 'CSV', status: 'met', explanation: 'x', deliveredBy: ['PR2', 'PR9', 'pr 1'] },
        { text: 'PDF', status: 'met', explanation: 'x', deliveredBy: ['PR7'] },
        { text: 'Email', status: 'met', explanation: 'x', evidence: [{ pr: 'PR2', path: 'src/mail.ts', line: 4 }, { pr: 'PR5', path: 'x' }] },
      ],
    });
    expect(assessment.criteria.map((c) => [c.ref, c.status, c.deliveredBy])).toEqual([
      ['AC1', 'met', [11, 22]],
      ['AC2', 'unclear', []],
      ['AC3', 'met', [22]],
    ]);
    expect(assessment.criteria[2]!.evidence).toEqual([{ prId: 22, path: 'src/mail.ts', line: 4 }]);
  });

  it('renumbers, drops bad rows, and reports nothing as not_checked', () => {
    const { assessment } = reconcileTicketReview(ticket, members, {
      alignment: 'aligned',
      criteria: [
        { text: '', status: 'met' },
        { text: 'CSV', status: 'done' },
        { text: 'PDF', status: 'not_met', explanation: 'none' },
      ],
    });
    expect(assessment.criteria.map((c) => c.ref)).toEqual(['AC1']);
    const none = reconcileTicketReview(ticket, members, null).assessment;
    expect(none.alignment).toBe('not_checked');
    expect(none.criteria).toHaveLength(1);
    expect(none.criteria[0]!.status).toBe('not_checked');
    const empty = reconcileTicketReview(ticket, members, { alignment: 'aligned', criteria: [] }).assessment;
    expect(empty.criteria[0]!.status).toBe('not_checked');
  });
});

describe('reconcileTicketReview — a member that could not be checked out', () => {
  it('turns not_met into unclear, and leaves partly_met and met alone', () => {
    const blind = [members[0]!, { ...members[1]!, checkedOut: false }];
    const report = {
      alignment: 'not_aligned',
      criteria: [
        { text: 'CSV', status: 'not_met', explanation: 'no CSV', expectedIn: { pr: 'PR2' } },
        { text: 'PDF', status: 'partly_met', explanation: 'half', deliveredBy: ['PR1'] },
        { text: 'Email', status: 'met', explanation: 'yes', deliveredBy: ['PR1'] },
      ],
    };
    const { assessment, items } = reconcileTicketReview(ticket, blind, report);
    expect(assessment.criteria.map((c) => c.status)).toEqual(['unclear', 'partly_met', 'met']);
    // An unclear criterion is not something to post.
    expect(items.map((i) => i.ref)).toEqual(['AC2']);
    // With every member read, the same report keeps its not_met.
    const seen = reconcileTicketReview(ticket, members, report);
    expect(seen.assessment.criteria[0]!.status).toBe('not_met');
  });

  it('⚠ keeps a missing item on screen but never makes it postable', () => {
    const blind = [members[0]!, { ...members[1]!, checkedOut: false }];
    const report = { alignment: 'partly_aligned', criteria: [], missing: [{ title: 'Audit log', explanation: 'none' }] };
    const { assessment, items } = reconcileTicketReview(ticket, blind, report);
    expect(assessment.missing.map((m) => m.title)).toEqual(['Audit log']);
    expect(items).toEqual([]);
    expect(reconcileTicketReview(ticket, members, report).items.map((i) => i.ref)).toEqual(['M1']);
  });
});

describe('reconcileTicketReview — items', () => {
  it('owns an item by its expectedIn member, with a path only then', () => {
    const { assessment, items } = reconcileTicketReview(ticket, members, {
      alignment: 'partly_aligned',
      criteria: [
        { text: 'CSV', status: 'not_met', explanation: 'no CSV', expectedIn: { pr: 'PR2' }, path: 'src/export.ts', line: 9 },
        { text: 'PDF', status: 'partly_met', explanation: 'half', deliveredBy: ['PR1'], expectedIn: { repo: 'ACME/api' }, path: 'x.ts' },
        { text: 'Email', status: 'met', deliveredBy: ['PR1'] },
      ],
      missing: [{ title: 'Audit log', explanation: 'none', expectedIn: { pr: 'PR8' } }],
      notRequested: [{ title: 'Dark mode', explanation: 'extra', pr: 'PR1', path: 'theme.css', line: 2 }],
    });
    expect(items).toEqual([
      { ref: 'AC1', status: 'not_met', title: 'CSV', body: 'no CSV', ownerPrId: 22, path: 'src/export.ts', line: 9 },
      { ref: 'AC2', status: 'partly_met', title: 'PDF', body: 'half', ownerPrId: null, path: null, line: null },
      { ref: 'M1', status: 'missing', title: 'Audit log', body: 'none', ownerPrId: null, path: null, line: null },
    ]);
    expect(assessment.criteria[1]!.expectedIn).toEqual({ prId: null, repoId: 1 });
    expect(assessment.missing[0]!.expectedIn).toBeNull();
    expect(assessment.notRequested[0]).toEqual({ title: 'Dark mode', explanation: 'extra', prId: 11, path: 'theme.css', line: 2 });
  });
});

describe('namePrRefs', () => {
  const ms = [
    { ref: 'PR1', prId: 10, repoId: 1, repo: 'acme/web', number: 412, checkedOut: true },
    { ref: 'PR2', prId: 11, repoId: 2, repo: 'acme/api', number: 76, checkedOut: true },
  ];
  it('names member refs the way the reader knows them, and leaves unknown refs alone', () => {
    expect(namePrRefs("PR2's head has it; PR 1 pins it. PR9 is not a member.", ms)).toBe(
      "api#76's head has it; web#412 pins it. PR9 is not a member.",
    );
    expect(namePrRefs(null, ms)).toBeNull();
  });
});

describe('reconcileTicketReview — the summary is two plain sentences', () => {
  // Run 361 (BMD-1086, 2026-10-28) stored one sentence, then a bullet per criterion, clipped mid-word
  // at 1,000 characters ("AC10: CI still runs one `npm test` job, not o…").
  const OLD_SHAPE = [
    'Together the two PRs add the service-template flag and project fixtures. Most of the page-rendering work is not done.',
    '- AC1/AC8: "View baseline details" still matches by ref (PR1).',
    `- AC10: CI still runs one \`npm test\` job, not o${'x'.repeat(1_000)}`,
  ].join('\n');

  it('keeps only the prose before the first bullet, whole', () => {
    const { assessment } = reconcileTicketReview(ticket, members, { alignment: 'partly_aligned', summary: OLD_SHAPE });
    expect(assessment.summary).toBe(
      'Together the two PRs add the service-template flag and project fixtures. Most of the page-rendering work is not done.',
    );
  });

  it('a long summary is cut at a sentence end, never mid-word', () => {
    const long = `${'The first sentence is here. '.repeat(30)}And a trailing clause with no end`;
    const { assessment } = reconcileTicketReview(ticket, members, { alignment: 'aligned', summary: long });
    expect(assessment.summary!.length).toBeLessThanOrEqual(600);
    expect(assessment.summary!.endsWith('here.')).toBe(true);
  });

  it('a summary that is only a list stores nothing; PR refs are named', () => {
    expect(reconcileTicketReview(ticket, members, { alignment: 'aligned', summary: '- a\n- b' }).assessment.summary).toBeNull();
    const named = reconcileTicketReview(ticket, [{ ...members[0]!, number: 7 }], { alignment: 'aligned', summary: 'PR1 does it all.' });
    expect(named.assessment.summary).toBe('api#7 does it all.');
  });

  it("a criterion's own leading ref is dropped (the row prints the ref)", () => {
    const { assessment, items } = reconcileTicketReview(ticket, members, {
      alignment: 'partly_aligned',
      criteria: [
        { text: 'AC1: CSV export works', status: 'met', deliveredBy: ['PR1'] },
        { text: 'AC2 - every new error code shows mapped copy', status: 'not_met', explanation: 'x' },
      ],
    });
    // Never re-cased: "npm test" stays "npm test".
    expect(assessment.criteria.map((c) => c.text)).toEqual(['CSV export works', 'every new error code shows mapped copy']);
    expect(items.map((i) => i.title)).toEqual(['every new error code shows mapped copy']);
  });

  it("the model's OTHER numbering stays visible: a combined ref, or one the row's position differs from", () => {
    const { assessment } = reconcileTicketReview(ticket, members, {
      alignment: 'partly_aligned',
      criteria: [
        { text: 'AC1/AC8 - links work', status: 'met', deliveredBy: ['PR1'] },
        // An unknown status is skipped, so the next row is AC2 by position, not the model's AC3.
        { text: 'AC2: skipped', status: 'bogus' },
        { text: 'AC3: export works', status: 'not_met', explanation: 'x' },
        { text: 'AC3: npm test runs as two jobs', status: 'not_met', explanation: 'x' },
      ],
    });
    expect(assessment.criteria.map((c) => [c.ref, c.text])).toEqual([
      ['AC1', 'AC1/AC8 - links work'],
      ['AC2', 'AC3: export works'],
      ['AC3', 'npm test runs as two jobs'],
    ]);
  });
});

describe('reconcileTicketReview — met outside code changes', () => {
  // The comments IN THE PROMPT, by ref — people only (bots never reach a prompt).
  const comments = new Map([
    ['C1', { id: '10001', author: 'Dana Lee', createdAt: '2026-03-04T10:00:00.000Z' }],
    ['C3', { id: '10003', author: ' ', createdAt: '2026-03-06T09:00:00.000Z' }],
  ]);
  const outside = (over: Record<string, unknown>) => ({ text: 'CSV', status: 'met_outside_code', explanation: 'Done in the admin screen.', ...over });

  it('keeps it with a cited comment, and stores the STORED comment, never model text', () => {
    const { assessment, items } = reconcileTicketReview(
      ticket,
      members,
      { alignment: 'aligned', criteria: [outside({ metByComment: '[c1]' }), outside({ text: 'PDF', metByComment: 'C3' })] },
      comments,
    );
    expect(assessment.criteria.map((c) => [c.status, c.metBy, c.deliveredBy, c.expectedIn])).toEqual([
      ['met_outside_code', { commentId: '10001', author: 'Dana Lee', createdAt: '2026-03-04T10:00:00.000Z' }, [], null],
      ['met_outside_code', { commentId: '10003', author: 'Someone', createdAt: '2026-03-06T09:00:00.000Z' }, [], null],
    ]);
    // Done: never an item, never posted.
    expect(items).toEqual([]);
  });

  it('no citation, a ref not in the prompt (a cut-off or a bot comment), or a place for the code ⇒ unclear', () => {
    const { assessment } = reconcileTicketReview(
      ticket,
      members,
      {
        alignment: 'aligned',
        criteria: [
          outside({}),
          outside({ text: 'PDF', metByComment: 'C2' }),
          outside({ text: 'Email', metByComment: 'C1', expectedIn: { pr: 'PR1' } }),
        ],
      },
      comments,
    );
    expect(assessment.criteria.map((c) => [c.status, c.metBy ?? null])).toEqual([
      ['unclear', null],
      ['unclear', null],
      ['unclear', null],
    ]);
    // With no comments given at all, nothing outside code survives.
    expect(reconcileTicketReview(ticket, members, { alignment: 'aligned', criteria: [outside({ metByComment: 'C1' })] }).assessment.criteria[0]!.status).toBe(
      'unclear',
    );
  });

  it('a PR named as delivering it makes it a plain met; an unread member never demotes it', () => {
    const { assessment } = reconcileTicketReview(
      ticket,
      [members[0]!, { ...members[1]!, checkedOut: false }],
      { alignment: 'aligned', criteria: [outside({ metByComment: 'C1', deliveredBy: ['PR1'] }), outside({ text: 'PDF', metByComment: 'C1' })] },
      comments,
    );
    expect(assessment.criteria.map((c) => [c.status, c.deliveredBy, c.metBy ?? null])).toEqual([
      ['met', [11], null],
      ['met_outside_code', [], { commentId: '10001', author: 'Dana Lee', createdAt: '2026-03-04T10:00:00.000Z' }],
    ]);
  });
});

// 6. CODE OUTSIDE THE TICKET (outside.ts): a `met` only an outside source delivers stays met, labelled apart
//    (`outside`, from the STORED list); an unread source, or a member delivering it too, never labels it;
//    an `expectedIn` naming an outside repository carries `outsideRepo` and owns no PR.
describe('reconcileTicketReview — code outside the ticket', () => {
  const outside = {
    sources: [
      { ref: 'X1', kind: 'repo' as const, repoId: 7, repo: 'acme/docs', prId: null, number: null, sha: 'd1', read: true },
      { ref: 'X2', kind: 'unlinked_pr' as const, repoId: 8, repo: 'acme/mail', prId: 88, number: 88, sha: 'e1', read: true },
      { ref: 'X3', kind: 'repo' as const, repoId: 9, repo: 'acme/old', prId: null, number: null, sha: null, read: false },
    ],
    leftOut: ['acme/zulu'],
  };
  const report = {
    alignment: 'partly_aligned',
    summary: 'X1 already has it.',
    criteria: [
      { text: 'CSV', status: 'met', explanation: 'In X1.', metOutsideTicket: 'X1' },
      { text: 'PDF', status: 'met', explanation: 'x', metOutsideTicket: '[x2]' },
      { text: 'Email', status: 'met', explanation: 'x', metOutsideTicket: 'X3' },
    ],
    missing: [{ title: 'Docs page', explanation: 'x', expectedIn: { repo: 'ACME/docs' } }],
  };

  it('counts a met only outside code delivers as met, labelled apart, and stores what it read', () => {
    const { assessment, items } = reconcileTicketReview(ticket, members, report, new Map(), outside);
    expect(assessment.criteria.map((c) => [c.status, c.deliveredBy, c.outside?.kind ?? null])).toEqual([
      ['met', [], 'repo'],
      ['met', [], 'unlinked_pr'],
      // X3 could not be read: it delivers nothing, and a met nobody can point at is not a met.
      ['unclear', [], null],
    ]);
    expect(assessment.criteria[1]!.outside).toEqual({ kind: 'unlinked_pr', repoId: 8, repo: 'acme/mail', prId: 88, number: 88 });
    // Prose names the source the way the reader knows it.
    expect(assessment.criteria[0]!.explanation).toBe('In acme/docs.');
    expect(assessment.summary).toBe('acme/docs already has it.');
    expect(assessment.outside).toEqual(outside);
    // The shared count: still met, distinguishable.
    const c = criterionCounts(assessment.criteria);
    expect([c.met, c.metOutsideTicket]).toEqual([2, 2]);
    expect(ticketCriteriaSentence(assessment)).toBe('2 of 3 criteria met, 2 already outside the ticket.');
    expect(criterionOutsideWords(assessment.criteria[0]!.outside!)).toBe('Already in acme/docs (no PR on this ticket)');
    expect(criterionOutsideWords(assessment.criteria[1]!.outside!)).toBe('In mail#88 (same branch, not linked to the ticket)');
    // The missing item belongs in a repository with no PR on the ticket: it owns no PR.
    expect(assessment.missing[0]!.expectedIn).toEqual({ prId: null, repoId: 7, outsideRepo: 'acme/docs' });
    expect(items.find((i) => i.status === 'missing')?.ownerPrId).toBeNull();
  });

  it('a member delivering it too makes it a plain met; no list ⇒ no label and no stored context', () => {
    const both = reconcileTicketReview(ticket, members, {
      alignment: 'aligned',
      criteria: [{ text: 'CSV', status: 'met', deliveredBy: ['PR1'], metOutsideTicket: 'X1' }],
    }, new Map(), outside).assessment;
    expect(both.criteria[0]!.status).toBe('met');
    expect(both.criteria[0]!.outside).toBeUndefined();
    const none = reconcileTicketReview(ticket, members, report).assessment;
    expect(none.criteria.map((c) => c.status)).toEqual(['unclear', 'unclear', 'unclear']);
    expect(none.outside).toBeUndefined();
    expect(none.missing[0]!.expectedIn).toBeNull();
  });

  it('⚠ an expectedIn naming an outside repository never resolves to a PR, and is never a post target', () => {
    const r = reconcileTicketReview(ticket, members, {
      alignment: 'not_aligned',
      criteria: [{ text: 'CSV', status: 'not_met', explanation: 'x', expectedIn: { repo: 'acme/docs' } }],
    }, new Map(), outside);
    const crit = r.assessment.criteria[0]!;
    expect(crit.expectedIn).toEqual({ prId: null, repoId: 7, outsideRepo: 'acme/docs' });
    const raw = r.items[0]!;
    expect(raw.ownerPrId).toBeNull();
    const item = withNoPrIn(
      { id: 1, ticketReviewId: 1, ref: raw.ref, status: raw.status, title: raw.title, body: raw.body, ownerPrId: null, path: null, line: null, priorItemId: null, posted: null },
      r.assessment,
    );
    expect(item.noPrIn).toBe('acme/docs');
    expect(storyGapTarget(item, 11)).toBeNull();
    // An ordinary ownerless item still lands on the PR the reader is viewing.
    expect(storyGapTarget({ ownerPrId: null }, 11)).toBe(11);
  });
});
