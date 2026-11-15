// JIRA — MANY TICKETS' STATUSES IN ONE SEARCH (docs/TRACKERS.md § Batched status reads). The release
// scan and Refresh read every ticket of the tags after the baseline; one GET per ticket was the slow
// part. Here: ONE search per ≤ JIRA_STATUS_BATCH keys, `key in (A-1, B-2, …)`, fields `status`,
// `summary` and `issuetype` only, through the ONE outbound helper (`jiraGetJson`) and the workspace's
// sealed token.
//
//   • `GET /rest/api/3/search/jql` first; a Server / Data Center site has no v3 search (404) → the
//     same JQL on `/rest/api/2/search` for the rest of the batch (as the sprint read does).
//   • Jira refuses the WHOLE JQL (400) when one key does not exist. The batch is split in two and each
//     half asked again, down to one key, whose 400 means not found — log2(100) ≈ 7 extra calls per
//     missing key, never one call per key.
//   • A key absent from a good answer (the ticket moved project, or the token cannot see it) is
//     `missing`: the caller reads it on its own (the one-ticket read follows a moved key).
//   • 401 / 403 → `no_access` for the batch; anything else (timeout, 5xx) → `failed` (retried later).
// Keys are checked against `isTicketKey` (letters, digits, one hyphen): safe in JQL unquoted.
import type { TicketStatusAnswer, TrackerCall } from '../types.js';
import { isTicketKey, jiraAuthHeader, statusOf } from './client.js';
import { JiraFetchError, jiraGetJson } from './fetch.js';

export const JIRA_STATUS_BATCH = 100;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** The JQL for one batch. Pure. */
export function jiraStatusJql(keys: readonly string[]): string {
  return `key in (${keys.join(', ')})`;
}

/** One search answer → key → its status, for the keys asked only. Pure. */
export function jiraStatusAnswers(raw: unknown, asked: readonly string[]): Map<string, TicketStatusAnswer> {
  const want = new Set(asked);
  const out = new Map<string, TicketStatusAnswer>();
  const issues = asRecord(raw)?.issues;
  for (const issue of Array.isArray(issues) ? issues : []) {
    const r = asRecord(issue);
    const key = typeof r?.key === 'string' ? r.key : null;
    if (key == null || !want.has(key)) continue;
    const f = asRecord(r?.fields);
    const status = statusOf(f?.status);
    out.set(key, {
      state: 'ok',
      key,
      title: typeof f?.summary === 'string' ? f.summary.slice(0, 500) : null,
      status: status == null ? null : { name: status.name, category: status.category },
    });
  }
  for (const k of asked) if (!out.has(k)) out.set(k, { state: 'missing', key: k });
  return out;
}

/** Every key's status, ≤ JIRA_STATUS_BATCH keys a search. Never throws. */
export async function readJiraStatuses(
  call: TrackerCall,
  keys: readonly string[],
): Promise<{ answers: Map<string, TicketStatusAnswer>; calls: number }> {
  const answers = new Map<string, TicketStatusAnswer>();
  let calls = 0;
  let v2 = false;
  const valid = [...new Set(keys)].filter((k) => {
    if (isTicketKey(k)) return true;
    answers.set(k, { state: 'not_found', key: k });
    return false;
  });
  const search = async (part: string[]): Promise<unknown> => {
    const q = new URLSearchParams({ jql: jiraStatusJql(part), fields: 'status,summary,issuetype', maxResults: String(JIRA_STATUS_BATCH) });
    const get = (path: string): Promise<unknown> => {
      calls += 1;
      return jiraGetJson(`${call.apiRoot}${path}?${q.toString()}`, { authorization: jiraAuthHeader(call.credentials) }, call.policy, call.transport);
    };
    if (!v2) {
      try {
        return await get('/rest/api/3/search/jql');
      } catch (err) {
        if (!(err instanceof JiraFetchError && err.code === 'not_found')) throw err;
        v2 = true;
      }
    }
    return get('/rest/api/2/search');
  };
  const ask = async (part: string[]): Promise<void> => {
    try {
      for (const [k, a] of jiraStatusAnswers(await search(part), part)) answers.set(k, a);
    } catch (err) {
      const code = err instanceof JiraFetchError ? err.code : 'network';
      const status = err instanceof JiraFetchError ? err.status : null;
      if (code === 'http' && status === 400) {
        if (part.length === 1) answers.set(part[0]!, { state: 'not_found', key: part[0]! });
        else {
          const mid = Math.ceil(part.length / 2);
          await ask(part.slice(0, mid));
          await ask(part.slice(mid));
        }
        return;
      }
      const state = code === 'unauthorized' || code === 'forbidden' ? 'no_access' : 'failed';
      for (const k of part) answers.set(k, { state, key: k });
    }
  };
  for (let i = 0; i < valid.length; i += JIRA_STATUS_BATCH) await ask(valid.slice(i, i + JIRA_STATUS_BATCH));
  return { answers, calls };
}
