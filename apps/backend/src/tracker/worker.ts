import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, max, or } from 'drizzle-orm';
import { TICKET_LINKS_TITLE_LOOKUPS, type TrackerProvider } from '@pierre-review/shared';
import { githubAccessFor, inChunks, type TrackerContext } from './context.js';
import { detectForAccess, linksUnknownFor, manualKeysOf, prLinkColumns, withParsedLinks } from './enricher.js';
import { adapterFor, maybeAdapterFor, readingProviders, ticketUrl } from './registry.js';
import {
  autoDetectedWorkspaces,
  readWorkspaceTrackerRow,
  trackerAccessOf,
  trackerBaseUrl,
  type WorkspaceTrackerAccess,
} from './settings.js';
import { prepareTrackerCall } from './calls.js';
import { refreshGithubIssuesUsage } from './github/issues-usage.js';
import { JiraFetchError, type JiraTransport } from './jira/fetch.js';
import type { DetectInput, DetectedTicket, LinkerPr, TrackerCall } from './types.js';
import {
  deleteStaleKeys,
  deriveAc,
  groupByPr,
  readAcFieldSettings,
  parseCandidates,
  readStoredTickets,
  settingFor,
  upsertTicketRow,
  type StoredTicketRow,
  type TicketState,
  type TicketWrite,
} from './store.js';

// ── THE TICKET WORKER — a tracker is read when a PR is RECEIVED, never when it is VIEWED ─────────
//
// Moved from the plugin (jira/ticket-sync.ts) into CORE at apiVersion 23 and made PROVIDER-
// DISPATCHED: the workspaces it walks are those whose tracker's adapter has a READER (Jira, GitHub Issues, Linear;
// ./registry.ts), and every read goes through that adapter. Everything below was written for Jira
// and holds for any reading provider.
//
// Pull-based, like core's ML enrichment worker: nothing is queued. Each pass re-derives the work
// from the database —
//   • every OPEN pull request in a workspace whose tracker READS tickets AND has its credential;
//   • detection on it (`detectKeysWithAccess`, the ONE rule: title + head branch — the PR body is
//     not stored under lean storage and is not a detection source);
//   • a ticket is DUE when it has no stored row (a new PR, or a title/branch edit that changed the
//     key set), when its row was read from a different Jira site, or when `next_check_at` has
//     passed (the TTL: 30 min after a read, 10 min after a transient failure, 6 h after Jira said
//     "no such ticket" / "not allowed");
//   • a stored key the PR no longer names is DELETED.
// Then at most `TICKET_LINKS_TITLE_LOOKUPS` (40) tickets per account per pass and `MAX_PER_TICK`
// overall are read, new ones first, `CONCURRENCY` at a time, each key ONCE per workspace per pass.
//
// MERGED PULL REQUESTS. Rows are never deleted when a PR merges — the open-PR walk simply stops
// visiting it, so a PR that was open when seen keeps its tickets. A PR that MERGED before the worker
// saw it (it predates the worker, it merged between two passes, or the deep backfill brought it in
// already merged) has no row, and core's ticket review would never count it. So each pass also
// takes MERGED PRs (never closed-unmerged ones) merged in the last `MERGED_WINDOW_MS` (90 days) that
// have NO stored row, and reads them in MISSING-ONLY mode: a key with no row (or a row from another
// Jira site) is read, a `failed` row is retried on its TTL, and nothing else — no TTL refresh, no
// prune, no re-label: a merged PR's rows are history. Bounded like everything else:
//   • ONE-TIME PER REPO: a repo's whole 90-day window is scanned ONCE; after that only PRs merged
//     in the last `RECENT_MERGED_MS`, and rows NEWER than the repo's highest PR id at that scan
//     (what the deep backfill inserts), are looked at. A PR still owed a row (over budget, backed
//     off, no token, a transient failure) is remembered BY ID and revisited each pass, so it never
//     forces a rescan. A repo walk re-opens that repo's window at most every `FULL_RESCAN_MS`; a
//     settings kick re-opens the account's, and a PR whose rows sit on another Jira site than its
//     workspace's current one is not settled, so a site move reads it again. The markers live in
//     memory: a restart scans again, which costs database reads only.
//   • ONE READ PER TICKET, NOT PER PR: a merged PR on a ticket that already has a stored row on the
//     same Jira site COPIES that row (re-deriving the criteria with its own workspace's field) and
//     makes no Jira call; the rest join the pass's per-(workspace, key) dedup. Merged-only tickets
//     queue after new open tickets and before TTL refreshes, inside the same budget.
//
// TRIGGERS: a `*/2` cron tick (TTL refresh, and PRs that arrive by webhook or the per-PR refresh,
// which never pass through a repo walk — sync/scheduler.ts), a kick after every repo sync
// (sync/repo-synced-hooks.ts, registered by ./index.ts), a kick when the tracker settings change,
// and a kick from the ticket-links route when it finds a detected ticket with no row. A kick for an
// account already running is folded into one more pass after it.
//
// BUDGETS ARE PRE-EMPTED, NEVER SURFACED: a 401 / 403 / a refused address backs the WORKSPACE off
// for 30 minutes and a 429 for 5, keyed on a fingerprint of (site, email, token), so saving a new
// token ends the backoff at once. A person pressing Refresh bypasses it.
//
// ⚠ NEVER INSIDE A SYNC TRANSACTION. Every fetch here is awaited outside any `runTransaction`; each
// row write is its own statement. ⚠ Logs carry account + workspace + the error CODE only — never the
// error object, the URL or Jira's body.

export const TRACKER_TICKET_CRON = '*/2 * * * *';
export const OK_TTL_MS = 30 * 60_000;
export const FAILED_TTL_MS = 10 * 60_000;
export const REFUSED_TTL_MS = 6 * 60 * 60_000;
export const BACKOFF_MS = 30 * 60_000;
export const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
export const PER_ACCOUNT_PASS = TICKET_LINKS_TITLE_LOOKUPS;
export const MAX_PER_TICK = 200;
const CONCURRENCY = 4;
/** How far back a MERGED PR is given rows it never had. */
export const MERGED_WINDOW_MS = 90 * 24 * 60 * 60_000;
/** Once a repo's window is settled, only PRs merged this recently are looked at. */
export const RECENT_MERGED_MS = 24 * 60 * 60_000;

// ---- the per-workspace backoff (in memory; a restart forgets it, which is harmless) ----

const backoff = new Map<string, { until: number; fp: string; code: string }>();
const backoffKey = (accountId: number, workspaceId: number): string => `${accountId}|${workspaceId}`;

/** A fingerprint of the credentials a workspace calls its tracker with. Never logged, never stored. */
export function accessFingerprint(call: TrackerCall): string {
  return createHash('sha256')
    .update(`${call.provider}\0${call.apiRoot}\0${call.credentials.email ?? ''}\0${call.credentials.token}`)
    .digest('hex')
    .slice(0, 16);
}

export function isBackedOff(accountId: number, workspaceId: number, fp: string, now: number): boolean {
  return backoffCode(accountId, workspaceId, fp, now) != null;
}

/** The Jira error CODE that put the workspace in backoff, or null when it is not backed off. */
export function backoffCode(accountId: number, workspaceId: number, fp: string, now: number): string | null {
  const b = backoff.get(backoffKey(accountId, workspaceId));
  return b != null && b.fp === fp && b.until > now ? b.code : null;
}

function backOff(accountId: number, workspaceId: number, fp: string, until: number, code: string): void {
  backoff.set(backoffKey(accountId, workspaceId), { until, fp, code });
}

// ---- detection with its source ----

export type { DetectedTicket };

/** Detection (the ONE rule) plus which source named each key. null = no tracker configured. */
export function detectWithSources(access: WorkspaceTrackerAccess, pr: DetectInput): DetectedTicket[] | null {
  return detectForAccess(access, pr);
}

// ---- one pass over a set of pull requests ----

interface PrRow {
  id: number;
  repoId: number;
  number: number;
  title: string | null;
  headRefName: string | null;
  githubNodeId: string;
  state: string;
  updatedAt: Date | null;
  closingIssues: string[] | null;
  closingIssuesCheckedAt: Date | null;
  linearLinks: string[] | null;
  linearLinksRoot: string | null;
  linearLinksCheckedAt: Date | null;
}

/** The PR columns a pass reads (detection + the linkers). */
function prColumns(pr: TrackerContext['schema'][string]) {
  return {
    id: pr.id,
    repoId: pr.repoId,
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    githubNodeId: pr.githubNodeId,
    state: pr.state,
    updatedAt: pr.updatedAt,
    ...prLinkColumns(pr),
    closingIssuesCheckedAt: pr.closingIssuesCheckedAt,
    linearLinksCheckedAt: pr.linearLinksCheckedAt,
  };
}

async function readPrRows(ctx: TrackerContext, accountId: number, ids: readonly number[]): Promise<PrRow[]> {
  const pr = ctx.schema.pullRequests;
  const rows = await inChunks([...ids], async (chunk) =>
    (await ctx.db
      .select(prColumns(pr))
      .from(pr)
      .where(and(eq(pr.accountId, accountId), inArray(pr.id, chunk)))
      .execute()) as PrRow[],
  );
  return rows.map((r) => withParsedLinks(r));
}

/** `https://github.com/<owner>/<repo>/pull/<n>` per PR (this account's repos only) — what Linear's
 *  attachments are keyed on. */
async function prUrlsFor(ctx: TrackerContext, accountId: number, rows: readonly PrRow[]): Promise<Map<number, string>> {
  const r = ctx.schema.repos;
  const repos = await inChunks([...new Set(rows.map((x) => x.repoId))], async (chunk) =>
    (await ctx.db
      .select({ id: r.id, owner: r.owner, name: r.name })
      .from(r)
      .where(and(eq(r.accountId, accountId), inArray(r.id, chunk)))
      .execute()) as Array<{ id: number; owner: string; name: string }>,
  );
  const byId = new Map(repos.map((x) => [x.id, x]));
  const out = new Map<number, string>();
  for (const row of rows) {
    const repo = byId.get(row.repoId);
    if (repo != null && row.number != null) out.set(row.id, `https://github.com/${repo.owner}/${repo.name}/pull/${row.number}`);
  }
  return out;
}

interface WorkspaceCall {
  access: WorkspaceTrackerAccess;
  call: TrackerCall | null; // null = no reading provider, or no usable credential
  apiRoot: string | null;
  fp: string | null;
}

export interface PassOptions {
  transport?: JiraTransport;
  now?: () => number;
  /** Max tickets read from Jira in this pass. */
  budget?: number;
  /** Keys (per PR) to read again whatever their `next_check_at`. */
  force?: ReadonlyMap<number, ReadonlySet<string>>;
  /** A person pressed a button: ignore the workspace backoff. */
  bypassBackoff?: boolean;
  /**
   * MERGED PRs to give the rows they never had (missing-only mode: no TTL refresh, no prune, no
   * re-label). An id also in `prIds` is treated as open.
   */
  mergedPrIds?: readonly number[];
}

export interface PassStats {
  fetched: number;
  failed: number;
  deleted: number;
  pending: number; // due tickets left for a later pass (over budget)
  copied: number; // merged-PR rows copied from a stored row of the same ticket, no Jira call
  /** Merged PRs (of `mergedPrIds`) still owed a row: over budget, backed off, failed or no token. */
  mergedUnsettled: Set<number>;
}

/** The workspace of each repo (this account only) and each workspace's tracker call. */
export async function workspaceCallsFor(
  ctx: TrackerContext,
  accountId: number,
  repoIds: readonly number[],
  transport?: JiraTransport,
): Promise<{ workspaceOfRepo: Map<number, number>; calls: Map<number, WorkspaceCall> }> {
  const github = githubAccessFor(ctx, accountId);
  const wr = ctx.schema.workspaceRepos;
  const memberships = await inChunks([...new Set(repoIds)], async (chunk) =>
    (await ctx.db
      .select({ repoId: wr.repoId, workspaceId: wr.workspaceId })
      .from(wr)
      .where(and(eq(wr.accountId, accountId), inArray(wr.repoId, chunk)))
      .execute()) as Array<{ repoId: number; workspaceId: number }>,
  );
  const workspaceOfRepo = new Map(memberships.map((m) => [m.repoId, m.workspaceId]));
  const calls = new Map<number, WorkspaceCall>();
  for (const wsId of new Set(memberships.map((m) => m.workspaceId))) {
    const access = trackerAccessOf(ctx.host, await readWorkspaceTrackerRow(ctx, accountId, wsId));
    let call: TrackerCall | null = null;
    if (maybeAdapterFor(access.issue.provider)?.reader != null) {
      const prepared = prepareTrackerCall(access, { cloud: ctx.host.isCloud, transport, github });
      if (prepared.ok) call = prepared.call;
    }
    calls.set(wsId, { access, call, apiRoot: call?.apiRoot ?? null, fp: call != null ? accessFingerprint(call) : null });
  }
  return { workspaceOfRepo, calls };
}

interface Want {
  workspaceId: number;
  key: string;
  prs: Array<{ prId: number; det: DetectedTicket; prior: StoredTicketRow | undefined; merged: boolean }>;
  missing: boolean;
  dueAt: number;
  /** Any OPEN PR on it. A merged-only ticket may be copied from a stored row instead of read. */
  hasOpen: boolean;
}

function errorCodeOf(err: unknown): { code: string; status: number | null } {
  if (err instanceof JiraFetchError) return { code: err.code, status: err.status };
  return { code: 'unknown', status: null };
}

/**
 * Detect, prune and read the due tickets of these pull requests (this account only). The worker's
 * ONE body: the cron tick, the post-sync kick, a Refresh and a field change all run it.
 */
export async function syncPrTickets(
  ctx: TrackerContext,
  accountId: number,
  prIds: readonly number[],
  opts: PassOptions = {},
): Promise<PassStats> {
  const now = opts.now ?? Date.now;
  const stats: PassStats = { fetched: 0, failed: 0, deleted: 0, pending: 0, copied: 0, mergedUnsettled: new Set() };
  const openIds = new Set(prIds);
  const mergedIds = new Set((opts.mergedPrIds ?? []).filter((id) => !openIds.has(id)));
  const ids = [...openIds, ...mergedIds];
  if (ids.length === 0) return stats;

  let prRows = await readPrRows(ctx, accountId, ids);
  if (prRows.length === 0) return stats;
  const { workspaceOfRepo, calls } = await workspaceCallsFor(
    ctx,
    accountId,
    prRows.map((r) => r.repoId),
    opts.transport,
  );

  // LINKS FIRST, for a provider whose links are READ (GitHub Issues: the issues each PR closes;
  // Linear: the issues its integration attached the PR to). Grouped per WORKSPACE (each has its own
  // call: Linear's key and root), only PRs in such a workspace with a usable call; nothing at all for
  // any other provider. A workspace in backoff is skipped (a person's Refresh bypasses it), and a
  // linker that stops on a refused key or a rate limit backs the workspace off like a reader would.
  const linkable = new Map<number, LinkerPr[]>();
  for (const row of prRows) {
    const wsId = workspaceOfRepo.get(row.repoId);
    const wc = wsId != null ? calls.get(wsId) : undefined;
    const provider = wc?.call?.provider;
    if (wsId == null || provider == null || maybeAdapterFor(provider)?.linker == null) continue;
    linkable.set(wsId, [...(linkable.get(wsId) ?? []), row]);
  }
  if (linkable.size > 0) {
    const t = now();
    let read = 0;
    const needUrls = [...linkable.keys()].some((ws) => calls.get(ws)?.call?.provider === 'linear');
    const urls = needUrls ? await prUrlsFor(ctx, accountId, prRows) : new Map<number, string>();
    for (const [wsId, prs] of linkable) {
      const wc = calls.get(wsId)!;
      const call = wc.call!;
      const linker = maybeAdapterFor(call.provider)!.linker!;
      if (!opts.bypassBackoff && wc.fp != null && isBackedOff(accountId, wsId, wc.fp, t)) continue;
      const withUrls = prs.map((p) => ({ ...p, prUrl: urls.get(p.id) ?? null }));
      if (!opts.bypassBackoff && withUrls.every((p) => !linker.isDue(p, t, call))) continue;
      const res = await linker.refresh(ctx, accountId, withUrls, { now: t, call });
      read += res.read;
      if (res.stop != null && wc.fp != null) {
        const rateLimited = res.stop.code === 'http' && res.stop.status === 429;
        const refused = res.stop.code === 'unauthorized' || res.stop.code === 'forbidden';
        if (rateLimited || refused) {
          backOff(accountId, wsId, wc.fp, t + (rateLimited ? RATE_LIMIT_BACKOFF_MS : BACKOFF_MS), res.stop.code);
        }
      }
    }
    if (read > 0) prRows = await readPrRows(ctx, accountId, prRows.map((r) => r.id));
  }
  const stored = groupByPr(await readStoredTickets(ctx, accountId, prRows.map((r) => r.id)));

  // Detect, prune, and collect what is due — grouped by (workspace, key): one read per pass.
  const t0 = now();
  const wants = new Map<string, Want>();
  for (const row of prRows) {
    const wsId = workspaceOfRepo.get(row.repoId);
    const wc = wsId != null ? calls.get(wsId) : undefined;
    const merged = mergedIds.has(row.id);
    // ⚠ LINKS NOT READ YET (GitHub Issues, budget or a first pass): nothing is known about this
    // PR's tickets, so nothing is pruned and nothing is read. A merged PR stays owed.
    if (wc != null && linksUnknownFor(wc.access.issue.provider, row)) {
      if (merged) stats.mergedUnsettled.add(row.id);
      continue;
    }
    const mine = stored.get(row.id) ?? [];
    // A ticket a person linked by hand (a 'manual' row on the current site) is detected like any
    // other: kept by the prune below and re-read on its TTL.
    const detected =
      wc != null ? (detectWithSources(wc.access, { ...row, manualKeys: manualKeysOf(mine, wc.access) }) ?? []) : [];
    // ⚠ Only a READING workspace's detection may PRUNE: a PR whose workspace has no tracker (or a
    // link-only one) simply has no rows, and one in no workspace keeps what it had (absent, not wrong).
    // A MERGED PR is never pruned: its rows are history.
    if (wc != null && !merged) {
      stats.deleted += await deleteStaleKeys(
        ctx,
        accountId,
        row.id,
        mine,
        new Set(detected.map((d) => d.key)),
        new Date(t0),
      );
    }
    if (wsId == null || wc?.call == null) {
      if (merged && detected.length > 0) stats.mergedUnsettled.add(row.id);
      continue;
    }
    const forced = opts.force?.get(row.id);
    for (const det of detected) {
      const prior = mine.find((r) => r.issueKey === det.key);
      const missing = prior == null || prior.apiRoot !== wc.apiRoot || prior.provider !== wc.call.provider;
      const dueAt = prior == null ? 0 : new Date(prior.nextCheckAt).getTime();
      if (merged) {
        // Missing-only: a row it never had, or a transient failure on its TTL. Nothing else.
        const failed = !missing && prior?.state === 'failed';
        if (failed && dueAt > t0) stats.mergedUnsettled.add(row.id); // retried on its TTL
        if (!missing && !(failed && dueAt <= t0)) continue;
      }
      const due = missing || dueAt <= t0 || forced?.has(det.key) === true;
      if (!due) {
        // Not due, but the key may have MOVED (branch → title, reordered): keep the cheap columns true.
        if (prior != null && (prior.detectedFrom !== det.from || prior.detectOrder !== det.order)) {
          await upsertTicketRow(ctx, accountId, row.id, det.key, {
            ...withoutIdentity(prior),
            detectedFrom: det.from,
            detectOrder: det.order,
          });
        }
        continue;
      }
      const k = `${wsId}|${det.key}`;
      const w =
        wants.get(k) ?? { workspaceId: wsId, key: det.key, prs: [], missing: false, dueAt: Infinity, hasOpen: false };
      w.prs.push({ prId: row.id, det, prior, merged });
      w.missing ||= missing;
      w.hasOpen ||= !merged;
      w.dueAt = Math.min(w.dueAt, forced?.has(det.key) ? -1 : dueAt);
      wants.set(k, w);
    }
  }

  const settings = await readAcFieldSettings(ctx, accountId, [...new Set([...wants.values()].map((w) => w.workspaceId))]);

  // A merged-only ticket already stored on the same Jira site (any PR, any workspace of this
  // account) is COPIED: one read per ticket, never one per PR.
  for (const [k, w] of wants) {
    if (w.hasOpen) continue;
    const wc = calls.get(w.workspaceId);
    if (wc?.apiRoot == null) continue;
    const source = await storedSibling(ctx, accountId, wc.call!.provider, wc.apiRoot, w.key);
    if (source == null) continue;
    const at = new Date(now());
    const ac = deriveAc(
      parseCandidates(source.candidatesJson),
      settingFor(settings, w.workspaceId, wc.apiRoot, source.issueTypeId),
    );
    const base = trackerBaseUrl(wc.access.issue);
    // The source row's link is for the same site and key (and carries Linear's own issue URL).
    const url = source.url !== '' ? source.url : base != null ? ticketUrl(wc.call!.provider, base, w.key) : '';
    for (const p of w.prs) {
      await upsertTicketRow(ctx, accountId, p.prId, w.key, {
        ...withoutIdentity(source),
        workspaceId: w.workspaceId,
        detectedFrom: p.det.from,
        detectOrder: p.det.order,
        url,
        errorCode: null,
        acceptanceCriteria: ac.text,
        acFieldId: ac.field?.id ?? null,
        acFieldName: ac.field?.name ?? null,
        acFieldSource: ac.source,
        checkedAt: at,
        nextCheckAt: new Date(at.getTime() + OK_TTL_MS),
      });
    }
    stats.copied += 1;
    wants.delete(k);
  }

  // FORCED keys (a person pressed a button: `syncOnePrNow`) first, then new open tickets, then
  // merged-only tickets, then the longest overdue; capped. A forced key whose row already exists
  // (a hand-added ticket's placeholder, a Refresh) must not lose its one slot to a new key.
  const rank = (w: Want): number => (w.dueAt < 0 ? -1 : w.hasOpen && w.missing ? 0 : !w.hasOpen ? 1 : 2);
  const queue = [...wants.values()].sort(
    (a, b) => rank(a) - rank(b) || a.dueAt - b.dueAt || a.key.localeCompare(b.key),
  );
  const budget = Math.max(0, opts.budget ?? PER_ACCOUNT_PASS);
  const batch = queue.slice(0, budget);
  stats.pending = queue.length - batch.length;
  const unsettle = (w: Want): void => {
    for (const p of w.prs) if (p.merged) stats.mergedUnsettled.add(p.prId);
  };
  for (const w of queue.slice(budget)) unsettle(w);
  if (batch.length === 0) return stats;

  const stopped = new Set<number>(); // workspaces refused during this pass

  const readOne = async (w: Want): Promise<void> => {
    const wc = calls.get(w.workspaceId);
    if (wc?.call == null || wc.apiRoot == null || wc.fp == null) return unsettle(w);
    if (stopped.has(w.workspaceId)) return unsettle(w);
    if (!opts.bypassBackoff && isBackedOff(accountId, w.workspaceId, wc.fp, now())) return unsettle(w);
    const provider = wc.call.provider;
    const base = trackerBaseUrl(wc.access.issue);
    let url = base != null ? ticketUrl(provider, base, w.key) : '';
    const at = new Date(now());
    try {
      const issue = await adapterFor(provider).reader!.fetchTicket(wc.call, w.key);
      // The tracker's own link when it gives one (Linear's issue URL, with its slug).
      if (issue.url != null && issue.url !== '') url = issue.url;
      const ac = deriveAc(
        issue.candidates,
        settingFor(settings, w.workspaceId, wc.apiRoot, issue.issueType?.id),
      );
      for (const p of w.prs) {
        await upsertTicketRow(ctx, accountId, p.prId, w.key, {
          workspaceId: w.workspaceId,
          provider,
          detectedFrom: p.det.from,
          detectOrder: p.det.order,
          apiRoot: wc.apiRoot,
          url,
          state: 'ok',
          errorCode: null,
          title: issue.title,
          description: issue.description,
          acceptanceCriteria: ac.text,
          acFieldId: ac.field?.id ?? null,
          acFieldName: ac.field?.name ?? null,
          acFieldSource: ac.source,
          issueTypeId: issue.issueType?.id ?? null,
          issueTypeName: issue.issueType?.name ?? null,
          statusName: issue.status?.name ?? null,
          statusCategory: issue.status?.category ?? null,
          assigneeName: issue.assignee?.name ?? null,
          assigneeAccountId: issue.assignee?.accountId ?? null,
          assigneeAvatarUrl: issue.assignee?.avatarUrl ?? null,
          candidatesJson: JSON.stringify(issue.candidates),
          omittedCandidates: issue.omittedCandidates,
          fetchedAt: at,
          checkedAt: at,
          nextCheckAt: new Date(at.getTime() + OK_TTL_MS),
        });
      }
      stats.fetched += 1;
    } catch (err) {
      stats.failed += 1;
      const { code, status } = errorCodeOf(err);
      const workspaceWide =
        code === 'unauthorized' || code === 'forbidden' || code === 'blocked' || code === 'bad_url' || code === 'redirect';
      const rateLimited = code === 'http' && status === 429;
      if (workspaceWide || rateLimited) {
        if (!stopped.has(w.workspaceId)) {
          ctx.log.warn({ accountId, workspaceId: w.workspaceId, code, route: 'tracker-worker' }, 'tracker request failed');
        }
        stopped.add(w.workspaceId);
        backOff(accountId, w.workspaceId, wc.fp, now() + (rateLimited ? RATE_LIMIT_BACKOFF_MS : BACKOFF_MS), code);
      }
      // 401, a refused address and a 429 say nothing about THIS ticket: no row is written, the
      // workspace backoff carries it. 404 / 403 / `no_access` (GitHub: a repository this account
      // cannot read — the workspace carries on) are statements about the ticket; anything else is
      // transient.
      if ((workspaceWide && code !== 'forbidden') || rateLimited) return unsettle(w);
      const state: TicketState =
        code === 'not_found' ? 'not_found' : code === 'forbidden' || code === 'no_access' ? 'no_access' : 'failed';
      // A transient failure leaves the merged PRs owed a row; a refusal is an answer.
      if (state === 'failed') unsettle(w);
      for (const p of w.prs) {
        const prior =
          p.prior != null && p.prior.apiRoot === wc.apiRoot && p.prior.provider === provider ? p.prior : undefined;
        const keepContent = state === 'failed' && prior != null && prior.fetchedAt != null;
        const ttl = state === 'failed' ? FAILED_TTL_MS : REFUSED_TTL_MS;
        await upsertTicketRow(ctx, accountId, p.prId, w.key, {
          ...(keepContent ? withoutIdentity(prior) : emptyContent()),
          workspaceId: w.workspaceId,
          provider,
          detectedFrom: p.det.from,
          detectOrder: p.det.order,
          apiRoot: wc.apiRoot,
          // A kept read keeps the link it was read with (Linear's own issue URL).
          url: keepContent && prior.url ? prior.url : url,
          state: keepContent ? 'ok' : state,
          errorCode: code,
          checkedAt: at,
          nextCheckAt: new Date(at.getTime() + ttl),
        });
      }
    }
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
      while (next < batch.length) {
        const w = batch[next++];
        if (w != null) await readOne(w);
      }
    }),
  );
  return stats;
}

/** The freshest readable stored row of one ticket on one site, this account only. */
async function storedSibling(
  ctx: TrackerContext,
  accountId: number,
  provider: TrackerProvider,
  apiRoot: string,
  key: string,
): Promise<StoredTicketRow | null> {
  const t = ctx.schema.trackerTickets;
  const rows = (await ctx.db
    .select()
    .from(t)
    .where(
      and(
        eq(t.accountId, accountId),
        eq(t.provider, provider),
        eq(t.apiRoot, apiRoot),
        eq(t.issueKey, key),
        eq(t.state, 'ok'),
        isNotNull(t.fetchedAt),
        isNotNull(t.title),
      ),
    )
    .orderBy(desc(t.fetchedAt), desc(t.id))
    .limit(1)
    .execute()) as StoredTicketRow[];
  return rows[0] ?? null;
}

function withoutIdentity(r: StoredTicketRow): TicketWrite {
  // `changedAt` is upsertTicketRow's to decide, never round-tripped.
  const { id: _id, accountId: _a, prId: _p, issueKey: _k, changedAt: _c, ...rest } = r;
  return rest;
}

function emptyContent(): Pick<
  StoredTicketRow,
  | 'title'
  | 'description'
  | 'acceptanceCriteria'
  | 'acFieldId'
  | 'acFieldName'
  | 'acFieldSource'
  | 'issueTypeId'
  | 'issueTypeName'
  | 'statusName'
  | 'statusCategory'
  | 'assigneeName'
  | 'assigneeAccountId'
  | 'assigneeAvatarUrl'
  | 'candidatesJson'
  | 'omittedCandidates'
  | 'fetchedAt'
> {
  return {
    title: null,
    description: null,
    acceptanceCriteria: null,
    acFieldId: null,
    acFieldName: null,
    acFieldSource: null,
    issueTypeId: null,
    issueTypeName: null,
    statusName: null,
    statusCategory: null,
    assigneeName: null,
    assigneeAccountId: null,
    assigneeAvatarUrl: null,
    candidatesJson: null,
    omittedCandidates: 0,
    fetchedAt: null,
  };
}

// ---- the account pass + the tick ----

/**
 * Workspaces (of one account, or of every account) whose tracker READS tickets and holds the
 * credential its reader needs (a saved token, unless the reader needs none).
 */
async function readingWorkspaces(
  ctx: TrackerContext,
  accountId: number | null,
): Promise<Array<{ accountId: number; workspaceId: number }>> {
  const providers = readingProviders();
  if (providers.length === 0) return [];
  const s = ctx.schema.workspaceTrackers;
  const rows = (await ctx.db
    .select({ accountId: s.accountId, workspaceId: s.workspaceId, provider: s.provider, authToken: s.authToken })
    .from(s)
    .where(and(inArray(s.provider, providers), ...(accountId != null ? [eq(s.accountId, accountId)] : [])))
    .execute()) as Array<{ accountId: number; workspaceId: number; provider: string; authToken: string | null }>;
  const stored = rows
    .filter((r) => maybeAdapterFor(r.provider)?.reader?.credential === 'none' || (r.authToken != null && r.authToken !== ''))
    .map((r) => ({ accountId: r.accountId, workspaceId: r.workspaceId }));
  // ⚠ PLUS THE AUTOMATIC DEFAULT: a workspace with no stored choice whose repo uses GitHub Issues
  // reads as GitHub Issues everywhere (./settings.ts), so the worker must read it too. GitHub Issues
  // needs no saved credential (the account's own GitHub token).
  if (!providers.includes('github')) return stored;
  return [...stored, ...(await autoDetectedWorkspaces(ctx, accountId))];
}

/** The repos of an account's reading workspaces (optionally just one). */
async function readingRepoIds(
  ctx: TrackerContext,
  accountId: number,
  workspaceIds: readonly number[],
  repoId: number | null,
): Promise<number[]> {
  if (workspaceIds.length === 0) return [];
  const wr = ctx.schema.workspaceRepos;
  const repos = (await ctx.db
    .select({ repoId: wr.repoId })
    .from(wr)
    .where(and(eq(wr.accountId, accountId), inArray(wr.workspaceId, [...workspaceIds])))
    .execute()) as Array<{ repoId: number }>;
  return [...new Set(repos.map((r) => r.repoId))].filter((id) => repoId == null || id === repoId);
}

/** The open PRs of these repos (this account only). */
async function openPrIdsFor(ctx: TrackerContext, accountId: number, repoIds: readonly number[]): Promise<number[]> {
  if (repoIds.length === 0) return [];
  const pr = ctx.schema.pullRequests;
  const rows = await inChunks(repoIds, async (chunk) =>
    (await ctx.db
      .select({ id: pr.id })
      .from(pr)
      .where(and(eq(pr.accountId, accountId), inArray(pr.repoId, chunk), eq(pr.state, 'open')))
      .execute()) as Array<{ id: number }>,
  );
  return rows.map((r) => r.id);
}

// ---- merged PRs: the one-time backfill per repo, then the recent window ----

// `${accountId}|${repoId}` → the repo's 90-day window was scanned: when, and the highest PR id the
// repo had then. After that only recent merges and NEW rows (an id above the watermark — what the
// deep backfill inserts) are read.
const backfillDone = new Map<string, { scannedAt: number; watermark: number }>();
// Repos a walk asked to re-open; honoured once `FULL_RESCAN_MS` has passed since the last scan.
const reopenAsked = new Set<string>();
// Per account: merged PR ids settled this process (rows on the current site, or no ticket).
const mergedSettled = new Map<number, Set<number>>();
// Per account: merged PR id → repo id, still owed a row after a pass (budget, backoff, no token, a
// transient failure). Revisited BY ID each pass, so its repo's window need not be rescanned.
const mergedOwed = new Map<number, Map<number, number>>();
const repoKey = (accountId: number, repoId: number): string => `${accountId}|${repoId}`;
/** A repo walk re-opens a scanned window at most this often (database reads only; no Jira call). */
export const FULL_RESCAN_MS = 30 * 60_000;

interface MergedCandidates {
  ids: number[];
  repoOf: Map<number, number>;
  /** Repos whose whole window was scanned this pass, with the watermark to record. */
  fullRepos: Map<number, number>;
}

/**
 * MERGED PRs (never closed-unmerged) of these repos that may be owed a row: merged inside the
 * window, not yet settled, and with no stored row on the workspace's CURRENT Jira site — plus the
 * PRs still owed from an earlier pass. A PR whose rows are all on the current site is settled: it
 * was open when seen, and its rows stay.
 */
async function mergedCandidates(
  ctx: TrackerContext,
  accountId: number,
  repoIds: readonly number[],
  nowMs: number,
): Promise<MergedCandidates> {
  const out: MergedCandidates = { ids: [], repoOf: new Map(), fullRepos: new Map() };
  if (repoIds.length === 0) return out;
  const isFull = (id: number): boolean => {
    const done = backfillDone.get(repoKey(accountId, id));
    if (done == null) return true;
    return reopenAsked.has(repoKey(accountId, id)) && nowMs - done.scannedAt >= FULL_RESCAN_MS;
  };
  const fullRepos = repoIds.filter(isFull);
  const recentRepos = repoIds.filter((id) => !isFull(id));
  const pr = ctx.schema.pullRequests;
  if (fullRepos.length > 0) {
    const tops = await inChunks(fullRepos, async (chunk) =>
      (await ctx.db
        .select({ repoId: pr.repoId, top: max(pr.id) })
        .from(pr)
        .where(and(eq(pr.accountId, accountId), inArray(pr.repoId, chunk)))
        .groupBy(pr.repoId)
        .execute()) as Array<{ repoId: number; top: number | string | null }>,
    );
    const topOf = new Map(tops.map((r) => [r.repoId, Number(r.top ?? 0)]));
    for (const id of fullRepos) out.fullRepos.set(id, topOf.get(id) ?? 0);
  }
  const windowStart = new Date(nowMs - MERGED_WINDOW_MS);
  const full = await inChunks(fullRepos, async (chunk) =>
    (await ctx.db
      .select({ id: pr.id, repoId: pr.repoId })
      .from(pr)
      .where(
        and(eq(pr.accountId, accountId), inArray(pr.repoId, chunk), eq(pr.state, 'merged'), gte(pr.mergedAt, windowStart)),
      )
      .orderBy(asc(pr.id))
      .execute()) as Array<{ id: number; repoId: number }>,
  );
  const recent = await inChunks(recentRepos, async (chunk) =>
    (await ctx.db
      .select({ id: pr.id, repoId: pr.repoId })
      .from(pr)
      .where(
        and(
          eq(pr.accountId, accountId),
          inArray(pr.repoId, chunk),
          eq(pr.state, 'merged'),
          gte(pr.mergedAt, windowStart),
          or(
            gte(pr.mergedAt, new Date(nowMs - RECENT_MERGED_MS)),
            ...chunk.map((r) =>
              and(eq(pr.repoId, r), gt(pr.id, backfillDone.get(repoKey(accountId, r))?.watermark ?? 0)),
            ),
          ),
        ),
      )
      .orderBy(asc(pr.id))
      .execute()) as Array<{ id: number; repoId: number }>,
  );
  const settled = mergedSettled.get(accountId) ?? new Set<number>();
  mergedSettled.set(accountId, settled);
  const owed = mergedOwed.get(accountId);
  const inScope = new Set(repoIds);
  if (owed != null) {
    for (const [id, repoId] of owed) {
      if (!inScope.has(repoId)) continue;
      out.ids.push(id);
      out.repoOf.set(id, repoId);
    }
  }
  const open = [...full, ...recent].filter((r) => !settled.has(r.id) && !out.repoOf.has(r.id));
  if (open.length === 0) return out;
  const t = ctx.schema.trackerTickets;
  const stateRows = await inChunks(
    open.map((r) => r.id),
    async (chunk) =>
      (await ctx.db
        .select({ prId: t.prId, state: t.state, apiRoot: t.apiRoot })
        .from(t)
        .where(and(eq(t.accountId, accountId), inArray(t.prId, chunk)))
        .execute()) as Array<{ prId: number; state: string; apiRoot: string }>,
  );
  // The site each repo's workspace reads now. No usable token (null): a stored row is as good as
  // it gets until the settings change, which re-opens the account.
  const siteOfRepo = new Map<number, string | null>();
  if (stateRows.length > 0) {
    const { workspaceOfRepo, calls } = await workspaceCallsFor(ctx, accountId, [...new Set(open.map((r) => r.repoId))]);
    for (const [repoId, wsId] of workspaceOfRepo) siteOfRepo.set(repoId, calls.get(wsId)?.apiRoot ?? null);
  }
  const rowsOf = new Map<number, Array<{ state: string; apiRoot: string }>>();
  for (const r of stateRows) rowsOf.set(r.prId, [...(rowsOf.get(r.prId) ?? []), r]);
  for (const r of open) {
    const mine = rowsOf.get(r.id) ?? [];
    const site = siteOfRepo.get(r.repoId) ?? null;
    const isSettled =
      mine.length > 0 && mine.every((x) => x.state !== 'failed' && (site == null || x.apiRoot === site));
    if (isSettled) {
      settled.add(r.id);
      continue;
    }
    out.ids.push(r.id);
    out.repoOf.set(r.id, r.repoId);
  }
  return out;
}

/**
 * Record what a pass settled. A PR still owed a row is remembered by id; a scanned repo's window is
 * marked done whatever its PRs' fate, so a lasting reason (no token, a backoff) never rescans it.
 */
function noteMergedSettled(
  accountId: number,
  c: MergedCandidates,
  unsettled: ReadonlySet<number>,
  nowMs: number,
): void {
  const settled = mergedSettled.get(accountId) ?? new Set<number>();
  mergedSettled.set(accountId, settled);
  const owed = mergedOwed.get(accountId) ?? new Map<number, number>();
  mergedOwed.set(accountId, owed);
  for (const id of c.ids) {
    const repoId = c.repoOf.get(id);
    if (unsettled.has(id) && repoId != null) owed.set(id, repoId);
    else {
      settled.add(id);
      owed.delete(id);
    }
  }
  for (const [repoId, watermark] of c.fullRepos) {
    backfillDone.set(repoKey(accountId, repoId), { scannedAt: nowMs, watermark });
    reopenAsked.delete(repoKey(accountId, repoId));
  }
}

/** Re-open the merged window: one repo (a repo walk, throttled) or the whole account (settings). */
function reopenMergedWindow(accountId: number, repoId: number | null): void {
  if (repoId != null) {
    if (backfillDone.has(repoKey(accountId, repoId))) reopenAsked.add(repoKey(accountId, repoId));
    return;
  }
  for (const k of [...backfillDone.keys()]) if (k.startsWith(`${accountId}|`)) backfillDone.delete(k);
  for (const k of [...reopenAsked]) if (k.startsWith(`${accountId}|`)) reopenAsked.delete(k);
  mergedSettled.delete(accountId);
  mergedOwed.delete(accountId);
}

/** One bounded pass over an account's open PRs, and its merged PRs owed a row, in reading workspaces. */
export async function runAccountPass(
  ctx: TrackerContext,
  accountId: number,
  opts: PassOptions & { repoId?: number | null } = {},
): Promise<PassStats> {
  const nowMs = (opts.now ?? Date.now)();
  const ws = await readingWorkspaces(ctx, accountId);
  const repoIds = await readingRepoIds(ctx, accountId, ws.map((w) => w.workspaceId), opts.repoId ?? null);
  const prIds = await openPrIdsFor(ctx, accountId, repoIds);
  const merged = await mergedCandidates(ctx, accountId, repoIds, nowMs);
  const stats = await syncPrTickets(ctx, accountId, prIds, { ...opts, mergedPrIds: merged.ids });
  noteMergedSettled(accountId, merged, stats.mergedUnsettled, nowMs);
  return stats;
}

// One pass per account at a time; a kick that lands mid-pass asks for ONE more pass after it.
const accountRunning = new Map<number, Promise<void>>();
const accountAgain = new Set<number>();
let enabled = false;
let tickRunning = false;

/** Called once at boot (./index.ts `startTracker`); tests switch it on and off. */
export function enableTrackerWorker(on: boolean): void {
  enabled = on;
}

/** Test seam: forget backoffs and locks. */
export function resetTrackerWorker(): void {
  backoff.clear();
  backfillDone.clear();
  reopenAsked.clear();
  mergedSettled.clear();
  mergedOwed.clear();
  accountRunning.clear();
  accountAgain.clear();
  prKickRunning.clear();
  tickRunning = false;
}

function runGuarded(ctx: TrackerContext, accountId: number, opts: PassOptions & { repoId?: number | null }): Promise<void> {
  const existing = accountRunning.get(accountId);
  if (existing != null) {
    accountAgain.add(accountId);
    return existing;
  }
  const p = (async () => {
    try {
      do {
        accountAgain.delete(accountId);
        await runAccountPass(ctx, accountId, opts);
      } while (accountAgain.has(accountId));
    } catch (err) {
      const { code } = errorCodeOf(err);
      ctx.log.warn({ accountId, code, route: 'tracker-worker' }, 'ticket pass failed (non-fatal)');
    } finally {
      accountRunning.delete(accountId);
    }
  })();
  accountRunning.set(accountId, p);
  return p;
}

/**
 * Kick a pass for one account (optionally one repo), fire-and-forget. Never throws. A no-op while
 * the worker is not enabled (before boot, and in tests that do not switch it on).
 */
export function kickTrackerSync(
  ctx: TrackerContext,
  accountId: number,
  opts: { repoId?: number | null; transport?: JiraTransport; now?: () => number } = {},
): Promise<void> {
  if (!enabled) return Promise.resolve();
  // A repo walk may have merged an old PR (its new rows are caught by the watermark anyway); a
  // settings change may have moved the Jira site or saved the first token.
  reopenMergedWindow(accountId, opts.repoId ?? null);
  return runGuarded(ctx, accountId, {
    repoId: opts.repoId ?? null,
    transport: opts.transport,
    ...(opts.now != null ? { now: opts.now } : {}),
  });
}

// Targeted kicks (the ticket-links route): one in flight per account; a second is dropped — the
// SPA asks again while `titlesComplete` is false, and that ask kicks again.
const prKickRunning = new Set<number>();

/** Read the due tickets of THESE PRs, fire-and-forget, bounded. Never throws. */
export function kickTrackerSyncForPrs(
  ctx: TrackerContext,
  accountId: number,
  prIds: readonly number[],
  opts: { transport?: JiraTransport } = {},
): Promise<void> {
  if (!enabled || prKickRunning.has(accountId) || prIds.length === 0) return Promise.resolve();
  prKickRunning.add(accountId);
  return syncPrTickets(ctx, accountId, prIds, { transport: opts.transport, budget: PER_ACCOUNT_PASS })
    .then(
      () => undefined,
      (err: unknown) => {
        const { code } = errorCodeOf(err);
        ctx.log.warn({ accountId, code, route: 'tracker-worker' }, 'ticket kick failed (non-fatal)');
      },
    )
    .finally(() => prKickRunning.delete(accountId));
}

/** The cron tick: every account with a reading workspace, bounded per account and in total. */
export async function runTrackerTick(
  ctx: TrackerContext,
  opts: { transport?: JiraTransport; now?: () => number } = {},
): Promise<void> {
  if (!enabled || tickRunning) return;
  tickRunning = true;
  try {
    // The automatic default's fact (./github/issues-usage.ts): a few due repos per tick, each at most
    // once a day. FIRST, so a workspace it switches on is read in this same tick.
    await refreshGithubIssuesUsage(ctx, opts.now != null ? { now: opts.now } : {});
    const accounts = [...new Set((await readingWorkspaces(ctx, null)).map((w) => w.accountId))];
    let left = MAX_PER_TICK;
    for (const accountId of accounts) {
      if (left <= 0) break;
      if (accountRunning.has(accountId)) continue;
      const p = (async () => {
        const s = await runAccountPass(ctx, accountId, {
          ...opts,
          budget: Math.min(PER_ACCOUNT_PASS, left),
        });
        left -= s.fetched + s.failed;
      })();
      accountRunning.set(accountId, p.then(() => undefined, () => undefined));
      try {
        await p;
      } catch (err) {
        const { code } = errorCodeOf(err);
        ctx.log.warn({ accountId, code, route: 'tracker-worker' }, 'ticket pass failed (non-fatal)');
      } finally {
        accountRunning.delete(accountId);
      }
    }
  } catch (err) {
    const { code } = errorCodeOf(err);
    ctx.log.warn({ code, route: 'tracker-worker' }, 'ticket tick failed (non-fatal)');
  } finally {
    tickRunning = false;
  }
}

/**
 * Read these keys of ONE PR from its tracker NOW, through the worker's own body, and wait — the story
 * panel's Refresh and field change, and the first read of a ticket the worker has not reached.
 * `force` re-reads even a fresh row; without it only a missing or due row is read.
 */
export async function syncOnePrNow(
  ctx: TrackerContext,
  accountId: number,
  prId: number,
  keys: readonly string[],
  opts: { force: boolean; transport?: JiraTransport; now?: () => number },
): Promise<PassStats> {
  return syncPrTickets(ctx, accountId, [prId], {
    transport: opts.transport,
    now: opts.now,
    budget: Math.max(1, keys.length),
    // The named keys are always due and first in the queue; `force` decides only whether a person
    // pressing a button may override the workspace backoff.
    force: new Map([[prId, new Set(keys)]]),
    bypassBackoff: opts.force,
  });
}
