import { parseGithubIssueKey } from '@pierre-review/shared';
import { isRateLimitError } from '../../github/client.js';
import { isBudgetLow, noteBudget, noteLimited } from '../../github/rate-budget.js';
import { JiraFetchError } from '../jira/fetch.js';
import type { FetchedTicket, GithubCallAccess, TrackerCall } from '../types.js';
import { extractGithubAcceptanceCriteria, githubAcFieldId, type GithubSubIssue } from './ac.js';

// GITHUB ISSUES — THE READER. One GraphQL call per issue (1 point), with the ACCOUNT's own token
// (`TrackerCall.github`, resolved per call — never cached), through the same worker every reading
// tracker uses: read when a PR is RECEIVED, never when it is viewed.
//
// What is read: title, body (markdown), state + state reason, issue type, the first assignee, and
// up to `SUB_ISSUE_CAP` sub-issues — the criteria's first source (./ac.ts). Labels are not read:
// nothing shows them.
//
// ⚠ RATE LIMITS ARE PRE-EMPTED, NEVER SURFACED. A low budget (`isBudgetLow`) or a limit GitHub
// reports is thrown as an HTTP 429, which the worker turns into a short workspace backoff with NO
// row written — the issue is simply read on a later pass. The budget is fed from the query's own
// `rateLimit` block, exactly like every other cheap consumer.
//
// Failures map onto the worker's codes: an issue (or repository) GitHub says does not exist, or that
// this account cannot see, is `not_found`; one GitHub says exists but refuses (FORBIDDEN, an SSO
// wall) is `no_access` — both are STORED as that state, so a screen says "can't read this issue"
// rather than "no story". A refused token is `unauthorized`; anything else is transient.

export const SUB_ISSUE_CAP = 50;

export const GITHUB_ISSUE_QUERY = /* GraphQL */ `
  query TrackerGithubIssue($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number
        title
        url
        state
        stateReason
        body
        issueType { id name }
        assignees(first: 1) { nodes { login avatarUrl } }
        subIssues(first: ${SUB_ISSUE_CAP}) { totalCount nodes { number title state } }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`;

interface GqlIssue {
  number: number;
  title: string | null;
  url: string | null;
  state: string | null;
  stateReason: string | null;
  body: string | null;
  issueType?: { id: string; name: string } | null;
  assignees?: { nodes?: Array<{ login: string; avatarUrl: string | null } | null> | null } | null;
  subIssues?: { totalCount?: number | null; nodes?: Array<GithubSubIssue | null> | null } | null;
}

interface GqlIssueResponse {
  repository: { issue: GqlIssue | null } | null;
  rateLimit?: { cost?: number | null; remaining?: number | null; resetAt?: string | null } | null;
}

const errorTypes = (errors: unknown): string[] =>
  Array.isArray(errors) ? errors.map((e) => String((e as { type?: unknown })?.type ?? '')) : [];

/** A GraphQL error list that means "you may not read this" (FORBIDDEN, an SSO/SAML wall). */
function isRefusal(errors: unknown): boolean {
  if (errorTypes(errors).some((t) => t === 'FORBIDDEN')) return true;
  return Array.isArray(errors) && errors.some((e) => /saml|sso/i.test(String((e as { message?: unknown })?.message ?? '')));
}

function parseResetAt(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Feed the account's shared budget from a response's `rateLimit` block. */
export function noteGithubBudget(
  accountId: number,
  rl: { remaining?: number | null; resetAt?: string | null } | null | undefined,
): void {
  if (rl == null) return;
  noteBudget(accountId, { remaining: rl.remaining ?? null, resetAt: parseResetAt(rl.resetAt) });
}

/** Run one GraphQL call with the pre-emption + limit rules every GitHub Issues call shares. */
export async function githubGraphql<T>(
  gh: GithubCallAccess,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data: T | null; errors: unknown }> {
  if (isBudgetLow(gh.accountId)) throw new JiraFetchError('http', 429);
  let res: { data: T | null; errors?: unknown };
  try {
    res = await gh.graphql<T>(query, variables);
  } catch (err) {
    const rl = isRateLimitError(err);
    if (rl.limited) {
      noteLimited(gh.accountId, rl.resumeAt);
      throw new JiraFetchError('http', 429);
    }
    const status = (err as { status?: number })?.status ?? (err as { response?: { status?: number } })?.response?.status;
    if (status === 401) throw new JiraFetchError('unauthorized', 401);
    if (status === 403) throw new JiraFetchError('no_access', 403);
    throw new JiraFetchError('network');
  }
  if (errorTypes(res.errors).includes('RATE_LIMITED')) {
    noteLimited(gh.accountId, null);
    throw new JiraFetchError('http', 429);
  }
  return { data: res.data ?? null, errors: res.errors };
}

const STATE_NAMES: Record<string, string> = {
  COMPLETED: 'Closed',
  NOT_PLANNED: 'Closed as not planned',
  DUPLICATE: 'Closed as duplicate',
  REOPENED: 'Open',
};

/** GitHub's open/closed + reason → the stored status and its category. */
export function githubStatus(state: string | null, reason: string | null): FetchedTicket['status'] {
  const s = (state ?? '').toUpperCase();
  if (s === 'OPEN') return { name: 'Open', category: 'new' };
  if (s === 'CLOSED') return { name: STATE_NAMES[(reason ?? '').toUpperCase()] ?? 'Closed', category: 'done' };
  return null;
}

const httpsOnly = (u: string | null | undefined): string | null => (u != null && /^https:\/\//i.test(u) ? u : null);

/** One issue's GraphQL node → the provider-neutral ticket the worker stores. */
export function toFetchedTicket(key: string, issue: GqlIssue): FetchedTicket {
  const subs = (issue.subIssues?.nodes ?? []).filter(
    (n): n is GithubSubIssue => n != null && typeof n.number === 'number' && typeof n.title === 'string',
  );
  const ac = extractGithubAcceptanceCriteria(issue.body, subs, issue.subIssues?.totalCount ?? subs.length);
  const who = (issue.assignees?.nodes ?? []).find((n) => n != null) ?? null;
  return {
    key,
    title: (issue.title ?? '').trim(),
    description: ac.description,
    issueType: issue.issueType?.id && issue.issueType.name ? { id: issue.issueType.id, name: issue.issueType.name } : null,
    status: githubStatus(issue.state, issue.stateReason),
    assignee: who != null ? { name: who.login, accountId: who.login, avatarUrl: httpsOnly(who.avatarUrl) } : null,
    // The criteria travel as ONE strong candidate, so the store's one rule (`deriveAc`) picks them —
    // on a fresh read and when a merged PR copies a stored sibling alike.
    candidates:
      ac.criteria != null
        ? [{ id: githubAcFieldId(ac.criteria.source), name: ac.criteria.name, text: ac.criteria.text, match: 'strong' }]
        : [],
    omittedCandidates: 0,
  };
}

/** Read ONE issue (`owner/repo#12`). Throws `JiraFetchError` (the worker's transport-generic codes). */
export async function fetchGithubIssue(call: TrackerCall, key: string): Promise<FetchedTicket> {
  const gh = call.github;
  if (gh == null) throw new JiraFetchError('unauthorized');
  const parts = parseGithubIssueKey(key);
  if (parts == null) throw new JiraFetchError('not_found');
  const { data, errors } = await githubGraphql<GqlIssueResponse>(gh, GITHUB_ISSUE_QUERY, {
    owner: parts.owner,
    name: parts.repo,
    number: parts.number,
  });
  noteGithubBudget(gh.accountId, data?.rateLimit);
  const issue = data?.repository?.issue ?? null;
  if (issue == null) {
    if (isRefusal(errors)) throw new JiraFetchError('no_access');
    if (data?.repository !== undefined || errorTypes(errors).includes('NOT_FOUND')) throw new JiraFetchError('not_found');
    throw new JiraFetchError('network');
  }
  return toFetchedTicket(key, issue);
}

/** A plain-English sentence for a failure. Never anything GitHub sent back. */
export function githubErrorMessage(err: unknown): string {
  const code = err instanceof JiraFetchError ? err.code : 'network';
  switch (code) {
    case 'not_found':
      return "Can't read this issue. It does not exist, or your GitHub account can't see it.";
    case 'no_access':
      return "Can't read this issue. Your GitHub account does not have access to its repository.";
    case 'unauthorized':
      return 'GitHub did not accept your GitHub sign-in.';
    case 'http':
      return err instanceof JiraFetchError && err.status === 429
        ? 'GitHub’s rate limit is used up for now. Limn will read this issue later.'
        : 'GitHub answered with an error.';
    default:
      return 'Could not reach GitHub.';
  }
}
