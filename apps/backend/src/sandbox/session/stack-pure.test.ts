// THE PURE PARTS OF BUILDING TO AN APPROVED STACK (docs/STORY-BUILD.md § Plan first → Stacks). Pinned:
//   • the build turn's words: one branch line per planned PR, the "make each branch from the previous one"
//     line only for a real stack, the build report, Fill gaps' focus;
//   • THE build report validator: the shape rules, every planned PR and criterion covered; the checker
//     embeds the SAME text the host compiles;
//   • the extraction's stdout parser (tips, missing, dirty, too large, the bundle last);
//   • per-repository grouping, the PR a stacked PR builds on (an empty PR skipped), the decisions a PR's
//     body names, the stacked title and the body's Part list.
import { describe, expect, it } from 'vitest';
import type { BuildPlanRevision } from '@pierre-review/shared';
import { BUILD_REPORT_VALIDATOR_SOURCE, buildReportCheckerSource, buildReportFiles, validateBuildReport } from '../workspace/build-report.js';
import { planBuildInstruction } from './plan.js';
import { parseStackExtract } from './stack.js';
import { groupByRepo } from './stack-turn.js';
import { decisionsFor, previousInRepo } from '../../coding/story-build/push-stack.js';
import { storyBuildPrBody, storyBuildStackTitle } from '../../coding/story-build/push.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const row = (o: Record<string, unknown>): any => ({ id: 1, repoId: 1, prKey: 'P1', stackIndex: 1, position: 0, status: 'ready', ...o });

describe('the build turn after Approve', () => {
  const stack = [
    { key: 'P1', fullName: 'acme/api', branch: 'limn/acme-1', stackIndex: 1 },
    { key: 'P2', fullName: 'acme/api', branch: 'limn/acme-1-2', stackIndex: 2 },
    { key: 'P3', fullName: 'acme/web', branch: 'limn/acme-1', stackIndex: 1 },
  ];
  it('names each PR\'s branch, says how to stack, and asks for the build report', () => {
    const t = planBuildInstruction({ revision: 3, root: '/workspace', ticketChanged: false, extra: null, stack });
    expect(t).toContain('  - P1: `limn/acme-1` in acme/api\n  - P2: `limn/acme-1-2` in acme/api, made from the branch of the pull request before it\n  - P3: `limn/acme-1` in acme/web');
    expect(t).toContain('make each branch from the previous one');
    expect(t).toContain('Leave the LAST branch of each repository checked out');
    expect(t).toContain('write `/workspace/.limn/build-report.json`');
    expect(t).toContain('`node /home/agent/.limn/build-report-check.cjs`');
    expect(t).not.toContain('Build only the gaps');
  });
  it('one PR per repository: no stacking line; Fill gaps: the gaps only', () => {
    const t = planBuildInstruction({ revision: 1, root: '/workspace', ticketChanged: true, extra: 'Be brief.', stack: [stack[0]!, stack[2]!], fillGaps: true });
    expect(t).not.toContain('make each branch from the previous one');
    expect(t).toContain('- Build only the gaps PLAN.md plans. Do not redo what the existing pull requests deliver.');
    expect(t).toMatch(/^TICKET\.md was read again just now/);
    expect(t).toContain('The reader adds:\n````text\nBe brief.\n````');
  });
});

describe('the build report', () => {
  const ctx = { prs: ['P1', 'P2'], criteria: ['AC1', 'AC2'] };
  const good = {
    prs: [
      { id: 'P1', status: 'done', summary: 'Did it.', checks: [{ command: 'npm test', result: 'passed' }] },
      { id: 'P2', status: 'partly', summary: 'Half.', checks: [] },
    ],
    criteria: [
      { ref: 'AC1', status: 'met', how: 'x' },
      { ref: 'ac2', status: 'not_met', how: 'y' },
    ],
  };
  it('passes a complete report', () => {
    expect(validateBuildReport(good, ctx)).toEqual({ report: good, problems: [] });
  });
  it('names each problem', () => {
    const bad = { prs: [{ id: 'P9', status: 'ok', summary: '', checks: [{ command: 'x', result: 'green' }] }], criteria: [{ ref: 'AC1', status: 'met', how: 'x' }] };
    const r = validateBuildReport(bad, ctx);
    expect(r.report).toBeNull();
    expect(r.problems).toEqual([
      '"prs"[0].id must be one of P1, P2 (PLAN.md).',
      '"prs"[0].status must be done, partly or not_done.',
      '"prs"[0].summary must be a non-empty string of at most 2000 characters.',
      '"prs"[0].checks[0].result must be passed, failed or not_run.',
      'P1 is not in "prs".',
      'P2 is not in "prs".',
      'AC2 is not in "criteria".',
    ]);
    expect(validateBuildReport([], ctx).problems).toEqual(['The report must be one JSON object.']);
  });
  it('⚠ the checker embeds THE validator text the host compiles; Approve copies it with its context', () => {
    const src = buildReportCheckerSource({ reportFile: '/w/.limn/build-report.json', contextFile: '/w/.limn/build-context.json' });
    expect(src).toContain(`const validateBuildReport = ${BUILD_REPORT_VALIDATOR_SOURCE};`);
    const files = buildReportFiles('/workspace', ctx);
    expect(files.map((f) => f.path)).toEqual(['/workspace/.limn/build-context.json', '/home/agent/.limn/build-report-check.cjs']);
    expect(JSON.parse(files[0]!.content)).toEqual(ctx);
    expect(files[1]!.mode).toBe(0o755);
  });
});

describe('the extraction\'s stdout', () => {
  it('reads tips, missing branches, dirty work and the bundle (last, to the end)', () => {
    const a = 'a'.repeat(40);
    const out = [
      '@@LIMN-STACK@@ tip',
      `1 ${a}`,
      '@@LIMN-STACK@@ missing',
      '2 limn/x-2',
      '@@LIMN-STACK@@ dirty',
      '0 main',
      '@@LIMN-STACK@@ bundle',
      Buffer.from('# v2 git bundle\n@@LIMN-STACK@@ tip\n').toString('base64'),
      '',
    ].join('\n');
    const r = parseStackExtract(out);
    expect([...r.tips]).toEqual([[1, a]]);
    expect([...r.missing]).toEqual([[2, 'limn/x-2']]);
    expect(r.dirty).toEqual([{ k: 0, branch: 'main' }]);
    expect(r.bundle!.toString()).toBe('# v2 git bundle\n@@LIMN-STACK@@ tip\n');
    expect(parseStackExtract('@@LIMN-STACK@@ toolarge\n9000000\n').tooLargeBytes).toBe(9_000_000);
    // A tip that is not a sha, or a k out of range, is ignored.
    expect(parseStackExtract('@@LIMN-STACK@@ tip\n1 nope\n@@LIMN-STACK@@ tip\n7 ' + a + '\n').tips.size).toBe(0);
  });
});

describe('stacks', () => {
  it('groups per repository in stack order; a stacked PR builds on the nearest earlier PR with changes', () => {
    const rows = [row({ id: 3, repoId: 2, prKey: 'P3', position: 2 }), row({ id: 2, prKey: 'P2', stackIndex: 2, position: 1, status: 'empty' }), row({ id: 4, prKey: 'P4', stackIndex: 3, position: 3 }), row({ id: 1 })];
    const g = groupByRepo(rows);
    expect([...g.keys()]).toEqual([1, 2]);
    expect(g.get(1)!.map((r: any) => r.prKey)).toEqual(['P1', 'P2', 'P4']);
    expect(previousInRepo(rows, rows[2])?.prKey).toBe('P1');
    expect(previousInRepo(rows, rows[3])).toBeNull();
  });

  it('a PR\'s body names the decisions touching its criteria, and those touching no planned PR', () => {
    const rev = {
      stack: [{ criteria: ['AC1'] }, { criteria: ['AC2'] }],
      contentions: [
        { id: 'C1', about: ['AC1'], problem: 'p1', proposal: 'q1' },
        { id: 'C2', about: ['AC2'], problem: 'p2', proposal: 'q2' },
        { id: 'C3', about: ['AC9'], problem: 'p3', proposal: 'q3' },
        { id: 'C4', about: ['AC1'], problem: 'p4', proposal: 'q4' },
      ],
    } as unknown as BuildPlanRevision;
    const d = { C1: { decision: 'agree' }, C2: { decision: 'keep_story' }, C3: { decision: 'keep_story' } };
    expect(decisionsFor(rev, d, ['AC1'])).toEqual([
      { kind: 'changed', text: 'q1' },
      { kind: 'kept', text: 'p3' },
    ]);
  });

  it('the stacked title keeps the key first; the body lists the parts', () => {
    expect(storyBuildStackTitle('ACME-1', 2, 3, '  Log   refunds ')).toBe('ACME-1 (2/3): Log refunds');
    const body = storyBuildPrBody({
      summary: 'S.',
      ticketKey: 'ACME-1',
      ticketTitle: 'T',
      ticketUrl: null,
      covers: [{ ref: 'AC2', text: 'Logged' }],
      siblings: [{ fullName: 'acme/x', number: 9, url: null }],
      stackedOnPrNumber: null,
      closes: null,
      stack: {
        position: 2,
        total: 2,
        parts: [
          { fullName: 'acme/api', title: 'Endpoint [v2]', number: 5, url: 'https://github.com/acme/api/pull/5', self: false },
          { fullName: 'acme/api', title: 'Log', number: null, url: null, self: true },
        ],
        buildsOnNumber: 5,
      },
      decisions: [{ kind: 'kept', text: 'Ping @ops' }],
    });
    expect(body).toContain('**Part 2 of 2:**\n1. [acme/api — Endpoint v2](https://github.com/acme/api/pull/5) (#5)\n2. acme/api — Log (this pull request)\n\nBuilds on #5.');
    expect(body).toContain('**Decisions on the story:**\n- Kept the story: Ping @​ops');
    // The Part list replaces the sibling list.
    expect(body).not.toContain('Other pull requests for this story');
  });
});
