// SEQUENCE DIAGRAMS in the SPA: Mermaid's config stays STRICT and follows the app's tokens; the reads
// poll only while something is drawing (or just after a review); the status line names refusals.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/sequenceDiagram.test.ts
import { describe, expect, it } from 'vitest';
import type { PrSequenceDiagramsResponse, SequenceDiagramSlot, SequenceDiagramView } from '@pierre-review/shared';
import { channelsToHex, mermaidConfig, readMermaidTokens } from '../src/lib/mermaidTheme.js';
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
  diagramType: 'sequenceDiagram',
  source: 'sequenceDiagram\n A->>B: x',
  headSha: 'a'.repeat(40),
  members: [],
  refusal: null,
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

describe('mermaid config', () => {
  it('is strict, with plain-text labels and no auto start', () => {
    const c = mermaidConfig(readMermaidTokens(() => '', false), false);
    expect(c.securityLevel).toBe('strict');
    expect(c.htmlLabels).toBe(false);
    expect(c.flowchart.htmlLabels).toBe(false);
    expect(c.startOnLoad).toBe(false);
    expect(c.theme).toBe('base');
  });

  it('reads the --ai-* channels, falling back per theme', () => {
    expect(channelsToHex('250 250 248', '#000000')).toBe('#fafaf8');
    expect(channelsToHex('nope', '#123456')).toBe('#123456');
    const dark = readMermaidTokens(() => '', true);
    expect(dark.ink).toBe('#dcdcd6');
    const live = readMermaidTokens((n) => (n === '--ai-ink' ? '1 2 3' : ''), false);
    expect(live.ink).toBe('#010203');
    expect(mermaidConfig(dark, true).themeVariables.darkMode).toBe(true);
  });
});

describe('polling', () => {
  it('polls while a run is queued or running, in the PR slot or a story', () => {
    expect(prDiagramsPollMs(resp({ diagram: null, latest: view({ status: 'running', source: null }) }), null)).toBe(DIAGRAM_POLL_MS);
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
});

describe('the status line', () => {
  it('names drawing, refusals and failures; says nothing under a good diagram', () => {
    expect(slotStatusLine({ diagram: view(), latest: null }, false)).toBeNull();
    expect(slotStatusLine({ diagram: null, latest: null }, false)).toBe('No diagram yet.');
    expect(slotStatusLine({ diagram: view(), latest: null }, true)).toBe('Drawing…');
    expect(slotStatusLine({ diagram: null, latest: view({ status: 'refused', refusal: 'no_code', source: null }) }, false)).toBe(
      'No code changed, so there is no flow to draw.',
    );
    expect(slotStatusLine({ diagram: view(), latest: view({ status: 'failed', source: null }) }, false)).toBe('Drawing failed.');
    expect(redrawRefusalText({ outcome: 'refused', diagramId: null, refusal: 'too_few_prs' })).toBe(
      'The story has only one pull request.',
    );
    expect(redrawRefusalText({ outcome: 'queued', diagramId: 3 })).toBeNull();
  });
});
