// DESIGN DIAGRAMS in the SPA: the reads poll only while something is drawing (or just after a review);
// the status line names refusals. (The grid's own fold is test/designGrid.test.ts.)
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/sequenceDiagram.test.ts
import { describe, expect, it } from 'vitest';
import type { PrSequenceDiagramsResponse, SequenceDiagramSlot, SequenceDiagramView } from '@pierre-review/shared';
import {
  AFTER_REVIEW_WAIT_MS,
  DIAGRAM_POLL_MS,
  prDiagramsPollMs,
  redrawRefusalText,
  slotStatusLine,
} from '../src/lib/sequenceDiagrams.js';

const view = (over: Partial<SequenceDiagramView> = {}): SequenceDiagramView => ({
  id: 1,
  kind: 'pr',
  prId: 7,
  ticketIdent: null,
  ticketKey: null,
  status: 'succeeded',
  trigger: 'review',
  title: 'Flow',
  caption: null,
  flow: {
    participants: [
      { id: 'a', kind: 'service', label: 'Importer', change: 'new', pr: null },
      { id: 'b', kind: 'db', label: 'rates', change: 'unchanged', pr: null },
    ],
    steps: [{ n: 1, from: 'a', to: 'b', kind: 'write', label: 'rows', pr: null, files: [] }],
  },
  design: { acts: [{ id: 'a', title: 'Import' }], layers: ['domain'], cells: [{ id: 'c', act: 'a', layer: 'domain', label: 'Parse rows', pattern: 'Pipeline', change: 'new', pr: null, files: [] }], arrows: [] },
  headSha: 'a'.repeat(40),
  members: [],
  refusal: null,
  refusalDetail: null,
  error: null,
  current: true,
  createdAt: '2026-10-16T00:00:00.000Z',
  completedAt: null,
  costUsd: null,
  ...over,
});
const resp = (pr: SequenceDiagramSlot, stories: PrSequenceDiagramsResponse['stories'] = []): PrSequenceDiagramsResponse => ({
  prId: 7,
  pr,
  stories,
});

describe('polling', () => {
  it('polls while a run is queued or running, in the PR slot or a story', () => {
    expect(prDiagramsPollMs(resp({ diagram: null, latest: view({ status: 'running', design: null }) }), null)).toBe(DIAGRAM_POLL_MS);
    const story = { ident: 'T', ticketKey: null, memberCount: 2, diagram: null, latest: view({ kind: 'story', status: 'queued' }) };
    expect(prDiagramsPollMs(resp({ diagram: view(), latest: null }, [story]), null)).toBe(DIAGRAM_POLL_MS);
  });

  it('waits a short while after a review for a diagram at the current head, then stops', () => {
    const empty = resp({ diagram: null, latest: null });
    expect(prDiagramsPollMs(empty, 1_000, 2_000)).toBe(DIAGRAM_POLL_MS);
    expect(prDiagramsPollMs(empty, 1_000, 1_000 + AFTER_REVIEW_WAIT_MS + 1)).toBe(false);
    expect(prDiagramsPollMs(resp({ diagram: view(), latest: null }), 1_000, 2_000)).toBe(false);
    expect(prDiagramsPollMs(undefined, 1_000, 2_000)).toBe(false);
  });

  it('after a review, keeps waiting for a multi-PR story whose current diagram is not stored yet', () => {
    const prDone = { diagram: view(), latest: null };
    const staleStory = { ident: 'T', ticketKey: null, memberCount: 2, diagram: view({ kind: 'story', current: false }), latest: null };
    expect(prDiagramsPollMs(resp(prDone, [staleStory]), 1_000, 2_000)).toBe(DIAGRAM_POLL_MS);
    // A docs-only PR's refused row is current, but the story still waits.
    const prRefused = { diagram: null, latest: view({ status: 'refused', refusal: 'no_code', design: null }) };
    expect(prDiagramsPollMs(resp(prRefused, [{ ...staleStory, diagram: null }]), 1_000, 2_000)).toBe(DIAGRAM_POLL_MS);
    // A single-PR ticket is never drawn, so it never holds the poll open.
    expect(prDiagramsPollMs(resp(prDone, [{ ...staleStory, memberCount: 1 }]), 1_000, 2_000)).toBe(false);
    const doneStory = { ...staleStory, diagram: view({ kind: 'story' }) };
    expect(prDiagramsPollMs(resp(prDone, [doneStory]), 1_000, 2_000)).toBe(false);
    expect(prDiagramsPollMs(resp(prDone, [staleStory]), 1_000, 1_000 + AFTER_REVIEW_WAIT_MS + 1)).toBe(false);
  });
});

describe('the status line', () => {
  it('names drawing, refusals and failures; says nothing under a good diagram', () => {
    expect(slotStatusLine({ diagram: view(), latest: null }, false)).toBeNull();
    expect(slotStatusLine({ diagram: null, latest: null }, false)).toBe('No design yet.');
    expect(slotStatusLine({ diagram: view(), latest: null }, true)).toBe('Drawing…');
    expect(slotStatusLine({ diagram: null, latest: view({ status: 'refused', refusal: 'no_code', design: null }) }, false)).toBe(
      'No diagram: this change edits no code.',
    );
    // The model's decline says its own reason; the pre-check's say theirs.
    expect(
      slotStatusLine({ diagram: null, latest: view({ status: 'refused', refusal: 'no_flow', refusalDetail: 'this change only renames helpers', design: null }) }, false),
    ).toBe('No diagram: this change only renames helpers.');
    expect(slotStatusLine({ diagram: null, latest: view({ status: 'refused', refusal: 'copy_only', design: null }) }, false)).toBe(
      'No diagram: this change only edits copy.',
    );
    expect(slotStatusLine({ diagram: view(), latest: view({ status: 'failed', design: null }) }, false)).toBe('Drawing failed.');
    expect(redrawRefusalText({ outcome: 'refused', diagramId: null, refusal: 'too_few_prs' })).toBe(
      'The story has only one pull request.',
    );
    expect(redrawRefusalText({ outcome: 'queued', diagramId: 3 })).toBeNull();
  });

  it('a refused design names the provider that RAN the drawing', () => {
    const refused = (o: Record<string, unknown>) =>
      slotStatusLine({ diagram: null, latest: view({ status: 'refused', refusal: 'invalid_diagram', design: null, ...o }) }, false);
    expect(refused({ provider: 'codex', model: 'gpt-6.1-sol' })).toBe('Codex did not return a usable design.');
    expect(refused({ provider: 'claude', model: 'claude-sonnet-5' })).toBe('Claude did not return a usable design.');
  });
});
