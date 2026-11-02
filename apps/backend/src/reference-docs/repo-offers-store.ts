import { and, asc, eq, inArray, isNotNull, max, notInArray, sql } from 'drizzle-orm';
import {
  asUnreadableReason,
  DOCS_OFFER_SNOOZE_DAYS,
  type RepoDocsOffer,
  type RepoDocsOffers,
  type RepoDocsUnreadable,
  type RepoDocsUnreadableReason,
} from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';

// THE OFFERS' ROWS (migration 0155; docs/REFERENCE-DOCS.md § Docs offered from your repositories).
// Database only — Pending's board reads `docsOffersFor` in the same request as its cards, so this
// module imports nothing that reads GitHub or runs a model. Every read and write carries the ACCOUNT
// predicate, and an id from a request resolves only within (account, workspace).
//
// A row's `state`: 'offered' (waiting), 'declined' (the card's "Not now": the card is hidden for
// DOCS_OFFER_SNOOZE_DAYS from the latest one, `decided_at`; after that the folder is offered again) or
// 'added' (a document was queued, or the scan found the folder already in Docs). The wizard's "From your
// repositories" lists EVERY row not in the library, whatever its state (`listRepoFolders`).

const t = () => schema.referenceDocRepoOffers;

export type OfferRow = typeof schema.referenceDocRepoOffers.$inferSelect;

/** What the scan found for one folder. */
export interface OfferCandidate {
  path: string;
  docs: number;
  words: number;
  pages: number;
  tooLarge: boolean;
}

/** A GitHub folder already in the library: `owner/name` (lower-cased) and its path. */
export interface LibraryFolder {
  repo: string;
  path: string;
}

/** Do two repository folders overlap — one is the other, or holds it? ('' is the whole repository.) Pure. */
export function foldersOverlap(a: string, b: string): boolean {
  if (a === b || a === '' || b === '') return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Is this folder already in the library (itself, a folder holding it, or one inside it)? Pure. */
export function inLibrary(repo: string, path: string, library: readonly LibraryFolder[]): boolean {
  const r = repo.toLowerCase();
  return library.some((l) => l.repo === r && foldersOverlap(l.path, path));
}

/** The workspace's GitHub documents, as folders (read from the stored wiki JSON). */
export async function libraryGithubFolders(accountId: number, workspaceId: number): Promise<LibraryFolder[]> {
  const d = schema.referenceDocs;
  const rows = await db
    .select({ wiki: d.wiki })
    .from(d)
    .where(and(eq(d.accountId, accountId), eq(d.workspaceId, workspaceId), eq(d.sourceKind, 'wiki')))
    .execute();
  const out: LibraryFolder[] = [];
  for (const r of rows) {
    const w = r.wiki as { provider?: unknown; scope?: { kind?: unknown; owner?: unknown; repo?: unknown; path?: unknown } } | null;
    const s = w?.provider === 'github' ? w.scope : null;
    if (s?.kind !== 'repo' || typeof s.owner !== 'string' || typeof s.repo !== 'string' || typeof s.path !== 'string') continue;
    out.push({ repo: `${s.owner}/${s.repo}`.toLowerCase(), path: s.path });
  }
  return out;
}

/** The repository's workspace (a repo is in exactly one), or null. */
export async function workspaceOfRepo(accountId: number, repoId: number): Promise<number | null> {
  const wr = schema.workspaceRepos;
  const rows = await db
    .select({ workspaceId: wr.workspaceId })
    .from(wr)
    .where(and(eq(wr.accountId, accountId), eq(wr.repoId, repoId)))
    .limit(1)
    .execute();
  return rows[0]?.workspaceId ?? null;
}

const DAY_MS = 86_400_000;
/** The states a scan may still move (an 'added' row is history: never deleted, never re-stated). */
const OPEN_STATES = ['offered', 'declined'];

/**
 * Record what one scan of a repository found, for its workspace — EVERY qualifying folder (`found`),
 * with the ones already in Docs named in `held`: a new folder is inserted as 'offered' ('added' when
 * held); a folder already known keeps its STATE (a "Not now" or an add is never undone) and only its
 * counts move, except that an open one now held becomes 'added'; an open ('offered' / 'declined')
 * folder the scan no longer finds is removed. Returns how many folders are on offer for the repository
 * afterwards.
 */
export async function recordScan(
  accountId: number,
  workspaceId: number,
  repoId: number,
  found: readonly OfferCandidate[],
  now: Date = new Date(),
  held: ReadonlySet<string> = new Set(),
): Promise<number> {
  for (const c of found) {
    await db
      .insert(t())
      .values({
        accountId,
        workspaceId,
        repoId,
        path: c.path,
        docCount: c.docs,
        wordEstimate: c.words,
        pageCount: c.pages,
        tooLarge: c.tooLarge,
        state: held.has(c.path) ? 'added' : 'offered',
        detectedAt: now,
        ...(held.has(c.path) ? { decidedAt: now } : {}),
      })
      .onConflictDoUpdate({
        target: [t().accountId, t().workspaceId, t().repoId, t().path],
        // ⚠ Never `state`: the reader's decision stands (a held folder is moved below).
        set: { docCount: c.docs, wordEstimate: c.words, pageCount: c.pages, tooLarge: c.tooLarge },
      })
      .execute();
  }
  const repoScope = and(eq(t().accountId, accountId), eq(t().workspaceId, workspaceId), eq(t().repoId, repoId));
  if (held.size > 0) {
    await db
      .update(t())
      .set({ state: 'added', decidedAt: now })
      .where(and(repoScope, inArray(t().state, OPEN_STATES), inArray(t().path, [...held])))
      .execute();
  }
  const keep = found.map((c) => c.path);
  const open = and(repoScope, inArray(t().state, OPEN_STATES));
  await db
    .delete(t())
    .where(keep.length > 0 ? and(open, notInArray(t().path, keep)) : open)
    .execute();
  const left = await db
    .select({ id: t().id })
    .from(t())
    .where(and(repoScope, eq(t().state, 'offered')))
    .execute();
  return left.length;
}

/** Stamp the repository as looked at — and clear any earlier failure to read it (a success wins). */
export async function stampRepoScanned(accountId: number, repoId: number, at: Date = new Date()): Promise<void> {
  const r = schema.repos;
  await db
    .update(r)
    .set({ docsOfferScannedAt: at, docsOfferFailedAt: null, docsOfferFailure: null })
    .where(and(eq(r.id, repoId), eq(r.accountId, accountId)))
    .execute();
}

/**
 * Record that the repository's files could not be read: when and why. `docs_offer_scanned_at` is left
 * as it was (the last SUCCESSFUL look, whose offers stand). The repository is not looked at again for
 * DOCS_OFFER_FAILURE_RETRY_HOURS (`offerScanBackedOff`). Never touches the PR sync.
 */
export async function recordRepoUnreadable(
  accountId: number,
  repoId: number,
  reason: RepoDocsUnreadableReason,
  at: Date = new Date(),
): Promise<void> {
  const r = schema.repos;
  await db
    .update(r)
    .set({ docsOfferFailedAt: at, docsOfferFailure: reason })
    .where(and(eq(r.id, repoId), eq(r.accountId, accountId)))
    .execute();
}

/** The workspace's repositories whose files could not be read (the STORED failure), by name. */
export async function listUnreadableRepos(accountId: number, workspaceId: number): Promise<RepoDocsUnreadable[]> {
  const r = schema.repos;
  const wr = schema.workspaceRepos;
  const rows = await db
    .select({ id: r.id, owner: r.owner, name: r.name, failedAt: r.docsOfferFailedAt, failure: r.docsOfferFailure })
    .from(wr)
    .innerJoin(r, and(eq(r.id, wr.repoId), eq(r.accountId, wr.accountId)))
    .where(and(eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId), isNotNull(r.docsOfferFailedAt)))
    .orderBy(asc(r.owner), asc(r.name))
    .execute();
  return rows.map((x) => ({
    repoId: x.id,
    repoFullName: `${x.owner}/${x.name}`,
    reason: asUnreadableReason(x.failure) ?? 'unavailable',
    failedAt: (x.failedAt as Date).toISOString(),
  }));
}

/** Until when the workspace's offer card is hidden by its latest "Not now" (null = it is not). */
export async function offersSnoozedUntil(accountId: number, workspaceId: number): Promise<Date | null> {
  const rows = await db
    .select({ at: max(t().decidedAt) })
    .from(t())
    .where(and(eq(t().accountId, accountId), eq(t().workspaceId, workspaceId), eq(t().state, 'declined')))
    .execute();
  const at = rows[0]?.at;
  return at == null ? null : new Date(new Date(at).getTime() + DOCS_OFFER_SNOOZE_DAYS * DAY_MS);
}

/** The workspace's rows in these states, the repository still in the workspace and the folder not in
 *  the library (a folder added through the wizard since the scan drops out at once). By repo, path. */
async function listRows(accountId: number, workspaceId: number, states: readonly string[]): Promise<RepoDocsOffer[]> {
  const o = t();
  const r = schema.repos;
  const wr = schema.workspaceRepos;
  const rows = await db
    .select({
      id: o.id,
      repoId: o.repoId,
      owner: r.owner,
      name: r.name,
      path: o.path,
      docs: o.docCount,
      words: o.wordEstimate,
      tooLarge: o.tooLarge,
    })
    .from(o)
    .innerJoin(r, and(eq(r.id, o.repoId), eq(r.accountId, o.accountId)))
    .innerJoin(wr, and(eq(wr.repoId, o.repoId), eq(wr.accountId, o.accountId), eq(wr.workspaceId, o.workspaceId)))
    .where(and(eq(o.accountId, accountId), eq(o.workspaceId, workspaceId), inArray(o.state, [...states])))
    .orderBy(asc(r.owner), asc(r.name), asc(o.path))
    .execute();
  if (rows.length === 0) return [];
  const library = await libraryGithubFolders(accountId, workspaceId);
  return rows
    .filter((x) => !inLibrary(`${x.owner}/${x.name}`, x.path, library))
    .map((x) => ({
      id: x.id,
      repoId: x.repoId,
      repoFullName: `${x.owner}/${x.name}`,
      path: x.path,
      docs: x.docs,
      words: x.words,
      tooLarge: x.tooLarge,
    }));
}

/**
 * The folders the OFFER CARD shows in this workspace: none while a "Not now" is younger than
 * DOCS_OFFER_SNOOZE_DAYS; otherwise every folder still not added ('offered', and 'declined' ones whose
 * snooze has passed), not in the library.
 */
export async function listOpenOffers(accountId: number, workspaceId: number, now: Date = new Date()): Promise<RepoDocsOffer[]> {
  const until = await offersSnoozedUntil(accountId, workspaceId);
  if (until != null && until.getTime() > now.getTime()) return [];
  return listRows(accountId, workspaceId, OPEN_STATES);
}

/**
 * Every qualifying folder of this workspace that is NOT in the library, whatever the card's state —
 * the add-documents wizard's "From your repositories". An 'added' row whose document was since removed
 * is listed again.
 */
export async function listRepoFolders(accountId: number, workspaceId: number): Promise<RepoDocsOffer[]> {
  return listRows(accountId, workspaceId, [...OPEN_STATES, 'added']);
}

/** The offers block for a response, or null when nothing is waiting. */
export async function docsOffersFor(accountId: number, workspaceId: number): Promise<RepoDocsOffers | null> {
  const offers = await listOpenOffers(accountId, workspaceId);
  return offers.length === 0 ? null : { offers, budgetUsd: config.docsBuildBudgetUsd };
}

/** "Not now": the named, not-yet-added folders of this workspace are declined NOW, which hides the
 *  workspace's offer card for DOCS_OFFER_SNOOZE_DAYS (`listOpenOffers`). */
export async function declineOffers(accountId: number, workspaceId: number, ids: readonly number[], now: Date = new Date()): Promise<number> {
  if (ids.length === 0) return 0;
  const done = await db
    .update(t())
    .set({ state: 'declined', decidedAt: now })
    .where(and(eq(t().accountId, accountId), eq(t().workspaceId, workspaceId), inArray(t().id, [...ids]), inArray(t().state, OPEN_STATES)))
    .returning({ id: t().id })
    .execute();
  return done.length;
}

/** One offer of this workspace, or null (another account's or workspace's id reads as missing). */
export async function getOffer(accountId: number, workspaceId: number, id: number): Promise<(OfferRow & { owner: string; name: string }) | null> {
  const o = t();
  const r = schema.repos;
  const rows = await db
    .select({ offer: o, owner: r.owner, name: r.name })
    .from(o)
    .innerJoin(r, and(eq(r.id, o.repoId), eq(r.accountId, o.accountId)))
    .where(and(eq(o.accountId, accountId), eq(o.workspaceId, workspaceId), eq(o.id, id)))
    .limit(1)
    .execute();
  const x = rows[0];
  return x ? { ...x.offer, owner: x.owner, name: x.name } : null;
}

/**
 * CLAIM an offer for adding — compare-and-set 'offered' / 'declined' → 'added' — BEFORE anything reads
 * GitHub or queues a build, so a double press adds one document. False when it was not on offer.
 * `reclaimAdded` (the wizard): an 'added' row may be claimed again — ⚠ the CALLER has checked the folder
 * is no longer in the library and holds the route's per-offer lock across the whole add (one process),
 * so a double press still adds one document.
 */
export async function claimOffer(
  accountId: number,
  workspaceId: number,
  id: number,
  now: Date = new Date(),
  opts: { reclaimAdded?: boolean } = {},
): Promise<boolean> {
  const claimable = inArray(t().state, opts.reclaimAdded ? [...OPEN_STATES, 'added'] : OPEN_STATES);
  const done = await db
    .update(t())
    .set({ state: 'added', decidedAt: now, docId: null })
    .where(and(eq(t().accountId, accountId), eq(t().workspaceId, workspaceId), eq(t().id, id), claimable, eq(t().tooLarge, false)))
    .returning({ id: t().id })
    .execute();
  return done.length > 0;
}

/** The add failed after its claim: back to the state it was claimed from (default: on offer). */
export async function releaseOffer(
  accountId: number,
  id: number,
  back: { state: string; decidedAt: Date | null } = { state: 'offered', decidedAt: null },
): Promise<void> {
  await db
    .update(t())
    .set({ state: back.state, decidedAt: back.decidedAt })
    .where(and(eq(t().accountId, accountId), eq(t().id, id), eq(t().state, 'added'), sql`${t().docId} IS NULL`))
    .execute();
}

/** The document the add queued. */
export async function setOfferDoc(accountId: number, id: number, docId: number): Promise<void> {
  await db
    .update(t())
    .set({ docId })
    .where(and(eq(t().accountId, accountId), eq(t().id, id)))
    .execute();
}
