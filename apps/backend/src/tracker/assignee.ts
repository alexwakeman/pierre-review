import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  TICKET_ASSIGNEE_ID_MAX,
  TRACKER_PROVIDER_LABEL,
  canAssignTickets,
  isTrackerIdent,
  parseGithubIssueKey,
  parseTicketIdent,
  trackerTicketIdent,
  trackerTicketRow,
  type TicketAssignBody,
  type TicketAssignResponse,
  type TicketAssignable,
  type TicketAssignablesResponse,
  type TrackerProvider,
} from '@pierre-review/shared';
import { githubAccessFor, resolveRequestWorkspaceId, type TrackerContext } from './context.js';
import { maybeAdapterFor } from './registry.js';
import { readWorkspaceTrackerAccess } from './settings.js';
import { prepareTrackerCall } from './calls.js';
import type { TrackerCall } from './types.js';
import { assigneeOf, jiraAuthHeader } from './jira/client.js';
import { JiraFetchError, jiraGetJson, jiraPutJson, type JiraTransport } from './jira/fetch.js';
import { githubGraphql } from './github/reader.js';
import { linearGraphql } from './linear/client.js';

// ── A TRACKER WRITE — the ASSIGNEE the reader picks (docs/TRACKERS.md § The assignee change). CORE
// and FREE: Jira, GitHub Issues and Linear. Notion is read-only in Limn, so its tickets have no picker.
//
//   GET  /api/ticket-assignees?workspace=<id>&ident=…  the people the tracker lets this ticket be
//        assigned to. Made when the story view's picker OPENS, never on mount; kept in memory per
//        (account, workspace, site, project / repository / team) for ASSIGNABLES_TTL_MS, so reopening
//        the picker costs nothing.
//   POST /api/ticket-assignee?workspace=<id>  { ident, assigneeId }  assigns the ticket to one of
//        those people (null = nobody), then SETTLES: the assignee the tracker reports is written to
//        every stored row of the ticket (`tracker_tickets` on that site, `sprint_tickets`,
//        `sprint_ref_tickets` — this account only).
//
// ⚠ STILL NOT A TRACKER PROXY: the ident must name THIS workspace's tracker site, Limn must already
// hold a row for the ticket in this account, and the person must be on the tracker's own list.
// Anything else is refused BEFORE the tracker is called.
// ⚠ Every failure answers a sentence Limn wrote, never the tracker's body; the log carries the CODE.
// ⚠ Nothing here runs on its own: no worker, no automation, no retry. Only the reader's pick writes.

export const ASSIGNABLES_TTL_MS = 10 * 60_000;
/** The most people one list holds (a payload guard; the picker filters by typing). */
export const ASSIGNABLES_MAX = 500;
const ASSIGNABLES_CACHE_MAX = 200;
const JIRA_PAGE = 100;
const GQL_PAGE = 100;
const GQL_PAGES_MAX = 5;

const MSG_NOT_HELD = 'Limn holds no such ticket in this workspace.';
const MSG_CANNOT_ASSIGN = 'Assigning a ticket works with Jira, GitHub Issues and Linear.';
const MSG_NOTION = 'Limn does not change Notion pages, so it cannot assign this ticket.';
const MSG_UNKNOWN_PERSON = 'That person cannot be assigned this ticket.';

const ASSIGNEE_ID_RE = new RegExp(`^[^\\u0000-\\u001f\\u007f]{1,${TICKET_ASSIGNEE_ID_MAX}}$`);

type AssignProvider = 'jira' | 'github' | 'linear';
type Settled = { name: string; avatarUrl: string | null; accountId: string | null } | null;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
function httpsOnly(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

// ---- the list cache ----

interface CachedList {
  users: TicketAssignable[];
  truncated: boolean;
  at: number;
}
const cache = new Map<string, CachedList>();
let now: () => number = Date.now;

/** Tests: a fake clock, and an empty cache. */
export function __resetAssignablesCache(clock?: () => number): void {
  cache.clear();
  now = clock ?? Date.now;
}

function cacheGet(key: string): CachedList | null {
  const hit = cache.get(key);
  if (hit == null) return null;
  if (now() - hit.at >= ASSIGNABLES_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function cachePut(key: string, value: Omit<CachedList, 'at'>): void {
  cache.delete(key);
  cache.set(key, { ...value, at: now() });
  while (cache.size > ASSIGNABLES_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

/** What one list is shared by: a Jira project, a GitHub repository, a Linear team. */
export function assignScope(provider: AssignProvider, key: string): string {
  if (provider === 'github') {
    const p = parseGithubIssueKey(key);
    return p != null ? `${p.owner}/${p.repo}`.toLowerCase() : key;
  }
  return key.split('-')[0] ?? key;
}

function byName(a: TicketAssignable, b: TicketAssignable): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

// ---- Jira ----

const isJiraCloud = (apiRoot: string): boolean => {
  try {
    return /\.(atlassian\.net|jira\.com|jira-dev\.com)$/i.test(new URL(apiRoot).hostname);
  } catch {
    return false;
  }
};
const jiraAuth = (call: TrackerCall): Record<string, string> => ({ authorization: jiraAuthHeader(call.credentials) });
const jiraIssueUrl = (call: TrackerCall, key: string): string => `${call.apiRoot}/rest/api/2/issue/${encodeURIComponent(key)}`;

/** One Jira user → a choice. Cloud names a person by `accountId`, Server / Data Center by `name`. */
export function toJiraAssignable(raw: unknown): TicketAssignable | null {
  const u = asRecord(raw);
  if (u == null || u.active === false) return null;
  // An app account (Automation for Jira, a Connect app) is not a person to give work to.
  if (u.accountType === 'app') return null;
  const name = str(u.displayName);
  if (name === '') return null;
  const accountId = str(u.accountId);
  const login = str(u.name);
  const id = accountId !== '' ? `acc:${accountId}` : login !== '' ? `name:${login}` : '';
  if (id === '' || !ASSIGNEE_ID_RE.test(id)) return null;
  const email = str(u.emailAddress);
  return {
    id,
    name: name.slice(0, 200),
    detail: email !== '' ? email.slice(0, 200) : null,
    avatarUrl: httpsOnly(asRecord(u.avatarUrls)?.['48x48']),
  };
}

async function jiraAssignables(call: TrackerCall, key: string): Promise<{ users: TicketAssignable[]; truncated: boolean }> {
  const project = assignScope('jira', key);
  // Server / Data Center searches by `username`; an empty one matches everybody. Cloud has no such
  // parameter.
  const extra = isJiraCloud(call.apiRoot) ? '' : '&username=';
  const users: TicketAssignable[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (let startAt = 0; ; startAt += JIRA_PAGE) {
    const raw = await jiraGetJson(
      `${call.apiRoot}/rest/api/2/user/assignable/search?project=${encodeURIComponent(project)}${extra}&startAt=${startAt}&maxResults=${JIRA_PAGE}`,
      jiraAuth(call),
      call.policy,
      call.transport,
    );
    // Cloud may answer FEWER than maxResults while more exist, so only an empty page ends the list.
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const r of raw) {
      const u = toJiraAssignable(r);
      if (u == null || seen.has(u.id)) continue;
      seen.add(u.id);
      users.push(u);
    }
    if (users.length >= ASSIGNABLES_MAX || startAt + JIRA_PAGE >= ASSIGNABLES_MAX) {
      truncated = raw.length >= JIRA_PAGE || users.length > ASSIGNABLES_MAX;
      break;
    }
  }
  return { users: users.slice(0, ASSIGNABLES_MAX), truncated };
}

/** The PUT body for a Jira assignee: Cloud by account id, Server by user name; null = nobody. */
export function jiraAssigneeBody(apiRoot: string, assigneeId: string | null): Record<string, string | null> {
  if (assigneeId == null) return isJiraCloud(apiRoot) ? { accountId: null } : { name: null };
  if (assigneeId.startsWith('acc:')) return { accountId: assigneeId.slice(4) };
  return { name: assigneeId.slice(5) };
}

async function jiraAssign(call: TrackerCall, key: string, assigneeId: string | null): Promise<Settled | undefined> {
  await jiraPutJson(`${jiraIssueUrl(call, key)}/assignee`, jiraAuth(call), jiraAssigneeBody(call.apiRoot, assigneeId), call.policy, call.transport);
  // SETTLE: read back the assignee Jira now holds. A failed re-read is `undefined` (not known).
  try {
    const raw = await jiraGetJson(`${jiraIssueUrl(call, key)}?fields=assignee`, jiraAuth(call), call.policy, call.transport);
    const a = assigneeOf(asRecord(asRecord(raw)?.fields)?.assignee);
    return a == null ? null : { name: a.name, avatarUrl: a.avatarUrl, accountId: a.accountId };
  } catch {
    return undefined;
  }
}

// ---- GitHub Issues ----

const GITHUB_ASSIGNABLES_QUERY = /* GraphQL */ `
  query LimnAssignableUsers($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      assignableUsers(first: ${GQL_PAGE}, after: $after) {
        nodes { id login name avatarUrl }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const GITHUB_ISSUE_ASSIGNEES_QUERY = /* GraphQL */ `
  query LimnIssueAssignees($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) { id assignees(first: 20) { nodes { id } } }
    }
  }
`;

interface GqlPage<N> {
  nodes?: Array<N | null> | null;
  pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
}
type GithubUserNode = { id?: string | null; login?: string | null; name?: string | null; avatarUrl?: string | null };

function errorTypes(errors: unknown): string[] {
  return Array.isArray(errors) ? errors.map((e) => String((e as { type?: unknown })?.type ?? '')) : [];
}

function githubCall(call: TrackerCall): NonNullable<TrackerCall['github']> {
  if (call.github == null) throw new JiraFetchError('unauthorized');
  return call.github;
}

export function toGithubAssignable(n: GithubUserNode | null | undefined): TicketAssignable | null {
  const id = str(n?.id);
  const login = str(n?.login);
  if (id === '' || login === '' || !ASSIGNEE_ID_RE.test(id)) return null;
  const full = str(n?.name);
  return { id, name: login, detail: full !== '' && full !== login ? full.slice(0, 200) : null, avatarUrl: httpsOnly(n?.avatarUrl) };
}

async function githubAssignables(call: TrackerCall, key: string): Promise<{ users: TicketAssignable[]; truncated: boolean }> {
  const gh = githubCall(call);
  const p = parseGithubIssueKey(key);
  if (p == null) throw new JiraFetchError('not_found');
  const users: TicketAssignable[] = [];
  let after: string | null = null;
  let truncated = false;
  for (let page = 0; page < GQL_PAGES_MAX; page++) {
    const res: { data: { repository?: { assignableUsers?: GqlPage<GithubUserNode> | null } | null } | null; errors: unknown } = await githubGraphql(
      gh,
      GITHUB_ASSIGNABLES_QUERY,
      { owner: p.owner, name: p.repo, after },
    );
    const list: GqlPage<GithubUserNode> | null | undefined = res.data?.repository?.assignableUsers;
    if (list == null) {
      if (errorTypes(res.errors).includes('FORBIDDEN')) throw new JiraFetchError('forbidden', 403);
      throw new JiraFetchError('not_found');
    }
    for (const n of list.nodes ?? []) {
      const u = toGithubAssignable(n);
      if (u != null) users.push(u);
    }
    const next: string | null = list.pageInfo?.hasNextPage === true ? (list.pageInfo.endCursor ?? null) : null;
    if (next == null) break;
    if (page === GQL_PAGES_MAX - 1 || users.length >= ASSIGNABLES_MAX) {
      truncated = true;
      break;
    }
    after = next;
  }
  return { users: users.slice(0, ASSIGNABLES_MAX), truncated };
}

/** The ONE mutation that makes `add` the issue's only assignee (or nobody): remove the others, add. */
export function githubAssignMutation(remove: readonly string[], add: string | null): string | null {
  const parts: string[] = [];
  if (remove.length > 0) {
    parts.push('r: removeAssigneesFromAssignable(input: { assignableId: $id, assigneeIds: $remove }) { clientMutationId }');
  }
  if (add != null) {
    parts.push(
      'a: addAssigneesToAssignable(input: { assignableId: $id, assigneeIds: $add }) { assignable { ... on Issue { assignees(first: 1) { nodes { login avatarUrl } } } } }',
    );
  }
  if (parts.length === 0) return null;
  const vars = ['$id: ID!', ...(remove.length > 0 ? ['$remove: [ID!]!'] : []), ...(add != null ? ['$add: [ID!]!'] : [])];
  return `mutation LimnAssignIssue(${vars.join(', ')}) { ${parts.join(' ')} }`;
}

async function githubAssign(call: TrackerCall, key: string, assigneeId: string | null, picked: TicketAssignable | null): Promise<Settled | undefined> {
  const gh = githubCall(call);
  const p = parseGithubIssueKey(key);
  if (p == null) throw new JiraFetchError('not_found');
  const { data, errors } = await githubGraphql<{
    repository?: { issue?: { id?: string | null; assignees?: GqlPage<{ id?: string | null }> | null } | null } | null;
  }>(gh, GITHUB_ISSUE_ASSIGNEES_QUERY, { owner: p.owner, name: p.repo, number: p.number });
  const issue = data?.repository?.issue;
  const issueId = str(issue?.id);
  if (issue == null || issueId === '') {
    if (errorTypes(errors).includes('FORBIDDEN')) throw new JiraFetchError('forbidden', 403);
    throw new JiraFetchError('not_found');
  }
  const current = (issue.assignees?.nodes ?? []).map((n) => str(n?.id)).filter((id) => id !== '');
  // Picking one person makes them the ONLY assignee (Limn shows one); already alone = nothing to do.
  const remove = current.filter((id) => id !== assigneeId);
  const add = assigneeId != null && !current.includes(assigneeId) ? assigneeId : null;
  const mutation = githubAssignMutation(remove, add);
  if (mutation == null) return picked == null ? null : { name: picked.name, avatarUrl: picked.avatarUrl, accountId: picked.name };
  const res = await githubGraphql<{
    a?: { assignable?: { assignees?: GqlPage<{ login?: string | null; avatarUrl?: string | null }> | null } | null } | null;
  }>(gh, mutation, { id: issueId, ...(remove.length > 0 ? { remove } : {}), ...(add != null ? { add: [add] } : {}) });
  if (res.data == null || (Array.isArray(res.errors) && res.errors.length > 0)) {
    if (errorTypes(res.errors).includes('FORBIDDEN')) throw new JiraFetchError('forbidden', 403);
    throw new JiraFetchError('http', 400);
  }
  if (assigneeId == null) return null;
  const who = (res.data.a?.assignable?.assignees?.nodes ?? []).find((n) => n != null);
  const login = str(who?.login);
  if (login !== '') return { name: login, avatarUrl: httpsOnly(who?.avatarUrl), accountId: login };
  return picked == null ? undefined : { name: picked.name, avatarUrl: picked.avatarUrl, accountId: picked.name };
}

// ---- Linear ----

const LINEAR_MEMBERS_QUERY = /* GraphQL */ `
  query LimnTeamMembers($id: String!, $after: String) {
    issue(id: $id) {
      team {
        members(first: ${GQL_PAGE}, after: $after) {
          nodes { id name displayName avatarUrl active }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const LINEAR_ASSIGN_MUTATION = /* GraphQL */ `
  mutation LimnAssignIssue($id: String!, $assigneeId: String) {
    issueUpdate(id: $id, input: { assigneeId: $assigneeId }) {
      success
      issue { assignee { id name displayName avatarUrl } }
    }
  }
`;

type LinearUserNode = { id?: string | null; name?: string | null; displayName?: string | null; avatarUrl?: string | null; active?: boolean | null };

/** The name Limn stores for a Linear person: the display name, else the full name (the reader's rule). */
const linearName = (n: LinearUserNode | null | undefined): string => str(n?.displayName) || str(n?.name);

export function toLinearAssignable(n: LinearUserNode | null | undefined): TicketAssignable | null {
  if (n == null || n.active === false) return null;
  const id = str(n.id);
  const name = linearName(n);
  if (id === '' || name === '' || !ASSIGNEE_ID_RE.test(id)) return null;
  const full = str(n.name);
  return { id, name: name.slice(0, 200), detail: full !== '' && full !== name ? full.slice(0, 200) : null, avatarUrl: httpsOnly(n.avatarUrl) };
}

type LinearErrors = Array<{ message?: unknown; extensions?: { code?: unknown } }>;
const linearRefused = (errors: LinearErrors): boolean =>
  errors.some((e) => /forbidden|permission/i.test(`${String(e?.extensions?.code ?? '')} ${String(e?.message ?? '')}`));

async function linearAssignables(call: TrackerCall, key: string): Promise<{ users: TicketAssignable[]; truncated: boolean }> {
  const users: TicketAssignable[] = [];
  let after: string | null = null;
  let truncated = false;
  for (let page = 0; page < GQL_PAGES_MAX; page++) {
    const res: { data: { issue?: { team?: { members?: GqlPage<LinearUserNode> | null } | null } | null } | null; errors: LinearErrors } = await linearGraphql(
      call,
      LINEAR_MEMBERS_QUERY,
      { id: key, after },
    );
    const list: GqlPage<LinearUserNode> | null | undefined = res.data?.issue?.team?.members;
    if (list == null) {
      if (linearRefused(res.errors)) throw new JiraFetchError('forbidden', 403);
      throw new JiraFetchError('not_found');
    }
    for (const n of list.nodes ?? []) {
      const u = toLinearAssignable(n);
      if (u != null) users.push(u);
    }
    const next: string | null = list.pageInfo?.hasNextPage === true ? (list.pageInfo.endCursor ?? null) : null;
    if (next == null) break;
    if (page === GQL_PAGES_MAX - 1 || users.length >= ASSIGNABLES_MAX) {
      truncated = true;
      break;
    }
    after = next;
  }
  return { users: users.slice(0, ASSIGNABLES_MAX), truncated };
}

async function linearAssign(call: TrackerCall, key: string, assigneeId: string | null): Promise<Settled | undefined> {
  const { data, errors } = await linearGraphql<{
    issueUpdate?: { success?: boolean | null; issue?: { assignee?: LinearUserNode | null } | null } | null;
  }>(call, LINEAR_ASSIGN_MUTATION, { id: key, assigneeId });
  const upd = data?.issueUpdate;
  if (upd?.success !== true) {
    if (linearRefused(errors)) throw new JiraFetchError('forbidden', 403);
    throw new JiraFetchError('http', 400);
  }
  if (upd.issue == null) return undefined;
  const who = upd.issue.assignee;
  const name = linearName(who);
  return name === '' ? null : { name: name.slice(0, 200), avatarUrl: httpsOnly(who?.avatarUrl), accountId: str(who?.id) || null };
}

// ---- the provider switch ----

async function listAssignables(provider: AssignProvider, call: TrackerCall, key: string) {
  if (provider === 'jira') return jiraAssignables(call, key);
  if (provider === 'github') return githubAssignables(call, key);
  return linearAssignables(call, key);
}

async function assign(provider: AssignProvider, call: TrackerCall, key: string, assigneeId: string | null, picked: TicketAssignable | null) {
  if (provider === 'jira') return jiraAssign(call, key, assigneeId);
  if (provider === 'github') return githubAssign(call, key, assigneeId, picked);
  return linearAssign(call, key, assigneeId);
}

/** The sentence for a failed assignee call: refused access and a refused change get our own words. */
export function assignErrorMessage(provider: AssignProvider, err: unknown): string {
  const label = TRACKER_PROVIDER_LABEL[provider];
  if (err instanceof JiraFetchError) {
    if (err.code === 'forbidden' || err.code === 'no_access') {
      return provider === 'jira'
        ? 'Your Jira token cannot assign this issue.'
        : provider === 'github'
          ? 'Your GitHub account cannot assign this issue.'
          : 'The saved Linear key cannot assign this issue.';
    }
    if (err.code === 'http' && err.status === 400) return `${label} refused this change.`;
  }
  return maybeAdapterFor(provider)?.reader?.errorMessage(err) ?? `${label} answered with an error.`;
}

// ---- the gate ----

type Gate =
  | { ok: false; status: number; error: string; message: string }
  | { ok: true; provider: AssignProvider; call: TrackerCall; key: string; apiRoot: string; ident: string; cacheKey: string };

/**
 * ⚠ THE NOT-A-PROXY GATE: the workspace's tracker can assign and is usable, the ident names its
 * site, and Limn already holds a row for the ticket in this account.
 */
export async function assignGate(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  rawIdent: string,
  transport: JiraTransport | undefined,
): Promise<Gate> {
  const access = await readWorkspaceTrackerAccess(ctx, accountId, workspaceId);
  const provider = access.issue.provider;
  if (!canAssignTickets(provider)) {
    return { ok: false, status: 400, error: 'CannotAssign', message: provider === 'notion' ? MSG_NOTION : MSG_CANNOT_ASSIGN };
  }
  const p = provider as AssignProvider;
  const notHeld = { ok: false as const, status: 404, error: 'TicketNotFound', message: MSG_NOT_HELD };
  const parsed = parseTicketIdent(rawIdent);
  if (!isTrackerIdent(parsed)) return notHeld;
  const row = trackerTicketRow(parsed);
  const adapter = maybeAdapterFor(p);
  const siteRoot = adapter?.siteRoot(access.issue.baseUrl) ?? null;
  if (adapter == null || row.provider !== p || siteRoot == null || row.apiRoot !== siteRoot || !adapter.isKey(row.issueKey)) return notHeld;
  const ident = trackerTicketIdent(p, row.apiRoot, row.issueKey);
  if (!(await holdsTicket(ctx, accountId, workspaceId, p, row.apiRoot, row.issueKey, ident))) return notHeld;
  const prepared = prepareTrackerCall(access, { transport, github: githubAccessFor(ctx, accountId) });
  if (!prepared.ok) return { ok: false, status: prepared.status, error: prepared.error, message: prepared.message };
  return {
    ok: true,
    provider: p,
    call: prepared.call,
    key: row.issueKey,
    apiRoot: row.apiRoot,
    ident,
    cacheKey: `${accountId}|${workspaceId}|${p}|${row.apiRoot}|${assignScope(p, row.issueKey)}`,
  };
}

async function holdsTicket(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  provider: TrackerProvider,
  apiRoot: string,
  key: string,
  ident: string,
): Promise<boolean> {
  const t = ctx.schema.trackerTickets;
  const pr = (await ctx.db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.provider, provider), eq(t.apiRoot, apiRoot), eq(t.issueKey, key)))
    .limit(1)
    .execute()) as unknown[];
  if (pr.length > 0) return true;
  for (const table of [ctx.schema.sprintTickets, ctx.schema.sprintRefTickets]) {
    if (table == null) continue;
    const rows = (await ctx.db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.accountId, accountId), eq(table.workspaceId, workspaceId), eq(table.ident, ident)))
      .limit(1)
      .execute()) as unknown[];
    if (rows.length > 0) return true;
  }
  return false;
}

// ---- the settle ----

/**
 * Write the assignee the tracker reported to every stored row of the ticket in this account. Only the
 * assignee columns move: an assignee is not story text (`changed_at` stays).
 */
export async function writeTicketAssignee(
  ctx: TrackerContext,
  accountId: number,
  provider: TrackerProvider,
  apiRoot: string,
  key: string,
  ident: string,
  who: Settled,
): Promise<void> {
  const set = { assigneeName: who?.name ?? null, assigneeAvatarUrl: who?.avatarUrl ?? null };
  const t = ctx.schema.trackerTickets;
  await ctx.db
    .update(t)
    .set({ ...set, assigneeAccountId: who?.accountId ?? null })
    .where(and(eq(t.accountId, accountId), eq(t.provider, provider), eq(t.apiRoot, apiRoot), eq(t.issueKey, key)))
    .execute();
  for (const table of [ctx.schema.sprintTickets, ctx.schema.sprintRefTickets]) {
    if (table == null) continue;
    await ctx.db.update(table).set(set).where(and(eq(table.accountId, accountId), eq(table.ident, ident))).execute();
  }
}

async function markDue(ctx: TrackerContext, accountId: number, provider: TrackerProvider, apiRoot: string, key: string): Promise<void> {
  const t = ctx.schema.trackerTickets;
  await ctx.db
    .update(t)
    .set({ nextCheckAt: new Date(0) })
    .where(and(eq(t.accountId, accountId), eq(t.provider, provider), eq(t.apiRoot, apiRoot), eq(t.issueKey, key)))
    .execute();
}

// ---- the routes ----

async function assignablesFor(gate: Extract<Gate, { ok: true }>): Promise<CachedList> {
  const hit = cacheGet(gate.cacheKey);
  if (hit != null) return hit;
  const fresh = await listAssignables(gate.provider, gate.call, gate.key);
  const users = [...fresh.users].sort(byName);
  cachePut(gate.cacheKey, { users, truncated: fresh.truncated });
  return { users, truncated: fresh.truncated, at: now() };
}

function failed(
  ctx: TrackerContext,
  reply: FastifyReply,
  provider: AssignProvider,
  err: unknown,
  where: { accountId: number; workspaceId: number; route: string },
): FastifyReply {
  const code = err instanceof JiraFetchError ? err.code : 'unknown';
  const status = err instanceof JiraFetchError ? err.status : null;
  ctx.log.warn({ ...where, provider, code, status }, 'tracker assignee call failed');
  return reply.code(502).send({ error: 'TrackerError', code, message: assignErrorMessage(provider, err) });
}

export function registerTicketAssigneeRoutes(
  app: FastifyInstance,
  ctx: TrackerContext,
  opts: { transport?: JiraTransport } = {},
): void {
  app.get<{ Querystring: { workspace?: string; ident?: string } }>(
    '/api/ticket-assignees',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['ident'],
          properties: {
            workspace: { type: 'string', maxLength: 20 },
            ident: { type: 'string', minLength: 1, maxLength: 600 },
          },
        },
      },
    },
    async (req, reply): Promise<TicketAssignablesResponse | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      const gate = await assignGate(ctx, accountId, workspaceId, req.query.ident ?? '', opts.transport);
      if (!gate.ok) return reply.code(gate.status).send({ error: gate.error, message: gate.message });
      try {
        const list = await assignablesFor(gate);
        return { workspaceId, ident: gate.ident, users: list.users, truncated: list.truncated };
      } catch (err) {
        return failed(ctx, reply, gate.provider, err, { accountId, workspaceId, route: 'assignees' });
      }
    },
  );

  app.post<{ Querystring: { workspace?: string }; Body: TicketAssignBody }>(
    '/api/ticket-assignee',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { workspace: { type: 'string', maxLength: 20 } },
        },
        body: {
          type: 'object',
          required: ['ident', 'assigneeId'],
          additionalProperties: false,
          properties: {
            ident: { type: 'string', minLength: 1, maxLength: 600 },
            // ⚠ A TYPE UNION, never anyOf: Fastify's coercion would turn a null into "" under anyOf.
            assigneeId: { type: ['string', 'null'], minLength: 1, maxLength: TICKET_ASSIGNEE_ID_MAX },
          },
        },
      },
    },
    async (req, reply): Promise<TicketAssignResponse | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      const assigneeId = req.body.assigneeId;
      if (assigneeId != null && !ASSIGNEE_ID_RE.test(assigneeId)) {
        return reply.code(400).send({ error: 'UnknownAssignee', message: MSG_UNKNOWN_PERSON });
      }
      const gate = await assignGate(ctx, accountId, workspaceId, req.body.ident, opts.transport);
      if (!gate.ok) return reply.code(gate.status).send({ error: gate.error, message: gate.message });
      let picked: TicketAssignable | null = null;
      let settled: Settled | undefined;
      try {
        // ⚠ Only a person on the tracker's own list (the picker's list, from the cache when warm).
        if (assigneeId != null) {
          picked = (await assignablesFor(gate)).users.find((u) => u.id === assigneeId) ?? null;
          if (picked == null) return reply.code(400).send({ error: 'UnknownAssignee', message: MSG_UNKNOWN_PERSON });
        }
        settled = await assign(gate.provider, gate.call, gate.key, assigneeId, picked);
      } catch (err) {
        return failed(ctx, reply, gate.provider, err, { accountId, workspaceId, route: 'assign' });
      }
      ctx.log.info({ accountId, workspaceId, provider: gate.provider, route: 'assign' }, 'tracker assignee changed');
      // The change was made. With no read-back, store who was picked (the tracker accepted it) and let
      // the worker read the PR rows again at its next pass.
      const who: Settled =
        settled !== undefined
          ? settled
          : picked == null
            ? null
            : {
                name: picked.name,
                avatarUrl: picked.avatarUrl,
                // The id the reader stores: GitHub the login, Jira the bare account id / user name.
                accountId: gate.provider === 'github' ? picked.name : (assigneeId ?? '').replace(/^(?:acc|name):/, ''),
              };
      await writeTicketAssignee(ctx, accountId, gate.provider, gate.apiRoot, gate.key, gate.ident, who);
      if (settled === undefined) await markDue(ctx, accountId, gate.provider, gate.apiRoot, gate.key);
      return { workspaceId, ident: gate.ident, assignee: who == null ? null : { name: who.name, avatarUrl: who.avatarUrl } };
    },
  );
}
