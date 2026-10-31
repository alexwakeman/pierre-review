// THE DATA-FLOW DIAGRAM'S RENDERING MODEL (lib/dataFlow.ts): lanes in stored order, one row per step in
// order, arrows between lane centres, loops for in-place steps, and every step as one sentence.
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

  it('arrows join lane centres; labels span the lanes they join', () => {
    const [call, check, read, transform, ret] = l.rows;
    expect(call).toMatchObject({ dir: 'right', self: false, word: 'Call' });
    expect(call!.arrow.left).toBeCloseTo(100 / 6);
    expect(call!.arrow.width).toBeCloseTo(100 / 3);
    expect(call!.label).toEqual({ left: 0, width: expect.closeTo(200 / 3) });
    expect(ret).toMatchObject({ dir: 'left', word: 'Return' });
    expect(read).toMatchObject({ dir: 'right', word: 'Read' });
    // A check in place: a loop opening right of its lane …
    expect(check).toMatchObject({ dir: 'self', self: true, loopRight: true, word: 'Check' });
    expect(check!.arrow.left).toBeCloseTo(50);
    // … except on the last lane, where it opens to the left and its label takes the lane before.
    expect(transform).toMatchObject({ dir: 'self', loopRight: false, word: 'Transform' });
    expect(transform!.arrow.left + transform!.arrow.width).toBeCloseTo((2.5 / 3) * 100);
    expect(transform!.label.left).toBeCloseTo(100 / 3);
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
