import { createHash } from 'node:crypto';
import { linearSiteRoot } from '@pierre-review/shared';
import { acSourceFieldId, extractAcceptanceCriteria, type AcChild } from '../ac.js';
import { normalizePrefixKey } from '../detect.js';
import {
  JIRA_MAX_BYTES,
  JIRA_TIMEOUT_MS,
  JiraFetchError,
  checkJiraUrl,
  guardedLookup,
  nodeTransport,
  type RawResponse,
} from '../jira/fetch.js';
import type { FetchedTicket, TrackerCall } from '../types.js';

// LINEAR — THE CLIENT (docs/TRACKERS.md § Linear). Every Linear call goes through `linearGraphql`.
//
//   • ONE FIXED HOST: `https://api.linear.app/graphql`. Nothing the customer types is ever a host —
//     the workspace URL in Settings is an IDENTITY (the ticket root and the link base), never
//     fetched — so there is no customer-named host to guard. The call still rides the same transport
//     as Jira's (tracker/jira/fetch.ts): no redirects (a 3xx is an error; following one would forward
//     the key), a 10 s timeout, a 5 MiB cap, and in cloud https + the connect-time public-address
//     check, which costs nothing here.
//   • THE KEY is a Linear PERSONAL API KEY, sent as `Authorization: <key>` — Linear refuses an API
//     key sent as `Bearer …` (400). It is the workspace's sealed, write-only tracker token
//     (tracker/secret.ts); nothing here logs it, and errors carry a CODE, never Linear's body.
//   • RATE LIMITS ARE PRE-EMPTED, NEVER SURFACED. Linear meters per user: requests per hour and
//     complexity points per hour (2,500 and 3,000,000 for an API key, ≤ 10,000 points per query).
//     Each response's `x-ratelimit-*` headers feed a per-KEY budget held in memory; under the floor
//     the next call throws an HTTP 429 without calling. Linear's own `RATELIMITED` answer (HTTP 400
//     or 429) is the same 429. The worker turns a 429 into a 5-minute WORKSPACE backoff with no row
//     written, so the ticket is simply read on a later pass.
//
// Linear answers errors in the GraphQL `errors` array, often with HTTP 200: a refused key is
// `AUTHENTICATION_ERROR` (401), a missing issue "Entity not found" (`INPUT_ERROR`), a team the key
// cannot see `FORBIDDEN`.

export const LINEAR_API_URL = 'https://api.linear.app/graphql';

// ---- the per-key budget (in memory; a restart forgets it, which is harmless) ----

const REQUESTS_FLOOR = 25;
const COMPLEXITY_FLOOR = 25_000;
const budgets = new Map<string, { requests: number | null; complexity: number | null; resetAt: number }>();

const keyFp = (token: string): string => createHash('sha256').update(`linear\0${token}`).digest('hex').slice(0, 16);

function headerNum(h: Record<string, string> | undefined, name: string): number | null {
  const v = h?.[name];
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function noteLinearBudget(token: string, h: Record<string, string> | undefined, now: number): void {
  if (h == null) return;
  const requests = headerNum(h, 'x-ratelimit-requests-remaining');
  const complexity = headerNum(h, 'x-ratelimit-complexity-remaining');
  if (requests == null && complexity == null) return;
  // Linear's resets are epoch MILLISECONDS; anything unreadable is "within the hour".
  const reset = Math.max(
    headerNum(h, 'x-ratelimit-requests-reset') ?? 0,
    headerNum(h, 'x-ratelimit-complexity-reset') ?? 0,
  );
  budgets.set(keyFp(token), { requests, complexity, resetAt: reset > now ? reset : now + 60 * 60_000 });
}

function noteLinearLimited(token: string, now: number): void {
  budgets.set(keyFp(token), { requests: 0, complexity: 0, resetAt: now + 5 * 60_000 });
}

/** True while the key's remaining Linear budget is under the floor (until Linear's reset). */
export function isLinearBudgetLow(token: string, now: number = Date.now()): boolean {
  const b = budgets.get(keyFp(token));
  if (b == null || b.resetAt <= now) return false;
  return (b.requests != null && b.requests < REQUESTS_FLOOR) || (b.complexity != null && b.complexity < COMPLEXITY_FLOOR);
}

/** Test seam. */
export function __resetLinearBudget(): void {
  budgets.clear();
}

// ---- one call ----

export interface LinearGqlError {
  message?: string;
  path?: unknown[];
  extensions?: { code?: string; type?: string; statusCode?: number };
}

const codesOf = (errors: readonly LinearGqlError[]): string[] =>
  errors.map((e) => String(e?.extensions?.code ?? '').toUpperCase());

function parseBody(res: RawResponse): { data?: unknown; errors?: unknown } | null {
  if (!/\bjson\b/i.test(res.contentType)) return null;
  try {
    const v = JSON.parse(res.body) as unknown;
    return typeof v === 'object' && v !== null ? (v as { data?: unknown; errors?: unknown }) : null;
  } catch {
    return null;
  }
}

/**
 * POST one GraphQL query to Linear with the workspace's key. Returns the data (possibly partial) and
 * Linear's errors; throws `JiraFetchError` (the tracker's transport-generic codes) for a refused
 * key (`unauthorized`), a rate limit (`http` 429), a redirect, a timeout and every other transport
 * failure.
 */
export async function linearGraphql<T>(
  call: TrackerCall,
  query: string,
  variables: Record<string, unknown>,
  now: () => number = Date.now,
): Promise<{ data: T | null; errors: LinearGqlError[] }> {
  const token = call.credentials.token;
  if (token === '') throw new JiraFetchError('unauthorized');
  if (isLinearBudgetLow(token, now())) throw new JiraFetchError('http', 429);
  const url = checkJiraUrl(LINEAR_API_URL, call.policy);
  const transport = call.transport ?? nodeTransport;
  const res = await transport(
    url,
    {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'Limn',
      // ⚠ NO "Bearer": Linear refuses a personal API key sent as a bearer token.
      authorization: token,
    },
    { lookup: call.policy.cloud ? guardedLookup() : undefined, timeoutMs: JIRA_TIMEOUT_MS, maxBytes: JIRA_MAX_BYTES },
    { method: 'POST', body: JSON.stringify({ query, variables }) },
  );
  noteLinearBudget(token, res.headers, now());
  if (res.status >= 300 && res.status < 400) throw new JiraFetchError('redirect', res.status);
  const body = parseBody(res);
  const errors = Array.isArray(body?.errors) ? (body!.errors as LinearGqlError[]) : [];
  const codes = codesOf(errors);
  if (res.status === 429 || codes.includes('RATELIMITED')) {
    noteLinearLimited(token, now());
    throw new JiraFetchError('http', 429);
  }
  if (res.status === 401 || codes.includes('AUTHENTICATION_ERROR')) throw new JiraFetchError('unauthorized', 401);
  if (res.status === 403) throw new JiraFetchError('forbidden', 403);
  if (body == null) {
    if (res.status < 200 || res.status >= 300) throw new JiraFetchError('http', res.status);
    throw new JiraFetchError('not_json', res.status);
  }
  if (res.status < 200 || res.status >= 300) {
    // A 400 that is about the request's OBJECT (an entity not found) still answers like a 200.
    if (!errors.some(isNotFound)) throw new JiraFetchError('http', res.status);
  }
  return { data: (body.data ?? null) as T | null, errors };
}

function isNotFound(e: LinearGqlError): boolean {
  return /not found/i.test(String(e?.message ?? '')) || String(e?.extensions?.code ?? '').toUpperCase() === 'NOT_FOUND';
}

// ---- the reader: one issue ----

export const LINEAR_CHILD_CAP = 50;

// Complexity ≈ 120 points (50 children × their two small objects), far under Linear's 10,000.
export const LINEAR_ISSUE_QUERY = /* GraphQL */ `
  query LimnLinearIssue($id: String!) {
    issue(id: $id) {
      identifier
      title
      description
      url
      state { name type }
      assignee { id name displayName avatarUrl }
      project { name }
      children(first: ${LINEAR_CHILD_CAP}) {
        nodes { identifier title state { type } }
        pageInfo { hasNextPage }
      }
    }
  }
`;

interface GqlIssue {
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  state?: { name?: string | null; type?: string | null } | null;
  assignee?: { id?: string | null; name?: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
  project?: { name?: string | null } | null;
  children?: {
    nodes?: Array<{ identifier?: string | null; title?: string | null; state?: { type?: string | null } | null } | null> | null;
    pageInfo?: { hasNextPage?: boolean | null } | null;
  } | null;
}

/** Linear's workflow-state TYPE → the stored status category. */
export function linearStatus(state: GqlIssue['state']): FetchedTicket['status'] {
  const name = (state?.name ?? '').trim();
  const type = (state?.type ?? '').toLowerCase();
  if (name === '' && type === '') return null;
  const category =
    type === 'completed' || type === 'canceled'
      ? 'done'
      : type === 'started'
        ? 'indeterminate'
        : type === 'backlog' || type === 'unstarted' || type === 'triage'
          ? 'new'
          : null;
  return { name: name !== '' ? name : type, category };
}

const httpsOnly = (u: string | null | undefined): string | null => (u != null && /^https:\/\//i.test(u) ? u : null);

/** One issue's GraphQL node → the provider-neutral ticket the worker stores. */
export function toLinearTicket(key: string, issue: GqlIssue): FetchedTicket {
  // A CANCELED child is no longer part of the work, so it is not a criterion; a COMPLETED one is ticked.
  const children: AcChild[] = [];
  for (const n of issue.children?.nodes ?? []) {
    const ref = normalizePrefixKey(n?.identifier ?? '');
    const title = (n?.title ?? '').trim();
    const type = (n?.state?.type ?? '').toLowerCase();
    if (ref == null || title === '' || type === 'canceled') continue;
    children.push({ ref, title, done: type === 'completed' });
  }
  const more = issue.children?.pageInfo?.hasNextPage === true;
  const ac = extractAcceptanceCriteria(issue.description, children, more ? null : children.length);
  // The project is context for whoever reads the story (the ticket review): one line, after the
  // description. ⚠ The CYCLE is deliberately NOT read: it moves every few weeks for carried-over
  // work, and a story-text change re-bills the ticket review (store.ts `storyOrMembershipMoved`),
  // exactly like a status change would.
  const project = (issue.project?.name ?? '').trim();
  const description = project !== '' ? `${ac.description}${ac.description !== '' ? '\n\n' : ''}Linear project: ${project}` : ac.description;
  const who = issue.assignee;
  const whoName = (who?.displayName ?? '').trim() || (who?.name ?? '').trim();
  return {
    key,
    title: (issue.title ?? '').trim(),
    description,
    // Linear has no issue types.
    issueType: null,
    status: linearStatus(issue.state),
    assignee: whoName !== '' ? { name: whoName, accountId: who?.id ?? null, avatarUrl: httpsOnly(who?.avatarUrl) } : null,
    candidates:
      ac.criteria != null
        ? [{ id: acSourceFieldId('linear', ac.criteria.source), name: ac.criteria.name, text: ac.criteria.text, match: 'strong' }]
        : [],
    omittedCandidates: 0,
    url: httpsOnly(issue.url),
  };
}

/** Read ONE issue (`ENG-123`). Throws `JiraFetchError`. */
export async function fetchLinearIssue(call: TrackerCall, key: string): Promise<FetchedTicket> {
  const id = normalizePrefixKey(key);
  if (id == null) throw new JiraFetchError('not_found');
  const { data, errors } = await linearGraphql<{ issue: GqlIssue | null }>(call, LINEAR_ISSUE_QUERY, { id });
  const issue = data?.issue ?? null;
  if (issue == null) {
    if (codesOf(errors).includes('FORBIDDEN')) throw new JiraFetchError('no_access');
    if (errors.length === 0 || errors.some(isNotFound)) throw new JiraFetchError('not_found');
    throw new JiraFetchError('http');
  }
  // ⚠ THE KEY MUST BELONG TO THE WORKSPACE IN SETTINGS. A ticket is keyed on that workspace's root;
  // an issue from another Linear workspace stored under it would be a different ticket wearing this
  // one's ident. A key for another workspace is a SETTINGS problem (workspace-wide, backed off).
  const root = linearSiteRoot(issue.url);
  if (root == null || root !== call.apiRoot) throw new JiraFetchError('bad_url');
  return toLinearTicket(id, issue);
}

// ---- the connection check ----

export const LINEAR_VIEWER_QUERY = /* GraphQL */ `
  query LimnLinearViewer {
    viewer { name displayName }
    organization { name urlKey }
  }
`;

export async function fetchLinearViewer(
  call: TrackerCall,
): Promise<{ viewerName: string; organizationName: string; organizationUrl: string }> {
  const { data } = await linearGraphql<{
    viewer?: { name?: string | null; displayName?: string | null } | null;
    organization?: { name?: string | null; urlKey?: string | null } | null;
  }>(call, LINEAR_VIEWER_QUERY, {});
  const urlKey = (data?.organization?.urlKey ?? '').trim();
  const organizationUrl = linearSiteRoot(`https://linear.app/${urlKey}`);
  if (data?.viewer == null || organizationUrl == null) throw new JiraFetchError('http');
  return {
    viewerName: (data.viewer.displayName ?? '').trim() || (data.viewer.name ?? '').trim(),
    organizationName: (data.organization?.name ?? '').trim() || urlKey,
    organizationUrl,
  };
}

/** A plain-English sentence for a failure. Never anything Linear sent back. */
export function linearErrorMessage(err: unknown): string {
  const code = err instanceof JiraFetchError ? err.code : 'network';
  switch (code) {
    case 'not_found':
      return "Can't read this issue. It does not exist in this Linear workspace, or the saved key can't see it.";
    case 'no_access':
      return "Can't read this issue. The saved Linear key does not have access to its team.";
    case 'unauthorized':
      return 'Linear rejected this key. Save a new personal API key in Settings.';
    case 'forbidden':
      return 'Linear refused the saved key.';
    case 'bad_url':
      return 'The saved Linear key belongs to a different Linear workspace than the URL in Settings.';
    case 'redirect':
      return 'Linear answered with a redirect, which Limn does not follow.';
    case 'timeout':
      return 'Linear took too long to answer.';
    case 'not_json':
    case 'too_large':
      return 'Linear sent an answer Limn could not read.';
    case 'http':
      return err instanceof JiraFetchError && err.status === 429
        ? 'Linear’s rate limit is used up for now. Limn will read this ticket later.'
        : 'Linear answered with an error.';
    default:
      return 'Could not reach Linear.';
  }
}
