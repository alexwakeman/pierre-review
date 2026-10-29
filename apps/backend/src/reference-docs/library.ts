import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accountDocsDir,
  assertSlug,
  docsRoot,
  isInside,
  legacyDocsRoot,
  libraryDir,
  sourcesDir,
  stagingRoot,
  workspaceDocsDir,
  type LibraryPath,
} from './paths.js';
import {
  claimWorkspaceDir,
  docFolderNames,
  isForeignDir,
  loadDocsOwner,
  migrateLegacyDocs,
  readOwnerMarker,
  type LegacyDocsMove,
} from './owner.js';
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
      await loadDocsOwner().catch(() => null);
      claimWorkspaceDir(workspaceDocsDir(accountId, workspaceId));
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
  claimWorkspaceDir(workspaceDocsDir(accountId, workspaceId));
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

/** Remove a document's files (its library folder and its stored source). Never in another DB's folder. */
export function removeDocFiles(accountId: number, workspaceId: number, slug: string): void {
  if (isForeignDir(workspaceDocsDir(accountId, workspaceId))) return;
  rmSync(join(libraryDir(accountId, workspaceId), assertSlug(slug)), { recursive: true, force: true });
  rmSync(sourcesDir(accountId, workspaceId, slug), { recursive: true, force: true });
}

/**
 * Erasure: every library of the account, on disk — except a workspace folder another database owns
 * (`.owner`, reference-docs/owner.ts). The account folder goes once nothing is left in it.
 */
export function removeAccountDocs(accountId: number): void {
  const dir = accountDocsDir(accountId);
  if (!existsSync(dir)) return;
  for (const ws of readdirSync(dir)) {
    const wsDir = join(dir, ws);
    if (isForeignDir(wsDir)) continue;
    rmSync(wsDir, { recursive: true, force: true });
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
}

/** A deleted workspace: its library, sources and staging — unless another database owns the folder. */
export function removeWorkspaceDocs(accountId: number, workspaceId: number): void {
  const wsDir = workspaceDocsDir(accountId, workspaceId);
  if (isForeignDir(wsDir)) return;
  rmSync(wsDir, { recursive: true, force: true });
}

// ---- sources (for Rebuild) ----

export function saveSource(accountId: number, workspaceId: number, slug: string, body: Buffer, ext: string): void {
  claimWorkspaceDir(workspaceDocsDir(accountId, workspaceId));
  const dir = sourcesDir(accountId, workspaceId, slug);
  // The previous source FILE goes; the folders beside it stay (a wiki's `pages/`, the figures a build
  // just stored in `figures/` — pruned after a successful build, figures.ts `pruneFigures`).
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (/^source\.[a-z0-9]+$/i.test(f)) rmSync(join(dir, f), { force: true });
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

export interface DocsSweepResult {
  /** Library / source folders removed (a whole unwanted workspace folder counts its documents). */
  removed: number;
  /** `<acct>/<ws>` folders with no `.owner` that hold documents: left as they are, never deleted. */
  leftUnowned: string[];
  /** `<acct>/<ws>` folders another database's `.owner` names: never entered. */
  leftForeign: string[];
}

/**
 * Remove what no row accounts for — a library folder or source of a deleted document or workspace,
 * and every leftover staging folder (a build that died with the process) — in the workspace folders
 * THIS database owns. ⚠ A folder whose `.owner` names another database is never entered; a folder
 * with no `.owner` is never deleted from (reference-docs/owner.ts). Pure over its arguments.
 */
export function sweepDocsRoot(
  root: string,
  rows: ReadonlyArray<{ accountId: number; workspaceId: number; slug: string }>,
  me: string | null,
): DocsSweepResult {
  const out: DocsSweepResult = { removed: 0, leftUnowned: [], leftForeign: [] };
  if (!existsSync(root)) return out;
  const wanted = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = `${r.accountId}/${r.workspaceId}`;
    if (!wanted.has(k)) wanted.set(k, new Set());
    wanted.get(k)!.add(r.slug);
  }
  for (const acct of readdirSync(root)) {
    if (!/^\d+$/.test(acct)) continue;
    for (const ws of readdirSync(join(root, acct))) {
      if (!/^\d+$/.test(ws)) continue;
      const key = `${acct}/${ws}`;
      const wsDir = join(root, acct, ws);
      const marker = readOwnerMarker(wsDir);
      if (marker == null || me == null) {
        // Not provably ours: leave all of it. Report it only when it holds something to lose.
        const { library, sources } = docFolderNames(wsDir);
        if (library.length > 0 || sources.length > 0) out.leftUnowned.push(key);
        continue;
      }
      if (marker !== me) {
        out.leftForeign.push(key);
        continue;
      }
      rmSync(join(wsDir, 'staging'), { recursive: true, force: true });
      const slugs = wanted.get(key);
      for (const sub of ['library', 'sources']) {
        const d = join(wsDir, sub);
        if (!existsSync(d)) continue;
        for (const name of readdirSync(d)) {
          if (sub === 'library' && name === 'INDEX.md') continue;
          if (slugs?.has(name)) continue;
          rmSync(join(d, name), { recursive: true, force: true });
          out.removed += 1;
        }
      }
      // Our workspace with no document left: INDEX.md is regenerated from the rows on the next read.
      if (!slugs) rmSync(wsDir, { recursive: true, force: true });
    }
  }
  return out;
}

/**
 * Boot, as THIS database: first the one-time move of its own folders out of the root every database
 * used to share (owner.ts `migrateLegacyDocs`), then the janitor over its own root.
 */
export async function sweepDocsOnStartup(): Promise<DocsSweepResult & { migration: LegacyDocsMove }> {
  const me = await loadDocsOwner();
  const rows = await workspacesWithDocs();
  const root = docsRoot();
  const migration = migrateLegacyDocs({ legacyRoot: legacyDocsRoot(), root, rows, me });
  return { ...sweepDocsRoot(root, rows, me), migration };
}
