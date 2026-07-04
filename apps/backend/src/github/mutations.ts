// Per-account GitHub WRITE actions — the data-plane for the PR write features
// (reply / resolve / comment / approve / inline comment / fetch files). Every
// function takes the owning account's token as its FIRST argument and goes
// through the per-account client factories (getGraphqlClientFor / ghRestGetFor /
// ghRestPostFor) — NEVER the gh-CLI wrappers, so these work in cloud too.
//
// GraphQL note: @octokit/graphql RESERVES the variable name `query`. The
// operation-variable here is named `input` / etc., never `query`.

import {
  getGraphqlClientFor,
  ghRestGetDiff,
  ghRestGetFor,
  ghRestPostFor,
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

// The PR's unified diff via the REST API (Accept: application/vnd.github.diff) —
// cloud-ready, per-account. Bounded implicitly by GitHub's own diff-size limit.
export async function fetchPrUnifiedDiff(
  token: string,
  owner: string,
  name: string,
  number: number,
): Promise<string> {
  return ghRestGetDiff(token, `/repos/${owner}/${name}/pulls/${number}`);
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
