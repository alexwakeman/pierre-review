// THE RELEASE CHECK'S DB HALF (docs/RELEASES.md § The release check) — gathers the stored inputs of
// shared `foldReleaseCheck` and answers GET /api/releases. DB ONLY: never a GitHub or tracker call.
//
//   • Repos: the workspace's RELEASABLE repos only (db/release-repos.ts: ticked "Released from this
//     workspace", ∩ its current membership — unticked repos are ignored entirely), their stored tags,
//     `writable` from the synced `viewerPermission` (the ONE WRITE_PERMISSIONS set).
//   • THE HISTORY PASS (sync/release-history.ts) is read here: the walked first-parent commits from
//     this workspace's baseline up (`release_history_commits`, seq ≥ the newest walked release tag's)
//     → releases/history-fold.ts `historyView` → each tag's place on the default branch and each tag's
//     INCREMENT (a missing one is still being read), and the walk's progress (`history`).
//   • PRs: one per LIGHT record (`release_range_prs`) in an increment (merged into the default branch
//     by definition); a PR also stored in `pull_requests` lends its full row (links, author, the PR
//     tab's id).
//   • OPEN PRs: the stored `pull_requests` rows still open INTO THE DEFAULT BRANCH (a base not synced yet
//     counts) in ANY of the workspace's releasable repos, with the tickets THE detection rule names on
//     them — a Complete ticket with one does not qualify. A hotfix PR (into `hotfix/…`) is not one.
//   • Tickets: THE detection rule (`releasePrDetectInput` → `detectKeysWithAccess`) on each range PR,
//     plus a stored PR's own `tracker_tickets` rows, ON THE WORKSPACE'S TRACKER SITE only. A ticket's
//     reads come from three stores — the PR rows, the batched status rows (`tracker_ticket_status`,
//     tracker/ticket-status.ts) and the sprint rows — and `bestTicketRead` keeps the freshest
//     successful one. DONE = the This Sprint stage resolver (`sprintStageOf` over `sprintLayoutFor`)
//     says Complete (`stage === 'done'`; a Cancelled ticket does not qualify, like any not-Done one) —
//     never a second resolver. A ticket with no read yet is `not_read`: "checking" (the scan reads it
//     in its next batch); a batched read that failed RELEASE_TICKET_FAILS_MAX times in a row is
//     `failed` — listed as "could not be read", never a block. A workspace whose tracker cannot read at
//     all (`ticketsReadable` false) lists its tickets as "could not be read" too.
//   • PROGRESS: the fold derives it; the scan's live step (releases/scan-state.ts) is laid over it while
//     fresh (for its "waiting for GitHub's rate limit"). Still DB + memory only.
//   • Bot-ness: `globalAutomationUserIds` (the stored author, or the login's user row) or the light
//     record's own rule — never the hidden-bots list.
//   • THE OLDER BAND's size is per (workspace, repo), in memory (releases/older-tags.ts): the fold lists at
//     most that many older tags. THE TICKET DETAIL (GET /api/releases only, `detail`): each ticket's type,
//     assignee and last read from the stored reads, and the MERGED stored PRs naming it in the releasable
//     repos (the "Elsewhere" list) — still DB only.
import { and, count, desc, eq, gte, inArray, max } from 'drizzle-orm';
import {
  TRACKER_PROVIDER_LABEL,
  clampOlderTagsWanted,
  foldReleaseCheck,
  releaseScanLine,
  releaseSettingsConfigured,
  tagKind,
  trackerTicketIdent,
  type ReleaseCheckInput,
  type ReleaseCheckMergedPrInput,
  type ReleaseCheckResult,
  type ReleaseCheckOpenPrInput,
  type ReleaseCheckPrInput,
  type ReleaseCheckTicketInput,
  type ReleaseSettings,
  type ReleaseTicketReadState,
  type ReleasesResponse,
  type SprintStatusLayout,
  type TrackerProvider,
} from '@pierre-review/shared';
import { globalAutomationUserIds } from './automation-ids.js';
import { db, schema } from './client.js';
import { WRITE_PERMISSIONS, resolveWorkspaceScope } from './queries.js';
import { getReleaseRepos } from './release-repos.js';
import { getReleaseSettings } from './release-settings.js';
import { getRepoTags } from './repo-tags.js';
import { liveScanStep } from '../releases/scan-state.js';
import { olderTagsWanted } from '../releases/older-tags.js';
import { historyView, type HistoryIncrement } from '../releases/history-fold.js';
import { RELEASE_TICKET_FAILS_MAX } from '../tracker/ticket-status.js';
import { sprintLayoutFor, sprintStageOf } from './sprint-status-layout.js';

const { repos, pullRequests, trackerTickets, sprintTickets, releases, releaseHistoryCommits, releaseRangePrs, trackerTicketStatus, users } = schema;

const CHUNK = 400;

function chunks<T>(xs: readonly T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Done = the workspace's Complete stage ONLY, through THE This Sprint stage resolver. With no stored
 *  layout (the sprint was never read) the resolver's category fallback decides (`done` → Complete, but
 *  a name that reads as cancelled — "Won't do" — → Cancelled, which is NOT Done and holds the tag).
 *  Pure. */
export function ticketIsDone(
  layout: Pick<SprintStatusLayout, 'order' | 'buckets'> | null,
  statusName: string | null,
  statusCategory: string | null,
): boolean {
  if (statusName == null && statusCategory == null) return false;
  return sprintStageOf(layout ?? { order: [] }, { name: statusName ?? '', category: statusCategory }) === 'done';
}

const READ_STATES = new Set<ReleaseTicketReadState>(['ok', 'not_found', 'no_access', 'failed']);

interface TicketRow {
  prId: number;
  issueKey: string;
  url: string;
  state: string;
  title: string | null;
  statusName: string | null;
  statusCategory: string | null;
  fetchedAt: Date | null;
  checkedAt: Date;
  issueTypeName: string | null;
  assigneeName: string | null;
}

/** The ticket from its rows (one per PR): the newest successful read, else the newest attempt. Pure. */
export function bestTicketRow<R extends Pick<TicketRow, 'state' | 'fetchedAt' | 'checkedAt'>>(rows: readonly R[]): R | null {
  const ms = (d: Date | null): number => (d == null ? 0 : d.getTime());
  const ok = rows.filter((r) => r.state === 'ok' && r.fetchedAt != null).sort((a, b) => ms(b.fetchedAt) - ms(a.fetchedAt));
  if (ok[0] != null) return ok[0];
  return [...rows].sort((a, b) => ms(b.checkedAt) - ms(a.checkedAt))[0] ?? null;
}

/** The workspace's tracker as the check needs it: the detection access, whether it can READ tickets
 *  (a reading adapter and a usable credential), and its name. DB only. */
async function workspaceTrackerOf(accountId: number, workspaceId: number) {
  // LAZY: tracker/runtime.ts opens the database at import.
  const [{ trackerContext }, { readWorkspaceTrackerRow, trackerAccessOf }, { maybeAdapterFor }, { prepareTrackerCall }, { githubAccessFor }] =
    await Promise.all([
      import('../tracker/runtime.js'),
      import('../tracker/settings.js'),
      import('../tracker/registry.js'),
      import('../tracker/calls.js'),
      import('../tracker/context.js'),
    ]);
  const ctx = trackerContext();
  const access = trackerAccessOf(ctx.host, await readWorkspaceTrackerRow(ctx, accountId, workspaceId));
  const provider = access.issue.provider;
  const readable =
    maybeAdapterFor(provider)?.reader != null && prepareTrackerCall(access, { github: githubAccessFor(ctx, accountId) }).ok;
  const name = provider != null && provider in TRACKER_PROVIDER_LABEL ? TRACKER_PROVIDER_LABEL[provider as keyof typeof TRACKER_PROVIDER_LABEL] : null;
  return { access, readable, name };
}

/** What THE ONE detection rule (tracker/enricher.ts `detectKeysWithAccess`: title + head branch +
 *  stored links) reads off a range PR: its FULL row when one is stored (links included), else its
 *  LIGHT record from the history pass (title + head branch; no links read). ONE function for both, so
 *  a light record and a stored PR with the same title and branch name the same tickets. Pure. */
export function releasePrDetectInput<S extends { title: string; headRefName: string | null }>(
  light: { title: string; headRefName: string | null },
  stored: S | null,
): S | { title: string; headRefName: string | null } {
  if (stored != null) return stored;
  return { title: light.title, headRefName: light.headRefName };
}

/** One read of a ticket from any of its stores, for `bestTicketRead`. */
export interface TicketReadCandidate {
  source: 'pr' | 'status' | 'sprint';
  state: string;
  key: string;
  title: string | null;
  url: string | null;
  statusName: string | null;
  statusCategory: string | null;
  fetchedAt: Date | null;
  checkedAt: Date;
  /** status rows: failed reads in a row. */
  attempts?: number;
  typeName?: string | null;
  assigneeName?: string | null;
}

/**
 * THE ticket read the release check believes, from every store (a PR's row, the batched status row,
 * the sprint row): the freshest SUCCESSFUL read — unless the tracker said `not_found` or `no_access`
 * AFTER it (a ticket deleted or moved since: BMD-1026, 2026-11-16), which wins; a transient `failed`
 * never replaces a successful read. With none, the newest attempt's state — a batched read that FAILED
 * fewer than `failsMax` times in a row is "not read yet" (checking, retried); past that it is `failed`
 * ("could not be read", listed, never a block). Pure.
 */
export function bestTicketRead(
  cands: readonly TicketReadCandidate[],
  failsMax: number,
): { read: TicketReadCandidate | null; readState: ReleaseTicketReadState } {
  const ms = (d: Date | null): number => (d == null ? 0 : d.getTime());
  const ok = cands.filter((c) => c.state === 'ok' && c.fetchedAt != null).sort((a, b) => ms(b.fetchedAt) - ms(a.fetchedAt));
  const refused = cands
    .filter((c) => c.state === 'not_found' || c.state === 'no_access')
    .sort((a, b) => ms(b.checkedAt) - ms(a.checkedAt))[0];
  if (ok[0] != null) {
    if (refused != null && ms(refused.checkedAt) > ms(ok[0].fetchedAt)) return { read: refused, readState: refused.state as ReleaseTicketReadState };
    return { read: ok[0], readState: 'ok' };
  }
  const last = [...cands].sort((a, b) => ms(b.checkedAt) - ms(a.checkedAt))[0] ?? null;
  if (last == null) return { read: null, readState: 'not_read' };
  if (last.state === 'failed' && last.source === 'status' && (last.attempts ?? 0) < failsMax) return { read: last, readState: 'not_read' };
  const st = last.state as ReleaseTicketReadState;
  return { read: last, readState: READ_STATES.has(st) && st !== 'ok' ? st : 'not_read' };
}

/** When a ticket of the check was last read (any store), for the scan's batched refresh. */
export interface TicketReadInfo {
  ident: string;
  key: string;
  readState: ReleaseTicketReadState;
  /** The newest read or attempt (null = never). */
  lastAt: Date | null;
}

export interface ReleaseCheckLoaded {
  input: ReleaseCheckInput;
  reads: TicketReadInfo[];
}

/** Every stored input of the fold for one workspace (the caller checked the settings are set). Only the
 *  RELEASABLE repos among `repoIds` are read (an unticked id is dropped here, whoever asks). `detail`:
 *  also the ticket detail's merged PRs (GET /api/releases). */
export async function loadReleaseCheckInput(
  accountId: number,
  workspaceId: number,
  requestedRepoIds: readonly number[],
  settings: ReleaseSettings,
  opts: { detail?: boolean } = {},
): Promise<ReleaseCheckInput> {
  return (await loadReleaseCheck(accountId, workspaceId, requestedRepoIds, settings, opts)).input;
}

type StoredPr = {
  id: number;
  repoId: number;
  number: number;
  title: string;
  headRefName: string | null;
  authorId: number | null;
  closingIssues?: unknown;
  linearLinks?: unknown;
  linearLinksRoot?: unknown;
};

/** The loader, with when each ticket was last read (the scan's refresh reads that). DB only. */
export async function loadReleaseCheck(
  accountId: number,
  workspaceId: number,
  requestedRepoIds: readonly number[],
  settings: ReleaseSettings,
  opts: { detail?: boolean } = {},
): Promise<ReleaseCheckLoaded> {
  const ticked = await getReleaseRepos(accountId, workspaceId);
  const repoIds = [...new Set(requestedRepoIds)].filter((id) => ticked.has(id));
  const repoRows =
    repoIds.length === 0
      ? []
      : await db
          .select({
            id: repos.id,
            owner: repos.owner,
            name: repos.name,
            defaultBranch: repos.defaultBranch,
            defaultBranchName: repos.defaultBranchName,
            viewerPermission: repos.viewerPermission,
          })
          .from(repos)
          .where(and(eq(repos.accountId, accountId), inArray(repos.id, [...repoIds])))
          .execute();
  const ids = repoRows.map((r) => r.id);
  const tags = await getRepoTags(accountId, ids);
  const { readHistoryScan, historyProgress } = await import('../sync/release-history.js');

  // ── Per repo: the walked history → each tag's place on the default branch and its increment ──
  interface RepoHistory {
    onDefault: Map<string, boolean | null>;
    increments: HistoryIncrement[];
    history: { done: number; total: number; complete: boolean };
  }
  const historyByRepo = new Map<number, RepoHistory>();
  const hc = releaseHistoryCommits;
  for (const r of repoRows) {
    const repoTagsOf = tags.filter((t) => t.repoId === r.id);
    const scan = await readHistoryScan(accountId, r.id);
    // The floor: the newest WALKED release tag of this workspace (its baseline). Older commits are not
    // needed, and not loaded.
    const releaseShas = [...new Set(repoTagsOf.filter((t) => tagKind(t.name, settings) === 'release').map((t) => t.sha))];
    let floorSeq: number | null = null;
    for (const part of chunks(releaseShas)) {
      const row = (
        await db
          .select({ seq: max(hc.seq) })
          .from(hc)
          .where(and(eq(hc.accountId, accountId), eq(hc.repoId, r.id), inArray(hc.sha, part)))
          .execute()
      )[0];
      if (row?.seq != null) floorSeq = Math.max(floorSeq ?? Number.NEGATIVE_INFINITY, Number(row.seq));
    }
    const commitRows =
      scan == null
        ? []
        : await db
            .select({ sha: hc.sha, seq: hc.seq, prNumbers: hc.prNumbers, committedAt: hc.committedAt })
            .from(hc)
            .where(and(eq(hc.accountId, accountId), eq(hc.repoId, r.id), ...(floorSeq != null ? [gte(hc.seq, floorSeq)] : [])))
            .execute();
    const walked =
      scan == null
        ? 0
        : Number((await db.select({ n: count() }).from(hc).where(and(eq(hc.accountId, accountId), eq(hc.repoId, r.id))).execute())[0]?.n ?? 0);
    const topAt = scan == null ? null : (commitRows.find((c) => c.sha === scan.topSha)?.committedAt ?? null);
    const view = historyView(
      commitRows.map((c) => ({ ...c, prNumbers: c.prNumbers ?? [] })),
      repoTagsOf,
      {
        coversAll: scan != null && scan.deepExpectedSha == null && floorSeq == null,
        tipPending: scan == null || scan.tipStartSha != null,
        topCommittedAt: topAt,
      },
    );
    // Complete for THIS workspace: no newer head left, and the deep walk met its baseline or the root.
    const complete = scan != null && scan.tipStartSha == null && (scan.deepExpectedSha == null || floorSeq != null);
    const progress = scan == null ? { done: 0, total: 0 } : historyProgress(scan, walked, floorSeq != null);
    historyByRepo.set(r.id, { onDefault: view.onDefaultBranch, increments: view.increments, history: { ...progress, complete } });
  }

  // ── The range PRs: their light records, and the full row when one is stored ──
  const lightRows: Array<typeof releaseRangePrs.$inferSelect> = [];
  for (const r of repoRows) {
    const numbers = [...new Set((historyByRepo.get(r.id)?.increments ?? []).flatMap((x) => x.prNumbers))];
    for (const part of chunks(numbers)) {
      lightRows.push(
        ...(await db
          .select()
          .from(releaseRangePrs)
          .where(and(eq(releaseRangePrs.accountId, accountId), eq(releaseRangePrs.repoId, r.id), inArray(releaseRangePrs.number, part)))
          .execute()),
      );
    }
  }
  const lightByKey = new Map(lightRows.map((l) => [`${l.repoId}#${l.number}`, l]));
  const { prLinkColumns, detectKeysWithAccess, withParsedLinks } = await import('../tracker/enricher.js');
  const storedByKey = new Map<string, StoredPr>();
  for (const r of repoRows) {
    const numbers = lightRows.filter((l) => l.repoId === r.id).map((l) => l.number);
    for (const part of chunks(numbers)) {
      const rows = (await db
        .select({
          id: pullRequests.id,
          repoId: pullRequests.repoId,
          number: pullRequests.number,
          title: pullRequests.title,
          headRefName: pullRequests.headRefName,
          authorId: pullRequests.authorId,
          ...prLinkColumns(pullRequests),
        })
        .from(pullRequests)
        .where(and(eq(pullRequests.accountId, accountId), eq(pullRequests.repoId, r.id), inArray(pullRequests.number, part)))
        .execute()) as StoredPr[];
      for (const p of rows) storedByKey.set(`${p.repoId}#${p.number}`, p);
    }
  }

  // The workspace's tracker site (LAZY: db/stories.ts reaches the tracker runtime).
  const { workspaceSite } = await import('./stories.js');
  const site = await workspaceSite(accountId, workspaceId);
  const tracker = site != null ? await workspaceTrackerOf(accountId, workspaceId) : null;
  const identOf = (issueKey: string): string => trackerTicketIdent(site!.provider as TrackerProvider, site!.apiRoot, issueKey);

  // Ticket keys per range PR: THE detection rule (on the stored row, else the light record), plus a
  // stored PR's own ticket rows on the site (a ticket linked by hand, a link read).
  const ticketSelect = {
    prId: trackerTickets.prId,
    issueKey: trackerTickets.issueKey,
    url: trackerTickets.url,
    state: trackerTickets.state,
    title: trackerTickets.title,
    statusName: trackerTickets.statusName,
    statusCategory: trackerTickets.statusCategory,
    fetchedAt: trackerTickets.fetchedAt,
    checkedAt: trackerTickets.checkedAt,
    issueTypeName: trackerTickets.issueTypeName,
    assigneeName: trackerTickets.assigneeName,
  };
  const siteWhere =
    site != null ? and(eq(trackerTickets.accountId, accountId), eq(trackerTickets.provider, site.provider), eq(trackerTickets.apiRoot, site.apiRoot)) : null;
  const prRowsByPrId = new Map<number, TicketRow[]>();
  if (siteWhere != null) {
    for (const part of chunks([...storedByKey.values()].map((p) => p.id))) {
      for (const r of await db.select(ticketSelect).from(trackerTickets).where(and(siteWhere, inArray(trackerTickets.prId, part))).execute()) {
        prRowsByPrId.set(r.prId, [...(prRowsByPrId.get(r.prId) ?? []), r]);
      }
    }
  }
  const keysByLight = new Map<number, string[]>();
  if (tracker != null) {
    for (const l of lightRows) {
      const stored = storedByKey.get(`${l.repoId}#${l.number}`) ?? null;
      const detected =
        detectKeysWithAccess(
          tracker.access,
          withParsedLinks(releasePrDetectInput(l, stored) as { title: string; headRefName: string | null; closingIssues?: unknown; linearLinks?: unknown; linearLinksRoot?: unknown }),
        ) ?? [];
      const keys = [...detected];
      for (const row of stored != null ? (prRowsByPrId.get(stored.id) ?? []) : []) if (!keys.includes(row.issueKey)) keys.push(row.issueKey);
      if (keys.length > 0) keysByLight.set(l.id, keys);
    }
  }

  // ── The OPEN PRs into the default branch in every releasable repo of the workspace (not only the
  // ones asked for): a Complete ticket with one does not qualify. THE detection rule on the stored
  // row, plus its own ticket rows on the site. ──
  const openPrs: ReleaseCheckOpenPrInput[] = [];
  /** Ticket keys the open PRs name: a ticket with ONLY open work is listed too ("Not in a tag yet"). */
  const openKeys: string[] = [];
  if (tracker != null && ticked.size > 0) {
    const tickedIds = [...ticked.keys()];
    const names = new Map<number, { owner: string; name: string; branch: string | null }>();
    for (const part of chunks(tickedIds)) {
      for (const r of await db
        .select({ id: repos.id, owner: repos.owner, name: repos.name, defaultBranch: repos.defaultBranch, defaultBranchName: repos.defaultBranchName })
        .from(repos)
        .where(and(eq(repos.accountId, accountId), inArray(repos.id, part)))
        .execute()) {
        names.set(r.id, { owner: r.owner, name: r.name, branch: r.defaultBranch ?? r.defaultBranchName ?? null });
      }
    }
    const open: Array<StoredPr & { baseRefName: string | null }> = [];
    for (const part of chunks([...names.keys()])) {
      open.push(
        ...((await db
          .select({
            id: pullRequests.id,
            repoId: pullRequests.repoId,
            number: pullRequests.number,
            title: pullRequests.title,
            headRefName: pullRequests.headRefName,
            baseRefName: pullRequests.baseRefName,
            authorId: pullRequests.authorId,
            ...prLinkColumns(pullRequests),
          })
          .from(pullRequests)
          .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.repoId, part), eq(pullRequests.state, 'open')))
          .execute()) as Array<StoredPr & { baseRefName: string | null }>),
      );
    }
    const openRows = new Map<number, string[]>();
    if (siteWhere != null) {
      for (const part of chunks(open.map((p) => p.id))) {
        for (const r of await db
          .select({ prId: trackerTickets.prId, issueKey: trackerTickets.issueKey })
          .from(trackerTickets)
          .where(and(siteWhere, inArray(trackerTickets.prId, part)))
          .execute()) {
          openRows.set(r.prId, [...(openRows.get(r.prId) ?? []), r.issueKey]);
        }
      }
    }
    const openAuthors = new Map<number, string>();
    for (const part of chunks([...new Set(open.map((p) => p.authorId).filter((x): x is number => x != null))])) {
      for (const u of await db.select({ id: users.id, login: users.githubLogin }).from(users).where(inArray(users.id, part)).execute()) {
        openAuthors.set(u.id, u.login);
      }
    }
    for (const p of open) {
      const n = names.get(p.repoId)!;
      // Into another branch (a hotfix branch): not work still on its way to the default branch.
      if (p.baseRefName != null && n.branch != null && p.baseRefName !== n.branch) continue;
      const keys = [
        ...(detectKeysWithAccess(
          tracker.access,
          withParsedLinks(p as { title: string; headRefName: string | null; closingIssues?: unknown; linearLinks?: unknown; linearLinksRoot?: unknown }),
        ) ?? []),
      ];
      for (const k of openRows.get(p.id) ?? []) if (!keys.includes(k)) keys.push(k);
      if (keys.length === 0) continue;
      openKeys.push(...keys);
      openPrs.push({
        repoId: p.repoId,
        repoName: n.name,
        number: p.number,
        url: `https://github.com/${n.owner}/${n.name}/pull/${p.number}`,
        prId: p.id,
        ticketIdents: keys.map(identOf),
        title: p.title,
        authorLogin: p.authorId != null ? (openAuthors.get(p.authorId) ?? null) : null,
      });
    }
  }

  // ── The tickets: every store's reads; the freshest successful one wins ──
  const keyByIdent = new Map<string, string>();
  for (const keys of keysByLight.values()) for (const k of keys) keyByIdent.set(identOf(k), k);
  for (const k of openKeys) if (!keyByIdent.has(identOf(k))) keyByIdent.set(identOf(k), k);
  const idents = [...keyByIdent.keys()];
  const cands = new Map<string, TicketReadCandidate[]>();
  const add = (ident: string, c: TicketReadCandidate): void => {
    cands.set(ident, [...(cands.get(ident) ?? []), c]);
  };
  if (siteWhere != null) {
    for (const part of chunks([...new Set(keyByIdent.values())])) {
      for (const r of await db.select(ticketSelect).from(trackerTickets).where(and(siteWhere, inArray(trackerTickets.issueKey, part))).execute()) {
        add(identOf(r.issueKey), {
          source: 'pr',
          state: r.state,
          key: r.issueKey,
          title: r.title,
          url: r.url,
          statusName: r.statusName,
          statusCategory: r.statusCategory,
          fetchedAt: r.fetchedAt,
          checkedAt: r.checkedAt,
          typeName: r.issueTypeName,
          assigneeName: r.assigneeName,
        });
      }
    }
    for (const part of chunks(idents)) {
      const rows = await db
        .select()
        .from(trackerTicketStatus)
        .where(and(eq(trackerTicketStatus.accountId, accountId), eq(trackerTicketStatus.workspaceId, workspaceId), inArray(trackerTicketStatus.ident, part)))
        .execute();
      for (const r of rows) {
        if (r.provider !== site!.provider || r.apiRoot !== site!.apiRoot) continue;
        add(r.ident, {
          source: 'status',
          state: r.state,
          key: r.issueKey,
          title: r.title,
          url: r.url,
          statusName: r.statusName,
          statusCategory: r.statusCategory,
          fetchedAt: r.fetchedAt,
          checkedAt: r.checkedAt,
          attempts: r.attempts,
          typeName: r.issueTypeName,
          assigneeName: r.assigneeName,
        });
      }
      const srows = await db
        .select({
          ident: sprintTickets.ident,
          statusName: sprintTickets.statusName,
          statusCategory: sprintTickets.statusCategory,
          fetchedAt: sprintTickets.fetchedAt,
          title: sprintTickets.title,
          url: sprintTickets.url,
          issueTypeName: sprintTickets.issueTypeName,
          assigneeName: sprintTickets.assigneeName,
        })
        .from(sprintTickets)
        .where(and(eq(sprintTickets.accountId, accountId), eq(sprintTickets.workspaceId, workspaceId), inArray(sprintTickets.ident, part)))
        .execute();
      for (const r of srows) {
        add(r.ident, {
          source: 'sprint',
          state: 'ok',
          key: keyByIdent.get(r.ident)!,
          title: r.title,
          url: r.url,
          statusName: r.statusName,
          statusCategory: r.statusCategory,
          fetchedAt: r.fetchedAt,
          checkedAt: r.fetchedAt,
          typeName: r.issueTypeName,
          assigneeName: r.assigneeName,
        });
      }
    }
  }
  const layout = idents.length > 0 ? await sprintLayoutFor(accountId, workspaceId) : null;
  const reads: TicketReadInfo[] = [];
  const tickets: ReleaseCheckTicketInput[] = idents.map((ident) => {
    const list = cands.get(ident) ?? [];
    const { read, readState } = bestTicketRead(list, RELEASE_TICKET_FAILS_MAX);
    const key = keyByIdent.get(ident)!;
    const lastAt = list.reduce<Date | null>((m, c) => (m == null || c.checkedAt.getTime() > m.getTime() ? c.checkedAt : m), null);
    reads.push({ ident, key, readState, lastAt });
    const ok = readState === 'ok';
    // The detail: the chosen read's type and assignee, else the freshest successful read that has one.
    const okReads = list
      .filter((c) => c.state === 'ok' && c.fetchedAt != null)
      .sort((a, b) => b.fetchedAt!.getTime() - a.fetchedAt!.getTime());
    const pick = (f: (c: TicketReadCandidate) => string | null | undefined): string | null =>
      (read != null && ok ? f(read) : null) ?? okReads.map(f).find((v) => v != null) ?? null;
    return {
      ident,
      key: read?.key ?? key,
      title: read?.title ?? list.find((c) => c.title != null)?.title ?? null,
      url: read?.url ?? list.find((c) => c.url != null)?.url ?? null,
      statusName: ok ? (read?.statusName ?? null) : null,
      done: ok && ticketIsDone(layout, read?.statusName ?? null, read?.statusCategory ?? null),
      readState,
      stage: ok && (read?.statusName != null || read?.statusCategory != null)
        ? sprintStageOf(layout ?? { order: [] }, { name: read?.statusName ?? '', category: read?.statusCategory ?? null })
        : null,
      typeName: pick((c) => c.typeName),
      assigneeName: pick((c) => c.assigneeName),
      readAt: okReads[0]?.fetchedAt ?? null,
    };
  });

  // ── The PRs: one per light record. Bot-ness by the GLOBAL automation set (the stored author, or
  // the login's user row), or the light record's own rule (GitHub typed it a Bot, a known vendor). ──
  const bots = lightRows.length > 0 ? await globalAutomationUserIds() : new Set<number>();
  const botLogins = new Set<string>();
  for (const part of chunks([...new Set(lightRows.map((l) => l.authorLogin).filter((x): x is string => x != null))])) {
    for (const u of await db.select({ id: users.id, login: users.githubLogin }).from(users).where(inArray(users.githubLogin, part)).execute()) {
      if (bots.has(u.id)) botLogins.add(u.login);
    }
  }
  const prs: ReleaseCheckPrInput[] = lightRows.map((l) => {
    const stored = storedByKey.get(`${l.repoId}#${l.number}`) ?? null;
    const isBot =
      l.isBot || (stored?.authorId != null && bots.has(stored.authorId)) || (l.authorLogin != null && botLogins.has(l.authorLogin));
    return {
      id: l.id,
      prId: stored?.id ?? null,
      repoId: l.repoId,
      number: l.number,
      title: stored?.title ?? l.title,
      url: l.url,
      isBot,
      // The history pass keeps only PRs merged into the default branch.
      mergedAt: l.mergedAt,
      ticketIdents: (keysByLight.get(l.id) ?? []).map(identOf),
      authorLogin: l.authorLogin,
    };
  });

  // ── THE TICKET DETAIL's merged stored PRs (GET /api/releases only): every MERGED `pull_requests` row
  // into the default branch of a releasable repo whose ticket rows name one of the check's tickets. ──
  const mergedPrs: ReleaseCheckMergedPrInput[] = [];
  if (opts.detail === true && siteWhere != null && ticked.size > 0 && keyByIdent.size > 0) {
    const tickedIds = new Set(ticked.keys());
    const byPr = new Map<number, string[]>();
    for (const part of chunks([...new Set(keyByIdent.values())])) {
      for (const r of await db
        .select({ prId: trackerTickets.prId, issueKey: trackerTickets.issueKey })
        .from(trackerTickets)
        .where(and(siteWhere, inArray(trackerTickets.issueKey, part)))
        .execute()) {
        byPr.set(r.prId, [...(byPr.get(r.prId) ?? []), r.issueKey]);
      }
    }
    const repoInfo = new Map<number, { owner: string; name: string; branch: string | null }>();
    for (const part of chunks([...tickedIds])) {
      for (const r of await db
        .select({ id: repos.id, owner: repos.owner, name: repos.name, defaultBranch: repos.defaultBranch, defaultBranchName: repos.defaultBranchName })
        .from(repos)
        .where(and(eq(repos.accountId, accountId), inArray(repos.id, part)))
        .execute()) {
        repoInfo.set(r.id, { owner: r.owner, name: r.name, branch: r.defaultBranch ?? r.defaultBranchName ?? null });
      }
    }
    const rows: Array<{ id: number; repoId: number; number: number; title: string; baseRefName: string | null; mergedAt: Date | null; authorId: number | null }> = [];
    for (const part of chunks([...byPr.keys()])) {
      rows.push(
        ...(await db
          .select({
            id: pullRequests.id,
            repoId: pullRequests.repoId,
            number: pullRequests.number,
            title: pullRequests.title,
            baseRefName: pullRequests.baseRefName,
            mergedAt: pullRequests.mergedAt,
            authorId: pullRequests.authorId,
          })
          .from(pullRequests)
          .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, part), eq(pullRequests.state, 'merged')))
          .execute()),
      );
    }
    const authors = new Map<number, string>();
    for (const part of chunks([...new Set(rows.map((p) => p.authorId).filter((x): x is number => x != null))])) {
      for (const u of await db.select({ id: users.id, login: users.githubLogin }).from(users).where(inArray(users.id, part)).execute()) {
        authors.set(u.id, u.login);
      }
    }
    for (const p of rows) {
      const n = repoInfo.get(p.repoId);
      if (n == null || !tickedIds.has(p.repoId)) continue;
      if (p.baseRefName != null && n.branch != null && p.baseRefName !== n.branch) continue;
      mergedPrs.push({
        repoId: p.repoId,
        repoName: n.name,
        number: p.number,
        title: p.title,
        url: `https://github.com/${n.owner}/${n.name}/pull/${p.number}`,
        prId: p.id,
        authorLogin: p.authorId != null ? (authors.get(p.authorId) ?? null) : null,
        mergedAt: p.mergedAt,
        ticketIdents: [...new Set(byPr.get(p.id) ?? [])].map(identOf),
      });
    }
  }

  return {
    input: {
      settings,
      ticketsReadable: tracker?.readable ?? true,
      trackerName: tracker?.name ?? null,
      repos: [...repoRows]
        .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
        .map((r) => {
          const h = historyByRepo.get(r.id)!;
          return {
            repoId: r.id,
            fullName: `${r.owner}/${r.name}`,
            name: r.name,
            writable: WRITE_PERMISSIONS.has(r.viewerPermission ?? ''),
            defaultBranch: r.defaultBranch ?? r.defaultBranchName ?? null,
            history: h.history,
            olderWanted: clampOlderTagsWanted(olderTagsWanted(accountId, workspaceId, r.id)),
            tags: tags
              .filter((t) => t.repoId === r.id)
              .map((t) => ({
                name: t.name,
                sha: t.sha,
                committedAt: t.committedAt,
                taggedAt: t.taggedAt,
                onDefaultBranch: h.onDefault.get(t.name) ?? null,
                moved: t.movedAt != null,
              })),
            ranges: h.increments.map((x) => {
              const prIds: number[] = [];
              const unresolvedPrNumbers: number[] = [];
              for (const n of x.prNumbers) {
                const l = lightByKey.get(`${r.id}#${n}`);
                if (l != null) prIds.push(l.id);
                else unresolvedPrNumbers.push(n);
              }
              return {
                tagName: x.tagName,
                sha: x.sha,
                baseTagName: x.baseTagName,
                baseSha: x.baseSha,
                prIds,
                unresolvedPrNumbers,
                unmatchedCommits: x.unmatchedCommits,
              };
            }),
          };
        }),
      prs,
      openPrs,
      mergedPrs,
      tickets,
    },
    reads,
  };
}

/**
 * The scan's LIVE step laid over the fold's derived progress, per repo, while it is fresh and work is
 * left (the tickets step is always the derived one: the stored rows are the truth). Mutates `result`.
 */
export function withLiveProgress(result: ReleaseCheckResult, input: Pick<ReleaseCheckInput, 'repos' | 'trackerName'>, now: number = Date.now()): ReleaseCheckResult {
  for (const r of result.repos) {
    const row = r.checking && r.progress?.step === 'history';
    const older = r.older.loading && r.older.progress?.step === 'history';
    if (!row && !older) continue;
    const live = liveScanStep(r.repoId, now);
    if (live == null || live.step !== 'history') continue;
    const repo = input.repos.find((x) => x.repoId === r.repoId);
    const p = { step: live.step, done: live.done, total: live.total, branch: repo?.defaultBranch ?? null, paused: live.paused };
    const progress = { step: p.step, done: p.done, total: p.total, line: releaseScanLine(p) };
    if (row) r.progress = progress;
    if (older) r.older.progress = { ...progress };
  }
  return result;
}

/** A ticket read this long ago is read again by the scan's next batch (its status decides the answer). */
export const RELEASE_TICKET_TTL_MS = 10 * 60_000;
/** A failed batched read is tried again after this long. */
export const RELEASE_TICKET_RETRY_MS = 2 * 60_000;

/** The keys the scan's batch should read now: not read yet, failed and due, or read longer ago than
 *  the TTL. `force` (Refresh): every ticket of `scope`. Pure. */
export function ticketKeysOwed(
  reads: readonly TicketReadInfo[],
  nowMs: number,
  opts: { force?: boolean; ttlMs?: number; retryMs?: number } = {},
): string[] {
  const ttl = opts.ttlMs ?? RELEASE_TICKET_TTL_MS;
  const retry = opts.retryMs ?? RELEASE_TICKET_RETRY_MS;
  const out: string[] = [];
  for (const r of reads) {
    const age = r.lastAt == null ? Infinity : nowMs - r.lastAt.getTime();
    const due = opts.force === true || r.lastAt == null || (r.readState === 'not_read' ? age >= retry : age >= ttl);
    if (due && !out.includes(r.key)) out.push(r.key);
  }
  return out.sort();
}

/**
 * The release scan's ticket step (sync/tags-step.ts): one releasable repo's tickets (in the tags after
 * this workspace's baseline) whose status the next batch should read, and how many are not read yet.
 * DB only. Nothing when the workspace's tracker cannot read.
 */
export async function releaseTicketKeysOwed(
  accountId: number,
  workspaceId: number,
  repoId: number,
  settings: ReleaseSettings,
  nowMs: number = Date.now(),
): Promise<{ keys: string[]; waiting: number }> {
  if (!releaseSettingsConfigured(settings)) return { keys: [], waiting: 0 };
  const { input, reads } = await loadReleaseCheck(accountId, workspaceId, [repoId], settings);
  if (input.ticketsReadable === false) return { keys: [], waiting: 0 };
  return { keys: ticketKeysOwed(reads, nowMs), waiting: reads.filter((r) => r.readState === 'not_read').length };
}

/**
 * THE HISTORY PASS MAY STOP EARLY (docs/RELEASES.md § The release check, rule 4): true when, for EVERY
 * workspace releasing this repo, the check already names a candidate — the newest-first walk found a
 * qualifying tag whose scope is read, so nothing older needs reading — AND its older band (the candidate +
 * the wanted older tags, releases/older-tags.ts) needs no older history. DB only. A view with no workspace
 * id (it cannot be checked) answers false.
 */
export async function releaseCandidateProven(
  accountId: number,
  repoId: number,
  views: ReadonlyArray<{ workspaceId?: number; settings: ReleaseSettings }>,
): Promise<boolean> {
  if (views.length === 0) return false;
  for (const v of views) {
    if (v.workspaceId == null || !releaseSettingsConfigured(v.settings)) return false;
    const { input } = await loadReleaseCheck(accountId, v.workspaceId, [repoId], v.settings);
    const repo = foldReleaseCheck(input).repos.find((r) => r.repoId === repoId);
    if (repo?.status !== 'candidate') return false;
    // The older band (candidate + its wanted older tags) still needs older history.
    if (repo.older.needsHistory) return false;
  }
  return true;
}

/** GET /api/releases. `rawWorkspace` absent / unknown / unparseable ⇒ the Default workspace. With no
 *  releasable repo the check is null (the tab's setup line). */
export async function getReleases(accountId: number, rawWorkspace: string | number | undefined | null): Promise<ReleasesResponse> {
  const scope = await resolveWorkspaceScope(accountId, rawWorkspace);
  const workspaceId = scope.workspaceId;
  const settings = (await getReleaseSettings(accountId, workspaceId)) ?? { releaseSuffix: null, hotfixSuffix: null };
  const latest = (
    await db
      .select({ id: releases.id, createdAt: releases.createdAt, state: releases.state })
      .from(releases)
      .where(and(eq(releases.accountId, accountId), eq(releases.workspaceId, workspaceId)))
      .orderBy(desc(releases.createdAt), desc(releases.id))
      .limit(1)
      .execute()
  )[0];
  const base = {
    workspaceId,
    configured: releaseSettingsConfigured(settings),
    releaseSuffix: settings.releaseSuffix,
    hotfixSuffix: settings.hotfixSuffix,
    latestRelease: latest != null ? { id: latest.id, createdAt: latest.createdAt.toISOString(), state: latest.state } : null,
  };
  const releasable = [...(await getReleaseRepos(accountId, workspaceId)).keys()];
  const withRepos = { ...base, hasReleasableRepos: releasable.length > 0 };
  if (!base.configured || releasable.length === 0) return { ...withRepos, latestReleaseTagAt: null, check: null };
  const input = await loadReleaseCheckInput(accountId, workspaceId, releasable, settings, { detail: true });
  let latestTagMs: number | null = null;
  for (const r of input.repos) {
    for (const t of r.tags) {
      const k = tagKind(t.name, settings);
      if ((k === 'release' || k === 'hotfix') && t.committedAt != null) {
        latestTagMs = Math.max(latestTagMs ?? 0, t.committedAt.getTime());
      }
    }
  }
  return {
    ...withRepos,
    latestReleaseTagAt: latestTagMs == null ? null : new Date(latestTagMs).toISOString(),
    check: withLiveProgress(foldReleaseCheck(input), input),
  };
}
