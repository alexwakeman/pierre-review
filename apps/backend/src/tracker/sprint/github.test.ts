// GitHub Issues' sprint list (./github.ts): the nearest-due open milestone across the workspace's
// repos (undated after dated, overdue never), its open issues in every repo with the same title, the
// status fallback (none_active), paging, the cap, and the budget pre-emption shared with the reader.
// No request leaves the process: every answer comes from the fake `graphql` below.
import { describe, expect, it } from 'vitest';
import { SPRINT_TICKETS_MAX } from '@pierre-review/shared';
import type { GithubCallAccess, GithubGqlResult, TrackerCall } from '../types.js';
import { makeGithubLister, milestoneDates, pickMilestone } from './github.js';
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

function gh(h: Handler, log: Array<{ query: string; vars: Record<string, unknown> }> = []): GithubCallAccess {
  const accountId = (accountSeq += 1);
  return {
    accountId,
    graphql: async <T,>(query: string, vars: Record<string, unknown>): Promise<GithubGqlResult<T>> => {
      log.push({ query, vars });
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
