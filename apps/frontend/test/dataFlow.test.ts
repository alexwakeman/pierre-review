// THE DATA-FLOW DIAGRAM'S RENDERING MODEL (lib/dataFlow.ts): lanes in stored order, one row per step in
// order, spans between lane centres, loops for in-place steps, and every step as one sentence.
import { describe, expect, it } from 'vitest';
import { sequenceDiagramRefusalText, type FlowDiagram, type SequenceDiagramMember } from '@pierre-review/shared';
import { laneChangesPresent, layoutFlow } from '../src/lib/dataFlow.js';

const FLOW: FlowDiagram = {
  participants: [
    { id: 'ui', kind: 'ui', label: 'Rates page', change: 'new', pr: 'PR2' },
    { id: 'api', kind: 'api', label: 'Rates route', change: 'changed', pr: 'PR1' },
    { id: 'db', kind: 'db', label: 'rates table', change: 'unchanged', pr: null },
  ],
  steps: [
    { n: 1, from: 'ui', to: 'api', kind: 'call', label: 'currency filter', pr: 'PR2', files: ['web/Rates.tsx'] },
    { n: 2, from: 'api', to: 'api', kind: 'validate', label: 'a known currency', pr: 'PR1', files: [] },
    { n: 3, from: 'api', to: 'db', kind: 'read', label: 'rates for it', pr: 'PR1', files: [] },
    { n: 4, from: 'db', to: 'db', kind: 'transform', label: 'latest per day', pr: null, files: [] },
    { n: 5, from: 'api', to: 'ui', kind: 'return', label: 'rate list', pr: 'PR1', files: [] },
    { n: 6, from: 'api', to: 'ghost', kind: 'write', label: 'dropped', pr: null, files: [] },
  ],
};
const MEMBERS: SequenceDiagramMember[] = [
  { prId: 11, repo: 'acme/api', number: 4, title: 'API', state: 'open', headSha: 'a' },
  { prId: 12, repo: 'acme/web', number: 9, title: 'Web', state: 'merged', headSha: 'b' },
];

describe('layoutFlow', () => {
  const l = layoutFlow(FLOW, MEMBERS);

  it('lanes in stored order, with their kind words and pull requests', () => {
    expect(l.lanes.map((x) => [x.participant.id, x.col, x.kindLabel, x.member?.number ?? null])).toEqual([
      ['ui', 0, 'Screen', 9],
      ['api', 1, 'API route', 4],
      ['db', 2, 'Database', null],
    ]);
    expect(laneChangesPresent(l)).toEqual(['new', 'changed', 'unchanged']);
  });

  it('one row per drawable step, in order; a step to a missing lane is dropped', () => {
    expect(l.rows.map((r) => r.step.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it('a step spans lane line to lane line; a loop up to 1.75 lanes towards its open side', () => {
    const [call, check, read, transform, ret] = l.rows;
    expect(call).toMatchObject({ dir: 'right', self: false, word: 'Call' });
    expect(call!.span.left).toBeCloseTo(100 / 6);
    expect(call!.span.width).toBeCloseTo(100 / 3);
    expect(ret).toMatchObject({ dir: 'left', word: 'Return' });
    // A leftward step spans the same lane lines as a rightward one between the same lanes.
    expect(ret!.span.left).toBeCloseTo(100 / 6);
    expect(ret!.span.width).toBeCloseTo(100 / 3);
    expect(read).toMatchObject({ dir: 'right', word: 'Read' });
    // A check in place: its box opens right of its lane, 1.75 lanes or to the figure's edge …
    expect(check).toMatchObject({ dir: 'self', self: true, loopRight: true, word: 'Check' });
    expect(check!.span.left).toBeCloseTo(50);
    expect(check!.span.width).toBeCloseTo((1.5 / 3) * 100);
    // … except on the last lane, where it opens to the left, ending on its own lane's line.
    expect(transform).toMatchObject({ dir: 'self', loopRight: false, word: 'Transform' });
    expect(transform!.span.left + transform!.span.width).toBeCloseTo((2.5 / 3) * 100);
    expect(transform!.span.left).toBeCloseTo((0.75 / 3) * 100);
  });

  it('a lone lane: a loop runs from its line to the figure edge, never past it', () => {
    const one = layoutFlow({
      participants: [FLOW.participants[1]!],
      steps: [{ n: 1, from: 'api', to: 'api', kind: 'validate', label: 'x', pr: null, files: [] }],
    });
    expect(one.rows[0]!.span).toEqual({ left: 50, width: 50 });
    expect(one.rows[0]!.loopRight).toBe(true);
  });

  it('every step reads as one sentence', () => {
    expect(l.rows[0]!.text).toBe('Step 1, Call: from Rates page to Rates route — currency filter. Pull request acme/web #9.');
    expect(l.rows[1]!.text).toBe('Step 2, Check: in Rates route — a known currency. Pull request acme/api #4.');
  });

  it('never throws on an empty or odd flow', () => {
    expect(layoutFlow({ participants: [], steps: [] })).toEqual({ lanes: [], rows: [] });
    const dup = layoutFlow({ participants: [FLOW.participants[0]!, FLOW.participants[0]!], steps: [] });
    expect(dup.lanes).toHaveLength(1);
  });
});

describe('the refusal words', () => {
  it('say "No diagram:" and why, plainly', () => {
    expect(sequenceDiagramRefusalText('copy_only')).toBe('No diagram: this change only edits copy.');
    expect(sequenceDiagramRefusalText('no_flow', 'Claude', 'this change only renames helpers')).toBe(
      'No diagram: this change only renames helpers.',
    );
    expect(sequenceDiagramRefusalText('no_flow', 'Claude', null)).toBe('No diagram: no data moves through this change.');
  });
});
