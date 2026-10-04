// The Claude Review "User stories" tabs: the pure half (`lib/storyTabs.ts`).
//
//   1. "STORY N" IS THE RUN'S NUMBER — blank tabs are not sent, so they are "New story" and do not
//      count (the "Story 3 for the second story" regression), the same in the tab strip, the
//      check's message, the finding chip and the GitHub comment lead.
//   2. Add / remove / select keep the selection on a real tab.
//   3. Pulling: dedupe against existing tabs, refresh in place, the cap, blank tabs give way.
//   4. The automatic pull runs once per PR per detected-key set and never re-adds a removed key.
//   5. The criteria field: a changed field rebuilds the story; a reset forgets the remembered pick.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyTabs.test.ts
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_REVIEW_MAX_TICKETS,
  storyCommentLead,
  type JiraAcCandidate,
  type JiraTicketDetails,
  type TicketRef,
} from '@pierre-review/shared';
import {
  EMPTY_TICKET_DRAFT,
  checkTicketDrafts,
  storyChipLabel,
  type TicketDraft,
} from '../src/lib/claudeReviewFollowUp.js';
import {
  acFieldText,
  addStoryTab,
  criteriaHasOwnHeading,
  autoPullKeys,
  createStoryPullMemory,
  jiraKeysToPull,
  jiraStoryFromDetails,
  mergePulledStories,
  pullJiraTickets,
  pullNote,
  pulledAcField,
  removeStoryTab,
  storyIndexAt,
  storyTabLabel,
} from '../src/lib/storyTabs.js';

const ref = (key: string): TicketRef => ({
  key,
  url: `https://acme.atlassian.net/browse/${key}`,
  provider: 'jira',
  canFetchDetails: true,
});
const jira = (key: string, title = `${key} title`): TicketDraft => ({
  ...EMPTY_TICKET_DRAFT,
  title,
  source: 'jira',
  key,
  url: `https://acme.atlassian.net/browse/${key}`,
});
const typed = (title: string): TicketDraft => ({ ...EMPTY_TICKET_DRAFT, title });
const blank = (): TicketDraft => ({ ...EMPTY_TICKET_DRAFT });
const cand = (id: string, name: string, match: JiraAcCandidate['match'] = 'strong'): JiraAcCandidate => ({
  id,
  name,
  match,
  text: `${name} text`,
});
const details = (key: string, candidates: JiraAcCandidate[] = []): JiraTicketDetails => ({
  prId: 1,
  key,
  title: `${key} title`,
  description: 'Some *markdown*',
  issueType: { id: '10001', name: 'Story' },
  candidates,
  omittedCandidates: 0,
});

describe('numbering: "Story N" is the number the run gives the story', () => {
  it('a blank tab is "New story" and does not shift the stories after it', () => {
    // The reported bug: the second story showed as "Story 3".
    const drafts = [jira('BMD-1040'), blank(), typed('Reset link expires')];
    expect(drafts.map((_, i) => storyTabLabel(drafts, i))).toEqual(['BMD-1040', 'New story', 'Story 2']);
    expect(storyIndexAt(drafts, 1)).toBeNull();
    expect(storyIndexAt(drafts, 2)).toBe(1);
    // …and the server's stored list puts it at index 1, the index every result surface names.
    const check = checkTicketDrafts(drafts);
    expect(check.ok && check.tickets.map((t) => t.title)).toEqual(['BMD-1040 title', 'Reset link expires']);
  });

  it('agrees with the finding chip and the GitHub comment lead for the same story', () => {
    const drafts = [blank(), jira('BMD-1040'), typed('Audit log')];
    const label = storyTabLabel(drafts, 2);
    const index = storyIndexAt(drafts, 2)!;
    const entries = [
      { index: 0, ref: 'T1', ticket: { key: 'BMD-1040' }, assessment: null },
      { index, ref: 'T2', ticket: { key: null }, assessment: { criteria: [] } },
    ];
    expect(label).toBe('Story 2');
    expect(storyChipLabel({ index, ref: 'AC1' }, entries as never)).toBe('Story 2 · AC1');
    expect(storyCommentLead({ title: 'X', story: { index, ref: 'M1' } }, entries as never)).toBe('Story 2 · Not done: X');
  });

  it("the check's message names the story the same way", () => {
    const drafts = [jira('BMD-1040'), blank(), typed('x'.repeat(301))];
    const check = checkTicketDrafts(drafts);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.index).toBe(2); // the tab, for the field error
      expect(check.message.startsWith(`${storyTabLabel(drafts, 2)}:`)).toBe(true);
    }
  });

  it('a typed story never borrows a key', () => {
    const drafts = [{ ...typed('A'), key: 'BMD-9' }];
    expect(storyTabLabel(drafts, 0)).toBe('Story 1');
  });
});

describe('add / remove / select', () => {
  it('adds a blank tab at the end and selects it; nothing at the cap', () => {
    const r = addStoryTab([jira('A-1')]);
    expect(r?.drafts).toHaveLength(2);
    expect(r?.selected).toBe(1);
    const full = Array.from({ length: CLAUDE_REVIEW_MAX_TICKETS }, (_, i) => typed(`S${i}`));
    expect(addStoryTab(full)).toBeNull();
  });

  it('keeps the selection on the same story, or its neighbour', () => {
    const d = [typed('a'), typed('b'), typed('c')];
    expect(removeStoryTab(d, 0, 2)).toMatchObject({ selected: 1 }); // before it: shifts left
    expect(removeStoryTab(d, 2, 0)).toMatchObject({ selected: 0 }); // after it: unchanged
    expect(removeStoryTab(d, 1, 1)).toMatchObject({ selected: 1 }); // itself: the one that took its place
    expect(removeStoryTab(d, 2, 2)).toMatchObject({ selected: 1 }); // the last: the one before
    expect(removeStoryTab([typed('a')], 0, 0)).toEqual({ drafts: [], selected: 0 });
  });
});

describe('pulling from Jira', () => {
  it('pulls only detected keys that are not tabs yet, once each, under the cap', () => {
    const fillable = [ref('A-1'), ref('A-2'), ref('A-2'), ref('A-3')];
    expect(jiraKeysToPull(fillable, [jira('A-1')]).keys).toEqual(['A-2', 'A-3']);
    expect(jiraKeysToPull(fillable, [jira('A-1')], { skip: new Set(['A-3']) }).keys).toEqual(['A-2']);
    const four = [typed('a'), typed('b'), typed('c'), typed('d')];
    expect(jiraKeysToPull(fillable, four)).toEqual({ keys: ['A-1'], overCap: ['A-2', 'A-3'] });
    // A blank tab gives way to a pull, so it does not hold a slot.
    expect(jiraKeysToPull(fillable, [...four, blank()]).keys).toEqual(['A-1']);
  });

  it('refreshes a key in place, appends a new one, selects the first added', () => {
    const r = mergePulledStories([typed('mine'), jira('A-1', 'old')], [jira('A-1', 'new'), jira('A-2')]);
    expect(r.drafts.map((d) => d.title)).toEqual(['mine', 'new', 'A-2 title']);
    expect(r).toMatchObject({ added: ['A-2'], refreshed: ['A-1'], overCap: [], selected: 2 });
  });

  it('drops blank tabs when it adds, keeps them on a refresh only', () => {
    expect(mergePulledStories([blank(), typed('x')], [jira('A-1')]).drafts.map((d) => d.title)).toEqual([
      'x',
      'A-1 title',
    ]);
    const refreshOnly = mergePulledStories([jira('A-1'), blank()], [jira('A-1', 'new')]);
    expect(refreshOnly.drafts).toHaveLength(2);
    expect(refreshOnly.selected).toBe(0);
  });

  it('respects the cap and says what it left out', () => {
    const four = [typed('a'), typed('b'), typed('c'), typed('d')];
    const r = mergePulledStories(four, [jira('A-1'), jira('A-2')]);
    expect(r.drafts).toHaveLength(CLAUDE_REVIEW_MAX_TICKETS);
    expect(r.overCap).toEqual(['A-2']);
    expect(pullNote([], r.overCap)).toBe(`A-2 not added: ${CLAUDE_REVIEW_MAX_TICKETS} stories is the limit.`);
  });

  it('one failure never loses the others, and is one short line', async () => {
    const res = await pullJiraTickets(['A-1', 'A-2', 'A-3'], async (k) => {
      if (k === 'A-2') throw new Error('Jira said 404.');
      return details(k);
    });
    expect(res.ok.map((x) => x.key)).toEqual(['A-1', 'A-3']);
    expect(pullNote(res.failed, [])).toBe('Could not read A-2: Jira said 404.');
    expect(pullNote([{ key: 'A', message: '' }, { key: 'B', message: '' }, { key: 'C', message: '' }], [])).toBe(
      'Could not read A, B and C.',
    );
    expect(pullNote([], [])).toBeNull();
  });
});

describe('the automatic pull', () => {
  const fillable = [ref('A-1'), ref('A-2')];

  it('runs once per PR per detected-key set', () => {
    const m = createStoryPullMemory();
    expect(autoPullKeys(m, 7, fillable, [])).toEqual(['A-1', 'A-2']);
    m.noteAutoPull(7, ['A-1', 'A-2']);
    // A remount / tab switch: nothing, even though the reader still has no tabs.
    expect(autoPullKeys(m, 7, fillable, [])).toEqual([]);
    // Another PR is its own.
    expect(autoPullKeys(m, 8, fillable, [])).toEqual(['A-1', 'A-2']);
    // A NEW key detected on the same PR: the set changed, so the new key is pulled (and only it).
    expect(autoPullKeys(m, 7, [...fillable, ref('A-3')], [jira('A-1'), jira('A-2')])).toEqual(['A-3']);
  });

  it('never re-adds a story the reader removed; a manual pull clears that', () => {
    const m = createStoryPullMemory();
    m.noteRemoved(7, ['A-1']);
    expect(autoPullKeys(m, 7, fillable, [])).toEqual(['A-2']);
    m.noteAutoPull(7, ['A-1', 'A-2']);
    m.unremove(7, ['A-1']);
    expect(m.removed(7).has('A-1')).toBe(false);
  });

  it('respects the cap, and does nothing when every detected key is already a tab', () => {
    const m = createStoryPullMemory();
    const four = [typed('a'), typed('b'), typed('c'), typed('d')];
    expect(autoPullKeys(m, 7, fillable, four)).toEqual(['A-1']);
    const full = [...four, typed('e')];
    expect(autoPullKeys(m, 7, fillable, full)).toEqual([]);
    expect(autoPullKeys(m, 7, fillable, [jira('A-1'), jira('A-2')])).toEqual([]);
  });

  it('a dropped answer lets the next mount try again', () => {
    const m = createStoryPullMemory();
    m.noteAutoPull(7, ['A-1', 'A-2']);
    m.clearAutoPull(7);
    expect(autoPullKeys(m, 7, fillable, [])).toEqual(['A-1', 'A-2']);
  });

  it('nothing detected: nothing pulled', () => {
    expect(autoPullKeys(createStoryPullMemory(), 7, [], [])).toEqual([]);
  });
});

describe('the acceptance-criteria field', () => {
  const cands = [cand('cf_dod', 'Definition of Done', 'weak'), cand('cf_ac', 'Acceptance Criteria')];

  it('a pull records the field it used, and the tab says which', () => {
    const d = jiraStoryFromDetails(ref('A-1'), details('A-1', cands), pulledAcField(details('A-1', cands)));
    expect(d.acField).toEqual({ id: 'cf_ac', name: 'Acceptance Criteria' });
    expect(d.acceptanceCriteria).toBe('Acceptance Criteria text');
    expect(d.issueTypeId).toBe('10001');
    expect(d.source).toBe('jira');
    expect(acFieldText(d)).toBe('Acceptance Criteria');
    expect(acFieldText({ acField: null })).toBe('none');
    expect(acFieldText({})).toBe('not recorded');
  });

  it('changing the field rebuilds the story from the re-read ticket', () => {
    const d = jiraStoryFromDetails(ref('A-1'), details('A-1', cands), 'cf_dod');
    expect(d.acceptanceCriteria).toBe('Definition of Done text');
    expect(d.acField?.id).toBe('cf_dod');
    // "None of these": no criteria, and the tab says none.
    const none = jiraStoryFromDetails(ref('A-1'), details('A-1', cands), '');
    expect(none.acceptanceCriteria).toBe('');
    expect(none.acField).toBeNull();
  });

  it('a pull uses the field the SERVER picked; null is none; no acField falls back to the name match', () => {
    const base = details('A-1', cands);
    expect(pulledAcField({ ...base, acField: { id: 'cf_dod', name: 'Definition of Done' } })).toBe('cf_dod');
    expect(pulledAcField({ ...base, acField: null })).toBe('');
    expect(pulledAcField(base)).toBe('cf_ac');
  });
});

describe('the criteria label is not printed twice', () => {
  it('a field that opens with its own "Acceptance criteria" heading drops the label', () => {
    expect(criteriaHasOwnHeading('# **ACCEPTANCE CRITERIA**\n\n| a |')).toBe(true);
    expect(criteriaHasOwnHeading('\n## Acceptance Criteria:\n- x')).toBe(true);
    expect(criteriaHasOwnHeading('# Acceptance criteria for upload')).toBe(false);
    expect(criteriaHasOwnHeading('Acceptance criteria\n- x')).toBe(false);
    expect(criteriaHasOwnHeading('')).toBe(false);
  });
});
