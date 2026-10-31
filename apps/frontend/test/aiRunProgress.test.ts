// THE PROGRESS BAR WHILE A DESIGN IS DRAWN OR A STORY IS CHECKED AGAINST THE DOCS (docs/FRONTEND.md §
// Design diagrams → Progress, § The story view → the docs check). Pinned here:
//
//   1. A drawing's bar reads the server's phase (determinate, never past the checking step while it
//      reads), with no phase (an older server) the bar eases on its own; the words follow the phase.
//   2. The docs check's bar gives each stored step its share, eased by time, and never goes backwards
//      across a step change nor reaches 100 while running.
//   3. The slot draws the bar and the status line from the STORED run (so a reload shows them), and
//      no "Drawing…" line beside them; a finished slot draws neither.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/aiRunProgress.test.ts
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SequenceDiagramSlot, SequenceDiagramView } from '@pierre-review/shared';
import { diagramProgressPct, diagramProgressText, slotRunInFlight } from '../src/lib/sequenceDiagrams.js';
import { docsProgressPct } from '../src/lib/storyDocsAlignment.js';
import { DiagramSlotView } from '../src/components/ClaudeReviewDiagrams.js';

const run = (over: Partial<SequenceDiagramView> = {}): SequenceDiagramView => ({
  id: 9,
  kind: 'story',
  prId: null,
  ticketIdent: 'jira:x#A-1',
  ticketKey: 'A-1',
  status: 'running',
  trigger: 'manual',
  title: null,
  caption: null,
  flow: null,
  design: null,
  headSha: null,
  members: [],
  refusal: null,
  refusalDetail: null,
  error: null,
  current: true,
  createdAt: new Date(Date.now() - 65_000).toISOString(),
  completedAt: null,
  costUsd: null,
  ...over,
});

describe('a drawing in progress', () => {
  it('maps each phase to a share of the bar, reading growing with its steps', () => {
    expect(diagramProgressPct(null)).toBeNull();
    expect(diagramProgressPct({ phase: 'waiting', steps: 0 })).toBe(5);
    expect(diagramProgressPct({ phase: 'preparing', steps: 0 })).toBe(15);
    expect(diagramProgressPct({ phase: 'reading', steps: 0 })).toBe(25);
    expect(diagramProgressPct({ phase: 'reading', steps: 5 })).toBe(40);
    expect(diagramProgressPct({ phase: 'reading', steps: 500 })).toBe(80);
    expect(diagramProgressPct({ phase: 'checking', steps: 9 })).toBe(88);
    expect(diagramProgressPct({ phase: 'saving', steps: 9 })).toBe(96);
  });

  it('words follow the phase, or the stored status when the server gave none', () => {
    expect(diagramProgressText(run({ progress: { phase: 'reading', steps: 3 } }), false)).toBe('Reading the code');
    expect(diagramProgressText(run({ progress: { phase: 'checking', steps: 3 } }), false)).toBe('Checking the design');
    expect(diagramProgressText(run({ status: 'queued' }), false)).toBe('Waiting to start');
    expect(diagramProgressText(run(), false)).toBe('Drawing the design');
    expect(diagramProgressText(null, true)).toBe('Starting');
  });

  it('finds the run in flight in either half of the slot', () => {
    expect(slotRunInFlight({ diagram: null, latest: run() })?.id).toBe(9);
    expect(slotRunInFlight({ diagram: run({ id: 3 }), latest: null })?.id).toBe(3);
    expect(slotRunInFlight({ diagram: run({ status: 'succeeded' }), latest: run({ status: 'failed' }) })).toBeNull();
  });
});

describe('the docs check in progress', () => {
  it('each step has its share, eased by time; never backwards, never done', () => {
    expect(docsProgressPct(null, 0)).toBeNull();
    expect(docsProgressPct('succeeded', 0)).toBeNull();
    const q = docsProgressPct('queued', 0)!;
    const s0 = docsProgressPct('shortlisting', 2_000)!;
    const s1 = docsProgressPct('shortlisting', 60_000)!;
    const r0 = docsProgressPct('reading', 61_000)!;
    const r1 = docsProgressPct('reading', 3_600_000)!;
    expect(q).toBe(3);
    expect(s0).toBeGreaterThan(q);
    expect(s1).toBeGreaterThan(s0);
    expect(s1).toBeLessThanOrEqual(40);
    expect(r0).toBeGreaterThanOrEqual(s1);
    expect(r1).toBeLessThanOrEqual(92);
  });
});

describe('the slot while drawing', () => {
  const html = (slot: SequenceDiagramSlot, redrawing = false): string =>
    renderToStaticMarkup(createElement(DiagramSlotView, { slot, redrawing, label: 'Design' }));

  it('draws the bar and the phase line from the stored run, and no "Drawing…" line', () => {
    const out = html({ diagram: null, latest: run({ progress: { phase: 'reading', steps: 5 } }) });
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-label="Drawing the design"');
    expect(out).toContain('aria-valuenow="40"');
    expect(out).toContain('Reading the code…');
    // The clock runs from the run's own row (65 s ago), not from mount.
    expect(out).toMatch(/1:0[4-6]/);
    expect(out).not.toContain('Drawing…');
  });

  it('a finished slot draws no bar, only its line', () => {
    const out = html({ diagram: null, latest: run({ status: 'failed', error: 'x' }) });
    expect(out).not.toContain('role="progressbar"');
    expect(out).toContain('Drawing failed.');
  });
});
