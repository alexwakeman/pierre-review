import { isSprintPassRunning } from './sprint-pass-flights.js';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  isBlockingRelation,
  parseTicketIdent,
  sprintSourceTitle,
  parseTicketLinkBlockers,
  trackerTicketIdent,
  type CiStatus,
  type JiraStatusCategory,
  type SprintBrief,
  type SprintBriefState,
  type SprintDates,
  type SprintGraphPr,
  type SprintGraphResponse,
  type SprintGraphTokenResponse,
  type SprintColumn,
  type SprintSource,
  type SprintStatusLayout,
  type TicketStoryResponse,
  type TicketStoryTicket,
  type TrackerProvider,
} from '@pierre-review/shared';
import { globalAutomationUserIds } from './automation-ids.js';
import { db, schema } from './client.js';
import { currentSprintBriefs, sprintBriefInput, type SprintBriefInput } from './sprint-briefs.js';
import { currentSprintCodeJudgements, sprintCodeJudgeInput, type SprintCodeJudgeInput } from './sprint-code-judgements.js';
import {
  SPRINT_EMPTY_CHANGE_TOKEN,
  foldSprintGraph,
  sprintChangeTokenOf,
  type GraphFoldResult,
  type GraphTicketInput,
} from './sprint-graph-fold.js';
import { sprintTicketChecksFor } from './sprint-ticket-checks.js';
import {
  isSprintPathsQueued,
  isSprintPathsRunning,
  reviewsWaitingByLogin,
  runsTodayOf,
  sprintPaceOf,
  sprintPathsInput,
  sprintPathsOf,
  sprintPathsStatusOf,
  sprintPeopleOf,
  sprintTimingOf,
  sprintTimingOfDates,
  storedSprintPaths,
  type SprintPathsInput,
  type SprintTiming,
} from './sprint-paths.js';
import { sprintSignalsFor } from './sprint-signals.js';
import { currentSprintThemes, sprintThemeInput, type SprintThemeInput } from './sprint-themes.js';
import {
  kickSprintRead,
  noteSprintViewed,
  readSprintRead,
  resetSprintReadForSite,
  sprintReadStateOf,
  type SprintReadRow,
  type SprintTicketDbRow,
} from './sprint-store.js';
import { getSprintStatusLayout, mergeRuleTarget, sprintPlacementOf } from './sprint-status-layout.js';

// REPORTS → THIS SPRINT AS A GRAPH (`GET /api/sprint-graph`; and the story view's `GET /api/ticket-story`;
// docs/API.md § This sprint). DB ONLY — no tracker, GitHub or model call: a view STAMPS the workspace
// as viewed (the sprint read's demand gate) and kicks a read that is due, nothing else.
//
//   • POPULATION: this workspace's `sprint_tickets` with `in_sprint` on the tracker's CURRENT site,
//     plus the ghosts the sprint read stored (`sprint_ref_tickets`) that the fold reaches
//     (db/sprint-graph-fold.ts — the ONE fold the brief pass and the ghost lookup use too).
//   • BUCKETS: the workspace's status layout places every node, ghosts included (`sprintPlacementOf`:
//     bucket + its meaning as `stage`), and the fold derives each node's `column` (`sprintColumnOf`).
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

/** The ONE fold of what is stored — the graph GET and the change-token GET share it, so both answer
 *  the same `changeToken` for the same state. DB only; stamps nothing. */
async function foldStoredSprint(
  accountId: number,
  workspaceId: number,
  site: { provider: TrackerProvider; apiRoot: string },
  aiEnabled: boolean,
  readRow: Pick<SprintReadRow, 'statusOrderJson'> | null,
): Promise<{ t: GraphTickets; statusLayout: SprintStatusLayout; themes: Awaited<ReturnType<typeof currentSprintThemes>>; g: GraphFoldResult }> {
  const t = await loadGraphTickets(accountId, workspaceId, site, aiEnabled);
  const statusLayout = await layoutFor(accountId, workspaceId, t, readRow);
  const placeOf = (s: GraphTicketInput['status']) => (s == null ? null : sprintPlacementOf(statusLayout, s));
  const placing = { stageOf: (s: GraphTicketInput['status']) => placeOf(s)?.stage ?? null, placeOf, productReviewId: mergeRuleTarget(statusLayout) };
  // PRs only for what can be a node: the sprint plus the stored ghosts.
  const prs = await graphPrsFor(accountId, workspaceId, site, [...t.sprintRows.map((r) => r.issueKey), ...t.refRows.map((r) => r.issueKey)]);
  const themes = aiEnabled ? await currentSprintThemes(accountId, workspaceId, sprintThemeInputOf(t).inputHash) : null;
  // THE TICKET CHECKS ("n of m met", db/sprint-ticket-checks.ts): sprint tickets only, batched; the
  // ticket review is agentic, so AI off reads none.
  const checks = aiEnabled ? await sprintTicketChecksFor(accountId, t.sprint.map((x) => x.ident), prs) : undefined;
  // "NEEDS CODE" (db/sprint-code-judgements.ts): CURRENT judgements only; the fold asks only about a
  // sprint ticket in Not started with no pull request. AI off → 'off'; not judged for today's text → 'pending'.
  const judgeInputs = sprintCodeJudgeInputsOf(t);
  const judged = aiEnabled
    ? await currentSprintCodeJudgements(accountId, workspaceId, [...judgeInputs].map(([ident, input]) => ({ ident, input })))
    : null;
  const g = foldSprintGraph({
    provider: site.provider,
    apiRoot: site.apiRoot,
    sprint: t.sprint,
    ghosts: t.ghosts,
    ...placing,
    prs,
    ...(themes != null ? { themes: themes.byIdent } : {}),
    ...(checks != null ? { checks } : {}),
    codeJudgementOf: (ident) => (judged == null ? { state: 'off', reason: null } : (judged.get(ident) ?? { state: 'pending', reason: null })),
  });
  return { t, statusLayout, themes, g };
}

/** Every sprint ticket's "needs code" input, by ident. */
function sprintCodeJudgeInputsOf(t: Pick<GraphTickets, 'sprintRows' | 'provider'>): Map<string, SprintCodeJudgeInput> {
  return new Map(t.sprintRows.map((r) => [r.ident, sprintCodeJudgeInput(r, t.provider)] as const));
}

/** The "needs code" pass's to-do list (review/sprint-code/): the sprint tickets the fold ASKS about
 *  (Not started, no pull request) with no current judgement, in the board's order, ≤ `cap`, with their
 *  key and input. Folded exactly as the graph GET folds it, WITHOUT stamping the view or kicking a read.
 *  [] with no tracker. */
export async function sprintCodeJudgeTodo(
  accountId: number,
  workspaceId: number,
  cap: number,
): Promise<Array<{ ident: string; key: string; input: SprintCodeJudgeInput }>> {
  const { workspaceSite } = await import('./stories.js');
  const site = await workspaceSite(accountId, workspaceId);
  if (site == null) return [];
  const readRow = await readSprintRead(accountId, workspaceId);
  const { t, g } = await foldStoredSprint(accountId, workspaceId, site, true, readRow);
  const inputs = sprintCodeJudgeInputsOf(t);
  return g.nodes
    .filter((n) => n.codeJudgement?.state === 'pending' && inputs.has(n.ident))
    .slice(0, cap)
    .map((n) => ({ ident: n.ident, key: n.key, input: inputs.get(n.ident)! }));
}

/** GET /api/sprint-graph/token — the change token alone. DB ONLY and SIDE-EFFECT FREE: no view stamp
 *  (the read's demand gate is the graph GET's), no read kick, no "since you last looked" snapshot. */
export async function getSprintChangeToken(
  accountId: number,
  workspaceId: number,
  opts: { aiEnabled: boolean },
): Promise<SprintGraphTokenResponse> {
  const { workspaceSite } = await import('./stories.js');
  const site = await workspaceSite(accountId, workspaceId);
  if (site == null) return { workspaceId, changeToken: SPRINT_EMPTY_CHANGE_TOKEN };
  const readRow = await readSprintRead(accountId, workspaceId);
  const { g } = await foldStoredSprint(accountId, workspaceId, site, opts.aiEnabled, readRow);
  return { workspaceId, changeToken: sprintChangeTokenOf(g) };
}

/** GET /api/sprint-graph — the whole graph, from what is stored. */
export async function getSprintGraph(
  accountId: number,
  workspaceId: number,
  opts: {
    aiEnabled: boolean;
    now: number;
    /** A builder pass could run here (AI on AND a Claude credential). Absent = `aiEnabled`. Only
     *  `pathsStatus` reads it: with no credential "waiting for the next read" would show for ever. */
    pathsCanRun?: boolean;
  },
): Promise<SprintGraphResponse> {
  const [{ workspaceSite }, { sprintReadErrorMessage }] = await Promise.all([
    import('./stories.js'),
    import('../tracker/sprint/read.js'),
  ]);
  const site = await workspaceSite(accountId, workspaceId);
  if (site == null) {
    return {
      workspaceId,
      trackerOn: false,
      changeToken: SPRINT_EMPTY_CHANGE_TOKEN,
      provider: null,
      source: null,
      read: sprintReadStateOf(null, () => ''),
      statusLayout: null,
      nodes: [],
      edges: [],
      ghostsTruncated: false,
      briefs: { current: 0, pending: 0 },
      aiEnabled: opts.aiEnabled,
      themes: null,
      paths: null,
      pathsStatus: { state: 'none', stale: false, lastAttemptAt: null, failure: null },
      pace: null,
      people: [],
      sprintDates: null,
      signals: [],
    };
  }
  const readRow = await viewHeader(accountId, workspaceId, site, opts.now);
  const source: SprintSource | null = readRow.sourceJson ?? null;
  const { statusLayout, themes, g } = await foldStoredSprint(accountId, workspaceId, site, opts.aiEnabled, readRow);
  // THE PATHS: the LAST ones written (any version), even when the input hash has moved — marked STALE.
  // The hash covers GitHub-synced facts (PR states, CI) that change between sprint reads, and the pass
  // runs only after a read, so "current only" would blank them on every merge. The hash stays the
  // RE-BILL gate (review/sprint-paths/manager.ts), never the display gate. `pathsStatus` says where the
  // builder stands for TODAY's input (`sprintPathsStatusOf`, the ONE fold).
  const timing = await sprintTimingFor(accountId, workspaceId, source, opts.now, readRow);
  const pathsInput = opts.aiEnabled ? sprintPathsInputOf(source, g, statusLayout.columns, timing) : null;
  const pathsRow = pathsInput?.eligible ? await storedSprintPaths(accountId, workspaceId) : null;
  const keyIdent = new Map(g.nodes.map((n) => [n.key.toUpperCase(), n.ident] as const));
  // Resolved against TODAY's nodes only: a key that left the sprint and the ghost set is dropped (a
  // path left with no ticket goes with it), never handed out as an ident no node carries.
  const pathsNow = pathsRow != null ? sprintPathsOf(pathsRow, (k) => keyIdent.get(k.toUpperCase()) ?? null) : null;
  const { config } = await import('../config.js');
  const builder = {
    paths: pathsNow,
    pathsStatus: sprintPathsStatusOf({
      aiEnabled: opts.aiEnabled,
      canRun: opts.pathsCanRun ?? opts.aiEnabled,
      eligible: pathsInput?.eligible === true,
      inputHash: pathsInput?.inputHash ?? null,
      row: pathsRow,
      hasPaths: pathsNow != null,
      running: isSprintPathsRunning(accountId, workspaceId),
      queued: isSprintPathsQueued(accountId, workspaceId),
      capped: runsTodayOf(pathsRow, new Date(opts.now)) >= config.sprintPathsDailyCap,
    }),
    pace: sprintPaceOf(g.nodes, g.edges, timing),
    people: await sprintPeopleFor(accountId, workspaceId, g.nodes),
    sprintDates: await sprintDatesFor(accountId, workspaceId, source, opts.now, readRow),
  };
  // THE CODE CARDS (db/sprint-signals.ts): free, DB only. The view's snapshot is recorded only once a
  // sprint read has produced tickets — an empty list must never become the "since you last looked" baseline.
  const signals = await sprintSignalsFor(
    accountId,
    workspaceId,
    { nodes: g.nodes, edges: g.edges, timing, record: source != null && g.nodes.some((n) => !n.ghost) },
    opts.now,
  );
  return {
    workspaceId,
    trackerOn: true,
    changeToken: sprintChangeTokenOf(g),
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
    themes: themes?.themes ?? null,
    // The status line's "now" half: which Claude passes are running for this workspace right now.
    passes: {
      briefsRunning: isSprintPassRunning('briefs', accountId, workspaceId),
      themesRunning: isSprintPassRunning('themes', accountId, workspaceId),
    },
    ...builder,
    signals,
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

/** The builder's input from a folded graph — the ONE builder the GET and the pass share. */
export function sprintPathsInputOf(
  source: SprintSource | null,
  g: Pick<GraphFoldResult, 'nodes' | 'edges'>,
  columns: readonly SprintColumn[],
  timing: SprintTiming | null = null,
): SprintPathsInput {
  return sprintPathsInput({ sprintName: source != null ? sprintSourceTitle(source) : null, nodes: g.nodes, edges: g.edges, columns, timing });
}

/** `SprintGraphResponse.people`: the sprint's assignees through the ONE member mapping, with the open
 *  review requests waiting on each mapped GitHub login (db/sprint-paths.ts). */
async function sprintPeopleFor(accountId: number, workspaceId: number, nodes: GraphFoldResult['nodes']): Promise<GraphPeople> {
  const logins = new Set<string>();
  for (const n of nodes) if (!n.ghost) for (const p of n.prs) if (p.author != null && !p.author.isBot) logins.add(p.author.login);
  return sprintPeopleOf(nodes, await reviewsWaitingByLogin(accountId, workspaceId, [...logins]));
}
type GraphPeople = SprintGraphResponse['people'];

/**
 * Where today sits in the workspace's sprint, in whole days. FIRST the TRACKER's own sprint dates (the
 * sprint read stores them on `sprint_reads.sprint_starts_at/_ends_at`; both ends needed), else the
 * workspace's STORED cadence + phase anchor resolved through the ONE reporting-window resolver
 * (`getReportingWindow`; the plugin's `resolveComparisonWindow`) when its mode is 'sprint'. Null when
 * neither is a real sprint (OSS, no cadence, a rolling mode — the trailing-14-day fallback is never a
 * sprint), and when the list is the tracker's STATUS FALLBACK (no sprint was read, so the tickets are
 * not the sprint's). Never throws: no timing on a failure.
 */
export async function sprintTimingFor(
  accountId: number,
  workspaceId: number,
  source: SprintSource | null,
  nowMs: number,
  readRow: Pick<SprintReadRow, 'sprintStartsAt' | 'sprintEndsAt'> | null = null,
): Promise<SprintTiming | null> {
  if (source == null || source.kind === 'status_fallback') return null;
  const fromTracker = sprintTimingOfDates(readRow?.sprintStartsAt, readRow?.sprintEndsAt, nowMs);
  if (fromTracker != null) return fromTracker;
  try {
    const { getReportingWindow } = await import('./reporting-window.js');
    return sprintTimingOf(await getReportingWindow(accountId, workspaceId, nowMs), nowMs);
  } catch {
    return null;
  }
}

/** The page header's sprint dates: the tracker's own (either end), else the cadence's sprint window
 *  (reporting-window mode 'sprint'), else null. Never for the status fallback. Never throws. */
export async function sprintDatesFor(
  accountId: number,
  workspaceId: number,
  source: SprintSource | null,
  nowMs: number,
  readRow: Pick<SprintReadRow, 'sprintStartsAt' | 'sprintEndsAt'> | null,
): Promise<SprintDates | null> {
  if (source == null || source.kind === 'status_fallback') return null;
  const s = readRow?.sprintStartsAt ?? null;
  const e = readRow?.sprintEndsAt ?? null;
  if (s != null || e != null) return { startsAt: s?.toISOString() ?? null, endsAt: e?.toISOString() ?? null, source: 'tracker' };
  try {
    const { getReportingWindow } = await import('./reporting-window.js');
    const w = await getReportingWindow(accountId, workspaceId, nowMs);
    if (w.mode !== 'sprint' || sprintTimingOf(w, nowMs) == null) return null;
    return { startsAt: new Date(w.fromMs).toISOString(), endsAt: new Date(w.toMs).toISOString(), source: 'cadence' };
  } catch {
    return null;
  }
}

/** The builder's input for this workspace's current sprint (null: no tracker), folded exactly as
 *  `getSprintGraph` folds it — WITHOUT stamping the view or kicking a read (a background pass is not a
 *  view). AI on by construction: the pass only runs where it is. */
export async function sprintPathsTodo(accountId: number, workspaceId: number): Promise<SprintPathsInput | null> {
  const { workspaceSite } = await import('./stories.js');
  const site = await workspaceSite(accountId, workspaceId);
  if (site == null) return null;
  const readRow = await readSprintRead(accountId, workspaceId);
  const t = await loadGraphTickets(accountId, workspaceId, site, true);
  const statusLayout = await layoutFor(accountId, workspaceId, t, readRow);
  const placeOf = (s: GraphTicketInput['status']) => (s == null ? null : sprintPlacementOf(statusLayout, s));
  const placing = { stageOf: (s: GraphTicketInput['status']) => placeOf(s)?.stage ?? null, placeOf, productReviewId: mergeRuleTarget(statusLayout) };
  const prs = await graphPrsFor(accountId, workspaceId, site, [...t.sprintRows.map((r) => r.issueKey), ...t.refRows.map((r) => r.issueKey)]);
  const themes = await currentSprintThemes(accountId, workspaceId, sprintThemeInputOf(t).inputHash);
  const g = foldSprintGraph({
    provider: site.provider,
    apiRoot: site.apiRoot,
    sprint: t.sprint,
    ghosts: t.ghosts,
    ...placing,
    prs,
    ...(themes != null ? { themes: themes.byIdent } : {}),
  });
  const source = readRow?.sourceJson ?? null;
  return sprintPathsInputOf(source, g, statusLayout.columns, await sprintTimingFor(accountId, workspaceId, source, Date.now(), readRow));
}

/** GET /api/ticket-story — the STORY VIEW's lean read (docs/API.md § GET /api/ticket-story). DB only:
 *  ONE ticket's stored sprint text on the tracker's CURRENT site, read by the GRAPH's own rule
 *  (`loadGraphTickets`): this workspace's `sprint_tickets` row while it is IN the sprint; otherwise its
 *  `sprint_ref_tickets` row (the fresh text a ghost is built and briefed from); only with neither, the
 *  old out-of-sprint `sprint_tickets` row (briefState 'none' — nothing reads it again). Its CURRENT
 *  brief (text hash + SPRINT_BRIEF_VERSION). No graph fold, no PRs (the view reads those from
 *  `GET /api/ticket-prs`). A ticket Limn holds no sprint text for answers `found: false`. */
export async function getTicketStory(
  accountId: number,
  workspaceId: number,
  ident: string,
  opts: { aiEnabled: boolean },
): Promise<TicketStoryResponse> {
  const none: TicketStoryResponse = { workspaceId, ident, found: false, ticket: null, briefState: 'none', brief: null, story: null };
  if (parseTicketIdent(ident) == null) return none;
  const { workspaceSite } = await import('./stories.js');
  const site = await workspaceSite(accountId, workspaceId);
  if (site == null) return none;
  const st = schema.sprintTickets;
  const own = (
    (await db
      .select()
      .from(st)
      .where(and(eq(st.accountId, accountId), eq(st.workspaceId, workspaceId), eq(st.ident, ident), eq(st.provider, site.provider), eq(st.apiRoot, site.apiRoot)))
      .limit(1)
      .execute()) as SprintTicketDbRow[]
  )[0];
  const rt = schema.sprintRefTickets;
  const ref =
    own?.inSprint !== true
      ? (
          (await db
            .select()
            .from(rt)
            .where(and(eq(rt.accountId, accountId), eq(rt.workspaceId, workspaceId), eq(rt.ident, ident), eq(rt.provider, site.provider), eq(rt.apiRoot, site.apiRoot)))
            .limit(1)
            .execute()) as RefRow[]
        )[0]
      : undefined;
  // In the sprint → its own row; else the ref row (what the graph's ghost shows); else the old row.
  const inSprint = own?.inSprint === true;
  const sprintRow = inSprint ? own : undefined;
  const row = sprintRow ?? ref ?? own;
  if (row == null) return none;
  const status = row.statusName != null ? { name: row.statusName, category: categoryOf(row.statusCategory) } : null;
  const ticket: TicketStoryTicket = {
    key: row.issueKey,
    title: row.title != null && row.title.trim() !== '' ? row.title : null,
    url: row.url ?? null,
    provider: site.provider,
    status,
    issueType: row.issueTypeName ?? null,
    assignee: row.assigneeName != null ? { name: row.assigneeName, avatarUrl: row.assigneeAvatarUrl ?? null } : null,
    epic: row === own && own.epicKey != null ? { key: own.epicKey, title: own.epicTitle ?? null } : null,
    inSprint,
  };
  const story = { description: row.description ?? '', acceptanceCriteria: row.acceptanceCriteria ?? '' };
  if (!opts.aiEnabled) return { workspaceId, ident, found: true, ticket, briefState: 'off', brief: null, story };
  const input = sprintBriefInput(row, site.provider);
  const brief = (await currentSprintBriefs(accountId, workspaceId, [{ ident, input }])).get(ident) ?? null;
  // The brief pass reads the graph: a sprint ticket and the tickets it leads to (ref rows). An old
  // out-of-sprint row is not read again, so "pending" would wait for ever — it says nothing instead.
  const briefState: TicketStoryResponse['briefState'] = brief != null ? 'current' : row === own && !inSprint ? 'none' : 'pending';
  return { workspaceId, ident, found: true, ticket, briefState, brief, story };
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
