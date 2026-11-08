// THE PLAN PANEL'S AND THE STACK VIEW'S PURE HALF (lib/buildPlan.ts; docs/STORY-BUILD.md § Plan first).
//
// Pins: "Approve and start" is enabled only on a live session waiting for the reader whose latest
// revision has every point answered (and the one line that says why not); presses in flight lay over the
// server's answers and a second press on the chosen answer clears it; the stage line; the dropped line;
// the evidence labels and the GitHub link (only for a well-formed repository and sha); the stack's
// "builds on" / "after" words; which planned PR may be pushed now (the one before it in its repository
// pushed, an empty one skipped over, a cross-repository dependency pushed) and what Push all reaches.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/buildPlan.test.ts
import { describe, expect, it } from 'vitest';
import type { BuildPlanEvidence, BuildPlanPr, BuildPlanRevision, BuildPlanView, StoryBuildPr, StoryBuildSession } from '@pierre-review/shared';
import {
  contentionsHeading,
  decisionsWithPending,
  droppedLine,
  evidenceGithubUrl,
  evidenceLabel,
  excerptLines,
  nextDecision,
  planApproveState,
  planStageLine,
  previousInRepo,
  prPushState,
  prsByRepo,
  pushAllPrCount,
  stackRows,
} from '../src/lib/buildPlan.js';

const at = '2026-11-08T10:00:00.000Z';

const code: BuildPlanEvidence = {
  kind: 'code',
  repoId: 1,
  fullName: 'acme/api',
  path: 'src/export.js',
  startLine: 12,
  endLine: 13,
  baseSha: 'abc1234def',
  excerpt: 'const MAX_EXPORT_ROWS = 500;\nexport { MAX_EXPORT_ROWS };\n',
  linesCorrected: false,
};

function revision(o: Partial<BuildPlanRevision> = {}): BuildPlanRevision {
  return {
    revision: 2,
    source: 'reply',
    createdAt: at,
    summary: 'Add CSV export.',
    repos: [{ repoId: 1, fullName: 'acme/api', why: 'The endpoint.' }],
    criteria: [{ ref: 'AC1', text: 'A button.', status: 'planned', how: 'Add it.', prs: ['P1'], openPoints: [] }],
    contentions: [
      { id: 'C1', fingerprint: 'f1', about: ['AC2'], storySays: '10,000 rows', problem: 'The cap is 500.', proposal: 'Stream.', ifKept: 'Raise the cap.', evidence: [code] },
      { id: 'C2', fingerprint: 'f2', about: ['AC3'], storySays: null, problem: 'No such report.', proposal: 'Drop it.', ifKept: 'Add it.', evidence: [code] },
    ],
    stack: [],
    stackReason: null,
    ticketUpdate: null,
    dropped: { contentions: 0, evidence: 0, reasons: [] },
    ...o,
  };
}

function view(o: Partial<BuildPlanView> = {}): BuildPlanView {
  return {
    latest: revision(),
    revisions: 2,
    decisions: {},
    replies: [],
    unanswered: 2,
    approvedRevision: null,
    approvedAt: null,
    status: 'ready',
    problem: null,
    withDocs: false,
    fillGaps: false,
    ...o,
  };
}

type S = Pick<StoryBuildSession, 'phase' | 'live' | 'agentState' | 'plan'>;
const sess = (o: Partial<S> = {}): S => ({ phase: 'plan_ready', live: true, agentState: 'ready', plan: view(), ...o });

describe('Approve and start', () => {
  it('waits for every point to be answered, on a live session waiting for the reader', () => {
    expect(planApproveState(sess())).toEqual({ shown: true, enabled: false, reason: '2 points still to answer.' });
    const one = { C1: { decision: 'agree' as const, at } };
    expect(planApproveState(sess({ plan: view({ decisions: one }) })).reason).toBe('1 point still to answer.');
    const both = { ...one, C2: { decision: 'keep_story' as const, at } };
    expect(planApproveState(sess({ plan: view({ decisions: both }) }))).toEqual({ shown: true, enabled: true, reason: null });
  });

  it('reads the answers as shown (presses in flight) when given', () => {
    expect(planApproveState(sess(), { C1: 'agree', C2: 'agree' }).enabled).toBe(true);
  });

  it('a plan with no points needs no answer', () => {
    expect(planApproveState(sess({ plan: view({ latest: revision({ contentions: [] }) }) })).enabled).toBe(true);
  });

  it('says why not: closed, a turn running, or the agent not waiting', () => {
    const answered = view({ decisions: { C1: { decision: 'agree', at }, C2: { decision: 'agree', at } } });
    expect(planApproveState(sess({ plan: answered, live: false })).reason).toBe('Resume the session first.');
    expect(planApproveState(sess({ plan: answered, phase: 'revising' })).reason).toBe('The agent is revising the plan.');
    expect(planApproveState(sess({ plan: answered, agentState: 'stopped' })).enabled).toBe(false);
  });

  it('is not shown without a revision, once approved, or on a session without a plan', () => {
    expect(planApproveState(sess({ plan: view({ latest: null }) })).shown).toBe(false);
    expect(planApproveState(sess({ plan: view({ approvedRevision: 2 }) })).shown).toBe(false);
    expect(planApproveState(sess({ plan: null })).shown).toBe(false);
  });
});

describe('decisions', () => {
  it('lays presses in flight over the server, a null one clearing', () => {
    const server = { C1: { decision: 'agree' as const, at }, C2: { decision: 'agree' as const, at } };
    expect(decisionsWithPending(server, { C1: 'keep_story', C2: null })).toEqual({ C1: 'keep_story' });
  });

  it('a second press on the chosen answer clears it', () => {
    expect(nextDecision('agree', 'agree')).toBeNull();
    expect(nextDecision('agree', 'keep_story')).toBe('keep_story');
    expect(nextDecision(undefined, 'agree')).toBe('agree');
  });

  it('counts the answered points in the heading', () => {
    expect(contentionsHeading(revision().contentions, { C2: 'agree' })).toBe('Points to settle (1 of 2 answered)');
  });
});

describe('the plan stage line', () => {
  it('names what the agent reads, the docs when it has them', () => {
    expect(planStageLine(view({ status: 'planning', latest: null }))).toBe('The agent is reading the ticket and the code to make a plan.');
    expect(planStageLine(view({ status: 'planning', latest: null, withDocs: true }))).toBe('The agent is reading the ticket and the code and the docs to make a plan.');
    expect(planStageLine(view({ status: 'planning', latest: null, fillGaps: true }))).toContain('the gaps');
    expect(planStageLine(view({ status: 'revising' }))).toBe('The agent is revising the plan.');
    expect(planStageLine(view({ status: 'ready' }))).toBeNull();
  });

  it("says why the plan failed Limn's checks, in one sentence", () => {
    expect(planStageLine(view({ status: 'failed', latest: null, problem: 'AC2 has no line.' }))).toBe("The plan did not pass Limn's checks: AC2 has no line.");
  });

  it('counts what Limn left out, never the claims', () => {
    expect(droppedLine({ contentions: 1, evidence: 3, reasons: ['x'] })).toBe('Limn left out 1 point it could not check.');
    expect(droppedLine({ contentions: 0, evidence: 2, reasons: [] })).toBe('Limn left out 2 pieces of evidence it could not check.');
    expect(droppedLine({ contentions: 0, evidence: 0, reasons: [] })).toBeNull();
  });
});

describe('evidence', () => {
  it('labels each kind with where it is', () => {
    expect(evidenceLabel(code)).toEqual({ kind: 'Code', where: 'acme/api · src/export.js:12–13', note: null });
    expect(evidenceLabel({ ...code, kind: 'data_file', what: 'migration', linesCorrected: true }).note).toBe('Migration, lines moved');
    expect(
      evidenceLabel({ kind: 'data_run', run: 'svc-1', stack: 'dev', service: 'postgres', command: ['psql', '-c', 'select 1'], exitCode: 0, at, excerpt: '1' }),
    ).toEqual({ kind: 'Data', where: 'postgres in dev', note: 'Query run, exit 0' });
  });

  it('links the lines on GitHub at the base commit, only for a well-formed repository and sha', () => {
    expect(evidenceGithubUrl(code)).toBe('https://github.com/acme/api/blob/abc1234def/src/export.js#L12-L13');
    expect(evidenceGithubUrl({ ...code, path: 'a b/c#d.js', startLine: 4, endLine: 4 })).toBe('https://github.com/acme/api/blob/abc1234def/a%20b/c%23d.js#L4');
    expect(evidenceGithubUrl({ ...code, fullName: 'javascript:alert(1)//x' })).toBeNull();
    expect(evidenceGithubUrl({ ...code, baseSha: 'main' })).toBeNull();
  });

  it('numbers the excerpt from its first line', () => {
    expect(excerptLines(code as Extract<BuildPlanEvidence, { kind: 'code' }>)).toEqual([
      { n: 12, text: 'const MAX_EXPORT_ROWS = 500;' },
      { n: 13, text: 'export { MAX_EXPORT_ROWS };' },
    ]);
  });
});

const planPr = (o: Partial<BuildPlanPr>): BuildPlanPr => ({
  key: 'P1',
  repoId: 1,
  fullName: 'acme/api',
  stackIndex: 1,
  title: 'T',
  contains: '',
  criteria: [],
  dependsOn: [],
  branch: 'limn/PLAT-1',
  ...o,
});

describe('the planned stack', () => {
  it('says what each PR builds on in its repository and what it waits for elsewhere', () => {
    const rows = stackRows([
      planPr({ key: 'P1' }),
      planPr({ key: 'P2', stackIndex: 2, dependsOn: ['P1'] }),
      planPr({ key: 'P3', repoId: 2, fullName: 'acme/web', dependsOn: ['P2'] }),
    ]);
    expect(rows.map((r) => [r.n, r.key, r.buildsOn, r.after])).toEqual([
      [1, 'P1', null, null],
      [2, 'P2', 'Builds on P1', null],
      [3, 'P3', null, 'After P2'],
    ]);
  });
});

const pr = (o: Partial<StoryBuildPr>): StoryBuildPr => ({
  id: 1,
  key: 'P1',
  repoId: 1,
  fullName: 'acme/api',
  position: 0,
  stackIndex: 1,
  title: 'T',
  contains: '',
  criteria: [],
  dependsOn: [],
  branch: 'limn/PLAT-1',
  status: 'ready',
  error: null,
  stat: { files: 1, insertions: 2, deletions: 0, commits: 1 },
  filesChanged: ['a.js'],
  summary: null,
  checks: null,
  reported: null,
  pushedBranch: null,
  pushedPrNumber: null,
  pushedPrUrl: null,
  pushError: null,
  ...o,
});

describe('pushing the stack', () => {
  const p1 = pr({ id: 1, key: 'P1' });
  const p2 = pr({ id: 2, key: 'P2', position: 1, stackIndex: 2 });
  const p3 = pr({ id: 3, key: 'P3', position: 2, repoId: 2, fullName: 'acme/web', dependsOn: ['P2'] });

  it('offers Push only once the PR before it in its repository is pushed', () => {
    expect(prPushState(p1, [p1, p2, p3])).toEqual({ canPush: true, reason: null });
    expect(prPushState(p2, [p1, p2, p3])).toEqual({ canPush: false, reason: 'Push P1 first.' });
    expect(prPushState(p2, [{ ...p1, status: 'pushed' }, p2, p3]).canPush).toBe(true);
  });

  it('skips over an empty PR, and waits for a dependency in another repository', () => {
    const empty = { ...p1, status: 'empty' as const };
    expect(previousInRepo(p2, [empty, p2])).toBeNull();
    expect(prPushState(p2, [empty, p2]).canPush).toBe(true);
    expect(prPushState(p3, [p1, p2, p3]).reason).toBe("Push acme/api's P2 first.");
    expect(prPushState(p3, [p1, { ...p2, status: 'pushed' }, p3]).canPush).toBe(true);
  });

  it('offers nothing on a PR that is not ready', () => {
    expect(prPushState({ ...p1, status: 'failed' }, [p1])).toEqual({ canPush: false, reason: null });
  });

  it('Push all reaches every ready PR; the view groups them by repository in plan order', () => {
    expect(pushAllPrCount([p1, p2, { ...p3, status: 'pushed' }])).toBe(2);
    expect(prsByRepo([p3, p2, p1]).map((g) => [g.fullName, g.prs.map((p) => p.key)])).toEqual([
      ['acme/api', ['P1', 'P2']],
      ['acme/web', ['P3']],
    ]);
  });
});
