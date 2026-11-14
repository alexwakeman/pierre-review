// THE RELEASE CHECK'S DB HALF (docs/RELEASES.md § The release check) — gathers the stored inputs of
// shared `foldReleaseCheck` and answers GET /api/releases. DB ONLY: never a GitHub or tracker call.
//
//   • Repos: the workspace's members (`resolveWorkspaceScope`), their stored tags and range increments
//     (db/repo-tags.ts), `writable` from the synced `viewerPermission` (the ONE WRITE_PERMISSIONS set).
//   • PRs: every PR in a stored range, plus every PR (in the workspace's repos) on a ticket one of them
//     names — the ships-whole and open-work rules need the ticket's PRs everywhere.
//   • Tickets: `tracker_tickets` rows ON THE WORKSPACE'S TRACKER SITE only (a row of another site is a
//     ticket of a tracker the workspace no longer uses: not a link). The best row per ticket is the
//     newest successful read; a fresher `sprint_tickets` row's status wins. DONE = the This Sprint
//     stage resolver (`sprintStageOf` over `sprintLayoutFor`) says Complete — never a second resolver.
//   • Bot-ness: `globalAutomationUserIds`, never the hidden-bots list.
//   • Accepted repos: `sprint_ticket_repos` (the reader's accepted repos per ticket).
import { and, desc, eq, inArray } from 'drizzle-orm';
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
import { getReleaseSettings } from './release-settings.js';
import { getRepoTags, getTagRanges } from './repo-tags.js';
import { sprintLayoutFor, sprintStageOf } from './sprint-status-layout.js';

const { repos, pullRequests, trackerTickets, sprintTickets, sprintTicketRepos, releases } = schema;

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

/** Every stored input of the fold for one workspace (the caller checked the settings are set). */
export async function loadReleaseCheckInput(
  accountId: number,
  workspaceId: number,
  repoIds: readonly number[],
  settings: ReleaseSettings,
): Promise<ReleaseCheckInput> {
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
  const [tags, ranges] = await Promise.all([getRepoTags(accountId, ids), getTagRanges(accountId, ids)]);

  // The workspace's tracker site (LAZY: db/stories.ts reaches the tracker runtime).
  const { workspaceSite } = await import('./stories.js');
  const site = await workspaceSite(accountId, workspaceId);

  const rangePrIds = [...new Set(ranges.flatMap((r) => r.prIds))];
  const ticketRows: TicketRow[] = [];
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
    // Every PR on those tickets (the ticket's other repos, its open work).
    const keys = [...new Set(ticketRows.map((r) => r.issueKey))];
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

  // The PRs, within the workspace's repos only.
  const prIdSet = [...new Set([...rangePrIds, ...ticketRows.map((r) => r.prId)])];
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
  const idents = [...rowsByIdent.keys()];
  const sprintByIdent = new Map<string, { statusName: string | null; statusCategory: string | null; fetchedAt: Date; title: string; url: string | null }>();
  const accepted: Array<{ ident: string; repoId: number }> = [];
  for (const part of chunks(idents)) {
    const [srows, arows] = await Promise.all([
      db
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
        .execute(),
      db
        .select({ ident: sprintTicketRepos.ident, repoId: sprintTicketRepos.repoId })
        .from(sprintTicketRepos)
        .where(
          and(
            eq(sprintTicketRepos.accountId, accountId),
            eq(sprintTicketRepos.workspaceId, workspaceId),
            inArray(sprintTicketRepos.ident, part),
          ),
        )
        .execute(),
    ]);
    for (const s of srows) sprintByIdent.set(s.ident, s);
    accepted.push(...arows.filter((a) => repoById.has(a.repoId)));
  }
  const layout = idents.length > 0 ? await sprintLayoutFor(accountId, workspaceId) : null;
  const tickets: ReleaseCheckTicketInput[] = idents.map((ident) => {
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
    acceptedRepos: accepted,
  };
}

/** GET /api/releases. `rawWorkspace` absent / unknown / unparseable ⇒ the Default workspace. */
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
  if (!base.configured) return { ...base, latestReleaseTagAt: null, check: null };
  const input = await loadReleaseCheckInput(accountId, workspaceId, scope.repoIds, settings);
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
    ...base,
    latestReleaseTagAt: latestTagMs == null ? null : new Date(latestTagMs).toISOString(),
    check: foldReleaseCheck(input),
  };
}
