// Per-account GitHub WRITE actions — the data-plane for the PR write features
// (reply / resolve / comment / approve / inline comment / fetch files). Every
// function takes the owning account's token as its FIRST argument and goes
// through the per-account client factories (getGraphqlClientFor / ghRestGetFor /
// ghRestPostFor) — NEVER the gh-CLI wrappers, so these work in cloud too.
//
// GraphQL note: @octokit/graphql RESERVES the variable name `query`. The
// operation-variable here is named `input` / etc., never `query`.

import type { MergeMethod } from '@pierre-review/shared';
import {
  getGraphqlClientFor,
  ghRestGetDiffStatus,
  ghRestGetFor,
  ghRestPatchStatus,
  ghRestPostFor,
  ghRestPostNoContent,
  ghRestPutStatus,
} from './client.js';

// ---- Review-thread reply (GraphQL) ----

interface AddReplyResponse {
  addPullRequestReviewThreadReply: {
    // `comment` is schema-NULLABLE (the GitHub SDL types it without `!`): GitHub
    // can return 200 + null on a partial success, so guard before dereferencing.
    comment: {
      id: string;
      databaseId: number | null;
      body: string;
      createdAt: string;
      url: string;
      author: { login: string } | null;
    } | null;
  };
}

const ADD_REPLY_MUTATION = /* GraphQL */ `
  mutation AddThreadReply($input: AddPullRequestReviewThreadReplyInput!) {
    addPullRequestReviewThreadReply(input: $input) {
      comment {
        id
        databaseId
        body
        createdAt
        url
        author {
          login
        }
      }
    }
  }
`;

// Reply to an existing review thread (GraphQL). `threadNodeId` is the thread's
// GitHub node id (reviewThreads.githubNodeId).
export async function addReviewThreadReply(
  token: string,
  threadNodeId: string,
  body: string,
): Promise<{
  nodeId: string;
  databaseId: number | null;
  body: string;
  createdAt: string;
  url: string;
  authorLogin: string | null;
}> {
  const gql = getGraphqlClientFor(token);
  const res = await gql<AddReplyResponse>(ADD_REPLY_MUTATION, {
    input: { pullRequestReviewThreadId: threadNodeId, body },
  });
  const c = res.addPullRequestReviewThreadReply.comment;
  if (!c) {
    throw new Error(
      'GitHub returned no comment for the thread reply (the reply may still have posted)',
    );
  }
  return {
    nodeId: c.id,
    databaseId: c.databaseId,
    body: c.body,
    createdAt: c.createdAt,
    url: c.url,
    authorLogin: c.author?.login ?? null,
  };
}

// ---- Resolve / unresolve a review thread (GraphQL) ----

// `thread` is schema-NULLABLE on both payloads — guard before reading isResolved.
interface ResolveResponse {
  resolveReviewThread: { thread: { isResolved: boolean } | null };
}
interface UnresolveResponse {
  unresolveReviewThread: { thread: { isResolved: boolean } | null };
}

const RESOLVE_MUTATION = /* GraphQL */ `
  mutation ResolveThread($input: ResolveReviewThreadInput!) {
    resolveReviewThread(input: $input) {
      thread {
        isResolved
      }
    }
  }
`;

const UNRESOLVE_MUTATION = /* GraphQL */ `
  mutation UnresolveThread($input: UnresolveReviewThreadInput!) {
    unresolveReviewThread(input: $input) {
      thread {
        isResolved
      }
    }
  }
`;

// Resolve (resolved=true) or unresolve (resolved=false) a review thread.
export async function setReviewThreadResolved(
  token: string,
  threadNodeId: string,
  resolved: boolean,
): Promise<{ isResolved: boolean }> {
  const gql = getGraphqlClientFor(token);
  if (resolved) {
    const res = await gql<ResolveResponse>(RESOLVE_MUTATION, {
      input: { threadId: threadNodeId },
    });
    const t = res.resolveReviewThread.thread;
    if (!t) throw new Error('GitHub returned no thread for resolve');
    return { isResolved: t.isResolved };
  }
  const res = await gql<UnresolveResponse>(UNRESOLVE_MUTATION, {
    input: { threadId: threadNodeId },
  });
  const t = res.unresolveReviewThread.thread;
  if (!t) throw new Error('GitHub returned no thread for unresolve');
  return { isResolved: t.isResolved };
}

// ---- Issue-level (PR) comment (REST) ----

interface RestIssueComment {
  node_id: string;
  id: number;
  body: string;
  created_at: string;
  html_url: string;
  user: { login: string } | null;
}

// Post a new issue-level (general PR) comment. A PR is an issue for the comments
// endpoint, so `number` is the PR number.
export async function addIssueComment(
  token: string,
  owner: string,
  name: string,
  number: number,
  body: string,
): Promise<{
  nodeId: string;
  databaseId: number;
  body: string;
  createdAt: string;
  url: string;
  authorLogin: string | null;
}> {
  const res = await ghRestPostFor<RestIssueComment>(
    token,
    `/repos/${owner}/${name}/issues/${number}/comments`,
    { body },
  );
  return {
    nodeId: res.node_id,
    databaseId: res.id,
    body: res.body,
    createdAt: res.created_at,
    url: res.html_url,
    authorLogin: res.user?.login ?? null,
  };
}

// ---- Submit a PR review (REST) ----

interface RestReview {
  id: number;
  node_id: string | null;
  state: string;
  body: string;
  submitted_at: string | null;
  html_url: string;
  user: { login: string } | null;
}

// Submit ONE PR review (inline comments + body + verdict) in a single call. The
// REST reviews endpoint is required for inline line comments. `commitId` pins the
// review to a head SHA so it 409s/422s if the head moved. `comments` are inline
// line comments folded into this one review.
export async function submitPrReview(
  token: string,
  owner: string,
  name: string,
  number: number,
  opts: {
    event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
    body?: string;
    commitId?: string;
    comments?: Array<{ path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string }>;
  },
): Promise<{
  databaseId: number;
  nodeId: string | null;
  state: string;
  body: string;
  submittedAt: string;
  url: string;
  authorLogin: string | null;
}> {
  const payload: Record<string, unknown> = { event: opts.event };
  if (opts.body !== undefined) payload.body = opts.body;
  if (opts.commitId !== undefined) payload.commit_id = opts.commitId;
  if (opts.comments && opts.comments.length > 0) {
    payload.comments = opts.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      body: c.body,
    }));
  }
  const res = await ghRestPostFor<RestReview>(
    token,
    `/repos/${owner}/${name}/pulls/${number}/reviews`,
    payload,
  );
  return {
    databaseId: res.id,
    nodeId: res.node_id,
    state: res.state,
    body: res.body,
    submittedAt: res.submitted_at ?? new Date().toISOString(),
    url: res.html_url,
    authorLogin: res.user?.login ?? null,
  };
}

// ---- Standalone inline review comment (REST) ----

interface RestPullComment {
  id: number;
  node_id: string;
  html_url: string;
}

// Post a SINGLE standalone inline review comment (not part of a review draft),
// committed immediately. `commitId` pins it to the head SHA; the line must be
// addable on that side.
export async function postInlineComment(
  token: string,
  owner: string,
  name: string,
  number: number,
  opts: { commitId: string; path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string },
): Promise<{ databaseId: number; nodeId: string; url: string }> {
  const res = await ghRestPostFor<RestPullComment>(
    token,
    `/repos/${owner}/${name}/pulls/${number}/comments`,
    {
      body: opts.body,
      commit_id: opts.commitId,
      path: opts.path,
      line: opts.line,
      side: opts.side,
    },
  );
  return { databaseId: res.id, nodeId: res.node_id, url: res.html_url };
}

// ---- Per-file diff patches (REST, paginated) ----

interface RestPullFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  blob_url: string;
  sha: string;
}

// Fetch the PR's per-file diff patches, paginating by hand (per_page=100). Models
// the hand-paginated loop on sync/commit-files.ts. Stops once a page returns < 100
// files (definitively the last page) or once we've collected more than `cap`
// files. `truncated` is true iff there are more files than we return — either
// because a fetched page pushed us past `cap`, or because the last full page was
// exactly at `cap` AND a subsequent page returned more (handled naturally: we
// only break on a short page or on overflow, so a trailing full page is always
// followed by another fetch).
export async function fetchPrFilesWithPatch(
  token: string,
  owner: string,
  name: string,
  number: number,
  cap = 100,
): Promise<{ files: RestPullFile[]; truncated: boolean }> {
  const files: RestPullFile[] = [];
  let truncated = false;
  let page = 1;
  // GitHub caps per_page at 100 for this endpoint.
  const perPage = 100;
  for (;;) {
    const pageFiles = await ghRestGetFor<RestPullFile[]>(
      token,
      `/repos/${owner}/${name}/pulls/${number}/files?per_page=${perPage}&page=${page}`,
    );
    files.push(...pageFiles);
    if (files.length > cap) {
      // We have strictly more than the cap → there's at least one extra file.
      truncated = true;
      files.length = cap;
      break;
    }
    if (pageFiles.length < perPage) {
      // Short page: this is the last page, nothing beyond it.
      break;
    }
    // A full page came back and we're still at/under the cap. Keep going; the
    // next page's result decides whether more files exist beyond the cap.
    page += 1;
  }
  return { files, truncated };
}

// ---- PR head SHA (REST) ----

interface RestPull {
  head: { sha: string };
}

// The PR's current head SHA (to pin a posted review/comment to, and to detect a
// head-moved race).
export async function fetchHeadShaFor(
  token: string,
  owner: string,
  name: string,
  number: number,
): Promise<string> {
  const pull = await ghRestGetFor<RestPull>(
    token,
    `/repos/${owner}/${name}/pulls/${number}`,
  );
  return pull.head.sha;
}

// ---- AI Fix: PR head/fork info, unified diff, open PR (all per-account) ----

interface RestPullFull {
  head: {
    sha: string;
    ref: string;
    repo: { full_name: string } | null;
  };
  base: { ref: string; repo: { full_name: string } };
  maintainer_can_modify: boolean;
}

// Full head/fork metadata for a PR. `isFork` is true when the head repo differs from
// the base repo; combined with `maintainer_can_modify` it tells the fixer whether the
// PR's own head branch can be pushed to (else it must open a new branch in the base
// repo). head.repo can be null when a fork was deleted — treated as a fork.
export async function fetchPrHeadInfo(
  token: string,
  owner: string,
  name: string,
  number: number,
): Promise<{
  headSha: string;
  headRef: string;
  headRepoFullName: string;
  isFork: boolean;
  maintainerCanModify: boolean;
  baseRef: string;
}> {
  const pull = await ghRestGetFor<RestPullFull>(
    token,
    `/repos/${owner}/${name}/pulls/${number}`,
  );
  const baseRepoFullName = pull.base.repo.full_name;
  const headRepoFullName = pull.head.repo?.full_name ?? baseRepoFullName;
  return {
    headSha: pull.head.sha,
    headRef: pull.head.ref,
    headRepoFullName,
    isFork: pull.head.repo == null || headRepoFullName !== baseRepoFullName,
    maintainerCanModify: pull.maintainer_can_modify,
    baseRef: pull.base.ref,
  };
}

interface RestPullMergeable {
  mergeable: boolean | null;
  mergeable_state: string;
  base: { ref: string; sha: string };
  head: { ref: string; label: string; sha: string; repo: { full_name: string } | null };
}

// GitHub's OWN mergeability for a PR — a NEAR-INSTANT trunk-conflict signal (one, or
// two, REST calls) used to offer the rebase/merge/push options without cloning. GitHub
// computes `mergeable` asynchronously and can briefly return null; we retry once. The
// `compare` call adds behind/ahead counts + the trunk tip. This reflects the PR as it
// stands on GitHub (not the not-yet-pushed fix) — a fast approximation; the actual
// rebase/merge job does the authoritative, with-fix resolution.
export async function fetchMergeability(
  token: string,
  owner: string,
  name: string,
  number: number,
): Promise<{
  mergeable: boolean | null;
  mergeableState: string;
  baseRef: string;
  baseSha: string;
  behindBy: number;
  aheadBy: number;
}> {
  let pull = await ghRestGetFor<RestPullMergeable>(
    token,
    `/repos/${owner}/${name}/pulls/${number}`,
  );
  if (pull.mergeable === null) {
    await new Promise((r) => setTimeout(r, 600));
    pull = await ghRestGetFor<RestPullMergeable>(
      token,
      `/repos/${owner}/${name}/pulls/${number}`,
    );
  }

  let behindBy = 0;
  let aheadBy = 0;
  let baseSha = pull.base.sha;
  try {
    // For a fork the head must be qualified `owner:branch` (head.label); same-repo uses
    // the plain ref. Branch names with slashes are fine literal in the compare path.
    const headRef = pull.head.repo ? pull.head.label : pull.head.ref;
    const cmp = await ghRestGetFor<{
      behind_by: number;
      ahead_by: number;
      base_commit: { sha: string };
    }>(token, `/repos/${owner}/${name}/compare/${pull.base.ref}...${headRef}`);
    behindBy = cmp.behind_by ?? 0;
    aheadBy = cmp.ahead_by ?? 0;
    baseSha = cmp.base_commit?.sha ?? baseSha;
  } catch {
    /* compare is best-effort — the mergeable flag is the load-bearing part */
  }

  return {
    mergeable: pull.mergeable,
    mergeableState: pull.mergeable_state,
    baseRef: pull.base.ref,
    baseSha,
    behindBy,
    aheadBy,
  };
}

// ---- PR merge + update-from-trunk (CORE / free tier) ----

// The repo's enabled merge methods + default branch (GET /repos/{o}/{n}). Not synced — a
// rarely-changing repo setting, fetched live only when the merge control opens. Missing flags
// default true (GitHub's own default for a new repo).
export async function fetchRepoMergeConfig(
  token: string,
  owner: string,
  name: string,
): Promise<{
  allowMergeCommit: boolean;
  allowSquashMerge: boolean;
  allowRebaseMerge: boolean;
  defaultBranch: string;
}> {
  const repo = await ghRestGetFor<{
    allow_merge_commit?: boolean;
    allow_squash_merge?: boolean;
    allow_rebase_merge?: boolean;
    default_branch: string;
  }>(token, `/repos/${owner}/${name}`);
  return {
    allowMergeCommit: repo.allow_merge_commit ?? true,
    allowSquashMerge: repo.allow_squash_merge ?? true,
    allowRebaseMerge: repo.allow_rebase_merge ?? true,
    defaultBranch: repo.default_branch,
  };
}

export type MergePrOutcome =
  | { ok: true; sha: string }
  | {
      ok: false;
      // head_moved (409 sha mismatch), method_disallowed (422), not_mergeable (405: protection /
      // failing checks / conflicts), error (anything else).
      reason: 'head_moved' | 'method_disallowed' | 'not_mergeable' | 'error';
      message: string;
    };

// Merge the PR via GitHub's native endpoint (PUT .../merge). Pins `sha` to the expected head so
// GitHub 409s if the branch moved. Cloud-safe, clone-free. The caller pre-checks conflicts.
export async function mergePullRequest(
  token: string,
  owner: string,
  name: string,
  number: number,
  opts: { method: MergeMethod; expectedHeadSha?: string },
): Promise<MergePrOutcome> {
  const body: Record<string, unknown> = { merge_method: opts.method };
  if (opts.expectedHeadSha) body.sha = opts.expectedHeadSha;
  const res = await ghRestPutStatus(token, `/repos/${owner}/${name}/pulls/${number}/merge`, body);
  const j = (res.json ?? {}) as { merged?: boolean; sha?: string; message?: string };
  if (res.ok && j.merged) return { ok: true, sha: j.sha ?? '' };
  const message = j.message ?? res.text.slice(0, 300);
  const reason =
    res.status === 409
      ? 'head_moved'
      : res.status === 422
        ? 'method_disallowed'
        : res.status === 405
          ? 'not_mergeable'
          : 'error';
  return { ok: false, reason, message };
}

export type ClosePrOutcome =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'error'; message: string };

// Close an open PR (REST PATCH `{ state: 'closed' }`) — WITHOUT merging. Reversible on
// GitHub (it can be reopened), so no head-SHA pin is needed. Permission is re-checked by the
// caller (author OR write+). A 404 usually means the token can't see the PR (private/SSO).
export async function closePullRequest(
  token: string,
  owner: string,
  name: string,
  number: number,
): Promise<ClosePrOutcome> {
  const res = await ghRestPatchStatus(token, `/repos/${owner}/${name}/pulls/${number}`, {
    state: 'closed',
  });
  if (res.ok) return { ok: true };
  const j = (res.json ?? {}) as { message?: string };
  const message = j.message ?? res.text.slice(0, 300);
  return { ok: false, reason: res.status === 404 ? 'not_found' : 'error', message };
}

export type UpdateBranchOutcome =
  | { ok: true }
  | { ok: false; reason: 'head_moved' | 'conflicts' | 'error'; message: string };

// GitHub's NATIVE "update branch from base" (PUT .../update-branch) — a merge commit of the base
// into the head. Cloud-safe, clone-free (the cloud path for update-from-trunk). Merge-only: there
// is no native rebase. 202 = accepted; 422 = can't update — which GitHub uses BOTH for a stale
// expected_head_sha (a head-moved race — its message mentions the expected head sha) AND for a
// genuine can't-merge, so we disambiguate on the message.
export async function updatePullRequestBranch(
  token: string,
  owner: string,
  name: string,
  number: number,
  expectedHeadSha?: string,
): Promise<UpdateBranchOutcome> {
  const body = expectedHeadSha ? { expected_head_sha: expectedHeadSha } : undefined;
  const res = await ghRestPutStatus(
    token,
    `/repos/${owner}/${name}/pulls/${number}/update-branch`,
    body,
  );
  if (res.status === 202) return { ok: true };
  const j = (res.json ?? {}) as { message?: string };
  const message = j.message ?? res.text.slice(0, 300);
  const headMoved = res.status === 409 || /expected head sha/i.test(message);
  const reason = headMoved ? 'head_moved' : res.status === 422 ? 'conflicts' : 'error';
  return { ok: false, reason, message };
}

// The PR's unified diff via the REST API (Accept: application/vnd.github.diff) —
// cloud-ready, per-account. GitHub caps this media type at 20,000 lines and returns 406
// past it (a large PR — e.g. bulk data/generated files). In that case we fall back to the
// per-file endpoint, which has no total-lines cap, and synthesise a unified diff from each
// file's `patch`. Without this fallback the diff came back empty and the AI summary / CI
// analysis / fixer would (correctly, but uselessly) report "the diff is empty".
export async function fetchPrUnifiedDiff(
  token: string,
  owner: string,
  name: string,
  number: number,
): Promise<string> {
  const path = `/repos/${owner}/${name}/pulls/${number}`;
  const res = await ghRestGetDiffStatus(token, path);
  if (res.ok) return res.text;
  if (res.status === 406) {
    return reconstructUnifiedDiffFromFiles(token, owner, name, number);
  }
  throw new Error(
    `GitHub REST GET(diff) ${path} -> ${res.status}: ${res.text.slice(0, 300)}`,
  );
}

// Synthesise a unified diff from GitHub's per-file `patch`es — the fallback when the
// whole-PR .diff 406s (too large). The /files endpoint has no total-lines cap (up to 3000
// files); a file's `patch` is omitted when it's binary or a single file's own diff is too
// large, so we name those with their churn/status. The synthetic `diff --git a/… b/…`
// headers keep the result splittable by capDiff's per-file budgeter (so a summary still
// stays within the prompt's char budget, grounded in the files that DO have patches).
export function filesToUnifiedDiff(
  files: Array<{
    filename: string;
    previous_filename?: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>,
): string {
  const parts: string[] = [];
  for (const f of files) {
    const aPath = f.previous_filename ?? f.filename;
    parts.push(`diff --git a/${aPath} b/${f.filename}`);
    if (f.patch) {
      parts.push(`--- a/${aPath}`, `+++ b/${f.filename}`, f.patch);
    } else {
      // GitHub omits `patch` for binary files, a single file whose own diff is too large,
      // and some no-content changes (pure rename / mode-only). Lead with the authoritative
      // status + churn (the real signal) and hedge the reason so a rename isn't mislabelled.
      parts.push(
        `(diff not shown — status=${f.status}, +${f.additions}/-${f.deletions}; likely binary or too large)`,
      );
    }
  }
  return parts.join('\n');
}

async function reconstructUnifiedDiffFromFiles(
  token: string,
  owner: string,
  name: string,
  number: number,
): Promise<string> {
  // 300 files is plenty for a grounded summary and bounds the paging to ~3 requests; the
  // downstream capDiff trims further to the prompt's char budget.
  const { files } = await fetchPrFilesWithPatch(token, owner, name, number, 300);
  return filesToUnifiedDiff(files);
}

interface RestCreatedPull {
  number: number;
  html_url: string;
}

// Open a pull request (per-account). `head` is the branch to merge FROM (in the base
// repo — the fixer only ever creates branches in the base repo, so no `owner:branch`
// cross-fork form is needed); `base` the branch to merge INTO.
export async function createPullRequest(
  token: string,
  args: {
    owner: string;
    name: string;
    head: string;
    base: string;
    title: string;
    body: string;
  },
): Promise<{ number: number; url: string }> {
  const res = await ghRestPostFor<RestCreatedPull>(
    token,
    `/repos/${args.owner}/${args.name}/pulls`,
    {
      title: args.title,
      head: args.head,
      base: args.base,
      body: args.body,
    },
  );
  return { number: res.number, url: res.html_url };
}

// ---- Request reviewers on a PR (REST) ----

// Request one or more reviewers on a PR (POST .../pulls/:n/requested_reviewers with
// { reviewers: [login…], team_reviewers: [slug…] }). Needs a token with write/triage
// access; GitHub 422s if a login isn't a collaborator or is the PR author (the caller
// filters the author out). `teamSlugs` requests a whole team (a CODEOWNERS `@org/team`)
// WITHOUT expanding its membership — GitHub resolves the slug against the repo's org.
// Returns 201 with the updated PR body, which we don't need — the refreshed request
// state arrives on the next sync (reviewRequests are re-derived each sync).
export async function requestReviewers(
  token: string,
  owner: string,
  name: string,
  number: number,
  logins: string[],
  teamSlugs: string[] = [],
): Promise<void> {
  const body: { reviewers: string[]; team_reviewers?: string[] } = { reviewers: logins };
  if (teamSlugs.length > 0) body.team_reviewers = teamSlugs;
  await ghRestPostFor<unknown>(
    token,
    `/repos/${owner}/${name}/pulls/${number}/requested_reviewers`,
    body,
  );
}

// ---- Re-trigger a GitHub Actions workflow run ----

// Re-run a workflow run (per-account). `mode: 'failed'` reruns only the failed jobs
// (POST .../runs/:runId/rerun-failed-jobs); `mode: 'all'` reruns the whole run
// (POST .../runs/:runId/rerun). GitHub returns 201 with an EMPTY body and queues the
// run asynchronously; the caller has no run id to poll (the refreshed status arrives
// on the next sync). Uses the no-content POST helper so the empty success body isn't
// JSON-parsed. Needs a token with actions:write — fails loud (throws) otherwise,
// matching the other write helpers.
export async function rerunWorkflowRun(
  token: string,
  owner: string,
  name: string,
  runId: number,
  mode: 'failed' | 'all',
): Promise<void> {
  const suffix = mode === 'failed' ? 'rerun-failed-jobs' : 'rerun';
  await ghRestPostNoContent(
    token,
    `/repos/${owner}/${name}/actions/runs/${runId}/${suffix}`,
  );
}
