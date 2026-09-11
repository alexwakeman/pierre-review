// The transient AI-Fix run registry — what the bottom-right AiFixBanner renders.
//
// It is a store slice with three writers and one hazard each:
//   - `noteAiFixRun` is called BEFORE the POST, from a card the reader may leave in the same
//     breath. A re-run must reuse the row rather than stack a second one: one PR runs one fix
//     at a time (the plugin's `claimed` set makes that a fact), so two rows for one PR would be
//     two watchers of one paid run.
//   - `setAiFixRunStatus` runs from a per-row effect on every SSE frame. It must be a NO-OP on
//     an unchanged status, or the effect writes the store on every heartbeat and re-renders the
//     column forever.
//   - `dismissAiFixRun` removes the row. Nothing else may.
//
// Neither directory runs in CI (see CLAUDE.md § Known gaps). By hand:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import { useFilters } from '../src/store/filters.js';

const PR = {
  prId: 42,
  repoFullName: 'acme/api',
  prNumber: 7,
  prTitle: 'Fix the flaky test',
};

describe('aiFixRuns', () => {
  beforeEach(() => {
    useFilters.setState({ aiFixRuns: {} });
  });

  it('starts empty — the banner is seeded only by a start this session performed', () => {
    expect(useFilters.getState().aiFixRuns).toEqual({});
  });

  it('records a run as queued, carrying the coordinates the row needs to link back', () => {
    useFilters.getState().noteAiFixRun(PR);
    const row = useFilters.getState().aiFixRuns[42];
    expect(row?.status).toBe('queued');
    expect(row?.repoFullName).toBe('acme/api');
    expect(row?.prNumber).toBe(7);
    expect(row?.prTitle).toBe('Fix the flaky test');
    expect(row?.startedAt).toBeGreaterThan(0);
  });

  it('re-running one PR keeps ONE row and resets it to queued', () => {
    useFilters.getState().noteAiFixRun(PR);
    useFilters.getState().setAiFixRunStatus(42, 'failed');
    useFilters.getState().noteAiFixRun(PR);
    expect(Object.keys(useFilters.getState().aiFixRuns)).toEqual(['42']);
    expect(useFilters.getState().aiFixRuns[42]?.status).toBe('queued');
  });

  it('keeps one row per PR and orders by start time — the stream cap takes the oldest', () => {
    useFilters.getState().noteAiFixRun({ ...PR, prId: 1 });
    useFilters.getState().noteAiFixRun({ ...PR, prId: 2 });
    const rows = Object.values(useFilters.getState().aiFixRuns).sort(
      (a, b) => a.startedAt - b.startedAt,
    );
    expect(rows.map((r) => r.prId)).toEqual([1, 2]);
  });

  it('does not touch state when the status is unchanged', () => {
    useFilters.getState().noteAiFixRun(PR);
    const before = useFilters.getState().aiFixRuns;
    useFilters.getState().setAiFixRunStatus(42, 'queued');
    // Identity, not deep equality: a fresh object here is a re-render of the whole column on
    // every SSE heartbeat.
    expect(useFilters.getState().aiFixRuns).toBe(before);
  });

  it('ignores a status for a PR it is not tracking', () => {
    useFilters.getState().setAiFixRunStatus(999, 'succeeded');
    expect(useFilters.getState().aiFixRuns).toEqual({});
  });

  it('drops the row on dismiss, and only then', () => {
    useFilters.getState().noteAiFixRun(PR);
    useFilters.getState().setAiFixRunStatus(42, 'succeeded');
    expect(useFilters.getState().aiFixRuns[42]?.status).toBe('succeeded');
    useFilters.getState().dismissAiFixRun(42);
    expect(useFilters.getState().aiFixRuns[42]).toBeUndefined();
  });
});
