import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  defaultAcCandidate,
  type JiraAcCandidate,
  type JiraStatusCategory,
  type JiraTicketDetails,
  type TicketLink,
} from '@pierre-review/shared';
import type { TrackerContext } from './context.js';
import { inChunks } from './context.js';
import type { DetectedFrom } from './types.js';

// THE STORED TICKETS (core `tracker_tickets`, migration 0088 / pg 0075 — the plugin's
// `pro_pr_jira_tickets` until apiVersion 23) — reads, writes and the two derivations every consumer
// shares:
//   • `deriveAc` — which field holds the acceptance criteria (the workspace's choice for the issue
//     type when the ticket has it, else the shared name-match rule `defaultAcCandidate`), ONE rule
//     for the worker, the field-setting route and the re-derivation;
//   • `toDetails` / `toLinkExtras` — a row → the wire.
// Every query predicates on accountId. Schema + rationale: db/schema.sqlite.ts § THE ISSUE TRACKER.

export type TicketState = 'ok' | 'not_found' | 'no_access' | 'failed';
export type { DetectedFrom };

export interface StoredTicketRow {
  id: number;
  accountId: number;
  workspaceId: number;
  prId: number;
  // TrackerProvider — with apiRoot + issueKey, the ticket's identity.
  provider: string;
  issueKey: string;
  detectedFrom: string;
  detectOrder: number;
  apiRoot: string;
  url: string;
  state: string;
  errorCode: string | null;
  title: string | null;
  description: string | null;
  acceptanceCriteria: string | null;
  acFieldId: string | null;
  acFieldName: string | null;
  acFieldSource: string | null;
  issueTypeId: string | null;
  issueTypeName: string | null;
  statusName: string | null;
  statusCategory: string | null;
  assigneeName: string | null;
  assigneeAccountId: string | null;
  assigneeAvatarUrl: string | null;
  candidatesJson: string | null;
  omittedCandidates: number;
  fetchedAt: Date | null;
  checkedAt: Date;
  nextCheckAt: Date;
  // Written ONLY by this module (upsertTicketRow / deleteStaleKeys / rederiveAcForIssueType); see
  // `storyOrMembershipMoved`.
  changedAt: Date | null;
}

// ---- the acceptance-criteria field ----

export interface DerivedAc {
  text: string;
  field: { id: string; name: string } | null;
  source: 'setting' | 'default';
}

/** The criteria for one ticket from its candidates and the workspace's field for its issue type. */
export function deriveAc(candidates: readonly JiraAcCandidate[], settingFieldId: string | null): DerivedAc {
  const id = defaultAcCandidate(candidates, settingFieldId);
  const c = id === '' ? undefined : candidates.find((x) => x.id === id);
  return {
    text: c?.text ?? '',
    field: c != null ? { id: c.id, name: c.name } : null,
    source: settingFieldId != null && c != null && c.id === settingFieldId ? 'setting' : 'default',
  };
}

export function parseCandidates(json: string | null): JiraAcCandidate[] {
  if (json == null) return [];
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (c): c is JiraAcCandidate =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as JiraAcCandidate).id === 'string' &&
        typeof (c as JiraAcCandidate).name === 'string' &&
        typeof (c as JiraAcCandidate).text === 'string',
    );
  } catch {
    return [];
  }
}

// ---- the field settings ----

const settingKey = (workspaceId: number, apiRoot: string, issueTypeId: string): string =>
  `${workspaceId}|${apiRoot}|${issueTypeId}`;

/** Every field choice an account has made for these workspaces, keyed `ws|apiRoot|issueTypeId`. */
export async function readAcFieldSettings(
  ctx: TrackerContext,
  accountId: number,
  workspaceIds: readonly number[],
): Promise<Map<string, { fieldId: string; fieldName: string }>> {
  const out = new Map<string, { fieldId: string; fieldName: string }>();
  if (workspaceIds.length === 0) return out;
  const t = ctx.schema.jiraAcFields;
  const rows = (await ctx.db
    .select({
      workspaceId: t.workspaceId,
      apiRoot: t.apiRoot,
      issueTypeId: t.issueTypeId,
      fieldId: t.fieldId,
      fieldName: t.fieldName,
    })
    .from(t)
    .where(and(eq(t.accountId, accountId), inArray(t.workspaceId, [...new Set(workspaceIds)])))
    .execute()) as Array<{ workspaceId: number; apiRoot: string; issueTypeId: string; fieldId: string; fieldName: string }>;
  for (const r of rows) out.set(settingKey(r.workspaceId, r.apiRoot, r.issueTypeId), r);
  return out;
}

export function settingFor(
  settings: Map<string, { fieldId: string }>,
  workspaceId: number,
  apiRoot: string,
  issueTypeId: string | null | undefined,
): string | null {
  if (issueTypeId == null) return null;
  return settings.get(settingKey(workspaceId, apiRoot, issueTypeId))?.fieldId ?? null;
}

/** Write (or with `field: null`, clear) the choice for one (workspace, site, issue type). */
export async function writeAcFieldSetting(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  apiRoot: string,
  issueTypeId: string,
  field: { id: string; name: string } | null,
  now: Date,
): Promise<void> {
  const t = ctx.schema.jiraAcFields;
  if (field == null) {
    await ctx.db
      .delete(t)
      .where(
        and(
          eq(t.accountId, accountId),
          eq(t.workspaceId, workspaceId),
          eq(t.apiRoot, apiRoot),
          eq(t.issueTypeId, issueTypeId),
        ),
      )
      .execute();
    return;
  }
  await ctx.db
    .insert(t)
    .values({ accountId, workspaceId, apiRoot, issueTypeId, fieldId: field.id, fieldName: field.name, updatedAt: now })
    .onConflictDoUpdate({
      target: [t.accountId, t.workspaceId, t.apiRoot, t.issueTypeId],
      set: { fieldId: field.id, fieldName: field.name, updatedAt: now },
    })
    .execute();
}

// ---- ticket rows ----

/** Every stored row for these PRs (this account only), in detection order per PR. */
export async function readStoredTickets(
  ctx: TrackerContext,
  accountId: number,
  prIds: readonly number[],
): Promise<StoredTicketRow[]> {
  const ids = [...new Set(prIds)];
  if (ids.length === 0) return [];
  const t = ctx.schema.trackerTickets;
  return inChunks(ids, async (chunk) =>
    (await ctx.db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), inArray(t.prId, chunk)))
      .orderBy(asc(t.prId), asc(t.detectOrder))
      .execute()) as StoredTicketRow[],
  );
}

export function groupByPr(rows: readonly StoredTicketRow[]): Map<number, StoredTicketRow[]> {
  const m = new Map<number, StoredTicketRow[]>();
  for (const r of rows) {
    const list = m.get(r.prId) ?? [];
    list.push(r);
    m.set(r.prId, list);
  }
  return m;
}

/** The columns a write sets (everything but the identity triple, id and `changedAt`). */
export type TicketWrite = Omit<StoredTicketRow, 'id' | 'accountId' | 'prId' | 'issueKey' | 'changedAt'>;

type MovedFields = Pick<StoredTicketRow, 'state' | 'provider' | 'apiRoot' | 'title' | 'description' | 'acceptanceCriteria'>;

/**
 * THE ONE RULE FOR `changed_at`: a row's ticket MEMBERSHIP or STORY TEXT moved — it is new, it
 * entered or left state 'ok' (only 'ok' rows are members), it moved site or provider, or its
 * title / description / acceptance criteria changed. Status, assignee, TTL and detection-order
 * churn do not count: core's ticket review would re-run (and bill) for nothing.
 */
export function storyOrMembershipMoved(prior: MovedFields | undefined, next: MovedFields): boolean {
  if (prior == null) return true;
  return (
    (prior.state === 'ok') !== (next.state === 'ok') ||
    prior.apiRoot !== next.apiRoot ||
    prior.provider !== next.provider ||
    (prior.title ?? null) !== (next.title ?? null) ||
    (prior.description ?? null) !== (next.description ?? null) ||
    (prior.acceptanceCriteria ?? null) !== (next.acceptanceCriteria ?? null)
  );
}

export async function upsertTicketRow(
  ctx: TrackerContext,
  accountId: number,
  prId: number,
  issueKey: string,
  values: TicketWrite,
): Promise<void> {
  const t = ctx.schema.trackerTickets;
  // A caller spreading a stored row must not round-trip its `changedAt`: this function owns it.
  const { changedAt: _ignored, ...write } = values as TicketWrite & { changedAt?: unknown };
  const prior = (
    (await ctx.db
      .select({
        state: t.state,
        provider: t.provider,
        apiRoot: t.apiRoot,
        title: t.title,
        description: t.description,
        acceptanceCriteria: t.acceptanceCriteria,
        changedAt: t.changedAt,
      })
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.prId, prId), eq(t.issueKey, issueKey)))
      .limit(1)
      .execute()) as Array<MovedFields & { changedAt: Date | null }>
  )[0];
  const changedAt = storyOrMembershipMoved(prior, write) ? write.checkedAt : (prior?.changedAt ?? null);
  await ctx.db
    .insert(t)
    .values({ accountId, prId, issueKey, ...write, changedAt })
    .onConflictDoUpdate({ target: [t.accountId, t.prId, t.issueKey], set: { ...write, changedAt } })
    .execute();
}

/** Delete one PR's rows whose key is not in `keep` (a key no longer detected). */
export async function deleteStaleKeys(
  ctx: TrackerContext,
  accountId: number,
  prId: number,
  stored: readonly StoredTicketRow[],
  keep: ReadonlySet<string>,
  now: Date = new Date(),
): Promise<number> {
  const goneRows = stored.filter((r) => r.prId === prId && !keep.has(r.issueKey));
  const gone = goneRows.map((r) => r.id);
  if (gone.length === 0) return 0;
  const t = ctx.schema.trackerTickets;
  await ctx.db
    .delete(t)
    .where(and(eq(t.accountId, accountId), eq(t.prId, prId), inArray(t.id, gone)))
    .execute();
  // The PR LEFT those tickets. Its row is gone, so the change is recorded on the rows of the PRs
  // still on each ticket (same site) — `listChangedTicketIdents` then finds the ticket.
  for (const r of goneRows) {
    await ctx.db
      .update(t)
      .set({ changedAt: now })
      .where(
        and(eq(t.accountId, accountId), eq(t.provider, r.provider), eq(t.apiRoot, r.apiRoot), eq(t.issueKey, r.issueKey)),
      )
      .execute();
  }
  return gone.length;
}

/** Mark rows due now (a forced refresh or a field change), this account only. */
export async function markDue(ctx: TrackerContext, accountId: number, rowIds: readonly number[]): Promise<void> {
  if (rowIds.length === 0) return;
  const t = ctx.schema.trackerTickets;
  await inChunks(rowIds, async (chunk) => {
    await ctx.db
      .update(t)
      .set({ nextCheckAt: new Date(0) })
      .where(and(eq(t.accountId, accountId), inArray(t.id, chunk)))
      .execute();
    return [];
  });
}

/**
 * Re-derive the criteria of every stored JIRA ticket of ONE issue type in ONE workspace on ONE site
 * from its stored candidates — no Jira call. Returns the row ids touched.
 */
export async function rederiveAcForIssueType(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  apiRoot: string,
  issueTypeId: string,
  settingFieldId: string | null,
): Promise<number[]> {
  const t = ctx.schema.trackerTickets;
  const rows = (await ctx.db
    .select({
      id: t.id,
      candidatesJson: t.candidatesJson,
      apiRoot: t.apiRoot,
      state: t.state,
      acceptanceCriteria: t.acceptanceCriteria,
    })
    .from(t)
    .where(
      and(
        eq(t.accountId, accountId),
        eq(t.workspaceId, workspaceId),
        eq(t.provider, 'jira'),
        eq(t.issueTypeId, issueTypeId),
      ),
    )
    .execute()) as Array<{
    id: number;
    candidatesJson: string | null;
    apiRoot: string;
    state: string;
    acceptanceCriteria: string | null;
  }>;
  const touched: number[] = [];
  const now = new Date();
  for (const r of rows) {
    if (r.apiRoot !== apiRoot || r.candidatesJson == null) continue;
    const ac = deriveAc(parseCandidates(r.candidatesJson), settingFieldId);
    await ctx.db
      .update(t)
      .set({
        acceptanceCriteria: ac.text,
        acFieldId: ac.field?.id ?? null,
        acFieldName: ac.field?.name ?? null,
        acFieldSource: ac.source,
        // A different criteria field is a story edit to core's ticket review.
        ...((r.acceptanceCriteria ?? null) !== ac.text ? { changedAt: now } : {}),
      })
      .where(and(eq(t.accountId, accountId), eq(t.id, r.id)))
      .execute();
    touched.push(r.id);
  }
  return touched;
}

// ---- the wire ----

const CATEGORIES: readonly string[] = ['new', 'indeterminate', 'done'];
const asCategory = (v: string | null): JiraStatusCategory | null =>
  v != null && CATEGORIES.includes(v) ? (v as JiraStatusCategory) : null;

/** A row has content to show (a successful read happened at some point). */
export const hasContent = (r: StoredTicketRow): boolean => r.fetchedAt != null && r.title != null;

const TITLE_MAX_CHARS = 200;

function clipTitle(title: string | null): string | null {
  const s = title?.replace(/\s+/g, ' ').trim() ?? '';
  if (s === '') return null;
  if (s.length <= TITLE_MAX_CHARS) return s;
  let cut = TITLE_MAX_CHARS;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return `${s.slice(0, cut).trimEnd()}…`;
}

/** The Open PRs ticket row's extras from a stored row (or nothing known). */
export function toLinkExtras(r: StoredTicketRow | undefined): Pick<
  TicketLink,
  'title' | 'status' | 'statusCategory' | 'assignee' | 'issueType'
> {
  if (r == null || !hasContent(r)) {
    return { title: null, status: null, statusCategory: null, assignee: null, issueType: null };
  }
  return {
    title: clipTitle(r.title),
    status: r.statusName,
    statusCategory: asCategory(r.statusCategory),
    assignee:
      r.assigneeName != null ? { name: r.assigneeName, avatarUrl: r.assigneeAvatarUrl ?? null } : null,
    issueType: r.issueTypeName,
  };
}

/** One stored row → the story panel's ticket. Only for a row with content. */
export function toDetails(prId: number, r: StoredTicketRow): JiraTicketDetails {
  return {
    prId,
    key: r.issueKey,
    title: r.title ?? '',
    description: r.description ?? '',
    issueType: r.issueTypeId != null && r.issueTypeName != null ? { id: r.issueTypeId, name: r.issueTypeName } : null,
    candidates: parseCandidates(r.candidatesJson),
    omittedCandidates: r.omittedCandidates,
    acceptanceCriteria: r.acceptanceCriteria ?? '',
    acField: r.acFieldId != null && r.acFieldName != null ? { id: r.acFieldId, name: r.acFieldName } : null,
    acFieldSource: r.acFieldSource === 'setting' ? 'setting' : 'default',
    status: r.statusName,
    statusCategory: asCategory(r.statusCategory),
    assignee: r.assigneeName != null ? { name: r.assigneeName, avatarUrl: r.assigneeAvatarUrl ?? null } : null,
    fetchedAt: r.fetchedAt != null ? new Date(r.fetchedAt).toISOString() : null,
  };
}
