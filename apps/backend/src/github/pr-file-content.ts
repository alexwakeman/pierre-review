import { diffTokens } from '../conflict/diff.js';
import { ghRestGetFor } from './client.js';

// The Changes tab's three click-gated "load more" reads (docs/API.md § PR files):
//
//   • `?page=` on GET /api/prs/:id/files — the next 100 changed files (`fetchPrFilesPage`).
//   • GET /api/prs/:id/files/content — one file's raw text at the PR head or the merge base, so a
//     gap marker can expand the unchanged lines GitHub's patch leaves out (`fetchFileAtRef`).
//   • GET /api/prs/:id/files/diff — a file GitHub sends NO patch for (too large): both sides are
//     fetched and diffed here with the resolver's Myers engine (`synthesizeUnifiedPatch`).
//
// ⚠ NOTHING HERE IS STORED. File bodies are live reads, cached client-side only; the merge base
// is cached in this process's memory per (account, PR, head) because it is the one value two
// different clicks both need and it cannot change while the head does not.
//
// ⚠ EVERY READ IS CLICK-GATED IN THE SPA — never on mount. A PR with 3,000 files would otherwise
// spend 30 calls to paint, and every gap in every file would be a call.

/** GitHub's REST ceiling for `GET /pulls/:n/files` — it lists at most 3,000 files. */
export const PR_FILES_CEILING = 3000;
/** Files per page (GitHub's own per_page cap for this endpoint). */
export const PR_FILES_PER_PAGE = 100;
/** Last page we will ask for: 30 × 100 = the 3,000-file ceiling. */
export const PR_FILES_MAX_PAGE = PR_FILES_CEILING / PR_FILES_PER_PAGE;

/**
 * Per-side size limit for a file body (`/files/content` and `/files/diff`). Past this a file is
 * not something a reader scrolls in a review pane, and the server-side diff of two such sides is
 * the expensive part. Refused with a plain sentence; the GitHub link stays.
 */
export const MAX_FILE_CONTENT_BYTES = 1_000_000;

/** Myers edit-distance budget for a synthesised diff. Past it the file is one replacement hunk. */
const SYNTH_DIFF_MAX_D = 20_000;

interface RestPullFilePage {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  blob_url: string;
  sha: string;
}

/**
 * ONE page of a PR's changed files. `nextPage` is set whenever the page came back FULL and the
 * ceiling is not reached — a full page followed by an empty one costs one harmless extra click,
 * where looking ahead would cost a call on every page. `ceilingReached` is true when this is the
 * last page GitHub will ever serve and it was full: files past 3,000 exist but cannot be listed.
 */
export async function fetchPrFilesPage(
  token: string,
  owner: string,
  name: string,
  number: number,
  page: number,
): Promise<{ files: RestPullFilePage[]; nextPage: number | null; ceilingReached: boolean }> {
  const p = Math.min(Math.max(1, Math.trunc(page)), PR_FILES_MAX_PAGE);
  const files = await ghRestGetFor<RestPullFilePage[]>(
    token,
    `/repos/${owner}/${name}/pulls/${number}/files?per_page=${PR_FILES_PER_PAGE}&page=${p}`,
  );
  const full = files.length >= PR_FILES_PER_PAGE;
  return {
    files,
    nextPage: full && p < PR_FILES_MAX_PAGE ? p + 1 : null,
    ceilingReached: full && p >= PR_FILES_MAX_PAGE,
  };
}

/**
 * Find ONE file's REST patch anywhere in the PR's file list, paging until it turns up. The inline
 * comment route needs this: with the Changes tab now paging past the first 100 files, a reader can
 * comment on file 150, and a first-page-only lookup would refuse that line as "not in the diff".
 */
export async function findPrFileWithPatch(
  token: string,
  owner: string,
  name: string,
  number: number,
  path: string,
): Promise<RestPullFilePage | null> {
  for (let page = 1; page <= PR_FILES_MAX_PAGE; page += 1) {
    const { files, nextPage } = await fetchPrFilesPage(token, owner, name, number, page);
    const hit = files.find((f) => f.filename === path);
    if (hit) return hit;
    if (nextPage == null) return null;
  }
  return null;
}

/**
 * A repo-relative path the SPA may ask for. It only ever names a file inside the PR's own repo
 * (owner/name come from the account-scoped PR row, never the request), so this is hygiene rather
 * than the tenancy boundary — but a `..` segment or a leading slash has no business in a path
 * GitHub listed, and a NUL never reaches a URL.
 */
export function isSafeRepoPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  if (path === '' || path.length > 4096) return false;
  if (path.startsWith('/') || path.includes('\0') || path.includes('\\')) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export type FileAtRef =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'binary' }
  | { kind: 'too_large'; bytes: number | null };

/**
 * One file's raw bytes at `ref` (Accept: application/vnd.github.raw), capped at
 * `MAX_FILE_CONTENT_BYTES` WHILE READING — a 90 MB generated file is refused after one megabyte
 * crosses the wire, not after the whole thing is buffered. A NUL byte marks it binary (git's own
 * test). Throws on any GitHub failure other than a 404, which is the ordinary "this side has no
 * such file" (an added file's base, a deleted file's head).
 */
export async function fetchFileAtRef(
  token: string,
  owner: string,
  name: string,
  path: string,
  ref: string,
): Promise<FileAtRef> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${name}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    {
      method: 'GET',
      headers: {
        authorization: `token ${token}`,
        accept: 'application/vnd.github.raw',
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return { kind: 'missing' };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`GitHub contents ${res.status}: ${text.slice(0, 200)}`), {
      status: res.status,
    });
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FILE_CONTENT_BYTES) {
    await res.body?.cancel().catch(() => {});
    return { kind: 'too_large', bytes: declared };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FILE_CONTENT_BYTES) {
        await reader.cancel().catch(() => {});
        return { kind: 'too_large', bytes: null };
      }
      chunks.push(value);
    }
  }
  const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  if (bytes.includes(0)) return { kind: 'binary' };
  return { kind: 'text', text: bytes.toString('utf8') };
}

// ---- the merge base, cached in memory ----

interface PullRefs {
  head: { sha: string };
  base: { sha: string };
}

interface CompareMergeBase {
  merge_base_commit?: { sha?: string } | null;
}

/** Bounded insertion-ordered cache; the oldest entry goes first. Keyed per account — the key
 *  carries the accountId so one tenant can never read another's resolution. */
const MERGE_BASE_CACHE_MAX = 500;
const mergeBaseCache = new Map<string, { headSha: string; mergeBase: string }>();

/**
 * The two commits the PR's diff is BETWEEN: the head the SPA's patch was read at (the stored head,
 * else GitHub's live one) and the merge base GitHub's three-dot "Files changed" diff is taken
 * against. The base is not stored anywhere (the sync never needed it), so it costs one `pulls`
 * read plus one `compare` — once per (account, PR, head), then from memory.
 */
export async function resolvePrDiffRefs(
  token: string,
  accountId: number,
  prId: number,
  owner: string,
  name: string,
  number: number,
  storedHeadSha: string | null,
): Promise<{ headSha: string; mergeBase: string }> {
  // No stored head ⇒ no cache: the live head can move under a key that does not name it.
  const key = storedHeadSha != null ? `${accountId}:${prId}:${storedHeadSha}` : null;
  const hit = key != null ? mergeBaseCache.get(key) : undefined;
  if (hit) return hit;
  const pull = await ghRestGetFor<PullRefs>(token, `/repos/${owner}/${name}/pulls/${number}`);
  const headSha = storedHeadSha ?? pull.head.sha;
  // `per_page=1`: the compare payload also pages its commit list, which nothing here reads.
  const cmp = await ghRestGetFor<CompareMergeBase>(
    token,
    `/repos/${owner}/${name}/compare/${pull.base.sha}...${headSha}?per_page=1`,
  );
  const mergeBase = cmp.merge_base_commit?.sha ?? pull.base.sha;
  const value = { headSha, mergeBase };
  if (key == null) return value;
  mergeBaseCache.set(key, value);
  while (mergeBaseCache.size > MERGE_BASE_CACHE_MAX) {
    const oldest = mergeBaseCache.keys().next().value;
    if (oldest == null) break;
    mergeBaseCache.delete(oldest);
  }
  return value;
}

/** Test seam: forget every cached merge base. */
export function clearMergeBaseCache(): void {
  mergeBaseCache.clear();
}

// ---- a unified patch from two whole files ----

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/**
 * A header-less unified patch (starting at the first `@@`, exactly the shape GitHub's REST `patch`
 * field has) from the two sides of one file, with `context` unchanged lines around each change.
 * Lines are interned to integers and diffed by `diffTokens` — the conflict resolver's Myers, which
 * is git's own default algorithm, so the hunks land where GitHub's would. A pair past the edit
 * budget degrades to ONE whole-file replacement hunk: coarser, never wrong.
 *
 * Returns `{ patch: '' }` when the two sides are line-identical (a whitespace-at-EOF-only change).
 */
export function synthesizeUnifiedPatch(
  oldText: string,
  newText: string,
  context = 3,
): { patch: string; additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ids = new Map<string, number>();
  const intern = (l: string): number => {
    let id = ids.get(l);
    if (id == null) {
      id = ids.size;
      ids.set(l, id);
    }
    return id;
  };
  const ai = a.map(intern);
  const bi = b.map(intern);
  const changes = diffTokens(ai, bi, SYNTH_DIFF_MAX_D) ?? [
    { aStart: 0, aEnd: a.length, bStart: 0, bEnd: b.length },
  ];
  const real = changes.filter((c) => c.aEnd > c.aStart || c.bEnd > c.bStart);
  if (real.length === 0) return { patch: '', additions: 0, deletions: 0 };

  // Group changes whose context windows touch into one hunk.
  const groups: (typeof real)[] = [];
  for (const c of real) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev && c.aStart - prev.aEnd <= context * 2) last.push(c);
    else groups.push([c]);
  }

  const out: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const g of groups) {
    const first = g[0]!;
    const lastC = g[g.length - 1]!;
    const lead = Math.min(context, first.aStart);
    const aFrom = first.aStart - lead;
    const bFrom = first.bStart - lead;
    const trail = Math.min(context, a.length - lastC.aEnd);
    const aTo = lastC.aEnd + trail;
    const bTo = lastC.bEnd + trail;
    const body: string[] = [];
    let ap = aFrom;
    for (const c of g) {
      for (; ap < c.aStart; ap += 1) body.push(` ${a[ap]}`);
      for (let k = c.aStart; k < c.aEnd; k += 1) {
        body.push(`-${a[k]}`);
        deletions += 1;
      }
      for (let k = c.bStart; k < c.bEnd; k += 1) {
        body.push(`+${b[k]}`);
        additions += 1;
      }
      ap = c.aEnd;
    }
    for (; ap < aTo; ap += 1) body.push(` ${a[ap]}`);
    const aCount = aTo - aFrom;
    const bCount = bTo - bFrom;
    // git's convention: an empty range names the line BEFORE it (0 for the top of the file).
    const aStart = aCount === 0 ? aFrom : aFrom + 1;
    const bStart = bCount === 0 ? bFrom : bFrom + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...body);
  }
  return { patch: out.join('\n'), additions, deletions };
}
