// Test support: a good plan and its check context (plan-check, plan-verify and the session flow tests).
import type { BuildPlanCheckContext } from './plan-check.js';

export const CTX: BuildPlanCheckContext = { criteria: ['AC1', 'AC2'], gaps: null, repos: ['acme/api', 'acme/web'], runs: ['svc-1'], docs: false, fillGaps: false };

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export function goodPlan(over: Record<string, unknown> = {}): any {
  return {
    schema: 'limn.plan/1',
    summary: 'Add the export endpoint in the API, then the button in the web app.',
    repos: [
      { repo: 'acme/api', why: 'The endpoint lives here.' },
      { repo: 'acme/web', why: 'The button lives here.' },
    ],
    criteria: [
      { ref: 'AC1', status: 'planned', how: 'Stream rows from the endpoint.', prs: ['P1'] },
      { ref: 'AC2', status: 'planned', how: 'A Download CSV button.', prs: ['P2'] },
    ],
    contentions: [
      {
        id: 'C1',
        about: ['AC1'],
        storySays: 'Stream every row',
        problem: 'The API caps exports at 1000 rows.',
        proposal: 'Page through the rows.',
        ifKept: 'Remove the cap.',
        evidence: [{ kind: 'code', repo: 'acme/api', path: 'src/export.ts', lines: [3, 4], quote: 'const MAX_ROWS = 1000;' }],
      },
    ],
    stack: [
      { id: 'P1', repo: 'acme/api', title: 'Stream the export', contains: 'The endpoint.', criteria: ['AC1'], dependsOn: [] },
      { id: 'P2', repo: 'acme/web', title: 'Add the button', contains: 'The button.', criteria: ['AC2'], dependsOn: ['P1'] },
    ],
    stackReason: null,
    ticketUpdate: { description: null, acceptanceCriteria: '1. Stream every row, in pages\n2. A Download CSV button', why: 'The API caps rows.', contentions: ['C1'] },
    ...over,
  };
}

