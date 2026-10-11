// Linear's sprint list (./linear.ts): the active cycle per team (named, paged), the issue fold
// (team key, parent as epic, labels as components, cycle name), the two fallbacks (no team with
// cycles → no_sprint_concept; none active → none_active), the cap, and the other-workspace guard.
// No request leaves the process: every answer comes from the fake transport.
import { beforeEach, describe, expect, it } from 'vitest';
import { SPRINT_TICKETS_MAX } from '@pierre-review/shared';
import type { JiraTransport, RawResponse } from '../jira/fetch.js';
import { __resetLinearBudget } from '../linear/client.js';
import type { TrackerCall } from '../types.js';
import { linearStatesOrder, listLinearCycle, toLinearSprintTicket } from './linear.js';

const ROOT = 'https://linear.app/acme';
const json = (body: unknown, status = 200): RawResponse => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

function node(n: number, over: Record<string, unknown> = {}) {
  return {
    identifier: `ENG-${n}`,
    title: `Story ${n}`,
    description: `Body ${n}\n\n## Acceptance criteria\n- It works`,
    url: `${ROOT}/issue/ENG-${n}/story`,
    createdAt: '2026-09-20T10:00:00.000Z',
    completedAt: null,
    updatedAt: '2026-10-01T10:00:00.000Z',
    state: { name: 'Todo', type: 'unstarted' },
    assignee: null,
    project: null,
    parent: { identifier: 'ENG-100', title: 'Billing' },
    labels: { nodes: [{ name: 'backend' }] },
    children: { nodes: [], pageInfo: { hasNextPage: false } },
    ...over,
  };
}

type Handler = (query: string, vars: Record<string, unknown>) => unknown;

function transport(h: Handler, log: Array<{ query: string; vars: Record<string, unknown>; auth: string }> = []): JiraTransport {
  return async (_url, headers, _o, init) => {
    const { query, variables } = JSON.parse(init?.body ?? '{}') as { query: string; variables: Record<string, unknown> };
    log.push({ query, vars: variables, auth: headers.authorization ?? '' });
    return json({ data: h(query, variables) });
  };
}

const call = (t: JiraTransport): TrackerCall => ({
  provider: 'linear',
  apiRoot: ROOT,
  credentials: { email: null, token: 'lin_api_aaaaaaaaaaaaaaaaaaaa' },
  policy: { cloud: false },
  transport: t,
});

const args = (t: JiraTransport) => ({
  call: call(t),
  projectKeys: ['ENG'],
  repos: [],
  fallbackWindow: { fromMs: Date.UTC(2026, 8, 26), toMs: Date.UTC(2026, 9, 10) },
  acSettingFor: () => null,
});

beforeEach(() => __resetLinearBudget());

describe('the issue fold', () => {
  it('team key, parent as epic, labels as components, cycle name, criteria from the body', () => {
    const t = toLinearSprintTicket(node(1), ROOT, 'Cycle 12')!;
    expect(t.key).toBe('ENG-1');
    expect(t.projectKey).toBe('ENG');
    expect(t.epic).toEqual({ key: 'ENG-100', title: 'Billing' });
    expect(t.components).toEqual(['backend']);
    expect(t.sprintName).toBe('Cycle 12');
    expect(t.status).toEqual({ name: 'Todo', category: 'new' });
    expect(t.candidates[0]?.text).toContain('It works');
    expect(t.issueUpdatedAt?.toISOString()).toBe('2026-10-01T10:00:00.000Z');
  });
  it('an issue from another Linear workspace is not this one’s', () => {
    expect(toLinearSprintTicket(node(2, { url: 'https://linear.app/other/issue/ENG-2' }), ROOT, null)).toBeNull();
  });
});

describe('listLinearCycle', () => {
  it('reads each active cycle, paged, with the raw key in Authorization', async () => {
    const log: Array<{ query: string; vars: Record<string, unknown>; auth: string }> = [];
    const t = transport((q, v) => {
      if (q.includes('LimnLinearSprintTeams'))
        return {
          teams: {
            nodes: [
              { id: 't1', key: 'ENG', cyclesEnabled: true, activeCycle: { id: 'c1', name: null, number: 12 } },
              { id: 't2', key: 'OPS', cyclesEnabled: true, activeCycle: { id: 'c2', name: 'Ops sprint', number: 3 } },
            ],
          },
        };
      if (q.includes('LimnLinearCycleIssues')) {
        if (v.id === 'c1' && v.after == null) return { cycle: { issues: { nodes: [node(1)], pageInfo: { hasNextPage: true, endCursor: 'x' } } } };
        if (v.id === 'c1') return { cycle: { issues: { nodes: [node(2)], pageInfo: { hasNextPage: false, endCursor: null } } } };
        return { cycle: { issues: { nodes: [node(3, { identifier: 'OPS-3', url: `${ROOT}/issue/OPS-3/x` })], pageInfo: { hasNextPage: false } } } };
      }
      throw new Error(`unexpected ${q}`);
    }, log);
    const r = await listLinearCycle(args(t));
    expect(r.source).toEqual({ kind: 'cycle', provider: 'linear', names: ['Cycle 12', 'Ops sprint'] });
    expect(r.tickets.map((x) => [x.key, x.sprintName])).toEqual([
      ['ENG-1', 'Cycle 12'],
      ['ENG-2', 'Cycle 12'],
      ['OPS-3', 'Ops sprint'],
    ]);
    expect(log[0]!.vars).toEqual({ keys: ['ENG'] });
    expect(log.every((l) => l.auth === 'lin_api_aaaaaaaaaaaaaaaaaaaa')).toBe(true);
  });

  it('no team with cycles on → status fallback, no_sprint_concept', async () => {
    const log: Array<{ query: string; vars: Record<string, unknown>; auth: string }> = [];
    const t = transport((q) => {
      if (q.includes('LimnLinearSprintTeams')) return { teams: { nodes: [{ id: 't1', key: 'ENG', cyclesEnabled: false, activeCycle: null }] } };
      if (q.includes('LimnLinearSprintFallback')) return { issues: { nodes: [node(4)], pageInfo: { hasNextPage: false } } };
      throw new Error(q);
    }, log);
    const r = await listLinearCycle(args(t));
    expect(r.source).toMatchObject({ kind: 'status_fallback', provider: 'linear', reason: 'no_sprint_concept' });
    expect(r.tickets[0]!.sprintName).toBeNull();
    expect(log[1]!.vars).toMatchObject({ keys: ['ENG'], from: '2026-09-26T00:00:00.000Z' });
  });

  it('cycles on but none active → none_active', async () => {
    const t = transport((q) => {
      if (q.includes('LimnLinearSprintTeams')) return { teams: { nodes: [{ id: 't1', key: 'ENG', cyclesEnabled: true, activeCycle: null }] } };
      return { issues: { nodes: [], pageInfo: { hasNextPage: false } } };
    });
    const r = await listLinearCycle(args(t));
    expect(r.source).toMatchObject({ kind: 'status_fallback', reason: 'none_active' });
    expect(r.tickets).toEqual([]);
  });

  it('cuts at the cap', async () => {
    const t = transport((q, v) => {
      if (q.includes('LimnLinearSprintTeams')) return { teams: { nodes: [{ id: 't1', key: 'ENG', cyclesEnabled: true, activeCycle: { id: 'c1', name: 'C', number: 1 } }] } };
      const page = Number(v.after ?? 0);
      return { cycle: { issues: { nodes: Array.from({ length: 50 }, (_, i) => node(page * 50 + i + 1)), pageInfo: { hasNextPage: true, endCursor: String(page + 1) } } } };
    });
    const r = await listLinearCycle(args(t));
    expect(r.tickets).toHaveLength(SPRINT_TICKETS_MAX);
    expect(r.truncated).toBe(true);
  });

  it('a list that is ONLY another workspace’s issues is a settings problem (bad_url)', async () => {
    const t = transport((q) => {
      if (q.includes('LimnLinearSprintTeams')) return { teams: { nodes: [{ id: 't1', key: 'ENG', cyclesEnabled: true, activeCycle: { id: 'c1', name: 'C', number: 1 } }] } };
      return { cycle: { issues: { nodes: [node(1, { url: 'https://linear.app/other/issue/ENG-1' })], pageInfo: { hasNextPage: false } } } };
    });
    await expect(listLinearCycle(args(t))).rejects.toMatchObject({ code: 'bad_url' });
  });

  it('no team keys → not_found, and no call is made', async () => {
    const log: Array<{ query: string; vars: Record<string, unknown>; auth: string }> = [];
    await expect(listLinearCycle({ ...args(transport(() => ({}), log)), projectKeys: [] })).rejects.toMatchObject({ code: 'not_found' });
    expect(log).toHaveLength(0);
  });
});

describe('blocking relations and the workflow order', () => {
  const rel = (type: string, n: number, state = { name: 'Todo', type: 'unstarted' }) => ({
    type,
    issue: { identifier: `ENG-${n}`, title: `Dep ${n}`, url: `${ROOT}/issue/ENG-${n}/dep`, state },
  });

  it('an inverse "blocks" relation is a blocker of THIS issue; other types are not; the state id is kept', () => {
    const t = toLinearSprintTicket(
      node(1, {
        state: { id: 'st-2', name: 'In Progress', type: 'started' },
        inverseRelations: { nodes: [rel('blocks', 7), rel('related', 8), rel('duplicate', 9), rel('blocks', 10, { name: 'Done', type: 'completed' }), rel('blocks', 7)] },
      }) as never,
      ROOT,
      'Cycle 5',
    )!;
    expect(t.status).toEqual({ name: 'In Progress', category: 'indeterminate', id: 'st-2' });
    expect(t.blockedBy).toEqual([
      { key: 'ENG-7', title: 'Dep 7', status: 'Todo', category: 'new', relation: 'blocked by', url: `${ROOT}/issue/ENG-7/dep` },
      { key: 'ENG-10', title: 'Dep 10', status: 'Done', category: 'done', relation: 'blocked by', url: `${ROOT}/issue/ENG-10/dep` },
    ]);
    // No selection → the key is absent (the stored links stand).
    expect('blockedBy' in toLinearSprintTicket(node(2) as never, ROOT, null)!).toBe(false);
  });

  it('orders the teams’ states by category then position, active-cycle team first, names deduped', () => {
    const o = linearStatesOrder(
      [
        {
          key: 'ENG',
          states: {
            nodes: [
              { id: 'd', name: 'Done', type: 'completed', position: 0 },
              { id: 'r', name: 'In Review', type: 'started', position: 2 },
              { id: 'p', name: 'In Progress', type: 'started', position: 1 },
              { id: 't', name: 'Todo', type: 'unstarted', position: 5 },
              { id: 'b', name: 'Backlog', type: 'backlog', position: 0 },
            ],
          },
        },
        { key: 'OPS', states: { nodes: [{ id: 'x', name: 'todo', type: 'unstarted', position: 0 }, { id: 'q', name: 'QA', type: 'started', position: 9 }] } },
      ],
      'T',
    );
    expect(o?.source).toBe('linear_states');
    expect(o?.statuses.map((s) => `${s.name}:${s.category}`)).toEqual([
      'Backlog:new',
      'Todo:new',
      'In Progress:indeterminate',
      'In Review:indeterminate',
      'Done:done',
      'QA:indeterminate',
    ]);
    expect(linearStatesOrder([{ key: 'ENG' }], 'T')).toBeNull();
  });

  it('the list read selects inverse relations and the teams’ states, and returns the order', async () => {
    const log: Array<{ query: string; vars: Record<string, unknown>; auth: string }> = [];
    const t = transport((q) => {
      if (q.includes('LimnLinearSprintTeams')) {
        return {
          teams: {
            nodes: [
              {
                id: 'T1',
                key: 'ENG',
                cyclesEnabled: true,
                activeCycle: { id: 'C1', name: 'Cycle 5', number: 5 },
                states: { nodes: [{ id: 's1', name: 'Todo', type: 'unstarted', position: 0 }, { id: 's2', name: 'In Progress', type: 'started', position: 1 }] },
              },
            ],
          },
        };
      }
      return { cycle: { issues: { nodes: [node(1)], pageInfo: { hasNextPage: false, endCursor: null } } } };
    }, log);
    const r = await listLinearCycle(args(t));
    expect(log[0]!.query).toContain('states(first: 50) { nodes { id name type position } }');
    expect(log[1]!.query).toContain('inverseRelations(first: 10)');
    expect(log[1]!.query).toContain('state { id name type }');
    expect(r.statusOrder?.statuses.map((s) => s.name)).toEqual(['Todo', 'In Progress']);
  });
});
