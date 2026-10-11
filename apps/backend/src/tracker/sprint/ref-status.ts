import { and, eq, notInArray } from 'drizzle-orm';
import {
  canonicalTicketKey,
  parseTicketLinkBlockers,
  ticketKeyProject,
  ticketMentionsInText,
  trackerTicketIdent,
  type JiraStatusCategory,
  type TicketSite,
  type TrackerProvider,
} from '@pierre-review/shared';
import type { TrackerContext } from '../context.js';
import { isTicketKey, jiraAuthHeader, statusOf } from '../jira/client.js';
import { JiraFetchError, jiraGetJson } from '../jira/fetch.js';
import { fieldValueToText } from '../jira/text.js';
import { maybeAdapterFor } from '../registry.js';
import type { TrackerCall } from '../types.js';

// ── REFERENCED TICKETS' STATUS (Reports → This sprint; docs/TRACKERS.md § The sprint list read →
// Referenced tickets) ─────────────────────────────────────────────────────────────────────────────
//
// A sprint ticket's text names other tickets — work it supersedes, shipped work it extends, an
// existing page it sends the user to, siblings left out of scope, one it really waits on. Limn knew
// the STATUS only of sprint tickets and of tickets read off a pull request, so a named "BMD-343" read
// "status unknown" and a finished one could still look like a blocker. The sprint read now asks the
// tracker for the rest, ONCE per read:
//
//   • WHICH KEYS (`sprintReferencedKeys`, pure): every ticket the stored in-sprint rows' description +
//     criteria name (shared `ticketMentionsInText`: a link on this site always; a BARE key only when
//     its project is one the workspace reads or the ticket's own — `UTF-8` has a key's shape), plus
//     tracker links that came WITHOUT a status. A label's references name keys from the same text (its
//     validator keeps only keys the text names), so the text is the superset. Minus the sprint's own
//     tickets and any key a stored row already gives a status for (`knownTicketsFor`, refs excluded).
//     Capped at SPRINT_REF_LOOKUP_MAX.
//   • THE CALL: Jira only for now — `GET /rest/api/3/search/jql` with JQL `key in (…)`,
//     `fields=summary,status`, through the ONE outbound helper (`jiraGetJson`), SPRINT_REF_CHUNK keys
//     per call (404 → the Server / Data Center v2 search). ⚠ Jira answers 400 for the WHOLE query
//     when one key does not exist (deleted, moved, a typo), so a 400 chunk is BISECTED and a lone bad
//     key dropped — bounded by SPRINT_REF_CALLS_MAX calls per read. Linear and GitHub Issues return
//     nothing (their tickets' text rarely names others; not built).
//   • THE STORE: `sprint_ref_tickets` is REPLACED per workspace by a lookup that finished — rows for
//     keys no longer named, or not found, are deleted. A lookup that failed or ran out of calls keeps
//     what it could not re-read. ⚠ NEVER on a view: only `readWorkspaceSprint` calls this.

/** Keys one read looks up at most. */
export const SPRINT_REF_LOOKUP_MAX = 200;
/** Keys per search call (one page: maxResults is 100). */
export const SPRINT_REF_CHUNK = 50;
/** Calls one read may spend on the lookup, bisection included. */
export const SPRINT_REF_CALLS_MAX = 16;

export interface RefTicket {
  key: string;
  title: string | null;
  status: string | null;
  category: JiraStatusCategory | null;
  url: string | null;
}

export interface RefLookupResult {
  tickets: RefTicket[];
  /** Every asked key got an answer (found or provably not found). False = out of calls / a failure. */
  complete: boolean;
}

/** One provider's batched lookup. Throws `JiraFetchError` only for a failure of the whole lookup. */
export type RefLister = (call: TrackerCall, keys: readonly string[], browseBase: string) => Promise<RefLookupResult>;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** `key in ("A-1","A-2")` — keys already checked by `isTicketKey`. */
export function refJql(keys: readonly string[]): string {
  return `key in (${keys.map((k) => `"${k}"`).join(',')})`;
}

/** One search answer → the tickets in it. Pure (exported for its test). */
export function refTicketsOf(raw: unknown, browseBase: string): RefTicket[] {
  const issues = asRecord(raw)?.issues;
  if (!Array.isArray(issues)) return [];
  const out: RefTicket[] = [];
  for (const i of issues) {
    const o = asRecord(i);
    const f = asRecord(o?.fields);
    const key = typeof o?.key === 'string' ? o.key : '';
    if (f == null || !isTicketKey(key)) continue;
    const st = statusOf(f.status);
    const title = fieldValueToText(f.summary).trim();
    out.push({
      key,
      title: title === '' ? null : title.slice(0, 300),
      status: st?.name ?? null,
      category: st?.category ?? null,
      url: /^https:\/\//i.test(browseBase) ? `${browseBase.replace(/\/+$/, '')}/browse/${key}` : null,
    });
  }
  return out;
}

/** JIRA: batched `key in (…)` searches; a 400 chunk is bisected, a lone bad key dropped. */
export const jiraRefLister: RefLister = async (call, keys, browseBase) => {
  const headers = { authorization: jiraAuthHeader(call.credentials) };
  const wanted = [...new Set(keys.filter(isTicketKey))];
  const out = new Map<string, RefTicket>();
  let calls = 0;
  let complete = true;
  let v2 = false;
  const ask = async (chunk: readonly string[]): Promise<unknown> => {
    const q = new URLSearchParams({ jql: refJql(chunk), fields: 'summary,status', maxResults: '100' });
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
      for (const t of refTicketsOf(await ask(chunk), browseBase)) out.set(t.key, t);
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

/** The keys the stored in-sprint rows name — text mentions on this site (a bare key only in a known
 *  project) and status-less tracker links — minus the sprint's own keys. Upper-cased (prefix keys),
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
    for (const l of parseTicketLinkBlockers(r.blockedByJson) ?? []) if (l.status == null) add(l.key);
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

/**
 * Look up and store the status of every ticket this workspace's sprint names and Limn holds nowhere
 * else. Called by the sprint read after it stored the list. Never throws; returns what it did.
 */
export async function refreshSprintRefTickets(
  ctx: TrackerContext,
  a: {
    accountId: number;
    workspaceId: number;
    call: TrackerCall;
    baseUrl: string | null;
    projectKeys: readonly string[];
    nowMs: number;
    listers?: Partial<Record<TrackerProvider, RefLister>>;
  },
): Promise<{ asked: number; stored: number; code: string | null }> {
  const lister = (a.listers ?? SPRINT_REF_LISTERS)[a.call.provider];
  const rt = ctx.schema.sprintRefTickets;
  if (lister == null || rt == null) return { asked: 0, stored: 0, code: null };
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
    const site: TicketSite = { provider: a.call.provider, root: a.call.apiRoot };
    const named = sprintReferencedKeys(rows, site, a.projectKeys);
    // LAZY: the core lookup opens the core database client.
    const { knownTicketsFor } = await import('../../db/story-issue-input.js');
    const known = await knownTicketsFor(a.accountId, a.call.provider, a.call.apiRoot, named, { refs: false });
    const ask = named.filter((k) => known.get(k.toUpperCase())?.status == null);
    const adapter = maybeAdapterFor(a.call.provider);
    const browseBase = adapter?.fixedBaseUrl ?? a.baseUrl ?? a.call.apiRoot;
    const res = ask.length > 0 ? await lister(a.call, ask, browseBase) : { tickets: [], complete: true };
    const at = new Date(a.nowMs);
    const askedSet = new Set(ask.map((k) => k.toUpperCase()));
    const kept: string[] = [];
    for (const t of res.tickets) {
      if (!askedSet.has(t.key.toUpperCase())) continue;
      const ident = trackerTicketIdent(a.call.provider, a.call.apiRoot, t.key);
      kept.push(ident);
      const values = {
        provider: a.call.provider,
        apiRoot: a.call.apiRoot,
        issueKey: t.key,
        title: t.title,
        statusName: t.status,
        statusCategory: t.category,
        url: t.url,
        readAt: at,
      };
      await ctx.db
        .insert(rt)
        .values({ accountId: a.accountId, workspaceId: a.workspaceId, ident, ...values })
        .onConflictDoUpdate({ target: [rt.accountId, rt.workspaceId, rt.ident], set: values })
        .execute();
    }
    // Replace: a finished lookup is the whole answer. One cut short keeps the rows it did not re-read.
    if (res.complete) {
      await ctx.db
        .delete(rt)
        .where(
          and(
            eq(rt.accountId, a.accountId),
            eq(rt.workspaceId, a.workspaceId),
            ...(kept.length > 0 ? [notInArray(rt.ident, kept)] : []),
          ),
        )
        .execute();
    }
    return { asked: ask.length, stored: kept.length, code: res.complete ? null : 'incomplete' };
  } catch (err) {
    const code = err instanceof JiraFetchError ? err.code : 'unknown';
    ctx.log.warn({ accountId: a.accountId, workspaceId: a.workspaceId, code, route: 'tracker-sprint' }, 'sprint referenced-ticket lookup failed (non-fatal)');
    return { asked: 0, stored: 0, code };
  }
}
