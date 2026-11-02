// GitHub Issues' sprint list (./github.ts): the nearest-due open milestone across the workspace's
// repos (undated after dated, overdue never), its open issues in every repo with the same title, the
// status fallback (none_active), paging, the cap, and the budget pre-emption shared with the reader.
// No request leaves the process: every answer comes from the fake `graphql` below.
import { describe, expect, it } from 'vitest';
import { SPRINT_TICKETS_MAX } from '@pierre-review/shared';
import type { GithubCallAccess, GithubGqlResult, TrackerCall } from '../types.js';
import { isMissingScope, iterationSpan, makeGithubLister, milestoneDates, pickIteration, pickMilestone, SPRINT_ITERATION_ITEMS_MAX, type IterationSighting } from './github.js';
import { busiestSprintDates } from './types.js';

const NOW = Date.UTC(2026, 9, 10, 12);

function issue(n: number) {
  return {
    number: n,
    title: `Issue ${n}`,
    url: `https://github.com/acme/web/issues/${n}`,
    state: 'OPEN',
    stateReason: null,
    body: `Body\n\n## Acceptance criteria\n- [ ] Works ${n}`,
    createdAt: '2026-09-01T00:00:00Z',
    closedAt: null,
    updatedAt: '2026-10-01T00:00:00Z',
    issueType: null,
    assignees: { nodes: [{ login: 'octo', avatarUrl: 'https://avatars.githubusercontent.com/u/1' }] },
    subIssues: { totalCount: 0, nodes: [] },
  };
}

type Handler = (query: string, vars: Record<string, unknown>) => unknown;
let accountSeq = 9000;
/** Handlers that answer the Projects queries themselves. */
const handlesProjects = new WeakSet<Handler>();
const projects = (h: Handler): Handler => {
  handlesProjects.add(h);
  return h;
};

function gh(h: Handler, log: Array<{ query: string; vars: Record<string, unknown> }> = []): GithubCallAccess {
  const accountId = (accountSeq += 1);
  return {
    accountId,
    graphql: async <T,>(query: string, vars: Record<string, unknown>): Promise<GithubGqlResult<T>> => {
      log.push({ query, vars });
      // A test that does not speak to Projects sees a workspace whose issues sit in no project.
      if (query.includes('LimnSprintIteration') && !handlesProjects.has(h)) return { data: { repository: { issues: { nodes: [] } } } as T };
      return { data: { ...(h(query, vars) as object), rateLimit: { cost: 1, remaining: 4000, resetAt: '2026-10-10T13:00:00Z' } } as T };
    },
  };
}

const call = (g: GithubCallAccess): TrackerCall => ({
  provider: 'github',
  apiRoot: 'https://github.com',
  credentials: { email: null, token: '' },
  policy: { cloud: false },
  github: g,
});

const args = (g: GithubCallAccess, repos = ['acme/web', 'acme/api']) => ({
  call: call(g),
  projectKeys: [],
  repos,
  fallbackWindow: { fromMs: Date.UTC(2026, 8, 26), toMs: NOW },
  acSettingFor: () => null,
});

const list = makeGithubLister(() => NOW);

describe('pickMilestone', () => {
  it('nearest due today-or-later wins; undated after dated; overdue never', () => {
    const pick = pickMilestone(
      [
        { repo: 'a', milestones: [{ title: 'old', dueOn: '2026-10-01T00:00:00Z', number: 1 }, { title: 'later', dueOn: '2026-11-01T00:00:00Z', number: 2 }] },
        { repo: 'b', milestones: [{ title: 'undated', dueOn: null, number: 3 }, { title: 'today', dueOn: '2026-10-10T00:00:00Z', number: 4 }] },
      ],
      NOW,
    );
    expect(pick).toEqual({ title: 'today', dueOn: '2026-10-10T00:00:00Z' });
    expect(pickMilestone([{ repo: 'a', milestones: [{ title: 'undated', dueOn: null, number: 1 }] }], NOW)).toEqual({ title: 'undated', dueOn: null });
    expect(pickMilestone([{ repo: 'a', milestones: [{ title: 'old', dueOn: '2026-01-01T00:00:00Z', number: 1 }] }], NOW)).toBeNull();
  });
});

describe('listGithubMilestone', () => {
  it('reads the picked milestone in every repo carrying the same title', async () => {
    const log: Array<{ query: string; vars: Record<string, unknown> }> = [];
    const g = gh((q, v) => {
      if (q.includes('LimnSprintMilestones')) {
        return v.name === 'web'
          ? { repository: { milestones: { nodes: [{ title: 'v2.3', dueOn: '2026-10-20T00:00:00Z', number: 7 }] } } }
          : { repository: { milestones: { nodes: [{ title: 'v2.3', dueOn: '2026-10-20T00:00:00Z', number: 2 }, { title: 'v3', dueOn: null, number: 3 }] } } };
      }
      if (q.includes('LimnSprintMilestoneIssues')) {
        return { repository: { milestone: { issues: { nodes: [issue(v.name === 'web' ? 1 : 2)], pageInfo: { hasNextPage: false } } } } };
      }
      throw new Error(q);
    }, log);
    const r = await list(args(g));
    expect(r.source).toEqual({ kind: 'milestone', provider: 'github', name: 'v2.3', dueOn: '2026-10-20T00:00:00Z', repos: ['acme/web', 'acme/api'] });
    // A milestone has an end (its due date) and no start.
    expect(r.dates).toEqual({ startsAt: null, endsAt: new Date('2026-10-20T00:00:00Z') });
    expect(r.tickets.map((t) => [t.key, t.projectKey, t.sprintName])).toEqual([
      ['acme/web#1', 'acme/web', 'v2.3'],
      ['acme/api#2', 'acme/api', 'v2.3'],
    ]);
    expect(r.tickets[0]!.candidates[0]?.text).toContain('Works 1');
    expect(r.tickets[0]!.assignee?.name).toBe('octo');
    const issueCalls = log.filter((l) => l.query.includes('LimnSprintMilestoneIssues'));
    expect(issueCalls.map((l) => l.vars.number)).toEqual([7, 2]);
  });

  it('no open milestone → open issues updated in the window, none_active', async () => {
    const log: Array<{ query: string; vars: Record<string, unknown> }> = [];
    const g = gh((q) => {
      if (q.includes('LimnSprintMilestones')) return { repository: { milestones: { nodes: [] } } };
      if (q.includes('LimnSprintFallbackIssues')) return { repository: { issues: { nodes: [issue(5)], pageInfo: { hasNextPage: false } } } };
      throw new Error(q);
    }, log);
    const r = await list(args(g, ['acme/web']));
    expect(r.source).toMatchObject({ kind: 'status_fallback', provider: 'github', reason: 'none_active' });
    expect(r.tickets.map((t) => t.sprintName)).toEqual([null]);
    expect(log.find((l) => l.query.includes('Fallback'))!.vars.since).toBe('2026-09-26T00:00:00.000Z');
  });

  it('pages and cuts at the cap', async () => {
    const g = gh((q, v) => {
      if (q.includes('LimnSprintMilestones')) return { repository: { milestones: { nodes: [{ title: 'm', dueOn: null, number: 1 }] } } };
      const page = Number(v.after ?? 0);
      return {
        repository: {
          milestone: { issues: { nodes: Array.from({ length: 50 }, (_, i) => issue(page * 50 + i + 1)), pageInfo: { hasNextPage: true, endCursor: String(page + 1) } } },
        },
      };
    });
    const r = await list(args(g, ['acme/web']));
    expect(r.tickets).toHaveLength(SPRINT_TICKETS_MAX);
    expect(r.truncated).toBe(true);
  });

  it('a malformed repo name is skipped; none left → not_found with no call', async () => {
    const log: Array<{ query: string; vars: Record<string, unknown> }> = [];
    await expect(list(args(gh(() => ({}), log), ['not a repo']))).rejects.toMatchObject({ code: 'not_found' });
    expect(log).toHaveLength(0);
  });

  it('a GitHub rate limit is the reader’s 429', async () => {
    const g: GithubCallAccess = {
      accountId: (accountSeq += 1),
      graphql: async () => ({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'limit' }] }),
    };
    await expect(list(args(g, ['acme/web']))).rejects.toMatchObject({ code: 'http', status: 429 });
  });
});


describe('sprint dates', () => {
  it('milestoneDates: the due date is the end; none → null', () => {
    expect(milestoneDates('2026-10-20T00:00:00Z')).toEqual({ startsAt: null, endsAt: new Date('2026-10-20T00:00:00Z') });
    expect(milestoneDates(null)).toBeNull();
    expect(milestoneDates('nope')).toBeNull();
  });
  it('busiestSprintDates: most tickets, ties to the earliest start; a dateless pick is null', () => {
    const d = (s: string) => new Date(s);
    expect(
      busiestSprintDates([
        { count: 2, startsAt: d('2026-10-05T00:00:00Z'), endsAt: d('2026-10-19T00:00:00Z') },
        { count: 2, startsAt: d('2026-10-01T00:00:00Z'), endsAt: d('2026-10-15T00:00:00Z') },
        { count: 1, startsAt: d('2026-09-01T00:00:00Z'), endsAt: null },
      ]),
    ).toEqual({ startsAt: d('2026-10-01T00:00:00Z'), endsAt: d('2026-10-15T00:00:00Z') });
    expect(busiestSprintDates([{ count: 3, startsAt: null, endsAt: null }, { count: 1, startsAt: d('2026-10-01T00:00:00Z'), endsAt: null }])).toBeNull();
    expect(busiestSprintDates([])).toBeNull();
  });
});


// ── GitHub Projects iterations ──────────────────────────────────────────────────────────────────

const sight = (over: Partial<IterationSighting>): IterationSighting => ({
  issue: 'acme/web#1',
  projectId: 'P1',
  projectTitle: 'Web',
  fieldId: 'F1',
  fieldName: 'Sprint',
  iterationId: 'I1',
  title: 'Sprint 7',
  startDate: '2026-10-05',
  duration: 14,
  ...over,
});

describe('pickIteration', () => {
  it('the iteration holding today wins; past and future ones never', () => {
    const p = pickIteration(
      [
        sight({ iterationId: 'past', title: 'Sprint 6', startDate: '2026-09-21', duration: 14 }),
        sight({ iterationId: 'now', title: 'Sprint 7', startDate: '2026-10-05', duration: 14 }),
        sight({ iterationId: 'next', title: 'Sprint 8', startDate: '2026-10-19', duration: 14 }),
      ],
      NOW,
    );
    expect(p).toMatchObject({ iterationId: 'now', title: 'Sprint 7', fieldName: 'Sprint', count: 1 });
    expect(p!.startsAt).toEqual(new Date('2026-10-05T00:00:00Z'));
    // The day after the last: exclusive, so the header's last day is 18 Oct.
    expect(p!.endsAt).toEqual(new Date('2026-10-19T00:00:00Z'));
  });

  it('several current: the one on the most distinct issues; ties to the earliest start, then first seen', () => {
    const many = pickIteration(
      [
        sight({ projectId: 'A', iterationId: 'a', issue: 'acme/web#1' }),
        sight({ projectId: 'A', iterationId: 'a', issue: 'acme/web#1' }),
        sight({ projectId: 'B', iterationId: 'b', issue: 'acme/web#2', title: 'Cycle B' }),
        sight({ projectId: 'B', iterationId: 'b', issue: 'acme/api#3', title: 'Cycle B' }),
      ],
      NOW,
    );
    expect(many).toMatchObject({ projectId: 'B', title: 'Cycle B', count: 2 });
    const tie = pickIteration(
      [sight({ projectId: 'A', iterationId: 'a', startDate: '2026-10-08' }), sight({ projectId: 'B', iterationId: 'b', startDate: '2026-10-06' })],
      NOW,
    );
    expect(tie?.projectId).toBe('B');
    const first = pickIteration([sight({ projectId: 'A', iterationId: 'a' }), sight({ projectId: 'B', iterationId: 'b' })], NOW);
    expect(first?.projectId).toBe('A');
  });

  it('none current, or malformed dates → null', () => {
    expect(pickIteration([], NOW)).toBeNull();
    expect(pickIteration([sight({ startDate: '2026-11-01' })], NOW)).toBeNull();
    expect(pickIteration([sight({ startDate: 'soon' }), sight({ duration: 0 })], NOW)).toBeNull();
    expect(iterationSpan('2026-10-05', 14)).toEqual({ startMs: Date.UTC(2026, 9, 5), endMs: Date.UTC(2026, 9, 19) });
  });

  it('isMissingScope: INSUFFICIENT_SCOPES or a message naming read:project', () => {
    expect(isMissingScope([{ type: 'INSUFFICIENT_SCOPES' }])).toBe(true);
    expect(isMissingScope([{ message: "requires one of the following scopes: ['read:project']" }])).toBe(true);
    expect(isMissingScope([{ type: 'FORBIDDEN' }])).toBe(false);
    expect(isMissingScope(undefined)).toBe(false);
  });
});

/** A scan answer: each issue number with the iterations it sits in. */
function scan(issues: Array<{ n: number; its: Array<Partial<{ project: string; closed: boolean; id: string; title: string; start: string; days: number }>> }>) {
  return {
    repository: {
      issues: {
        nodes: issues.map((i) => ({
          number: i.n,
          projectItems: {
            nodes: i.its.map((it) => ({
              project: { id: it.project ?? 'P1', title: 'Web board', closed: it.closed ?? false },
              fieldValues: {
                nodes: [
                  {},
                  {
                    iterationId: it.id ?? 'I7',
                    title: it.title ?? 'Sprint 7',
                    startDate: it.start ?? '2026-10-05',
                    duration: it.days ?? 14,
                    field: { id: 'F1', name: 'Sprint' },
                  },
                ],
              },
            })),
          },
        })),
      },
    },
  };
}

function item(repo: string, n: number, iterationId: string | null, archived = false) {
  return {
    isArchived: archived,
    fieldValueByName: iterationId == null ? null : { iterationId },
    content: { ...issue(n), url: `https://github.com/${repo}/issues/${n}`, repository: { nameWithOwner: repo } },
  };
}

describe('listGithubMilestone — Projects iterations', () => {
  it('reads the current iteration: workspace issues only, its dates, no milestone call', async () => {
    const log: Array<{ query: string; vars: Record<string, unknown> }> = [];
    const g = gh(
      projects((q, v) => {
        if (q.includes('LimnSprintIterationScan')) {
          return v.name === 'web'
            ? scan([{ n: 1, its: [{}] }, { n: 2, its: [{}, { project: 'P2', id: 'old', start: '2026-09-01' }] }])
            : scan([{ n: 3, its: [{ project: 'P9', id: 'X', closed: true }] }]);
        }
        if (q.includes('LimnSprintIterationItems')) {
          expect(v).toMatchObject({ project: 'P1', field: 'Sprint' });
          return {
            node: {
              items: {
                nodes: [
                  item('acme/web', 1, 'I7'),
                  item('ACME/api', 4, 'I7'),
                  item('acme/web', 2, 'I6'), // another iteration
                  item('other/repo', 9, 'I7'), // not this workspace's
                  item('acme/web', 5, 'I7', true), // archived
                  { isArchived: false, fieldValueByName: { iterationId: 'I7' }, content: {} }, // a PR / draft
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          };
        }
        throw new Error(q);
      }),
      log,
    );
    const r = await list(args(g));
    expect(r.source).toEqual({
      kind: 'iteration',
      provider: 'github',
      name: 'Sprint 7',
      project: 'Web board',
      field: 'Sprint',
      startsOn: '2026-10-05',
      endsOn: '2026-10-19',
      repos: ['acme/web', 'acme/api'],
    });
    expect(r.dates).toEqual({ startsAt: new Date('2026-10-05T00:00:00Z'), endsAt: new Date('2026-10-19T00:00:00Z') });
    expect(r.tickets.map((t) => [t.key, t.sprintName])).toEqual([
      ['acme/web#1', 'Sprint 7'],
      ['acme/api#4', 'Sprint 7'],
    ]);
    expect(r.truncated).toBe(false);
    expect(log.some((l) => l.query.includes('LimnSprintMilestones'))).toBe(false);
  });

  it('a missing read:project scope falls back to milestones, says why, and asks no further repo', async () => {
    const log: Array<{ query: string; vars: Record<string, unknown> }> = [];
    const g: GithubCallAccess = {
      accountId: (accountSeq += 1),
      graphql: async <T,>(query: string, vars: Record<string, unknown>): Promise<GithubGqlResult<T>> => {
        log.push({ query, vars });
        if (query.includes('LimnSprintIterationScan')) {
          // GitHub's answer for a token without the scope: no data, INSUFFICIENT_SCOPES — thrown by the client.
          throw Object.assign(new Error('scopes'), { errors: [{ type: 'INSUFFICIENT_SCOPES', message: "requires ['read:project']" }] });
        }
        if (query.includes('LimnSprintMilestones')) return { data: { repository: { milestones: { nodes: [{ title: 'v2', dueOn: null, number: 1 }] } } } as T };
        return { data: { repository: { milestone: { issues: { nodes: [issue(1)], pageInfo: { hasNextPage: false } } } } } as T };
      },
    };
    const r = await list(args(g));
    expect(r.source).toMatchObject({ kind: 'milestone', name: 'v2', projectsAccess: 'needs_scope' });
    expect(log.filter((l) => l.query.includes('LimnSprintIterationScan'))).toHaveLength(1);
  });

  it('a scope error inside partial data also says why; the status fallback carries it too', async () => {
    const g: GithubCallAccess = {
      accountId: (accountSeq += 1),
      graphql: async <T,>(query: string): Promise<GithubGqlResult<T>> => {
        if (query.includes('LimnSprintIterationScan'))
          return { data: { repository: { issues: { nodes: [{ number: 1, projectItems: null }] } } } as T, errors: [{ type: 'INSUFFICIENT_SCOPES' }] };
        if (query.includes('LimnSprintMilestones')) return { data: { repository: { milestones: { nodes: [] } } } as T };
        return { data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } as T };
      },
    };
    const r = await list(args(g, ['acme/web']));
    expect(r.source).toMatchObject({ kind: 'status_fallback', reason: 'none_active', projectsAccess: 'needs_scope' });
  });

  it('FORBIDDEN / NOT_FOUND / an HTTP 403 fall back silently, with no note', async () => {
    for (const fail of [
      () => ({ data: { repository: null }, errors: [{ type: 'FORBIDDEN' }] }),
      () => ({ data: null, errors: [{ type: 'NOT_FOUND' }] }),
      () => {
        throw Object.assign(new Error('forbidden'), { status: 403 });
      },
    ]) {
      const g: GithubCallAccess = {
        accountId: (accountSeq += 1),
        graphql: async <T,>(query: string): Promise<GithubGqlResult<T>> => {
          if (query.includes('LimnSprintIterationScan')) return fail() as GithubGqlResult<T>;
          if (query.includes('LimnSprintMilestones')) return { data: { repository: { milestones: { nodes: [{ title: 'v2', dueOn: null, number: 1 }] } } } as T };
          return { data: { repository: { milestone: { issues: { nodes: [issue(1)], pageInfo: { hasNextPage: false } } } } } as T };
        },
      };
      const r = await list(args(g, ['acme/web']));
      expect(r.source.kind).toBe('milestone');
      expect('projectsAccess' in r.source).toBe(false);
    }
  });

  it('no current iteration → milestones, with no note', async () => {
    const g = gh(
      projects((q) => {
        if (q.includes('LimnSprintIterationScan')) return scan([{ n: 1, its: [{ start: '2026-08-01' }] }]);
        if (q.includes('LimnSprintMilestones')) return { repository: { milestones: { nodes: [{ title: 'v2', dueOn: '2026-10-20T00:00:00Z', number: 1 }] } } };
        if (q.includes('LimnSprintMilestoneIssues')) return { repository: { milestone: { issues: { nodes: [issue(1)], pageInfo: { hasNextPage: false } } } } };
        throw new Error(q);
      }),
    );
    const r = await list(args(g, ['acme/web']));
    expect(r.source).toEqual({ kind: 'milestone', provider: 'github', name: 'v2', dueOn: '2026-10-20T00:00:00Z', repos: ['acme/web'] });
  });

  it('a project with more items than the cap is cut and says truncated', async () => {
    const log: Array<{ query: string; vars: Record<string, unknown> }> = [];
    const g = gh(
      projects((q, v) => {
        if (q.includes('LimnSprintIterationScan')) return scan([{ n: 1, its: [{}] }]);
        const page = Number(v.after ?? 0);
        // One item per page in the iteration, the rest elsewhere: the ITEM cap cuts, not the ticket cap.
        return {
          node: {
            items: {
              nodes: Array.from({ length: 50 }, (_, i) => item('acme/web', page * 50 + i + 1, i === 0 ? 'I7' : 'other')),
              pageInfo: { hasNextPage: true, endCursor: String(page + 1) },
            },
          },
        };
      }),
      log,
    );
    const r = await list(args(g, ['acme/web']));
    expect(r.source.kind).toBe('iteration');
    expect(r.truncated).toBe(true);
    expect(log.filter((l) => l.query.includes('LimnSprintIterationItems'))).toHaveLength(SPRINT_ITERATION_ITEMS_MAX / 50);
    expect(r.tickets).toHaveLength(SPRINT_ITERATION_ITEMS_MAX / 50);
  });

  it('a rate limit on the Projects call is still the reader’s 429', async () => {
    const g: GithubCallAccess = {
      accountId: (accountSeq += 1),
      graphql: async () => ({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'limit' }] }),
    };
    await expect(list(args(g, ['acme/web']))).rejects.toMatchObject({ code: 'http', status: 429 });
  });
});
