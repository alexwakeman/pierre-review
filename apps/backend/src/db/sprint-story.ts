import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  SPRINT_BRIEF_MODEL,
  SPRINT_STORY_CAPS,
  SPRINT_STORY_LATE,
  SPRINT_STORY_VERSION,
  sprintDayOf,
  type SprintGraphEdge,
  type SprintGraphNode,
  type SprintStage,
  type SprintStory,
  type SprintStoryFailure,
  type SprintStoryStatus,
  type SprintStoryline,
  type SprintStorylineKind,
} from '@pierre-review/shared';

// ACTIVITY → THIS SPRINT — THE SPRINT STORY'S INPUT + STORE (docs/CLAUDE-REVIEW.md § Sprint story).
//
//   • THE INPUT is built by CODE from the folded graph (db/sprint-graph.ts — the SAME fold the page
//     shows): the sprint's totals, the AREAS OF WORK (one per theme, or epic when no current theme pass
//     covers the sprint — the "Sprint focus" sentence is written from them), then CANDIDATE storylines —
//     the longest DEPENDENCY CHAINS whose every link still waits on an UNFINISHED prerequisite, and the
//     RISKS (tickets waiting on unfinished work INSIDE the sprint — the outside ones are the code card
//     "Blocked outside the sprint", db/sprint-signals.ts — failing checks, work not started, unassigned
//     work). Each candidate carries its kind, the idents it covers and its fact lines, every count
//     written here. The model only PICKS candidates by id and WORDS them; kind and idents are never the
//     model's.
//   • THE HASH covers exactly what is sent (the rendered facts). ⚠ ONE `now`-derived thing reaches it,
//     ON PURPOSE: the SPRINT DAY (`SprintTiming` — whole days counted from the sprint's start instant,
//     so it changes exactly once per 24 hours and never finer). That is at most ONE re-run per
//     workspace per day, and only when a sprint read kicks the pass. Leaving it out would let a stored
//     headline say "day 3 of 14" on day 12 and never raise the late risk (the page shows the LAST story
//     whatever its hash). Nothing finer than the day index (no hour, no elapsed fraction) may enter.
//     Current only while `input_hash` matches today's AND `story_version` is SPRINT_STORY_VERSION.
//   • TIME FACTS ONLY FROM A REAL SPRINT WINDOW: FIRST the tracker's own sprint dates, stored by the
//     sprint read (`sprint_reads.sprint_starts_at/_ends_at`, `sprintTimingOfDates`), else the
//     workspace's cadence resolved through `getReportingWindow` with mode 'sprint' (`sprintTimingOf`).
//     The trailing-14-day fallback (OSS, no cadence, a rolling mode) is NOT a sprint: no day facts, no
//     "late in the sprint" risk. A GitHub milestone (a due date, no start) gives no day facts either.
//   • NO PERSON IS NAMED: assignees reach the input only as "unassigned" counts.
//
// ⚠ PURE AT IMPORT: the DB client is reached LAZILY inside the readers (a pure test never opens it).

/** Ticket lines listed under one candidate (the rest are counted). */
export const SPRINT_STORY_LIST_MAX = 12;
export const SPRINT_STORY_CHAINS_MAX = 3;
export const SPRINT_STORY_GROUPS_MAX = 8;
const TITLE_MAX = 120;
const WHY_MAX = 160;

export interface SprintStoryCandidate {
  /** 'C1', 'C2', … — what the model answers with. */
  id: string;
  kind: SprintStorylineKind;
  idents: string[];
  /** The rendered block the model reads (inside the fence). */
  text: string;
}

/** Where today sits in a REAL sprint window, in WHOLE days. `day` counts the day you are in (1-based);
 *  `daysLeft` are the days after today. */
export interface SprintTiming {
  day: number;
  days: number;
  daysLeft: number;
}

/**
 * The sprint timing for a reporting window, or null when the window is not a sprint (mode other than
 * 'sprint' — the trailing-days fallback). Day granularity only: the day index changes once per 24h,
 * counted from the sprint's own start instant (shared `sprintDayOf`, the page header's count too). Pure.
 */
export function sprintTimingOf(
  w: { fromMs: number; toMs: number; mode: string } | null | undefined,
  nowMs: number,
): SprintTiming | null {
  if (w == null || w.mode !== 'sprint') return null;
  return sprintDayOf(w.fromMs, w.toMs, nowMs);
}

/** The sprint timing from the TRACKER's own sprint dates (`sprint_reads.sprint_starts_at/_ends_at`);
 *  null unless both ends are known. Pure. */
export function sprintTimingOfDates(startsAt: Date | null | undefined, endsAt: Date | null | undefined, nowMs: number): SprintTiming | null {
  if (startsAt == null || endsAt == null) return null;
  return sprintDayOf(startsAt.getTime(), endsAt.getTime(), nowMs);
}

/** Late in the sprint: at most SPRINT_STORY_LATE.maxLeftPct % of its days left. Pure. */
export function isLateInSprint(t: SprintTiming | null | undefined): boolean {
  return t != null && 100 * t.daysLeft <= SPRINT_STORY_LATE.maxLeftPct * t.days;
}

export interface SprintStoryInput {
  /** The sprint-wide facts block. */
  facts: string;
  /** The AREAS OF WORK block (themes or epics with their stage counts) — the focus sentence's source. */
  areas: string;
  candidates: SprintStoryCandidate[];
  /** Every key handed in (sprint + listed ghosts) — the only keys the text may name. */
  keys: string[];
  /** Tracker-authored names handed in (sprint name, theme / epic names, ticket titles), longest first.
   *  The number gate reads them as WORDS, never as counts: a digit in "Handle 500 errors" may be quoted
   *  but never becomes an allowed number (review/sprint-story/validate.ts). Derived; not in the hash. */
  verbatim: string[];
  sprintTickets: number;
  /** Enough sprint tickets (a story with a headline + focus and no storyline is a story). */
  eligible: boolean;
  /** sha256 hex of everything sent. */
  inputHash: string;
}

const STAGE_WORD: Record<SprintStage, string> = {
  not_started: 'not started',
  in_progress: 'in progress',
  in_review: 'in review',
  done: 'done',
};
const stageWord = (s: SprintStage | null): string => (s == null ? 'status unknown' : STAGE_WORD[s]);
const isDone = (n: Pick<SprintGraphNode, 'stage'>): boolean => n.stage === 'done';

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  let cut = max - 1;
  const c = t.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return `${t.slice(0, cut)}…`;
};

const byKey = (a: SprintGraphNode, b: SprintGraphNode): number =>
  a.key.localeCompare(b.key, undefined, { numeric: true }) || a.ident.localeCompare(b.ident);

const ticketLine = (n: SprintGraphNode): string =>
  `${n.key} ${n.title !== '' ? oneLine(n.title, TITLE_MAX) : '(title not read)'} (${stageWord(n.stage)}${n.ghost ? ', outside the sprint' : ''})`;

function listLines(nodes: SprintGraphNode[], line: (n: SprintGraphNode) => string = ticketLine, max: number = SPRINT_STORY_LIST_MAX): string[] {
  const shown = nodes.slice(0, max).map((n) => `  - ${line(n)}`);
  if (nodes.length > max) shown.push(`  - and ${nodes.length - max} more`);
  return shown;
}

/** Ticket lines listed under one AREA (the focus needs the shape, not every ticket). */
export const SPRINT_STORY_AREA_LIST_MAX = 6;

function stageCounts(nodes: SprintGraphNode[]): string {
  const c = (s: SprintStage) => nodes.filter((n) => n.stage === s).length;
  const unknown = nodes.filter((n) => n.stage == null).length;
  const parts = [`done ${c('done')}`, `in review ${c('in_review')}`, `in progress ${c('in_progress')}`, `not started ${c('not_started')}`];
  if (unknown > 0) parts.push(`status unknown ${unknown}`);
  return parts.join(', ');
}

const pct = (n: number, of: number): number => (of === 0 ? 0 : Math.round((100 * n) / of));
const failingCi = (n: SprintGraphNode) => n.prs.filter((p) => p.state === 'open' && (p.ciState === 'failure' || p.ciState === 'error'));

/** Why `from` needs `to`: the edge's one-sentence `why` when the graph carries one, else its quote. */
function whyOf(e: SprintGraphEdge): string | null {
  const r = (e as SprintGraphEdge & { why?: unknown }).why;
  const s = typeof r === 'string' && r.trim() !== '' ? r : e.quote;
  return s == null || s.trim() === '' ? null : oneLine(s, WHY_MAX);
}

/** The longest depends_on paths (dependent first), touching an unfinished sprint ticket. ⚠ Every link
 *  waits on an UNFINISHED prerequisite: an edge onto a done ticket is no dependency any more, so it is
 *  never walked ("BMD-1028 depends on BMD-994, which is done" is not a story). Pure. */
export function storyChains(nodes: readonly SprintGraphNode[], edges: readonly SprintGraphEdge[]): string[][] {
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
    // It matters to THIS sprint only when a sprint ticket on it is still not done.
    .filter((p) => p.some((id) => { const n = byIdent.get(id)!; return !n.ghost && !isDone(n); }))
    .sort((a, b) => b.length - a.length || byKey(byIdent.get(a[0]!)!, byIdent.get(b[0]!)!));
  const picked: string[][] = [];
  const used = new Set<string>();
  for (const p of paths) {
    if (picked.length >= SPRINT_STORY_CHAINS_MAX) break;
    const overlap = p.filter((id) => used.has(id)).length;
    if (overlap * 2 >= p.length) continue;
    picked.push(p);
    for (const id of p) used.add(id);
  }
  return picked;
}

/** The story pass's input for a folded graph. Pure. */
export function sprintStoryInput(g: {
  sprintName: string | null;
  nodes: readonly SprintGraphNode[];
  edges: readonly SprintGraphEdge[];
  /** A REAL sprint's day facts (`sprintTimingOf`); null/absent = no time facts and no late risk. */
  timing?: SprintTiming | null;
}): SprintStoryInput {
  const timing = g.timing ?? null;
  const sprint = g.nodes.filter((n) => !n.ghost).sort(byKey);
  const byIdent = new Map(g.nodes.map((n) => [n.ident, n]));
  const keys = new Set<string>(sprint.map((n) => n.key));
  const listed = (ns: SprintGraphNode[]) => ns.slice(0, SPRINT_STORY_LIST_MAX).forEach((n) => keys.add(n.key));
  const openPrs = sprint.reduce((s, n) => s + n.prs.filter((p) => p.state === 'open').length, 0);
  const mergedPrs = sprint.reduce((s, n) => s + n.prs.filter((p) => p.state === 'merged').length, 0);
  const failing = sprint.filter((n) => failingCi(n).length > 0);
  const facts = [
    `Sprint: ${g.sprintName != null && g.sprintName.trim() !== '' ? oneLine(g.sprintName, TITLE_MAX) : 'This sprint'}`,
    `Tickets in the sprint: ${sprint.length} (${stageCounts(sprint)})`,
    `Pull requests on them: ${openPrs} open, ${mergedPrs} merged`,
    `Tickets with failing checks on an open pull request: ${failing.length}`,
    ...(timing != null ? [`Sprint day: ${timing.day} of ${timing.days}; days left after today: ${timing.daysLeft}`] : []),
  ].join('\n');

  const raw: Array<{ kind: SprintStorylineKind; idents: string[]; lines: string[] }> = [];

  // AREAS OF WORK — themes (or epics when no current theme pass covers the sprint): the focus's source.
  const themed = sprint.some((n) => n.theme != null);
  const groups = new Map<string, SprintGraphNode[]>();
  for (const n of sprint) {
    const name = themed ? n.theme : n.epic != null ? (n.epic.title ?? n.epic.key) : null;
    if (name == null) continue;
    groups.set(name, [...(groups.get(name) ?? []), n]);
  }
  const groupList = [...groups.entries()]
    .filter(([, ns]) => themed || ns.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, SPRINT_STORY_GROUPS_MAX);
  const areaLines: string[] = [];
  for (const [name, ns] of groupList) {
    ns.slice(0, SPRINT_STORY_AREA_LIST_MAX).forEach((n) => keys.add(n.key));
    areaLines.push(`- "${oneLine(name, TITLE_MAX)}"${themed ? '' : ' (an epic)'}: ${ns.length} tickets (${stageCounts(ns)})`, ...listLines(ns, ticketLine, SPRINT_STORY_AREA_LIST_MAX));
  }
  if (groupList.length === 0) {
    // No themes and no epics: the tickets themselves are the only clue to the focus.
    sprint.slice(0, SPRINT_STORY_LIST_MAX).forEach((n) => keys.add(n.key));
    areaLines.push('- No themes or epics; the sprint\'s tickets:', ...listLines(sprint));
  }
  const areas = areaLines.join('\n');

  // DEPENDENCY CHAINS, in delivery order (what is needed first, first).
  const edgeOf = new Map(g.edges.filter((e) => e.kind === 'depends_on').map((e) => [`${e.from}>${e.to}`, e]));
  for (const path of storyChains(g.nodes, g.edges)) {
    const ns = path.map((id) => byIdent.get(id)!);
    const order = [...ns].reverse();
    const done = ns.filter(isDone).length;
    const firstOpen = order.find((n) => !isDone(n));
    const lines = [
      `chain — a dependency path of ${ns.length} tickets, in the order they are needed`,
      `  Done: ${done}, not done: ${ns.length - done}${firstOpen != null ? `; the first one not done is ${firstOpen.key}` : ''}`,
    ];
    order.forEach((n, i) => {
      const prev = order[i - 1];
      const e = prev != null ? edgeOf.get(`${n.ident}>${prev.ident}`) : undefined;
      const why = e != null ? whyOf(e) : null;
      lines.push(`  ${i + 1}. ${ticketLine(n)}${prev != null ? ` — needs ${prev.key}${why != null ? `: "${why}"` : ''}` : ''}`);
    });
    for (const n of order) keys.add(n.key);
    raw.push({ kind: 'chain', idents: order.map((n) => n.ident), lines });
  }

  // RISKS.
  const waitsOn = (n: SprintGraphNode) =>
    g.edges
      .filter((e) => e.kind === 'depends_on' && e.from === n.ident)
      .map((e) => byIdent.get(e.to))
      .filter((t): t is SprintGraphNode => t != null && !isDone(t))
      .sort(byKey);
  // ⚠ INSIDE the sprint only: a wait on an outside ticket is the code card "Blocked outside the sprint"
  // (db/sprint-signals.ts) — one fact, one card.
  const waitsInside = (n: SprintGraphNode) => waitsOn(n).filter((t) => !t.ghost);
  const blocked = sprint.filter((n) => !isDone(n) && waitsInside(n).length > 0);
  if (blocked.length > 0) {
    listed(blocked);
    for (const n of blocked.slice(0, SPRINT_STORY_LIST_MAX)) for (const t of waitsInside(n)) keys.add(t.key);
    raw.push({
      kind: 'risk',
      idents: blocked.map((n) => n.ident),
      lines: [
        `risk — tickets waiting on unfinished work inside the sprint`,
        `  Tickets waiting: ${blocked.length}`,
        ...listLines(blocked, (n) => `${ticketLine(n)} — waits on ${waitsInside(n).map((t) => `${t.key} (${stageWord(t.stage)})`).join(', ')}`),
      ],
    });
  }
  if (failing.length > 0) {
    listed(failing);
    const prs = failing.reduce((s, n) => s + failingCi(n).length, 0);
    raw.push({
      kind: 'risk',
      idents: failing.map((n) => n.ident),
      lines: [`risk — failing checks`, `  Tickets: ${failing.length}; open pull requests with failing checks: ${prs}`, ...listLines(failing)],
    });
  }
  const notStarted = sprint.filter((n) => n.stage === 'not_started');
  // LATE IN THE SPRINT (a real sprint window only): replaces the plain "work not started" risk — the
  // same tickets, now with the days left beside them.
  const late = isLateInSprint(timing) && notStarted.length >= SPRINT_STORY_LATE.minNotStarted;
  if (late) {
    listed(notStarted);
    raw.push({
      kind: 'risk',
      idents: notStarted.map((n) => n.ident),
      lines: [
        `risk — work not started late in the sprint`,
        `  Not started: ${notStarted.length} of ${sprint.length} tickets, on day ${timing!.day} of ${timing!.days} with ${timing!.daysLeft} days left after today`,
        ...listLines(notStarted),
      ],
    });
  } else if (notStarted.length >= 2 && pct(notStarted.length, sprint.length) >= 20) {
    listed(notStarted);
    raw.push({
      kind: 'risk',
      idents: notStarted.map((n) => n.ident),
      lines: [
        `risk — work not started`,
        `  Not started: ${notStarted.length} of ${sprint.length} tickets (${pct(notStarted.length, sprint.length)}%)`,
        ...listLines(notStarted),
      ],
    });
  }
  const unassigned = sprint.filter((n) => !isDone(n) && n.assignee == null);
  if (unassigned.length >= 2) {
    listed(unassigned);
    raw.push({
      kind: 'risk',
      idents: unassigned.map((n) => n.ident),
      lines: [`risk — unfinished tickets nobody is assigned to`, `  Tickets: ${unassigned.length}`, ...listLines(unassigned)],
    });
  }

  const candidates = raw.map((c, i) => ({ id: `C${i + 1}`, kind: c.kind, idents: c.idents, text: c.lines.join('\n') }));
  const names = new Set<string>();
  const addName = (t: string | null | undefined): void => {
    if (t == null) return;
    const full = t.replace(/\s+/g, ' ').trim();
    // A name with no letter, or a very short one ("2", "v2"), could hide a bare count: never verbatim.
    for (const x of [full, oneLine(full, TITLE_MAX)]) if (x.length >= 6 && /\p{L}/u.test(x)) names.add(x);
  };
  // THE SPRINT NAME'S SHORT FORMS are quotable too: "Sprint 15 (Oct 14-27)" is written "Sprint 15", and
  // its bracketed dates "Oct 14-27". Before this, a headline naming "Sprint 15" failed the number gate
  // on EVERY pass for a sprint whose name carried a bracket — the story for that workspace was never
  // stored (2026-10-14).
  const sprintNameForms = (t: string): string[] => {
    const full = t.replace(/\s+/g, ' ').trim();
    const out: string[] = [];
    const bare = full.replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (bare !== full) out.push(bare);
    for (const m of full.matchAll(/[([]([^)\]]+)[)\]]/g)) out.push(m[1]!.trim());
    return out;
  };
  if (g.sprintName != null) {
    addName(g.sprintName);
    for (const f of sprintNameForms(g.sprintName)) addName(f);
  }
  for (const [name] of groupList) addName(name);
  for (const n of g.nodes) addName(n.title);
  const inputHash = createHash('sha256')
    .update(JSON.stringify([facts, areas, candidates.map((c) => [c.id, c.kind, c.idents, c.text])]))
    .digest('hex');
  return {
    facts,
    areas,
    candidates,
    keys: [...keys].sort(),
    verbatim: [...names].sort((a, b) => b.length - a.length || a.localeCompare(b)),
    sprintTickets: sprint.length,
    eligible: sprint.length >= SPRINT_STORY_CAPS.minTickets,
    inputHash,
  };
}

// ── The store ────────────────────────────────────────────────────────────────────────────────────

export interface SprintStoryRow {
  inputHash: string;
  storyVersion: number;
  storyJson: unknown;
  createdAt: Date;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v);
// ⚠ 'theme' is RETIRED (v4): an older stored story's theme storylines are dropped on read, and it shows
// no focus line until the next pass rewrites it.
const KINDS: readonly string[] = ['chain', 'risk'];

export function isStoryCurrent(row: Pick<SprintStoryRow, 'inputHash' | 'storyVersion'> | null | undefined, inputHash: string): boolean {
  return row != null && row.storyVersion === SPRINT_STORY_VERSION && row.inputHash === inputHash;
}

/** A stored row → the wire story. Tolerant: malformed (and retired 'theme') storylines are dropped; a
 *  story with a headline and no storyline left still stands (a v4 story may have none). Pure. */
export function sprintStoryOf(row: Pick<SprintStoryRow, 'storyJson' | 'createdAt'>): SprintStory | null {
  const j = row.storyJson;
  if (!isObj(j) || typeof j.headline !== 'string' || j.headline.trim() === '' || !Array.isArray(j.storylines)) return null;
  const storylines: SprintStoryline[] = [];
  for (const s of j.storylines) {
    if (!isObj(s) || typeof s.kind !== 'string' || !KINDS.includes(s.kind) || typeof s.title !== 'string' || typeof s.sentence !== 'string') continue;
    if (!Array.isArray(s.idents)) continue;
    const idents = s.idents.filter((x): x is string => typeof x === 'string');
    storylines.push({ kind: s.kind as SprintStorylineKind, title: s.title, sentence: s.sentence, idents });
  }
  const focus = typeof j.focus === 'string' && j.focus.trim() !== '' ? j.focus : null;
  return { headline: j.headline, focus, storylines, createdAt: row.createdAt.toISOString() };
}

/** The stored row (any currency), this account + workspace only. */
export async function storedSprintStory(accountId: number, workspaceId: number): Promise<SprintStoryRow | null> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintStory;
  const rows = await db
    .select({ inputHash: t.inputHash, storyVersion: t.storyVersion, storyJson: t.storyJson, createdAt: t.createdAt })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .limit(1)
    .execute();
  return (rows[0] as SprintStoryRow | undefined) ?? null;
}

/** The last story written — ANY SPRINT_STORY_VERSION, whatever input it was written for — or null. What
 *  the page SHOWS (db/sprint-graph.ts), marked stale when not current; currency only gates a re-run.
 *  ⚠ A version bump used to HIDE the stored story ("Writing the sprint story…" until a new pass stored
 *  one — for ever, when every pass was refused). A stale story beats a blank strip. */
export async function latestSprintStory(accountId: number, workspaceId: number): Promise<SprintStory | null> {
  const row = await storedSprintStory(accountId, workspaceId);
  return row != null ? sprintStoryOf(row) : null;
}

/** The CURRENT story for today's input, or null. */
export async function currentSprintStory(accountId: number, workspaceId: number, inputHash: string): Promise<SprintStory | null> {
  const row = await storedSprintStory(accountId, workspaceId);
  return isStoryCurrent(row, inputHash) ? sprintStoryOf(row!) : null;
}

export interface StoredSprintStory {
  headline: string;
  focus: string;
  storylines: SprintStoryline[];
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Upsert the workspace's ONE story row. */
export async function storeSprintStory(
  accountId: number,
  workspaceId: number,
  inputHash: string,
  v: StoredSprintStory,
  now: Date = new Date(),
): Promise<void> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintStory;
  const values = {
    inputHash,
    storyVersion: SPRINT_STORY_VERSION,
    storyJson: { headline: v.headline, focus: v.focus, storylines: v.storylines },
    model: SPRINT_BRIEF_MODEL,
    costUsd: v.costUsd,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    createdAt: now,
  };
  await db
    .insert(t)
    .values({ accountId, workspaceId, ...values })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId], set: values })
    .execute();
}

// ── The pass's last attempt + what is in flight ─────────────────────────────────────────────────
//
// The ATTEMPT lives on the workspace's `sprint_reads` row (`story_attempt_at/_hash/_error`; a story
// row cannot exist without a story). Written by the pass (review/sprint-story/manager.ts) after every
// pass that called Claude: error null = stored, else the failure code. ⚠ THE BACKOFF: a failure for
// today's input hash is not retried until the hash moves (`storyBackedOff`) — every read used to
// re-bill two refused calls for ever, with nothing recorded, while the page said "Writing…".
//
// IN FLIGHT is in-process (the pass runs in this process; LOCAL only): `queued` from the moment a
// stored sprint read hands the workspace to the after-read chain (briefs → themes → story) until the
// chain ends, `running` while the story pass itself holds its slot.

export interface SprintStoryAttempt {
  at: Date | null;
  inputHash: string | null;
  error: string | null;
}

const FAILURES: readonly string[] = [
  'not_json', 'shape', 'too_long', 'count', 'unknown_id', 'duplicate', 'coverage', 'numeral', 'number_word', 'unknown_key', 'number', 'error',
];
export const isSprintStoryFailure = (v: unknown): v is SprintStoryFailure => typeof v === 'string' && FAILURES.includes(v);

/** A failed pass for THIS input is not tried again (the backoff): wait for the input to move. Pure. */
export function storyBackedOff(a: SprintStoryAttempt | null | undefined, inputHash: string): boolean {
  return a != null && a.error != null && a.inputHash === inputHash;
}

/** Record the pass's attempt on the workspace's sprint_reads row (no row → nothing to record). */
export async function recordSprintStoryAttempt(
  accountId: number,
  workspaceId: number,
  inputHash: string,
  error: SprintStoryFailure | null,
  now: Date = new Date(),
): Promise<void> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintReads;
  await db
    .update(t)
    .set({ storyAttemptAt: now, storyAttemptHash: inputHash, storyAttemptError: error })
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .execute();
}

/** The last recorded attempt, this account + workspace only. */
export async function sprintStoryAttempt(accountId: number, workspaceId: number): Promise<SprintStoryAttempt | null> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintReads;
  const rows = await db
    .select({ at: t.storyAttemptAt, inputHash: t.storyAttemptHash, error: t.storyAttemptError })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .limit(1)
    .execute();
  return (rows[0] as SprintStoryAttempt | undefined) ?? null;
}

const flightKey = (a: number, w: number): string => `${a}:${w}`;
const storyRunning = new Set<string>();
const storyQueued = new Map<string, number>();

/** Claim the story pass's slot. false = one is already running. ⚠ SYNCHRONOUS — no await in between. */
export function claimSprintStoryPass(accountId: number, workspaceId: number): boolean {
  const k = flightKey(accountId, workspaceId);
  if (storyRunning.has(k)) return false;
  storyRunning.add(k);
  return true;
}
export function releaseSprintStoryPass(accountId: number, workspaceId: number): void {
  storyRunning.delete(flightKey(accountId, workspaceId));
}
export function isSprintStoryRunning(accountId: number, workspaceId: number): boolean {
  return storyRunning.has(flightKey(accountId, workspaceId));
}
/** The after-read chain holds this workspace (counted: two reads may overlap). */
export function markSprintStoryQueued(accountId: number, workspaceId: number, on: boolean): void {
  const k = flightKey(accountId, workspaceId);
  const n = (storyQueued.get(k) ?? 0) + (on ? 1 : -1);
  if (n > 0) storyQueued.set(k, n);
  else storyQueued.delete(k);
}
export function isSprintStoryQueued(accountId: number, workspaceId: number): boolean {
  return storyQueued.has(flightKey(accountId, workspaceId));
}
/** Test seam. */
export function resetSprintStoryFlight(): void {
  storyRunning.clear();
  storyQueued.clear();
}

/**
 * Where the story pass stands for today's input — the ONE fold the page reads
 * (`SprintGraphResponse.storyStatus`). Pure.
 *   • 'none'    — no pass can run: AI off, the sprint not eligible (too few tickets / nothing to say), or
 *                 no Claude credential and the story is not current.
 *   • 'current' — the stored story was written for today's input at today's version.
 *   • 'writing' — the pass is running now.
 *   • 'queued'  — the after-read chain holds the workspace (summaries, then themes, then the story).
 *   • 'failed'  — the last pass was for today's input and stored nothing (the backoff holds it).
 *   • 'waiting' — otherwise: the next sprint read starts a pass.
 */
export function sprintStoryStatusOf(p: {
  aiEnabled: boolean;
  canRun: boolean;
  eligible: boolean;
  inputHash: string | null;
  row: Pick<SprintStoryRow, 'inputHash' | 'storyVersion'> | null;
  hasStory: boolean;
  attempt: SprintStoryAttempt | null;
  running: boolean;
  queued: boolean;
}): SprintStoryStatus {
  const lastAttemptAt = p.attempt?.at != null ? p.attempt.at.toISOString() : null;
  const current = p.inputHash != null && isStoryCurrent(p.row, p.inputHash);
  const stale = p.hasStory && !current;
  const base = { stale, lastAttemptAt, failure: null as SprintStoryFailure | null };
  if (!p.aiEnabled || !p.eligible || p.inputHash == null) return { ...base, state: 'none', stale: false };
  if (current) return { ...base, state: 'current' };
  if (p.running) return { ...base, state: 'writing' };
  if (!p.canRun) return { ...base, state: 'none' };
  if (p.queued) return { ...base, state: 'queued' };
  if (storyBackedOff(p.attempt, p.inputHash) && isSprintStoryFailure(p.attempt!.error)) {
    return { ...base, state: 'failed', failure: p.attempt!.error };
  }
  return { ...base, state: 'waiting' };
}
