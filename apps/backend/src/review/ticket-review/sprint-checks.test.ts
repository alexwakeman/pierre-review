// This Sprint's refresh → ticket checks (sprint-checks.ts), over fake deps. Pinned: only tickets with an
// open or merged PR; skip a current check, a running one, a held one, an identical failed attempt and
// a member count over the cap; never-checked first, then newest activity; at most `max` started, always
// 'manual'; no credential / no credits starts nothing and says why.
import { describe, expect, it } from 'vitest';
import { TICKET_REVIEW_MAX_PRS, type SprintGraphPr } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import type { TicketStateInputs } from './persist.js';
import type { StartTicketArgs } from './manager.js';
import { orderSprintChecks, runSprintTicketChecks, type SprintCheckDeps, type SprintCheckLive } from './sprint-checks.js';
import type { LiveMember } from './fingerprint.js';

const pr = (prId: number, state: SprintGraphPr['state']): SprintGraphPr => ({
  prId,
  number: prId,
  repoFullName: 'o/r',
  title: `PR ${prId}`,
  state,
  draft: false,
  ciState: null,
  url: '',
  author: null,
});
const member = (prId: number, updatedMs: number, state: 'open' | 'merged' = 'open'): LiveMember => ({
  prId,
  headSha: 'h',
  state,
  repoId: 1,
  number: prId,
  title: '',
  updatedAt: new Date(updatedMs),
});
const live = (fp: string, members: LiveMember[]): SprintCheckLive => ({ fingerprint: fp, members, ticketKey: null, ticketTitle: null });
const state = (o: Partial<{ latestFp: string; latestId: number; running: number; attempt: { id: number; fp: string } }>): TicketStateInputs => ({
  latest:
    o.latestFp != null
      ? { id: o.latestId ?? 1, fingerprint: o.latestFp, ticketHash: 'h', alignment: null, assessment: null, completedAt: null, members: [] }
      : null,
  runningRunId: o.running ?? null,
  latestAttempt: o.attempt != null ? { id: o.attempt.id, status: 'failed', fingerprint: o.attempt.fp, refused: null } : null,
});

const ctx = (auth: 'ok' | 'none' = 'ok', blocked = false): AgentContext =>
  ({
    log: { warn: () => {}, info: () => {}, error: () => {} },
    llm: { detectAuth: () => ({ status: auth, message: '' }) },
    aiCredits: { check: async () => ({ agentBlocked: blocked }) },
  }) as unknown as AgentContext;

function deps(over: Partial<SprintCheckDeps> = {}): SprintCheckDeps & { started: StartTicketArgs[] } {
  const started: StartTicketArgs[] = [];
  const tickets = [
    // A-1: never checked, older activity.
    { ident: 'A-1', key: 'A-1', title: 'A1', prs: [pr(1, 'open')] },
    // A-2: stale check, newest activity.
    { ident: 'A-2', key: 'A-2', title: 'A2', prs: [pr(2, 'merged')] },
    // A-3: current check — skipped.
    { ident: 'A-3', key: 'A-3', title: 'A3', prs: [pr(3, 'open')] },
    // A-4: only a closed PR — not a candidate.
    { ident: 'A-4', key: 'A-4', title: 'A4', prs: [pr(4, 'closed')] },
    // A-5: running — skipped.
    { ident: 'A-5', key: 'A-5', title: 'A5', prs: [pr(5, 'open')] },
    // A-6: failed on these very inputs — skipped.
    { ident: 'A-6', key: 'A-6', title: 'A6', prs: [pr(6, 'open')] },
    // A-7: never checked, newest activity → first.
    { ident: 'A-7', key: 'A-7', title: 'A7', prs: [pr(7, 'merged'), pr(70, 'open')] },
    // A-8: too many members — skipped.
    { ident: 'A-8', key: 'A-8', title: 'A8', prs: [pr(8, 'open')] },
    // A-9: held in this process — skipped.
    { ident: 'A-9', key: 'A-9', title: 'A9', prs: [pr(9, 'open')] },
  ];
  const lives: Record<string, SprintCheckLive | null> = {
    'A-1': live('f1', [member(1, 1_000)]),
    'A-2': live('f2-new', [member(2, 9_000, 'merged')]),
    'A-3': live('f3', [member(3, 5_000)]),
    'A-5': live('f5', [member(5, 5_000)]),
    'A-6': live('f6', [member(6, 5_000)]),
    'A-7': live('f7', [member(7, 8_000, 'merged'), member(70, 7_000)]),
    'A-8': live('f8', Array.from({ length: TICKET_REVIEW_MAX_PRS + 1 }, (_, i) => member(800 + i, 5_000))),
    'A-9': live('f9', [member(9, 5_000)]),
  };
  const states = new Map<string, TicketStateInputs>([
    ['A-2', state({ latestFp: 'f2-old' })],
    ['A-3', state({ latestFp: 'f3' })],
    ['A-5', state({ running: 44 })],
    ['A-6', state({ latestFp: 'f6-old', latestId: 1, attempt: { id: 2, fp: 'f6' } })],
  ]);
  const d: SprintCheckDeps & { started: StartTicketArgs[] } = {
    started,
    candidates: async () => tickets,
    states: async () => states,
    live: async (_a, ident) => lives[ident] ?? null,
    held: (_a, ident) => ident === 'A-9',
    start: async (a) => {
      started.push(a);
      return { outcome: 'queued', runId: started.length };
    },
    ...over,
  };
  return d;
}

describe('runSprintTicketChecks', () => {
  it('never checked first (newest activity first), then stale; skips current, running, held, failed-identical, over-cap', async () => {
    const d = deps();
    const r = await runSprintTicketChecks(ctx(), 1, 5, { deps: d, max: 10 });
    expect(r).toEqual({ started: 3, skipped: null });
    expect(d.started.map((s) => s.ident)).toEqual(['A-7', 'A-1', 'A-2']);
    expect(d.started.every((s) => s.trigger === 'manual' && s.workspaceId === 5 && s.accountId === 1)).toBe(true);
    // The run starts from an OPEN PR of this workspace when there is one, else the newest merged.
    expect(d.started.map((s) => s.originPrId)).toEqual([70, 1, 2]);
  });

  it('caps at `max` (the default is SPRINT_REFRESH_TICKET_CHECKS)', async () => {
    const d = deps();
    expect(await runSprintTicketChecks(ctx(), 1, 5, { deps: d, max: 2 })).toEqual({ started: 2, skipped: null });
    expect(d.started.map((s) => s.ident)).toEqual(['A-7', 'A-1']);
  });

  it('a full lane stops early; already-running answers are not counted', async () => {
    let n = 0;
    const d = deps({ start: async () => (++n === 1 ? { outcome: 'already_running', runId: null } : { outcome: 'busy' }) });
    expect(await runSprintTicketChecks(ctx(), 1, 5, { deps: d })).toEqual({ started: 0, skipped: null });
    expect(n).toBe(2);
  });

  it('no credential: nothing starts, and it says why', async () => {
    const a = deps();
    expect(await runSprintTicketChecks(ctx('none'), 1, 5, { deps: a })).toEqual({ started: 0, skipped: 'no_credential' });
    expect(a.started).toEqual([]);
  });

  it('never throws', async () => {
    const d = deps({
      candidates: async () => {
        throw new Error('db gone');
      },
    });
    expect(await runSprintTicketChecks(ctx(), 1, 5, { deps: d })).toEqual({ started: 0, skipped: null });
  });

  it('orderSprintChecks is deterministic on ties', () => {
    const p = (ident: string, never: boolean, newestMs: number) => ({ ident, never, newestMs, live: live('f', []), originPrId: 1 });
    expect(orderSprintChecks([p('B', false, 5), p('A', false, 5), p('C', true, 1)]).map((x) => x.ident)).toEqual(['C', 'A', 'B']);
  });
});
