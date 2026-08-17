// Re-read the VENDOR'S OWN severity badge off already-labelled bot text — and write NOTHING else.
//
// ⚠ THIS MODULE WRITES EXACTLY TWO COLUMNS: `ml_comment_labels.vendor_severity` and
// `ml_comment_labels.vendor_severity_confidence`. Never `severity`, `severity_ord`,
// `severity_prob`, `categories`, `category_probs`, `is_summary`, `backend`, `model_version`,
// `body_hash`, `target_created_at` — and not even `updated_at` (see the note on it below).
// That constraint is not tidiness, it is the ENTIRE reason this path exists instead of
// `pnpm ml:enrich --reset`: a reset re-scores the corpus against whatever artifact is served
// today, which moves every number the user is currently looking at (severities, category mix,
// the Bots table's verdicts, the agreement matrix) as a side effect of wanting one missing
// badge. This sweep cannot move any of them, because it never invokes the model at all — the
// service endpoint it calls (`POST /markers/vendor-severity`) takes no `Services` dependency
// and its response shape carries only the two fields above.
//
// WHY THE GAP EXISTS. `vendor_severity` was added to the schema after ~23k rows already
// existed, and there is no re-scoring path (the candidate query is "has no label row"), so
// every row written before it stayed NULL. Worse, three high-volume vendors only got a marker
// parser later still, so their rows are NULL even when written after the column landed —
// measured in this repo's own dev DB: cursor 329 labelled / 0 badged, chatgpt-codex-connector
// 518 / 0, deepsource-io 4,655 / 0, with the badge plainly visible in 100% of the bodies.
//
// A NULL ANSWER IS A NORMAL, FINAL RESULT — never an error and never a reason to synthesize
// one. sonarqubecloud, greptile-apps and github-code-quality declare no severity at all, and so
// does a badge vendor's un-badged comment (Cursor's `<!-- BUGBOT_REVIEW -->` roll-up, Copilot's
// prose). The stored value is rendered to a user AS THAT VENDOR'S OWN CALL next to ours, so
// inventing one puts words in a third party's mouth. The badge allowlist lives in the service
// (`parse.markers._BADGE_VENDORS`); nothing here second-guesses it.
//
//   pnpm ml:reparse-badges              # fill in every missing badge
//   pnpm ml:reparse-badges --dry-run    # report what WOULD change, write nothing
//   pnpm ml:reparse-badges --all        # also re-parse rows that already carry a badge
import { and, asc, eq, gt, inArray, isNull, type SQL } from 'drizzle-orm';
import type { MlLabelTargetKind, MlSeverity, MlVendorConfidence } from '@pierre-review/shared';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { isSeverityApiConfigured } from '../ml/severity-client.js';
import { vendorHint, type MlLog } from './ml-enrichment.js';

const { accounts, mlCommentLabels, prComments, pullRequests, reviewComments, reviews, users } =
  schema;

/** The marker-only endpoint. Deliberately NOT `/score/comments`: that one runs the model. */
const MARKERS_PATH = '/markers/vendor-severity';

// The service caps a request at 256 items (422 beyond), the same bound `/score/comments` uses.
// The DB page is sized to match so one page is at most one request.
const MAX_REQUEST_ITEMS = 256;

// A second bound, on TEXT rather than items. Nothing here tokenizes, so this is about the size
// of a single HTTP body, not about inference cost — 256 walkthrough-sized bodies would be a
// ~25 MB POST. Ordinary batches never reach it (a bot comment averages ~1.5k chars).
const MAX_REQUEST_CHARS = 1_000_000;

// `inArray` chunk for the id lists this module builds (body lookups, the UPDATE fan-out). Both
// dialects have a bound-parameter ceiling (SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999);
// 900 leaves room for the handful of other predicates in the same statement.
const ID_CHUNK = 900;

const SEVERITIES: MlSeverity[] = ['nit', 'minor', 'major', 'critical'];
const CONFIDENCES: MlVendorConfidence[] = ['high', 'medium', 'low'];

/**
 * Read one of the two answer fields defensively — a value outside the union becomes `null`,
 * and NOTHING throws.
 *
 * Same rule and the same reason as `ml/severity-client.ts`'s `pickEnum`: the service is
 * deployed separately and may be older than this caller, so an absent or unrecognised value
 * has to mean "no claim" rather than failing a batch. Duplicated rather than imported because
 * that one is module-private; if these two ever disagree, the client's is authoritative.
 */
function pickEnum<T extends string>(raw: unknown, allowed: T[]): T | null {
  if (typeof raw !== 'string') return null;
  const word = raw.trim().toLowerCase();
  return (allowed as string[]).includes(word) ? (word as T) : null;
}

/** Extra headers for the call, from `SEVERITY_API_HEADERS` — see `config.severityApiHeaders`. */
function extraHeaders(): Record<string, string> {
  const raw = config.severityApiHeaders;
  if (!raw) return {};
  const headers: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }
  } catch {
    // Ignored on purpose, exactly as in the severity client: a malformed header bag must not
    // turn a maintenance sweep into a crash. A wrong header gets a 401, which is a modelled
    // outcome (the batch fails and is reported).
  }
  return headers;
}

interface MarkerRequestItem {
  /** `ml_comment_labels.id` — see `postMarkers` for why the id travels. */
  id: number;
  body: string;
  vendor: string | null;
}

interface MarkerAnswer {
  severity: MlSeverity | null;
  confidence: MlVendorConfidence | null;
}

/**
 * POST one batch of bodies and return the answers KEYED BY OUR OWN ROW ID.
 *
 * ⚠ KEYED, NEVER POSITIONAL. `/score/comments` zips its results onto the caller's targets by
 * position and throws on a length mismatch, which is sound but leaves the ordering contract
 * implicit on both sides. Here a mis-attribution would write "DeepSource says CRITICAL" onto a
 * comment DeepSource never wrote, in a column rendered verbatim as that vendor's own call —
 * a lie nothing downstream could ever detect. The endpoint echoes each `id`, so this keys on
 * it and an unanswered id is simply left unwritten.
 *
 * Throws on any transport/HTTP failure; the caller counts the batch as failed and moves on.
 * Nothing has been written at that point, so a failed batch costs only the round trip.
 */
async function postMarkers(items: MarkerRequestItem[]): Promise<Map<number, MarkerAnswer>> {
  const url = new URL(MARKERS_PATH, config.severityApiUrl).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders() },
    body: JSON.stringify({
      comments: items.map((i) => ({
        id: i.id,
        body: i.body,
        // Omitted rather than sent as null when there is no hint — the field is optional and
        // the service treats absent and null identically.
        ...(i.vendor ? { vendor: i.vendor } : {}),
      })),
    }),
    signal: AbortSignal.timeout(config.mlRequestTimeoutMs),
  });
  if (!res.ok) {
    // Bound the echoed body: a FastAPI 500 carries a full traceback.
    const text = await res.text().catch(() => '');
    throw new Error(`severity-api ${res.status}: ${text.slice(0, 300)}`);
  }
  const raw = (await res.json()) as {
    results?: Array<{
      id?: unknown;
      vendor_severity?: unknown;
      vendor_severity_confidence?: unknown;
    }>;
  };
  const out = new Map<number, MarkerAnswer>();
  for (const r of raw.results ?? []) {
    // The id is `int | str` on the wire (the endpoint is generic over callers); ours are always
    // integers, so anything else is a contract break and is dropped rather than guessed at.
    const id = typeof r.id === 'number' ? r.id : Number(r.id);
    if (!Number.isInteger(id)) continue;
    out.set(id, {
      severity: pickEnum(r.vendor_severity, SEVERITIES),
      confidence: pickEnum(r.vendor_severity_confidence, CONFIDENCES),
    });
  }
  return out;
}

/** Split a page into requests bounded by BOTH the item cap and the text cap. */
function packRequests(items: MarkerRequestItem[]): MarkerRequestItem[][] {
  const out: MarkerRequestItem[][] = [];
  let current: MarkerRequestItem[] = [];
  let chars = 0;
  for (const item of items) {
    // A single body larger than the whole budget still has to go somewhere: it gets its own
    // request rather than being dropped or truncated (see `bodiesFor` on why we never truncate).
    if (
      current.length > 0 &&
      (current.length >= MAX_REQUEST_ITEMS || chars + item.body.length > MAX_REQUEST_CHARS)
    ) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.body.length;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Per-vendor coverage, which is the number the operator actually runs this for. */
export interface VendorBadgeStat {
  /** The vendor string SENT to the parser (`cursor` / `codex` / `deepsource` / …). */
  vendor: string;
  scanned: number;
  /** NULL → a badge. The coverage jump. */
  gained: number;
  /** A badge → a DIFFERENT badge. Only reachable with `includeBadged`. */
  changed: number;
  /** Re-parsed to exactly what is already stored — no statement issued. */
  unchanged: number;
  /** Re-parsed to nothing. A normal, final answer; see the module docstring. */
  noClaim: number;
}

export interface ReparseStats {
  scanned: number;
  /** Rows written (`gained + changed`). Under `dryRun` this is what WOULD have been written. */
  updated: number;
  gained: number;
  changed: number;
  unchanged: number;
  noClaim: number;
  /** Label rows whose source text was missing or blank — nothing to re-parse. */
  skipped: number;
  requests: number;
  failures: number;
  /** Sorted by `gained` descending, so the biggest coverage win reads first. */
  byVendor: VendorBadgeStat[];
}

export interface ReparseOptions {
  /** Report what would change and write nothing. */
  dryRun?: boolean;
  /**
   * Also re-parse rows that ALREADY carry a badge. Off by default: the default sweep exists to
   * close the NULL gap, and restricting to NULLs makes a re-run trivially cheap. Turn it on
   * after a parser fix that changes an existing mapping.
   */
  includeBadged?: boolean;
  /** Restrict to one account. Default: every account (a local install has exactly one). */
  accountId?: number;
  log?: MlLog;
}

const NOOP_LOG: MlLog = { info: () => {}, warn: () => {} };

function emptyStats(): ReparseStats {
  return {
    scanned: 0,
    updated: 0,
    gained: 0,
    changed: 0,
    unchanged: 0,
    noClaim: 0,
    skipped: 0,
    requests: 0,
    failures: 0,
    byVendor: [],
  };
}

/**
 * The vendor string each labelled author's text must be re-parsed under, DERIVED FROM THE
 * GITHUB LOGIN.
 *
 * ⚠ NOT from `workspace_reviewers.kind`, and this is the specific reason the whole sweep is
 * necessary. That column is written once, lazily, the first time someone reads the Bots tab,
 * and the classifier never re-derives a row that already exists — so an actor first seen BEFORE
 * its login joined `REVIEW_BOTS` keeps that day's answer forever. In this repo's dev DB both
 * `deepsource-io` (4,655 labelled comments) and `chatgpt-codex-connector` (518) sit at
 * `kind='in_house'`, which maps to NO vendor hint at all — i.e. re-parsing off the stored kind
 * would send the generic path and recover exactly nothing, while looking like the parser is
 * broken.
 *
 * It goes through `vendorHint` (with no stored kind offered) rather than calling
 * `reviewBotKind` directly, so the vocabulary can never drift from the one the enrichment
 * worker scores under — that function is the single source of truth for "which parser does this
 * actor's text go to", and re-parsing under a different one than wrote the row is the one
 * mistake this module must not make.
 *
 * KNOWN UNDER-RECOVERY, deliberately: an actor a human manually identified as a vendor whose
 * LOGIN is not in `REVIEW_BOTS` (a self-hosted or renamed CodeRabbit) gets no hint here and
 * keeps its NULL badge. Under-recovering is the right failure — the alternative is guessing a
 * parser, and a wrong parser writes a wrong claim into a column shown as the vendor's own.
 */
async function vendorAuthorsForAccount(accountId: number): Promise<Map<number, string>> {
  const rows = await db
    .selectDistinct({ userId: mlCommentLabels.authorUserId, login: users.githubLogin })
    .from(mlCommentLabels)
    // `users` is one of the two GLOBAL tables; the ids come from label rows already scoped to
    // this account, so joining it widens nothing and only the login is selected.
    .innerJoin(users, eq(users.id, mlCommentLabels.authorUserId))
    .where(eq(mlCommentLabels.accountId, accountId))
    .execute();
  const out = new Map<number, string>();
  for (const r of rows) {
    const vendor = vendorHint(null, r.login);
    if (vendor) out.set(r.userId, vendor);
  }
  return out;
}

/**
 * The source text for a page's targets, by target id within ONE kind.
 *
 * ⚠ THE FULL BODY, never `config.mlBodyMaxChars`. That cap exists because the model truncates
 * at 512 tokens, so trimming costs nothing there; here nothing tokenizes, and a marker below
 * the cut is silently lost — a badge the vendor plainly declared would read as "declared none",
 * which is the one confusion this feature cannot afford.
 *
 * Scoped through `pull_requests.account_id` rather than trusting the label row's own
 * `account_id`: the id is a bare integer in one of three id spaces, and reading text by id
 * alone is exactly the shape an IDOR takes. The join makes the tenancy structural for a
 * handful of extra index lookups.
 */
async function bodiesFor(
  accountId: number,
  kind: MlLabelTargetKind,
  targetIds: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let i = 0; i < targetIds.length; i += ID_CHUNK) {
    const chunk = targetIds.slice(i, i + ID_CHUNK);
    const rows =
      kind === 'review_comment'
        ? await db
            .select({ id: reviewComments.id, body: reviewComments.body })
            .from(reviewComments)
            .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
            .where(and(eq(pullRequests.accountId, accountId), inArray(reviewComments.id, chunk)))
            .execute()
        : kind === 'pr_comment'
          ? await db
              .select({ id: prComments.id, body: prComments.body })
              .from(prComments)
              .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
              .where(and(eq(pullRequests.accountId, accountId), inArray(prComments.id, chunk)))
              .execute()
          : await db
              .select({ id: reviews.id, body: reviews.body })
              .from(reviews)
              .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
              .where(and(eq(pullRequests.accountId, accountId), inArray(reviews.id, chunk)))
              .execute();
    for (const r of rows) {
      if (r.body != null && r.body.trim() !== '') out.set(r.id, r.body);
    }
  }
  return out;
}

interface PendingWrite {
  labelId: number;
  severity: MlSeverity;
  confidence: MlVendorConfidence | null;
}

/**
 * Apply the writes, one statement per DISTINCT (severity, confidence) pair per id chunk.
 *
 * There are at most 4 × 4 pairs, so a 23k-row sweep is a couple of dozen statements rather than
 * 23k. Every statement carries `account_id` even though the ids are already this account's —
 * one predicate, and the isolation is then true of the statement itself rather than of the
 * argument it was handed.
 *
 * ⚠ `updated_at` IS DELIBERATELY NOT BUMPED. Nothing reads it today, and what it means is "when
 * this LABEL was produced" — a badge-only re-parse produced no label, so bumping it would make
 * a maintenance sweep look like a full re-score of the corpus in any future readout built on
 * it. Leaving it alone is also what lets the test assert that EVERY other column is
 * byte-identical before and after, which is the property that makes this command safe to run.
 */
async function applyWrites(accountId: number, writes: PendingWrite[]): Promise<void> {
  const groups = new Map<
    string,
    { severity: MlSeverity; confidence: MlVendorConfidence | null; ids: number[] }
  >();
  for (const w of writes) {
    const key = `${w.severity}|${w.confidence ?? ''}`;
    const group = groups.get(key);
    if (group) group.ids.push(w.labelId);
    else groups.set(key, { severity: w.severity, confidence: w.confidence, ids: [w.labelId] });
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.ids.length; i += ID_CHUNK) {
      await db
        .update(mlCommentLabels)
        .set({
          // THE ONLY TWO COLUMNS THIS MODULE MAY WRITE.
          vendorSeverity: group.severity,
          vendorSeverityConfidence: group.confidence,
        })
        .where(
          and(
            eq(mlCommentLabels.accountId, accountId),
            inArray(mlCommentLabels.id, group.ids.slice(i, i + ID_CHUNK)),
          ),
        )
        .execute();
    }
  }
}

function statFor(byVendor: Map<string, VendorBadgeStat>, vendor: string): VendorBadgeStat {
  const existing = byVendor.get(vendor);
  if (existing) return existing;
  const fresh: VendorBadgeStat = {
    vendor,
    scanned: 0,
    gained: 0,
    changed: 0,
    unchanged: 0,
    noClaim: 0,
  };
  byVendor.set(vendor, fresh);
  return fresh;
}

/**
 * Re-parse vendor badges over stored labels. Resolves even when the service is unreachable —
 * failures are counted and reported, never thrown.
 *
 * IDEMPOTENT AND RESUMABLE, by construction rather than by bookkeeping:
 *   • the parser is deterministic, so a second run computes the same answer for every row;
 *   • a row whose answer already matches what is stored is skipped without a statement, so a
 *     completed sweep re-run reports `updated: 0`;
 *   • paging is a forward-only cursor over `ml_comment_labels.id`, so a run killed halfway
 *     leaves committed work committed and the next run simply re-selects what is still NULL.
 *
 * ⚠ A NULL PARSE NEVER CLEARS AN EXISTING BADGE. The endpoint answers null both for "this
 * vendor declared nothing" and for "I have no parser for this vendor" — they are the same
 * response, and this module cannot tell them apart. So a parser regression, a rolled-back
 * service, or a vendor hint that stopped resolving would silently ERASE the column for every
 * row it touched, destroying exactly the data an earlier run correctly recovered. Refusing to
 * clear costs only that a genuinely withdrawn badge lingers; the deliberate way to clear one is
 * `pnpm ml:enrich --reset`, which re-derives the whole label including this column.
 */
export async function reparseVendorBadges(options: ReparseOptions = {}): Promise<ReparseStats> {
  const log = options.log ?? NOOP_LOG;
  const stats = emptyStats();
  const byVendor = new Map<string, VendorBadgeStat>();

  // THE one gate, same as everywhere else in this feature: no URL ⇒ do nothing, cleanly.
  if (!isSeverityApiConfigured()) {
    log.warn('reparse-vendor-badges: SEVERITY_API_URL is not set — nothing to do');
    return stats;
  }

  const accountIds =
    options.accountId != null
      ? [options.accountId]
      : (await db.select({ id: accounts.id }).from(accounts).execute()).map((r) => r.id);

  const kinds: MlLabelTargetKind[] = ['review_comment', 'pr_comment', 'review'];
  // A service that is simply not there fails every request; stop rather than walking the whole
  // corpus to prove it. A single rejected batch is different and must not stop the sweep.
  const MAX_CONSECUTIVE_FAILURES = 3;
  let consecutiveFailures = 0;

  for (const accountId of accountIds) {
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
    const vendorByAuthor = await vendorAuthorsForAccount(accountId);
    if (vendorByAuthor.size === 0) {
      log.info(`account ${accountId}: no labelled text from a known vendor — skipping`);
      continue;
    }
    const authorIds = [...vendorByAuthor.keys()];
    log.info(
      `account ${accountId}: ${authorIds.length} vendor author(s) — ` +
        `${[...new Set(vendorByAuthor.values())].sort().join(', ')}`,
    );

    for (const kind of kinds) {
      let cursor = 0;
      for (;;) {
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        const where: SQL[] = [
          eq(mlCommentLabels.accountId, accountId),
          eq(mlCommentLabels.targetKind, kind),
          inArray(mlCommentLabels.authorUserId, authorIds),
          gt(mlCommentLabels.id, cursor),
        ];
        // The default sweep is the NULL gap only — see `includeBadged`.
        if (!options.includeBadged) where.push(isNull(mlCommentLabels.vendorSeverity));
        const page = await db
          .select({
            labelId: mlCommentLabels.id,
            targetId: mlCommentLabels.targetId,
            authorUserId: mlCommentLabels.authorUserId,
            storedSeverity: mlCommentLabels.vendorSeverity,
            storedConfidence: mlCommentLabels.vendorSeverityConfidence,
          })
          .from(mlCommentLabels)
          .where(and(...where))
          // Ordered + cursored so paging is stable while rows are being updated underneath it:
          // an offset would shift every time a row stopped matching the NULL predicate.
          .orderBy(asc(mlCommentLabels.id))
          .limit(MAX_REQUEST_ITEMS)
          .execute();
        if (page.length === 0) break;
        cursor = page[page.length - 1]!.labelId;

        const bodies = await bodiesFor(
          accountId,
          kind,
          page.map((r) => r.targetId),
        );
        const items: MarkerRequestItem[] = [];
        const rowById = new Map<number, (typeof page)[number]>();
        for (const row of page) {
          stats.scanned += 1;
          const vendor = vendorByAuthor.get(row.authorUserId) ?? null;
          if (vendor) statFor(byVendor, vendor).scanned += 1;
          const body = bodies.get(row.targetId);
          if (!body) {
            // No text to re-read: a lean-storage NULL body, or a parent deleted since the label
            // was written. Neither is an error and neither is fixable here.
            stats.skipped += 1;
            continue;
          }
          rowById.set(row.labelId, row);
          items.push({ id: row.labelId, body, vendor });
        }
        if (items.length === 0) continue;

        for (const request of packRequests(items)) {
          let answers: Map<number, MarkerAnswer>;
          try {
            answers = await postMarkers(request);
            stats.requests += 1;
            consecutiveFailures = 0;
          } catch (err) {
            stats.failures += 1;
            consecutiveFailures += 1;
            log.warn(
              `reparse-vendor-badges: batch of ${request.length} failed: ` +
                (err instanceof Error ? err.message.slice(0, 200) : String(err)),
            );
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
            continue;
          }

          const writes: PendingWrite[] = [];
          let unanswered = 0;
          for (const item of request) {
            const row = rowById.get(item.id)!;
            const stat = item.vendor ? statFor(byVendor, item.vendor) : null;
            const answer = answers.get(item.id);
            if (!answer) {
              // The endpoint echoes every id it was given, so a missing one is a contract
              // break, NOT "no claim" — counting it as the latter would hide a broken service
              // behind a number that looks like an ordinary result. Nothing is written for it.
              unanswered += 1;
              stats.skipped += 1;
              continue;
            }
            if (answer.severity === null) {
              // "No claim" — the vendor declared nothing, which is a final answer and leaves
              // the row exactly as it is. See the never-clear rule in this function's docblock.
              stats.noClaim += 1;
              if (stat) stat.noClaim += 1;
              continue;
            }
            if (
              answer.severity === row.storedSeverity &&
              answer.confidence === (row.storedConfidence ?? null)
            ) {
              stats.unchanged += 1;
              if (stat) stat.unchanged += 1;
              continue;
            }
            if (row.storedSeverity == null) {
              stats.gained += 1;
              if (stat) stat.gained += 1;
            } else {
              stats.changed += 1;
              if (stat) stat.changed += 1;
            }
            writes.push({
              labelId: item.id,
              severity: answer.severity,
              confidence: answer.confidence,
            });
          }

          if (unanswered > 0) {
            log.warn(
              `reparse-vendor-badges: ${unanswered} of ${request.length} item(s) came back ` +
                'without an id — left untouched',
            );
          }
          if (writes.length > 0 && !options.dryRun) await applyWrites(accountId, writes);
          stats.updated += writes.length;
          log.info(
            `account ${accountId} ${kind}: ${request.length} re-parsed, ` +
              `+${writes.length} badge(s)${options.dryRun ? ' (dry run)' : ''} — ` +
              `${stats.scanned} scanned, ${stats.updated} badged so far`,
          );
        }
      }
    }
  }

  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    log.warn(
      `reparse-vendor-badges: gave up after ${MAX_CONSECUTIVE_FAILURES} consecutive failures — ` +
        `is ${config.severityApiUrl} running? Whatever was written is committed; re-running ` +
        'picks up everything still unbadged.',
    );
  }
  stats.byVendor = [...byVendor.values()].sort((a, b) => b.gained - a.gained);
  return stats;
}
