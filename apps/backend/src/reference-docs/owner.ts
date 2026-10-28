import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getInstanceId } from '../db/instance-id.js';

// WHICH DATABASE OWNS A WORKSPACE DOCS FOLDER (docs/REFERENCE-DOCS.md § On disk → Ownership).
//
// Every `<root>/<accountId>/<workspaceId>/` folder this process creates gets a `.owner` file holding
// THIS database's random id (db/instance-id.ts). Account and workspace ids are small integers that
// every database reuses, so the folder name alone never says whose it is.
//
// ⚠ NOTHING DELETES A FOLDER IT CANNOT PROVE IS ITS OWN. The boot janitor, a workspace delete and an
// account erase all skip a folder whose `.owner` names another database. A folder with NO `.owner`
// (written before the marker existed) is left alone by the janitor, too — a library that is not
// cleaned costs disk; a library that is deleted cannot be rebuilt without its sources.
//
// ⚠ A FOLDER IS CLAIMED ONLY WHEN IT IS EMPTY. `claimWorkspaceDir` writes the marker into a folder
// that has no document folders yet (new, or only an INDEX.md). An unmarked folder that already holds
// documents may be another database's, so it stays unmarked — except through `migrateLegacyDocs`,
// which proves the match against this database's rows first.

export const OWNER_FILE = '.owner';

let ownerId: string | null = null;

/** Read (and cache) this database's id. Boot calls it before the janitor; writeIndex awaits it. */
export async function loadDocsOwner(): Promise<string> {
  if (ownerId) return ownerId;
  ownerId = await getInstanceId();
  return ownerId;
}

/** The cached id, or null before `loadDocsOwner` has run. */
export function docsOwnerId(): string | null {
  return ownerId;
}

/** Test seam: pretend to be the database with this id (null forgets it). */
export function setDocsOwnerForTest(id: string | null): void {
  ownerId = id;
}

/** The id in a workspace folder's `.owner`, or null when there is none. */
export function readOwnerMarker(wsDir: string): string | null {
  try {
    const text = readFileSync(join(wsDir, OWNER_FILE), 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Does the folder name ANOTHER database? (Any marker counts as foreign while our id is unknown.) */
export function isForeignDir(wsDir: string, me: string | null = ownerId): boolean {
  const marker = readOwnerMarker(wsDir);
  return marker != null && marker !== me;
}

/** The document folders a workspace folder holds: library entries but INDEX.md, plus sources. */
export function docFolderNames(wsDir: string): { library: string[]; sources: string[] } {
  const list = (sub: string): string[] => {
    try {
      return readdirSync(join(wsDir, sub)).filter((n) => !(sub === 'library' && n === 'INDEX.md'));
    } catch {
      return [];
    }
  };
  return { library: list('library'), sources: list('sources') };
}

function writeMarker(wsDir: string, id: string): void {
  writeFileSync(join(wsDir, OWNER_FILE), `${id}\n`);
}

/**
 * Create a workspace folder (if needed) and mark it as this database's — but only while it holds no
 * document folders (see the header). A no-op before `loadDocsOwner` has run.
 */
export function claimWorkspaceDir(wsDir: string, me: string | null = ownerId): void {
  mkdirSync(wsDir, { recursive: true });
  if (!me || readOwnerMarker(wsDir) != null) return;
  const { library, sources } = docFolderNames(wsDir);
  if (library.length > 0 || sources.length > 0) return;
  try {
    writeMarker(wsDir, me);
  } catch {
    /* unmarked just means "never swept" */
  }
}

export interface LegacyDocsMove {
  moved: string[];
  /** `<acct>/<ws>` folders this database has rows for that were left in the shared root, and why. */
  left: Array<{ key: string; reason: 'foreign_owner' | 'unproven' | 'rename_failed'; error?: string }>;
}

/**
 * THE ONE-TIME MOVE out of the root every database used to share. For each workspace this database
 * has documents in, whose folder is NOT yet in `root` but IS in `legacyRoot`: move it with ONE
 * rename, and mark it — when it is provably this database's:
 *   - its `.owner` is our id, or
 *   - it has no `.owner`, holds at least one document folder, and EVERY document folder in it is a
 *     slug this database has a row for in that workspace.
 * Anything else is left exactly where it is (and reported). Never clobbers: an existing target
 * folder means the move already happened. Safe on every boot.
 */
export function migrateLegacyDocs(opts: {
  legacyRoot: string | null;
  root: string;
  rows: ReadonlyArray<{ accountId: number; workspaceId: number; slug: string }>;
  me: string;
}): LegacyDocsMove {
  const out: LegacyDocsMove = { moved: [], left: [] };
  const { legacyRoot, root, me } = opts;
  if (!legacyRoot || resolve(legacyRoot) === resolve(root) || !existsSync(legacyRoot)) return out;
  const wanted = new Map<string, Set<string>>();
  for (const r of opts.rows) {
    const k = `${r.accountId}/${r.workspaceId}`;
    if (!wanted.has(k)) wanted.set(k, new Set());
    wanted.get(k)!.add(r.slug);
  }
  for (const [key, slugs] of wanted) {
    const [acct, ws] = key.split('/') as [string, string];
    const from = join(legacyRoot, acct, ws);
    const to = join(root, acct, ws);
    if (!existsSync(from) || existsSync(to)) continue;
    const marker = readOwnerMarker(from);
    if (marker != null && marker !== me) {
      out.left.push({ key, reason: 'foreign_owner' });
      continue;
    }
    if (marker == null) {
      const { library, sources } = docFolderNames(from);
      const all = [...library, ...sources];
      if (all.length === 0 || !all.every((n) => slugs.has(n))) {
        out.left.push({ key, reason: 'unproven' });
        continue;
      }
    }
    try {
      mkdirSync(join(root, acct), { recursive: true });
      renameSync(from, to);
    } catch (err) {
      out.left.push({ key, reason: 'rename_failed', error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    try {
      if (marker == null) writeMarker(to, me);
    } catch {
      /* moved; unmarked just means "never swept" */
    }
    out.moved.push(key);
  }
  return out;
}
