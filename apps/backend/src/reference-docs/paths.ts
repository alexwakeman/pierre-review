import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';

// WHERE A WORKSPACE'S REFERENCE LIBRARY LIVES, and the ONE check that a path a request names is a
// file of it (docs/REFERENCE-DOCS.md § On disk).
//
//   <docsDir>/<accountId>/<workspaceId>/
//     library/                  what agents and the SPA read — and NOTHING else is in it
//       INDEX.md
//       <slug>/CONTENTS.md
//       <slug>/sections/NN-<name>.md
//     sources/<slug>/           the original upload (for Rebuild); never handed to the chat agent
//     staging/<slug>-<n>/       one build's working directory, removed when the build ends
//
// `docsDir` is config.docsDir (`~/.limn/docs`, LIMN_DOCS_DIR overrides). Tests point it elsewhere
// through `setDocsRootForTest` and never touch the real one.

let rootOverride: string | null = null;

/** Test seam: put every library under `dir` (null restores config.docsDir). */
export function setDocsRootForTest(dir: string | null): void {
  rootOverride = dir;
}

// ⚠ UNDER VITEST, NEVER THE REAL LIBRARY. Any suite that erases an account (erase-account.test.ts,
// on a scratch DB whose account 1 is NOT the developer's) would otherwise `rm -rf` the developer's
// own `~/.limn/docs/1`. A suite that wants a library sets one with `setDocsRootForTest`.
const vitestRoot = (): string | null =>
  process.env.VITEST && !process.env.LIMN_DOCS_DIR ? join(tmpdir(), `limn-docs-vitest-${process.pid}`) : null;

export function docsRoot(): string {
  return resolve(rootOverride ?? vitestRoot() ?? config.docsDir);
}

const positiveInt = (n: number): number => {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`not an id: ${n}`);
  return n;
};

export function accountDocsDir(accountId: number): string {
  return join(docsRoot(), String(positiveInt(accountId)));
}
export function workspaceDocsDir(accountId: number, workspaceId: number): string {
  return join(accountDocsDir(accountId), String(positiveInt(workspaceId)));
}
export function libraryDir(accountId: number, workspaceId: number): string {
  return join(workspaceDocsDir(accountId, workspaceId), 'library');
}
export function sourcesDir(accountId: number, workspaceId: number, slug: string): string {
  return join(workspaceDocsDir(accountId, workspaceId), 'sources', assertSlug(slug));
}
export function stagingRoot(accountId: number, workspaceId: number): string {
  return join(workspaceDocsDir(accountId, workspaceId), 'staging');
}

// ---- slugs + file names ----

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SECTION_FILE = /^[0-9]{2,4}-[a-z0-9-]{0,48}\.md$/;

export function assertSlug(slug: string): string {
  if (!SLUG.test(slug)) throw new Error(`not a document slug: ${JSON.stringify(slug)}`);
  return slug;
}

/** A file-name-safe slug: lower case ASCII letters, digits and single hyphens. */
export function slugify(text: string, max = 48): string {
  const base = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return base;
}

/** A document slug from its title, unique among `taken`. Never empty. */
export function uniqueDocSlug(title: string, taken: ReadonlySet<string>): string {
  const base = slugify(title, 48) || 'document';
  const start = /^[a-z0-9]/.test(base) ? base : `doc-${base}`.slice(0, 48);
  if (!taken.has(start)) return start;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${start.slice(0, 48 - String(n).length - 1)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${start.slice(0, 40)}-${Date.now().toString(36)}`;
}

// ---- library paths named by a request (or cited by the chat) ----

export type LibraryPath =
  | { kind: 'index'; path: 'INDEX.md' }
  | { kind: 'contents'; path: string; slug: string }
  | { kind: 'section'; path: string; slug: string; file: string };

/**
 * Parse a library-relative path — `INDEX.md`, `<slug>/CONTENTS.md` or `<slug>/sections/<file>.md` —
 * or return null. ⚠ A STRICT GRAMMAR, not a sanitiser: anything else (`..`, an absolute path, a
 * backslash, a NUL, percent-encoding, a different file) is refused, so a path that parses can only
 * name a file the server itself wrote. An `#anchor` is stripped first and returned beside it.
 */
export function parseLibraryPath(raw: string): { path: LibraryPath; anchor: string | null } | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null;
  const hash = raw.indexOf('#');
  const bare = hash >= 0 ? raw.slice(0, hash) : raw;
  const anchorRaw = hash >= 0 ? raw.slice(hash + 1) : null;
  const anchor = anchorRaw != null && /^[a-z0-9_-]{1,120}$/i.test(anchorRaw) ? anchorRaw : null;
  const clean = bare.startsWith('./') ? bare.slice(2) : bare;
  if (clean === 'INDEX.md') return { path: { kind: 'index', path: 'INDEX.md' }, anchor };
  const parts = clean.split('/');
  if (parts.length === 2 && SLUG.test(parts[0]!) && parts[1] === 'CONTENTS.md') {
    return { path: { kind: 'contents', path: clean, slug: parts[0]! }, anchor };
  }
  if (parts.length === 3 && SLUG.test(parts[0]!) && parts[1] === 'sections' && SECTION_FILE.test(parts[2]!)) {
    return { path: { kind: 'section', path: clean, slug: parts[0]!, file: parts[2]! }, anchor };
  }
  return null;
}

/** True when `p` is `root` or inside it. Both are resolved through symlinks first. */
export function isInside(root: string, p: string): boolean {
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(p);
  } catch {
    return false;
  }
  const rel = relative(realRoot, real);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
