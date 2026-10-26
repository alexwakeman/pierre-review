import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  aiRunProvider,
  SPRINT_EDGE_LABEL,
  SPRINT_PATHS_CAPS,
  SPRINT_PATHS_MODEL,
  SPRINT_PATHS_VERSION,
  SPRINT_PATH_RISKS,
  SPRINT_STAGE_LABEL,
  sprintDayOf,
  sprintMembers,
  type SprintCallout,
  type SprintColumn,
  type SprintGraphEdge,
  type SprintGraphNode,
  type SprintPace,
  type SprintPath,
  type SprintPathRisk,
  type SprintPaths,
  type SprintPathsFailure,
  type SprintPathsStatus,
  type SprintPerson,
} from '@pierre-review/shared';

// ACTIVITY → THIS SPRINT — THE SPRINT BUILDER'S INPUT + STORE, THE PACE AND THE PEOPLE
// (docs/CLAUDE-REVIEW.md § Sprint paths).
//
//   • THE INPUT (`sprintPathsInput`) is built by CODE from the folded graph (db/sprint-graph.ts — the
//     SAME fold the page draws): every sprint ticket (key, short title, theme, column name + meaning,
//     assignee, pull request states + CI, the CURRENT brief's summary), the `depends_on` and `builds_on`
//     edges with the brief's `why`, the outside tickets a sprint ticket depends on or builds on (key,
//     title, status), the dependency chains code found, and the PACE facts. The model may name ONLY the
//     keys listed here (review/sprint-paths/validate.ts).
//   • THE HASH covers everything sent EXCEPT the now-derived day facts (CLAUDE.md: a `Date.now()`-derived
//     field must never enter a payload hash, or a dormant sprint re-bills every day). The day line is
//     still SENT; stored advice carries no digit, so an older day never shows through. Plus
//     SPRINT_PATHS_VERSION. Current only while `input_hash` matches today's AND `paths_version` is
//     SPRINT_PATHS_VERSION.
//   • THE PACE (`sprintPaceOf`) and THE PEOPLE (`sprintPeopleOf`) are free code folds on the GET.
//     People: the ONE assignee → GitHub mapping (shared `sprintMembers`, the Members filter's), and
//     "reviews waiting" = open pull requests in this workspace's repos with an outstanding
//     `review_requests` row for that person's user id(s) — the People report's population
//     (db/person-period.ts). No mapped login → null, never 0.
//   • NO PERSON IS NAMED to the model: assignees reach the input as "assigned" / "unassigned" only.
//
// ⚠ PURE AT IMPORT: the DB client is reached LAZILY inside the readers (a pure test never opens it).

/** Where today sits in a REAL sprint window, in WHOLE days. `day` counts the day you are in (1-based);
 *  `daysLeft` are the days after today. */
export interface SprintTiming {
  day: number;
  days: number;
  daysLeft: number;
}

/** The sprint timing for a reporting window, or null when the window is not a sprint (mode other than
 *  'sprint' — the trailing-days fallback). Day granularity only (shared `sprintDayOf`). Pure. */
export function sprintTimingOf(
  w: { fromMs: number; toMs: number; mode: string } | null | undefined,
  nowMs: number,
): SprintTiming | null {
  if (w == null || w.mode !== 'sprint') return null;
  return sprintDayOf(w.fromMs, w.toMs, nowMs);
}

/** The sprint timing from the TRACKER's own sprint dates; null unless both ends are known. Pure. */
export function sprintTimingOfDates(startsAt: Date | null | undefined, endsAt: Date | null | undefined, nowMs: number): SprintTiming | null {
  if (startsAt == null || endsAt == null) return null;
  return sprintDayOf(startsAt.getTime(), endsAt.getTime(), nowMs);
}

const TITLE_MAX = 100;
const SUMMARY_MAX = 300;
const WHY_MAX = 160;
/** Chains listed to the model as hints (the pace counts all of them). */
export const SPRINT_PATHS_CHAINS_LISTED = 8;

const isDone = (n: Pick<SprintGraphNode, 'stage'>): boolean => n.stage === 'done';
const byKey = (a: SprintGraphNode, b: SprintGraphNode): number =>
  a.key.localeCompare(b.key, undefined, { numeric: true }) || a.ident.localeCompare(b.ident);
const oneLine = (s: string | null | undefined, max: number): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  let cut = max - 1;
  const c = t.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return `${t.slice(0, cut)}…`;
};
const pct = (n: number, of: number): number => (of === 0 ? 0 : Math.round((100 * n) / of));

/** Every `depends_on` path (dependent first) whose every link waits on an UNFINISHED prerequisite and
 *  that touches a live sprint ticket, longest first, overlapping ones dropped (a path sharing half its
 *  tickets with a longer one is the same chain). Pure. */
export function sprintChains(nodes: readonly SprintGraphNode[], edges: readonly SprintGraphEdge[]): string[][] {
  const byIdent = new Map(nodes.map((n) => [n.ident, n]));
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== 'depends_on' || !byIdent.has(e.from) || !byIdent.has(e.to) || e.from === e.to) continue;
    if (isDone(byIdent.get(e.to)!)) continue;
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }
  for (const [k, v] of out) out.set(k, [...new Set(v)].sort((a, b) => byKey(byIdent.get(a)!, byIdent.get(b)!)));
  const memo = new Map<string, string[]>();
  const onStack = new Set<string>();
  const longest = (id: string): string[] => {
    const hit = memo.get(id);
    if (hit) return hit;
    if (onStack.has(id)) return [id];
    onStack.add(id);
    let best: string[] = [];
    for (const to of out.get(id) ?? []) {
      if (onStack.has(to)) continue;
      const p = longest(to);
      if (p.length > best.length) best = p;
    }
    onStack.delete(id);
    const path = [id, ...best];
    memo.set(id, path);
    return path;
  };
  const paths = [...out.keys()]
    .map((id) => longest(id))
    .filter((p) => p.length >= 2)
    .filter((p) => p.some((id) => { const n = byIdent.get(id)!; return !n.ghost && !isDone(n); }))
    .sort((a, b) => b.length - a.length || byKey(byIdent.get(a[0]!)!, byIdent.get(b[0]!)!));
  const picked: string[][] = [];
  const used = new Set<string>();
  for (const p of paths) {
    const overlap = p.filter((id) => used.has(id)).length;
    if (overlap * 2 >= p.length) continue;
    picked.push(p);
    for (const id of p) used.add(id);
  }
  return picked;
}

// ── The pace ─────────────────────────────────────────────────────────────────────────────────────

/** CODE's pace facts over the sprint's tickets. Pure. */
export function sprintPaceOf(
  nodes: readonly SprintGraphNode[],
  edges: readonly SprintGraphEdge[],
  timing: SprintTiming | null | undefined,
): SprintPace {
  const sprint = nodes.filter((n) => !n.ghost);
  const byIdent = new Map(nodes.map((n) => [n.ident, n]));
  const done = sprint.filter(isDone).length;
  let openDependencies = 0;
  for (const e of edges) {
    if (e.kind !== 'depends_on') continue;
    const from = byIdent.get(e.from);
    const to = byIdent.get(e.to);
    if (from == null || to == null || from.ghost || isDone(from) || isDone(to)) continue;
    openDependencies += 1;
  }
  return {
    daysElapsed: timing?.day ?? null,
    daysTotal: timing?.days ?? null,
    timeUsedPct: timing != null ? pct(timing.day, timing.days) : null,
    tickets: sprint.length,
    live: sprint.length - done,
    done,
    // A Product review column: a status placed there (`stage`), or moved there by the merge rule — the
    // only way a node's column differs from its bucket.
    productReview: sprint.filter((n) => n.stage === 'product_review' || (n.column != null && n.column !== n.bucketId)).length,
    codeMerged: sprint.filter((n) => n.prs.some((p) => p.state === 'merged') && !n.prs.some((p) => p.state === 'open')).length,
    openDependencies,
    chains: sprintChains(nodes, edges).length,
  };
}

// ── The people ───────────────────────────────────────────────────────────────────────────────────

/** One person per distinct sprint ASSIGNEE (shared `sprintMembers`; GitHub-only members are not
 *  assignees and are left out), alphabetical. `waitingByLogin` maps a GitHub login to its open review
 *  requests' PR ids; a person with no mapped login → null. Pure. */
export function sprintPeopleOf(
  nodes: ReadonlyArray<Pick<SprintGraphNode, 'ghost' | 'assignee' | 'prs'>>,
  waitingByLogin: ReadonlyMap<string, ReadonlySet<number>>,
): SprintPerson[] {
  return sprintMembers(nodes)
    .filter((m) => m.names.length > 0)
    .map((m) => {
      if (m.logins.length === 0) return { name: m.label, names: [...m.names], reviewsWaiting: null };
      const prs = new Set<number>();
      for (const l of m.logins) for (const id of waitingByLogin.get(l.toLowerCase()) ?? []) prs.add(id);
      return { name: m.label, names: [...m.names], reviewsWaiting: prs.size };
    });
}

/** Open PRs in THIS workspace's repos with an outstanding review request, by requested login
 *  (lower-cased). DB; `users` is global, read only for the logins asked about. */
export async function reviewsWaitingByLogin(accountId: number, workspaceId: number, logins: readonly string[]): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>();
  const list = [...new Set(logins.filter((l) => l.trim() !== ''))];
  if (list.length === 0) return out;
  const { db, schema } = await import('./client.js');
  const { reviewRequests: rr, pullRequests: pr, workspaceRepos: wr, users: u } = schema;
  const rows = (await db
    .select({ login: u.githubLogin, prId: pr.id })
    .from(rr)
    .innerJoin(u, eq(u.id, rr.userId))
    .innerJoin(pr, and(eq(pr.id, rr.prId), eq(pr.accountId, accountId)))
    .innerJoin(wr, and(eq(wr.repoId, pr.repoId), eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId)))
    .where(and(inArray(u.githubLogin, list), eq(pr.state, 'open')))
    .execute()) as Array<{ login: string; prId: number }>;
  for (const r of rows) {
    const k = r.login.toLowerCase();
    const s = out.get(k) ?? new Set<number>();
    s.add(r.prId);
    out.set(k, s);
  }
  return out;
}

// ── The input ────────────────────────────────────────────────────────────────────────────────────

export interface SprintPathsInput {
  /** The map the model reads (inside the fence), day facts included. */
  text: string;
  /** Every key handed in (sprint + listed outside tickets), as the input spells them. */
  keys: string[];
  /** KEY (upper case) → node ident, for every key in `keys`. */
  identByKey: Record<string, string>;
  sprintTickets: number;
  eligible: boolean;
  /** sha256 hex over everything sent EXCEPT the day facts, + SPRINT_PATHS_VERSION. */
  inputHash: string;
}

const prLine = (n: SprintGraphNode): string => {
  if (n.prs.length === 0) return 'no pull requests';
  const open = n.prs.filter((p) => p.state === 'open');
  const merged = n.prs.filter((p) => p.state === 'merged').length;
  const failing = open.filter((p) => p.ciState === 'failure' || p.ciState === 'error').length;
  const drafts = open.filter((p) => p.draft).length;
  const parts: string[] = [];
  if (open.length > 0) parts.push(`${open.length} open${drafts > 0 ? ` (${drafts} draft)` : ''}${failing > 0 ? `, ${failing} with failing checks` : ''}`);
  if (merged > 0) parts.push(`${merged} merged`);
  return parts.length > 0 ? `pull requests: ${parts.join('; ')}` : 'pull requests: only closed ones';
};

/** The builder's input for a folded graph. Pure. */
export function sprintPathsInput(g: {
  sprintName: string | null;
  nodes: readonly SprintGraphNode[];
  edges: readonly SprintGraphEdge[];
  /** The drawn columns (`statusLayout.columns`), left to right. */
  columns: readonly SprintColumn[];
  timing?: SprintTiming | null;
}): SprintPathsInput {
  const sprint = g.nodes.filter((n) => !n.ghost).sort(byKey);
  const byIdent = new Map(g.nodes.map((n) => [n.ident, n]));
  const colName = new Map(g.columns.map((c) => [c.id, c]));
  // A column by its own name, with its meaning when the name does not already say it.
  const columnLabel = (c: Pick<SprintColumn, 'name' | 'meaning'>): string => {
    const meaning = SPRINT_STAGE_LABEL[c.meaning].toLowerCase();
    return c.name.trim().toLowerCase() === meaning ? oneLine(c.name, 40) : `${oneLine(c.name, 40)} (${meaning})`;
  };
  const listed = new Map<string, SprintGraphNode>();
  for (const n of sprint) listed.set(n.ident, n);
  // The outside tickets a SPRINT ticket depends on or builds on.
  const tied = g.edges.filter((e) => (e.kind === 'depends_on' || e.kind === 'builds_on') && byIdent.has(e.from) && byIdent.has(e.to));
  const outside: SprintGraphNode[] = [];
  for (const e of tied) {
    const from = byIdent.get(e.from)!;
    const to = byIdent.get(e.to)!;
    if (!from.ghost && to.ghost && !listed.has(to.ident)) {
      listed.set(to.ident, to);
      outside.push(to);
    }
  }
  outside.sort(byKey);
  const columnOf = (n: SprintGraphNode): string => {
    const c = n.column != null ? colName.get(n.column) : undefined;
    if (c != null) return columnLabel(c);
    return n.stage != null ? SPRINT_STAGE_LABEL[n.stage].toLowerCase() : 'status unknown';
  };
  const pace = sprintPaceOf(g.nodes, g.edges, null);
  // Each chain cut to its LONGEST RUN of listed tickets (a ghost of a ghost may sit at EITHER end, or
  // in the middle), in DELIVERY order (what is needed first, first); an end that was cut says so. A
  // chain is listed from its dependent end first, so ids AFTER the run are prerequisites and ids
  // BEFORE it are dependents.
  const chains = sprintChains(g.nodes, g.edges)
    .map((p) => {
      let best = { from: 0, to: 0 };
      for (let i = 0; i < p.length; ) {
        if (!listed.has(p[i]!)) {
          i += 1;
          continue;
        }
        let j = i;
        while (j < p.length && listed.has(p[j]!)) j += 1;
        if (j - i > best.to - best.from) best = { from: i, to: j };
        i = j;
      }
      return { keep: p.slice(best.from, best.to), needsMore: best.to < p.length, feedsMore: best.from > 0 };
    })
    .filter((c) => c.keep.length >= 2);
  const chainLines = chains
    .slice(0, SPRINT_PATHS_CHAINS_LISTED)
    .map(
      (c) =>
        `- ${c.needsMore ? '(more work outside the sprint) → ' : ''}${[...c.keep].reverse().map((id) => byIdent.get(id)!.key).join(' → ')}${c.feedsMore ? ' → (more work outside the sprint)' : ''}`,
    );
  const facts = [
    `Sprint: ${g.sprintName != null && g.sprintName.trim() !== '' ? oneLine(g.sprintName, TITLE_MAX) : 'This sprint'}`,
    `Columns, left to right: ${g.columns.map((c) => columnLabel(c)).join(' · ') || 'none'}`,
    `Tickets in the sprint: ${pace.tickets}; complete: ${pace.done}; in product review: ${pace.productReview}; not complete: ${pace.live}`,
    `Open dependencies: ${pace.openDependencies}; dependency chains: ${chains.length} found, ${chainLines.length} listed below`,
  ];
  const ticketLines = sprint.map((n) =>
    [
      `- ${n.key}`,
      `title: ${n.title !== '' ? oneLine(n.title, TITLE_MAX) : '(not read)'}`,
      `type: ${n.issueType != null && n.issueType.trim() !== '' ? oneLine(n.issueType, 40) : 'not known'}`,
      ...(n.epic != null ? [`epic: ${n.epic.title != null && n.epic.title.trim() !== '' ? oneLine(n.epic.title, TITLE_MAX) : n.epic.key}`] : []),
      `theme: ${n.theme != null ? oneLine(n.theme, 40) : 'none'}`,
      `column: ${columnOf(n)}`,
      n.assignee != null ? 'assigned' : 'unassigned',
      prLine(n),
      ...(n.brief.summary != null ? [`summary: ${oneLine(n.brief.summary, SUMMARY_MAX)}`] : []),
    ].join(' | '),
  );
  const outsideLines = outside.map(
    (n) =>
      `- ${n.key} | title: ${n.title !== '' ? oneLine(n.title, TITLE_MAX) : '(not read)'} | status: ${n.status != null ? oneLine(n.status.name, 40) : 'unknown'}${isDone(n) ? ' (complete)' : ' (not complete)'} | outside the sprint`,
  );
  const linkLines = tied
    .filter((e) => listed.has(e.from) && listed.has(e.to))
    .map((e) => {
      const a = byIdent.get(e.from)!;
      const b = byIdent.get(e.to)!;
      const why = e.why != null && e.why.trim() !== '' ? e.why : e.quote;
      return `- ${a.key} ${SPRINT_EDGE_LABEL[e.kind].toLowerCase()} ${b.key}${why != null && why.trim() !== '' ? `: ${oneLine(why, WHY_MAX)}` : ''}`;
    })
    .sort();
  const stable = [
    ...facts,
    '',
    'SPRINT TICKETS:',
    ...(ticketLines.length > 0 ? ticketLines : ['- none']),
    '',
    'OUTSIDE THE SPRINT (sprint tickets depend on or build on these):',
    ...(outsideLines.length > 0 ? outsideLines : ['- none']),
    '',
    'LINKS (A → B):',
    ...(linkLines.length > 0 ? linkLines : ['- none']),
    '',
    'DEPENDENCY CHAINS CODE FOUND (needed first, first):',
    ...(chainLines.length > 0 ? chainLines : ['- none']),
  ].join('\n');
  const timing = g.timing ?? null;
  const dayLine = timing != null ? `Sprint day: ${timing.day} of ${timing.days}; days left after today: ${timing.daysLeft}` : 'Sprint day: not known';
  const text = `${dayLine}\n${stable}`;
  const identByKey: Record<string, string> = {};
  for (const n of listed.values()) identByKey[n.key.toUpperCase()] = n.ident;
  const inputHash = createHash('sha256').update(JSON.stringify([SPRINT_PATHS_VERSION, stable])).digest('hex');
  return {
    text,
    keys: [...listed.values()].map((n) => n.key),
    identByKey,
    sprintTickets: sprint.length,
    eligible: sprint.length >= SPRINT_PATHS_CAPS.minTickets,
    inputHash,
  };
}

// ── The store ────────────────────────────────────────────────────────────────────────────────────

/** What the pass stores (keys only — idents are resolved on read, against today's nodes). */
export interface StoredPathsJson {
  paths: Array<{ title: string; tickets: string[]; advice: string; risk: SprintPathRisk }>;
  callouts: Array<{ title: string; tickets: string[] }>;
}

export interface SprintPathsRow {
  inputHash: string | null;
  pathsVersion: number | null;
  pathsJson: unknown;
  writtenAt: Date | null;
  attemptAt: Date | null;
  attemptHash: string | null;
  attemptError: string | null;
  runsDay: string | null;
  runsToday: number;
  // What wrote the stored paths (0128). Optional: a stand-in row in a test omits them.
  model?: string | null;
  provider?: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function isPathsCurrent(row: Pick<SprintPathsRow, 'inputHash' | 'pathsVersion' | 'pathsJson'> | null | undefined, inputHash: string): boolean {
  return row != null && row.pathsJson != null && row.pathsVersion === SPRINT_PATHS_VERSION && row.inputHash === inputHash;
}

/** A stored row → the wire paths, idents resolved through `identOf` (a key it cannot resolve is
 *  dropped from that list; a path or call-out left empty is dropped). Tolerant. Pure. */
export function sprintPathsOf(
  row: Pick<SprintPathsRow, 'pathsJson' | 'writtenAt' | 'model' | 'provider'>,
  identOf: (key: string) => string | null,
): SprintPaths | null {
  const j = row.pathsJson;
  if (!isObj(j) || !Array.isArray(j.paths) || row.writtenAt == null) return null;
  const resolve = (keys: string[]): { tickets: string[]; idents: string[] } => {
    const tickets: string[] = [];
    const idents: string[] = [];
    for (const k of keys) {
      const id = identOf(k);
      if (id == null) continue;
      tickets.push(k);
      idents.push(id);
    }
    return { tickets, idents };
  };
  const paths: SprintPath[] = [];
  for (const p of j.paths) {
    if (!isObj(p) || typeof p.title !== 'string' || typeof p.advice !== 'string' || !SPRINT_PATH_RISKS.includes(p.risk as SprintPathRisk)) continue;
    const r = resolve(strs(p.tickets));
    if (r.tickets.length === 0) continue;
    paths.push({ title: p.title, advice: p.advice, risk: p.risk as SprintPathRisk, ...r });
  }
  const callouts: SprintCallout[] = [];
  for (const c of Array.isArray(j.callouts) ? j.callouts : []) {
    if (!isObj(c) || typeof c.title !== 'string') continue;
    const r = resolve(strs(c.tickets));
    if (r.tickets.length === 0) continue;
    callouts.push({ title: c.title, ...r });
  }
  return {
    paths,
    callouts,
    createdAt: row.writtenAt.toISOString(),
    ...(row.model ? { model: row.model, provider: aiRunProvider(row.provider, row.model) } : {}),
  };
}

/** The stored row (any currency), this account + workspace only. */
export async function storedSprintPaths(accountId: number, workspaceId: number): Promise<SprintPathsRow | null> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintPaths;
  const rows = await db
    .select({
      inputHash: t.inputHash,
      pathsVersion: t.pathsVersion,
      pathsJson: t.pathsJson,
      writtenAt: t.writtenAt,
      attemptAt: t.attemptAt,
      attemptHash: t.attemptHash,
      attemptError: t.attemptError,
      runsDay: t.runsDay,
      runsToday: t.runsToday,
      model: t.model,
      provider: t.provider,
    })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .limit(1)
    .execute();
  return (rows[0] as SprintPathsRow | undefined) ?? null;
}

export interface StoredSprintPaths extends StoredPathsJson {
  // What ran (0128). Absent ⇒ Claude's SPRINT_PATHS_MODEL (a stand-in in a test).
  model?: string;
  provider?: 'claude' | 'codex';
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Upsert the workspace's ONE row with new paths (the attempt columns are left to `recordSprintPathsAttempt`). */
export async function storeSprintPaths(accountId: number, workspaceId: number, inputHash: string, v: StoredSprintPaths, now: Date = new Date()): Promise<void> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintPaths;
  const values = {
    inputHash,
    pathsVersion: SPRINT_PATHS_VERSION,
    pathsJson: { paths: v.paths, callouts: v.callouts } satisfies StoredPathsJson,
    model: v.model ?? SPRINT_PATHS_MODEL,
    provider: v.provider ?? 'claude',
    costUsd: v.costUsd,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    writtenAt: now,
    updatedAt: now,
  };
  await db
    .insert(t)
    .values({ accountId, workspaceId, ...values })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId], set: values })
    .execute();
}

/** The UTC day a run counts against ('YYYY-MM-DD'). Pure. */
export const utcDayOf = (now: Date): string => now.toISOString().slice(0, 10);

/** Runs already started today (a row from another day counts 0). Pure. */
export function runsTodayOf(row: Pick<SprintPathsRow, 'runsDay' | 'runsToday'> | null | undefined, now: Date): number {
  return row != null && row.runsDay === utcDayOf(now) ? row.runsToday : 0;
}

/** Count one run against today's cap (before Claude is called). */
export async function noteSprintPathsRun(accountId: number, workspaceId: number, now: Date = new Date()): Promise<void> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintPaths;
  const row = await storedSprintPaths(accountId, workspaceId);
  const runs = { runsDay: utcDayOf(now), runsToday: runsTodayOf(row, now) + 1, updatedAt: now };
  await db
    .insert(t)
    .values({ accountId, workspaceId, ...runs })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId], set: runs })
    .execute();
}

const FAILURES: readonly string[] = ['refused', 'no_submit', 'stopped', 'daily_cap', 'error'];
export const isSprintPathsFailure = (v: unknown): v is SprintPathsFailure => typeof v === 'string' && FAILURES.includes(v);

/** Record the pass's attempt: error null = stored, else the failure. */
export async function recordSprintPathsAttempt(
  accountId: number,
  workspaceId: number,
  inputHash: string,
  error: SprintPathsFailure | null,
  now: Date = new Date(),
): Promise<void> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintPaths;
  const values = { attemptAt: now, attemptHash: inputHash, attemptError: error, updatedAt: now };
  await db
    .insert(t)
    .values({ accountId, workspaceId, ...values })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId], set: values })
    .execute();
}

/** A failed pass for THIS input is not tried again (the backoff): wait for the input to move. Pure. */
export function pathsBackedOff(row: Pick<SprintPathsRow, 'attemptHash' | 'attemptError'> | null | undefined, inputHash: string): boolean {
  return row != null && row.attemptError != null && row.attemptHash === inputHash;
}

// ── What is in flight (in-process; the pass runs here, LOCAL only) ──────────────────────────────

const flightKey = (a: number, w: number): string => `${a}:${w}`;
const running = new Set<string>();
const queued = new Map<string, number>();

/** Claim the builder's slot. false = one is already running. ⚠ SYNCHRONOUS — no await in between. */
export function claimSprintPathsPass(accountId: number, workspaceId: number): boolean {
  const k = flightKey(accountId, workspaceId);
  if (running.has(k)) return false;
  running.add(k);
  return true;
}
export function releaseSprintPathsPass(accountId: number, workspaceId: number): void {
  running.delete(flightKey(accountId, workspaceId));
}
export function isSprintPathsRunning(accountId: number, workspaceId: number): boolean {
  return running.has(flightKey(accountId, workspaceId));
}
/** The after-read chain holds this workspace (counted: two reads may overlap). */
export function markSprintPathsQueued(accountId: number, workspaceId: number, on: boolean): void {
  const k = flightKey(accountId, workspaceId);
  const n = (queued.get(k) ?? 0) + (on ? 1 : -1);
  if (n > 0) queued.set(k, n);
  else queued.delete(k);
}
export function isSprintPathsQueued(accountId: number, workspaceId: number): boolean {
  return queued.has(flightKey(accountId, workspaceId));
}
/** Test seam. */
export function resetSprintPathsFlight(): void {
  running.clear();
  queued.clear();
}

/**
 * Where the builder stands for today's input — the ONE fold the page reads
 * (`SprintGraphResponse.pathsStatus`). Pure. `capped` = today's runs reached SPRINT_PATHS_DAILY_CAP.
 */
export function sprintPathsStatusOf(p: {
  aiEnabled: boolean;
  canRun: boolean;
  eligible: boolean;
  inputHash: string | null;
  row: SprintPathsRow | null;
  hasPaths: boolean;
  running: boolean;
  queued: boolean;
  capped: boolean;
}): SprintPathsStatus {
  const lastAttemptAt = p.row?.attemptAt != null ? p.row.attemptAt.toISOString() : null;
  const current = p.inputHash != null && isPathsCurrent(p.row, p.inputHash);
  const stale = p.hasPaths && !current;
  const base = { stale, lastAttemptAt, failure: null as SprintPathsFailure | null };
  if (!p.aiEnabled || !p.eligible || p.inputHash == null) return { ...base, state: 'none', stale: false };
  if (current) return { ...base, state: 'current' };
  if (p.running) return { ...base, state: 'writing' };
  if (!p.canRun) return { ...base, state: 'none' };
  if (p.queued) return { ...base, state: 'queued' };
  if (pathsBackedOff(p.row, p.inputHash) && isSprintPathsFailure(p.row!.attemptError)) {
    return { ...base, state: 'failed', failure: p.row!.attemptError };
  }
  if (p.capped) return { ...base, state: 'failed', failure: 'daily_cap' };
  return { ...base, state: 'waiting' };
}
