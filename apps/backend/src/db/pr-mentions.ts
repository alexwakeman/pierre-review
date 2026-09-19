// Query layer for "@you was mentioned on this PR" (CORE, free, no AI, no GitHub quota).
//
// WHAT THIS ANSWERS. My Turn's `mention` type (S6 of the ball rule, `getMyTurn`): a PERSON typed
// your login on an open PR, and you have not acted on that PR since. A mention is a summons EVEN
// IN A REPO YOU ONLY READ — that is the whole point of it, and why it is its own card type rather
// than a property of the repo. The card clears when you act AFTER the mention, so each row carries
// the moment of the NEWEST qualifying mention (`mentioned_at`) and who made it.
//
// TWO JOBS, and nothing else:
//   1. MATCH   — the pure `@login` word-boundary predicate (exported and unit-pinned)
//   2. DERIVE  — the full "which of this account's PRs mention the viewer, newest when and by whom"
//                set (the scanner's worklist; see sync/mention-scan.ts), and the diff that makes
//                the stored rows equal it. The READ is a join inside `getMyTurn`.
//
// WHO CAN SUMMON YOU. A mention by the viewer themself is not a summons, and neither is one by
// automation — the GLOBAL automation set (`globalAutomationUserIds`), the SAME set the ball rule
// resolves bot-ness with, so a mention this scanner stamps is always one `getMyTurn` would honour.
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
import { and, desc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { db, schema } from './client.js';
import { globalAutomationUserIds } from './automation-ids.js';

const { prMentions, prComments, pullRequests, reviewComments, reviews, users } = schema;

// A cap on how many MATCHING rows one account's scan will look at, per source table. Not a
// correctness bound — it is a guard against a pathological corpus (a bot that @-mentions the
// account owner on every PR) turning one tick into an unbounded allocation. Each scan orders
// NEWEST FIRST before the cap, so if it ever bites it drops the OLDEST matches — the ones least
// likely to be a PR's newest mention, which is the only one a row keeps.
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
 * Everything else — start of string, whitespace, `(`, `[`, `>`, a backtick — is a real mention
 * position and matches. (`deriveMentionedPrs` drops QUOTED lines before it asks: see
 * `withoutQuotedLines`.)
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

/** The body without its markdown blockquote lines — what its author TYPED. A quote-reply repeats
 *  somebody else's words: "> @you can you look?" is not the quoter summoning you, and counting it
 *  would move the mention clock past an action you already took and credit the wrong person. */
export function withoutQuotedLines(body: string): string {
  return body.replace(/^[ \t]*>.*$/gm, '');
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

/** One PR the viewer is mentioned on: the repo it belongs to (denormalised onto the row), and the
 *  NEWEST qualifying mention — when, and by whom. */
export interface MentionedPr {
  prId: number;
  repoId: number;
  mentionedAt: Date;
  mentionedById: number;
}

/**
 * THE FULL DERIVATION: every PR of this account on which a PERSON other than the viewer
 * @-mentions `login`, with that PR's NEWEST such mention.
 *
 * All three body-bearing tables, because a mention is a mention wherever it was typed: an
 * issue-level PR comment, a review body, an inline review-thread comment. PR TITLES AND
 * DESCRIPTIONS ARE DELIBERATELY OUT — descriptions are not persisted under lean storage
 * (docs/BACKEND.md), so including them would make the answer depend on whether PERSIST_BODIES
 * happened to be on, which is the one thing a derived fact must never do. Comment and review
 * bodies are ALWAYS persisted, so this needs no GitHub fetch and no hydration.
 *
 * ⚠ A SKIPPED ROW IS SKIPPED BEFORE "NEWEST" IS DECIDED. A bot that echoes your login after a
 * colleague's mention must not become the PR's mention (its time would move the card's clock, and
 * the next bot echo would re-summon you after you acted); the colleague's mention stays the newest.
 */
export async function deriveMentionedPrs(
  accountId: number,
  login: string,
): Promise<MentionedPr[]> {
  if (!login) return [];
  const pat = likePattern(login);
  // Resolved once per scan: who "you" are (a self-mention is not a summons) and who is automation.
  const [viewerRows, bots] = await Promise.all([
    db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.githubLogin}) = ${login.toLowerCase()}`)
      .limit(1)
      .execute(),
    globalAutomationUserIds(),
  ]);
  const viewerUserId = viewerRows[0]?.id ?? null;
  // Three near-identical queries rather than one parameterised helper: drizzle's column types are
  // per-table, and the generic version only type-checks by widening the columns to `any` — which
  // is exactly the seam that would let a wrong `prId` through unnoticed.
  const [pc, rc, rv] = await Promise.all([
    db
      .select({
        prId: prComments.prId,
        repoId: pullRequests.repoId,
        body: prComments.body,
        authorId: prComments.authorId,
        at: prComments.createdAt,
      })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          isNotNull(prComments.body),
          likeCol(prComments.body, pat),
        ),
      )
      .orderBy(desc(prComments.createdAt))
      .limit(MENTION_SCAN_CAP)
      .execute(),
    db
      .select({
        prId: reviewComments.prId,
        repoId: pullRequests.repoId,
        body: reviewComments.body,
        authorId: reviewComments.authorId,
        at: reviewComments.createdAt,
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
      .orderBy(desc(reviewComments.createdAt))
      .limit(MENTION_SCAN_CAP)
      .execute(),
    db
      .select({
        prId: reviews.prId,
        repoId: pullRequests.repoId,
        body: reviews.body,
        authorId: reviews.authorId,
        at: reviews.submittedAt,
      })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          isNotNull(reviews.body),
          likeCol(reviews.body, pat),
        ),
      )
      .orderBy(desc(reviews.submittedAt))
      .limit(MENTION_SCAN_CAP)
      .execute(),
  ]);

  const out = new Map<number, MentionedPr>();
  for (const rows of [pc, rc, rv]) {
    for (const r of rows) {
      // Nobody we can name (a deleted account), yourself, or automation: not a summons.
      if (r.authorId == null || r.authorId === viewerUserId || bots.has(r.authorId)) continue;
      // ⚠ THE SQL IS A PREFILTER, THE REGEX IS THE ANSWER. `lower(body) LIKE '%@alex%'` matches
      // "@alexwakeman" and "bob@alex.com" too; dropping this line is how "@alex" starts claiming
      // every PR that mentions a colleague with a longer login. And only TYPED lines count — a
      // quoted mention skipped here, before "newest" is decided, cannot restamp the clock.
      if (r.body == null || !mentionsLogin(withoutQuotedLines(r.body), login)) continue;
      const prev = out.get(r.prId);
      if (prev != null && prev.mentionedAt.getTime() >= r.at.getTime()) continue;
      out.set(r.prId, {
        prId: r.prId,
        repoId: r.repoId,
        mentionedAt: r.at,
        mentionedById: r.authorId,
      });
    }
  }
  return [...out.values()];
}

/** What is currently stored for this account: each PR, the login it was derived under, and the
 *  mention clock last stamped on it (NULL until the first scan after migration 0068). */
export async function listStoredMentions(accountId: number): Promise<
  Array<{
    id: number;
    prId: number;
    login: string;
    mentionedAt: Date | null;
    mentionedByUserId: number | null;
  }>
> {
  return db
    .select({
      id: prMentions.id,
      prId: prMentions.prId,
      login: prMentions.login,
      mentionedAt: prMentions.mentionedAt,
      mentionedByUserId: prMentions.mentionedByUserId,
    })
    .from(prMentions)
    .where(eq(prMentions.accountId, accountId))
    .execute();
}

export interface MentionSyncResult {
  added: number;
  /** Rows kept but restamped: a newer mention arrived (or the first scan after migration 0068). */
  updated: number;
  removed: number;
}

/**
 * Make the stored set EQUAL the derived set for one account — the scanner's only writer.
 *
 * A diff rather than an upsert sweep, because the delete half is load-bearing: a mention edited
 * out of a comment, a deleted comment, a PR that lost its mention when a review was dismissed,
 * and every row derived under a login this account no longer has must all STOP summoning you.
 * An insert-only writer would make the mention card a ratchet that only ever widens.
 *
 * ⚠ AND THE KEPT HALF IS RESTAMPED. A row is "unchanged" only when its login, its mention time and
 * its author all match what was derived; a NEWER mention on the same PR must move `mentioned_at`,
 * or you would act, the card would clear, and the colleague's second "@you?" would never return
 * it.
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
  let updated = 0;
  for (const d of derived) {
    const existing = storedByPr.get(d.prId);
    const kept = existing != null && existing.login === canonical;
    if (
      kept &&
      existing.mentionedAt?.getTime() === d.mentionedAt.getTime() &&
      existing.mentionedByUserId === d.mentionedById
    ) {
      continue;
    }
    // An UPSERT on the table's one unique, `(account_id, pr_id)` — the `prm_account_pr` target
    // every writer of this table uses — so a concurrent (or retried) tick cannot turn a duplicate
    // into a thrown scan, and a kept row is restamped in the same statement.
    const res = await db
      .insert(prMentions)
      .values({
        accountId,
        repoId: d.repoId,
        prId: d.prId,
        login: canonical,
        mentionedAt: d.mentionedAt,
        mentionedByUserId: d.mentionedById,
      })
      .onConflictDoUpdate({
        target: [prMentions.accountId, prMentions.prId],
        set: {
          login: canonical,
          repoId: d.repoId,
          mentionedAt: d.mentionedAt,
          mentionedByUserId: d.mentionedById,
        },
      })
      .returning({ id: prMentions.id })
      .execute();
    if (kept) updated += res.length;
    else added += res.length;
  }
  return { added, updated, removed: staleIds.length };
}
