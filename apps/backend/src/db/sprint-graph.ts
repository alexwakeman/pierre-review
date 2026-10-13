import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  isBlockingRelation,
  parseTicketIdent,
  sprintAssessModeOf,
  parseTicketLinkBlockers,
  trackerTicketIdent,
  type CiStatus,
  type JiraStatusCategory,
  type SprintBrief,
  type SprintBriefState,
  type SprintGraphPr,
  type SprintGraphResponse,
  type SprintSource,
  type SprintStatusLayout,
  type SprintTicketDetailResponse,
  type SprintTicketReference,
  type TicketPrsResponse,
  type TrackerProvider,
} from '@pierre-review/shared';
import { globalAutomationUserIds } from './automation-ids.js';
import { db, schema } from './client.js';
import { currentSprintBriefs, sprintBriefInput, type SprintBriefInput } from './sprint-briefs.js';
import { foldSprintGraph, identOfKey, type GraphTicketInput } from './sprint-graph-fold.js';
import { currentSprintThemes, sprintThemeInput, type SprintThemeInput } from './sprint-themes.js';
import {
  kickSprintRead,
  latestSprintAssessments,
  noteSprintViewed,
  resetSprintReadForSite,
  sprintAssessmentRecordOf,
  sprintReadStateOf,
  type SprintReadRow,
  type SprintTicketDbRow,
} from './sprint-store.js';
import { sprintAssessmentCurrencyFrom, workspaceRepoRefs } from './sprint-stories.js';
import { getSprintStatusLayout, sprintStageOf } from './sprint-status-layout.js';
import { effectiveSprintRepos } from './sprint-ticket-repos.js';

// REPORTS → THIS SPRINT AS A GRAPH (`GET /api/sprint-graph`, `GET /api/sprint-graph/ticket`;
// docs/API.md § This sprint). DB ONLY — no tracker, GitHub or model call: a view STAMPS the workspace
// as viewed (the sprint read's demand gate) and kicks a read that is due, nothing else.
//
//   • POPULATION: this workspace's `sprint_tickets` with `in_sprint` on the tracker's CURRENT site,
//     plus the ghosts the sprint read stored (`sprint_ref_tickets`) that the fold reaches
//     (db/sprint-graph-fold.ts — the ONE fold the brief pass and the ghost lookup use too).
//   • STAGES: the workspace's status layout places every node, ghosts included (`sprintStageOf`).
//   • BRIEFS: CURRENT only (text hash + SPRINT_BRIEF_VERSION, db/sprint-briefs.ts). `aiEnabled` false
//     → every node's brief is 'off' and no text edge is drawn (tracker links still are).
//   • THEMES: CURRENT only (input hash over the sprint keys + brief summaries + SPRINT_THEME_VERSION,
//     db/sprint-themes.ts); null when AI is off or no current pass covers today's sprint.
//   • PRS: every PR on the ticket in THIS workspace's repos — the ticket review's membership rule
//     (`tracker_tickets`, state 'ok', read), any state.
//
// ⚠ Every read predicates on accountId (and workspaceId where the table has one).

const CHUNK = 400;
const CATEGORIES: readonly string[] = ['new', 'indeterminate', 'done'];
const categoryOf = (v: string | null | undefined): JiraStatusCategory | null =>
  v != null && CATEGORIES.includes(v) ? (v as JiraStatusCategory) : null;

type RefRow = typeof schema.sprintRefTickets.$inferSelect;

export interface GraphTickets {
  provider: TrackerProvider;
  apiRoot: string;
  sprintRows: SprintTicketDbRow[];
  refRows: RefRow[];
  sprint: GraphTicketInput[];
  ghosts: GraphTicketInput[];
  /** The brief input of every ticket (sprint + stored ghosts), by ident. */
  inputs: Map<string, SprintBriefInput>;
}

/** Everything the fold needs, from what is stored. `aiEnabled` false → no briefs ('off'). */
export async function loadGraphTickets(
  accountId: number,
  workspaceId: number,
  site: { provider: TrackerProvider; apiRoot: string },
  aiEnabled: boolean,
): Promise<GraphTickets> {
  const st = schema.sprintTickets;
  const sprintRows = (await db
    .select()
    .from(st)
    .where(
      and(
        eq(st.accountId, accountId),
        eq(st.workspaceId, workspaceId),
        eq(st.inSprint, true),
        eq(st.provider, site.provider),
        eq(st.apiRoot, site.apiRoot),
      ),
    )
    .execute()) as SprintTicketDbRow[];
  const rt = schema.sprintRefTickets;
  const own = new Set(sprintRows.map((r) => r.ident));
  const refRows = (
    (await db
      .select()
      .from(rt)
      .where(and(eq(rt.accountId, accountId), eq(rt.workspaceId, workspaceId), eq(rt.provider, site.provider), eq(rt.apiRoot, site.apiRoot)))
      .execute()) as RefRow[]
  ).filter((r) => !own.has(r.ident));
  const inputs = new Map<string, SprintBriefInput>();
  for (const r of sprintRows) inputs.set(r.ident, sprintBriefInput(r, site.provider));
  for (const r of refRows) inputs.set(r.ident, sprintBriefInput(r, site.provider));
  const briefs: Map<string, SprintBrief> = aiEnabled
    ? await currentSprintBriefs(
        accountId,
        workspaceId,
        [...inputs].map(([ident, input]) => ({ ident, input })),
      )
    : new Map();
  const state = (ident: string): SprintBriefState => (!aiEnabled ? 'off' : briefs.has(ident) ? 'current' : 'pending');
  const sprint: GraphTicketInput[] = sprintRows.map((r) => ({
    ident: r.ident,
    key: r.issueKey,
    title: r.title,
    url: r.url ?? null,
    status: r.statusName != null ? { name: r.statusName, category: categoryOf(r.statusCategory) } : null,
    issueType: r.issueTypeName ?? null,
    assignee: r.assigneeName != null ? { name: r.assigneeName, avatarUrl: r.assigneeAvatarUrl ?? null } : null,
    epic: r.epicKey != null ? { key: r.epicKey, title: r.epicTitle ?? null } : null,
    links: parseTicketLinkBlockers(r.blockedByJson),
    brief: briefs.get(r.ident) ?? null,
    briefState: state(r.ident),
  }));
  const ghosts: GraphTicketInput[] = refRows.map((r) => ({
    ident: r.ident,
    key: r.issueKey,
    title: r.title ?? '',
    url: r.url ?? null,
    status: r.statusName != null ? { name: r.statusName, category: categoryOf(r.statusCategory) } : null,
    issueType: r.issueTypeName ?? null,
    assignee: r.assigneeName != null ? { name: r.assigneeName, avatarUrl: r.assigneeAvatarUrl ?? null } : null,
    epic: null,
    links: parseTicketLinkBlockers(r.blockedByJson),
    brief: briefs.get(r.ident) ?? null,
    briefState: state(r.ident),
  }));
  return { provider: site.provider, apiRoot: site.apiRoot, sprintRows, refRows, sprint, ghosts, inputs };
}

/** Every PR on these tickets in THIS workspace's repos (any state), by ident: open first, then merged
 *  (newest first), then closed. */
export async function graphPrsFor(
  accountId: number,
  workspaceId: number,
  site: { provider: TrackerProvider; apiRoot: string },
  keys: readonly string[],
): Promise<Map<string, SprintGraphPr[]>> {
  const out = new Map<string, SprintGraphPr[]>();
  const list = [...new Set(keys)];
  if (list.length === 0) return out;
  const { trackerTickets: tt, pullRequests: pr, repos: r, workspaceRepos: wr, users: u } = schema;
  type Row = {
    issueKey: string;
    prId: number;
    number: number;
    title: string;
    state: 'open' | 'merged' | 'closed';
    isDraft: boolean;
    ciStatus: CiStatus | null;
    mergedAt: Date | null;
    updatedAt: Date | null;
    owner: string;
    name: string;
    authorId: number | null;
    authorLogin: string | null;
    authorName: string | null;
  };
  const rows: Row[] = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    rows.push(
      ...((await db
        .select({
          issueKey: tt.issueKey,
          prId: pr.id,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          isDraft: pr.isDraft,
          ciStatus: pr.ciStatus,
          mergedAt: pr.mergedAt,
          updatedAt: pr.updatedAt,
          owner: r.owner,
          name: r.name,
          authorId: u.id,
          authorLogin: u.githubLogin,
          authorName: u.displayName,
        })
        .from(tt)
        .innerJoin(pr, and(eq(pr.id, tt.prId), eq(pr.accountId, accountId)))
        .innerJoin(r, and(eq(r.id, pr.repoId), eq(r.accountId, accountId)))
        .innerJoin(wr, and(eq(wr.repoId, r.id), eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId)))
        // `users` is GLOBAL: only the PR's own author row is read, by the PR's id.
        .leftJoin(u, eq(u.id, pr.authorId))
        .where(
          and(
            eq(tt.accountId, accountId),
            eq(tt.provider, site.provider),
            eq(tt.apiRoot, site.apiRoot),
            inArray(tt.issueKey, list.slice(i, i + CHUNK)),
            eq(tt.state, 'ok'),
            isNotNull(tt.fetchedAt),
          ),
        )
        .execute()) as Row[]),
    );
  }
  // The ball rule's GLOBAL automation set (`users.isBot` ∪ `github_type='Bot'` ∪ vendor logins), read
  // only when a PR has an author: the Members filter must not list dependabot as a person.
  const bots = rows.some((x) => x.authorId != null) ? await globalAutomationUserIds() : new Set<number>();
  const rank = (s: string): number => (s === 'open' ? 0 : s === 'merged' ? 1 : 2);
  const byIdent = new Map<string, Row[]>();
  for (const row of rows) {
    const ident = trackerTicketIdent(site.provider, site.apiRoot, row.issueKey);
    const arr = byIdent.get(ident) ?? [];
    if (!arr.some((x) => x.prId === row.prId)) arr.push(row);
    byIdent.set(ident, arr);
  }
  const ms = (d: Date | null): number => (d == null ? 0 : new Date(d).getTime());
  for (const [ident, arr] of byIdent) {
    out.set(
      ident,
      arr
        .sort(
          (a, b) =>
            rank(a.state) - rank(b.state) ||
            ms(b.mergedAt) - ms(a.mergedAt) ||
            ms(b.updatedAt) - ms(a.updatedAt) ||
            b.prId - a.prId,
        )
        .map((m) => ({
          prId: m.prId,
          number: m.number,
          repoFullName: `${m.owner}/${m.name}`,
          title: m.title,
          state: m.state,
          draft: m.isDraft === true,
          ciState: m.ciStatus ?? null,
          url: `https://github.com/${m.owner}/${m.name}/pull/${m.number}`,
          author:
            m.authorLogin != null
              ? { login: m.authorLogin, name: m.authorName ?? null, isBot: m.authorId != null && bots.has(m.authorId) }
              : null,
        })),
    );
  }
  return out;
}

/** The view's shared header: stamp the view, reset a read of another site, kick a due read. */
async function viewHeader(
  accountId: number,
  workspaceId: number,
  site: { provider: TrackerProvider; apiRoot: string },
  nowMs: number,
): Promise<SprintReadRow> {
  const viewed = await noteSprintViewed(accountId, workspaceId, new Date(nowMs));
  // A stored read of ANOTHER tracker or site (the workspace switched since) is not this list: make a
  // read due now and show "Reading…" — never the old read's time over an empty graph.
  const otherSite =
    (viewed.readAt != null || viewed.provider != null) && (viewed.provider !== site.provider || viewed.apiRoot !== site.apiRoot);
  const readRow: SprintReadRow = otherSite ? ((await resetSprintReadForSite(accountId, workspaceId, site)) ?? viewed) : viewed;
  if (readRow.nextReadAt.getTime() <= nowMs) kickSprintRead(accountId, workspaceId);
  return readRow;
}

async function layoutFor(
  accountId: number,
  workspaceId: number,
  t: GraphTickets,
  readRow: Pick<SprintReadRow, 'statusOrderJson'> | null,
): Promise<SprintStatusLayout> {
  return getSprintStatusLayout(accountId, workspaceId, {
    provider: t.provider,
    apiRoot: t.apiRoot,
    tickets: t.sprintRows.map((r) => ({ issueKey: r.issueKey, statusName: r.statusName ?? null, statusCategory: r.statusCategory ?? null })),
    autoOrder: readRow?.statusOrderJson ?? null,
  });
}

/** GET /api/sprint-graph — the whole graph, from what is stored. */
export async function getSprintGraph(
  accountId: number,
  workspaceId: number,
  opts: { aiEnabled: boolean; now: number },
): Promise<SprintGraphResponse> {
  const [{ workspaceSite }, { sprintReadErrorMessage }] = await Promise.all([
    import('./stories.js'),
    import('../tracker/sprint/read.js'),
  ]);
  const repos = await workspaceRepoRefs(accountId, workspaceId);
  const site = await workspaceSite(accountId, workspaceId);
  if (site == null) {
    return {
      workspaceId,
      trackerOn: false,
      provider: null,
      source: null,
      read: sprintReadStateOf(null, () => ''),
      statusLayout: null,
      nodes: [],
      edges: [],
      ghostsTruncated: false,
      briefs: { current: 0, pending: 0 },
      aiEnabled: opts.aiEnabled,
      repos,
      themes: null,
    };
  }
  const readRow = await viewHeader(accountId, workspaceId, site, opts.now);
  const source: SprintSource | null = readRow.sourceJson ?? null;
  const t = await loadGraphTickets(accountId, workspaceId, site, opts.aiEnabled);
  const statusLayout = await layoutFor(accountId, workspaceId, t, readRow);
  const stageOf = (s: GraphTicketInput['status']) => (s == null ? null : sprintStageOf(statusLayout, s));
  // PRs only for what can be a node: the sprint plus the stored ghosts.
  const prs = await graphPrsFor(accountId, workspaceId, site, [...t.sprintRows.map((r) => r.issueKey), ...t.refRows.map((r) => r.issueKey)]);
  const themes = opts.aiEnabled ? await currentSprintThemes(accountId, workspaceId, sprintThemeInputOf(t).inputHash) : null;
  const g = foldSprintGraph({
    provider: site.provider,
    apiRoot: site.apiRoot,
    sprint: t.sprint,
    ghosts: t.ghosts,
    stageOf,
    prs,
    ...(themes != null ? { themes: themes.byIdent } : {}),
  });
  return {
    workspaceId,
    trackerOn: true,
    provider: site.provider,
    source,
    read: sprintReadStateOf(readRow, (code) => sprintReadErrorMessage(site.provider, code)),
    statusLayout,
    nodes: g.nodes,
    edges: g.edges,
    ghostsTruncated: g.ghostsTruncated,
    briefs: {
      current: g.nodes.filter((n) => n.brief.state === 'current').length,
      pending: g.nodes.filter((n) => n.brief.state === 'pending').length,
    },
    aiEnabled: opts.aiEnabled,
    repos,
    themes: themes?.themes ?? null,
  };
}

/** The theme pass's input: the sprint's tickets (never ghosts) with their CURRENT brief summaries. */
export function sprintThemeInputOf(t: Pick<GraphTickets, 'sprint'>): SprintThemeInput {
  return sprintThemeInput(t.sprint.map((x) => ({ ident: x.ident, key: x.key, title: x.title, summary: x.brief?.summary ?? null })));
}

/** The theme pass's input for this workspace's current sprint (null: no tracker). */
export async function sprintThemeTodo(accountId: number, workspaceId: number): Promise<SprintThemeInput | null> {
  const { workspaceSite } = await import('./stories.js');
  const site = await workspaceSite(accountId, workspaceId);
  if (site == null) return null;
  return sprintThemeInputOf(await loadGraphTickets(accountId, workspaceId, site, true));
}

/** The references of one ticket for the drawer: its tracker links, then its brief's references —
 *  one per (key, relation), itself excluded. Pure (exported for its test). */
export function ticketReferencesOf(
  t: Pick<GraphTicketInput, 'ident' | 'links' | 'brief'>,
  provider: TrackerProvider,
  apiRoot: string,
  known: ReadonlyMap<string, { key: string; title: string; status: GraphTicketInput['status']; url: string | null; assignee?: GraphTicketInput['assignee'] }>,
  inGraph: ReadonlySet<string>,
): SprintTicketReference[] {
  const out: SprintTicketReference[] = [];
  const seen = new Set<string>();
  const push = (raw: string, relation: SprintTicketReference['relation'], quote: string | null, fallback: { title: string | null; status: string | null; category: JiraStatusCategory | null; url: string | null } | null): void => {
    const id = identOfKey(provider, apiRoot, raw);
    if (id == null || id.ident === t.ident) return;
    const k = `${id.ident}\u0000${relation}`;
    if (seen.has(k)) return;
    seen.add(k);
    const row = known.get(id.ident);
    const category = row?.status?.category ?? fallback?.category ?? null;
    out.push({
      ident: id.ident,
      key: id.key,
      title: row != null && row.title !== '' ? row.title : (fallback?.title ?? null),
      status: row?.status?.name ?? fallback?.status ?? null,
      done: category == null ? null : category === 'done',
      relation,
      quote,
      inGraph: inGraph.has(id.ident),
      url: row?.url ?? fallback?.url ?? null,
      // A ticket we hold a row for: its assignee or null (unassigned). One we never read: no claim.
      ...(row != null ? { assignee: row.assignee ?? null } : {}),
    });
  };
  for (const l of t.links ?? []) {
    push(l.key, isBlockingRelation(l.relation) ? 'blocked_by' : 'linked', null, { title: l.title, status: l.status, category: l.category, url: l.url });
  }
  for (const r of t.brief?.references ?? []) push(r.ticketKey, r.relation, r.quote, null);
  return out;
}

/** GET /api/sprint-graph/ticket — the drawer. `prsOf` is the ticket tab's fold (`ticketPrs`), handed in
 *  by the route so this module never imports the tracker context. */
export async function getSprintTicketDetail(
  accountId: number,
  workspaceId: number,
  ident: string,
  opts: { aiEnabled: boolean; now: number; prsOf: (ident: string) => Promise<TicketPrsResponse> },
): Promise<SprintTicketDetailResponse> {
  const emptyPrs: TicketPrsResponse = {
    workspaceId,
    ident,
    found: false,
    ticket: null,
    open: [],
    merged: [],
    closed: [],
    outsideWorkspace: 0,
    truncated: false,
  };
  const none: SprintTicketDetailResponse = {
    workspaceId,
    ident,
    found: false,
    ticket: null,
    briefState: opts.aiEnabled ? 'pending' : 'off',
    brief: null,
    references: [],
    prs: emptyPrs,
    repos: null,
    assessment: null,
    aiEnabled: opts.aiEnabled,
  };
  if (parseTicketIdent(ident) == null) return none;
  const { workspaceSite } = await import('./stories.js');
  const site = await workspaceSite(accountId, workspaceId);
  if (site == null) return none;
  const t = await loadGraphTickets(accountId, workspaceId, site, opts.aiEnabled);
  const sr = schema.sprintReads;
  const readRow = (
    await db
      .select({ statusOrderJson: sr.statusOrderJson })
      .from(sr)
      .where(and(eq(sr.accountId, accountId), eq(sr.workspaceId, workspaceId)))
      .limit(1)
      .execute()
  )[0] as Pick<SprintReadRow, 'statusOrderJson'> | undefined;
  const statusLayout = await layoutFor(accountId, workspaceId, t, readRow ?? null);
  const stageOf = (s: GraphTicketInput['status']) => (s == null ? null : sprintStageOf(statusLayout, s));
  const g = foldSprintGraph({ provider: site.provider, apiRoot: site.apiRoot, sprint: t.sprint, ghosts: t.ghosts, stageOf });
  const node = g.nodes.find((n) => n.ident === ident);
  if (node == null) return none;
  const input = (node.ghost ? t.ghosts : t.sprint).find((x) => x.ident === ident)!;
  const known = new Map(
    [...t.sprint, ...t.ghosts].map((x) => [x.ident, { key: x.key, title: x.title, status: x.status, url: x.url, assignee: x.assignee }] as const),
  );
  const references = ticketReferencesOf(input, site.provider, site.apiRoot, known, new Set(g.nodes.map((n) => n.ident)));
  const prs = await opts.prsOf(ident);
  let repos: SprintTicketDetailResponse['repos'] = null;
  let assessment: SprintTicketDetailResponse['assessment'] = null;
  if (!node.ghost) {
    const row = t.sprintRows.find((r) => r.ident === ident)!;
    const eff = (await effectiveSprintRepos(accountId, workspaceId, [ident], { rows: [row], nowMs: opts.now })).get(ident);
    const acc = eff?.accepted ?? [];
    repos = {
      accepted: acc.map((d) => ({ repoId: d.repoId, fullName: d.fullName })),
      suggested: eff?.suggested ?? [],
      defaulted: eff?.defaulted ?? false,
    };
    const a = (await latestSprintAssessments(accountId, workspaceId, [ident])).get(ident);
    if (a != null) {
      const mode = sprintAssessModeOf(node.stage ?? 'not_started');
      assessment = { record: sprintAssessmentRecordOf(a), currency: sprintAssessmentCurrencyFrom(a, row, acc, mode) };
    }
  }
  return {
    workspaceId,
    ident,
    found: true,
    ticket: {
      ident: node.ident,
      key: node.key,
      title: node.title,
      url: node.url,
      provider: node.provider,
      ghost: node.ghost,
      depth: node.depth,
      status: node.status,
      stage: node.stage,
      issueType: node.issueType,
      assignee: node.assignee,
      epic: node.epic,
    },
    briefState: node.brief.state,
    brief: input.brief,
    references,
    prs,
    repos,
    assessment,
    aiEnabled: opts.aiEnabled,
  };
}

/** The brief pass's to-do list: graph NODES (sprint first, then ghosts by depth) with no current
 *  brief, with their input. ≤ `cap`. */
export async function sprintBriefTodo(
  accountId: number,
  workspaceId: number,
  cap: number,
): Promise<Array<{ ident: string; provider: TrackerProvider; input: SprintBriefInput }>> {
  const { workspaceSite } = await import('./stories.js');
  const site = await workspaceSite(accountId, workspaceId);
  if (site == null) return [];
  const t = await loadGraphTickets(accountId, workspaceId, site, true);
  const g = foldSprintGraph({ provider: site.provider, apiRoot: site.apiRoot, sprint: t.sprint, ghosts: t.ghosts, stageOf: () => null });
  return g.nodes
    .filter((n) => n.brief.state !== 'current')
    .slice(0, cap)
    .map((n) => ({ ident: n.ident, provider: site.provider, input: t.inputs.get(n.ident)! }));
}
