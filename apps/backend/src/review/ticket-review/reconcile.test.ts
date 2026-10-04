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
