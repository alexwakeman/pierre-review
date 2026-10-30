import { createHash } from 'node:crypto';
import { isNonCodeFile } from '../../db/code-loc.js';
import { ghRestGetFor, isRateLimitError } from '../../github/client.js';
import type { WikiScope } from '@pierre-review/shared';
import { WikiSourceError, type WikiCallOptions, type WikiPage, type WikiPageMeta, type WikiPageRef, type WikiSource } from './source.js';

// A GITHUB REPOSITORY'S DOCUMENTS AS A WIKI (docs/REFERENCE-DOCS.md § GitHub repositories). The third
// `WikiSource`: a folder of a repository (the root, or `docs/`, …) on its default branch is the ROOT
// page, every folder below it holding a text document is a page, and every text document is a page —
// so the import, the change check, the per-page cache and the incremental rebuild are the wiki's own.
//
//   tree      GET /repos/{o}/{r}/git/trees/{branch}?recursive=1   every path, its blob sha and size
//   a page    GET /repos/{o}/{r}/git/blobs/{sha}                  the document's text (base64)
//
// ⚠ ONLY TEXT DOCUMENTS (`isRepoDocPath`): markdown, MDX, reStructuredText, AsciiDoc, Org and plain
// text, never code, binaries, images, lockfiles or anything under a vendored / generated / build folder
// or a dot-folder. A folder's README (or index) is that folder's own text, not a child page.
//
// THE PAGE ID is the path, base64url (`g…`, filename-safe for the page cache) — or, for a path too long
// for that, `h` + a sha256 of it, found again through the tree. THE VERSION is a number taken from the
// file's blob sha, so the sync's version compare sees exactly the files whose bytes changed. The change
// check lists the tree (ONE request) and reports every document — over, never under; the sync keeps
// only the moved ones.
//
// AUTH: the reader's own `gh` token (auth/account.ts `getAccessToken`, via the credential ladder), on
// the account's GitHub quota. ⚠ Never logged.

/** Text documents, by extension (lower-cased). */
export const REPO_DOC_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'rst', 'txt', 'adoc', 'asciidoc', 'org']);
/** A document over this is skipped (a generated reference dump, not prose a reader wrote). */
export const REPO_DOC_MAX_BYTES = 1024 * 1024;
/** Folders never read, matched as a whole path segment anywhere. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'vendor',
  'vendored',
  'third_party',
  'thirdparty',
  '3rdparty',
  'dist',
  'build',
  'out',
  'target',
  'generated',
  'gen',
  'autogen',
  'coverage',
  '__snapshots__',
  '__pycache__',
  '__fixtures__',
  'fixtures',
  'testdata',
  'site-packages',
  'bower_components',
  'jspm_packages',
]);
/** Boilerplate a library does not need (licences, changelogs, ownership files). */
const SKIPPED_BASENAMES = /^(?:license|licence|copying|notice|patents|authors|contributors|codeowners|changelog|changes|history|news)(?:\.[a-z0-9]+)?$/i;
const README_NAMES = ['readme', 'index', '_index'];

/**
 * Is this repository path a TEXT DOCUMENT the library reads? A fifth question, beside the four path
 * classifiers (db/code-loc.ts names them) — it REUSES `isNonCodeFile` as its first gate (so anything
 * that classifier counts as code is out), then keeps only the document extensions and drops vendored /
 * generated / dot folders and boilerplate. It folds nothing into `isNonCodeFile`.
 */
export function isRepoDocPath(path: string): boolean {
  const p = path.replace(/^\/+/, '');
  if (p === '' || !isNonCodeFile(p)) return false;
  const segs = p.split('/');
  const base = segs[segs.length - 1]!;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!.toLowerCase();
    if (seg.startsWith('.') || SKIPPED_DIRS.has(seg)) return false;
  }
  if (base.startsWith('.') || SKIPPED_BASENAMES.test(base)) return false;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return REPO_DOC_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** A path → its page id: `g` + base64url(path), or `h` + sha256 when that would not fit 64 chars. */
export function repoPageId(path: string): string {
  const b = Buffer.from(path, 'utf8').toString('base64url');
  return b.length <= 63 ? `g${b}` : `h${createHash('sha256').update(path).digest('hex').slice(0, 40)}`;
}

/** A `g…` id → its path, or null (an `h…` id is found through the tree). */
export function repoPathOfId(id: string): string | null {
  if (!id.startsWith('g')) return null;
  try {
    return Buffer.from(id.slice(1), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** A blob sha → the version number the sync compares (48 bits: exact in a double). */
export const shaVersion = (sha: string): number => Number.parseInt(sha.slice(0, 12), 16) || 0;

export interface RepoTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size: number | null;
}

export interface RepoTree {
  entries: RepoTreeEntry[];
  truncated: boolean;
}

/** One folder's place in the document tree: its README (if any) and what is below it. */
interface Folder {
  path: string;
  readme: RepoTreeEntry | null;
  docs: RepoTreeEntry[];
  folders: Folder[];
  /** Documents in it and every folder below. */
  count: number;
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const stem = (p: string): string => {
  const b = basename(p);
  const dot = b.lastIndexOf('.');
  return (dot > 0 ? b.slice(0, dot) : b).toLowerCase();
};

/**
 * The tree → the folder hierarchy under `root` ('' = the repository): documents only, folders with no
 * document anywhere below them pruned, each folder's README taken as its own text. Pure; exported for
 * its test.
 */
export function folderTree(tree: RepoTree, root: string): Folder {
  const prefix = root === '' ? '' : `${root}/`;
  const docs = tree.entries.filter(
    (e) => e.type === 'blob' && (root === '' || e.path.startsWith(prefix)) && isRepoDocPath(e.path) && (e.size == null || e.size <= REPO_DOC_MAX_BYTES),
  );
  const folders = new Map<string, Folder>();
  const folder = (path: string): Folder => {
    let f = folders.get(path);
    if (!f) {
      f = { path, readme: null, docs: [], folders: [], count: 0 };
      folders.set(path, f);
      if (path !== root) folder(dirname(path)).folders.push(f);
    }
    return f;
  };
  folder(root);
  for (const d of docs) {
    const f = folder(dirname(d.path));
    f.docs.push(d);
  }
  const sortByName = (a: { path: string }, b: { path: string }): number => a.path.localeCompare(b.path, 'en');
  const settle = (f: Folder): number => {
    f.docs.sort(sortByName);
    // The folder's own text: README first, then index — and only a markdown-ish one.
    for (const name of README_NAMES) {
      const r = f.docs.find((d) => stem(d.path) === name);
      if (r) {
        f.readme = r;
        f.docs = f.docs.filter((d) => d !== r);
        break;
      }
    }
    f.folders.sort(sortByName);
    let n = f.docs.length + (f.readme ? 1 : 0);
    for (const c of f.folders) n += settle(c);
    f.count = n;
    return n;
  };
  const top = folders.get(root)!;
  settle(top);
  return top;
}

/** Every folder that holds a document (itself or below), root first then by path, with its count. */
export function docFolders(tree: RepoTree, limit = 300): Array<{ path: string; docs: number }> {
  const out: Array<{ path: string; docs: number }> = [];
  const walk = (f: Folder): void => {
    if (out.length >= limit || (f.count === 0 && f.path !== '')) return;
    out.push({ path: f.path, docs: f.count });
    for (const c of f.folders) walk(c);
  };
  walk(folderTree(tree, ''));
  return out;
}

/** Turn a non-markdown text document's headings into markdown ones; markdown passes through. Pure. */
export function repoDocToMarkdown(path: string, text: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (ext === 'md' || ext === 'markdown') return text.replace(/\r\n?/g, '\n');
  if (ext === 'mdx') {
    // MDX: drop the top-level import / export lines (code, not prose); JSX stays as text.
    return lines.filter((l) => !/^(?:import|export)\s/.test(l)).join('\n');
  }
  if (ext === 'adoc' || ext === 'asciidoc') {
    // `= Title`, `== Section` … → `#`, `##` …; attribute lines (`:toc:`) dropped.
    return lines
      .filter((l) => !/^:[A-Za-z0-9_-]+:/.test(l))
      .map((l) => {
        const m = /^(={1,6})\s+(\S.*)$/.exec(l);
        return m ? `${'#'.repeat(m[1]!.length)} ${m[2]}` : l;
      })
      .join('\n');
  }
  if (ext === 'org') {
    // `* Heading`, `** Sub` … → `#`, `##` …; `#+TITLE:` → the title; other `#+` keywords dropped.
    const out: string[] = [];
    for (const l of lines) {
      const t = /^#\+title:\s*(.+)$/i.exec(l);
      if (t) {
        out.push(`# ${t[1]}`);
        continue;
      }
      if (/^#\+/.test(l)) continue;
      const m = /^(\*{1,6})\s+(\S.*)$/.exec(l);
      out.push(m ? `${'#'.repeat(m[1]!.length)} ${m[2]}` : l);
    }
    return out.join('\n');
  }
  if (ext === 'rst') {
    // A title is a line underlined (and maybe overlined) by one repeated punctuation character at least
    // as long as it; each new character is the next level down, in the order the document uses them.
    const order: string[] = [];
    const out: string[] = [];
    const isRule = (l: string | undefined): boolean => l != null && /^([=\-`:'"~^_*+#<>.])\1{2,}\s*$/.test(l);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const next = lines[i + 1];
      if (isRule(l) && i + 2 < lines.length && lines[i + 1]!.trim() !== '' && isRule(lines[i + 2]) && lines[i + 2]![0] === l[0]) {
        // Overlined title: rule, text, rule.
        const key = `o${l[0]}`;
        if (!order.includes(key)) order.push(key);
        out.push(`${'#'.repeat(Math.min(6, order.indexOf(key) + 1))} ${lines[i + 1]!.trim()}`);
        i += 2;
        continue;
      }
      if (l.trim() !== '' && !isRule(l) && next != null && isRule(next) && next.trim().length >= l.trim().length) {
        const key = `u${next[0]}`;
        if (!order.includes(key)) order.push(key);
        out.push(`${'#'.repeat(Math.min(6, order.indexOf(key) + 1))} ${l.trim()}`);
        i += 1;
        continue;
      }
      out.push(l);
    }
    return out.join('\n');
  }
  // Plain text: as it is.
  return lines.join('\n');
}

// ---- the adapter ----

export interface GithubDocsDeps {
  /** One REST GET with the reader's token (a test passes a fake). Throws the client's error. */
  get?: <T>(token: string, path: string) => Promise<T>;
  now?: () => number;
}

/** How long one listed tree serves the page reads of a build (the build reads it once a minute). */
const TREE_TTL_MS = 60_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The client's thrown error → the wiki's code (never the upstream body). */
export function githubErrorCode(err: unknown): WikiSourceError {
  if (err instanceof WikiSourceError) return err;
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null;
  if (status == null) return new WikiSourceError('network');
  const limit = isRateLimitError(err);
  if (limit.limited) return new WikiSourceError('rate_limited', status, limit.resumeAt ? Math.max(0, limit.resumeAt.getTime() - Date.now()) : null);
  if (status === 404) return new WikiSourceError('not_found', 404);
  if (status === 401) return new WikiSourceError('unauthorized', 401);
  if (status === 403) return new WikiSourceError('forbidden', 403);
  return new WikiSourceError('http', status);
}

type RepoScope = Extract<WikiScope, { kind: 'repo' }>;

function repoOf(site: WikiPageRef): RepoScope {
  const s = site.scope;
  if (s?.kind !== 'repo') throw new WikiSourceError('bad_url');
  return s;
}

const enc = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

export function githubDocsSource(deps: GithubDocsDeps = {}): WikiSource & {
  /** The repository's default branch (the wizard's first read). */
  defaultBranch(owner: string, repo: string, opts: WikiCallOptions): Promise<string>;
  /** The repository's tree on a branch (one request, cached briefly). */
  listTree(owner: string, repo: string, branch: string, opts: WikiCallOptions): Promise<RepoTree>;
} {
  const get = deps.get ?? (<T>(token: string, path: string): Promise<T> => ghRestGetFor<T>(token, path));
  const now = deps.now ?? Date.now;
  const call = async <T>(opts: WikiCallOptions, path: string): Promise<T> => {
    if (opts.signal?.aborted) throw new WikiSourceError('network');
    try {
      return await get<T>(opts.credential.token, path);
    } catch (err) {
      throw githubErrorCode(err);
    }
  };
  const trees = new Map<string, { at: number; tree: RepoTree }>();
  const listTree = async (owner: string, repo: string, branch: string, opts: WikiCallOptions): Promise<RepoTree> => {
    const key = `${owner}/${repo}@${branch}`;
    const hit = trees.get(key);
    if (hit && now() - hit.at < TREE_TTL_MS) return hit.tree;
    const raw = obj(await call<unknown>(opts, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`));
    const entries: RepoTreeEntry[] = [];
    for (const e of Array.isArray(raw?.tree) ? raw!.tree : []) {
      const o = obj(e);
      const path = str(o?.path);
      const sha = str(o?.sha);
      const type = o?.type === 'blob' || o?.type === 'tree' ? o.type : null;
      if (!path || !sha || !SHA.test(sha) || !type || path.length > 1024) continue;
      entries.push({ path, type, sha, size: typeof o?.size === 'number' ? o.size : null });
    }
    const tree = { entries, truncated: raw?.truncated === true };
    trees.set(key, { at: now(), tree });
    if (trees.size > 20) trees.delete(trees.keys().next().value!);
    return tree;
  };
  /** The page id → its folder or document, through the tree. */
  const locate = (top: Folder, id: string): { folder: Folder | null; doc: RepoTreeEntry | null } => {
    const stack: Folder[] = [top];
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (repoPageId(f.path) === id) return { folder: f, doc: null };
      for (const d of f.docs) if (repoPageId(d.path) === id) return { folder: null, doc: d };
      stack.push(...f.folders);
    }
    return { folder: null, doc: null };
  };
  const topOf = async (site: WikiPageRef, opts: WikiCallOptions): Promise<{ top: Folder; scope: RepoScope }> => {
    const scope = repoOf(site);
    const tree = await listTree(scope.owner, scope.repo, scope.branch, opts);
    // A folder that is not in the tree (deleted, renamed) reads as gone.
    if (scope.path !== '' && !tree.entries.some((e) => e.type === 'tree' && e.path === scope.path)) throw new WikiSourceError('not_found', 404);
    const top = folderTree(tree, scope.path);
    return { top, scope };
  };
  const titleOf = (scope: RepoScope, path: string): string =>
    path === scope.path ? (scope.path === '' ? `${scope.owner}/${scope.repo}` : `${scope.repo}/${scope.path}`) : basename(path);
  const webUrl = (scope: RepoScope, path: string, isDir: boolean): string =>
    `https://github.com/${enc(scope.owner)}/${enc(scope.repo)}/${isDir ? 'tree' : 'blob'}/${enc(scope.branch)}${path ? `/${enc(path)}` : ''}`;

  return {
    provider: 'github',
    // A repository is never pasted into the web-page form: the wizard's own route builds the reference.
    resolveRef: () => null,
    defaultBranch: async (owner, repo, opts) => {
      const raw = obj(await call<unknown>(opts, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`));
      const b = str(raw?.default_branch);
      if (!b) throw new WikiSourceError('not_json');
      return b;
    },
    listTree,
    async resolveRoot(ref, opts) {
      const { top, scope } = await topOf(ref, opts);
      return { ref: { ...ref, pageId: repoPageId(top.path), scope }, title: titleOf(scope, top.path), scope };
    },
    async getPage(site, pageId, opts) {
      const { top, scope } = await topOf(site, opts);
      const { folder, doc } = locate(top, pageId);
      if (!folder && !doc) throw new WikiSourceError('not_found', 404);
      const file = doc ?? folder!.readme;
      const path = doc ? doc.path : folder!.path;
      const base: WikiPage = {
        id: pageId,
        title: titleOf(scope, path),
        parentId: path === scope.path ? null : repoPageId(dirname(path)),
        // A folder's version is its README's (no README: 0 — its children carry their own).
        version: file ? shaVersion(file.sha) : 0,
        editedAt: null,
        depth: 0,
        position: null,
        body: '',
        webUrl: webUrl(scope, path, doc == null),
      };
      if (!opts.body || !file) return base;
      const raw = obj(await call<unknown>(opts, `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/git/blobs/${file.sha}`));
      const content = str(raw?.content);
      if (content == null) throw new WikiSourceError('not_json');
      const text = raw?.encoding === 'base64' ? Buffer.from(content, 'base64').toString('utf8') : content;
      if (text.includes('\u0000')) return base; // binary after all
      return { ...base, body: JSON.stringify({ v: 1, path: file.path, text }) };
    },
    async listDescendants(site, rootId, depth, cap, opts) {
      const { top } = await topOf(site, opts);
      if (repoPageId(top.path) !== rootId) throw new WikiSourceError('not_found', 404);
      const pages: WikiPageMeta[] = [];
      let more = false;
      // Reading order: a folder's documents, then its sub-folders (each with its own, depth-first).
      const walk = (f: Folder, d: number): void => {
        if (d >= depth) return;
        let position = 0;
        const add = (id: string, title: string, version: number): boolean => {
          if (pages.length >= cap) {
            more = true;
            return false;
          }
          pages.push({ id, title, parentId: repoPageId(f.path), version, editedAt: null, depth: d + 1, position: position++ });
          return true;
        };
        for (const doc of f.docs) if (!add(repoPageId(doc.path), basename(doc.path), shaVersion(doc.sha))) return;
        for (const c of f.folders) {
          if (c.count === 0) continue;
          if (!add(repoPageId(c.path), basename(c.path), c.readme ? shaVersion(c.readme.sha) : 0)) return;
          walk(c, d + 1);
        }
      };
      walk(top, 0);
      return { pages, more };
    },
    async changedSince(site, _rootId, _since, opts) {
      // The tree carries every file's blob sha: report every page with its version (over, never under —
      // the sync keeps only those whose version moved, and reads only those).
      const { top } = await topOf(site, opts);
      const out: WikiPageMeta[] = [];
      const stack: Folder[] = [top];
      while (stack.length > 0) {
        const f = stack.pop()!;
        out.push({ id: repoPageId(f.path), title: '', parentId: null, version: f.readme ? shaVersion(f.readme.sha) : 0, editedAt: null, depth: 0, position: null });
        for (const d of f.docs) out.push({ id: repoPageId(d.path), title: '', parentId: null, version: shaVersion(d.sha), editedAt: null, depth: 0, position: null });
        stack.push(...f.folders.filter((c) => c.count > 0));
      }
      return out;
    },
    async toMarkdown(page) {
      if (page.body === '') return '';
      try {
        const b = JSON.parse(page.body) as { path?: unknown; text?: unknown };
        if (typeof b.path !== 'string' || typeof b.text !== 'string') return '';
        return repoDocToMarkdown(b.path, b.text);
      } catch {
        return '';
      }
    },
    async checkAccess(_site, opts) {
      await call(opts, '/rate_limit');
    },
    pageUrl(site, pageId) {
      const scope = repoOf(site);
      const path = repoPathOfId(pageId);
      // A folder and a document read the same address form (`tree/` vs `blob/` both redirect on GitHub),
      // so the URL never depends on the tree: a fetched and a cached page bundle identically.
      return path == null ? webUrl(scope, scope.path, true) : webUrl(scope, path, !isRepoDocPath(path));
    },
  };
}
