// The ticket review's server reconcile (reconcile.ts) — pure, no DB. What this pins:
//   1. `deliveredBy` and `evidence` keep ONLY member refs; a `met` left with nobody to point at is
//      demoted to `unclear`; evidence alone fills `deliveredBy`.
//   2. ⚠ While any member could not be checked out, no criterion is `not_met` — it reads `unclear` —
//      and no missing item is postable.
//   3. Unreported ⇒ `not_checked`; unknown statuses and empty texts are dropped and refs renumber.
//   4. Items: every not_met / partly_met criterion and every missing item, owned by the member
//      Claude named in `expectedIn` (else null), with a path only when a member owns it.
//
//   pnpm --filter @pierre-review/backend test ticket-review/reconcile
import { describe, expect, it } from 'vitest';
import { namePrRefs, reconcileTicketReview, type ReconcileMember } from './reconcile.js';

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
