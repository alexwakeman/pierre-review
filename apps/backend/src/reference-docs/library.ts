import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accountDocsDir,
  assertSlug,
  docsRoot,
  isInside,
  libraryDir,
  sourcesDir,
  stagingRoot,
  workspaceDocsDir,
  type LibraryPath,
} from './paths.js';
import { renderIndex } from './render.js';
import { indexEntries, workspacesWithDocs } from './store.js';

// THE LIBRARY ON DISK (docs/REFERENCE-DOCS.md § On disk). Plain markdown files, like Claude Code's
// memory: the agents read them with Read/Glob/Grep, the SPA reads them through GET /api/docs/section.
// Every write here is the SERVER's — a build's output is assembled in a staging folder and moved into
// place in one rename, so a reader never sees half a document and a failed rebuild leaves the last
// good version where it was.

const atomicWrite = (path: string, text: string): void => {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
};

// INDEX.md writes per workspace run one after another: two builds finishing together must not
// interleave their reads of the rows with their writes of the file.
const indexChains = new Map<string, Promise<void>>();

/** Rewrite INDEX.md from the stored rows of every built document. Deterministic; never a model. */
export function writeIndex(accountId: number, workspaceId: number): Promise<void> {
  const key = `${accountId}:${workspaceId}`;
  const prev = indexChains.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const entries = await indexEntries(accountId, workspaceId);
      const dir = libraryDir(accountId, workspaceId);
      mkdirSync(dir, { recursive: true });
      atomicWrite(join(dir, 'INDEX.md'), renderIndex(entries));
    });
  indexChains.set(key, next);
  void next.finally(() => {
    if (indexChains.get(key) === next) indexChains.delete(key);
  });
  return next;
}

/** Move a rendered document folder into the library, replacing the previous version. */
export function installDocFolder(accountId: number, workspaceId: number, slug: string, renderedDir: string): void {
  const lib = libraryDir(accountId, workspaceId);
  mkdirSync(lib, { recursive: true });
  const target = join(lib, assertSlug(slug));
  const old = `${join(stagingRoot(accountId, workspaceId), `.old-${slug}`)}-${process.pid}-${Date.now()}`;
  mkdirSync(stagingRoot(accountId, workspaceId), { recursive: true });
  if (existsSync(target)) renameSync(target, old);
  try {
    renameSync(renderedDir, target);
  } catch (err) {
    if (!existsSync(target) && existsSync(old)) renameSync(old, target);
    throw err;
  }
  rmSync(old, { recursive: true, force: true });
}

/** Remove a document's files (its library folder and its stored source). */
export function removeDocFiles(accountId: number, workspaceId: number, slug: string): void {
  rmSync(join(libraryDir(accountId, workspaceId), assertSlug(slug)), { recursive: true, force: true });
  rmSync(sourcesDir(accountId, workspaceId, slug), { recursive: true, force: true });
}

/** Erasure: every library of the account, on disk. */
export function removeAccountDocs(accountId: number): void {
  rmSync(accountDocsDir(accountId), { recursive: true, force: true });
}

/** A deleted workspace: its library, sources and staging. */
export function removeWorkspaceDocs(accountId: number, workspaceId: number): void {
  rmSync(workspaceDocsDir(accountId, workspaceId), { recursive: true, force: true });
}

// ---- sources (for Rebuild) ----

export function saveSource(accountId: number, workspaceId: number, slug: string, body: Buffer, ext: string): void {
  const dir = sourcesDir(accountId, workspaceId, slug);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `source.${ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin'}`), body);
}

export function readSource(accountId: number, workspaceId: number, slug: string): { body: Buffer; ext: string } | null {
  const dir = sourcesDir(accountId, workspaceId, slug);
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => /^source\.[a-z0-9]+$/i.test(f));
  if (!file) return null;
  return { body: readFileSync(join(dir, file)), ext: file.slice('source.'.length) };
}

// ---- reads ----

/**
 * The text of one library file, or null. `path` comes from `parseLibraryPath` (a strict grammar), and
 * the resolved file must still sit inside the workspace's library after symlinks are followed.
 */
export function readLibraryFile(accountId: number, workspaceId: number, path: LibraryPath): string | null {
  const lib = libraryDir(accountId, workspaceId);
  const abs = join(lib, ...path.path.split('/'));
  if (!existsSync(abs) || !isInside(lib, abs)) return null;
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** INDEX.md, written first if it is not there yet. */
export async function readIndex(accountId: number, workspaceId: number): Promise<string> {
  const p = join(libraryDir(accountId, workspaceId), 'INDEX.md');
  if (!existsSync(p)) await writeIndex(accountId, workspaceId);
  return readFileSync(p, 'utf8');
}

// ---- the janitor ----

/**
 * Boot: remove what no row accounts for — a library folder or source of a deleted document or
 * workspace, and every leftover staging folder (a build that died with the process).
 */
export async function sweepDocsOnStartup(): Promise<number> {
  const root = docsRoot();
  if (!existsSync(root)) return 0;
  const rows = await workspacesWithDocs();
  const wanted = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = `${r.accountId}/${r.workspaceId}`;
    if (!wanted.has(k)) wanted.set(k, new Set());
    wanted.get(k)!.add(r.slug);
  }
  let removed = 0;
  for (const acct of readdirSync(root)) {
    if (!/^\d+$/.test(acct)) continue;
    for (const ws of readdirSync(join(root, acct))) {
      if (!/^\d+$/.test(ws)) continue;
      const wsDir = join(root, acct, ws);
      rmSync(join(wsDir, 'staging'), { recursive: true, force: true });
      const slugs = wanted.get(`${acct}/${ws}`);
      for (const sub of ['library', 'sources']) {
        const d = join(wsDir, sub);
        if (!existsSync(d)) continue;
        for (const name of readdirSync(d)) {
          if (sub === 'library' && name === 'INDEX.md') continue;
          if (slugs?.has(name)) continue;
          rmSync(join(d, name), { recursive: true, force: true });
          removed += 1;
        }
      }
      // A workspace with nothing left: its INDEX.md is regenerated on the next read.
      if (!slugs) {
        rmSync(wsDir, { recursive: true, force: true });
      }
    }
  }
  return removed;
}
