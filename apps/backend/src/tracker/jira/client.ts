import {
  isAutomationCommentName,
  isBlockingRelation,
  TICKET_COMMENTS_KEPT,
  TICKET_LINK_BLOCKERS_MAX,
  TICKET_LINK_RELATION_MAX,
  TICKET_LINK_TITLE_MAX,
  type JiraAcCandidate,
  type JiraFieldOption,
  type TicketLinkBlocker,
} from '@pierre-review/shared';
import { extractAcCandidates } from './candidates.js';
import { JiraFetchError, jiraGetJson, type JiraFetchPolicy, type JiraTransport } from './fetch.js';
import { fieldValueToText, jiraWikiToMarkdown } from './text.js';
import { ticketDateFields, trackerDate } from '../dates.js';
import type { FetchedTicketComment } from '../types.js';

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
  status: { name: string; category: JiraStatusCategory | null; id?: string | null } | null;
  assignee: JiraIssueAssignee | null;
  candidates: JiraAcCandidate[];
  omittedCandidates: number;
  // The "is blocked by" / "depends on" issuelinks (`blockedByOf`); undefined when the answer had no
  // `issuelinks` field at all.
  blockedBy?: TicketLinkBlocker[];
  // `created` / `resolutiondate` (../dates.ts: undefined = not in the answer, null = none).
  issueCreatedAt?: Date | null;
  issueResolvedAt?: Date | null;
  // The comments (`fields.comment`, or the comment list read when that was cut short); undefined when
  // neither answered (the stored comments stand).
  comments?: FetchedTicketComment[];
}

const STATUS_CATEGORIES: readonly string[] = ['new', 'indeterminate', 'done'];

/** Jira's `fields.status` → name + category key + Jira's status id (what a board's columns list). */
export function statusOf(raw: unknown): JiraIssueText['status'] {
  const s = asRecord(raw);
  const name = typeof s?.name === 'string' ? s.name.trim() : '';
  if (name === '') return null;
  const key = asRecord(s?.statusCategory)?.key;
  const id = typeof s?.id === 'string' && s.id.trim() !== '' ? s.id.trim().slice(0, 64) : typeof s?.id === 'number' ? String(s.id) : null;
  return {
    name: name.slice(0, 100),
    category:
      typeof key === 'string' && STATUS_CATEGORIES.includes(key) ? (key as JiraStatusCategory) : null,
    ...(id != null ? { id } : {}),
  };
}

/**
 * `fields.issuelinks` → the links THIS ticket waits on (docs/TRACKERS.md § Blocking links). A link
 * carries the OTHER issue on one side: `inwardIssue` present → the phrase from this ticket's side is
 * `type.inward` ("is blocked by"); `outwardIssue` present → `type.outward` ("depends on"). Kept iff
 * shared `isBlockingRelation(phrase)`. The linked issue's key, summary and status come in the SAME
 * answer (Jira inlines them), so this costs no extra call. undefined when the field is absent (not
 * in the answer — the stored value stands); [] when present and none block.
 */
export function blockedByOf(raw: unknown, apiRoot: string): TicketLinkBlocker[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TicketLinkBlocker[] = [];
  const seen = new Set<string>();
  for (const l of raw) {
    const o = asRecord(l);
    if (o == null) continue;
    const type = asRecord(o.type);
    const inward = asRecord(o.inwardIssue);
    const outward = asRecord(o.outwardIssue);
    const other = inward ?? outward;
    const phraseRaw = inward != null ? type?.inward : type?.outward;
    const phrase = typeof phraseRaw === 'string' ? phraseRaw.trim() : '';
    if (other == null || phrase === '' || !isBlockingRelation(phrase)) continue;
    const key = typeof other.key === 'string' ? other.key.trim() : '';
    if (!isTicketKey(key) || seen.has(key)) continue;
    seen.add(key);
    const f = asRecord(other.fields);
    const summary = typeof f?.summary === 'string' ? f.summary.trim() : '';
    const status = statusOf(f?.status);
    let url: string | null = null;
    try {
      const u = `${apiRoot.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`;
      url = new URL(u).protocol === 'https:' ? u : null;
    } catch {
      url = null;
    }
    out.push({
      key,
      title: summary !== '' ? summary.slice(0, TICKET_LINK_TITLE_MAX) : null,
      status: status?.name ?? null,
      category: status?.category ?? null,
      relation: phrase.slice(0, TICKET_LINK_RELATION_MAX),
      url,
    });
    if (out.length >= TICKET_LINK_BLOCKERS_MAX) break;
  }
  return out;
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

/** `{blockedBy}` when the answer carried `issuelinks`, else nothing (positive-answer rule). */
export function linksField(fields: Record<string, unknown>, apiRoot: string): { blockedBy?: TicketLinkBlocker[] } {
  const b = blockedByOf(fields.issuelinks, apiRoot);
  return b === undefined ? {} : { blockedBy: b };
}

/** A ticket key as detection emits it (`PROJ-123`). The route re-checks it against detection. */
export function isTicketKey(key: string): boolean {
  return /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(key);
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

// ---- comments ----

/**
 * One Jira comment → the provider-neutral comment, or null when it is unusable (no id or date). The
 * body is wiki markup on v2 (rewritten to markdown) or an ADF document (flattened). An AUTOMATION is
 * Jira Cloud's `accountType: 'app'` (Automation for Jira, every Connect / Forge app), or — on Server /
 * Data Center, which has no account type — an author whose name says so (shared
 * `isAutomationCommentName`).
 */
export function jiraCommentOf(raw: unknown): FetchedTicketComment | null {
  const c = asRecord(raw);
  if (c == null) return null;
  const id = typeof c.id === 'string' ? c.id.trim() : typeof c.id === 'number' ? String(c.id) : '';
  const createdAt = trackerDate(c, 'created');
  if (id === '' || createdAt == null) return null;
  const updated = trackerDate(c, 'updated');
  const a = asRecord(c.author);
  const name = typeof a?.displayName === 'string' ? a.displayName.trim() : '';
  const authorId = [a?.accountId, a?.key, a?.name].find((v): v is string => typeof v === 'string' && v !== '') ?? null;
  const isBot = a?.accountType === 'app' || isAutomationCommentName(name) || isAutomationCommentName(typeof a?.name === 'string' ? a.name : null);
  const body = typeof c.body === 'string' ? jiraWikiToMarkdown(fieldValueToText(c.body)) : fieldValueToText(c.body);
  return { id, authorName: name, authorId, isBot, body, createdAt, updatedAt: updated ?? null };
}

/**
 * A comment page (`fields.comment` or the `/comment` list): `{comments, total}`. `complete` = every
 * comment is in it (Jira may cut the field short on a long thread). undefined when not a page.
 */
export function jiraCommentPage(raw: unknown): { comments: FetchedTicketComment[]; total: number; complete: boolean } | undefined {
  const o = asRecord(raw);
  if (o == null || !Array.isArray(o.comments)) return undefined;
  const comments = o.comments.map(jiraCommentOf).filter((c): c is FetchedTicketComment => c != null);
  const total = typeof o.total === 'number' && Number.isFinite(o.total) ? o.total : o.comments.length;
  return { comments, total, complete: total <= o.comments.length };
}

/**
 * The ticket's comments: `fields.comment` from the issue read when it is whole (no extra call — `*all`
 * carries it on Cloud and Server alike). When Jira cut the field short on a long thread, ONE read of the
 * newest page (`/comment?startAt=<total-N>`). An answer with no comment field (a screen that hides it)
 * leaves the comments unknown, as does that extra read failing — undefined: never a failed ticket,
 * never a cleared list, and never a write of the OLDEST page (it would prune the newer stored ones).
 */
async function jiraComments(
  call: JiraCall,
  key: string,
  field: unknown,
): Promise<FetchedTicketComment[] | undefined> {
  const page = jiraCommentPage(field);
  if (page == null) return undefined;
  if (page.complete) return page.comments;
  try {
    const raw = await jiraGetJson(
      `${call.apiRoot}/rest/api/2/issue/${encodeURIComponent(key)}/comment?startAt=${Math.max(0, page.total - TICKET_COMMENTS_KEPT)}&maxResults=${TICKET_COMMENTS_KEPT}`,
      { authorization: jiraAuthHeader(call.credentials) },
      call.policy,
      call.transport,
    );
    return jiraCommentPage(raw)?.comments;
  } catch {
    return undefined;
  }
}

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
    ...linksField(f, call.apiRoot),
    ...(await commentsField(call, key, f)),
    // `*all` carries both; an unresolved ticket's `resolutiondate` is null.
    ...ticketDateFields({ issueCreatedAt: trackerDate(f, 'created'), issueResolvedAt: trackerDate(f, 'resolutiondate') }),
  };
}

async function commentsField(
  call: JiraCall,
  key: string,
  fields: Record<string, unknown>,
): Promise<{ comments?: FetchedTicketComment[] }> {
  const comments = await jiraComments(call, key, fields.comment);
  return comments === undefined ? {} : { comments };
}

// (`fetchJiraIssueTitle` — a `?fields=summary` read for the Open PRs ticket row — is gone: since
// the stored tickets (plugin 0038, core `tracker_tickets` since apiVersion 23) that row reads what the worker wrote with `fetchJiraIssue`.)
