import { describe, expect, it } from 'vitest';
import { normalizeRepoFolder, parseGithubRepoName, type ReferenceDocWikiState } from '@pierre-review/shared';
import { docFolders, githubDocsSource, isRepoDocPath, repoDocToMarkdown, repoPageId, repoPathOfId, shaVersion, type RepoTreeEntry } from './github.js';
import { WikiSourceError, type WikiPageRef } from './source.js';
import { checkWikiTree, syncWikiTree } from './sync.js';

// A GITHUB REPOSITORY AS A WIKI (docs/REFERENCE-DOCS.md § GitHub repositories), through a fake REST GET:
// only text documents, folders as pages, a folder's README as its text, the version from the blob sha
// (so only changed files are read again), the converters, and the status → code mapping.

const sha = (n: number): string => n.toString(16).padStart(4, '0').padEnd(40, 'b');
const blob = (path: string, n: number, size = 100): RepoTreeEntry => ({ path, type: 'blob', sha: sha(n), size });
const dir = (path: string, n: number): RepoTreeEntry => ({ path, type: 'tree', sha: sha(n), size: null });

const TREE: RepoTreeEntry[] = [
  blob('README.md', 1),
  blob('LICENSE.md', 2),
  blob('CHANGELOG.md', 3),
  blob('package.json', 4),
  blob('src/index.ts', 5),
  blob('src/notes.md', 6),
  dir('src', 7),
  dir('docs', 8),
  blob('docs/README.md', 9),
  blob('docs/setup.md', 10),
  blob('docs/api.rst', 11),
  blob('docs/logo.png', 12),
  dir('docs/guides', 13),
  blob('docs/guides/deploy.adoc', 14),
  blob('docs/guides/huge.md', 15, 5 * 1024 * 1024),
  dir('node_modules', 16),
  blob('node_modules/lib/README.md', 17),
  dir('.github', 18),
  blob('.github/CONTRIBUTING.md', 19),
  dir('empty', 20),
  blob('empty/main.go', 21),
];

function fakeGh(entries: RepoTreeEntry[], texts: Record<string, string> = {}): {
  get: <T>(token: string, path: string) => Promise<T>;
  calls: string[];
} {
  const calls: string[] = [];
  const get = async <T,>(_token: string, path: string): Promise<T> => {
    calls.push(path);
    if (path === '/repos/acme/handbook') return { default_branch: 'main' } as T;
    if (path.startsWith('/repos/acme/handbook/git/trees/main')) return { tree: entries, truncated: false } as T;
    const m = /\/git\/blobs\/([0-9a-f]+)$/.exec(path);
    if (m) {
      const e = entries.find((x) => x.sha === m[1]);
      const text = (e && texts[e.path]) ?? `# ${e?.path}\n\nText of ${e?.path}.`;
      return { encoding: 'base64', content: Buffer.from(text).toString('base64') } as T;
    }
    throw Object.assign(new Error('nope'), { status: 404, headers: {} });
  };
  return { get, calls };
}

const CRED = { credential: { email: null, token: 'gh-tok' } };
const ref = (path: string): WikiPageRef => ({
  provider: 'github',
  origin: 'https://github.com',
  host: 'github.com',
  pageId: '',
  scope: { kind: 'repo', owner: 'acme', repo: 'handbook', path, branch: 'main' },
});

describe('which files are documents', () => {
  it('keeps text documents and drops code, binaries, boilerplate and vendored or dot folders', () => {
    expect(isRepoDocPath('docs/setup.md')).toBe(true);
    expect(isRepoDocPath('docs/api.rst')).toBe(true);
    expect(isRepoDocPath('guide.adoc')).toBe(true);
    expect(isRepoDocPath('notes.org')).toBe(true);
    expect(isRepoDocPath('notes.txt')).toBe(true);
    expect(isRepoDocPath('pages/intro.mdx')).toBe(true);
    expect(isRepoDocPath('src/index.ts')).toBe(false);
    expect(isRepoDocPath('package.json')).toBe(false);
    expect(isRepoDocPath('docs/logo.png')).toBe(false);
    expect(isRepoDocPath('docs/paper.pdf')).toBe(false);
    expect(isRepoDocPath('LICENSE.md')).toBe(false);
    expect(isRepoDocPath('CHANGELOG.md')).toBe(false);
    expect(isRepoDocPath('node_modules/x/README.md')).toBe(false);
    expect(isRepoDocPath('vendor/x/doc.md')).toBe(false);
    expect(isRepoDocPath('.github/CONTRIBUTING.md')).toBe(false);
    expect(isRepoDocPath('pnpm-lock.yaml')).toBe(false);
  });

  it('counts the folders holding documents, root first', () => {
    expect(docFolders({ entries: TREE, truncated: false })).toEqual([
      { path: '', docs: 6 },
      { path: 'docs', docs: 4 },
      { path: 'docs/guides', docs: 1 },
      { path: 'src', docs: 1 },
    ]);
  });

  it('page ids are filename-safe and round-trip short paths', () => {
    expect(repoPageId('')).toBe('g');
    expect(repoPathOfId(repoPageId('docs/setup.md'))).toBe('docs/setup.md');
    const long = `docs/${'deep/'.repeat(30)}x.md`;
    expect(repoPageId(long)).toMatch(/^h[0-9a-f]{40}$/);
    expect(repoPathOfId(repoPageId(long))).toBeNull();
    for (const p of ['', 'docs/setup.md', long]) expect(repoPageId(p)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('parses owner/name and folder paths strictly', () => {
    expect(parseGithubRepoName('acme/handbook')).toEqual({ owner: 'acme', repo: 'handbook' });
    expect(parseGithubRepoName('https://github.com/acme/handbook.git')).toEqual({ owner: 'acme', repo: 'handbook' });
    expect(parseGithubRepoName('acme')).toBeNull();
    expect(parseGithubRepoName('acme/../x')).toBeNull();
    expect(normalizeRepoFolder('/docs/guides/')).toBe('docs/guides');
    expect(normalizeRepoFolder('')).toBe('');
    expect(normalizeRepoFolder('docs/../etc')).toBeNull();
  });
});

describe('converting', () => {
  it('turns reStructuredText, AsciiDoc and Org headings into markdown ones', () => {
    expect(repoDocToMarkdown('a.rst', '=====\nTitle\n=====\n\nIntro\n\nSetup\n-----\n\nText\n\nMore\n-----\n')).toBe('# Title\n\nIntro\n\n## Setup\n\nText\n\n## More\n');
    expect(repoDocToMarkdown('a.adoc', '= Guide\n:toc:\n\n== Deploy\nText')).toBe('# Guide\n\n## Deploy\nText');
    expect(repoDocToMarkdown('a.org', '#+TITLE: Notes\n#+AUTHOR: x\n* One\n** Two\nbody')).toBe('# Notes\n# One\n## Two\nbody');
    expect(repoDocToMarkdown('a.mdx', "import X from './x'\n\n# Hi\n<X />")).toBe('\n# Hi\n<X />');
    expect(repoDocToMarkdown('a.md', '# Same\r\ntext')).toBe('# Same\ntext');
  });
});

describe('the adapter', () => {
  it('resolves a folder, lists its documents and sub-folders in reading order, and reads a README as the folder', async () => {
    const { get } = fakeGh(TREE);
    const src = githubDocsSource({ get });
    const root = await src.resolveRoot!(ref('docs'), CRED);
    expect(root.ref.pageId).toBe(repoPageId('docs'));
    expect(root.title).toBe('handbook/docs');
    const { pages, more } = await src.listDescendants(root.ref, root.ref.pageId, 32, 99, CRED);
    expect(more).toBe(false);
    expect(pages.map((p) => [repoPathOfId(p.id), p.depth])).toEqual([
      ['docs/api.rst', 1],
      ['docs/setup.md', 1],
      ['docs/guides', 1],
      ['docs/guides/deploy.adoc', 2],
    ]);
    const folder = await src.getPage(root.ref, root.ref.pageId, { ...CRED, body: true });
    expect(await src.toMarkdown(folder)).toContain('Text of docs/README.md.');
    expect(folder.version).toBe(shaVersion(sha(9)));
  });

  it('a missing folder or repository reads as not found, and a 401 as unauthorized', async () => {
    const { get } = fakeGh(TREE);
    await expect(githubDocsSource({ get }).resolveRoot!(ref('nope'), CRED)).rejects.toMatchObject({ code: 'not_found' });
    const denied = githubDocsSource({ get: async () => Promise.reject(Object.assign(new Error('x'), { status: 401, headers: {} })) });
    await expect(denied.resolveRoot!(ref(''), CRED)).rejects.toBeInstanceOf(WikiSourceError);
    await expect(denied.resolveRoot!(ref(''), CRED)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('a refresh reads only the file whose bytes changed', async () => {
    let entries = TREE.slice();
    let now = 0;
    const fake = fakeGh(entries);
    const src = githubDocsSource({ get: fake.get, now: () => now });
    const root = await src.resolveRoot!(ref('docs'), CRED);
    const state: ReferenceDocWikiState = {
      provider: 'github',
      origin: 'https://github.com',
      rootPageId: root.ref.pageId,
      rootUrl: 'https://github.com/acme/handbook/tree/main/docs',
      depth: 32,
      pageCount: null,
      pagesLeftOut: 0,
      lastCheckedAt: null,
      lastListedAt: null,
      lastChangedAt: null,
      unreachableSince: null,
      unreachableReason: null,
      retryAfter: null,
      scope: root.scope,
      rootTitle: root.title,
    };
    const cache = new Map<string, string>();
    const first = await syncWikiTree({ source: src, site: root.ref, state, stored: [], credential: CRED.credential, readCached: (id) => cache.get(id) ?? null, full: true, now: new Date(1000) });
    expect(first.pages).toHaveLength(5);
    for (const p of first.pages) cache.set(p.pageId, p.markdown);
    const stored = first.pages.map((p) => ({ ...p }));
    const after = { ...state, lastCheckedAt: 1000, lastListedAt: 1000 };

    // Nothing moved: the cheap check says so.
    now = 120_000;
    expect((await checkWikiTree({ source: src, site: root.ref, state: after, stored, credential: CRED.credential, now: new Date(2000) })).changed).toBe(false);

    // setup.md's bytes change: only it is read again.
    entries = entries.map((e) => (e.path === 'docs/setup.md' ? { ...e, sha: sha(99) } : e));
    const fake2 = fakeGh(entries);
    const src2 = githubDocsSource({ get: fake2.get, now: () => now });
    expect((await checkWikiTree({ source: src2, site: root.ref, state: after, stored, credential: CRED.credential, now: new Date(3000) })).changed).toBe(true);
    const second = await syncWikiTree({ source: src2, site: root.ref, state: after, stored, credential: CRED.credential, readCached: (id) => cache.get(id) ?? null, full: false, now: new Date(3000) });
    expect(second.fetched).toBe(1);
    expect(fake2.calls.filter((c) => c.includes('/git/blobs/'))).toEqual([`/repos/acme/handbook/git/blobs/${sha(99)}`]);
  });

  it('a folder past the page cap does not read as changed on every check', async () => {
    const many: RepoTreeEntry[] = [dir('big', 1), ...Array.from({ length: 140 }, (_, i) => blob(`big/p${String(i).padStart(3, '0')}.md`, 1000 + i))];
    const src = githubDocsSource({ get: fakeGh(many).get, now: () => 0 });
    const root = await src.resolveRoot!(ref('big'), CRED);
    const state: ReferenceDocWikiState = {
      provider: 'github',
      origin: 'https://github.com',
      rootPageId: root.ref.pageId,
      rootUrl: 'https://github.com/acme/handbook/tree/main/big',
      depth: 32,
      pageCount: null,
      pagesLeftOut: 0,
      lastCheckedAt: null,
      lastListedAt: null,
      lastChangedAt: null,
      unreachableSince: null,
      unreachableReason: null,
      retryAfter: null,
      scope: root.scope,
      rootTitle: root.title,
    };
    const first = await syncWikiTree({ source: src, site: root.ref, state, stored: [], credential: CRED.credential, readCached: () => null, full: true, now: new Date(1000) });
    expect(first.pages).toHaveLength(100);
    expect(first.pagesLeftOut).toBeGreaterThan(0);
    const cache = new Map(first.pages.map((p) => [p.pageId, p.markdown]));
    const after = { ...state, lastCheckedAt: 1000, lastListedAt: 1000, pagesLeftOut: first.pagesLeftOut };
    const check = await checkWikiTree({ source: src, site: root.ref, state: after, stored: first.pages, credential: CRED.credential, now: new Date(2000) });
    expect(check.changed).toBe(false);
    expect(cache.size).toBe(100);
  });
});
