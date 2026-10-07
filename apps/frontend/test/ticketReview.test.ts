// THE TICKET REVIEW in the SPA — the pure half (lib/ticketReview.ts) and its wiring.
//
//   1. IDENTS: a detected Jira link folds to the SAME api root the plugin stores; Linear has none.
//   2. CURRENCY: the server's verdict in a few words; the client never decides it.
//   3. ATTRIBUTION + POSTING: "Done in web#412", where an item is posted, and that a posted item
//      never offers Post again.
//   4. STARTING: a pasted story re-sends its text; a known Jira story goes by ident.
//   5. THE WIRING: one batched states request, gated on AI and the tracker; the PR review's Run
//      button no longer gates on a story.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/ticketReview.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TICKET_REVIEW_MAX_PRS, type TicketReviewItem, type TicketReviewMember, type TicketReviewState } from '@pierre-review/shared';
import {
  TICKET_PR_CARD_CHANGE_LABEL,
  TICKET_PR_CARD_KIND_LABEL,
  cardHasDetail,
  cardTicketPills,
  membersWithCards,
  coverageLabel,
  coverageTone,
  deliveredByLabel,
  expectedInLabel,
  jiraApiRootOf,
  memberLabel,
  memberPrIdsOf,
  planStoryStart,
  postButtonLabel,
  postTargetOf,
  postedLabel,
  recheckBody,
  refusalSentence,
  statesRequestIdents,
  ticketCoverage,
  ticketCurrency,
  ticketIdentOf,
  ticketProgressPct,
} from '../src/lib/ticketReview.js';

const member = (prId: number, repo: string, number: number, over: Partial<TicketReviewMember> = {}): TicketReviewMember => ({
  prId,
  repoId: prId * 10,
  repo,
  number,
  title: null,
  headSha: 'abc',
  state: 'open',
  checkedOut: true,
  ...over,
});
const MEMBERS = [member(1, 'acme/web', 412), member(2, 'acme/api', 88)];

const state = (over: Partial<TicketReviewState> = {}): TicketReviewState => ({
  ident: 'jira:https://acme.atlassian.net#BMD-1',
  status: 'current',
  staleBecause: [],
  changedPrIds: [],
  latestRunId: 5,
  runningRunId: null,
  alignment: 'partly_aligned',
  counts: { met: 4, partlyMet: 1, notMet: 1, unclear: 0, notChecked: 0, total: 6 },
  memberCount: 2,
  checkedAt: '2026-10-01T00:00:00Z',
  ...over,
});

const item = (over: Partial<TicketReviewItem> = {}): TicketReviewItem => ({
  id: 9,
  ticketReviewId: 5,
  ref: 'AC3',
  status: 'not_met',
  title: 'Export as CSV',
  body: '',
  ownerPrId: null,
  path: null,
  line: null,
  priorItemId: null,
  posted: null,
  ...over,
});

describe('idents', () => {
  it('a Jira browse link folds to the plugin api root (path kept up to /browse)', () => {
    expect(jiraApiRootOf('https://acme.atlassian.net/browse/BMD-1')).toBe('https://acme.atlassian.net');
    expect(jiraApiRootOf('https://jira.example.com/jira/browse/X-1')).toBe('https://jira.example.com/jira');
    expect(jiraApiRootOf('javascript:alert(1)')).toBeNull();
    expect(jiraApiRootOf('not a url')).toBeNull();
  });

  it('builds jira:<root>#<KEY> and linear:<root>#<KEY>; a link-less ticket has none', () => {
    expect(ticketIdentOf({ key: 'bmd-1', url: 'https://acme.atlassian.net/browse/BMD-1', provider: 'jira' })).toBe(
      'jira:https://acme.atlassian.net#BMD-1',
    );
    expect(ticketIdentOf({ key: 'ENG-1', url: 'https://linear.app/a/issue/ENG-1', provider: 'linear' })).toBe(
      'linear:https://linear.app/a#ENG-1',
    );
    expect(ticketIdentOf({ key: 'BMD-1', url: null })).toBeNull();
  });

  it('the states request is de-duplicated, sorted and blank-free', () => {
    expect(statesRequestIdents(['b', 'a', null, 'b', undefined, ''])).toEqual(['a', 'b']);
  });
});

describe('currency', () => {
  it('current names how many PRs; none says nothing', () => {
    expect(ticketCurrency(state())?.label).toBe('Checked against 2 PRs');
    expect(ticketCurrency(state({ memberCount: 1 }))?.label).toBe('Checked against 1 PR');
    expect(ticketCurrency(state({ status: 'none' }))).toBeNull();
    expect(ticketCurrency(state({ status: 'running' }))?.tone).toBe('running');
  });

  it('stale names the PR that moved when it can, else counts', () => {
    const labelOf = (id: number) => (id === 1 ? 'web#412' : null);
    expect(ticketCurrency(state({ status: 'stale', staleBecause: ['pr_pushed'], changedPrIds: [1] }), labelOf)?.label).toBe(
      'web#412 pushed since',
    );
    expect(ticketCurrency(state({ status: 'stale', staleBecause: ['pr_added'], changedPrIds: [7] }), labelOf)?.label).toBe(
      'PR added',
    );
    expect(
      ticketCurrency(state({ status: 'stale', staleBecause: ['pr_pushed', 'pr_merged'], changedPrIds: [1, 2] }), labelOf)
        ?.label,
    ).toBe('2 PRs changed since');
    expect(ticketCurrency(state({ status: 'stale', staleBecause: ['story_edited', 'pr_pushed'], changedPrIds: [1] }))?.label).toBe(
      'Story edited since',
    );
  });

  it('coverage is "met of total", toned by the worst', () => {
    expect(coverageLabel(state().counts)).toBe('4 of 6 met');
    expect(coverageLabel(null)).toBeNull();
    expect(coverageTone(state().counts)).toBe('bad');
    expect(coverageTone({ met: 2, partlyMet: 0, notMet: 0, unclear: 0, notChecked: 0, total: 2 })).toBe('ok');
    expect(coverageTone({ met: 1, partlyMet: 1, notMet: 0, unclear: 0, notChecked: 0, total: 2 })).toBe('partial');
  });

  it('a compact reading exists only once something is known', () => {
    expect(ticketCoverage(undefined)).toBeNull();
    expect(ticketCoverage(state({ status: 'none', counts: null }))).toBeNull();
    expect(ticketCoverage(state({ status: 'stale', staleBecause: ['pr_pushed'], changedPrIds: [1] }))).toMatchObject({
      label: '4 of 6 met',
      stale: true,
    });
    expect(ticketCoverage(state({ status: 'running', counts: null }))).toMatchObject({ label: 'Checking…', running: true });
  });

  it('card pills skip the stack’s own ticket and tickets with no reading', () => {
    const states = new Map([[state().ident, state()]]);
    const pills = cardTicketPills(
      [
        { key: 'BMD-1', ident: state().ident },
        { key: 'BMD-2', ident: 'jira:https://acme.atlassian.net#BMD-2' },
        { key: 'ENG-1' },
      ],
      states,
    );
    expect(pills.map((p) => [p.key, p.label])).toEqual([['BMD-1', '4 of 6 met']]);
    expect(cardTicketPills([{ key: 'BMD-1', ident: state().ident }], states, 'BMD-1')).toEqual([]);
  });
});

describe('attribution and posting', () => {
  it('labels a member by repo name and number', () => {
    expect(memberLabel(MEMBERS[0]!)).toBe('web#412');
  });

  it('"Done in" lists only member PRs', () => {
    expect(deliveredByLabel({ deliveredBy: [1, 2] }, MEMBERS)).toBe('Done in web#412 and api#88');
    expect(deliveredByLabel({ deliveredBy: [99] }, MEMBERS)).toBeNull();
  });

  it('"Belongs in" a member PR, or a member repo with no PR yet', () => {
    expect(expectedInLabel({ prId: 2, repoId: null }, MEMBERS)).toBe('Belongs in api#88');
    expect(expectedInLabel({ prId: null, repoId: 10 }, MEMBERS)).toBe('Belongs in web');
    expect(expectedInLabel({ prId: null, repoId: 999 }, MEMBERS)).toBeNull();
    expect(expectedInLabel(null, MEMBERS)).toBeNull();
  });

  it('posts on the owner PR, else the viewed one', () => {
    expect(postTargetOf(item(), 1, MEMBERS)).toEqual({ prId: 1, label: null });
    const t = postTargetOf(item({ ownerPrId: 2 }), 1, MEMBERS);
    expect(t).toEqual({ prId: 2, label: 'api#88' });
    expect(postButtonLabel(t, 1)).toBe('Post on api#88');
    expect(postButtonLabel({ prId: 1, label: null }, 1)).toBe('Post');
  });

  it('a posted item (its own or inherited) says so — there is no Post to offer again', () => {
    expect(postedLabel(item(), MEMBERS, 1)).toBeNull();
    const posted = { prId: 2, commentId: '1', postedAt: '2026-10-01T00:00:00Z', carried: false };
    expect(postedLabel(item({ posted }), MEMBERS, 1)).toBe('Posted on api#88');
    expect(postedLabel(item({ posted: { ...posted, prId: 1, carried: true } }), MEMBERS, 1)).toBe(
      'Posted on an earlier check',
    );
  });

  it('refusals are one sentence with the count', () => {
    // The cap is read from the shared constant (TICKET_REVIEW_MAX_PRS = 30), never retyped.
    expect(TICKET_REVIEW_MAX_PRS).toBe(30);
    expect(refusalSentence({ reason: 'too_many_prs', prCount: 40 })).toBe(
      '40 PRs name this ticket. One check covers at most 30.',
    );
    expect(refusalSentence({ reason: 'no_members', prCount: null })).toMatch(/No open or merged PR/);
  });
});

describe('starting', () => {
  it('a pasted story re-sends its stored text; a Jira ticket goes by ident', () => {
    const manual = 'manual:7:0123abcd';
    expect(recheckBody(7, manual, { ticket: { title: 'T', description: null, acceptanceCriteria: '- a' } })).toEqual({
      prId: 7,
      tickets: [{ title: 'T', acceptanceCriteria: '- a' }],
    });
    expect(recheckBody(7, 'jira:https://x#A-1', null)).toEqual({ prId: 7, ident: 'jira:https://x#A-1' });
  });

  it('the story panel sends a known Jira story by ident and the rest pasted', () => {
    const plan = planStoryStart(
      [
        { title: 'Jira one', source: 'jira', key: 'bmd-1' },
        { title: 'Typed' },
        { title: 'Unknown Jira', source: 'jira', key: 'BMD-9' },
      ],
      [{ ident: 'jira:https://acme.atlassian.net#BMD-1', ticketKey: 'BMD-1' }],
    );
    expect(plan.idents).toEqual(['jira:https://acme.atlassian.net#BMD-1']);
    expect(plan.pasted.map((t) => t.title)).toEqual(['Typed', 'Unknown Jira']);
  });

  it('progress and the members `done` refreshes', () => {
    expect(ticketProgressPct(null)).toBeNull();
    expect(ticketProgressPct({ phase: 'reviewing', recentActivity: ['a', 'b'] })).toBe(46);
    expect(memberPrIdsOf({ members: MEMBERS, originPrId: 3 }).sort()).toEqual([1, 2, 3]);
  });
});

describe('the wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8');

  it('Open PRs reads ONE batched states request, gated on AI and the tracker', () => {
    const cards = src('components/Activity/OpenPrsCards.tsx');
    expect(cards).toMatch(/const ticketReviewOn = claudeOn && ticketsOn;/);
    expect(cards).toMatch(/useTicketReviewStates\(ticketIdents, ticketReviewOn\)/);
    expect(src('components/Activity/ClaudeReviewCell.tsx')).not.toMatch(/useTicketReviewStates|assessedStoryPills/);
  });

  it('the PR review Run button no longer takes or gates on a story', () => {
    const tab = src('components/ClaudeReviewTab.tsx');
    expect(tab).not.toMatch(/ticketCheck|ClaudeReviewTicketPanel/);
    expect(tab).toMatch(/generate\.mutate\(\{ model \}\)/);
    expect(tab).toMatch(/<TicketCoverageSection /);
  });

  it('one start mutation key per ticket; `done` refreshes every member', () => {
    const hooks = src('hooks/useTicketReview.ts');
    expect(hooks).toMatch(/\['ticket-review-start', ident\]/);
    expect(hooks).toMatch(/refreshAfter\(qc, e\.memberPrIds\)/);
  });
});

describe('ticketCoverage with no acceptance criteria', () => {
  it('a finished run shows its alignment, so the stack does not offer "Check story" again', () => {
    const zero = { met: 0, partlyMet: 0, notMet: 0, unclear: 0, notChecked: 0, total: 0 };
    expect(
      ticketCoverage(state({ status: 'current', counts: zero, latestRunId: 1, alignment: 'partly_aligned' })),
    ).toMatchObject({ label: 'Partly matches', tone: 'partial' });
    expect(ticketCoverage(state({ status: 'none', counts: null, latestRunId: null, alignment: null }))).toBeNull();
  });
});

describe('contribution cards ("What this PR adds")', () => {
  const card = {
    headSha: 'abc',
    source: 'prepass' as const,
    createdAt: '2026-10-01T00:00:00Z',
    summary: 'Adds export.',
    interfaces: [{ kind: 'config' as const, name: 'EXPORT_ON', change: 'added' as const, note: null }],
    criteria: [],
    looseEnds: [],
  };
  it('lists only members with a card, in member order — a member with none shows nothing', () => {
    const ms = [member(1, 'acme/api', 1, { card }), member(2, 'acme/web', 2), member(3, 'acme/web', 3, { card: null })];
    expect(membersWithCards(ms).map((x) => x.member.prId)).toEqual([1]);
    expect(membersWithCards([member(2, 'acme/web', 2)])).toEqual([]);
  });
  it('labels every kind and change in plain words', () => {
    expect(TICKET_PR_CARD_KIND_LABEL.config).toBe('Setting');
    expect(TICKET_PR_CARD_CHANGE_LABEL.removed).toBe('Removed');
    expect(cardHasDetail(card)).toBe(true);
    expect(cardHasDetail({ interfaces: [], looseEnds: [] })).toBe(false);
  });
});
