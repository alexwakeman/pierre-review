// THE REPOSITORIES' OWN DOCS, OFFERED (docs/REFERENCE-DOCS.md § Docs offered from your repositories).
//
// After a repository's first sync (and again at most every DOCS_OFFER_RESCAN_DAYS), the server lists the
// repository's default-branch tree ONCE and finds the folders that look like a docs collection. They are
// OFFERED — on the Docs page and as a card on Pending — and NOTHING is built until the reader presses Add:
// building a document runs the AI. "Not now" hides the card for DOCS_OFFER_SNOOZE_DAYS; after that, the
// folders still not added may be offered again. Every folder stays importable from the add-documents
// wizard's "From your repositories", which runs the SAME check. Every threshold lives here, once.

/** Folder names that read as a docs collection, matched (lower-cased) at any depth. */
export const DOCS_OFFER_FOLDER_NAMES: readonly string[] = ['docs', 'doc', 'documentation', 'handbook', 'wiki', 'adr', 'decisions'];
/** Any other folder qualifies when it holds at least this many documents DIRECTLY (not in a sub-folder). */
export const DOCS_OFFER_ANY_FOLDER_MIN_FILES = 5;
/** A qualifying folder holds at least this many documents, its sub-folders included. */
export const DOCS_OFFER_MIN_FILES = 3;
/** …and at least this many words in all. */
export const DOCS_OFFER_MIN_WORDS = 1500;
/** Words are ESTIMATED from the tree's file sizes (no file is read): bytes ÷ this. */
export const DOCS_OFFER_BYTES_PER_WORD = 6;
/** A repository is looked at again after this many days, so a folder that qualifies later is offered once. */
export const DOCS_OFFER_RESCAN_DAYS = 14;
/** "Not now" hides the workspace's offer card (Pending and Docs) for this many days. */
export const DOCS_OFFER_SNOOZE_DAYS = 30;
/** The wizard's "From your repositories" looks at most this many not-yet-looked-at repositories per check
 *  (each costs one or two GitHub reads); the rest are counted, and looked at by the next check. */
export const DOCS_FROM_REPOS_SCAN_MAX = 20;

/** After a repository's files could not be read for the offers, no new look for this long; then at
 *  most once a day while it keeps failing. A later look that succeeds clears the failure. */
export const DOCS_OFFER_FAILURE_RETRY_HOURS = 24;

/**
 * Why Limn could not read a repository's files for the offers (stored on the repository, migration 0158):
 * 'no_access' (GitHub said 401/403), 'empty' (409: no commits), 'not_found' (404), 'unavailable' (GitHub
 * did not answer: network, rate limit, a server error). The repository's PR sync is never affected.
 */
export type RepoDocsUnreadableReason = 'no_access' | 'empty' | 'not_found' | 'unavailable';

/** One repository whose files could not be read, as the wizard's "From your repositories" lists it. */
export interface RepoDocsUnreadable {
  repoId: number;
  /** `owner/name`. */
  repoFullName: string;
  reason: RepoDocsUnreadableReason;
  /** When the last look failed (ISO-8601). */
  failedAt: string;
}

const UNREADABLE_REASONS: readonly RepoDocsUnreadableReason[] = ['no_access', 'empty', 'not_found', 'unavailable'];

/** A stored failure code → the reason (null = none stored; an unknown code reads as 'unavailable'). */
export function asUnreadableReason(v: string | null | undefined): RepoDocsUnreadableReason | null {
  if (v == null) return null;
  return (UNREADABLE_REASONS as readonly string[]).includes(v) ? (v as RepoDocsUnreadableReason) : 'unavailable';
}

const UNREADABLE_REASON: Record<RepoDocsUnreadableReason, string> = {
  no_access: 'no access',
  empty: 'the repository is empty',
  not_found: 'not found on GitHub',
  unavailable: 'GitHub did not answer',
};

/** The reasons that LAST — the reader can act on them, or they hold until something on GitHub changes. */
const LASTING_UNREADABLE_REASONS: ReadonlySet<RepoDocsUnreadableReason> = new Set(['no_access', 'empty', 'not_found']);

/**
 * Whether a stored failure is SHOWN to the reader (the repo status panel's line, the wizard's unreadable
 * list): only the lasting reasons. 'unavailable' (network, rate limit, a server error) is transient and
 * never shown — it still sets the DOCS_OFFER_FAILURE_RETRY_HOURS back-off like every other reason.
 */
export function isRepoDocsUnreadableShown(reason: RepoDocsUnreadableReason | null | undefined): reason is RepoDocsUnreadableReason {
  return reason != null && LASTING_UNREADABLE_REASONS.has(reason);
}

/** The reason, in a few words ("no access", "the repository is empty", …). */
export function repoDocsUnreadableReasonText(reason: RepoDocsUnreadableReason): string {
  return UNREADABLE_REASON[reason] ?? UNREADABLE_REASON.unavailable;
}

/** The repository page's line: "Limn can't read this repository's files, so its docs can't be offered: no access." */
export function repoDocsUnreadableLine(reason: RepoDocsUnreadableReason): string {
  return `Limn can’t read this repository’s files, so its docs can’t be offered: ${repoDocsUnreadableReasonText(reason)}.`;
}

/** One folder offered to the reader. */
export interface RepoDocsOffer {
  id: number;
  repoId: number;
  /** `owner/name`. */
  repoFullName: string;
  /** The folder in the repository, e.g. `docs` or `handbook/engineering`. */
  path: string;
  /** Documents in it, its sub-folders included. */
  docs: number;
  /** Words, estimated from the file sizes. */
  words: number;
  /** Past one document's limits (pages or bytes): offered only as a pointer to the add-documents wizard,
   *  never added from the offer. */
  tooLarge: boolean;
}

/** The offers for one workspace, with the per-build spend cap a cost line may quote. */
export interface RepoDocsOffers {
  offers: RepoDocsOffer[];
  /** `DOCS_BUILD_BUDGET_USD`: the most one build may spend. */
  budgetUsd: number;
}

/** POST /api/docs/offers/add and /api/docs/offers/dismiss. */
export interface RepoDocsOffersBody {
  workspaceId?: number;
  ids: number[];
  /** Add only: 'wizard' = the add-documents wizard's "From your repositories" — a folder whose earlier
   *  document was since removed may be added again. Absent = the offer card. */
  from?: 'card' | 'wizard';
}

/** POST /api/docs/offers/check — the wizard's "From your repositories". */
export interface RepoDocsCheckBody {
  workspaceId?: number;
}

/** POST /api/docs/offers/check: every qualifying folder in the workspace's repositories that is not in
 *  Docs yet, whatever the card's state ("Not now" or not). */
export interface RepoDocsCheckResponse {
  workspaceId: number;
  folders: RepoDocsOffer[];
  /** Repositories not looked at by this check (over DOCS_FROM_REPOS_SCAN_MAX, or no GitHub sign-in). */
  notLookedAt: number;
  /** Repositories whose files could not be read (the STORED failure, newest first by name): not looked at
   *  again until DOCS_OFFER_FAILURE_RETRY_HOURS have passed. Absent on an older server. */
  unreadable?: RepoDocsUnreadable[];
  /** `DOCS_BUILD_BUDGET_USD`: the most one build may spend. */
  budgetUsd: number;
}

/** POST /api/docs/offers/add — one entry per id asked for. */
export interface RepoDocsOffersAddResponse {
  /** The documents queued for a build. */
  added: Array<{ offerId: number; docId: number }>;
  /** Offers not added, each with its sentence. */
  failed: Array<{ offerId: number; message: string }>;
}

/** POST /api/docs/offers/dismiss. */
export interface RepoDocsOffersDismissResponse {
  dismissed: number;
}

/** "Add 2 docs collections from your repositories?" — the offer's question. */
export function docsOfferQuestion(n: number): string {
  return n === 1 ? 'Add a docs collection from your repositories?' : `Add ${n} docs collections from your repositories?`;
}
