import { and, eq, gte, inArray } from 'drizzle-orm';
import {
  SPRINT_REPO_SUGGESTIONS_MAX,
  type SprintRepoReason,
  type SprintRepoSuggestion,
  type TrackerProvider,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import type { SprintTicketDbRow } from './sprint-store.js';

// REPORTS → THIS SPRINT — CANDIDATE REPO SUGGESTIONS per ticket. CODE suggests, the reader accepts:
// a suggestion is computed on every read and never stored, and only an ACCEPTED repo
// (db/sprint-ticket-repos.ts) reaches the assessment.
//
// EVIDENCE, strongest first (the order of `REASON_ORDER`):
//   issue_repo       a GitHub Issues key names this repo (`owner/repo#n`)
//   ticket_pr        a PR on THIS ticket (stored `tracker_tickets`) is in this repo
//   same_epic        other sprint tickets of the account in the same epic → their MERGED PRs' repos
//   same_component   likewise, sharing a component (Jira components / Linear labels), same project
//   same_project     tickets with the same key prefix (Jira project / Linear team / GitHub repo) on
//                    the same site → PRs MERGED in the last 180 days → repo
//   named_in_ticket  the repo's NAME as a whole word in the ticket text (names under 3 characters skipped)
//
// Only repos of THIS workspace (`workspace_repos`), never one already accepted, at most
// SPRINT_REPO_SUGGESTIONS_MAX per ticket. Ranked by best reason, then merged-PR count, then name.
// COST: a fixed handful of account-scoped indexed scans for the WHOLE list — never a query per ticket.

const DAY_MS = 86_400_000;
const PROJECT_LOOKBACK_DAYS = 180;
const NAME_MIN_CHARS = 3;
const CHUNK = 400;

const REASON_ORDER: readonly SprintRepoReason[] = [
  'issue_repo',
  'ticket_pr',
  'same_epic',
  'same_component',
  'same_project',
  'named_in_ticket',
];
const HISTORY: ReadonlySet<SprintRepoReason> = new Set(['ticket_pr', 'same_epic', 'same_component', 'same_project']);

export interface SuggestTicket {
  ident: string;
  provider: TrackerProvider;
  apiRoot: string;
  issueKey: string;
  projectKey: string | null;
  epicKey: string | null;
  components: string[];
  /** title + description + criteria — the named-in-ticket scan's input. */
  text: string;
}

/** The project prefix of a key: `ENG-12` → `ENG`, `acme/web#4` → `acme/web`. */
export function keyPrefix(provider: string, key: string): string | null {
  if (provider === 'github') {
    const i = key.lastIndexOf('#');
    return i > 0 ? key.slice(0, i).toLowerCase() : null;
  }
  const i = key.lastIndexOf('-');
  return i > 0 ? key.slice(0, i).toUpperCase() : null;
}

function parseComponents(json: string | null): string[] {
  if (json == null) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  } catch {
    return [];
  }
}

/** A stored sprint ticket as a suggestion input. */
export function suggestTicketOf(row: SprintTicketDbRow): SuggestTicket {
  return {
    ident: row.ident,
    provider: row.provider as TrackerProvider,
    apiRoot: row.apiRoot,
    issueKey: row.issueKey,
    projectKey: row.projectKey ?? null,
    epicKey: row.epicKey ?? null,
    components: parseComponents(row.componentsJson ?? null),
    text: [row.title, row.description, row.acceptanceCriteria].join('\n'),
  };
}

const siteKey = (provider: string, apiRoot: string, issueKey: string): string => `${provider}\u0000${apiRoot}\u0000${issueKey}`;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is `name` present in `text` as a whole word (case-insensitive)? Word = letters, digits, _ . - */
export function namedInText(name: string, text: string): boolean {
  if (name.length < NAME_MIN_CHARS) return false;
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRe(name)}($|[^A-Za-z0-9_-])`, 'i').test(text);
}

interface Evidence {
  reasons: Set<SprintRepoReason>;
  prIds: Set<number>;
}

export async function suggestSprintRepos(
  accountId: number,
  workspaceId: number,
  tickets: readonly SuggestTicket[],
  accepted: ReadonlyMap<string, readonly number[]>,
  nowMs: number = Date.now(),
): Promise<Map<string, SprintRepoSuggestion[]>> {
  const out = new Map<string, SprintRepoSuggestion[]>();
  if (tickets.length === 0) return out;
  const { repos: r, workspaceRepos: wr, trackerTickets: tt, pullRequests: pr, sprintTickets: st } = schema;

  // 1. The workspace's repos — the only repos a suggestion may name.
  const wsRepos = await db
    .select({ id: r.id, owner: r.owner, name: r.name })
    .from(r)
    .innerJoin(wr, and(eq(wr.repoId, r.id), eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId)))
    .where(eq(r.accountId, accountId))
    .execute();
  if (wsRepos.length === 0) {
    for (const t of tickets) out.set(t.ident, []);
    return out;
  }
  const repoById = new Map(wsRepos.map((x) => [x.id, { repoId: x.id, fullName: `${x.owner}/${x.name}`, name: x.name }]));
  const repoByFull = new Map(wsRepos.map((x) => [`${x.owner}/${x.name}`.toLowerCase(), x.id]));
  const wsRepoIds = [...repoById.keys()];

  const evidence = new Map<string, Map<number, Evidence>>();
  const note = (ident: string, repoId: number, reason: SprintRepoReason, prId: number | null): void => {
    if (!repoById.has(repoId)) return;
    const perTicket = evidence.get(ident) ?? new Map<number, Evidence>();
    const e = perTicket.get(repoId) ?? { reasons: new Set<SprintRepoReason>(), prIds: new Set<number>() };
    e.reasons.add(reason);
    if (prId != null) e.prIds.add(prId);
    perTicket.set(repoId, e);
    evidence.set(ident, perTicket);
  };

  // 2. Epic / component mates among the account's stored sprint tickets (any workspace: an epic's
  //    history is the account's, the repo filter above keeps it to this workspace's repos).
  const epicKeys = [...new Set(tickets.map((t) => t.epicKey).filter((k): k is string => k != null))];
  const wantComponents = tickets.some((t) => t.components.length > 0);
  const mates: Array<{ ident: string; provider: string; apiRoot: string; issueKey: string; epicKey: string | null; projectKey: string | null; components: string[] }> = [];
  if (epicKeys.length > 0 || wantComponents) {
    const rows = await db
      .select({
        ident: st.ident,
        provider: st.provider,
        apiRoot: st.apiRoot,
        issueKey: st.issueKey,
        epicKey: st.epicKey,
        projectKey: st.projectKey,
        componentsJson: st.componentsJson,
      })
      .from(st)
      .where(eq(st.accountId, accountId))
      .execute();
    for (const m of rows) {
      const components = parseComponents(m.componentsJson ?? null);
      if ((m.epicKey != null && epicKeys.includes(m.epicKey)) || components.length > 0) {
        mates.push({ ...m, epicKey: m.epicKey ?? null, projectKey: m.projectKey ?? null, components });
      }
    }
  }

  // 3. ONE scan: every PR on the tickets themselves and on their mates (by key; site matched below).
  const keyed = new Set<string>();
  for (const t of tickets) keyed.add(t.issueKey);
  for (const m of mates) keyed.add(m.issueKey);
  const keyList = [...keyed];
  const prRows: Array<{ provider: string; apiRoot: string; issueKey: string; prId: number; repoId: number; state: string }> = [];
  for (let i = 0; i < keyList.length; i += CHUNK) {
    prRows.push(
      ...(await db
        .select({ provider: tt.provider, apiRoot: tt.apiRoot, issueKey: tt.issueKey, prId: pr.id, repoId: pr.repoId, state: pr.state })
        .from(tt)
        .innerJoin(pr, and(eq(pr.id, tt.prId), eq(pr.accountId, accountId)))
        .where(and(eq(tt.accountId, accountId), inArray(tt.issueKey, keyList.slice(i, i + CHUNK)), inArray(pr.repoId, wsRepoIds)))
        .execute()),
    );
  }
  const prsBySite = new Map<string, Array<{ prId: number; repoId: number; merged: boolean }>>();
  for (const p of prRows) {
    const k = siteKey(p.provider, p.apiRoot, p.issueKey);
    const arr = prsBySite.get(k) ?? [];
    arr.push({ prId: p.prId, repoId: p.repoId, merged: p.state === 'merged' });
    prsBySite.set(k, arr);
  }

  // 4. Same project: merged PRs of the last 180 days on the same sites, folded by key prefix.
  const roots = [...new Set(tickets.map((t) => t.apiRoot))];
  const since = new Date(nowMs - PROJECT_LOOKBACK_DAYS * DAY_MS);
  const projRows = await db
    .select({ provider: tt.provider, apiRoot: tt.apiRoot, issueKey: tt.issueKey, prId: pr.id, repoId: pr.repoId })
    .from(tt)
    .innerJoin(pr, and(eq(pr.id, tt.prId), eq(pr.accountId, accountId)))
    .where(
      and(
        eq(tt.accountId, accountId),
        inArray(tt.apiRoot, roots),
        eq(pr.state, 'merged'),
        gte(pr.mergedAt, since),
        inArray(pr.repoId, wsRepoIds),
      ),
    )
    .execute();
  const byProject = new Map<string, Array<{ prId: number; repoId: number }>>();
  for (const p of projRows) {
    const prefix = keyPrefix(p.provider, p.issueKey);
    if (prefix == null) continue;
    const k = `${p.provider}\u0000${p.apiRoot}\u0000${prefix}`;
    const arr = byProject.get(k) ?? [];
    arr.push({ prId: p.prId, repoId: p.repoId });
    byProject.set(k, arr);
  }

  for (const t of tickets) {
    // issue_repo
    if (t.provider === 'github') {
      const prefix = keyPrefix('github', t.issueKey);
      const id = prefix != null ? repoByFull.get(prefix) : undefined;
      if (id != null) note(t.ident, id, 'issue_repo', null);
    }
    // ticket_pr (any state)
    for (const p of prsBySite.get(siteKey(t.provider, t.apiRoot, t.issueKey)) ?? []) note(t.ident, p.repoId, 'ticket_pr', p.prId);
    // same_epic / same_component (merged PRs of OTHER tickets)
    for (const m of mates) {
      if (m.ident === t.ident || m.provider !== t.provider || m.apiRoot !== t.apiRoot) continue;
      const sameEpic = t.epicKey != null && m.epicKey === t.epicKey;
      const sameProject = t.projectKey == null || m.projectKey == null || t.projectKey === m.projectKey;
      const sameComponent = sameProject && t.components.some((c) => m.components.includes(c));
      if (!sameEpic && !sameComponent) continue;
      for (const p of prsBySite.get(siteKey(m.provider, m.apiRoot, m.issueKey)) ?? []) {
        if (!p.merged) continue;
        if (sameEpic) note(t.ident, p.repoId, 'same_epic', p.prId);
        if (sameComponent) note(t.ident, p.repoId, 'same_component', p.prId);
      }
    }
    // same_project
    const prefix = keyPrefix(t.provider, t.issueKey);
    if (prefix != null) {
      for (const p of byProject.get(`${t.provider}\u0000${t.apiRoot}\u0000${prefix}`) ?? []) note(t.ident, p.repoId, 'same_project', p.prId);
    }
    // named_in_ticket
    for (const repo of repoById.values()) if (namedInText(repo.name, t.text)) note(t.ident, repo.repoId, 'named_in_ticket', null);
  }

  const rank = new Map(REASON_ORDER.map((x, k) => [x, k]));
  for (const t of tickets) {
    const taken = new Set(accepted.get(t.ident) ?? []);
    const rows: SprintRepoSuggestion[] = [];
    for (const [repoId, e] of evidence.get(t.ident) ?? []) {
      if (taken.has(repoId)) continue;
      const repo = repoById.get(repoId)!;
      const reasons = [...e.reasons].sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99));
      rows.push({
        repoId,
        fullName: repo.fullName,
        reasons,
        prCount: [...e.reasons].some((x) => HISTORY.has(x)) ? e.prIds.size : 0,
      });
    }
    rows.sort(
      (a, b) =>
        (rank.get(a.reasons[0]!) ?? 99) - (rank.get(b.reasons[0]!) ?? 99) ||
        b.prCount - a.prCount ||
        a.fullName.localeCompare(b.fullName),
    );
    out.set(t.ident, rows.slice(0, SPRINT_REPO_SUGGESTIONS_MAX));
  }
  return out;
}
