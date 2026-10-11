// Reports → Stories → the story report: the pure folds behind the card (linkify, figures, sections,
// the markdown export).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyReportModel.test.ts
import { describe, expect, it } from 'vitest';
import type {
  StoryReportBody,
  StoryReportCandidate,
  StoryReportPopulation,
  StoryReportRecord,
} from '@pierre-review/shared';
import {
  indexCandidates,
  linkifyTicketKeys,
  markdownWithLinks,
  pointIssueLabel,
  storyReportFigures,
  issueRateFigure,
  storyReportMarkdown,
  storyReportSections,
  storyReportWindowLabel,
  ticketChipLabel,
} from '../src/components/Activity/storyReportModel.js';

// `safeExternalUrl` parses against `window.location.origin`; the node runner has no window.
(globalThis as unknown as { window: unknown }).window ??= { location: { origin: 'http://localhost' } };

function cand(key: string, over: Partial<StoryReportCandidate> = {}): StoryReportCandidate {
  return {
    ident: `jira:https://x.atlassian.net#${key}`,
    key,
    title: `Title ${key}`,
    url: `https://x.atlassian.net/browse/${key}`,
    provider: 'jira',
    group: 'done_well',
    whyPicked: ['review: all 3 criteria met'],
    workingHours: 10,
    pullRequests: 2,
    linesChanged: 120,
    criteria: 3,
    criteriaSource: 'acceptance_criteria',
    review: null,
    ...over,
  };
}

const population: StoryReportPopulation = {
  storiesInWindow: 81,
  withWrittenCriteria: 36,
  criteriaOnlyInDescription: 3,
  noCriteriaFound: 31,
  checkedByTicketReview: 13,
  checkedAndFullyMet: 5,
  checkedWithGaps: 8,
  medianWorkingHours: 19.2,
  workingDayHours: 8,
  truncated: false,
};

const emptyBody: StoryReportBody = {
  headline: 'H',
  summary: 'S',
  doingWell: [],
  fallingShort: [],
  spotlights: [],
  themes: [],
  actions: [],
  leftOut: [],
};

function record(body: StoryReportBody, picked: StoryReportCandidate[]): StoryReportRecord {
  return {
    id: 1,
    workspaceId: 2,
    window: '60',
    range: { choice: '60', from: '2026-08-11T12:00:00Z', to: '2026-10-10T12:00:00Z', days: 60, reporting: null },
    model: 'claude-haiku-5-5',
    status: 'succeeded',
    picked,
    population,
    report: body,
    dropped: null,
    error: null,
    costUsd: 0.02,
    inputTokens: 1,
    outputTokens: 1,
    numTurns: 21,
    createdAt: '2026-10-10T09:00:00Z',
    completedAt: '2026-10-10T09:01:00Z',
  };
}

describe('linkifyTicketKeys', () => {
  const index = indexCandidates([cand('BMD-12'), cand('BMD-1003'), cand('acme/web#7')]);

  it('links candidate keys only', () => {
    const segs = linkifyTicketKeys('BMD-12 waits on BMD-568, see BMD-1003.', index);
    expect(segs).toEqual([
      { kind: 'ticket', key: 'BMD-12', href: 'https://x.atlassian.net/browse/BMD-12' },
      { kind: 'text', text: ' waits on BMD-568, see ' },
      { kind: 'ticket', key: 'BMD-1003', href: 'https://x.atlassian.net/browse/BMD-1003' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('never matches a key inside a longer token', () => {
    for (const t of ['BMD-123', 'XBMD-12', 'BMD-12-fix', 'BMD-12a', 'path/BMD-12', 'BMD-12.5']) {
      expect(linkifyTicketKeys(t, index).every((s) => s.kind === 'text')).toBe(true);
    }
    expect(linkifyTicketKeys('(BMD-12)', index).map((s) => s.kind)).toEqual(['text', 'ticket', 'text']);
  });

  it('matches GitHub-style keys', () => {
    expect(linkifyTicketKeys('see acme/web#7 and acme/web#70', index).filter((s) => s.kind === 'ticket')).toEqual([
      { kind: 'ticket', key: 'acme/web#7', href: 'https://x.atlassian.net/browse/acme/web#7' },
    ]);
  });

  it('a candidate with an unsafe URL is matched but not linked', () => {
    const bad = indexCandidates([cand('BMD-9', { url: 'javascript:alert(1)' })]);
    expect(linkifyTicketKeys('BMD-9', bad)).toEqual([{ kind: 'ticket', key: 'BMD-9', href: null }]);
    expect(markdownWithLinks('BMD-9', bad)).toBe('BMD-9');
  });

  it('no candidates leaves the text alone', () => {
    expect(linkifyTicketKeys('BMD-12', new Map())).toEqual([{ kind: 'text', text: 'BMD-12' }]);
    expect(linkifyTicketKeys('', index)).toEqual([]);
  });
});

describe('figures', () => {
  it('gives each count its denominator', () => {
    expect(storyReportFigures(population).map((f) => [f.label, f.value])).toEqual([
      ['Stories', '81'],
      ['With written criteria', '36 of 81'],
      ['Checked by a ticket review', '13 of 81'],
      ['Fully met', '5 of 13'],
      ['With gaps', '8 of 13'],
      ['Median working time', '2.4 working days'],
    ]);
  });

  it('drops the review split when nothing was reviewed, and never prints an unknown median as 0', () => {
    const f = storyReportFigures({ ...population, checkedByTicketReview: 0, checkedAndFullyMet: 0, checkedWithGaps: 0, medianWorkingHours: null });
    expect(f.map((x) => x.key)).toEqual(['stories', 'criteria', 'checked', 'median']);
    expect(f.at(-1)?.value).toBe('not measured');
  });

  it('adds the whole-window issue rates, skipping one nothing could be told about and retired ids', () => {
    const f = storyReportFigures({
      ...population,
      issueRates: [
        { id: 'unclear_done', stories: 12, of: 81 },
        { id: 'blocked', stories: 0, of: 0 },
        { id: 'spec_gaps', stories: 30, of: 40 },
        // An OLD stored report: retired ids are dropped, never rendered.
        { id: 'too_big' as unknown as 'blocked', stories: 9, of: 40 },
      ],
    });
    expect(f.slice(-2).map((x) => [x.label, x.value])).toEqual([
      ['Unclear when done', '12 of 81 read'],
      ['Spec gaps', '30 of 40 read'],
    ]);
  });

  it('a current rate wears Story health\'s measure and its unit; an old one keeps its old label', () => {
    const f = storyReportFigures({
      ...population,
      issueRates: [
        { id: 'unclear_done', stories: 12, of: 81, unit: 'criteria' },
        { id: 'blocked', stories: 3, of: 40, unit: 'stories' },
      ],
    });
    expect(f.slice(-2).map((x) => [x.label, x.value])).toEqual([
      ['Criteria that can’t be checked', '12 of 81 criteria'],
      ['Stories with a linked blocker', '3 of 40 stories'],
    ]);
    expect(issueRateFigure({ id: 'blocked', stories: 2, of: 9 })).toEqual({ label: 'Had blockers', value: '2 of 9 read' });
  });

  it('names a point\'s story issue, and nothing on an old point or a retired id', () => {
    expect(pointIssueLabel({ issue: 'blocked' })).toBe('Blocked');
    expect(pointIssueLabel({})).toBeNull();
    expect(pointIssueLabel({ issue: 'blocked' }, 'positive')).toBe('Nothing blocking');
    expect(pointIssueLabel({ issue: 'spec_gaps' }, 'positive')).toBe('Spec complete');
    expect(pointIssueLabel({ issue: 'waits_on_work' as unknown as 'blocked' })).toBeNull();
    expect(pointIssueLabel({ issue: 'too_big' as unknown as 'blocked' }, 'positive')).toBeNull();
  });

  it('a ticket chip reads "KEY · Title" for a pick, the key alone otherwise', () => {
    const index = indexCandidates([cand('BMD-12'), cand('BMD-13', { title: '  ' }), cand('BMD-14', { title: null })]);
    expect(ticketChipLabel('BMD-12', index)).toBe('BMD-12 · Title BMD-12');
    expect(ticketChipLabel('BMD-13', index)).toBe('BMD-13');
    expect(ticketChipLabel('BMD-14', index)).toBe('BMD-14');
    expect(ticketChipLabel('BMD-999', index)).toBe('BMD-999');
  });
});

describe('sections and the window label', () => {
  it('lists only the sections with content, in reading order', () => {
    expect(storyReportSections(emptyBody)).toEqual([]);
    const body: StoryReportBody = {
      ...emptyBody,
      actions: [{ action: 'a', why: 'w', tickets: [] }],
      doingWell: [{ title: 't', detail: 'd', tickets: ['BMD-12'] }],
    };
    expect(storyReportSections(body)).toEqual(['doingWell', 'actions']);
  });

  it('names a day choice and the reporting window', () => {
    expect(storyReportWindowLabel('60', null)).toBe('Last 60 days');
    expect(storyReportWindowLabel('reporting', { mode: 'sprint', days: 14 })).toBe('This sprint');
    expect(storyReportWindowLabel('reporting', { mode: 'rolling_14', days: 14 })).toBe('Last 14 days');
    expect(storyReportWindowLabel('reporting', null)).toBe('Reporting window');
  });
});

describe('the markdown export', () => {
  const picked = [cand('BMD-12'), cand('BMD-40', { group: 'fell_short' })];
  const body: StoryReportBody = {
    headline: 'Criteria held up.',
    summary: 'Most stories with criteria\nwere met. BMD-12 is the best, BMD-568 is not built.',
    doingWell: [{ title: 'Clear criteria', detail: 'BMD-12 names each case.', tickets: ['BMD-12'] }],
    fallingShort: [{ title: 'No criteria', detail: 'Big work.', tickets: ['BMD-40'], issue: 'unclear_done' }],
    spotlights: [{ ticket: 'BMD-40', tone: 'negative', headline: 'Too big.', detail: 'Split it.' }],
    themes: [{ theme: 'Spikes', detail: 'No exit.', tickets: [] }],
    actions: [
      { action: 'Write criteria', why: 'So done is clear.', tickets: ['BMD-40'] },
      { action: 'Split work', why: 'Smaller.', tickets: [] },
    ],
    leftOut: [{ ticket: 'BMD-12', reason: 'covered' }],
  };
  const md = storyReportMarkdown(record(body, picked));

  it('is a clean document with links on candidate keys only', () => {
    expect(md.startsWith('# Criteria held up.\n\nLast 60 days (11 Aug – 10 Oct)\n\n')).toBe(true);
    expect(md).toContain(
      'Most stories with criteria were met. [BMD-12](https://x.atlassian.net/browse/BMD-12) is the best, BMD-568 is not built.',
    );
    expect(md).toContain('- With written criteria: 36 of 81');
    expect(md).toContain('## What we do well\n\n### Clear criteria\n\n[BMD-12](https://x.atlassian.net/browse/BMD-12) names each case.\n\nTickets: [BMD-12](https://x.atlassian.net/browse/BMD-12)');
    expect(md).toContain('### No criteria · Unclear when done\n');
    expect(md).toContain('- **[BMD-40](https://x.atlassian.net/browse/BMD-40)** (Weak example): Too big. Split it.');
    expect(md).toContain('- **Spikes**: No exit.\n');
    expect(md).toContain('1. **Write criteria**: So done is clear. ([BMD-40](https://x.atlassian.net/browse/BMD-40))\n2. **Split work**: Smaller.');
    expect(md).not.toContain('covered');
    expect(md).not.toMatch(/\n{3,}/);
    expect(md.endsWith('\n')).toBe(true);
  });

  it('labels the figures apart from the model text', () => {
    expect(md).toContain('_Figures are counted over every story in the window. The text was written by Claude from 2 picked stories._');
  });

  it('escapes model markdown; only the code-made candidate links stay live', () => {
    const hostile: StoryReportBody = {
      ...body,
      headline: '# Big [win](https://evil.example)',
      summary: '> quoted *bold* see https://evil.example and BMD-12',
      doingWell: [{ title: '- listy', detail: '1. step _one_ <b>x</b>', tickets: ['BMD-12'] }],
    };
    const out = storyReportMarkdown(record(hostile, picked));
    expect(out.startsWith('# \\# Big \\[win\\](https\\://evil.example)\n')).toBe(true);
    expect(out).toContain('\\> quoted \\*bold\\* see https\\://evil.example and [BMD-12](https://x.atlassian.net/browse/BMD-12)');
    expect(out).toContain('### \\- listy\n\n1\\. step \\_one\\_ \\<b\\>x\\</b\\>\n');
    expect(out).not.toMatch(/\]\(https:\/\/evil/);
  });

  it('an unfinished run exports nothing', () => {
    expect(storyReportMarkdown({ ...record(body, picked), report: null })).toBe('');
  });
});
