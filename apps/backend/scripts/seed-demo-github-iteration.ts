// THE DEMO'S GITHUB PROJECTS ITERATION — the Admin workspace (acme/admin-console) has no tracker
// chosen, so GitHub Issues is its automatic default, and its sprint is the CURRENT iteration of a
// fictional Projects board ("Admin roadmap", iteration field "Sprint"), read through the REAL sprint
// list read (docs/TRACKERS.md § GitHub Projects iterations).
//
// Like seed-demo-tracker.ts (Jira) and seed-demo-notion.ts (Notion), the remote side is FAKED at the
// seam the reader calls — here `TrackerContext.github.graphql` — answering the two Projects queries
// from the issues below, so every stored row is exactly what a real read would store. Nothing leaves
// the process, and no token is read.
//
// Everything is fictional: the Acme team, its board and its issues.
import { currentSprintStart } from './seed-periods.js';

const DAY = 86_400_000;
export const ITERATION_DEMO_REPO = 'acme/admin-console';
export const ITERATION_DEMO_NAME = 'Sprint 14';

interface DemoIssue {
  n: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  who: string | null;
  body: string;
  /** Which iteration it sits in: the current one, the last one, or none. */
  iteration: 'current' | 'previous' | null;
}

const ISSUES: DemoIssue[] = [
  {
    n: 41,
    title: 'Let admins invite people by email',
    state: 'OPEN',
    who: 'priya-nair',
    body: 'Admins add people one by one today. Send an invite link instead.\n\n## Acceptance criteria\n- [ ] An admin can invite by email\n- [ ] The invite expires after 7 days',
    iteration: 'current',
  },
  {
    n: 42,
    title: 'Show the last sign-in on the members page',
    state: 'OPEN',
    who: 'lena-fischer',
    body: 'Admins cannot tell which seats are unused.\n\n## Acceptance criteria\n- [ ] Each member row shows the last sign-in date',
    iteration: 'current',
  },
  {
    n: 44,
    title: 'Audit log export as CSV',
    state: 'OPEN',
    who: null,
    body: 'Compliance asks for the audit log every quarter.\n\n## Acceptance criteria\n- [ ] Export the filtered log as CSV\n- [ ] The export names the date range',
    iteration: 'current',
  },
  {
    n: 39,
    title: 'Fix the role picker closing on scroll',
    state: 'CLOSED',
    who: 'sam-carter',
    body: 'The role picker closes when the page scrolls under it.\n\n## Acceptance criteria\n- [x] The picker stays open while the page scrolls',
    iteration: 'current',
  },
  {
    n: 36,
    title: 'Remove the legacy settings page',
    state: 'CLOSED',
    who: 'tom-becker',
    body: 'The new settings page has shipped for a month.',
    iteration: 'previous',
  },
];

function issueJson(i: DemoIssue, nowMs: number) {
  return {
    number: i.n,
    title: i.title,
    url: `https://github.com/${ITERATION_DEMO_REPO}/issues/${i.n}`,
    state: i.state,
    stateReason: i.state === 'CLOSED' ? 'COMPLETED' : null,
    body: i.body,
    createdAt: new Date(nowMs - 12 * DAY).toISOString(),
    closedAt: i.state === 'CLOSED' ? new Date(nowMs - 2 * DAY).toISOString() : null,
    updatedAt: new Date(nowMs - (i.n % 5) * DAY).toISOString(),
    issueType: null,
    assignees: { nodes: i.who != null ? [{ login: i.who, avatarUrl: null }] : [] },
    subIssues: { totalCount: 0, nodes: [] },
  };
}

/** The fake GitHub GraphQL endpoint: the iteration scan and the project's items. */
function fakeGithub(nowMs: number) {
  const start = currentSprintStart(new Date(nowMs));
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const its = {
    current: { iterationId: 'it-14', title: ITERATION_DEMO_NAME, startDate: day(start), duration: 14 },
    previous: { iterationId: 'it-13', title: 'Sprint 13', startDate: day(start - 14 * DAY), duration: 14 },
  };
  const field = { id: 'PVTIF_sprint', name: 'Sprint' };
  const project = { id: 'PVT_admin', title: 'Admin roadmap', closed: false };
  const rateLimit = { cost: 1, remaining: 4900, resetAt: new Date(nowMs + 3_600_000).toISOString() };
  return {
    graphql: async (_accountId: number, query: string): Promise<{ data: unknown; errors?: unknown }> => {
      if (query.includes('LimnSprintIterationScan')) {
        return {
          data: {
            repository: {
              issues: {
                nodes: ISSUES.map((i) => ({
                  number: i.n,
                  projectItems: {
                    nodes: i.iteration == null ? [] : [{ project, fieldValues: { nodes: [{}, { ...its[i.iteration], field }] } }],
                  },
                })),
              },
            },
            rateLimit,
          },
        };
      }
      if (query.includes('LimnSprintIterationItems')) {
        return {
          data: {
            node: {
              items: {
                nodes: ISSUES.filter((i) => i.iteration != null).map((i) => ({
                  isArchived: false,
                  fieldValueByName: { iterationId: its[i.iteration!].iterationId },
                  content: { ...issueJson(i, nowMs), repository: { nameWithOwner: ITERATION_DEMO_REPO } },
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
            rateLimit,
          },
        };
      }
      // Nothing else is asked of GitHub here (no issue names another).
      return { data: { rateLimit } };
    },
  };
}

const quietLog = {
  info: () => {},
  warn: (o: unknown, m?: string) => console.warn('  ⚠', m ?? '', JSON.stringify(o).slice(0, 300)),
  error: (o: unknown, m?: string) => console.warn('  ✗', m ?? '', JSON.stringify(o).slice(0, 300)),
};

export interface IterationSeedCtx {
  now: Date;
  workspaceId: number;
}

export async function seedDemoGithubIteration(c: IterationSeedCtx): Promise<{ sprintTickets: number; source: string }> {
  const { now, workspaceId } = c;
  const nowMs = now.getTime();
  const { buildTrackerContext } = await import('../src/tracker/runtime.js');
  const ctx = { ...buildTrackerContext(quietLog as never), github: fakeGithub(nowMs) };
  const { noteSprintViewed } = await import('../src/db/sprint-store.js');
  await noteSprintViewed(1, workspaceId, now);
  const { readWorkspaceSprint } = await import('../src/tracker/sprint/read.js');
  const read = await readWorkspaceSprint(ctx as never, 1, workspaceId, { now: () => nowMs });
  if (!read.ok) throw new Error(`demo GitHub iteration read failed: ${read.code}`);
  return { sprintTickets: read.stored, source: ITERATION_DEMO_NAME };
}
