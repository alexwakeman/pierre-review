import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SPRINT_PATHS_CAPS,
  SPRINT_PATHS_VERSION,
  type SprintColumn,
  type SprintGraphEdge,
  type SprintGraphNode,
  type SprintGraphPr,
  type SprintStage,
} from '@pierre-review/shared';
import {
  pathsBackedOff,
  runsTodayOf,
  sprintChains,
  sprintPaceOf,
  sprintPathsInput,
  sprintPathsOf,
  sprintPathsStatusOf,
  sprintPeopleOf,
  type SprintPathsInput,
  type SprintPathsRow,
} from '../../db/sprint-paths.js';
import { runSprintAfterRead } from '../sprint-briefs/index.js';
import { judgePathsSubmission, sprintPathsToolPolicy, type SprintPathsAgentResult } from './agent.js';
import { pathsFailureOf, resetSprintPathsPasses, runSprintPathsPass } from './manager.js';
import { SPRINT_PATHS_SYSTEM, sprintPathsPrompt } from './prompt.js';
import { NO_NUMERALS, validateSprintPaths } from './validate.js';

// THE SPRINT BUILDER (docs/CLAUDE-REVIEW.md § Sprint paths): the code-built input and its hash, the
// validator (digits, keys, caps, ghosts), the tool's judgement and policy, the pass (currency, backoff,
// daily cap, store), the after-read chain's order, the pace and the people. Pure — no DB, no model.

const pr = (prId: number, state: SprintGraphPr['state'], o: Partial<SprintGraphPr> = {}): SprintGraphPr => ({
  prId,
  number: prId,
  repoFullName: 'o/r',
  title: 't',
  state,
  draft: false,
  ciState: null,
  url: 'u',
  author: null,
  ...o,
});
const I = (k: string) => `jira:x#${k}`;
const N = (key: string, stage: SprintStage | null, o: Partial<SprintGraphNode> = {}): SprintGraphNode => ({
  ident: I(key),
  key,
  title: `Title of ${key}`,
  url: null,
  provider: 'jira',
  ghost: false,
  depth: 0,
  status: null,
  stage,
  bucketId: stage,
  column: stage,
  issueType: null,
  assignee: null,
  epic: null,
  brief: { state: 'current', summary: null, oneLiner: null, criteriaCount: 0, criteriaDerived: false },
  check: null,
  checkRunning: false,
  prs: [],
  degree: 0,
  theme: null,
  ...o,
});
const edge = (from: string, to: string, kind: SprintGraphEdge['kind'] = 'depends_on', why: string | null = null): SprintGraphEdge => ({
  from: I(from),
  to: I(to),
  kind,
  source: 'text',
  quote: null,
  why,
});
const COLUMNS: SprintColumn[] = [
  { id: 'not_started', name: 'To do', meaning: 'not_started' },
  { id: 'in_progress', name: 'Doing', meaning: 'in_progress' },
  { id: 'in_review', name: 'Code review', meaning: 'in_review' },
  { id: 'product_review', name: 'QA and sign-off', meaning: 'product_review' },
  { id: 'done', name: 'Done', meaning: 'done' },
];

function fixture() {
  const nodes = [
    N('BMD-1080', 'in_progress', { theme: 'GeoPackage', assignee: { name: 'Sinan Goktas', avatarUrl: null }, prs: [pr(1, 'open', { ciState: 'failure' })] }),
    N('BMD-1081', 'not_started', { theme: 'GeoPackage', brief: { state: 'current', summary: 'Export layers.', oneLiner: 'Export layers', criteriaCount: 2, criteriaDerived: false } }),
    N('BMD-1090', 'in_review', { column: 'product_review', prs: [pr(2, 'merged')], assignee: { name: 'Colin', avatarUrl: null } }),
    N('BMD-1091', 'done', { prs: [pr(3, 'merged')] }),
    N('BMD-1096', 'in_progress', { ghost: true, depth: 1, status: { name: 'In Progress', category: 'indeterminate' } }),
    N('BMD-2000', 'not_started', { ghost: true, depth: 2 }),
  ];
  const edges = [
    edge('BMD-1081', 'BMD-1080', 'depends_on', 'Needs the GeoPackage writer.'),
    edge('BMD-1080', 'BMD-1096', 'depends_on'),
    edge('BMD-1096', 'BMD-2000', 'depends_on'),
    edge('BMD-1090', 'BMD-1091', 'builds_on'),
  ];
  return { nodes, edges };
}
const inputOf = (o: Partial<Parameters<typeof sprintPathsInput>[0]> = {}): SprintPathsInput => {
  const { nodes, edges } = fixture();
  return sprintPathsInput({ sprintName: 'Sprint 15', nodes, edges, columns: COLUMNS, timing: { day: 4, days: 14, daysLeft: 10 }, ...o });
};

describe('sprintPathsInput', () => {
  it('lists sprint tickets, the outside tickets they lean on, links with their why, chains and the pace', () => {
    const input = inputOf();
    expect(input.keys).toEqual(['BMD-1080', 'BMD-1081', 'BMD-1090', 'BMD-1091', 'BMD-1096']);
    // A ghost two hops out (only a ghost depends on it) is not listed.
    expect(input.keys).not.toContain('BMD-2000');
    expect(input.identByKey['BMD-1096']).toBe(I('BMD-1096'));
    expect(input.text).toContain('Sprint day: 4 of 14; days left after today: 10');
    expect(input.text).toContain('Columns, left to right: To do (not started) · Doing (in progress) · Code review · QA and sign-off (product review) · Done (complete)');
    expect(input.text).toContain('- BMD-1080 | title: Title of BMD-1080 | type: not known | theme: GeoPackage | column: Doing (in progress) | assigned | pull requests: 1 open, 1 with failing checks');
    // Moved there by the merge rule: drawn — and described — in the Product review column.
    expect(input.text).toContain('column: QA and sign-off (product review)');
    expect(input.text).toContain('in product review: 1');
    expect(input.text).toContain('summary: Export layers.');
    expect(input.text).toContain('- BMD-1081 depends on BMD-1080: Needs the GeoPackage writer.');
    expect(input.text).toContain('- BMD-1090 builds on BMD-1091');
    expect(input.text).toContain('- BMD-1096 | title: Title of BMD-1096 | status: In Progress (not complete) | outside the sprint');
    expect(input.text).toContain('- (more work outside the sprint) → BMD-1096 → BMD-1080 → BMD-1081');
    expect(input.text).toContain('dependency chains: 1 found, 1 listed below');
    // No person is named to the model.
    expect(input.text).not.toContain('Sinan');
    expect(input.text).not.toContain('Colin');
    expect(input.eligible).toBe(true);
  });

  it('the hash: stable, blind to the day facts, moved by a PR state or a version-worthy change', () => {
    const a = inputOf();
    expect(inputOf().inputHash).toBe(a.inputHash);
    expect(inputOf({ timing: { day: 9, days: 14, daysLeft: 5 } }).inputHash).toBe(a.inputHash);
    expect(inputOf({ timing: null }).inputHash).toBe(a.inputHash);
    const { nodes, edges } = fixture();
    const moved = nodes.map((n) => (n.key === 'BMD-1080' ? { ...n, prs: [pr(1, 'merged')] } : n));
    expect(sprintPathsInput({ sprintName: 'Sprint 15', nodes: moved, edges, columns: COLUMNS }).inputHash).not.toBe(a.inputHash);
    expect(inputOf({ sprintName: 'Sprint 16' }).inputHash).not.toBe(a.inputHash);
  });

  it('a ticket’s type and epic are stated, so code supplies "design work" rather than the title', () => {
    const { nodes, edges } = fixture();
    const typed = nodes.map((n) => (n.key === 'BMD-1081' ? { ...n, issueType: 'Design', epic: { key: 'BMD-1', title: 'Offline maps' } } : n));
    const text = sprintPathsInput({ sprintName: null, nodes: typed, edges, columns: COLUMNS }).text;
    expect(text).toContain('- BMD-1081 | title: Title of BMD-1081 | type: Design | epic: Offline maps | theme: GeoPackage');
    expect(sprintPathsInput({ sprintName: null, nodes: typed, edges, columns: COLUMNS }).inputHash).not.toBe(inputOf({ timing: null, sprintName: null }).inputHash);
  });

  it('a chain with an unlisted ticket at its DEPENDENT end keeps its listed run, both cut ends marked', () => {
    const { nodes, edges } = fixture();
    // A ghost three hops out that depends on a sprint ticket: the longest chain starts there.
    const more = [...nodes, N('BMD-3000', 'not_started', { ghost: true, depth: 2 })];
    const text = sprintPathsInput({ sprintName: null, nodes: more, edges: [...edges, edge('BMD-3000', 'BMD-1081')], columns: COLUMNS }).text;
    expect(text).not.toContain('- BMD-3000 |');
    expect(text).toContain('- (more work outside the sprint) → BMD-1096 → BMD-1080 → BMD-1081 → (more work outside the sprint)');
    expect(text).toContain('dependency chains: 1 found, 1 listed below');
  });

  it('too few sprint tickets: not eligible', () => {
    const { nodes, edges } = fixture();
    expect(sprintPathsInput({ sprintName: null, nodes: nodes.slice(0, 2), edges, columns: COLUMNS }).eligible).toBe(false);
  });
});

describe('validateSprintPaths', () => {
  const input = inputOf();
  const good = {
    paths: [
      { title: 'Export after the writer', tickets: ['BMD-1096', 'BMD-1080', 'BMD-1081'], advice: 'Get the writer reviewed this week.', risk: 'medium' },
      { title: 'Red checks on the writer', tickets: ['bmd-1080'], advice: 'Fix the failing checks first.', risk: 'high' },
    ],
    callouts: [{ title: 'Merged, not signed off', tickets: ['BMD-1090'] }],
  };

  it('accepts a good answer: keys canonicalised, ghosts allowed, paths ranked high first', () => {
    const v = validateSprintPaths(good, input);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.paths.map((p) => p.risk)).toEqual(['high', 'medium']);
    expect(v.value.paths[0]!.tickets).toEqual(['BMD-1080']);
    expect(v.value.paths[1]!.tickets).toEqual(['BMD-1096', 'BMD-1080', 'BMD-1081']);
    expect(v.value.callouts).toEqual([{ title: 'Merged, not signed off', tickets: ['BMD-1090'] }]);
    // Empty lists are a valid answer; an absent callouts is [].
    expect(validateSprintPaths({ paths: [] }, input)).toEqual({ ok: true, value: { paths: [], callouts: [] } });
  });

  const refused = (payload: unknown): string[] => {
    const v = validateSprintPaths(payload, input);
    return v.ok ? [] : v.problems;
  };
  const withPath = (p: Record<string, unknown>) => ({ paths: [{ ...good.paths[0], ...p }], callouts: [] });

  it('digits: ASCII, other Unicode numerals and ticket keys are all refused in titles and advice', () => {
    expect(refused(withPath({ advice: 'Three of 5 tickets wait.' })).join()).toMatch(/digit or numeral/);
    expect(refused(withPath({ title: 'Wait on BMD-1096' })).join()).toMatch(/digit or numeral/);
    expect(refused(withPath({ advice: 'Day ٣ is late.' })).join()).toMatch(/digit or numeral/);
    expect(refused(withPath({ advice: 'Phase Ⅻ.' })).join()).toMatch(/digit or numeral/);
    expect(refused({ paths: [], callouts: [{ title: 'Top ³', tickets: ['BMD-1090'] }] }).join()).toMatch(/digit or numeral/);
    expect(NO_NUMERALS.test('No numbers here.')).toBe(true);
  });

  it('keys: unknown, unlisted ghosts and duplicates are refused; no empty paths', () => {
    expect(refused(withPath({ tickets: ['BMD-9999'] })).join()).toMatch(/"BMD-9999" is not a ticket key in the map/);
    expect(refused(withPath({ tickets: ['BMD-2000'] })).join()).toMatch(/not a ticket key/);
    expect(refused(withPath({ tickets: ['BMD-1080', 'bmd-1080'] })).join()).toMatch(/listed twice/);
    expect(refused(withPath({ tickets: [] })).join()).toMatch(/at least one ticket key/);
    expect(refused({ paths: [], callouts: [{ title: 'Empty', tickets: [] }] }).join()).toMatch(/at least one ticket key/);
  });

  it('caps, risk, plain text and shape', () => {
    const many = Array.from({ length: SPRINT_PATHS_CAPS.maxPaths + 1 }, () => good.paths[0]);
    expect(refused({ paths: many, callouts: [] }).join()).toMatch(/send at most 5/);
    const calls = Array.from({ length: SPRINT_PATHS_CAPS.maxCallouts + 1 }, () => good.callouts[0]);
    expect(refused({ paths: [], callouts: calls }).join()).toMatch(/at most 3/);
    expect(refused(withPath({ title: 'x'.repeat(SPRINT_PATHS_CAPS.titleChars + 1) })).join()).toMatch(/keep it to 40/);
    expect(refused(withPath({ advice: 'x'.repeat(SPRINT_PATHS_CAPS.adviceChars + 1) })).join()).toMatch(/keep it to 200/);
    expect(refused(withPath({ risk: 'severe' })).join()).toMatch(/"risk" must be/);
    expect(refused(withPath({ advice: 'Read **this** first.' })).join()).toMatch(/plain text/);
    expect(refused(withPath({ advice: 'See https://example.com now.' })).join()).toMatch(/plain text/);
    expect(refused(withPath({ title: '   ' })).join()).toMatch(/missing or empty/);
    expect(refused('nope').join()).toMatch(/must be an object/);
    expect(refused({ paths: 'x' }).join()).toMatch(/"paths" must be a list/);
    const tooMany = Array.from({ length: SPRINT_PATHS_CAPS.pathTickets + 1 }, () => 'BMD-1080');
    expect(refused(withPath({ tickets: tooMany })).join()).toMatch(/keep it to 12/);
  });

  it('the tool: a refusal lists what to fix; the last attempt says stop', () => {
    const j = judgePathsSubmission(withPath({ advice: 'Ship 3 things.' }), 1, input);
    expect('reply' in j && j.reply).toMatch(/^Refused:\n- Path 1: "advice" contains a digit/);
    expect('reply' in j && j.reply).toMatch(/call submit_paths again/);
    const last = judgePathsSubmission(withPath({ advice: 'Ship 3 things.' }), SPRINT_PATHS_CAPS.maxSubmits, input);
    expect('reply' in last && last.reply).toMatch(/last attempt; stop now/);
    expect(judgePathsSubmission(good, 1, input)).toHaveProperty('accepted');
  });

  it('the tool policy: only submit_paths; Bash and every file tool denied', () => {
    const p = sprintPathsToolPolicy();
    expect(p.tools).toEqual([]);
    expect(p.allowedTools).toEqual(['mcp__paths__submit_paths']);
    for (const t of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch']) expect(p.disallowedTools).toContain(t);
  });

  it('the prompt: the map sits inside the nonce fence; the system prompt bans digits', () => {
    const text = sprintPathsPrompt(input, 'n0nce');
    expect(text).toContain('---BEGIN SPRINT MAP n0nce---\n');
    expect(text.endsWith('---END SPRINT MAP n0nce---')).toBe(true);
    expect(SPRINT_PATHS_SYSTEM).toMatch(/NO digits/);
  });
});

describe('the stored row → the wire', () => {
  const row = (o: Partial<SprintPathsRow> = {}): SprintPathsRow => ({
    inputHash: 'h',
    pathsVersion: SPRINT_PATHS_VERSION,
    pathsJson: { paths: [{ title: 'A', tickets: ['K-1', 'K-404'], advice: 'Do it.', risk: 'high' }, { title: 'B', tickets: ['K-404'], advice: 'x', risk: 'low' }], callouts: [] },
    writtenAt: new Date('2026-10-17T10:00:00Z'),
    attemptAt: null,
    attemptHash: null,
    attemptError: null,
    runsDay: null,
    runsToday: 0,
    ...o,
  });
  it('resolves idents from keys; drops what no longer resolves', () => {
    const p = sprintPathsOf(row(), (k) => (k === 'K-1' ? I('K-1') : null));
    expect(p).toEqual({ paths: [{ title: 'A', tickets: ['K-1'], idents: [I('K-1')], advice: 'Do it.', risk: 'high' }], callouts: [], createdAt: '2026-10-17T10:00:00.000Z' });
    expect(sprintPathsOf(row({ pathsJson: null, writtenAt: null }), () => null)).toBeNull();
  });
  it('the backoff and the day count', () => {
    expect(pathsBackedOff(row({ attemptHash: 'h', attemptError: 'refused' }), 'h')).toBe(true);
    expect(pathsBackedOff(row({ attemptHash: 'h', attemptError: 'refused' }), 'other')).toBe(false);
    expect(pathsBackedOff(row({ attemptHash: 'h', attemptError: null }), 'h')).toBe(false);
    expect(runsTodayOf(row({ runsDay: '2026-10-17', runsToday: 4 }), new Date('2026-10-17T23:00:00Z'))).toBe(4);
    expect(runsTodayOf(row({ runsDay: '2026-10-16', runsToday: 4 }), new Date('2026-10-17T01:00:00Z'))).toBe(0);
  });
  it('the status fold', () => {
    const base = { aiEnabled: true, canRun: true, eligible: true, inputHash: 'h', row: null, hasPaths: false, running: false, queued: false, capped: false };
    expect(sprintPathsStatusOf(base).state).toBe('waiting');
    expect(sprintPathsStatusOf({ ...base, row: row(), hasPaths: true })).toMatchObject({ state: 'current', stale: false });
    expect(sprintPathsStatusOf({ ...base, row: row({ inputHash: 'old' }), hasPaths: true, running: true })).toMatchObject({ state: 'writing', stale: true });
    expect(sprintPathsStatusOf({ ...base, row: row({ inputHash: 'old', attemptHash: 'h', attemptError: 'stopped' }), hasPaths: true })).toMatchObject({ state: 'failed', failure: 'stopped' });
    expect(sprintPathsStatusOf({ ...base, capped: true })).toMatchObject({ state: 'failed', failure: 'daily_cap' });
    expect(sprintPathsStatusOf({ ...base, canRun: false }).state).toBe('none');
    expect(sprintPathsStatusOf({ ...base, aiEnabled: false }).state).toBe('none');
  });
});

describe('the pace', () => {
  it('counts sprint tickets only; time from the sprint window', () => {
    const { nodes, edges } = fixture();
    expect(sprintPaceOf(nodes, edges, { day: 4, days: 14, daysLeft: 10 })).toEqual({
      daysElapsed: 4,
      daysTotal: 14,
      timeUsedPct: 29,
      tickets: 4,
      live: 3,
      done: 1,
      productReview: 1,
      codeMerged: 2,
      // BMD-1081 → BMD-1080 and BMD-1080 → BMD-1096 (a ghost → ghost link is not the sprint's).
      openDependencies: 2,
      chains: 1,
    });
    expect(sprintPaceOf(nodes, edges, null)).toMatchObject({ daysElapsed: null, daysTotal: null, timeUsedPct: null });
    expect(sprintChains(nodes, edges)).toEqual([[I('BMD-1081'), I('BMD-1080'), I('BMD-1096'), I('BMD-2000')]]);
  });
});

describe('the people', () => {
  it('one entry per assignee; a mapped login gives a number (0 included), an unmapped one null', () => {
    const nodes = [
      N('A-1', 'in_progress', { assignee: { name: 'Sinan Goktas', avatarUrl: null }, prs: [pr(1, 'open', { author: { login: 'sinangoktas', name: null, isBot: false } })] }),
      N('A-2', 'in_progress', { assignee: { name: 'sinan.goktas', avatarUrl: null } }),
      N('A-3', 'not_started', { assignee: { name: 'Colin', avatarUrl: null } }),
      N('A-4', 'not_started', { assignee: { name: 'Dee', avatarUrl: null }, prs: [pr(2, 'open', { author: { login: 'dee-gh', name: 'Dee', isBot: false } })] }),
      // A GitHub-only author is not an assignee: not listed.
      N('A-5', 'not_started', { prs: [pr(3, 'open', { author: { login: 'stranger', name: null, isBot: false } })] }),
    ];
    const waiting = new Map([['sinangoktas', new Set([10, 11])], ['stranger', new Set([12])]]);
    expect(sprintPeopleOf(nodes, waiting)).toEqual([
      { name: 'Colin', names: ['Colin'], reviewsWaiting: null },
      { name: 'Dee', names: ['Dee'], reviewsWaiting: 0 },
      { name: 'Sinan Goktas', names: ['Sinan Goktas', 'sinan.goktas'], reviewsWaiting: 2 },
    ]);
  });
});

describe('runSprintPathsPass', () => {
  const ctx = {
    log: { info: vi.fn(), warn: vi.fn() } as never,
    llm: { detectAuth: () => ({ status: 'ok' as const }) },
    recordAiUsage: vi.fn(async () => undefined),
  };
  const input = inputOf();
  const agentOut = (o: Partial<SprintPathsAgentResult> = {}): SprintPathsAgentResult => ({
    accepted: { paths: [{ title: 'Writer first', tickets: ['BMD-1080'], advice: 'Review the writer.', risk: 'high' }], callouts: [] },
    lastRefusal: null,
    subtype: 'success',
    costUsd: 0.12,
    inputTokens: 100,
    outputTokens: 20,
    runtimeMissing: false,
    error: null,
    ...o,
  });
  const seams = (o: Record<string, unknown> = {}) => {
    const calls = { store: [] as unknown[], attempts: [] as unknown[], runs: 0, runner: 0 };
    return {
      calls,
      s: {
        aiEnabled: true,
        entitled: async () => true,
        todo: async () => input,
        row: async () => null,
        store: async (_a: number, _w: number, h: string, v: unknown) => void calls.store.push([h, v]),
        recordAttempt: async (_a: number, _w: number, h: string, e: unknown) => void calls.attempts.push([h, e]),
        noteRun: async () => void (calls.runs += 1),
        runner: async () => {
          calls.runner += 1;
          return agentOut();
        },
        dailyCap: 12,
        applyAuthEnv: async () => false,
        ...o,
      },
    };
  };
  beforeEach(() => {
    resetSprintPathsPasses();
    ctx.recordAiUsage.mockClear();
  });

  it('stores a validated answer, records the attempt, counts the run, records spend as sprint_paths', async () => {
    const { calls, s } = seams();
    const r = await runSprintPathsPass(ctx, 1, 2, s);
    expect(r).toMatchObject({ state: 'done', paths: 1, costUsd: 0.12 });
    expect(calls.runs).toBe(1);
    expect(calls.store).toHaveLength(1);
    expect(calls.attempts).toEqual([[input.inputHash, null]]);
    expect(ctx.recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: 'sprint_paths', seam: 'agent', model: 'claude-sonnet-5', costUsd: 0.12 }));
  });

  it('current, backed off and capped inputs never call Claude', async () => {
    const stored = { inputHash: input.inputHash, pathsVersion: SPRINT_PATHS_VERSION, pathsJson: { paths: [], callouts: [] }, writtenAt: new Date(), attemptAt: null, attemptHash: null, attemptError: null, runsDay: null, runsToday: 0 };
    for (const [row, state] of [
      [stored, 'current'],
      [{ ...stored, inputHash: 'old', attemptHash: input.inputHash, attemptError: 'refused' }, 'backoff'],
      [{ ...stored, inputHash: 'old', runsDay: new Date().toISOString().slice(0, 10), runsToday: 12 }, 'capped'],
    ] as const) {
      const { calls, s } = seams({ row: async () => row });
      expect((await runSprintPathsPass(ctx, 1, 2, s)).state).toBe(state);
      expect(calls.runner).toBe(0);
      expect(calls.runs).toBe(0);
    }
  });

  it('a run that stored nothing records its failure (the backoff) and never loops', async () => {
    for (const [out, failure] of [
      [agentOut({ accepted: null, lastRefusal: 'digits' }), 'refused'],
      [agentOut({ accepted: null, subtype: 'error_max_turns' }), 'stopped'],
      [agentOut({ accepted: null }), 'no_submit'],
      [agentOut({ accepted: null, runtimeMissing: true, error: 'missing' }), 'error'],
      // The answer is validated AGAIN before storing: a key the input never listed is refused.
      [agentOut({ accepted: { paths: [{ title: 'X', tickets: ['NOPE-1'], advice: 'x', risk: 'high' }], callouts: [] } }), 'refused'],
    ] as const) {
      const { calls, s } = seams({ runner: async () => { calls.runner += 1; return out; } });
      const r = await runSprintPathsPass(ctx, 1, 2, s);
      expect(r).toMatchObject({ state: 'failed', failure });
      expect(calls.runner).toBe(1);
      expect(calls.store).toEqual([]);
      expect(calls.attempts).toEqual([[input.inputHash, failure]]);
    }
  });

  it('gates: AI off, no credential, busy, no tracker, too few', async () => {
    expect((await runSprintPathsPass(ctx, 1, 2, seams({ aiEnabled: false }).s)).state).toBe('off');
    expect((await runSprintPathsPass({ ...ctx, llm: { detectAuth: () => ({ status: 'none' as const }) } }, 1, 2, seams().s)).state).toBe('no_credential');
    expect((await runSprintPathsPass(ctx, 1, 2, seams({ todo: async () => null }).s)).state).toBe('no_tracker');
    expect((await runSprintPathsPass(ctx, 1, 2, seams({ todo: async () => ({ ...input, eligible: false }) }).s)).state).toBe('too_few');
    let release: () => void = () => undefined;
    const slow = seams({ todo: () => new Promise<SprintPathsInput>((r) => (release = () => r(input))) });
    const first = runSprintPathsPass(ctx, 1, 2, slow.s);
    expect((await runSprintPathsPass(ctx, 1, 2, seams().s)).state).toBe('busy');
    release();
    expect((await first).state).toBe('done');
  });

  it('pathsFailureOf', () => {
    expect(pathsFailureOf(agentOut({ accepted: null, error: 'x' }))).toBe('error');
    expect(pathsFailureOf(agentOut({ accepted: null, subtype: 'error_max_budget_usd' }))).toBe('stopped');
  });
});

describe('the after-read chain', () => {
  const ctx = { log: { warn: vi.fn() } as never, llm: { detectAuth: () => ({ status: 'ok' as const }) }, recordAiUsage: async () => undefined };
  it('briefs, then themes, then paths', async () => {
    const order: string[] = [];
    await runSprintAfterRead(ctx, 1, 2, {
      briefs: async () => (order.push('briefs'), { state: 'done', stoppedBy: null }),
      themes: async () => order.push('themes'),
      paths: async () => order.push('paths'),
    });
    expect(order).toEqual(['briefs', 'themes', 'paths']);
  });
  it('a brief pass that did not finish starts nothing after it; a throw is contained', async () => {
    const order: string[] = [];
    await runSprintAfterRead(ctx, 1, 2, {
      briefs: async () => (order.push('briefs'), { state: 'busy' }),
      themes: async () => order.push('themes'),
      paths: async () => order.push('paths'),
    });
    await runSprintAfterRead(ctx, 1, 2, {
      briefs: async () => ({ state: 'done', stoppedBy: 'runtime' }),
      themes: async () => order.push('themes'),
      paths: async () => order.push('paths'),
    });
    expect(order).toEqual(['briefs']);
    await expect(
      runSprintAfterRead(ctx, 1, 2, {
        briefs: async () => ({ state: 'done' }),
        themes: async () => {
          throw new Error('boom');
        },
        paths: async () => order.push('paths'),
      }),
    ).resolves.toBeUndefined();
  });
});
