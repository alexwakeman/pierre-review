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
import { ghRestGetFor, ghRestPostFor } from '../github/client.js';

export interface ReleaseGithub {
  readTagSha(owner: string, name: string, tag: string): Promise<string | null>;
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

    async createReleaseTag(owner, name, a) {
      let tagObject: { sha?: string };
      try {
        tagObject = await ghRestPostFor(token, `/repos/${seg(owner)}/${seg(name)}/git/tags`, {
          tag: a.tag,
          message: a.message,
          object: a.sha,
          type: 'commit',
        });
      } catch (err) {
        return { ok: false, exists: false, message: githubFailureWords(err) };
      }
      if (typeof tagObject.sha !== 'string') return { ok: false, exists: false, message: 'GitHub refused it' };
      try {
        await ghRestPostFor(token, `/repos/${seg(owner)}/${seg(name)}/git/refs`, { ref: `refs/tags/${a.tag}`, sha: tagObject.sha });
      } catch (err) {
        // 422 "Reference already exists": the name is taken — refused, never moved.
        if (statusOf(err) === 422) return { ok: false, exists: true, message: 'the tag already exists' };
        return { ok: false, exists: false, message: githubFailureWords(err) };
      }
      return { ok: true, tagObjectOid: tagObject.sha };
    },

    async createPrerelease(owner, name, a) {
      try {
        const r = await ghRestPostFor<{ id?: number; html_url?: string }>(token, `/repos/${seg(owner)}/${seg(name)}/releases`, {
          tag_name: a.tag,
          name: a.title,
          body: a.body,
          prerelease: true,
          draft: false,
        });
        if (typeof r.id !== 'number' || typeof r.html_url !== 'string') return { ok: false, message: 'GitHub refused it' };
        return { ok: true, id: r.id, url: r.html_url };
      } catch (err) {
        return { ok: false, message: githubFailureWords(err) };
      }
    },
  };
}
