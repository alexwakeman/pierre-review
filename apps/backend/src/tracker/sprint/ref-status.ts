import { and, eq, notInArray } from 'drizzle-orm';
import {
  SPRINT_GHOST_DEPTH_MAX,
  SPRINT_GHOST_MAX,
  canonicalTicketKey,
  parseTicketLinkBlockers,
  ticketKeyProject,
  ticketMentionsInText,
  trackerTicketIdent,
  type JiraStatusCategory,
  type TicketLinkBlocker,
  type TicketSite,
  type TrackerProvider,
} from '@pierre-review/shared';
import type { TrackerContext } from '../context.js';
import { isTicketKey, jiraAuthHeader, statusOf } from '../jira/client.js';
import { JiraFetchError, jiraGetJson } from '../jira/fetch.js';
import { fieldValueToText } from '../jira/text.js';
import { maybeAdapterFor } from '../registry.js';
import { deriveAc, readAcFieldSettings, settingFor } from '../store.js';
import { toJiraSprintTicket } from './jira.js';
import type { TrackerCall } from '../types.js';

// ── REFERENCED TICKETS AND GHOST CHAINS (Reports → This sprint; docs/TRACKERS.md § The sprint list
// read → Referenced tickets and ghost chains) ────────────────────────────────────────────────────
//
// A sprint ticket's text names other tickets — work it supersedes, shipped work it extends, a page it
// sends the user to, siblings left out of scope, one it really waits on. The sprint GRAPH draws the
// ones it depends on / runs alongside / builds on / replaces as GHOST nodes, and FOLLOWS THE CHAIN
// outside the sprint (A → B → C). So the sprint read asks the tracker for them, WITH their text:
//
//   • DEPTH 1 (`sprintReferencedKeys`, pure): every ticket the stored in-sprint rows' description +
//     criteria name (shared `ticketMentionsInText`: a link on this site always; a BARE key only when
//     its project is one the workspace reads or the ticket's own — `UTF-8` has a key's shape), plus
//     every tracker link. Minus the sprint's own tickets. ≤ SPRINT_REF_LOOKUP_MAX. Read in full, so the
//     drawer can say "BMD-343 · Done" for a ticket named only as context.
//   • DEPTH 2–SPRINT_GHOST_DEPTH_MAX: the keys a GHOST points at through an EDGE (its blocking tracker
//     links, and its CURRENT brief's depends_on / concurrent / builds_on / supersedes references) that
//     nothing stored holds yet — the graph fold's `missing` (db/sprint-graph-fold.ts, the SAME fold the
//     page draws), bounded so the graph never holds more than SPRINT_GHOST_MAX ghosts.
//   • A ghost's references come from its BRIEF, which the brief pass writes AFTER the read; so the pass
//     asks for the next hop when it has briefed a ghost (`expandSprintGhosts`, mode 'missing': only
//     keys nothing stores, never a delete). Still part of the read's pipeline — NEVER on a view.
//   • THE CALL: Jira only — `GET /rest/api/3/search/jql` with JQL `key in (…)`,
//     `fields=*all&expand=names,schema` (the same fold as the sprint list: candidates → criteria,
//     status, assignee, links), through the ONE outbound helper (`jiraGetJson`), SPRINT_REF_CHUNK keys
//     per call (404 → the Server / Data Center v2 search). ⚠ Jira answers 400 for the WHOLE query
//     when one key does not exist, so a 400 chunk is BISECTED and a lone bad key dropped — bounded by
//     SPRINT_REF_CALLS_MAX calls per lookup. Linear and GitHub Issues: none (not built).
//   • THE STORE: `sprint_ref_tickets` is REPLACED per workspace by a FULL lookup that finished — rows
//     no longer reached are deleted. A lookup cut short keeps what it could not re-read.

/** Keys one read looks up at depth 1 at most. */
export const SPRINT_REF_LOOKUP_MAX = 200;
/** Keys per search call (`*all` fields: kept well under the response size cap). */
export const SPRINT_REF_CHUNK = 40;
/** Calls one lookup may spend, bisection included. */
export const SPRINT_REF_CALLS_MAX = 16;

export interface RefTicket {
  key: string;
  title: string | null;
  status: string | null;
  category: JiraStatusCategory | null;
  url: string | null;
  /** The ticket's text (null = the lister read no text). */
  description?: string | null;
  acceptanceCriteria?: string | null;
  issueTypeName?: string | null;
  assignee?: { name: string; avatarUrl: string | null } | null;
  /** Its tracker links (undefined = not read). */
  blockedBy?: TicketLinkBlocker[] | null;
}

export interface RefLookupResult {
  tickets: RefTicket[];
  /** Every asked key got an answer (found or provably not found). False = out of calls / a failure. */
  complete: boolean;
}

/** One provider's batched lookup. Throws `JiraFetchError` only for a failure of the whole lookup. */
export type RefLister = (
  call: TrackerCall,
  keys: readonly string[],
  browseBase: string,
  acSettingFor?: (issueTypeId: string | null) => string | null,
) => Promise<RefLookupResult>;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** `key in ("A-1","A-2")` — keys already checked by `isTicketKey`. */
export function refJql(keys: readonly string[]): string {
  return `key in (${keys.map((k) => `"${k}"`).join(',')})`;
}

/** One search answer → the tickets in it, WITH their text when the answer carries it. Pure (exported
 *  for its test). */
export function refTicketsOf(
  raw: unknown,
  browseBase: string,
  apiRoot = '',
  acSettingFor: (issueTypeId: string | null) => string | null = () => null,
): RefTicket[] {
  const r = asRecord(raw);
  const issues = r?.issues;
  if (!Array.isArray(issues)) return [];
  const out: RefTicket[] = [];
  for (const i of issues) {
    const o = asRecord(i);
    const f = asRecord(o?.fields);
    const key = typeof o?.key === 'string' ? o.key : '';
    if (f == null || !isTicketKey(key)) continue;
    const st = statusOf(f.status);
    const title = fieldValueToText(f.summary).trim();
    const base: RefTicket = {
      key,
      title: title === '' ? null : title.slice(0, 300),
      status: st?.name ?? null,
      category: st?.category ?? null,
      url: /^https:\/\//i.test(browseBase) ? `${browseBase.replace(/\/+$/, '')}/browse/${key}` : null,
    };
    // A full read (`*all`): the same fold as a sprint ticket.
    const full = 'description' in f || 'issuelinks' in f ? toJiraSprintTicket(i, asRecord(r?.names), asRecord(r?.schema), false, apiRoot) : null;
    if (full != null) {
      base.description = full.description;
      base.acceptanceCriteria = deriveAc(full.candidates, acSettingFor(full.issueType?.id ?? null)).text;
      base.issueTypeName = full.issueType?.name ?? null;
      base.assignee = full.assignee ?? null;
      if (full.blockedBy !== undefined) base.blockedBy = full.blockedBy;
    }
    out.push(base);
  }
  return out;
}

/** JIRA: batched `key in (…)` searches; a 400 chunk is bisected, a lone bad key dropped. */
export const jiraRefLister: RefLister = async (call, keys, browseBase, acSettingFor) => {
  const headers = { authorization: jiraAuthHeader(call.credentials) };
  const wanted = [...new Set(keys.filter(isTicketKey))];
  const out = new Map<string, RefTicket>();
  let calls = 0;
  let complete = true;
  let v2 = false;
  const ask = async (chunk: readonly string[]): Promise<unknown> => {
    const q = new URLSearchParams({ jql: refJql(chunk), fields: '*all', expand: 'names,schema', maxResults: '100' });
    calls += 1;
    try {
      return await jiraGetJson(`${call.apiRoot}${v2 ? '/rest/api/2/search' : '/rest/api/3/search/jql'}?${q.toString()}`, headers, call.policy, call.transport);
    } catch (err) {
      // A Server / Data Center site has no v3 search: the same JQL on v2, from here on.
      if (v2 || !(err instanceof JiraFetchError && err.code === 'not_found')) throw err;
      v2 = true;
      calls += 1;
      return jiraGetJson(`${call.apiRoot}/rest/api/2/search?${q.toString()}`, headers, call.policy, call.transport);
    }
  };
  const run = async (chunk: readonly string[]): Promise<void> => {
    if (chunk.length === 0) return;
    if (calls >= SPRINT_REF_CALLS_MAX) {
      complete = false;
      return;
    }
    try {
      for (const t of refTicketsOf(await ask(chunk), browseBase, call.apiRoot, acSettingFor)) out.set(t.key, t);
    } catch (err) {
      if (!(err instanceof JiraFetchError && err.code === 'http' && err.status === 400)) throw err;
      // One key Jira does not know fails the whole query: halve until it is alone, then drop it.
      if (chunk.length === 1) return;
      const mid = Math.ceil(chunk.length / 2);
      await run(chunk.slice(0, mid));
      await run(chunk.slice(mid));
    }
  };
  for (let i = 0; i < wanted.length; i += SPRINT_REF_CHUNK) await run(wanted.slice(i, i + SPRINT_REF_CHUNK));
  return { tickets: [...out.values()], complete };
};

export const SPRINT_REF_LISTERS: Partial<Record<TrackerProvider, RefLister>> = { jira: jiraRefLister };

/** The keys the stored in-sprint rows name — their tracker links and text mentions on this site (a
 *  bare key only in a known project) — minus the sprint's own keys. Upper-cased (prefix keys),
 *  first-appearance order, ≤ SPRINT_REF_LOOKUP_MAX. Pure. */
export function sprintReferencedKeys(
  rows: ReadonlyArray<{ issueKey: string; description: string | null; acceptanceCriteria: string | null; blockedByJson?: unknown }>,
  site: TicketSite,
  projectKeys: readonly string[],
): string[] {
  const own = new Set(rows.map((r) => r.issueKey.toUpperCase()));
  const projects = new Set(projectKeys.map((p) => p.toUpperCase()));
  for (const r of rows) {
    const p = ticketKeyProject(r.issueKey);
    if (p != null) projects.add(p);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const key = canonicalTicketKey(raw) ?? raw.trim();
    const k = key.toUpperCase();
    if (k === '' || own.has(k) || seen.has(k)) return;
    seen.add(k);
    out.push(site.provider === 'github' ? key : k);
  };
  for (const r of rows) {
    for (const l of parseTicketLinkBlockers(r.blockedByJson) ?? []) add(l.key);
    for (const m of ticketMentionsInText(`${r.description ?? ''}\n${r.acceptanceCriteria ?? ''}`, site)) {
      if (m.via === 'bare') {
        const p = ticketKeyProject(m.key);
        if (p == null || !projects.has(p)) continue;
      }
      add(m.key);
    }
  }
  return out.slice(0, SPRINT_REF_LOOKUP_MAX);
}

export interface RefreshRefArgs {
  accountId: number;
  workspaceId: number;
  call: TrackerCall;
  baseUrl: string | null;
  projectKeys: readonly string[];
  nowMs: number;
  listers?: Partial<Record<TrackerProvider, RefLister>>;
  /** 'full' (the sprint read): depth 1 re-read, chains re-followed, the store REPLACED. 'missing' (after
   *  a brief pass): only the chain keys nothing stores, nothing deleted. Default 'full'. */
  mode?: 'full' | 'missing';
}

/**
 * Look up and store the tickets this workspace's sprint names (depth 1) and the ghost chains they lead
 * to (depth 2..SPRINT_GHOST_DEPTH_MAX). Called by the sprint read ('full') and after a brief pass
 * ('missing'). Never throws; returns what it did (`stored` = rows written this time).
 */
export async function refreshSprintRefTickets(
  ctx: TrackerContext,
  a: RefreshRefArgs,
): Promise<{ asked: number; stored: number; code: string | null }> {
  const lister = (a.listers ?? SPRINT_REF_LISTERS)[a.call.provider];
  const rt = ctx.schema.sprintRefTickets;
  if (lister == null || rt == null) return { asked: 0, stored: 0, code: null };
  const mode = a.mode ?? 'full';
  try {
    const st = ctx.schema.sprintTickets;
    const rows = (await ctx.db
      .select({ issueKey: st.issueKey, description: st.description, acceptanceCriteria: st.acceptanceCriteria, blockedByJson: st.blockedByJson })
      .from(st)
      .where(
        and(
          eq(st.accountId, a.accountId),
          eq(st.workspaceId, a.workspaceId),
          eq(st.inSprint, true),
          eq(st.provider, a.call.provider),
          eq(st.apiRoot, a.call.apiRoot),
        ),
      )
      .execute()) as Array<{ issueKey: string; description: string | null; acceptanceCriteria: string | null; blockedByJson: unknown }>;
    const own = new Set(rows.map((r) => r.issueKey.toUpperCase()));
    const site: TicketSite = { provider: a.call.provider, root: a.call.apiRoot };
    const adapter = maybeAdapterFor(a.call.provider);
    const browseBase = adapter?.fixedBaseUrl ?? a.baseUrl ?? a.call.apiRoot;
    const acSettings = await readAcFieldSettings(ctx, a.accountId, [a.workspaceId]);
    const acSettingFor = (issueTypeId: string | null): string | null => settingFor(acSettings, a.workspaceId, a.call.apiRoot, issueTypeId);
    const at = new Date(a.nowMs);
    const kept = new Set<string>();
    const asked = new Set<string>();
    let complete = true;
    let stored = 0;
    const store = async (tickets: readonly RefTicket[], depth: number, wanted: ReadonlySet<string>): Promise<void> => {
      for (const t of tickets) {
        const k = t.key.toUpperCase();
        if (!wanted.has(k) || own.has(k)) continue;
        const ident = trackerTicketIdent(a.call.provider, a.call.apiRoot, t.key);
        if (kept.has(ident)) continue;
        kept.add(ident);
        const values = {
          provider: a.call.provider,
          apiRoot: a.call.apiRoot,
          issueKey: t.key,
          title: t.title,
          statusName: t.status,
          statusCategory: t.category,
          url: t.url,
          readAt: at,
          depth,
          // The text, observed keys only: a lister that read none leaves the stored text alone.
          ...(t.description !== undefined ? { description: t.description } : {}),
          ...(t.acceptanceCriteria !== undefined ? { acceptanceCriteria: t.acceptanceCriteria } : {}),
          ...(t.issueTypeName !== undefined ? { issueTypeName: t.issueTypeName } : {}),
          ...(t.assignee !== undefined ? { assigneeName: t.assignee?.name ?? null, assigneeAvatarUrl: t.assignee?.avatarUrl ?? null } : {}),
          ...(t.blockedBy !== undefined ? { blockedByJson: t.blockedBy } : {}),
        };
        await ctx.db
          .insert(rt)
          .values({ accountId: a.accountId, workspaceId: a.workspaceId, ident, ...values })
          .onConflictDoUpdate({ target: [rt.accountId, rt.workspaceId, rt.ident], set: values })
          .execute();
        stored += 1;
      }
    };
    const lookUp = async (keys: readonly string[], depth: number): Promise<void> => {
      const fresh = keys.filter((k) => !asked.has(k.toUpperCase()) && !own.has(k.toUpperCase()));
      if (fresh.length === 0) return;
      for (const k of fresh) asked.add(k.toUpperCase());
      const res = await lister(a.call, fresh, browseBase, acSettingFor);
      if (!res.complete) complete = false;
      await store(res.tickets, depth, new Set(fresh.map((k) => k.toUpperCase())));
    };

    // ---- depth 1: everything the sprint names (the full read only) ----
    if (mode === 'full') await lookUp(sprintReferencedKeys(rows, site, a.projectKeys), 1);

    // ---- the chains: what the graph's nodes point at that nothing holds ----
    // LAZY: the graph loader opens the core database client.
    const [{ loadGraphTickets }, { foldSprintGraph }] = await Promise.all([
      import('../../db/sprint-graph.js'),
      import('../../db/sprint-graph-fold.js'),
    ]);
    for (let round = 0; round < SPRINT_GHOST_DEPTH_MAX; round += 1) {
      const g0 = await loadGraphTickets(a.accountId, a.workspaceId, { provider: a.call.provider, apiRoot: a.call.apiRoot }, true);
      // A full read follows only what THIS read holds — a row of an earlier read is replaced, not trusted.
      const ghosts = mode === 'full' ? g0.ghosts.filter((g) => kept.has(g.ident)) : g0.ghosts;
      const g = foldSprintGraph({ provider: a.call.provider, apiRoot: a.call.apiRoot, sprint: g0.sprint, ghosts, stageOf: () => null });
      const room = SPRINT_GHOST_MAX - g.nodes.filter((n) => n.ghost).length;
      const want = g.missing.filter((m) => !asked.has(m.key.toUpperCase()) && !own.has(m.key.toUpperCase()));
      if (room <= 0 || want.length === 0) break;
      const next = want.slice(0, room);
      for (const d of [...new Set(next.map((m) => m.depth))]) {
        await lookUp(
          next.filter((m) => m.depth === d).map((m) => m.key),
          d,
        );
      }
    }

    // Replace: a finished FULL lookup is the whole answer. One cut short keeps the rows it did not re-read.
    if (mode === 'full' && complete) {
      const keep = [...kept];
      await ctx.db
        .delete(rt)
        .where(and(eq(rt.accountId, a.accountId), eq(rt.workspaceId, a.workspaceId), ...(keep.length > 0 ? [notInArray(rt.ident, keep)] : [])))
        .execute();
    }
    return { asked: asked.size, stored, code: complete ? null : 'incomplete' };
  } catch (err) {
    const code = err instanceof JiraFetchError ? err.code : 'unknown';
    ctx.log.warn({ accountId: a.accountId, workspaceId: a.workspaceId, code, route: 'tracker-sprint' }, 'sprint referenced-ticket lookup failed (non-fatal)');
    return { asked: 0, stored: 0, code };
  }
}
