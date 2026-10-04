// THE OPEN PRs TICKET STACKS — the pure half (lib/openPrsStacks.ts): which stack a PR sits in, how a
// PR naming two tickets is shown twice but counted once, where "No ticket" goes, the order of the
// stacks (fixed) and of the PRs inside one (the caller's Sort menu order, untouched).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/openPrsStacks.test.ts
import { describe, expect, it } from 'vitest';
import type { ClaudeReviewPrState, TicketMergedPr, TimelinePr, User } from '@pierre-review/shared';
import type { CardTicket } from '../src/lib/cardTickets.js';
import { pickSort, sortOpenPrs } from '../src/lib/openPrsSort.js';
import {
  NO_TICKET_STACK_ID,
  initialsOf,
  mergedByStack,
  mergedPanelKeys,
  prCountLabel,
  stackDomId,
  stackOpenPrs,
  stackRollup,
  stackRollupParts,
  stacksWorthShowing,
} from '../src/lib/openPrsStacks.js';

const pr = (over: Partial<TimelinePr>): TimelinePr =>
  ({
    id: 1,
    repoId: 1,
    number: 1,
    title: 't',
    authorId: null,
    state: 'open',
    isDraft: false,
    openedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    threadCounts: { resolved: 0, likely_addressed: 0, replied_unresolved: 0, untouched: 0 },
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    ciStatus: 'success',
    isApproved: false,
    isChangesRequested: false,
    mergeable: 'mergeable',
    mergeStateStatus: 'blocked',
    ...over,
  }) as TimelinePr;

const tk = (key: string, over: Partial<CardTicket> = {}): CardTicket => ({
  key,
  title: `${key} title`,
  url: `https://acme.atlassian.net/browse/${key}`,
  ...over,
});

const day = (d: number): string => `2026-09-${String(d).padStart(2, '0')}T00:00:00.000Z`;

/** ticketsOf over a fixed map. */
const by = (m: Record<number, CardTicket[]>) => (p: TimelinePr) => m[p.id] ?? [];

const ids = (s: ReturnType<typeof stackOpenPrs>) =>
  s.stacks.map((st) => [st.ticket?.key ?? 'none', st.rows.map((r) => r.pr.id)]);

describe('grouping', () => {
  it('one stack per ticket, PRs beneath it, the no-ticket PRs in a final group', () => {
    const prs = [pr({ id: 1, updatedAt: day(5) }), pr({ id: 2, updatedAt: day(4) }), pr({ id: 3, updatedAt: day(3) })];
    const out = stackOpenPrs(prs, by({ 1: [tk('BMD-1')], 2: [tk('BMD-1')] }));
    expect(ids(out)).toEqual([
      ['BMD-1', [1, 2]],
      ['none', [3]],
    ]);
    expect(out.stacks.at(-1)?.id).toBe(NO_TICKET_STACK_ID);
    expect(out.prCount).toBe(3);
    expect(out.ticketedPrCount).toBe(2);
  });

  it('no no-ticket group when every PR names a ticket', () => {
    const out = stackOpenPrs([pr({ id: 1 })], by({ 1: [tk('BMD-1')] }));
    expect(out.stacks.map((s) => s.id)).toEqual(['ticket:BMD-1']);
  });

  it('nothing names a ticket → not worth grouping (the caller draws the list)', () => {
    const out = stackOpenPrs([pr({ id: 1 }), pr({ id: 2 })], by({}));
    expect(stacksWorthShowing(out)).toBe(false);
    expect(stacksWorthShowing(stackOpenPrs([pr({ id: 1 })], by({ 1: [tk('A-1')] })))).toBe(true);
  });

  it('a duplicated input row is still one PR', () => {
    const out = stackOpenPrs([pr({ id: 1 }), pr({ id: 1 })], by({ 1: [tk('A-1')] }));
    expect(ids(out)).toEqual([['A-1', [1]]]);
    expect(out.prCount).toBe(1);
  });
});

describe('a PR naming two tickets', () => {
  const prs = [pr({ id: 1, updatedAt: day(9) }), pr({ id: 2, updatedAt: day(5) })];
  const out = stackOpenPrs(prs, by({ 1: [tk('BMD-1040'), tk('BMD-1043')], 2: [tk('BMD-1043')] }));

  it('sits in BOTH stacks', () => {
    expect(ids(out)).toEqual([
      ['BMD-1040', [1]],
      ['BMD-1043', [1, 2]],
    ]);
  });

  it('each copy names the OTHER ticket, and only it', () => {
    const in1040 = out.stacks[0]!.rows[0]!;
    const in1043 = out.stacks[1]!.rows[0]!;
    expect(in1040.alsoIn.map((t) => t.key)).toEqual(['BMD-1043']);
    expect(in1043.alsoIn.map((t) => t.key)).toEqual(['BMD-1040']);
    expect(out.stacks[1]!.rows[1]!.alsoIn).toEqual([]);
  });

  it('the page total counts it once', () => {
    expect(out.prCount).toBe(2);
    expect(out.stacks.reduce((n, s) => n + s.rows.length, 0)).toBe(3);
  });

  it('the same key twice on one PR (any case) is one stack, one row', () => {
    const o = stackOpenPrs([pr({ id: 1 })], by({ 1: [tk('BMD-7'), tk('bmd-7')] }));
    expect(ids(o)).toEqual([['BMD-7', [1]]]);
    expect(o.stacks[0]!.rows[0]!.alsoIn).toEqual([]);
  });
});

describe('the ticket details', () => {
  it('first PR wins each field, a later PR fills a gap', () => {
    const out = stackOpenPrs(
      [pr({ id: 1 }), pr({ id: 2 })],
      by({
        1: [tk('A-1', { title: null, status: 'In Review', statusCategory: 'indeterminate' })],
        2: [tk('A-1', { title: 'From PR 2', status: 'Done', statusCategory: 'done', assignee: { name: 'Ann Lee' } })],
      }),
    );
    const t = out.stacks[0]!.ticket!;
    expect(t.title).toBe('From PR 2');
    expect(t.status).toBe('In Review');
    expect(t.statusCategory).toBe('indeterminate');
    expect(t.assignee?.name).toBe('Ann Lee');
  });

  it('does not mutate the caller’s ticket objects', () => {
    const shared = tk('A-1', { title: null });
    stackOpenPrs([pr({ id: 1 }), pr({ id: 2 })], by({ 1: [shared], 2: [tk('A-1', { title: 'x' })] }));
    expect(shared.title).toBeNull();
  });
});

describe('stack order — fixed, the Sort menu does not move stacks', () => {
  it('latest PR activity first; done tickets last; No ticket after everything', () => {
    const prs = [
      pr({ id: 1, updatedAt: day(1) }),
      pr({ id: 2, updatedAt: day(20) }),
      pr({ id: 3, updatedAt: day(10) }),
      pr({ id: 4, updatedAt: day(30) }),
      pr({ id: 5, updatedAt: day(25) }),
    ];
    const out = stackOpenPrs(
      prs,
      by({
        1: [tk('OLD-1')],
        2: [tk('NEW-1')],
        3: [tk('MID-1')],
        4: [tk('DONE-1', { statusCategory: 'done' })],
        // 5 has no ticket and is the second-latest PR: still last.
      }),
    );
    expect(out.stacks.map((s) => s.ticket?.key ?? 'none')).toEqual(['NEW-1', 'MID-1', 'OLD-1', 'DONE-1', 'none']);
  });

  it('a stack’s activity is its LATEST PR, not its first', () => {
    const out = stackOpenPrs(
      [pr({ id: 1, updatedAt: day(2) }), pr({ id: 2, updatedAt: day(3) }), pr({ id: 3, updatedAt: day(9) })],
      by({ 1: [tk('A-1')], 2: [tk('B-1')], 3: [tk('A-1')] }),
    );
    expect(out.stacks.map((s) => s.ticket?.key)).toEqual(['A-1', 'B-1']);
    expect(out.stacks[0]!.latestActivity).toBe(day(9));
  });

  it('unknown status is open, never done', () => {
    const out = stackOpenPrs(
      [pr({ id: 1, updatedAt: day(1) }), pr({ id: 2, updatedAt: day(5) })],
      by({ 1: [tk('A-1')], 2: [tk('B-1', { statusCategory: 'done' })] }),
    );
    expect(out.stacks.map((s) => s.ticket?.key)).toEqual(['A-1', 'B-1']);
  });

  it('ties break on the key, numerically', () => {
    const out = stackOpenPrs(
      [pr({ id: 1 }), pr({ id: 2 }), pr({ id: 3 })],
      by({ 1: [tk('BMD-10')], 2: [tk('BMD-9')], 3: [tk('ABC-1')] }),
    );
    expect(out.stacks.map((s) => s.ticket?.key)).toEqual(['ABC-1', 'BMD-9', 'BMD-10']);
  });
});

describe('within a stack — the Sort menu’s order, untouched', () => {
  it('keeps the order the PRs arrive in', () => {
    const prs = [
      pr({ id: 1, number: 10, additions: 5 }),
      pr({ id: 2, number: 11, additions: 500 }),
      pr({ id: 3, number: 12, additions: 50 }),
    ];
    const ctx = {
      usersById: new Map<number, User>(),
      repoNameById: new Map<number, string>(),
      claudeStates: new Map<number, ClaudeReviewPrState>(),
    };
    const sorted = sortOpenPrs(prs, pickSort('loc'), ctx); // largest first
    const out = stackOpenPrs(sorted, by({ 1: [tk('A-1')], 2: [tk('A-1')], 3: [tk('A-1')] }));
    expect(out.stacks[0]!.rows.map((r) => r.pr.id)).toEqual([2, 3, 1]);
  });
});

describe('the header bits', () => {
  it('counts', () => {
    expect(prCountLabel(1)).toBe('1 PR');
    expect(prCountLabel(3)).toBe('3 PRs');
  });

  it('roll-up says only what is non-zero, most pressing first', () => {
    const rows = [
      pr({ id: 1, ciStatus: 'failure' }),
      pr({ id: 2, isChangesRequested: true }),
      pr({ id: 3, mergeStateStatus: 'clean' }),
      pr({ id: 4, mergeStateStatus: 'clean', isDraft: true }),
    ].map((p) => ({ pr: p, alsoIn: [] }));
    const r = stackRollup(rows);
    expect(r).toEqual({ ciFailing: 1, changesRequested: 1, readyToMerge: 1 });
    expect(stackRollupParts(r).map((p) => p.text)).toEqual(['1 failing CI', '1 changes requested', '1 ready to merge']);
    expect(stackRollupParts({ ciFailing: 0, changesRequested: 0, readyToMerge: 0 })).toEqual([]);
  });

  it('initials, because the CSP blocks Jira avatars', () => {
    expect(initialsOf('david buckley')).toBe('DB');
    expect(initialsOf('Alex  de  Wakeman')).toBe('AW');
    expect(initialsOf('Cher')).toBe('CH');
    expect(initialsOf('  ')).toBe('?');
  });

  it('a DOM id safe for any key', () => {
    expect(stackDomId('ticket:BMD-1040')).toBe('open-prs-stack-ticket-BMD-1040');
    expect(stackDomId(NO_TICKET_STACK_ID)).toBe('open-prs-stack-none');
  });
});

describe('the "Merged (n)" panel', () => {
  const ACME = 'https://acme.atlassian.net';
  const m = (prId: number, mergedAt: string): TicketMergedPr => ({
    prId,
    repoId: 1,
    repoFullName: 'acme/engine',
    number: prId,
    title: `merged ${prId}`,
    authorLogin: 'ada',
    authorDisplayName: null,
    authorAvatarUrl: null,
    mergedAt,
  });
  const stacked = stackOpenPrs([pr({ id: 1 }), pr({ id: 2 }), pr({ id: 3 })], by({
    1: [tk('ENG-7', { ident: `jira:${ACME}#ENG-7` })],
    2: [tk('ENG-8', { ident: `jira:${ACME}#ENG-8` })],
  }));

  it('asks once per ticket stack, never for the no-ticket stack', () => {
    expect(mergedPanelKeys(stacked.stacks)).toEqual(['ENG-7', 'ENG-8']);
  });

  it('attaches each ticket’s merged PRs to its stack, newest first; an open card wins over its merged copy', () => {
    const map = mergedByStack(stacked.stacks, {
      workspaceId: 1,
      tickets: [
        { key: 'ENG-7', ident: `jira:${ACME}#ENG-7`, prs: [m(10, day(3)), m(11, day(9)), m(1, day(5)), m(11, day(9))] },
        { key: 'ENG-9', ident: `jira:${ACME}#ENG-9`, prs: [m(12, day(1))] },
      ],
    });
    expect([...map.keys()]).toEqual(['ticket:ENG-7']);
    expect(map.get('ticket:ENG-7')?.map((p) => p.prId)).toEqual([11, 10]);
  });

  it('a ticket with only merged PRs makes no stack; the open count is untouched', () => {
    const map = mergedByStack(stacked.stacks, {
      workspaceId: 1,
      tickets: [{ key: 'ENG-9', ident: `jira:${ACME}#ENG-9`, prs: [m(12, day(1))] }],
    });
    expect(map.size).toBe(0);
    expect(stacked.stacks.map((st) => st.ticket?.key ?? 'none')).toEqual(['ENG-7', 'ENG-8', 'none']);
    expect(stacked.prCount).toBe(3);
  });

  it('a same-key ticket on another Jira site is not shown under this one', () => {
    const map = mergedByStack(stacked.stacks, {
      workspaceId: 1,
      tickets: [{ key: 'ENG-8', ident: 'jira:https://other.atlassian.net#ENG-8', prs: [m(13, day(2))] }],
    });
    expect(map.size).toBe(0);
  });

  it('no answer yet → nothing', () => {
    expect(mergedByStack(stacked.stacks, undefined).size).toBe(0);
  });
});
