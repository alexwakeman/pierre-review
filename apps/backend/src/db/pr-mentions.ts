// Query layer for "@you was mentioned on this PR" (CORE, free, no AI, no GitHub quota).
//
// WHAT THIS ANSWERS. My Turn's "New PRs" section admits every non-draft human PR in every repo
// the account has added — on a real account, hundreds of strangers' PRs in repos the viewer only
// reads. Phase 1 gave each row a `personal` flag decided by "do you MAINTAIN this repo". This is
// the second derived signal behind that flag: someone typed your login on the PR. A mention is
// personal EVEN IN A REPO YOU ONLY READ — that is the entire point of the clause, and why it
// cannot be folded into the repo-permission test.
//
// THREE JOBS, and nothing else:
//   1. MATCH   — the pure `@login` word-boundary predicate (exported and unit-pinned)
//   2. DERIVE  — the full "which of this account's PRs mention the viewer" set (the scanner's
//                worklist; see sync/mention-scan.ts)
//   3. READ    — the tiny existence lookup getMyTurn does per request
//
// WHY THE DERIVE IS A FULL RE-SCAN AND NOT AN INCREMENTAL CURSOR. A cursor over the three comment
// tables would have to be right about four different ways the corpus changes, and each wrong
// answer is silent: a 90-day BACKFILL inserts rows whose `created_at` predates any time-based
// watermark; a body EDIT changes neither a row's id nor its created_at; a deleted comment must
// REMOVE a mention; and Postgres hands out sequence values out of commit order, so an id-based
// watermark can skip a row permanently. Re-deriving the whole set and diffing it against what is
// stored is correct under all four with no state to keep, and it is affordable because the
// expensive half is bounded by the MATCHES, not by the corpus: on this repo's own dev database
// (65k comment/review bodies, 8.5k PRs) the three scans below run in ~0.19s and return 12 rows.
// The cost that does scale is the LIKE scan itself, which is why this is a background worker on a
// multi-minute cron and NEVER a per-request read — `getWorkspaceInsights` runs on every Feed
// landing.
import { and, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { db, schema } from './client.js';

const { prMentions, prComments, pullRequests, reviewComments, reviews } = schema;

// A cap on how many MATCHING rows one account's scan will look at, per source table. Not a
// correctness bound — it is a guard against a pathological corpus (a bot that @-mentions the
// account owner on every PR) turning one tick into an unbounded allocation. It orders by nothing
// on purpose: the fold below only ever reads `prId`/`repoId`, so which matching rows are sampled
// changes nothing until the cap actually bites, and past that point every additional row is a
// duplicate PR far more often than a new one.
const MENTION_SCAN_CAP = 20_000;

// Chunk size for the `IN (…)` lookups. SQLite's default bound-variable limit is 999.
const ID_CHUNK = 500;

/**
 * THE MATCH RULE. `@login` as a whole word, case-insensitive.
 *
 * The two failure directions this exists to prevent, both silent:
 *   • `@alex` must NOT match "@alexwakeman" and `@alexwakeman` must not match "@alex" — the
 *     trailing class rejects a login that merely STARTS with ours (GitHub logins are
 *     `[A-Za-z0-9-]`; `_` is in the class as well because a reader cannot tell "@alex_wakeman"
 *     apart from a login we do not know, and under-notifying is the safe direction here).
 *   • "bob@alexwakeman.com" and "docs/@alexwakeman/notes.md" must not count — the leading class
 *     rejects an `@` glued to a word character, a path separator or a dot, which is what an
 *     email local part and a path segment look like.
 *
 * Everything else — start of string, whitespace, `(`, `[`, `>` (a quoted reply), a backtick — is
 * a real mention position and matches.
 *
 * Deliberately NOT a `\b` boundary: `\b` is symmetric about word characters and `@` is not a word
 * character, so `\b@login\b` would happily match the email case above.
 */
export function mentionPattern(login: string): RegExp {
  // The login is DATA (it comes from `accounts.github_login`, ultimately from GitHub). Escaping
  // it keeps a hyphen or a dot from being read as regex syntax.
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_@./-])@${escaped}(?![A-Za-z0-9_-])`, 'i');
}

/** True when `text` @-mentions `login` as a whole word. Empty login never matches. */
export function mentionsLogin(text: string | null | undefined, login: string): boolean {
  if (!text || !login) return false;
  return mentionPattern(login).test(text);
}

// A `%@login%` LIKE pattern with the LIKE metacharacters escaped, paired with `ESCAPE '\'` below
// (the db/search.ts idiom). This is a PREFILTER ONLY — it is substring, not word-boundary, so
// `mentionsLogin` above is the authority on every row it returns.
function likePattern(login: string): string {
  return `%@${login.toLowerCase().replace(/([\\%_])/g, '\\$1')}%`;
}

function likeCol(col: unknown, pattern: string): SQL {
  return sql`lower(${col}) like ${pattern} escape '\\'`;
}

/** One PR the viewer is mentioned on, with the repo it belongs to (denormalised onto the row). */
export interface MentionedPr {
  prId: number;
  repoId: number;
}

/**
 * THE FULL DERIVATION: every PR of this account whose text @-mentions `login`.
 *
 * All three body-bearing tables, because a mention is a mention wherever it was typed: an
 * issue-level PR comment, a review body, an inline review-thread comment. PR TITLES AND
 * DESCRIPTIONS ARE DELIBERATELY OUT — descriptions are not persisted under lean storage
 * (docs/BACKEND.md), so including them would make the answer depend on whether PERSIST_BODIES
 * happened to be on, which is the one thing a derived flag must never do. Comment and review
 * bodies are ALWAYS persisted, so this needs no GitHub fetch and no hydration.
 */
export async function deriveMentionedPrs(
  accountId: number,
  login: string,
): Promise<MentionedPr[]> {
  if (!login) return [];
  const pat = likePattern(login);
  // Three near-identical queries rather than one parameterised helper: drizzle's column types are
  // per-table, and the generic version only type-checks by widening the columns to `any` — which
  // is exactly the seam that would let a wrong `prId` through unnoticed.
  const [pc, rc, rv] = await Promise.all([
    db
      .select({ prId: prComments.prId, repoId: pullRequests.repoId, body: prComments.body })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          isNotNull(prComments.body),
          likeCol(prComments.body, pat),
        ),
      )
      .limit(MENTION_SCAN_CAP)
      .execute(),
    db
      .select({
        prId: reviewComments.prId,
        repoId: pullRequests.repoId,
        body: reviewComments.body,
      })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          isNotNull(reviewComments.body),
          likeCol(reviewComments.body, pat),
        ),
      )
      .limit(MENTION_SCAN_CAP)
      .execute(),
    db
      .select({ prId: reviews.prId, repoId: pullRequests.repoId, body: reviews.body })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          isNotNull(reviews.body),
          likeCol(reviews.body, pat),
        ),
      )
      .limit(MENTION_SCAN_CAP)
      .execute(),
  ]);

  const out = new Map<number, number>();
  for (const rows of [pc, rc, rv]) {
    for (const r of rows) {
      // ⚠ THE SQL IS A PREFILTER, THE REGEX IS THE ANSWER. `lower(body) LIKE '%@alex%'` matches
      // "@alexwakeman" and "bob@alex.com" too; dropping this line is how "@alex" starts claiming
      // every PR that mentions a colleague with a longer login.
      if (!mentionsLogin(r.body, login)) continue;
      out.set(r.prId, r.repoId);
    }
  }
  return [...out.entries()].map(([prId, repoId]) => ({ prId, repoId }));
}

/** What is currently stored for this account: the PR ids, and the login each was derived under. */
export async function listStoredMentions(
  accountId: number,
): Promise<Array<{ id: number; prId: number; login: string }>> {
  return db
    .select({ id: prMentions.id, prId: prMentions.prId, login: prMentions.login })
    .from(prMentions)
    .where(eq(prMentions.accountId, accountId))
    .execute();
}

export interface MentionSyncResult {
  added: number;
  removed: number;
}

/**
 * Make the stored set EQUAL the derived set for one account — the scanner's only writer.
 *
 * A diff rather than an upsert sweep, because the delete half is load-bearing: a mention edited
 * out of a comment, a deleted comment, a PR that lost its mention when a review was dismissed,
 * and every row derived under a login this account no longer has must all STOP being personal.
 * An insert-only writer would make `personal` a ratchet that only ever widens.
 *
 * `login` is stored lowercased so the reader's equality test does not depend on how GitHub
 * spelled the login on the day the row was written.
 */
export async function syncAccountMentions(
  accountId: number,
  login: string,
  derived: MentionedPr[],
): Promise<MentionSyncResult> {
  const canonical = login.toLowerCase();
  const stored = await listStoredMentions(accountId);
  const storedByPr = new Map(stored.map((r) => [r.prId, r]));
  const wanted = new Map(derived.map((d) => [d.prId, d]));

  // Stale = no longer derived, OR derived under a different login (an account rename). Both are
  // "this row no longer states a true fact", so both leave by the same path.
  const staleIds = stored
    .filter((r) => !wanted.has(r.prId) || r.login !== canonical)
    .map((r) => r.id);
  for (let i = 0; i < staleIds.length; i += ID_CHUNK) {
    await db
      .delete(prMentions)
      .where(inArray(prMentions.id, staleIds.slice(i, i + ID_CHUNK)))
      .execute();
  }

  let added = 0;
  for (const d of derived) {
    const existing = storedByPr.get(d.prId);
    if (existing && existing.login === canonical) continue;
    // ON CONFLICT DO NOTHING rather than a bare insert: the unique is `(account_id, pr_id)` and a
    // concurrent tick (or a retried one) must not turn a duplicate into a thrown scan.
    const res = await db
      .insert(prMentions)
      .values({ accountId, repoId: d.repoId, prId: d.prId, login: canonical })
      .onConflictDoNothing({ target: [prMentions.accountId, prMentions.prId] })
      .returning({ id: prMentions.id })
      .execute();
    added += res.length;
  }
  return { added, removed: staleIds.length };
}

/**
 * THE READ getMyTurn does: which of these PR ids does the viewer's login appear on?
 *
 * Login-SCOPED on purpose. The scanner deletes rows written under a previous login within a
 * tick, but "within a tick" is not "immediately", and a stale row would claim a stranger's PR is
 * personal to you. Filtering here makes an account rename narrow instantly and widen only once
 * the scan has actually re-derived — absence is always the safe direction for this flag.
 *
 * A deployment whose scanner has never run has NO rows, so this returns an empty set and the
 * personal rule degrades exactly to its phase-1 (maintainer-only) behaviour.
 */
export async function viewerMentionedPrIds(
  accountId: number,
  login: string | null | undefined,
  prIds: number[],
): Promise<Set<number>> {
  const out = new Set<number>();
  if (!login || prIds.length === 0) return out;
  const canonical = login.toLowerCase();
  for (let i = 0; i < prIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({ prId: prMentions.prId })
      .from(prMentions)
      .where(
        and(
          eq(prMentions.accountId, accountId),
          eq(prMentions.login, canonical),
          inArray(prMentions.prId, prIds.slice(i, i + ID_CHUNK)),
        ),
      )
      .execute();
    for (const r of rows) out.add(r.prId);
  }
  return out;
}
