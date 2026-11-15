// THE CRITERIA MAP — the shared pure fold (packages/shared/src/criteria-map.ts). What this pins:
//   1. A card line links to the criterion it names: same text, clear word overlap, or a lone ref.
//   2. A tie or a weak overlap is NO link (kept on the PR as unmatched) — never a guess.
//   3. Unknown is never zero: a criterion no card claims is a row with no links; a PR with no
//      current card is listed with `hasCard: false`; counts say both.
//   4. Status is the story check's alone (`done` = criterionDone), whatever the cards say.
//   5. Two lines of one card on one criterion are ONE link (files merged, no repeats).
//
//   pnpm --filter @pierre-review/backend test ticket-review/criteria-map
import { describe, expect, it } from 'vitest';
import { criteriaMap, criteriaMapOffered, matchCardCriterion, type CriteriaMapMemberIn } from '@pierre-review/shared';

const CRITERIA = [
  { ref: 'AC1', text: 'A sign-in link is emailed to the address entered', status: 'met' },
  { ref: 'AC2', text: 'The link expires after 15 minutes', status: 'not_met' },
  { ref: 'AC3', text: 'Requests for a link are rate limited per address', status: 'met_outside_code' },
];

const member = (prId: number, card: CriteriaMapMemberIn['card'], extra: Partial<CriteriaMapMemberIn> = {}): CriteriaMapMemberIn => ({
  prId,
  repo: 'acme/api',
  number: prId,
  title: `PR ${prId}`,
  state: 'open',
  card,
  ...extra,
});

describe('matchCardCriterion', () => {
  it('matches the same text, refs and punctuation aside', () => {
    expect(matchCardCriterion('AC2: The link expires after 15 minutes.', CRITERIA)).toBe(1);
  });

  it('matches a clear word overlap', () => {
    expect(matchCardCriterion('sign-in link emailed', CRITERIA)).toBe(0);
    expect(matchCardCriterion('link expiry after 15 minutes', CRITERIA)).toBe(1);
  });

  it('falls back to a lone leading ref', () => {
    expect(matchCardCriterion('AC3', CRITERIA)).toBe(2);
    expect(matchCardCriterion('ac 2', CRITERIA)).toBe(1);
  });

  it('refuses a tie, a weak overlap, an unknown ref and a combined ref', () => {
    // "link" alone is shared with all three, and one shared word is not enough.
    expect(matchCardCriterion('link', CRITERIA)).toBeNull();
    expect(matchCardCriterion('Adds a dark theme', CRITERIA)).toBeNull();
    expect(matchCardCriterion('AC9', CRITERIA)).toBeNull();
    expect(matchCardCriterion('AC1/AC2', CRITERIA)).toBeNull();
    const twins = [
      { ref: 'AC1', text: 'export report csv', status: 'met' },
      { ref: 'AC2', text: 'export report pdf', status: 'met' },
    ];
    expect(matchCardCriterion('export report', twins)).toBeNull();
  });
});

describe('criteriaMap', () => {
  it('links each claimed criterion to its PRs, and keeps the unclaimed and the card-less', () => {
    const map = criteriaMap(CRITERIA, [
      member(1, {
        criteria: [
          { criterion: 'Sign-in link is emailed', how: 'Adds POST /magic-link, which emails the link.', files: ['src/link.ts'] },
          { criterion: 'AC1', how: 'Templates the email.', files: ['src/link.ts', 'src/mail.ts'] },
          { criterion: 'Adds an audit log', how: 'Logs each request.', files: [] },
        ],
      }),
      member(2, { criteria: [{ criterion: 'A sign-in link is emailed to the address entered', how: 'Shows the form.', files: ['web/Form.tsx'] }] }, { repo: 'acme/web' }),
      // Pushed since its card: the server sends no card.
      member(3, null),
    ]);
    expect(map.rows.map((r) => r.links.map((l) => l.prId))).toEqual([[1, 2], [], []]);
    // Two lines of PR 1 on AC1 are one link: words joined, files merged without repeats.
    expect(map.rows[0]!.links[0]).toEqual({
      prId: 1,
      how: 'Adds POST /magic-link, which emails the link. Templates the email.',
      files: ['src/link.ts', 'src/mail.ts'],
    });
    expect(map.prs.map((p) => [p.prId, p.hasCard, p.linkCount])).toEqual([
      [1, true, 1],
      [2, true, 1],
      [3, false, 0],
    ]);
    expect(map.prs[0]!.unmatched.map((u) => u.criterion)).toEqual(['Adds an audit log']);
    expect(map.links).toBe(2);
    expect(map.unclaimed).toBe(2);
    expect(map.withoutCard).toBe(1);
  });

  it("takes status from the story check alone", () => {
    const map = criteriaMap(CRITERIA, [member(1, { criteria: [{ criterion: 'AC2', how: 'Sets a 15 minute expiry.', files: [] }] })]);
    // A card claims AC2, the check says not met: it stays not met (and linked).
    expect(map.rows[1]).toMatchObject({ status: 'not_met', done: false });
    expect(map.rows[1]!.links).toHaveLength(1);
    // Met outside code changes is done, with no PR link.
    expect(map.rows[2]).toMatchObject({ done: true, links: [] });
  });

  it('is offered only for a check with criteria and members', () => {
    expect(criteriaMapOffered(criteriaMap(CRITERIA, []))).toBe(false);
    expect(criteriaMapOffered(criteriaMap([], [member(1, null)]))).toBe(false);
    expect(criteriaMapOffered(criteriaMap(CRITERIA, [member(1, null)]))).toBe(true);
  });

  it('does not mutate its input', () => {
    const files = ['a.ts'];
    const members = [member(1, { criteria: [{ criterion: 'AC1', how: 'x', files }] })];
    const map = criteriaMap(CRITERIA, members);
    map.rows[0]!.links[0]!.files.push('b.ts');
    expect(files).toEqual(['a.ts']);
  });
});
