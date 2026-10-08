import { describe, expect, it } from 'vitest';
import type { BlastSignals, WorkspaceMergedReach, WorkspaceReachPr } from '@pierre-review/shared';
import { blastRadius, resolveBlastConfig } from '../src/lib/ui.js';
import { REACH_MAX_REPOS, foldWorkspaceReach } from '../src/components/Activity/reachModel.js';

// Reach by repository — the pure fold over the pull requests MERGED in the reporting window.
// Pinned: every level comes from the ONE `blastRadius()` resolver (so the Settings dial repaints
// without a refetch), an unmeasured PR is counted apart and never drawn, the cap is disclosed on
// both measures, and every printed total covers the SHOWN rows only.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend

const DEFAULTS = resolveBlastConfig(null);

const signals = (over: Partial<BlastSignals> = {}): BlastSignals => ({
  codeFiles: 2,
  testFiles: 0,
  nonCodeFiles: 0,
  dirs: 1,
  subsystems: 1,
  surfaces: [],
  allNew: false,
  hubDegree: null,
  hubBar: null,
  hubPath: null,
  truncated: false,
  contentKind: null,
  ...over,
});

let seq = 0;
const pr = (repoId: number, s: Partial<BlastSignals> | null, codeLoc: number | null = 40): WorkspaceReachPr => ({
  id: ++seq,
  repoId,
  blast: s == null ? null : signals(s),
  codeLoc,
  codeLocIsLowerBound: false,
});

const reach = (prs: WorkspaceReachPr[], truncated = false): WorkspaceMergedReach => ({
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-08T00:00:00.000Z',
  prs,
  truncated,
});

const repos = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  fullName: `acme/r${String(i + 1).padStart(2, '0')}`,
  workspaceId: 7,
}));

describe('foldWorkspaceReach', () => {
  it('levels every merged PR through blastRadius(), and counts an unmeasured one apart', () => {
    const rows = [
      pr(1, {}), // small → low
      pr(1, { surfaces: ['db_migration'] }), // a surface → high
      pr(1, null, null), // never measured → not drawn
      pr(2, {}),
    ];
    const out = foldWorkspaceReach(reach(rows), repos, 7, DEFAULTS);
    const r1 = out.repos.find((r) => r.repoId === 1)!;
    expect(r1.merged).toBe(3);
    expect(r1.unread).toBe(1);
    expect(r1.read).toBe(2);
    expect(r1.low + r1.medium + r1.high).toBe(r1.read);
    expect(r1.high).toBe(blastRadius(rows[1]!, DEFAULTS)?.level === 'high' ? 1 : 0);
    expect(out.merged).toBe(4);
    expect(out.unread).toBe(1);
    // Ranked by merges, so repo 1 leads.
    expect(out.repos.map((r) => r.repoFullName)).toEqual(['acme/r01', 'acme/r02']);
  });

  it('repaints from the config alone — a different dial moves the level with the same rows', () => {
    // 700 code lines: under the balanced HIGH bar (1,000), over the cautious one (600).
    const rows = [pr(1, { codeFiles: 5, dirs: 2 }, 700)];
    const balanced = foldWorkspaceReach(reach(rows), repos, 7, DEFAULTS);
    const cautious = foldWorkspaceReach(
      reach(rows),
      repos,
      7,
      resolveBlastConfig({ sensitivity: 'cautious', surfacesOff: [] }),
    );
    expect(balanced.repos[0]!.high).toBe(0);
    expect(cautious.repos[0]!.high).toBe(1);
  });

  it('caps the list, and names what it cut on the ranking AND the drawn measure', () => {
    const rows: WorkspaceReachPr[] = [];
    // 14 repositories with strictly descending merges; the two smallest carry the high-reach PRs.
    for (let i = 0; i < 14; i++) {
      for (let n = 0; n < 15 - i; n++) rows.push(pr(i + 1, i >= 12 ? { surfaces: ['db_migration'] } : {}));
    }
    const out = foldWorkspaceReach(reach(rows), repos, 7, DEFAULTS);
    expect(out.repos).toHaveLength(REACH_MAX_REPOS);
    expect(out.repoCount).toBe(14);
    expect(out.omitted).toEqual({ repos: 2, merged: 3 + 2, high: 5, read: 5 });
    // Every printed total covers the SHOWN rows only.
    expect(out.merged).toBe(out.repos.reduce((n, r) => n + r.merged, 0));
  });

  it('an empty window is an answer, not null — and the membership is still counted', () => {
    const out = foldWorkspaceReach(reach([]), repos, 7, DEFAULTS);
    expect(out.repoCount).toBe(0);
    expect(out.merged).toBe(0);
    expect(out.workspaceRepos).toBe(20);
  });

  it('carries the server row-cap flag through', () => {
    expect(foldWorkspaceReach(reach([pr(1, {})], true), repos, 7, DEFAULTS).truncated).toBe(true);
  });
});
