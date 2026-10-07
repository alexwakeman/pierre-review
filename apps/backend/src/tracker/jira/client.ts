import type { JiraAcCandidate, JiraFieldOption } from '@pierre-review/shared';
import { extractAcCandidates } from './candidates.js';
import { JiraFetchError, jiraGetJson, type JiraFetchPolicy, type JiraTransport } from './fetch.js';
import { fieldValueToText, jiraWikiToMarkdown } from './text.js';

// The Jira REST v2 calls Limn makes — exactly two: the field list (the Settings connection check)
// and one issue with every field (title, description, issue type, status, assignee and the
// acceptance-criteria candidates) — the latter made ONLY by the ticket worker (../worker.ts).
// v2, not v3: it works on Jira Cloud AND Server / Data Center, and returns `description` as a
// wiki-markup string (v3 is Cloud-only and always ADF). ADF is still handled — some fields and
// instances return it on v2 too (text.ts).

// ---- the API root ----

// ⚠ THE ONE DERIVATION OF THE JIRA API ROOT from the workspace's tracker base URL now lives in
// @pierre-review/shared (`jiraApiRoot`), because the SPA folds a ticket's browse link onto the SAME
// root to name the ticket (`jira:<apiRoot>#<KEY>`). The stored base URL SHOULD be the site root
// including any context path; people paste a ticket link, an API URL or a `/secure/…` page, and
// the fold cuts all of those back to the root. Re-exported so every caller here keeps its import.
export { jiraApiRoot } from '@pierre-review/shared';

// ---- auth ----

export interface JiraCredentials {
  email: string | null;
  token: string;
}

/**
 * Jira Cloud: HTTP Basic with `email:apiToken`. Server / Data Center: `Bearer <personal access
 * token>`. The email decides — present means Cloud. ⚠ The header is the credential; never log it.
 */
export function jiraAuthHeader(c: JiraCredentials): string {
  const email = c.email?.trim() ?? '';
  if (email !== '') return `Basic ${Buffer.from(`${email}:${c.token}`, 'utf8').toString('base64')}`;
  return `Bearer ${c.token}`;
}

// ---- errors ----

/** Plain-English sentence for each failure. Never includes anything Jira sent back. */
export function jiraErrorMessage(err: unknown): string {
  const code = err instanceof JiraFetchError ? err.code : 'network';
  switch (code) {
    case 'unauthorized':
      return 'Jira did not accept the saved token. Check the email and token in Settings.';
    case 'forbidden':
      return 'The saved Jira token does not have permission to read this.';
    case 'not_found':
      return 'Jira has no such ticket, or the saved token cannot see it.';
    case 'redirect':
      return 'Jira answered with a redirect. Check the base URL in Settings is the Jira site itself.';
    case 'timeout':
      return 'Jira did not answer within 10 seconds.';
    case 'blocked':
      return 'Limn will not connect to that address. The Jira base URL must be a public https address.';
    case 'bad_url':
      return 'The Jira base URL in Settings is not a valid web address.';
    case 'not_json':
      return 'Jira did not answer with data. Check the base URL in Settings points at Jira.';
    case 'too_large':
      return 'Jira sent more data than Limn accepts.';
    case 'http':
      return `Jira answered with an error${err instanceof JiraFetchError && err.status != null ? ` (${err.status})` : ''}.`;
    case 'network':
    default:
      return 'Could not reach Jira. Check the base URL in Settings.';
  }
}

// ---- the field list ----

/** Jira's `GET /rest/api/2/field` rows → custom fields only, sorted by name, well-formed only. */
export function toFieldOptions(raw: unknown): JiraFieldOption[] {
  if (!Array.isArray(raw)) return [];
  const out: JiraFieldOption[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    if (typeof f !== 'object' || f === null) continue;
    const o = f as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : null;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (id == null || !isJiraFieldId(id) || name === '' || seen.has(id)) continue;
    if (o.custom !== true) continue;
    const schema = typeof o.schema === 'object' && o.schema !== null ? (o.schema as Record<string, unknown>) : null;
    seen.add(id);
    out.push({ id, name, custom: true, type: typeof schema?.type === 'string' ? schema.type : null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** A field id safe to put in a query string: `customfield_10042`, `environment`, … */
export function isJiraFieldId(id: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(id);
}

export interface JiraCall {
  apiRoot: string;
  credentials: JiraCredentials;
  policy: JiraFetchPolicy;
  transport?: JiraTransport;
}

export async function fetchJiraFields(call: JiraCall): Promise<JiraFieldOption[]> {
  const raw = await jiraGetJson(
    `${call.apiRoot}/rest/api/2/field`,
    { authorization: jiraAuthHeader(call.credentials) },
    call.policy,
    call.transport,
  );
  return toFieldOptions(raw);
}

// ---- one issue ----

export type JiraStatusCategory = 'new' | 'indeterminate' | 'done';

export interface JiraIssueAssignee {
  name: string;
  // Jira Cloud `accountId`, else Server / Data Center `key` / `name`; null when neither.
  accountId: string | null;
  // The 48x48 avatar, https only; null otherwise.
  avatarUrl: string | null;
}

export interface JiraIssueText {
  key: string;
  title: string;
  description: string;
  issueType: { id: string; name: string } | null;
  // The workflow status as Jira names it ("In Review"), and its category — the only part that
  // means the same thing on every site. null when Jira sent none.
  status: { name: string; category: JiraStatusCategory | null } | null;
  assignee: JiraIssueAssignee | null;
  candidates: JiraAcCandidate[];
  omittedCandidates: number;
}

const STATUS_CATEGORIES: readonly string[] = ['new', 'indeterminate', 'done'];

/** Jira's `fields.status` → name + category key. */
export function statusOf(raw: unknown): JiraIssueText['status'] {
  const s = asRecord(raw);
  const name = typeof s?.name === 'string' ? s.name.trim() : '';
  if (name === '') return null;
  const key = asRecord(s?.statusCategory)?.key;
  return {
    name: name.slice(0, 100),
    category:
      typeof key === 'string' && STATUS_CATEGORIES.includes(key) ? (key as JiraStatusCategory) : null,
  };
}

/** Jira's `fields.assignee` → display name, an id and an https avatar. null = unassigned. */
export function assigneeOf(raw: unknown): JiraIssueAssignee | null {
  const a = asRecord(raw);
  const name = typeof a?.displayName === 'string' ? a.displayName.trim() : '';
  if (a == null || name === '') return null;
  const id = [a.accountId, a.key, a.name].find((v): v is string => typeof v === 'string' && v !== '');
  const avatar = asRecord(a.avatarUrls)?.['48x48'];
  let avatarUrl: string | null = null;
  if (typeof avatar === 'string') {
    try {
      avatarUrl = new URL(avatar).protocol === 'https:' ? avatar : null;
    } catch {
      avatarUrl = null;
    }
  }
  return { name: name.slice(0, 200), accountId: id?.slice(0, 200) ?? null, avatarUrl };
}

/** A ticket key as detection emits it (`PROJ-123`). The route re-checks it against detection. */
export function isTicketKey(key: string): boolean {
  return /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(key);
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * One issue with EVERY field and the id→name and id→schema maps
 * (`?fields=*all&expand=names,schema`), so the acceptance-criteria candidates can be read off the
 * ticket itself — the field that holds them differs by site and by issue type (candidates.ts).
 */
export async function fetchJiraIssue(call: JiraCall, key: string): Promise<JiraIssueText> {
  if (!isTicketKey(key)) throw new JiraFetchError('not_found');
  const raw = await jiraGetJson(
    `${call.apiRoot}/rest/api/2/issue/${encodeURIComponent(key)}?fields=*all&expand=names,schema`,
    { authorization: jiraAuthHeader(call.credentials) },
    call.policy,
    call.transport,
  );
  const o = asRecord(raw) ?? {};
  const f = asRecord(o.fields) ?? {};
  const it = asRecord(f.issuetype);
  const issueType =
    it && typeof it.id === 'string' && typeof it.name === 'string'
      ? { id: it.id, name: it.name }
      : null;
  const { candidates, omitted } = extractAcCandidates(f, asRecord(o.names), asRecord(o.schema));
  return {
    key: typeof o.key === 'string' && isTicketKey(o.key) ? o.key : key,
    title: fieldValueToText(f.summary),
    // MARKDOWN: REST v2 answers wiki markup (a string), rewritten here; an ADF document is
    // already flattened to markdown-shaped text.
    description:
      typeof f.description === 'string'
        ? jiraWikiToMarkdown(fieldValueToText(f.description))
        : fieldValueToText(f.description),
    issueType,
    status: statusOf(f.status),
    assignee: assigneeOf(f.assignee),
    candidates,
    omittedCandidates: omitted,
  };
}

// (`fetchJiraIssueTitle` — a `?fields=summary` read for the Open PRs ticket row — is gone: since
// the stored tickets (plugin 0038, core `tracker_tickets` since apiVersion 23) that row reads what the worker wrote with `fetchJiraIssue`.)
