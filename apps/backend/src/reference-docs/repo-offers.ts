import {
  DOCS_OFFER_ANY_FOLDER_MIN_FILES,
  DOCS_OFFER_BYTES_PER_WORD,
  DOCS_OFFER_FAILURE_RETRY_HOURS,
  DOCS_OFFER_FOLDER_NAMES,
  DOCS_OFFER_MIN_FILES,
  DOCS_OFFER_MIN_WORDS,
  DOCS_OFFER_RESCAN_DAYS,
  DOCS_FROM_REPOS_SCAN_MAX,
  REFERENCE_DOC_MAX_BYTES,
  REFERENCE_DOC_WIKI_MAX_PAGES,
  type RepoDocsOffer,
  type RepoDocsUnreadable,
  type RepoDocsUnreadableReason,
} from '@pierre-review/shared';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { onRepoWalked } from '../sync/walk-listeners.js';
import { resolveWikiCredential } from './wiki/credentials.js';
import { README_NAMES, folderTree, githubDocsSource, type Folder, type RepoTree } from './wiki/github.js';
import { WikiSourceError, wikiSourceFor } from './wiki/source.js';
import './wiki/register.js';
import {
  inLibrary,
  libraryGithubFolders,
  listRepoFolders,
  listUnreadableRepos,
  recordRepoUnreadable,
  recordScan,
  stampRepoScanned,
  workspaceOfRepo,
  type OfferCandidate,
} from './repo-offers-store.js';

// FINDING THE REPOSITORIES' OWN DOCS (docs/REFERENCE-DOCS.md § Docs offered from your repositories).
//
// After a repository's walk — its first sync's foreground pass, and any later walk once
// DOCS_OFFER_RESCAN_DAYS have passed — the repository's default-branch tree is listed ONCE (the add-
// documents wizard's own tree call, on the account's GitHub quota) and its docs folders are recorded
// as OFFERS. ⚠ NOTHING IS BUILT HERE: a build spends AI, so a document is queued only when the reader
// presses Add (repo-offers routes). No file is read: words are estimated from the tree's sizes.
//
// A folder QUALIFIES (`qualifyingDocFolders`) when ALL of these hold:
//   • it is a docs-style folder (DOCS_OFFER_FOLDER_NAMES, at any depth), or it holds at least
//     DOCS_OFFER_ANY_FOLDER_MIN_FILES documents directly;
//   • it holds at least DOCS_OFFER_MIN_FILES documents (sub-folders included), not all of them
//     READMEs, and about DOCS_OFFER_MIN_WORDS words;
// and it is offered as `tooLarge` (a pointer to the wizard, never added from the offer) when one
// document could not hold it (REFERENCE_DOC_WIKI_MAX_PAGES pages, REFERENCE_DOC_MAX_BYTES bytes).
// The repository's top folder is never offered (it would take in every folder below it), and a
// folder inside a qualifying one is not offered separately.

const DAY_MS = 86_400_000;
const FOLDER_NAMES = new Set(DOCS_OFFER_FOLDER_NAMES);

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const stem = (p: string): string => {
  const b = basename(p);
  const dot = b.lastIndexOf('.');
  return (dot > 0 ? b.slice(0, dot) : b).toLowerCase();
};
const isReadme = (p: string): boolean => README_NAMES.includes(stem(p));

interface FolderStats {
  files: number;
  nonReadme: number;
  bytes: number;
  /** Pages the wiki import would make: the folder itself, each document, each sub-folder below. */
  pages: number;
}

function statsOf(f: Folder): FolderStats {
  const s: FolderStats = { files: 0, nonReadme: 0, bytes: 0, pages: 1 };
  const walk = (x: Folder, isTop: boolean): void => {
    if (!isTop) s.pages += 1;
    const docs = x.readme ? [x.readme, ...x.docs] : x.docs;
    for (const d of docs) {
      s.files += 1;
      s.bytes += d.size ?? 0;
      if (!isReadme(d.path)) s.nonReadme += 1;
    }
    s.pages += x.docs.length;
    for (const c of x.folders) if (c.count > 0) walk(c, false);
  };
  walk(f, true);
  return s;
}

/** Words, estimated from bytes. Pure. */
export const estimateWords = (bytes: number): number => Math.round(bytes / DOCS_OFFER_BYTES_PER_WORD);

/** The repository's docs folders worth offering, outermost first by path. Pure. */
export function qualifyingDocFolders(tree: RepoTree): OfferCandidate[] {
  const out: OfferCandidate[] = [];
  const visit = (f: Folder): void => {
    if (f.path !== '') {
      const direct = f.docs.length + (f.readme ? 1 : 0);
      const looksLikeDocs = FOLDER_NAMES.has(basename(f.path).toLowerCase()) || direct >= DOCS_OFFER_ANY_FOLDER_MIN_FILES;
      if (looksLikeDocs) {
        const s = statsOf(f);
        const words = estimateWords(s.bytes);
        if (s.files >= DOCS_OFFER_MIN_FILES && s.nonReadme > 0 && words >= DOCS_OFFER_MIN_WORDS) {
          out.push({
            path: f.path,
            docs: s.files,
            words,
            pages: s.pages,
            tooLarge: s.pages > REFERENCE_DOC_WIKI_MAX_PAGES || s.bytes > REFERENCE_DOC_MAX_BYTES,
          });
          return; // a folder inside it is not offered separately
        }
      }
    }
    for (const c of f.folders) visit(c);
  };
  visit(folderTree(tree, ''));
  return out;
}

/** Is a scan due for a repository last looked at `scannedAt`? Pure. */
export function offerScanDue(scannedAt: Date | null, now: number): boolean {
  return scannedAt == null || now - scannedAt.getTime() >= DOCS_OFFER_RESCAN_DAYS * DAY_MS;
}

/**
 * A FAILED look backs off (docs/REFERENCE-DOCS.md § A repository whose files can't be read): no new look
 * until DOCS_OFFER_FAILURE_RETRY_HOURS after the last failure, so a repository that keeps failing is read
 * at most once a day (each failure moves the stamp). Pure.
 */
export function offerScanBackedOff(failedAt: Date | null, now: number): boolean {
  return failedAt != null && now - failedAt.getTime() < DOCS_OFFER_FAILURE_RETRY_HOURS * 3_600_000;
}

/** GitHub's answer to the tree read → the stored reason. Pure. */
export function unreadableReasonOf(err: unknown): RepoDocsUnreadableReason {
  if (!(err instanceof WikiSourceError)) return 'unavailable';
  if (err.code === 'unauthorized' || err.code === 'forbidden') return 'no_access';
  if (err.code === 'not_found') return 'not_found';
  // GitHub answers 409 "Git Repository is empty." for a repository with no commits.
  if (err.code === 'http' && err.status === 409) return 'empty';
  return 'unavailable';
}

export type ScanOutcome =
  | 'not_due'
  | 'backed_off'
  | 'no_repo'
  | 'no_workspace'
  | 'no_credential'
  | 'unreachable'
  | 'scanned';

export interface ScanDeps {
  /** The tree reader (a test passes a fake). */
  source?: Pick<ReturnType<typeof githubDocsSource>, 'defaultBranch' | 'listTree'>;
  /** The token (a test passes one; otherwise the `gh` sign-in through the credential ladder). */
  token?: string;
  now?: () => number;
  /** Look even when the last look was recent. (A failure's back-off still holds.) */
  force?: boolean;
}

/**
 * Look at one repository's tree and record its docs folders as offers for its workspace. Reads
 * GitHub at most twice (the default branch when the sync has not stored it, then the tree) and runs
 * NO model. Never throws for GitHub's answers: an unreachable repository's FAILURE is recorded (when
 * and why, `recordRepoUnreadable`) and it is not looked at again for DOCS_OFFER_FAILURE_RETRY_HOURS —
 * the scan runs after EVERY walk, so without that an unreadable repository was read on every walk. Its
 * PR sync is untouched. A later look that succeeds clears the failure.
 */
export async function scanRepoForDocOffers(accountId: number, repoId: number, deps: ScanDeps = {}): Promise<ScanOutcome> {
  const now = deps.now ?? Date.now;
  const r = schema.repos;
  const rows = await db
    .select({
      owner: r.owner,
      name: r.name,
      defaultBranch: r.defaultBranch,
      scannedAt: r.docsOfferScannedAt,
      failedAt: r.docsOfferFailedAt,
    })
    .from(r)
    .where(and(eq(r.id, repoId), eq(r.accountId, accountId)))
    .limit(1)
    .execute();
  const repo = rows[0];
  if (!repo) return 'no_repo';
  if (offerScanBackedOff(repo.failedAt ?? null, now())) return 'backed_off';
  if (!deps.force && !offerScanDue(repo.scannedAt ?? null, now())) return 'not_due';
  const workspaceId = await workspaceOfRepo(accountId, repoId);
  if (workspaceId == null) return 'no_workspace';
  let token = deps.token;
  if (token == null) {
    const cred = await resolveWikiCredential(accountId, workspaceId, { provider: 'github', host: 'github.com' });
    if (cred.state !== 'ok') return 'no_credential';
    token = cred.credential.token;
  }
  const gh = deps.source ?? ((wikiSourceFor('github') ?? githubDocsSource()) as ReturnType<typeof githubDocsSource>);
  const call = { credential: { email: null, token } };
  let tree: RepoTree;
  try {
    const branch = repo.defaultBranch ?? (await gh.defaultBranch(repo.owner, repo.name, call));
    tree = await gh.listTree(repo.owner, repo.name, branch, call);
  } catch (err) {
    await recordRepoUnreadable(accountId, repoId, unreadableReasonOf(err), new Date(now()));
    return 'unreachable';
  }
  const library = await libraryGithubFolders(accountId, workspaceId);
  // EVERY qualifying folder is recorded — the ones already in Docs as 'added' (`held`) — so the wizard's
  // "From your repositories" can list a folder again once its document is removed, with no new read.
  const found = qualifyingDocFolders(tree);
  const held = new Set(found.filter((c) => inLibrary(`${repo.owner}/${repo.name}`, c.path, library)).map((c) => c.path));
  await recordScan(accountId, workspaceId, repoId, found, new Date(now()), held);
  await stampRepoScanned(accountId, repoId, new Date(now()));
  return 'scanned';
}

// ---- the wizard's "From your repositories" ----

export interface FolderCheck {
  folders: RepoDocsOffer[];
  /** Repositories not looked at this time (over the cap, or no credential). */
  notLookedAt: number;
  /** Repositories whose files could not be read (stored; this check's failures included). */
  unreadable: RepoDocsUnreadable[];
}

/**
 * THE SAME CHECK, ON DEMAND (docs/REFERENCE-DOCS.md § The SPA → From your repositories): every qualifying
 * folder in the workspace's repositories that is not in Docs, whatever the offer card's state. A
 * repository looked at within DOCS_OFFER_RESCAN_DAYS is answered from its STORED scan (no GitHub read);
 * one never looked at (or due again) is scanned now — ≤ DOCS_FROM_REPOS_SCAN_MAX per check, through the
 * shared tree reader and its short-lived cache, oldest first. A repository whose files could not be
 * read is not looked at again before its back-off ends; it is listed under `unreadable`, from the stored
 * failure. Runs NO model.
 */
export async function checkWorkspaceRepoFolders(accountId: number, workspaceId: number, deps: Omit<ScanDeps, 'force'> = {}): Promise<FolderCheck> {
  const now = deps.now ?? Date.now;
  const r = schema.repos;
  const wr = schema.workspaceRepos;
  const repos = await db
    .select({ id: r.id, scannedAt: r.docsOfferScannedAt, failedAt: r.docsOfferFailedAt })
    .from(wr)
    .innerJoin(r, and(eq(r.id, wr.repoId), eq(r.accountId, wr.accountId)))
    .where(and(eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId)))
    .execute();
  const due = repos
    .filter((x) => offerScanDue(x.scannedAt ?? null, now()) && !offerScanBackedOff(x.failedAt ?? null, now()))
    .sort((a, b) => (a.scannedAt?.getTime() ?? -1) - (b.scannedAt?.getTime() ?? -1) || a.id - b.id);
  let notLookedAt = Math.max(0, due.length - DOCS_FROM_REPOS_SCAN_MAX);
  for (const x of due.slice(0, DOCS_FROM_REPOS_SCAN_MAX)) {
    const res = await scanRepoForDocOffers(accountId, x.id, deps);
    // An unreadable one is listed under `unreadable` instead (its failure is stored).
    if (res !== 'scanned' && res !== 'not_due' && res !== 'unreachable' && res !== 'backed_off') notLookedAt += 1;
  }
  return {
    folders: await listRepoFolders(accountId, workspaceId),
    notLookedAt,
    unreadable: await listUnreadableRepos(accountId, workspaceId),
  };
}

// ---- after a walk ----

let bound = false;
let chain: Promise<void> = Promise.resolve();
const waiting = new Set<number>();

/**
 * Boot (review/agentic.ts, so only where the library exists): look at each repository after its walk.
 * One look at a time across the process, a repository queued once; never awaited by the sync.
 */
export function bindRepoDocOffers(log: { info(msg: string): void; warn(obj: unknown, msg?: string): void }): void {
  if (bound) return;
  bound = true;
  onRepoWalked((accountId, repoId) => {
    if (waiting.has(repoId)) return;
    waiting.add(repoId);
    chain = chain
      .then(async () => {
        waiting.delete(repoId);
        const res = await scanRepoForDocOffers(accountId, repoId);
        if (res === 'scanned') log.info(`docs offers: looked at repo ${repoId}`);
      })
      .catch((err) => {
        waiting.delete(repoId);
        log.warn({ err }, `docs offers: repo ${repoId} not looked at`);
      });
  });
}
