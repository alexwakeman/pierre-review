// Chronology pointers: the parse is the mechanism, not the prompt. These pin the gates that make
// "evidence-led, digit-free, names no one" true of whatever the model sends back — and the payload
// hash that decides whether a click costs money.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/flow-pointers.test.ts
import { describe, expect, it } from 'vitest';
import { resolveFlowSettings, type FlowPointerEvidence, type FlowPointerRow } from '@pierre-review/shared';
import { parseFlowPointersOutput, buildFlowPointersUserPrompt } from '../flow-pointers/prompt.js';
import {
  FLOW_POINTERS_PROMPT_VERSION,
  flowPointersPayloadHash,
  flowPointersScopeKey,
  flowPointersScopeKeyFor,
} from '../flow-pointers/hash.js';
import { linksFor } from '../flow-pointers/routes.js';

function row(prId: number, over: Partial<FlowPointerRow> = {}): FlowPointerRow {
  return {
    prId,
    repoFullName: 'acme/api',
    prNumber: prId,
    prTitle: `PR ${prId}`,
    githubUrl: `https://github.com/acme/api/pull/${prId}`,
    quarter: 'middle',
    leadWorkHours: 4,
    workHours: { reviewer: 3, author: 0, landing: 1 },
    firstLookWorkHours: 3,
    rounds: 0,
    lines: 50,
    files: 2,
    reachAreas: [],
    ciRedHours: 0,
    openedWeekday: 2,
    ticketKey: null,
    selfMerged: false,
    ...over,
  };
}

function evidence(over: Partial<FlowPointerEvidence> = {}): FlowPointerEvidence {
  return {
    workspaceId: 5,
    windowDays: 30,
    measuredPrs: 3,
    settings: resolveFlowSettings(null, 'Europe/London'),
    budgets: [],
    contrast: null,
    sizeBands: [],
    weekdays: [],
    landing: null,
    concentration: [],
    rows: [row(10, { quarter: 'slowest' }), row(11), row(12, { quarter: 'fastest' })],
    rowsCapped: false,
    exemplars: [{ prId: 10, side: 'slow', sizeBand: 'Up to 100 lines', firstReview: 'Needs a test', description: null }],
    ...over,
  };
}

const answer = (pointers: unknown[]): string => JSON.stringify({ pointers });

describe('every pointer rests on evidence', () => {
  it('keeps cited ids that are in the evidence and counts the rest', () => {
    const v = parseFlowPointersOutput(
      answer([{ kind: 'pattern', text: 'Slow ones were split late.', cites: [10, 999, 10, 12] }]),
      evidence(),
    )!;
    expect(v.pointers).toEqual([{ kind: 'pattern', text: 'Slow ones were split late.', cites: [10, 12] }]);
    // 999 is not in the evidence; the second 10 is a repeat.
    expect(v.droppedIds).toBe(2);
  });

  it('drops a pointer WHOLE when none of its citations is real', () => {
    const v = parseFlowPointersOutput(
      answer([
        { kind: 'try', text: 'Request a named reviewer.', cites: [404] },
        { kind: 'example', text: 'This one was small and quick.', cites: [12] },
      ]),
      evidence(),
    )!;
    expect(v.pointers.map((p) => p.cites)).toEqual([[12]]);
    expect(v.droppedPointers).toBe(1);
  });

  it('keeps at most three citations and five pointers', () => {
    const many = Array.from({ length: 7 }, () => ({ kind: 'pattern', text: 'Same shape.', cites: [10, 11, 12] }));
    const v = parseFlowPointersOutput(answer(many), evidence(), )!;
    expect(v.pointers).toHaveLength(5);
    expect(v.droppedPointers).toBe(2);
  });

  it('returns null when nothing survived, so the route stores an empty row and never re-bills', () => {
    expect(parseFlowPointersOutput('not json', evidence())).toBeNull();
    expect(parseFlowPointersOutput(answer([{ kind: 'pattern', text: 'x', cites: [1] }]), evidence())).toBeNull();
  });

  it('survives code fences around the JSON', () => {
    const raw = '```json\n' + answer([{ kind: 'example', text: 'Quick and small.', cites: ['12'] }]) + '\n```';
    expect(parseFlowPointersOutput(raw, evidence())!.pointers[0]!.cites).toEqual([12]);
  });
});

describe('the gates on the sentence', () => {
  it('drops a sentence with a digit, including a Unicode numeral', () => {
    for (const text of ['It took 3 rounds.', 'It took ３ rounds.', 'Over Ⅻ files.']) {
      expect(parseFlowPointersOutput(answer([{ kind: 'pattern', text, cites: [10] }]), evidence())).toBeNull();
    }
  });

  it('drops a sentence that names someone by handle', () => {
    expect(
      parseFlowPointersOutput(answer([{ kind: 'pattern', text: 'Ask @alice to review first.', cites: [10] }]), evidence()),
    ).toBeNull();
  });

  it('drops an unknown kind and an overlong sentence', () => {
    const long = 'word '.repeat(80);
    const v = parseFlowPointersOutput(
      answer([
        { kind: 'blame', text: 'Nope.', cites: [10] },
        { kind: 'pattern', text: long, cites: [10] },
        { kind: 'try', text: 'Split the change before review.', cites: [11] },
      ]),
      evidence(),
    )!;
    expect(v.pointers.map((p) => p.kind)).toEqual(['try']);
    expect(v.droppedPointers).toBe(2);
  });
});

describe('the prompt carries no person', () => {
  it('sends ids, figures and masked text — never a login field', () => {
    const user = buildFlowPointersUserPrompt(evidence());
    expect(user).not.toMatch(/"(author|reviewer|login|user)[A-Za-z]*":/);
    expect(user).toContain('"id":10');
  });
});

describe('the payload hash', () => {
  const key = flowPointersScopeKey(5, 30);
  it('is identical for identical evidence, whatever the row order', () => {
    const e = evidence();
    const shuffled = evidence({ rows: [...e.rows].reverse() });
    expect(flowPointersPayloadHash(key, e)).toBe(flowPointersPayloadHash(key, shuffled));
  });

  it('moves when a figure, the calendar, a budget, the window or the reviewer text moves', () => {
    const base = flowPointersPayloadHash(key, evidence());
    expect(flowPointersPayloadHash(key, evidence({ rows: [row(10, { leadWorkHours: 9 }), row(11), row(12)] }))).not.toBe(base);
    expect(flowPointersPayloadHash(key, evidence({ settings: resolveFlowSettings({ timeZone: 'Asia/Tokyo' }, 'UTC') }))).not.toBe(base);
    expect(
      flowPointersPayloadHash(key, evidence({ settings: resolveFlowSettings({ budgets: { lead: { good: 6 } } }, 'Europe/London') })),
    ).not.toBe(base);
    expect(flowPointersPayloadHash(flowPointersScopeKey(5, 90), evidence())).not.toBe(base);
    expect(
      flowPointersPayloadHash(key, evidence({ exemplars: [{ prId: 10, side: 'slow', sizeBand: 'Up to 100 lines', firstReview: 'Edited', description: null }] })),
    ).not.toBe(base);
  });

  it('keys the REPORTING WINDOW on its mode, plus the sprint start — never on a sliding start', () => {
    const sprint = {
      mode: 'sprint' as const,
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-04T00:00:00.000Z',
      end: '2026-10-15T00:00:00.000Z',
      days: 14,
      elapsedDays: 3,
    };
    const e = evidence({ workspaceId: 5, reportingWindow: sprint });
    expect(flowPointersScopeKeyFor(e)).toBe('ws:5|r:sprint:2026-10-01T00:00:00.000Z');
    // A rolling window's start slides every second; keying on it would never hit the cache.
    const rolling = { ...sprint, mode: 'rolling_14' as const, from: '2026-09-20T12:34:56.000Z' };
    expect(flowPointersScopeKeyFor(evidence({ workspaceId: 5, reportingWindow: rolling }))).toBe('ws:5|r:rolling_14');
    // The fixed options keep their old key, so stored rows stay readable.
    expect(flowPointersScopeKeyFor(evidence({ workspaceId: 5, windowDays: 60 }))).toBe(flowPointersScopeKey(5, 60));
    // The prompt names the window the panel names.
    expect(buildFlowPointersUserPrompt(e)).toContain('(this sprint so far)');
  });

  it('folds the prompt version, so a bump flips every stored row stale', () => {
    expect(FLOW_POINTERS_PROMPT_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('links come from the live evidence only', () => {
  it('drops a citation whose PR has left the window', () => {
    const result = {
      pointers: [{ kind: 'pattern' as const, text: 'x', cites: [10, 77] }],
      model: 'm',
      generatedAt: '',
      droppedIds: 0,
      droppedPointers: 0,
      prCount: 3,
    };
    expect(linksFor(result, evidence()).map((l) => l.prId)).toEqual([10]);
  });
});
