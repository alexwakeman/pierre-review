// THE RELEASE WRITES' GITHUB CALLS (docs/RELEASES.md § Releases tab 6). REST, under the READER'S
// token (auth/account.ts `getAccessToken`, through the per-account `ghRest*For` factories — no cached
// token). The caller (releases/create.ts) CLAIMS each write before calling and never retries.
//
//   readTagSha        GET git/ref/tags/<name> (EXACT: `ref`, never `matching-refs`), peeled through an
//                     annotated tag object → the commit sha, or null when the tag does not exist.
//   createReleaseTag  POST git/tags (the annotated tag object on the commit) then POST git/refs
//                     (`refs/tags/<name>`). A 422 on the ref = the name already exists → `exists`:
//                     REFUSED, never moved (there is no PATCH anywhere here).
//   createPrerelease  POST releases `{tag_name, name, body, prerelease: true}`.
//   commitOnBranch    GET compare/<sha>...<branch> (`per_page=1`): the commit is on the branch when the
//                     branch is `ahead` of it or `identical` — Confirm's check of a RELEASE POINT (a repo
//                     released from merged pull requests has no version tag to read again).
// The two writes live in github/mutations.ts (`createAnnotatedReleaseTag`, `createGithubPrerelease`),
// through `limnWrite` with the 'reader' origin: the reader's press, under the reader's account.
import { ghRestGetFor } from '../github/client.js';
import { createAnnotatedReleaseTag, createGithubPrerelease } from '../github/mutations.js';

export interface ReleaseGithub {
  readTagSha(owner: string, name: string, tag: string): Promise<string | null>;
  /** The commit is on the branch (reachable from its head). A 404 (unknown commit or branch) = false. */
  commitOnBranch(owner: string, name: string, sha: string, branch: string): Promise<boolean>;
  createReleaseTag(
    owner: string,
    name: string,
    a: { tag: string; sha: string; message: string },
  ): Promise<{ ok: true; tagObjectOid: string } | { ok: false; exists: boolean; message: string }>;
  createPrerelease(
    owner: string,
    name: string,
    a: { tag: string; title: string; body: string },
  ): Promise<{ ok: true; id: number; url: string } | { ok: false; message: string }>;
}

const statusOf = (err: unknown): number | null => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
};

/** One short sentence for a GitHub refusal — never the response body. */
export function githubFailureWords(err: unknown): string {
  const s = statusOf(err);
  if (s === 403 || s === 404) return 'GitHub refused it (no write access)';
  if (s === 422) return 'GitHub refused it';
  if (s === 429) return 'GitHub rate limit';
  if (s != null && s >= 500) return 'GitHub did not answer';
  return 'GitHub could not be reached';
}

const seg = (s: string): string => encodeURIComponent(s);
const refPath = (tag: string): string => tag.split('/').map(seg).join('/');

export function releaseGithubFor(token: string): ReleaseGithub {
  return {
    async readTagSha(owner, name, tag) {
      let ref: { object?: { type?: string; sha?: string } };
      try {
        ref = await ghRestGetFor(token, `/repos/${seg(owner)}/${seg(name)}/git/ref/tags/${refPath(tag)}`);
      } catch (err) {
        if (statusOf(err) === 404) return null;
        throw err;
      }
      let obj = ref.object;
      // An annotated tag (possibly a tag of a tag): peel, at most a few levels.
      for (let i = 0; i < 4 && obj?.type === 'tag' && obj.sha; i += 1) {
        const t = await ghRestGetFor<{ object?: { type?: string; sha?: string } }>(
          token,
          `/repos/${seg(owner)}/${seg(name)}/git/tags/${seg(obj.sha)}`,
        );
        obj = t.object;
      }
      return obj?.type === 'commit' && typeof obj.sha === 'string' ? obj.sha : null;
    },

    async commitOnBranch(owner, name, sha, branch) {
      let out: { status?: string };
      try {
        out = await ghRestGetFor(token, `/repos/${seg(owner)}/${seg(name)}/compare/${seg(sha)}...${refPath(branch)}?per_page=1`);
      } catch (err) {
        if (statusOf(err) === 404) return false;
        throw err;
      }
      return out.status === 'ahead' || out.status === 'identical';
    },

    async createReleaseTag(owner, name, a) {
      try {
        const out = await createAnnotatedReleaseTag(token, { owner, name, tag: a.tag, sha: a.sha, message: a.message }, 'reader');
        return { ok: true, tagObjectOid: out.tagObjectOid };
      } catch (err) {
        // 422 on the REF ("Reference already exists"): the name is taken — refused, never moved.
        const onRef = (err as { stage?: unknown } | null)?.stage === 'ref';
        if (onRef && statusOf(err) === 422) return { ok: false, exists: true, message: 'the tag already exists' };
        return { ok: false, exists: false, message: githubFailureWords(err) };
      }
    },

    async createPrerelease(owner, name, a) {
      try {
        const r = await createGithubPrerelease(token, { owner, name, tag: a.tag, title: a.title, body: a.body }, 'reader');
        return { ok: true, id: r.id, url: r.url };
      } catch (err) {
        return { ok: false, message: githubFailureWords(err) };
      }
    },
  };
}
