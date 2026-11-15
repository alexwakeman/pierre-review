// THE BUILD CLAIM'S GITHUB ADAPTER (docs/STORY-BUILD.md § The team claim). The status lines go through the
// review claims' adapter (team-claim.ts `defaultTeamClaimGithub`: `listLines` matches either prefix, the
// writes are ledgered like every Ensemble line); the placeholder is the reader's (like Implement's push,
// github/mutations.ts git-data writes, origin 'reader'); the ticket branch is read in ONE GraphQL call for every
// workspace repository, and the placeholder is written with REST:
//   create   POST git/commits (the default branch's tree, one parent) + POST git/refs — GitHub refuses a ref
//            that exists (422), so creating the branch is itself a compare-and-set.
//   replace  (a free or lapsed placeholder) a NEW placeholder whose parent IS the old one, written with
//            PATCH git/refs `force: false`: a fast-forward of exactly the head that was read, so a branch
//            someone pushed real work to in between is refused, never overwritten.
//   delete   (our own placeholder, when the build ends) only after re-reading that the branch still points
//            at it and that commit carries the placeholder trailer.
// Every method may throw (the flow decides what a failure means). Replaceable in tests.
import { defaultTeamClaimGithub, type TeamClaimGithub } from '../../review/claude-review/team-claim.js';
import { isPlaceholderMessage } from './build-claim.js';

export interface TicketBranchRepo {
  owner: string;
  name: string;
  /** The reader may push here (viewerPermission WRITE, MAINTAIN or ADMIN). */
  canPush: boolean;
  defaultBranch: { name: string; oid: string; treeOid: string } | null;
  /** The ticket branch's head, or null when the branch is not there. */
  head: { oid: string; message: string; treeOid: string } | null;
}

export interface BuildClaimGithub extends TeamClaimGithub {
  readTicketBranch(accountId: number, repos: ReadonlyArray<{ owner: string; name: string }>, branch: string): Promise<TicketBranchRepo[]>;
  /** The new placeholder's sha. A ref that exists (create) or moved (replace) throws `code: 'REF_TAKEN'`. */
  createPlaceholder(
    accountId: number,
    owner: string,
    name: string,
    branch: string,
    commit: { treeOid: string; parentOid: string; message: string },
    replaceOid: string | null,
  ): Promise<string>;
  /** Delete the branch only while it is still at `sha` and that commit is a placeholder. true when deleted. */
  deletePlaceholder(accountId: number, owner: string, name: string, branch: string, sha: string): Promise<boolean>;
  /** One commit's message (null when GitHub has no such commit). */
  commitMessage(accountId: number, owner: string, name: string, sha: string): Promise<string | null>;
}

const enc = (s: string): string => encodeURIComponent(s);
const refPath = (branch: string): string => branch.split('/').map(enc).join('/');
const REPOS_PER_QUERY = 25;

const refTaken = (message: string): Error & { code: string } => Object.assign(new Error(message), { code: 'REF_TAKEN' });

interface RepoNode {
  viewerPermission: string | null;
  defaultBranchRef: { name: string; target: { oid: string; tree?: { oid: string } } | null } | null;
  ref: { target: { oid: string; message?: string; tree?: { oid: string } } | null } | null;
}

function ticketBranchQuery(n: number): string {
  const vars = ['$q: String!'];
  const fields: string[] = [];
  for (let i = 0; i < n; i += 1) {
    vars.push(`$o${i}: String!`, `$n${i}: String!`);
    fields.push(
      `r${i}: repository(owner: $o${i}, name: $n${i}) { viewerPermission defaultBranchRef { name target { oid ... on Commit { tree { oid } } } } ref(qualifiedName: $q) { target { oid ... on Commit { message tree { oid } } } } }`,
    );
  }
  return `query TicketBranch(${vars.join(', ')}) { ${fields.join(' ')} }`;
}

export const defaultBuildClaimGithub: BuildClaimGithub = {
  listLines: (...a) => defaultTeamClaimGithub.listLines(...a),
  postLine: (...a) => defaultTeamClaimGithub.postLine(...a),
  login: (accountId) => defaultTeamClaimGithub.login(accountId),
  async readTicketBranch(accountId, repos, branch) {
    const { getAccessToken } = await import('../../auth/account.js');
    const { getGraphqlClientFor, graphqlTolerant } = await import('../../github/client.js');
    const client = getGraphqlClientFor(await getAccessToken(accountId));
    const out: TicketBranchRepo[] = [];
    for (let at = 0; at < repos.length; at += REPOS_PER_QUERY) {
      const chunk = repos.slice(at, at + REPOS_PER_QUERY);
      const variables: Record<string, unknown> = { q: `refs/heads/${branch}` };
      chunk.forEach((r, i) => {
        variables[`o${i}`] = r.owner;
        variables[`n${i}`] = r.name;
      });
      // A repository the token cannot see answers null (a partial error), never the whole read.
      const data = await graphqlTolerant<Record<string, RepoNode | null>>(client, ticketBranchQuery(chunk.length), variables);
      chunk.forEach((r, i) => {
        const node = data?.[`r${i}`] ?? null;
        if (node == null) return;
        const d = node.defaultBranchRef;
        const head = node.ref?.target ?? null;
        out.push({
          owner: r.owner,
          name: r.name,
          canPush: node.viewerPermission === 'ADMIN' || node.viewerPermission === 'MAINTAIN' || node.viewerPermission === 'WRITE',
          defaultBranch: d?.target?.tree?.oid ? { name: d.name, oid: d.target.oid, treeOid: d.target.tree.oid } : null,
          head: head ? { oid: head.oid, message: head.message ?? '', treeOid: head.tree?.oid ?? '' } : null,
        });
      });
    }
    return out;
  },
  async createPlaceholder(accountId, owner, name, branch, commit, replaceOid) {
    const { getAccessToken } = await import('../../auth/account.js');
    const { createGitCommit, createGitBranchRef, fastForwardGitBranchRef } = await import('../../github/mutations.js');
    // A scratch backend without `--github write` writes nothing (scratch-guard.ts).
    (await import('../../scratch-guard.js')).assertScratchWriteAllowed(`the ${branch} placeholder on ${owner}/${name}`);
    const token = await getAccessToken(accountId);
    const sha = await createGitCommit(token, owner, name, { message: commit.message, treeOid: commit.treeOid, parentOids: [commit.parentOid] }, 'reader');
    if (replaceOid == null) {
      try {
        await createGitBranchRef(token, owner, name, branch, sha, 'reader');
      } catch (err) {
        if ((err as { status?: number }).status === 422) throw refTaken(`${branch} already exists on ${owner}/${name}`);
        throw err;
      }
      return sha;
    }
    const res = await fastForwardGitBranchRef(token, owner, name, branch, sha, 'reader');
    if (res.status === 422) throw refTaken(`${branch} moved on ${owner}/${name}`);
    if (!res.ok) throw Object.assign(new Error(`GitHub refused the branch update (HTTP ${res.status})`), { status: res.status });
    return sha;
  },
  async deletePlaceholder(accountId, owner, name, branch, sha) {
    const { getAccessToken } = await import('../../auth/account.js');
    const { ghRestGetText } = await import('../../github/client.js');
    const token = await getAccessToken(accountId);
    const ref = await ghRestGetText(token, `/repos/${enc(owner)}/${enc(name)}/git/ref/heads/${refPath(branch)}`);
    if (!ref.ok) return false;
    let live: unknown = null;
    try {
      live = (JSON.parse(ref.text) as { object?: { sha?: unknown } }).object?.sha;
    } catch {
      return false;
    }
    if (live !== sha) return false;
    (await import('../../scratch-guard.js')).assertScratchWriteAllowed(`deleting the ${branch} placeholder on ${owner}/${name}`);
    if (!isPlaceholderMessage(await defaultBuildClaimGithub.commitMessage(accountId, owner, name, sha))) return false;
    const { deleteGitBranchRef } = await import('../../github/mutations.js');
    return deleteGitBranchRef(token, owner, name, branch, 'reader');
  },
  async commitMessage(accountId, owner, name, sha) {
    const { getAccessToken } = await import('../../auth/account.js');
    const { ghRestGetText } = await import('../../github/client.js');
    const res = await ghRestGetText(await getAccessToken(accountId), `/repos/${enc(owner)}/${enc(name)}/git/commits/${enc(sha)}`);
    if (!res.ok) return null;
    try {
      const m = (JSON.parse(res.text) as { message?: unknown }).message;
      return typeof m === 'string' ? m : null;
    } catch {
      return null;
    }
  },
};
