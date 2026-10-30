// A handful of a repository's files at one commit, in ONE GraphQL request (one alias per path, each an
// `object(expression: "<sha>:<path>")` read as a Blob). Used by AI Fix's "Run tests" picker to list
// the checks a PR's head declares (coding/checks/discover.ts) before any clone exists. A missing path,
// a binary blob or one over `maxBytes` reads as null. Throws on a request failure (the route answers it).
import { getGraphqlClientFor } from './client.js';

interface BlobNode {
  text?: string | null;
  byteSize?: number;
  isBinary?: boolean | null;
}

export async function fetchRepoFilesAt(
  token: string,
  a: { owner: string; name: string; ref: string; paths: readonly string[]; maxBytes?: number },
): Promise<Record<string, string | null>> {
  if (!/^[0-9a-f]{40}$/.test(a.ref)) throw new Error('fetchRepoFilesAt: ref must be a commit sha');
  const maxBytes = a.maxBytes ?? 512 * 1024;
  const vars: Record<string, string> = { owner: a.owner, name: a.name };
  const fields = a.paths.map((p, i) => {
    vars[`e${i}`] = `${a.ref}:${p}`;
    return `f${i}: object(expression: $e${i}) { ... on Blob { text byteSize isBinary } }`;
  });
  const decl = a.paths.map((_, i) => `$e${i}: String!`).join(', ');
  const q = `query RepoFiles($owner: String!, $name: String!, ${decl}) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
  const res = (await getGraphqlClientFor(token)(q, vars)) as { repository?: Record<string, BlobNode | null> | null };
  const repo = res.repository ?? {};
  const out: Record<string, string | null> = {};
  a.paths.forEach((p, i) => {
    const b = repo[`f${i}`];
    out[p] = b && !b.isBinary && typeof b.text === 'string' && (b.byteSize ?? 0) <= maxBytes ? b.text : null;
  });
  return out;
}
