import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  SPRINT_TEXT_MAX,
  STORY_PR_REFS_MAX,
  sprintReplaceBaseText,
  sprintReplaceBaseTruncated,
  sprintReplaceTarget,
  sprintCurrentAssessmentBodyOf,
  sprintIssuesWithClaude,
  type JiraStatusCategory,
  type SprintAssessmentCurrency,
  type SprintPhase,
  type SprintRepoRef,
  type SprintSource,
  type SprintStoriesResponse,
  type SprintTicketRow,
  type StoryPrRef,
  type TrackerProvider,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { getSprintChecks } from './sprint-checks.js';
import { sprintCriteriaOf, sprintIssuesFor, sprintLabelState, type SprintChipInput } from './sprint-chips.js';
import { suggestSprintRepos, suggestTicketOf } from './sprint-repo-suggest.js';
import {
  kickSprintRead,
  latestSprintAssessments,
  resetSprintReadForSite,
  latestTrackerWrites,
  noteSprintViewed,
  sprintAssessFingerprint,
  sprintAssessmentRecordOf,
  sprintReadStateOf,
  sprintTicketTextHash,
  trackerWriteRecordOf,
  type SprintAssessmentRow,
  type SprintReadRow,
  type SprintTicketDbRow,
} from './sprint-store.js';
import { acceptedSprintRepoDetails, type AcceptedRepoDetail } from './sprint-ticket-repos.js';
import { storyLabelInput } from './story-label-input.js';

// REPORTS → THIS SPRINT — THE LIST (`GET /api/sprint-stories`; docs/API.md § This sprint). A
// DB-only fold over what the tracker worker stored (`sprint_tickets`, `sprint_reads`) plus the
// stored story labels, PRs, accepted repos, assessments and write-backs. No tracker, GitHub or model
// call: a view only STAMPS the workspace as viewed (the sprint read's demand gate) and kicks the
// read when it is due.
//
//   • POPULATION: this workspace's `sprint_tickets` with `in_sprint`, on the workspace tracker's
//     CURRENT site (a row from a provider the workspace has since left is not listed). Done tickets
//     are COUNTED (`doneCount`), never listed.
//   • ORDER: Not started, then In progress; within each, most issues first, then key. NEVER by
//     assignee, and no team or person score.
//   • ISSUES: the four story issues (`sprintIssuesFor`). Only a CURRENT label (text hash = today's
//     `storyLabelInput` hash, `STORY_RUBRIC_VERSION`) feeds the label half; `aiEnabled` false →
//     labels 'off' and only what code knows ("no criteria", "more than 8 criteria").
//   • ASSESSMENT CURRENCY is DB-only: today's ticket text hash + the accepted repos' SYNCED
//     default-branch head sha, against the run's stored fingerprint.

const CHUNK = 400;

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const capText = (s: string | null | undefined, max: number): string => {
  const t = s ?? '';
  if (t.length <= max) return t;
  let cut = max;
  const c = t.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return t.slice(0, cut);
};

/** Status category → phase; 'done' → null (counted, not listed); unknown → not started. */
export function sprintPhaseOf(category: string | null): SprintPhase | null {
  if (category === 'done') return null;
  if (category === 'indeterminate') return 'in_progress';
  return 'not_started';
}

/** Pure currency: a SUCCEEDED run is current while today's text hash and today's accepted repos'
 *  synced default-branch shas give its stored fingerprint. A ticket gone from the store is stale. */
export function sprintAssessmentCurrencyFrom(
  row: Pick<SprintAssessmentRow, 'status' | 'fingerprint'>,
  ticket: Pick<SprintTicketDbRow, 'title' | 'description' | 'acceptanceCriteria'> | null,
  accepted: ReadonlyArray<Pick<AcceptedRepoDetail, 'repoId' | 'syncedSha'>>,
): SprintAssessmentCurrency {
  if (row.status !== 'succeeded') return null;
  if (ticket == null) return 'stale';
  const now = sprintAssessFingerprint(
    sprintTicketTextHash(ticket),
    accepted.map((a) => ({ repoId: a.repoId, sha: a.syncedSha })),
  );
  return now === row.fingerprint ? 'current' : 'stale';
}

/** The sort the page lists in. Pure. */
export function sortSprintTickets<T extends Pick<SprintTicketRow, 'phase' | 'flagCount' | 'key'>>(rows: T[]): T[] {
  const phaseRank = (p: SprintPhase): number => (p === 'not_started' ? 0 : 1);
  return [...rows].sort(
    (a, b) =>
      phaseRank(a.phase) - phaseRank(b.phase) ||
      b.flagCount - a.flagCount ||
      a.key.localeCompare(b.key, undefined, { numeric: true }),
  );
}

async function workspaceRepoRefs(accountId: number, workspaceId: number): Promise<SprintRepoRef[]> {
  const { repos: r, workspaceRepos: wr } = schema;
  const rows = await db
    .select({ id: r.id, owner: r.owner, name: r.name })
    .from(r)
    .innerJoin(wr, and(eq(wr.repoId, r.id), eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId)))
    .where(eq(r.accountId, accountId))
    .execute();
  return rows
    .map((x) => ({ repoId: x.id, fullName: `${x.owner}/${x.name}` }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** PRs already on each ticket (stored `tracker_tickets`, any workspace of the account), merged first. */
async function ticketPrRefs(
  accountId: number,
  tickets: ReadonlyArray<Pick<SprintTicketDbRow, 'ident' | 'provider' | 'apiRoot' | 'issueKey'>>,
): Promise<Map<string, StoryPrRef[]>> {
  const out = new Map<string, StoryPrRef[]>();
  if (tickets.length === 0) return out;
  const { trackerTickets: tt, pullRequests: pr, repos: r } = schema;
  const keys = [...new Set(tickets.map((t) => t.issueKey))];
  const rows: Array<{
    provider: string;
    apiRoot: string;
    issueKey: string;
    prId: number;
    number: number;
    title: string;
    state: 'open' | 'merged' | 'closed';
    mergedAt: Date | null;
    openedAt: Date;
    owner: string;
    name: string;
  }> = [];
  for (let i = 0; i < keys.length; i += CHUNK) {
    rows.push(
      ...(await db
        .select({
          provider: tt.provider,
          apiRoot: tt.apiRoot,
          issueKey: tt.issueKey,
          prId: pr.id,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          mergedAt: pr.mergedAt,
          openedAt: pr.openedAt,
          owner: r.owner,
          name: r.name,
        })
        .from(tt)
        .innerJoin(pr, and(eq(pr.id, tt.prId), eq(pr.accountId, accountId)))
        .innerJoin(r, and(eq(r.id, pr.repoId), eq(r.accountId, accountId)))
        .where(and(eq(tt.accountId, accountId), inArray(tt.issueKey, keys.slice(i, i + CHUNK))))
        .execute()),
    );
  }
  const site = (p: string, root: string, key: string): string => `${p}\u0000${root}\u0000${key}`;
  const bySite = new Map<string, typeof rows>();
  for (const row of rows) {
    const k = site(row.provider, row.apiRoot, row.issueKey);
    const arr = bySite.get(k) ?? [];
    if (!arr.some((x) => x.prId === row.prId)) arr.push(row);
    bySite.set(k, arr);
  }
  const rank = (s: string): number => (s === 'merged' ? 0 : s === 'open' ? 1 : 2);
  for (const t of tickets) {
    const members = bySite.get(site(t.provider, t.apiRoot, t.issueKey)) ?? [];
    out.set(
      t.ident,
      [...members]
        .sort(
          (a, b) =>
            rank(a.state) - rank(b.state) ||
            (b.mergedAt?.getTime() ?? 0) - (a.mergedAt?.getTime() ?? 0) ||
            b.openedAt.getTime() - a.openedAt.getTime() ||
            b.prId - a.prId,
        )
        .slice(0, STORY_PR_REFS_MAX)
        .map((m) => ({
          prId: m.prId,
          repoFullName: `${m.owner}/${m.name}`,
          number: m.number,
          title: m.title,
          state: m.state,
          mergedAt: m.state === 'merged' && m.mergedAt != null ? m.mergedAt.toISOString() : null,
          githubUrl: `https://github.com/${m.owner}/${m.name}/pull/${m.number}`,
        })),
    );
  }
  return out;
}

export async function getSprintStories(
  accountId: number,
  workspaceId: number,
  opts: { aiEnabled: boolean; now: number },
): Promise<SprintStoriesResponse> {
  // LAZY: tracker/runtime.ts opens the DB at import (CLAUDE.md), so every tracker-side module is
  // reached inside the function.
  const [{ workspaceSite }, { sprintReadErrorMessage }, { trackerWriteMessage }] = await Promise.all([
    import('./stories.js'),
    import('../tracker/sprint/read.js'),
    import('../tracker/write/messages.js'),
  ]);
  const repos = await workspaceRepoRefs(accountId, workspaceId);
  const site = await workspaceSite(accountId, workspaceId);
  if (site == null) {
    return {
      workspaceId,
      trackerOn: false,
      provider: null,
      source: null,
      read: sprintReadStateOf(null, () => ''),
      tickets: [],
      doneCount: 0,
      aiEnabled: opts.aiEnabled,
      repos,
      checks: { off: [], issueTypes: [] },
      issueTypes: [],
    };
  }
  const provider: TrackerProvider = site.provider;
  const viewed = await noteSprintViewed(accountId, workspaceId, new Date(opts.now));
  // A stored read of ANOTHER tracker or site (the workspace switched since) is not this list: make a
  // read due now and show "Reading…" — never the old read's time over an empty list.
  // (A row stamped with no site yet — never read, or failed before any read — is left alone.)
  const otherSite =
    (viewed.readAt != null || viewed.provider != null) && (viewed.provider !== provider || viewed.apiRoot !== site.apiRoot);
  const readRow: SprintReadRow = otherSite
    ? ((await resetSprintReadForSite(accountId, workspaceId, { provider, apiRoot: site.apiRoot })) ?? viewed)
    : viewed;
  if (readRow.nextReadAt.getTime() <= opts.now) kickSprintRead(accountId, workspaceId);
  const source: SprintSource | null = readRow.sourceJson ?? null;

  const st = schema.sprintTickets;
  const stored = (await db
    .select()
    .from(st)
    .where(
      and(
        eq(st.accountId, accountId),
        eq(st.workspaceId, workspaceId),
        eq(st.inSprint, true),
        eq(st.provider, provider),
        eq(st.apiRoot, site.apiRoot),
      ),
    )
    .execute()) as SprintTicketDbRow[];

  let doneCount = 0;
  const listed: Array<{ row: SprintTicketDbRow; phase: SprintPhase }> = [];
  for (const row of stored) {
    const phase = sprintPhaseOf(row.statusCategory ?? null);
    if (phase == null) doneCount += 1;
    else listed.push({ row, phase });
  }
  const idents = listed.map((l) => l.row.ident);

  const [labels, prRefs, assessments, writes, accepted, checks] = await Promise.all([
    opts.aiEnabled
      ? import('./story-health.js').then((m) => m.currentLabelRowsFor(accountId, idents))
      : Promise.resolve(new Map<string, Map<string, never>>()),
    ticketPrRefs(accountId, listed.map((l) => l.row)),
    latestSprintAssessments(accountId, workspaceId, idents),
    latestTrackerWrites(accountId, workspaceId, idents),
    acceptedSprintRepoDetails(accountId, workspaceId, idents),
    getSprintChecks(accountId, workspaceId),
  ]);
  const suggestions = await suggestSprintRepos(
    accountId,
    workspaceId,
    listed.map((l) => suggestTicketOf(l.row)),
    new Map([...accepted].map(([k, v]) => [k, v.map((a) => a.repoId)])),
    opts.now,
  );

  const rows: SprintTicketRow[] = listed.map(({ row, phase }) => {
    const text = { title: row.title, description: row.description ?? '', acceptanceCriteria: row.acceptanceCriteria ?? '' };
    const input = opts.aiEnabled ? storyLabelInput(text, provider) : null;
    const label = input != null ? (labels.get(row.ident)?.get(input.textHash) ?? null) : null;
    const chipInput: SprintChipInput = {
      provider,
      description: text.description,
      acceptanceCriteria: text.acceptanceCriteria,
      issueType: row.issueTypeName ?? null,
      label,
    };
    const acc = accepted.get(row.ident) ?? [];
    const a = assessments.get(row.ident);
    const assessment = a != null ? { record: sprintAssessmentRecordOf(a), currency: sprintAssessmentCurrencyFrom(a, row, acc) } : null;
    const issues = sprintIssuesWithClaude(
      sprintIssuesFor(chipInput, checks),
      sprintCurrentAssessmentBodyOf({ assessment }),
      checks,
      row.issueTypeName ?? null,
      sprintCriteriaOf(text, provider).items.length,
    );
    const w = writes.get(row.ident);
    const acField = row.acFieldId != null && row.acFieldName != null ? { id: row.acFieldId, name: row.acFieldName } : null;
    const replaceTarget = sprintReplaceTarget(provider, acField);
    const baseText = sprintReplaceBaseText(row, replaceTarget);
    return {
      ident: row.ident,
      key: row.issueKey,
      title: capText(row.title, SPRINT_TEXT_MAX.title),
      url: row.url ?? null,
      provider,
      phase,
      status: row.statusName != null ? { name: row.statusName, category: (row.statusCategory as JiraStatusCategory | null) ?? null } : null,
      issueType: row.issueTypeName ?? null,
      assignee: row.assigneeName != null ? { name: row.assigneeName, avatarUrl: row.assigneeAvatarUrl ?? null } : null,
      epic: row.epicKey != null ? { key: row.epicKey, title: row.epicTitle ?? null } : null,
      description: capText(row.description, SPRINT_TEXT_MAX.description),
      acceptanceCriteria: capText(row.acceptanceCriteria, SPRINT_TEXT_MAX.criteria),
      acField,
      criteria: sprintCriteriaOf(text, provider),
      labels: sprintLabelState(chipInput, opts.aiEnabled),
      issues,
      flagCount: issues.length,
      pullRequests: prRefs.get(row.ident) ?? [],
      repos: {
        accepted: acc.map((d) => ({ repoId: d.repoId, fullName: d.fullName })),
        suggested: suggestions.get(row.ident) ?? [],
      },
      assessment,
      replaceTarget,
      replaceBase: { hash: sha256(baseText), truncated: sprintReplaceBaseTruncated(baseText, replaceTarget) },
      lastWrite: w != null ? trackerWriteRecordOf(w, trackerWriteMessage) : null,
    };
  });

  return {
    workspaceId,
    trackerOn: true,
    provider,
    source,
    read: sprintReadStateOf(readRow, (code) => sprintReadErrorMessage(provider, code)),
    tickets: sortSprintTickets(rows),
    doneCount,
    aiEnabled: opts.aiEnabled,
    repos,
    checks,
    issueTypes: [...new Set(stored.map((r) => r.issueTypeName?.trim() ?? '').filter((n) => n !== ''))].sort((a, b) =>
      a.localeCompare(b),
    ),
  };
}
