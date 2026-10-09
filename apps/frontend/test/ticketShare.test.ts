// ONE PR'S SHARE OF A TICKET REVIEW — lib/ticketShare.ts and its wiring.
//
//   1. THE SPLIT: the criteria this PR delivers and the unmet work that belongs in it; the rest is
//      counted, never listed. An item that names no owner stays postable (it is this PR's).
//   2. THE COUNT LINE: plain words, singular/plural, null when nothing else exists.
//   3. SLIM OR FULL: only where an Open PRs stack can hold the whole story.
//   4. THE JUMP: a target resolves case-insensitively, once, and expires.
//   5. WIRING: the stack's panel fetches only when expanded; no Post buttons there.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/ticketShare.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TicketAssessment, TicketCriterion, TicketReviewItem } from '@pierre-review/shared';
import {
  STORY_TARGET_TTL_MS,
  prCardOf,
  prTicketShare,
  resolveStoryTarget,
  shareRestLine,
  slimStoryCheck,
  storyTargetExpired,
  storyTargetFor,
} from '../src/lib/ticketShare.js';

const THIS = { id: 10, repoId: 1 };

const crit = (ref: string, over: Partial<TicketCriterion> = {}): TicketCriterion => ({
  ref,
  index: 0,
  text: ref,
  status: 'met',
  explanation: null,
  deliveredBy: [],
  evidence: [],
  expectedIn: null,
  ...over,
});
const item = (ref: string, over: Partial<TicketReviewItem> = {}): TicketReviewItem => ({
  id: Number(ref.replace(/\D/g, '')) + (ref.startsWith('M') ? 100 : 0),
  ticketReviewId: 1,
  ref,
  status: 'not_met',
  title: ref,
  body: '',
  ownerPrId: null,
  path: null,
  line: null,
  priorItemId: null,
  posted: null,
  ...over,
});
const assess = (over: Partial<TicketAssessment>): Pick<TicketAssessment, 'criteria' | 'missing' | 'notRequested'> => ({
  criteria: [],
  missing: [],
  notRequested: [],
  ...over,
});

describe('prTicketShare', () => {
  it('keeps what this PR delivers and what belongs in it; counts the rest', () => {
    const a = assess({
      criteria: [
        crit('AC1', { deliveredBy: [10] }),
        crit('AC2', { deliveredBy: [11] }),
        crit('AC3', { deliveredBy: [11, 12] }),
        crit('AC4', { status: 'not_met' }),
        crit('AC5', { status: 'partly_met', deliveredBy: [10] }),
        crit('AC6', { status: 'not_met' }),
      ],
      missing: [
        { ref: 'M1', title: 'm1', explanation: null, expectedIn: { prId: 10, repoId: null } },
        { ref: 'M2', title: 'm2', explanation: null, expectedIn: { prId: 12, repoId: null } },
      ],
    });
    const items = [
      item('AC4', { ownerPrId: 10 }),
      item('AC6', { ownerPrId: 11 }),
      item('AC5', { status: 'partly_met', ownerPrId: 11 }),
      item('M1', { status: 'missing', ownerPrId: 10 }),
      item('M2', { status: 'missing', ownerPrId: 12 }),
    ];
    const s = prTicketShare(a, items, THIS);
    // AC5 is partly delivered HERE, so it is this PR's even though its gap belongs elsewhere.
    expect(s.criteria.map((c) => c.ref)).toEqual(['AC1', 'AC4', 'AC5']);
    expect(s.missing.map((i) => i.ref)).toEqual(['M1']);
    expect(s.metElsewhere).toBe(2);
    expect(s.todoElsewhere).toBe(2); // AC6 + M2
  });

  it("falls back to the criterion's expectedIn, then its repo", () => {
    const a = assess({
      criteria: [
        crit('AC1', { status: 'not_met', expectedIn: { prId: 10, repoId: null } }),
        crit('AC2', { status: 'not_met', expectedIn: { prId: null, repoId: 1 } }),
        crit('AC3', { status: 'not_met', expectedIn: { prId: null, repoId: 2 } }),
        crit('AC4', { status: 'unclear', expectedIn: { prId: 11, repoId: null } }),
      ],
    });
    const s = prTicketShare(a, [], THIS);
    expect(s.criteria.map((c) => c.ref)).toEqual(['AC1', 'AC2']);
    expect(s.todoElsewhere).toBe(2);
  });

  it('an item that names no owner is this PR’s, so its Post stays reachable', () => {
    const a = assess({
      criteria: [crit('AC1', { status: 'not_met' })],
      missing: [{ ref: 'M1', title: 'm', explanation: null, expectedIn: null }],
    });
    const s = prTicketShare(a, [item('AC1'), item('M1', { status: 'missing' })], THIS);
    expect(s.criteria.map((c) => c.ref)).toEqual(['AC1']);
    expect(s.missing.map((i) => i.ref)).toEqual(['M1']);
    expect(s.todoElsewhere).toBe(0);
  });

  it('a missing item with no owner PR but another repo is counted, not listed', () => {
    const a = assess({ missing: [{ ref: 'M1', title: 'm', explanation: null, expectedIn: { prId: null, repoId: 2 } }] });
    const s = prTicketShare(a, [item('M1', { status: 'missing' })], THIS);
    expect(s.missing).toEqual([]);
    expect(s.todoElsewhere).toBe(1);
  });

  it('lists only the not-asked-for work this PR did', () => {
    const a = assess({
      notRequested: [
        { title: 'a', explanation: null, prId: 10, path: null, line: null },
        { title: 'b', explanation: null, prId: 11, path: null, line: null },
        { title: 'c', explanation: null, prId: null, path: null, line: null },
      ],
    });
    expect(prTicketShare(a, [], THIS).notRequested.map((g) => g.title)).toEqual(['a']);
  });
});

describe('shareRestLine', () => {
  it('says how many more, in plain words', () => {
    expect(shareRestLine({ metElsewhere: 3, todoElsewhere: 0 })).toBe('3 more criteria are met by other PRs.');
    expect(shareRestLine({ metElsewhere: 1, todoElsewhere: 1 })).toBe(
      '1 more criterion is met by another PR. 1 more is still to do in another PR.',
    );
    expect(shareRestLine({ metElsewhere: 0, todoElsewhere: 2 })).toBe('2 more are still to do in other PRs.');
    expect(shareRestLine({ metElsewhere: 0, todoElsewhere: 0 })).toBeNull();
  });
});

describe('slimStoryCheck', () => {
  const base = { ident: 'jira:https://x.atlassian.net#BMD-1', ticketKey: 'BMD-1', trackerOn: true, prOpen: true, members: [] };
  it('is slim for a tracker ticket with a stack to link to', () => {
    expect(slimStoryCheck(base)).toBe(true);
  });
  it('keeps the full view for a pasted story, no tracker, no key, or no open PR', () => {
    expect(slimStoryCheck({ ...base, ident: 'manual:10:abc' })).toBe(false);
    expect(slimStoryCheck({ ...base, trackerOn: false })).toBe(false);
    expect(slimStoryCheck({ ...base, ticketKey: null })).toBe(false);
    expect(slimStoryCheck({ ...base, prOpen: false })).toBe(false);
    expect(slimStoryCheck({ ...base, prOpen: false, members: [{ state: 'merged' }] })).toBe(false);
  });
  it('a merged PR is slim while another PR on the ticket is open', () => {
    expect(slimStoryCheck({ ...base, prOpen: false, members: [{ state: 'merged' }, { state: 'open' }] })).toBe(true);
  });
});

describe('the jump to Open PRs', () => {
  it('lands on the stack id the stacks use, case-insensitively', () => {
    const t = storyTargetFor(' bmd-7 ', 1000);
    expect(t.stackId).toBe('ticket:BMD-7');
    expect(resolveStoryTarget(t, ['ticket:BMD-6', 'ticket:bmd-7', 'none'], 1000)).toBe('ticket:bmd-7');
    expect(resolveStoryTarget(t, ['ticket:BMD-6'], 1000)).toBeNull();
    expect(resolveStoryTarget(null, ['ticket:BMD-7'], 1000)).toBeNull();
  });
  it('expires, so a later visit does not jump', () => {
    const t = storyTargetFor('BMD-7', 0);
    expect(storyTargetExpired(t, STORY_TARGET_TTL_MS)).toBe(false);
    expect(storyTargetExpired(t, STORY_TARGET_TTL_MS + 1)).toBe(true);
    expect(resolveStoryTarget(t, ['ticket:BMD-7'], STORY_TARGET_TTL_MS + 1)).toBeNull();
  });
});

describe('the wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8');

  it('the stack panel reads the run only while expanded, by the states’ latestRunId', () => {
    const panel = src('components/Activity/StackStoryCheck.tsx');
    expect(panel).toMatch(/\{open && \(/);
    expect(panel).toMatch(/<StoryCheckBody runId=\{state\.latestRunId\}/);
    expect(panel.match(/useTicketReviewById\(/g)).toHaveLength(1);
    expect(panel).toMatch(/<TicketResults review=\{review\} viewedPrId=\{null\} \/>/);
    // No Post anywhere in the stack.
    expect(panel).not.toMatch(/usePostTicketItem|ItemPost/);
    // The per-stack request never sits on the cards list itself.
    const cards = src('components/Activity/OpenPrsCards.tsx');
    expect(cards).not.toMatch(/useTicketReviewById|useTicketReviews\(/);
    expect(cards).toMatch(/<StackStoryCheck stackId=\{stack\.id\}/);
  });

  it('the pane shows only this PR’s share where a stack exists, and links to it', () => {
    const cov = src('components/TicketCoverage.tsx');
    expect(cov).toMatch(/slimStoryCheck\(\{/);
    expect(cov).toMatch(/prTicketShare\(a, review\.items, \{ id: pr\.id, repoId: pr\.repoId \}\)/);
    expect(cov).toMatch(/onClick=\{\(\) => showStoryInOpenPrs\(ticketKey\)\}/);
    expect(cov).toContain('See the whole story in Open PRs');
  });

  it('"What this PR adds" rides the loaded review: the stack lists every card, the pane this PR’s', () => {
    const panel = src('components/Activity/StackStoryCheck.tsx');
    expect(panel).toMatch(/<MemberCards members=\{members\} \/>/);
    const cov = src('components/TicketCoverage.tsx');
    expect(cov).toMatch(/prCardOf\(review\.members, pr\.id\)/);
    expect(cov).toMatch(/\{card != null && <PrCardDisclosure card=\{card\} \/>\}/);
    const parts = src('components/TicketReviewParts.tsx');
    expect(parts).toContain('What this PR adds');
    // No fetch of its own.
    expect(parts).not.toMatch(/useQuery\(|fetch\(/);
  });

  it('the Post button only renders with a viewed PR', () => {
    const parts = src('components/TicketReviewParts.tsx');
    expect(parts).toMatch(/if \(viewedPrId != null\) \{\s*return \(\s*<div className="mt-1\.5[^"]*">\s*<ItemPost /);
  });
});

describe('prCardOf', () => {
  const card = {
    headSha: 'h',
    source: 'story_check' as const,
    createdAt: '2026-10-01T00:00:00Z',
    summary: 's',
    interfaces: [],
    criteria: [],
    looseEnds: [],
  };
  it("is this PR's card, else null — never a placeholder", () => {
    expect(prCardOf([{ prId: 1, card }, { prId: 2 }], 1)).toBe(card);
    expect(prCardOf([{ prId: 1, card }, { prId: 2 }], 2)).toBeNull();
    expect(prCardOf([{ prId: 1, card: null }], 1)).toBeNull();
    expect(prCardOf([], 9)).toBeNull();
  });
});
