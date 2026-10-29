// THE DEMO'S NOTION TRACKER — the Web workspace's tickets are pages in a fictional Notion database
// ("Web tasks", Unique ID prefix WEB), read through the REAL tracker code: the PR ticket worker and the
// sprint list read (docs/TRACKERS.md § Notion).
//
// Like seed-demo-tracker.ts (the Platform workspace's Jira), the Notion API is FAKED at the transport
// seam (`JiraTransport`), answering the handful of calls the reader makes from the pages below, so every
// stored row is exactly what a real read would store. Nothing leaves the process.
//
// Everything is fictional: the Acme team, its database, its pages and its people.
import { currentSprintStart } from './seed-periods.js';

const DAY = 86_400_000;
const DB = '5e1f0c2a7b3d4e8f9a0b1c2d3e4f5a6b';
const SPRINTS_DB = '7c2e1d0f9a8b4c3d2e1f0a9b8c7d6e5f';
export const NOTION_DEMO_DB_URL = `https://www.notion.so/acme/Web-tasks-${DB}?v=0f1e2d3c4b5a69788796a5b4c3d2e1f0`;
const ROOT = `https://www.notion.so/${DB}`;

const PEOPLE = {
  lena: { id: 'u-lena', name: 'Lena Fischer' },
  sam: { id: 'u-sam', name: 'Sam Carter' },
  priya: { id: 'u-priya', name: 'Priya Nair' },
  morgan: { id: 'u-morgan', name: 'Morgan Diaz' },
} as const;
const BOT = { id: 'u-github-bot', name: 'GitHub', type: 'bot' as const };

type Status = 'Not started' | 'In progress' | 'In review' | 'Done';
const STATUS_IDS: Record<Status, string> = { 'Not started': 'o-todo', 'In progress': 'o-doing', 'In review': 'o-review', Done: 'o-done' };

interface Page {
  n: number;
  title: string;
  status: Status;
  type: 'Story' | 'Bug' | 'Task';
  who: keyof typeof PEOPLE | null;
  body: string[];
  criteria: string | null;
  blockedBy?: number[];
  inSprint: boolean;
  createdDaysAgo: number;
  editedDaysAgo: number;
  /** The PRs that carry this key in their branch. */
  prs: Array<{ id: number; branch: string }>;
}

const PAGES: Page[] = [
  {
    n: 31,
    title: 'Stop the open-PR strip from shifting when cards load',
    status: 'In review',
    type: 'Bug',
    who: 'lena',
    body: ['The strip jumps by one row when the third card arrives. Reserve the space before the cards render.'],
    criteria: '- [ ] No layout shift when the cards load\n- [ ] The strip keeps its height while a card refreshes',
    inSprint: true,
    createdDaysAgo: 9,
    editedDaysAgo: 1,
    prs: [{ id: 101, branch: 'lena/web-31-layout-shift' }],
  },
  {
    n: 34,
    title: 'Move between open-PR cards with the keyboard',
    status: 'In progress',
    type: 'Story',
    who: 'sam',
    body: ['Arrow keys move the focus between cards; Enter opens the PR. Focus must stay visible in dark mode.'],
    criteria: '- [ ] Left and right arrows move between cards\n- [ ] Enter opens the focused PR\n- [ ] A visible focus ring in both themes',
    inSprint: true,
    createdDaysAgo: 8,
    editedDaysAgo: 0,
    prs: [{ id: 112, branch: 'sam/web-34-keyboard-nav' }],
  },
  {
    n: 28,
    title: 'Retune the timeline clustering thresholds',
    status: 'In progress',
    type: 'Task',
    who: 'priya',
    body: ['Clusters merge too early on a busy week. Use the PR count per lane, not per day.', '## Acceptance criteria', '- [ ] A busy week shows separate clusters per lane', '- [x] The old threshold is kept behind a setting'],
    criteria: null,
    inSprint: true,
    createdDaysAgo: 21,
    editedDaysAgo: 2,
    prs: [{ id: 140, branch: 'priya/web-28-clustering' }],
  },
  {
    n: 36,
    title: 'Show the sprint dates in the page header',
    status: 'Not started',
    type: 'Story',
    who: 'morgan',
    body: ['The header names the sprint but not its days. Show "14 Oct – 27 Oct · day 3 of 14".'],
    criteria: '- [ ] The header shows the start, the end and the day',
    inSprint: true,
    createdDaysAgo: 5,
    editedDaysAgo: 3,
    prs: [],
  },
  {
    n: 37,
    title: 'Remember the focused card across reloads',
    status: 'Not started',
    type: 'Story',
    who: null,
    body: ['After a reload the focus should return to the card it was on.'],
    criteria: '- [ ] The focused card is restored after a reload',
    blockedBy: [34],
    inSprint: true,
    createdDaysAgo: 4,
    editedDaysAgo: 4,
    prs: [],
  },
  {
    n: 25,
    title: 'Pack timeline lanes in one pass',
    status: 'Done',
    type: 'Task',
    who: 'morgan',
    body: ['Extract the lane packer so the timeline and the sprint lanes share it.'],
    criteria: null,
    inSprint: false,
    createdDaysAgo: 14,
    editedDaysAgo: 3,
    prs: [{ id: 102, branch: 'morgan/web-25-lane-packer' }],
  },
];

const COMMENTS: Record<number, Array<{ id: string; who: keyof typeof PEOPLE | 'bot'; hoursAgo: number; text: string }>> = {
  34: [
    { id: 'cm-3401', who: 'lena', hoursAgo: 30, text: 'Home and End should jump to the first and last card too.' },
    { id: 'cm-3402', who: 'bot', hoursAgo: 20, text: 'Linked pull request acme/web-app#112.' },
    { id: 'cm-3403', who: 'sam', hoursAgo: 4, text: 'Agreed with Lena: Home and End are in. Skipping wrap-around for now.' },
  ],
};

const pageId = (n: number): string => `0000${String(n).padStart(4, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BY_N = new Map(PAGES.map((p) => [p.n, p]));
const BY_ID = new Map(PAGES.map((p) => [pageId(p.n), p]));

const rt = (text: string) => [{ plain_text: text }];

function pageJson(p: Page, now: number, sprintPageId: string): Record<string, unknown> {
  const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
  return {
    object: 'page',
    id: pageId(p.n),
    url: `https://www.notion.so/acme/${p.title.replace(/[^A-Za-z0-9]+/g, '-')}-${pageId(p.n).replace(/-/g, '')}`,
    created_time: iso(p.createdDaysAgo),
    last_edited_time: iso(p.editedDaysAgo),
    parent: { type: 'database_id', database_id: DB },
    properties: {
      Name: { id: 'title', type: 'title', title: rt(p.title) },
      ID: { id: 'uid', type: 'unique_id', unique_id: { prefix: 'WEB', number: p.n } },
      Status: { id: 'stat', type: 'status', status: { id: STATUS_IDS[p.status], name: p.status } },
      Assignee: {
        id: 'asgn',
        type: 'people',
        people: p.who != null ? [{ object: 'user', id: PEOPLE[p.who].id, name: PEOPLE[p.who].name, avatar_url: null, type: 'person' }] : [],
      },
      Sprint: { id: 'sprt', type: 'relation', relation: p.inSprint ? [{ id: sprintPageId }] : [], has_more: false },
      Type: { id: 'type', type: 'select', select: { id: `t-${p.type}`, name: p.type } },
      'Acceptance criteria': { id: 'accr', type: 'rich_text', rich_text: p.criteria != null ? rt(p.criteria) : [] },
      'Blocked by': { id: 'blkd', type: 'relation', relation: (p.blockedBy ?? []).map((n) => ({ id: pageId(n) })), has_more: false },
    },
  };
}

function blocksJson(p: Page): Record<string, unknown> {
  return {
    object: 'list',
    has_more: false,
    next_cursor: null,
    results: p.body.map((line, i) => {
      const h = /^## (.*)$/.exec(line);
      const todo = /^- \[( |x)\] (.*)$/.exec(line);
      const id = `${pageId(p.n)}-b${i}`;
      if (h) return { id, type: 'heading_2', has_children: false, heading_2: { rich_text: rt(h[1]!) } };
      if (todo) return { id, type: 'to_do', has_children: false, to_do: { rich_text: rt(todo[2]!), checked: todo[1] === 'x' } };
      return { id, type: 'paragraph', has_children: false, paragraph: { rich_text: rt(line) } };
    }),
  };
}

const SCHEMA = {
  object: 'database',
  id: DB,
  title: rt('Web tasks'),
  properties: {
    Name: { id: 'title', name: 'Name', type: 'title', title: {} },
    ID: { id: 'uid', name: 'ID', type: 'unique_id', unique_id: { prefix: 'WEB' } },
    Status: {
      id: 'stat',
      name: 'Status',
      type: 'status',
      status: {
        options: (Object.keys(STATUS_IDS) as Status[]).map((name) => ({ id: STATUS_IDS[name], name })),
        groups: [
          { id: 'g1', name: 'To-do', option_ids: ['o-todo'] },
          { id: 'g2', name: 'In progress', option_ids: ['o-doing', 'o-review'] },
          { id: 'g3', name: 'Complete', option_ids: ['o-done'] },
        ],
      },
    },
    Assignee: { id: 'asgn', name: 'Assignee', type: 'people', people: {} },
    Sprint: { id: 'sprt', name: 'Sprint', type: 'relation', relation: { database_id: SPRINTS_DB } },
    Type: { id: 'type', name: 'Type', type: 'select', select: { options: [{ id: 't-Story', name: 'Story' }, { id: 't-Bug', name: 'Bug' }, { id: 't-Task', name: 'Task' }] } },
    'Acceptance criteria': { id: 'accr', name: 'Acceptance criteria', type: 'rich_text', rich_text: {} },
    'Blocked by': { id: 'blkd', name: 'Blocked by', type: 'relation', relation: { database_id: DB } },
  },
};

const SPRINTS_SCHEMA = {
  object: 'database',
  id: SPRINTS_DB,
  title: rt('Web sprints'),
  properties: { Name: { id: 'title', name: 'Name', type: 'title', title: {} }, Dates: { id: 'dates', name: 'Dates', type: 'date', date: {} } },
};

/** The workspace's property mapping — what Settings → Issue tracker → Notion saves. */
export const NOTION_DEMO_MAPPING = {
  version: 1 as const,
  databaseId: DB,
  uniqueId: { property: { id: 'uid', name: 'ID' }, prefix: 'WEB' },
  status: { type: 'status' as const, property: { id: 'stat', name: 'Status' } },
  assignee: { id: 'asgn', name: 'Assignee' },
  sprint: { kind: 'relation' as const, property: { id: 'sprt', name: 'Sprint' }, sprintDatabaseId: SPRINTS_DB, dateProperty: { id: 'dates', name: 'Dates' } },
  issueType: { id: 'type', name: 'Type' },
  criteria: { id: 'accr', name: 'Acceptance criteria' },
  blockedBy: { id: 'blkd', name: 'Blocked by' },
};

/** A JiraTransport answering the Notion calls the reader and the sprint list make. */
function fakeNotionTransport(now: number, sprint: { startsAt: number; endsAt: number }) {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const none = { status: 404, contentType: 'application/json', body: '{"object":"error","code":"object_not_found"}' };
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const SPRINT_PAGE = '7c2e0000-0000-4000-8000-000000000009';
  const sprintPages = [
    { id: SPRINT_PAGE, name: 'Web Sprint 9', start: sprint.startsAt, end: sprint.endsAt - DAY },
    { id: '7c2e0000-0000-4000-8000-000000000008', name: 'Web Sprint 8', start: sprint.startsAt - 14 * DAY, end: sprint.startsAt - DAY },
  ];
  const list = (results: unknown[]) => json({ object: 'list', results, has_more: false, next_cursor: null });
  return async (url: URL, _h: Record<string, string>, _o: unknown, init?: { method: string; body: string }) => {
    const p = url.pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body != null ? (JSON.parse(init.body) as { filter?: Record<string, unknown> }) : {};
    let m: RegExpMatchArray | null;
    if (method === 'GET' && p === `/v1/databases/${DB}`) return json(SCHEMA);
    if (method === 'GET' && p === `/v1/databases/${SPRINTS_DB}`) return json(SPRINTS_SCHEMA);
    if (method === 'POST' && p === `/v1/databases/${SPRINTS_DB}/query`) {
      return list(
        sprintPages.map((s) => ({
          object: 'page',
          id: s.id,
          parent: { type: 'database_id', database_id: SPRINTS_DB },
          properties: { Name: { id: 'title', type: 'title', title: rt(s.name) }, Dates: { id: 'dates', type: 'date', date: { start: day(s.start), end: day(s.end) } } },
        })),
      );
    }
    if (method === 'POST' && p === `/v1/databases/${DB}/query`) {
      const f = body.filter ?? {};
      const uid = (f as { unique_id?: { equals?: number } }).unique_id?.equals;
      if (uid != null) {
        const page = BY_N.get(uid);
        return list(page != null ? [pageJson(page, now, SPRINT_PAGE)] : []);
      }
      if ((f as { relation?: unknown }).relation != null) return list(PAGES.filter((x) => x.inSprint).map((x) => pageJson(x, now, SPRINT_PAGE)));
      return list(PAGES.filter((x) => x.status !== 'Done').map((x) => pageJson(x, now, SPRINT_PAGE)));
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/blocks\/([^/]+)\/children$/))) {
      const page = BY_ID.get(m[1]!);
      return page != null ? json(blocksJson(page)) : list([]);
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/pages\/([^/]+)$/))) {
      const page = BY_ID.get(m[1]!);
      return page != null ? json(pageJson(page, now, SPRINT_PAGE)) : none;
    }
    if (method === 'GET' && p === '/v1/comments') {
      const page = BY_ID.get(url.searchParams.get('block_id') ?? '');
      const cs = page != null ? (COMMENTS[page.n] ?? []) : [];
      return list(
        cs.map((c) => ({
          id: c.id,
          created_time: new Date(now - c.hoursAgo * 3_600_000).toISOString(),
          last_edited_time: new Date(now - c.hoursAgo * 3_600_000).toISOString(),
          created_by: { object: 'user', id: c.who === 'bot' ? BOT.id : PEOPLE[c.who].id },
          rich_text: rt(c.text),
        })),
      );
    }
    if (method === 'GET' && (m = p.match(/^\/v1\/users\/([^/]+)$/))) {
      const id = m[1]!;
      if (id === BOT.id) return json({ object: 'user', ...BOT });
      const person = Object.values(PEOPLE).find((x) => x.id === id);
      return person != null ? json({ object: 'user', id, name: person.name, type: 'person' }) : none;
    }
    return none;
  };
}

export interface NotionSeedCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  now: Date;
  workspaceId: number;
}

const quietLog = {
  info: () => {},
  warn: (o: unknown, m?: string) => console.warn('  ⚠', m ?? '', JSON.stringify(o).slice(0, 300)),
  error: (o: unknown, m?: string) => console.warn('  ✗', m ?? '', JSON.stringify(o).slice(0, 300)),
};

export const notionDemoIdent = (n: number): string => `notion:${ROOT}#WEB-${n}`;

export async function seedDemoNotion(c: NotionSeedCtx): Promise<{ tickets: number; sprintTickets: number }> {
  const { db, schema, now, workspaceId } = c;
  const { eq } = await import('drizzle-orm');
  const nowMs = now.getTime();
  const startsAt = currentSprintStart(now);
  const transport = fakeNotionTransport(nowMs, { startsAt, endsAt: startsAt + 14 * DAY }) as never;

  // The demo never waits on the ≈3-per-second spacing: a clock whose sleep is instant.
  const { __setNotionClock } = await import('../src/tracker/notion/client.js');
  let t = nowMs;
  __setNotionClock({ now: () => t, sleep: async (ms) => void (t += ms) });

  // 1. Branch names that carry the WEB-n keys (detection reads title + branch).
  for (const p of PAGES) {
    for (const pr of p.prs) {
      await db.update(schema.pullRequests).set({ headRefName: pr.branch }).where(eq(schema.pullRequests.id, pr.id)).execute();
    }
  }

  // 2. The workspace's tracker: Notion, the database URL, an integration token (stored as typed — no
  //    ENCRYPTION_KEY locally; nothing ever sends it anywhere) and the property mapping.
  const { buildTrackerContext } = await import('../src/tracker/runtime.js');
  const { writeWorkspaceTracker } = await import('../src/tracker/settings.js');
  const ctx = buildTrackerContext(quietLog as never);
  await writeWorkspaceTracker(ctx, 1, workspaceId, {
    issue: { provider: 'notion', baseUrl: NOTION_DEMO_DB_URL, matchScope: 'title_branch' },
    jira: { token: 'ntn_demotokennotrealabcdefghijklmnop' },
    notion: NOTION_DEMO_MAPPING,
  });

  // 3. The PR ticket worker, open and merged PRs.
  const { syncPrTickets } = await import('../src/tracker/worker.js');
  const prIds = PAGES.flatMap((p) => p.prs.map((x) => x.id));
  const prs = (await db.select({ id: schema.pullRequests.id, state: schema.pullRequests.state }).from(schema.pullRequests).execute()) as Array<{ id: number; state: string }>;
  const stateOf = new Map(prs.map((p) => [p.id, p.state]));
  const stats = await syncPrTickets(ctx, 1, prIds.filter((id) => stateOf.get(id) === 'open'), {
    transport,
    mergedPrIds: prIds.filter((id) => stateOf.get(id) !== 'open'),
    budget: 100,
    bypassBackoff: true,
  });

  // 4. The sprint list read: the Sprints page whose dates hold today.
  const { noteSprintViewed } = await import('../src/db/sprint-store.js');
  await noteSprintViewed(1, workspaceId, now);
  const { readWorkspaceSprint } = await import('../src/tracker/sprint/read.js');
  const read = await readWorkspaceSprint(ctx, 1, workspaceId, { transport, now: () => nowMs });
  __setNotionClock(null);
  if (!read.ok) throw new Error(`demo Notion sprint read failed: ${read.code}`);
  return { tickets: stats.fetched + stats.copied, sprintTickets: read.stored };
}
