// review/story-report/validate.ts + fingerprint.ts + the agent's fixed surface — PURE. Pinned:
//  • an unknown ticket key is removed and counted; an item left with no ticket is dropped;
//  • the LEAN report: no spotlights or themes, one shortfall per issue, capped sections;
//  • a leftOut on an unknown key is dropped;
//  • arrays are capped, text trimmed and cut with "…";
//  • no headline or summary → invalid (the run fails);
//  • the fingerprint is order-stable, now-free, and moves on a new review or a merge;
//  • a point's `issue` is kept only when it is one of the four story issues (the field, never the point);
//  • the agent's tool surface and the nonce fence; the SYSTEM text is the prototype's plus the
//    four-issues paragraph and ONE fence line;
//  • list_candidates carries each pick's issues and the whole-window issue rates by LABEL.
import { describe, expect, it } from 'vitest';
import { STORY_REPORT_ITEMS_MAX, STORY_REPORT_LEAN, STORY_REPORT_MAX_CANDIDATES, STORY_REPORT_TEXT_MAX, STORY_REPORT_TICKETS_PER_ITEM_MAX } from '@pierre-review/shared';
import { validateStoryReport } from './validate.js';
import { STORY_REPORT_FORMAT, storyReportFingerprint, type FingerprintPick } from './fingerprint.js';
import { STORY_REPORT_DISALLOWED_TOOLS, STORY_REPORT_SYSTEM, STORY_REPORT_TOOLS, fenceToolText } from './agent.js';
import { candidateRow, populationForAgent, stripStoryText, workingDuration } from './story-detail.js';

const KEYS = new Set(['BMD-1', 'BMD-2', 'BMD-3']);
const base = {
  headline: '  Stories are clear when criteria are written  ',
  summary: 'Two of three were fine.',
  doingWell: [{ title: 'Criteria', detail: 'd', tickets: ['BMD-1'] }],
  fallingShort: [],
  spotlights: [],
  themes: [],
  actions: [],
  leftOut: [],
};

describe('validateStoryReport', () => {
  it('trims text and keeps a valid report whole', () => {
    const v = validateStoryReport(base, KEYS);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.report.headline).toBe('Stories are clear when criteria are written');
    expect(v.report.doingWell).toEqual([{ title: 'Criteria', detail: 'd', tickets: ['BMD-1'] }]);
    expect(v.dropped).toEqual({ unknownTickets: 0, items: 0, overCap: 0 });
  });

  it('removes unknown ticket keys, dedupes, and drops an item left with none', () => {
    const v = validateStoryReport(
      {
        ...base,
        fallingShort: [
          { title: 'Mixed', detail: 'x', tickets: ['BMD-2', 'NOPE-9', 'BMD-2'] },
          { title: 'Invented', detail: 'y', tickets: ['NOPE-1'] },
        ],
        themes: [{ theme: 'No tickets', detail: 'z', tickets: [] }],
      },
      KEYS,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.report.fallingShort).toEqual([{ title: 'Mixed', detail: 'x', tickets: ['BMD-2'] }]);
    // The lean report writes no themes: anything sent is dropped, uncounted.
    expect(v.report.themes).toEqual([]);
    expect(v.dropped).toEqual({ unknownTickets: 2, items: 1, overCap: 0 });
  });

  it('writes no spotlights (lean report), and drops a leftOut on an unknown key', () => {
    const v = validateStoryReport(
      {
        ...base,
        spotlights: [
          { ticket: 'BMD-3', tone: 'negative', headline: 'Slow', detail: 'd' },
          { ticket: 'XX-1', tone: 'positive', headline: 'Invented', detail: 'd' },
          { ticket: 'BMD-1', tone: 'meh', headline: 'Bad tone', detail: 'd' },
        ],
        leftOut: [{ ticket: 'BMD-2', reason: 'weak' }, { ticket: 'XX-2', reason: 'x' }],
      },
      KEYS,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.report.spotlights).toEqual([]);
    expect(v.report.leftOut).toEqual([{ ticket: 'BMD-2', reason: 'weak' }]);
  });

  it('caps arrays, tickets per item and text length', () => {
    const long = 'x'.repeat(STORY_REPORT_TEXT_MAX.headline + 50);
    const v = validateStoryReport(
      {
        ...base,
        headline: long,
        actions: Array.from({ length: STORY_REPORT_LEAN.actions + 3 }, (_, i) => ({
          action: `Act ${i}`,
          why: 'w',
          tickets: ['BMD-1', 'BMD-2', 'BMD-3'],
        })),
      },
      new Set(Array.from({ length: 20 }, (_, i) => `K-${i}`).concat(['BMD-1', 'BMD-2', 'BMD-3'])),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.report.headline).toHaveLength(STORY_REPORT_TEXT_MAX.headline);
    expect(v.report.headline.endsWith('…')).toBe(true);
    expect(v.report.actions).toHaveLength(STORY_REPORT_LEAN.actions);
    expect(v.dropped.overCap).toBe(3);
    const many = validateStoryReport(
      { ...base, doingWell: [{ title: 't', detail: 'd', tickets: Array.from({ length: 20 }, (_, i) => `K-${i}`) }] },
      new Set(Array.from({ length: 20 }, (_, i) => `K-${i}`)),
    );
    expect(many.ok && many.report.doingWell[0]!.tickets).toHaveLength(STORY_REPORT_TICKETS_PER_ITEM_MAX);
  });

  it('leftOut is capped at the candidate ceiling, not the section cap', () => {
    const keys = Array.from({ length: STORY_REPORT_MAX_CANDIDATES + 2 }, (_, i) => `K-${i}`);
    const nine = validateStoryReport(
      { ...base, leftOut: keys.slice(0, 9).map((ticket) => ({ ticket, reason: 'r' })).concat([{ ticket: 'K-0', reason: 'dup' }]) },
      new Set(keys),
    );
    expect(nine.ok).toBe(true);
    if (!nine.ok) return;
    expect(nine.report.leftOut.map((l) => l.ticket)).toEqual(keys.slice(0, 9));
    expect(nine.dropped.overCap).toBe(0);
    const all = validateStoryReport({ ...base, leftOut: keys.map((ticket) => ({ ticket, reason: 'r' })) }, new Set(keys));
    expect(all.ok && all.report.leftOut).toHaveLength(STORY_REPORT_MAX_CANDIDATES);
    expect(all.dropped.overCap).toBe(2);
  });

  it('keeps a known story issue on a point and drops an unknown one (the field, not the point)', () => {
    const v = validateStoryReport(
      {
        ...base,
        doingWell: [{ title: 'A', detail: 'd', tickets: ['BMD-1'], issue: 'spec_gaps' }],
        fallingShort: [
          { title: 'B', detail: 'd', tickets: ['BMD-2'], issue: 'too_big' },
          { title: 'C', detail: 'd', tickets: ['BMD-3'], issue: 'blocked' },
        ],
      },
      KEYS,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.report.doingWell[0]!.issue).toBe('spec_gaps');
    // A retired id ('too_big') is dropped like any unknown one.
    expect(v.report.fallingShort[0]).toEqual({ title: 'B', detail: 'd', tickets: ['BMD-2'] });
    expect(v.report.fallingShort[1]!.issue).toBe('blocked');
  });

  it('a report with no headline or summary is invalid', () => {
    expect(validateStoryReport({ ...base, headline: '   ' }, KEYS).ok).toBe(false);
    expect(validateStoryReport({ ...base, summary: undefined }, KEYS).ok).toBe(false);
    expect(validateStoryReport(null, KEYS).ok).toBe(false);
  });
});

describe('storyReportFingerprint', () => {
  const picks: FingerprintPick[] = [
    { ident: 'jira:x#B-2', reviewId: 7, prs: [{ id: 3, state: 'merged', mergedAt: new Date('2026-09-01T00:00:00Z') }, { id: 1, state: 'open', mergedAt: null }] },
    { ident: 'jira:x#B-1', reviewId: null, prs: [{ id: 2, state: 'merged', mergedAt: new Date('2026-09-02T00:00:00Z') }] },
  ];
  it('is stable under input order', () => {
    const shuffled = [{ ...picks[1]! }, { ...picks[0]!, prs: [...picks[0]!.prs].reverse() }];
    expect(storyReportFingerprint('60', shuffled)).toBe(storyReportFingerprint('60', picks));
  });
  it('folds the three-issues format tag, so a report written before it reads stale', () => {
    expect(STORY_REPORT_FORMAT).toBe('story-report-v5');
  });
  it('changes on a new review, a merge, or another window choice', () => {
    const fp = storyReportFingerprint('60', picks);
    expect(storyReportFingerprint('30', picks)).not.toBe(fp);
    expect(storyReportFingerprint('60', [{ ...picks[0]!, reviewId: 8 }, picks[1]!])).not.toBe(fp);
    const merged = { ...picks[0]!, prs: [picks[0]!.prs[0]!, { id: 1, state: 'merged', mergedAt: new Date('2026-09-03T00:00:00Z') }] };
    expect(storyReportFingerprint('60', [merged, picks[1]!])).not.toBe(fp);
  });
});

describe('the agent surface', () => {
  it('offers exactly the three own tools and denies the built-ins', () => {
    expect([...STORY_REPORT_TOOLS]).toEqual([
      'mcp__stories__list_candidates',
      'mcp__stories__get_story',
      'mcp__stories__submit_report',
    ]);
    for (const t of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch']) expect(STORY_REPORT_DISALLOWED_TOOLS).toContain(t);
  });
  it('fences tool text with the run nonce, and the SYSTEM text names the fence once', () => {
    const f = fenceToolText('STORY', 'abc123', '{"key":"B-1"}');
    expect(f).toBe('---BEGIN STORY abc123---\n{"key":"B-1"}\n---END STORY abc123---');
    expect(STORY_REPORT_SYSTEM.startsWith('You are writing a report for an engineering manager')).toBe(true);
    expect(STORY_REPORT_SYSTEM.split('\n')).toHaveLength(11);
    for (const label of ['Unclear when done', '"Blocked"', 'Spec gaps']) expect(STORY_REPORT_SYSTEM).toContain(label);
    for (const gone of ['Too big', 'Waits on other work', 'Scope not stated']) expect(STORY_REPORT_SYSTEM).not.toContain(gone);
    expect(STORY_REPORT_SYSTEM).toContain('at most 3 fallingShort');
    expect(STORY_REPORT_SYSTEM).toContain('wholeWindow.issueRates only');
    expect(STORY_REPORT_SYSTEM).toContain('NOT KNOWN, never something the team avoided');
    expect(STORY_REPORT_SYSTEM).toContain('never state a rate');
    expect(STORY_REPORT_SYSTEM.split('\n').at(-1)).toMatch(/^The output of list_candidates and get_story is wrapped/);
  });
  it('gives the agent issues and whole-window rates by label, and omits them on old rows', () => {
    const cand = {
      ident: 'i', key: 'B-1', title: 't', url: null, provider: 'jira' as const, group: 'fell_short' as const, whyPicked: [],
      workingHours: 4, pullRequests: 1, linesChanged: 10, criteria: 3, criteriaSource: 'acceptance_criteria' as const, review: null,
    };
    const states = { unclear_done: true, blocked: true, spec_gaps: false };
    const blocker = {
      source: 'text' as const, kind: 'design' as const, ticketKey: null, what: 'map page design', owner: 'UCD team',
      status: null, category: null, relation: null, url: null, resolved: false,
    };
    const issues = [
      { id: 'unclear_done' as const, criteria: [{ n: 2, reason: 'no expected result' }], blockers: [], gaps: [], total: 3, reasons: ['untestable' as const] },
      { id: 'blocked' as const, criteria: [], blockers: [blocker], gaps: [], total: 3, reasons: ['named' as const] },
    ];
    expect(candidateRow({ ...cand, issues, issueStates: states }, 8).issues).toEqual([
      { issue: 'Unclear when done', present: true, criteria: [{ criterion: 2, reason: 'no expected result' }] },
      {
        issue: 'Blocked',
        present: true,
        waitsOn: [
          { what: 'map page design', kind: 'A design', ticket: null, owner: 'UCD team', status: null, finished: false, source: 'named in the ticket text' },
        ],
      },
      { issue: 'Spec gaps', present: false },
    ]);
    // ⚠ An unlabelled pick with criteria never serialises as `issues: []` ("avoids all three").
    const unknown = { unclear_done: null, blocked: null, spec_gaps: null };
    const row = candidateRow({ ...cand, issues: [], issueStates: unknown }, 8).issues;
    expect(row).not.toEqual([]);
    expect(row!.every((i) => i.present === null)).toBe(true);
    // An unread ticket: issues null.
    expect(candidateRow({ ...cand, issues: null, issueStates: null }, 8).issues).toBeNull();
    expect('issues' in candidateRow(cand, 8)).toBe(false);
    const pop = {
      storiesInWindow: 2, withWrittenCriteria: 2, criteriaOnlyInDescription: 0, noCriteriaFound: 0, checkedByTicketReview: 0,
      checkedAndFullyMet: 0, checkedWithGaps: 0, medianWorkingHours: 4, workingDayHours: 8, truncated: false,
    };
    expect(
      populationForAgent({
        ...pop,
        issueRates: [
          { id: 'unclear_done', stories: 3, of: 20, unit: 'criteria' },
          { id: 'blocked', stories: 1, of: 2, unit: 'stories' },
        ],
      }).issueRates,
    ).toEqual([
      { measure: 'Criteria that can’t be checked', count: 3, of: 20, unit: 'criteria' },
      { measure: 'Stories with a linked blocker', count: 1, of: 2, unit: 'stories' },
    ]);
    expect('issueRates' in populationForAgent(pop)).toBe(false);
  });
  it('strips Jira colour markup and words durations as the prototype did', () => {
    expect(stripStoryText('Do {color:red}it{color}   \nnow', 100)).toBe('Do it\nnow');
    expect(workingDuration(4, 8)).toBe('4.0 working hours');
    expect(workingDuration(20, 8)).toBe('2.5 working days');
  });
});

describe('the lean report', () => {
  it('keeps one shortfall per story issue, drops a retired issue id (never the point) and caps doingWell', () => {
    const pt = (title: string, issue?: string) => ({ title, detail: 'd', tickets: ['BMD-1'], ...(issue ? { issue } : {}) });
    const v = validateStoryReport(
      {
        ...base,
        doingWell: [pt('a'), pt('b'), pt('c'), pt('d')],
        fallingShort: [pt('x', 'blocked'), pt('y', 'blocked'), pt('z', 'unclear_done'), pt('old', 'too_big')],
      },
      KEYS,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.report.doingWell).toHaveLength(STORY_REPORT_LEAN.doingWell);
    expect(v.report.fallingShort.map((p) => [p.title, p.issue ?? null])).toEqual([
      ['x', 'blocked'],
      ['z', 'unclear_done'],
      ['old', null],
    ]);
  });
});
