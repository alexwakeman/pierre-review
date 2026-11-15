// THE RELEASE CHECK'S DB HALF (docs/RELEASES.md § The release check) — gathers the stored inputs of
// shared `foldReleaseCheck` and answers GET /api/releases. DB ONLY: never a GitHub or tracker call.
//
//   • Repos: the workspace's RELEASABLE repos only (db/release-repos.ts: ticked "Released from this
//     workspace", ∩ its current membership — unticked repos are ignored entirely), their start tags,
//     their stored tags and range increments (db/repo-tags.ts), `writable` from the synced
//     `viewerPermission` (the ONE WRITE_PERMISSIONS set).
//   • PRs: every PR in a stored range (each repository is judged on its own: a ticket's PRs elsewhere
//     do not count).
//   • Tickets: `tracker_tickets` rows ON THE WORKSPACE'S TRACKER SITE only (a row of another site is a
//     ticket of a tracker the workspace no longer uses: not a link). The best row per ticket is the
//     newest successful read; a fresher `sprint_tickets` row's status wins. DONE = the This Sprint
//     stage resolver (`sprintStageOf` over `sprintLayoutFor`) says Complete — never a second resolver.
//     A range PR with a ticket key THE detection rule finds but no stored row yet is `not_read` (blocks).
//   • A 'history' range (the oldest tag) is read fresh from the stored PRs, never from its frozen row.
//   • Bot-ness: `globalAutomationUserIds`, never the hidden-bots list.
import { and, desc, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import {
  foldReleaseCheck,
  releaseSettingsConfigured,
  tagKind,
  trackerTicketIdent,
  type ReleaseCheckInput,
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
import { getRepoTags, getTagRanges } from './repo-tags.js';
import { sprintLayoutFor, sprintStageOf } from './sprint-status-layout.js';

const { repos, pullRequests, trackerTickets, sprintTickets, releases } = schema;

const CHUNK = 400;

function chunks<T>(xs: readonly T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Done = the workspace's Complete stage, through THE This Sprint stage resolver. With no stored
 *  layout (the sprint was never read) the resolver's category fallback decides (`done` → Complete,
 *  so "Won't do" counts). Pure. */
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
}

/** The ticket from its rows (one per PR): the newest successful read, else the newest attempt. Pure. */
export function bestTicketRow<R extends Pick<TicketRow, 'state' | 'fetchedAt' | 'checkedAt'>>(rows: readonly R[]): R | null {
  const ms = (d: Date | null): number => (d == null ? 0 : d.getTime());
  const ok = rows.filter((r) => r.state === 'ok' && r.fetchedAt != null).sort((a, b) => ms(b.fetchedAt) - ms(a.fetchedAt));
  if (ok[0] != null) return ok[0];
  return [...rows].sort((a, b) => ms(b.checkedAt) - ms(a.checkedAt))[0] ?? null;
}

/**
 * THE ONE detection rule (tracker/enricher.ts `detectKeysWithAccess`: title + head branch + stored
 * links) over these PRs, against the WORKSPACE's tracker: prId → keys. DB only (no tracker call). A
 * key detected on a range PR with no stored row is a ticket the worker has not read yet — it BLOCKS
 * (`not_read`), never passes as an untracked PR.
 */
async function detectedKeysByPr(accountId: number, workspaceId: number, prIds: readonly number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (prIds.length === 0) return out;
  // LAZY: tracker/runtime.ts opens the database at import.
  const [{ trackerContext }, { readWorkspaceTrackerRow, trackerAccessOf }, { detectKeysWithAccess, withParsedLinks, prLinkColumns }] =
    await Promise.all([import('../tracker/runtime.js'), import('../tracker/settings.js'), import('../tracker/enricher.js')]);
  const ctx = trackerContext();
  const access = trackerAccessOf(ctx.host, await readWorkspaceTrackerRow(ctx, accountId, workspaceId));
  for (const part of chunks(prIds)) {
    const rows = await db
      .select({ id: pullRequests.id, title: pullRequests.title, headRefName: pullRequests.headRefName, ...prLinkColumns(pullRequests) })
      .from(pullRequests)
      .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, part)))
      .execute();
    for (const r of rows) {
      const keys = detectKeysWithAccess(access, withParsedLinks(r as typeof r & { closingIssues?: unknown; linearLinks?: unknown; linearLinksRoot?: unknown }));
      if (keys != null && keys.length > 0) out.set(r.id, keys);
    }
  }
  return out;
}

/**
 * A 'history' range (the oldest tag: no base) is read FRESH from the stored PRs, never from its frozen
 * row: PRs the deep backfill brings in after the row was computed must enter it. Merged into the
 * default branch no later than the tag's commit (or by the tag's own commit). prIds per tag name.
 */
async function historyPrIds(
  accountId: number,
  repoId: number,
  defaultBranch: string,
  tag: { sha: string; committedAt: Date },
): Promise<number[]> {
  const rows = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        eq(pullRequests.state, 'merged'),
        eq(pullRequests.baseRefName, defaultBranch),
        or(
          eq(pullRequests.mergeCommitOid, tag.sha),
          and(isNotNull(pullRequests.mergedAt), lte(pullRequests.mergedAt, tag.committedAt)),
        ),
      ),
    )
    .execute();
  return [...new Set(rows.map((r) => r.id))].sort((a, b) => a - b);
}

/** Every stored input of the fold for one workspace (the caller checked the settings are set). Only the
 *  RELEASABLE repos among `repoIds` are read (an unticked id is dropped here, whoever asks). */
export async function loadReleaseCheckInput(
  accountId: number,
  workspaceId: number,
  requestedRepoIds: readonly number[],
  settings: ReleaseSettings,
): Promise<ReleaseCheckInput> {
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
  const [tags, storedRanges] = await Promise.all([getRepoTags(accountId, ids), getTagRanges(accountId, ids)]);
  const repoRowById = new Map(repoRows.map((r) => [r.id, r]));
  const ranges = await Promise.all(
    storedRanges.map(async (r) => {
      if (r.method !== 'history') return r;
      const tag = tags.find((t) => t.repoId === r.repoId && t.name === r.tagName);
      const row = repoRowById.get(r.repoId);
      const def = row?.defaultBranch ?? row?.defaultBranchName ?? null;
      if (tag == null || tag.sha !== r.sha || tag.committedAt == null || def == null) return r;
      return { ...r, prIds: await historyPrIds(accountId, r.repoId, def, { sha: tag.sha, committedAt: tag.committedAt }), unresolvedPrNumbers: [] };
    }),
  );

  // The workspace's tracker site (LAZY: db/stories.ts reaches the tracker runtime).
  const { workspaceSite } = await import('./stories.js');
  const site = await workspaceSite(accountId, workspaceId);

  const rangePrIds = [...new Set(ranges.flatMap((r) => r.prIds))];
  const ticketRows: TicketRow[] = [];
  const detectedOnly = new Map<number, string[]>();
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
  };
  if (site != null) {
    for (const part of chunks(rangePrIds)) {
      ticketRows.push(
        ...(await db
          .select(ticketSelect)
          .from(trackerTickets)
          .where(
            and(
              eq(trackerTickets.accountId, accountId),
              eq(trackerTickets.provider, site.provider),
              eq(trackerTickets.apiRoot, site.apiRoot),
              inArray(trackerTickets.prId, part),
            ),
          )
          .execute()),
      );
    }
    // Keys the detection rule finds on a range PR but no stored row answers for that PR yet.
    const rowKeys = new Map<number, Set<string>>();
    for (const r of ticketRows) rowKeys.set(r.prId, (rowKeys.get(r.prId) ?? new Set()).add(r.issueKey));
    for (const [prId, keys] of await detectedKeysByPr(accountId, workspaceId, rangePrIds)) {
      const missing = keys.filter((k) => !(rowKeys.get(prId)?.has(k) ?? false));
      if (missing.length > 0) detectedOnly.set(prId, missing);
    }
    // The same tickets' rows on OTHER PRs: a ticket read through another PR is read (its status counts),
    // though those PRs are not in this check.
    const keys = [...new Set([...ticketRows.map((r) => r.issueKey), ...[...detectedOnly.values()].flat()])];
    const have = new Set(ticketRows.map((r) => `${r.prId}#${r.issueKey}`));
    for (const part of chunks(keys)) {
      const more = await db
        .select(ticketSelect)
        .from(trackerTickets)
        .where(
          and(
            eq(trackerTickets.accountId, accountId),
            eq(trackerTickets.provider, site.provider),
            eq(trackerTickets.apiRoot, site.apiRoot),
            inArray(trackerTickets.issueKey, part),
          ),
        )
        .execute();
      for (const r of more) if (!have.has(`${r.prId}#${r.issueKey}`)) ticketRows.push(r);
    }
  }

  // The PRs: the ranges' only, within the releasable repos.
  const prIdSet = rangePrIds;
  type PrRow = {
    id: number;
    repoId: number;
    number: number;
    title: string;
    state: 'open' | 'merged' | 'closed';
    baseRefName: string | null;
    mergedAt: Date | null;
    authorId: number | null;
  };
  const prRows: PrRow[] = [];
  if (ids.length > 0) {
    for (const part of chunks(prIdSet)) {
      prRows.push(
        ...((await db
          .select({
            id: pullRequests.id,
            repoId: pullRequests.repoId,
            number: pullRequests.number,
            title: pullRequests.title,
            state: pullRequests.state,
            baseRefName: pullRequests.baseRefName,
            mergedAt: pullRequests.mergedAt,
            authorId: pullRequests.authorId,
          })
          .from(pullRequests)
          .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.repoId, ids), inArray(pullRequests.id, part)))
          .execute()) as PrRow[]),
      );
    }
  }
  const bots = prRows.some((p) => p.authorId != null) ? await globalAutomationUserIds() : new Set<number>();

  const identOf = (issueKey: string): string => trackerTicketIdent(site!.provider as TrackerProvider, site!.apiRoot, issueKey);
  const identsByPr = new Map<number, string[]>();
  const rowsByIdent = new Map<string, TicketRow[]>();
  for (const r of ticketRows) {
    const ident = identOf(r.issueKey);
    const list = identsByPr.get(r.prId) ?? [];
    if (!list.includes(ident)) list.push(ident);
    identsByPr.set(r.prId, list);
    rowsByIdent.set(ident, [...(rowsByIdent.get(ident) ?? []), r]);
  }
  /** Detected on a range PR, no stored row anywhere on the site: ident → key (read state `not_read`). */
  const unreadKeys = new Map<string, string>();
  for (const [prId, keys] of detectedOnly) {
    for (const key of keys) {
      const ident = identOf(key);
      const list = identsByPr.get(prId) ?? [];
      if (!list.includes(ident)) list.push(ident);
      identsByPr.set(prId, list);
      if (!rowsByIdent.has(ident)) unreadKeys.set(ident, key);
    }
  }

  const repoById = new Map(repoRows.map((r) => [r.id, r]));
  const defaultOf = (repoId: number): string | null => {
    const r = repoById.get(repoId);
    return r?.defaultBranch ?? r?.defaultBranchName ?? null;
  };
  const prs: ReleaseCheckPrInput[] = prRows.map((p) => {
    const r = repoById.get(p.repoId)!;
    const def = defaultOf(p.repoId);
    return {
      id: p.id,
      repoId: p.repoId,
      number: p.number,
      title: p.title,
      url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}`,
      isBot: p.authorId != null && bots.has(p.authorId),
      intoDefaultBranch: def != null && p.baseRefName === def,
      state: p.state,
      mergedAt: p.mergedAt,
      ticketIdents: identsByPr.get(p.id) ?? [],
    };
  });

  // The tickets: best stored read, a fresher sprint read's status wins, Done by the stage resolver.
  const idents = [...rowsByIdent.keys(), ...unreadKeys.keys()];
  const sprintByIdent = new Map<string, { statusName: string | null; statusCategory: string | null; fetchedAt: Date; title: string; url: string | null }>();
  for (const part of chunks(idents)) {
    const srows = await db
        .select({
          ident: sprintTickets.ident,
          statusName: sprintTickets.statusName,
          statusCategory: sprintTickets.statusCategory,
          fetchedAt: sprintTickets.fetchedAt,
          title: sprintTickets.title,
          url: sprintTickets.url,
        })
        .from(sprintTickets)
        .where(and(eq(sprintTickets.accountId, accountId), eq(sprintTickets.workspaceId, workspaceId), inArray(sprintTickets.ident, part)))
        .execute();
    for (const s of srows) sprintByIdent.set(s.ident, s);
  }
  const layout = idents.length > 0 ? await sprintLayoutFor(accountId, workspaceId) : null;
  const tickets: ReleaseCheckTicketInput[] = idents.map((ident) => {
    const unreadKey = unreadKeys.get(ident);
    if (unreadKey != null) {
      // A sprint read of it is a real read of the ticket; with none, it is not read yet (blocks).
      const sprint = sprintByIdent.get(ident);
      if (sprint == null) return { ident, key: unreadKey, title: null, url: null, statusName: null, done: false, readState: 'not_read' };
      return {
        ident,
        key: unreadKey,
        title: sprint.title,
        url: sprint.url,
        statusName: sprint.statusName,
        done: ticketIsDone(layout, sprint.statusName, sprint.statusCategory),
        readState: 'ok',
      };
    }
    const rows = rowsByIdent.get(ident)!;
    const best = bestTicketRow(rows)!;
    const readState: ReleaseTicketReadState =
      best.state === 'ok' && best.fetchedAt != null
        ? 'ok'
        : READ_STATES.has(best.state as ReleaseTicketReadState) && best.state !== 'ok'
          ? (best.state as ReleaseTicketReadState)
          : 'not_read';
    const sprint = sprintByIdent.get(ident);
    const useSprint = sprint != null && (best.fetchedAt == null || sprint.fetchedAt.getTime() > best.fetchedAt.getTime());
    const statusName = useSprint ? sprint.statusName : best.statusName;
    const statusCategory = useSprint ? sprint.statusCategory : best.statusCategory;
    return {
      ident,
      key: best.issueKey,
      title: best.title ?? sprint?.title ?? null,
      url: best.url ?? sprint?.url ?? null,
      statusName,
      done: readState === 'ok' && ticketIsDone(layout, statusName, statusCategory),
      readState,
    };
  });

  const tagsByRepo = new Map<number, typeof tags>();
  for (const t of tags) tagsByRepo.set(t.repoId, [...(tagsByRepo.get(t.repoId) ?? []), t]);
  const rangesByRepo = new Map<number, typeof ranges>();
  for (const r of ranges) rangesByRepo.set(r.repoId, [...(rangesByRepo.get(r.repoId) ?? []), r]);

  return {
    settings,
    repos: [...repoRows]
      .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
      .map((r) => ({
        repoId: r.id,
        fullName: `${r.owner}/${r.name}`,
        name: r.name,
        writable: WRITE_PERMISSIONS.has(r.viewerPermission ?? ''),
        startTag: ticked.get(r.id)?.startTag ?? null,
        tags: (tagsByRepo.get(r.id) ?? []).map((t) => ({
          name: t.name,
          sha: t.sha,
          committedAt: t.committedAt,
          taggedAt: t.taggedAt,
          onDefaultBranch: t.onDefaultBranch,
          moved: t.movedAt != null,
        })),
        ranges: (rangesByRepo.get(r.id) ?? []).map((x) => ({
          tagName: x.tagName,
          sha: x.sha,
          baseTagName: x.baseTagName,
          baseSha: x.baseSha,
          method: x.method,
          prIds: x.prIds,
          unresolvedPrNumbers: x.unresolvedPrNumbers,
          unmatchedCommits: x.unmatchedCommits,
          truncated: x.truncated,
        })),
      })),
    prs,
    tickets,
  };
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
  const input = await loadReleaseCheckInput(accountId, workspaceId, releasable, settings);
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
    check: foldReleaseCheck(input),
  };
}
