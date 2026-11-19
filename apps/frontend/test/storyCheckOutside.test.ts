// CODE OUTSIDE THE TICKET in the SPA (docs/CLAUDE-REVIEW.md § Ticket review → Outside the ticket).
//   1. A criterion met only by code outside the ticket renders as MET, labelled apart ("Already in
//      acme/docs (no PR on this ticket)" / "In mail#88 (same branch, not linked to the ticket)").
//   2. The story check panel's ONE short line: what it also read, what it could not, what it left out.
//   3. Work that belongs in a repository with no PR on the ticket reads "No PR yet in acme/docs" and is
//      in NO "Post N gaps" group (the server agrees: `storyGapTarget`).
//   4. Counts stay honest: still met, named apart.
//   5. Settings → AI review carries the switch, explained behind its ⓘ.
//
// No JSX here (plain `.ts`), so components are instantiated with `createElement`.
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyCheckOutside.test.ts
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TicketAssessment, TicketReview, TicketReviewItem, TicketReviewMember } from '@pierre-review/shared';
import { TicketResults } from '../src/components/TicketReviewParts.js';
import { coverageLabel, expectedInLabel, outsideReadLine, storyGapGroups } from '../src/lib/ticketReview.js';
import { ticketCardCriteria } from '../src/lib/laneBoard.js';

const members: TicketReviewMember[] = [
  { prId: 1, repoId: 10, repo: 'acme/web', number: 412, title: null, headSha: 'abc', state: 'open', checkedOut: true },
];
const outside: NonNullable<TicketAssessment['outside']> = {
  sources: [
    { ref: 'X1', kind: 'repo', repoId: 70, repo: 'acme/docs', prId: null, number: null, sha: 'd1', read: true },
    { ref: 'X2', kind: 'repo', repoId: 71, repo: 'acme/lib', prId: null, number: null, sha: 'd2', read: true },
    { ref: 'X3', kind: 'unlinked_pr', repoId: 80, repo: 'acme/mail', prId: 88, number: 88, sha: 'e1', read: true },
    { ref: 'X4', kind: 'repo', repoId: 72, repo: 'acme/old', prId: null, number: null, sha: null, read: false },
  ],
  leftOut: ['acme/zeta', 'acme/zulu'],
};
const assessment: TicketAssessment = {
  alignment: 'partly_aligned',
  summary: null,
  criteria: [
    { ref: 'AC1', index: 0, text: 'CSV', status: 'met', explanation: null, deliveredBy: [], evidence: [], expectedIn: null, outside: { kind: 'repo', repoId: 70, repo: 'acme/docs', prId: null, number: null } },
    { ref: 'AC2', index: 1, text: 'PDF', status: 'met', explanation: null, deliveredBy: [], evidence: [], expectedIn: null, outside: { kind: 'unlinked_pr', repoId: 80, repo: 'acme/mail', prId: 88, number: 88 } },
    { ref: 'AC3', index: 2, text: 'Mail', status: 'met', explanation: null, deliveredBy: [1], evidence: [], expectedIn: null },
    { ref: 'AC4', index: 3, text: 'Docs', status: 'not_met', explanation: 'x', deliveredBy: [], evidence: [], expectedIn: { prId: null, repoId: 70, outsideRepo: 'acme/docs' } },
  ],
  missing: [{ ref: 'M1', title: 'Help page', explanation: 'x', expectedIn: { prId: null, repoId: 70, outsideRepo: 'acme/docs' } }],
  notRequested: [],
  outside,
};
const item = (over: Partial<TicketReviewItem>): TicketReviewItem => ({
  id: 1,
  ticketReviewId: 5,
  ref: 'AC4',
  status: 'not_met',
  title: 'Docs',
  body: 'x',
  ownerPrId: null,
  path: null,
  line: null,
  priorItemId: null,
  posted: null,
  ...over,
});
const review = {
  id: 5,
  ident: 'jira:x#PAY-1',
  ticketKey: 'PAY-1',
  ticketTitle: null,
  ticket: null,
  workspaceId: 1,
  originPrId: 1,
  trigger: 'manual',
  status: 'succeeded',
  model: 'm',
  costUsd: null,
  error: null,
  refused: null,
  createdAt: '2026-11-19T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
  alignment: 'partly_aligned',
  summary: null,
  assessment,
  members,
  items: [item({ noPrIn: 'acme/docs' }), item({ id: 2, ref: 'M1', status: 'missing', title: 'Help page', noPrIn: 'acme/docs' }), item({ id: 3, ref: 'AC9' })],
} as TicketReview;

describe('code outside the ticket', () => {
  it('renders a met only outside code delivers as met, labelled apart, and the one short line', () => {
    const html = renderToStaticMarkup(createElement(TicketResults, { review, viewedPrId: null }));
    expect(html).toContain('Already in acme/docs (no PR on this ticket)');
    expect(html).toContain('In mail#88 (same branch, not linked to the ticket)');
    expect(html).toContain('No PR yet in acme/docs');
    expect(html).toContain('data-testid="story-check-outside"');
    // The plain met (a PR delivers it) carries no outside label.
    expect(html.match(/data-testid="criterion-outside"/g)).toHaveLength(2);
  });

  it('says what it read, could not read and left out, in one line', () => {
    expect(outsideReadLine(outside)).toBe(
      'Also read 2 other repositories and mail#88 (same branch, not linked to the ticket). Could not read acme/old. Left out: acme/zeta, acme/zulu.',
    );
    expect(outsideReadLine({ sources: [], leftOut: [] })).toBeNull();
    expect(outsideReadLine(undefined)).toBeNull();
  });

  it('an outside repository is "No PR yet", and never a post target', () => {
    expect(expectedInLabel({ prId: null, repoId: 70, outsideRepo: 'acme/docs' }, members)).toBe('No PR yet in acme/docs');
    expect(expectedInLabel({ prId: null, repoId: 10 }, members)).toBe('Belongs in web');
    const groups = storyGapGroups(review, 1);
    expect(groups.flatMap((g) => g.itemIds)).toEqual([3]);
  });

  it('a related repository with an unlinked same-branch PR names that PR, never "No PR yet"', () => {
    expect(expectedInLabel({ prId: null, repoId: 80, outsideRepo: 'acme/mail', outsideUnlinkedPr: { prId: 88, number: 88 } }, members)).toBe(
      'acme/mail#88 is on the same branch but not linked to the ticket',
    );
    const r = { ...review, items: [item({ ref: 'M1', status: 'missing', title: 'Mail page', noPrIn: 'acme/mail', noPrUnlinked: { prId: 88, number: 88 } })] } as TicketReview;
    const html = renderToStaticMarkup(createElement(TicketResults, { review: r, viewedPrId: null }));
    expect(html).toContain('acme/mail#88 is on the same branch but not linked to the ticket');
    expect(html).not.toContain('No PR yet in acme/mail');
    expect(storyGapGroups(r, 1)).toEqual([]);
  });

  it('the AI Fix rounds say when a criterion is met only in an unlinked PR', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/components/AiFix/FixLoopSection.tsx', import.meta.url)), 'utf8');
    expect(src).toContain("c.status === 'met_unlinked'");
    expect(src).toContain('Only in a pull request on the same branch that is not linked to the ticket');
  });

  it('keeps every count honest: met, and named apart', () => {
    const counts = { met: 3, metOutsideTicket: 2, partlyMet: 0, notMet: 1, unclear: 0, notChecked: 0, total: 4 };
    expect(coverageLabel(counts)).toBe('3 of 4 met, 2 already outside the ticket');
    expect(coverageLabel({ ...counts, metOutsideTicket: 0 })).toBe('3 of 4 met');
    const card = ticketCardCriteria({
      brief: { criteriaCount: 4 },
      check: { met: 3, metOutsideTicket: 2, partlyMet: 0, notMet: 1, unsettled: 0, total: 4, stale: false },
      checkRunning: false,
    } as unknown as Parameters<typeof ticketCardCriteria>[0]);
    expect(card?.text).toBe('3 of 4 criteria met, 2 already outside the ticket');
  });

  it('Settings → AI review has the switch, with its ⓘ', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/components/settings/AutoReviewSection.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('Story checks read every repository');
    expect(src).toContain('<InfoButton title="Story checks read every repository">');
    expect(src).toContain('storyCheckAllRepos: allRepos');
  });
});
