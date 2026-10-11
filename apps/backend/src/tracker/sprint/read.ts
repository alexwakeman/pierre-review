import { and, asc, eq, gte, inArray, lt, lte, notInArray } from 'drizzle-orm';
import {
  SPRINT_FALLBACK_DAYS,
  SPRINT_READ_INTERVAL_MS,
  SPRINT_VIEW_TTL_DAYS,
  trackerTicketIdent,
  type TrackerProvider,
} from '@pierre-review/shared';
import { githubAccessFor, type TrackerContext } from '../context.js';
import { MSG_NO_READING_TRACKER, prepareTrackerCall } from '../calls.js';
import { JiraFetchError, type JiraFetchErrorCode, type JiraTransport } from '../jira/fetch.js';
import { maybeAdapterFor } from '../registry.js';
import { githubIssuesRepos, readWorkspaceTrackerRow, trackerAccessOf } from '../settings.js';
import { deriveAc, linkColumns, readAcFieldSettings, settingFor } from '../store.js';
import type { FetchedTicket, TrackerCall } from '../types.js';
import { accessFingerprint, backoffCode } from '../worker.js';
import { afterSprintRead } from './hooks.js';
import { listGithubMilestone } from './github.js';
import { listJiraSprint } from './jira.js';
import { listLinearCycle } from './linear.js';
import { sprintProjectKeys, workspaceRepoNames } from './project-keys.js';
import type { SprintFetchedTicket, SprintLister } from './types.js';

// ── THE SPRINT LIST READ (Reports → This sprint; docs/TRACKERS.md § The sprint list read) ────────
//
// ⚠ THE RULE CHANGE. Until this, a tracker was read ONLY when a pull request was RECEIVED (the
// ticket worker, ../worker.ts) or a person pressed Refresh on one. This is the FIRST tracker read
// that is not triggered by a received PR: a sprint's tickets mostly have NO pull request yet — that
// is the point of looking at them before the work starts. It is deliberately DEMAND-GATED:
//
//   • a workspace is read only while its This sprint tab was opened in the last
//     `SPRINT_VIEW_TTL_DAYS` (`sprint_reads.viewed_at`, stamped by the GET — the GET itself never
//     calls a tracker, it only stamps and kicks);
//   • at most every `SPRINT_READ_INTERVAL_MS` (`next_read_at`; a Refresh sets it due);
//   • only for a workspace whose tracker READS and whose call prepares (`prepareTrackerCall` over the
//     EFFECTIVE tracker row — the ticket worker's population, the automatic GitHub default included);
//   • never for a workspace the ticket worker has backed off (a refused token, a rate limit);
//   • at most `TICK_WORKSPACES` workspaces per tick, one read per workspace in flight.
//
// What is stored: `sprint_tickets` (one row per ticket, WITH OR WITHOUT a PR; `in_sprint` false
// once a later read stops returning it; pruned after 90 days unseen) and the workspace's
// `sprint_reads` row (where the list came from, when, and the last failure's CODE — the sentence is
// `sprintReadErrorMessage`'s). A failed read keeps the last good list. Logs carry account,
// workspace and a code only — never a token or anything a tracker sent back.

export const SPRINT_LISTERS: Record<TrackerProvider, SprintLister> = {
  jira: listJiraSprint,
  linear: listLinearCycle,
  github: listGithubMilestone,
};

/** Workspaces read per tick at most. */
export const TICK_WORKSPACES = 5;
/** Forced single-ticket re-reads per account per tick at most. */
export const FORCED_REREADS_PER_TICK = 10;
/** A ticket unseen this long is deleted. */
export const SPRINT_PRUNE_MS = 90 * 86_400_000;
/** A rate-limited read is retried this soon. */
export const SPRINT_RATE_LIMIT_RETRY_MS = 5 * 60_000;

const DAY_MS = 86_400_000;
const EPOCH = new Date(0);

export interface SprintReadOptions {
  now?: () => number;
  transport?: JiraTransport;
  /** Test seam: the provider listers. */
  listers?: Partial<Record<TrackerProvider, SprintLister>>;
}

export interface SprintTickOptions extends SprintReadOptions {
  /** Whether the account may have Reports (`periodReports`). Default: the account's entitlement. */
  entitled?: (accountId: number) => Promise<boolean>;
}

// ---- one workspace in flight ----

const inFlight = new Map<string, Promise<{ ok: boolean; stored: number; code: string | null }>>();
const flightKey = (a: number, w: number): string => `${a}|${w}`;

/** Test seam. */
export function resetSprintRead(): void {
  inFlight.clear();
}

/** Run one read for a workspace, joining one already in flight. */
export function readWorkspaceSprintOnce(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  opts: SprintReadOptions = {},
): Promise<{ ok: boolean; stored: number; code: string | null }> {
  const k = flightKey(accountId, workspaceId);
  const existing = inFlight.get(k);
  if (existing != null) return existing;
  const p = readWorkspaceSprint(ctx, accountId, workspaceId, opts).finally(() => inFlight.delete(k));
  inFlight.set(k, p);
  return p;
}

// ---- the read ----

function codeOf(err: unknown): string {
  if (err instanceof JiraFetchError) return err.code === 'http' && err.status === 429 ? 'rate_limited' : err.code;
  return 'unknown';
}

async function fallbackWindow(accountId: number, workspaceId: number, nowMs: number): Promise<{ fromMs: number; toMs: number }> {
  try {
    // LAZY: the reporting window pulls in core db modules this tracker module must not open at import.
    const { getReportingWindow } = await import('../../db/reporting-window.js');
    const w = await getReportingWindow(accountId, workspaceId, nowMs);
    return { fromMs: w.fromMs, toMs: Math.min(w.toMs, nowMs) };
  } catch {
    return { fromMs: nowMs - SPRINT_FALLBACK_DAYS * DAY_MS, toMs: nowMs };
  }
}

async function recordFailure(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  code: string,
  nowMs: number,
): Promise<void> {
  const t = ctx.schema.sprintReads;
  await ctx.db
    .update(t)
    .set({
      checkedAt: new Date(nowMs),
      errorCode: code,
      nextReadAt: new Date(nowMs + (code === 'rate_limited' ? SPRINT_RATE_LIMIT_RETRY_MS : SPRINT_READ_INTERVAL_MS)),
    })
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .execute();
}

/** The stored columns of a fetched ticket's TEXT (shared by the list read and the forced re-read). */
function textColumns(t: FetchedTicket, acSetting: string | null) {
  const ac = deriveAc(t.candidates, acSetting);
  return {
    title: t.title.slice(0, 1000),
    description: t.description,
    acceptanceCriteria: ac.text,
    acFieldId: ac.field?.id ?? null,
    acFieldName: ac.field?.name ?? null,
    candidatesJson: JSON.stringify(t.candidates),
    omittedCandidates: t.omittedCandidates,
    issueTypeId: t.issueType?.id ?? null,
    issueTypeName: t.issueType?.name ?? null,
    statusName: t.status?.name ?? null,
    statusCategory: t.status?.category ?? null,
    assigneeName: t.assignee?.name ?? null,
    assigneeAvatarUrl: t.assignee?.avatarUrl ?? null,
    // The blocking links + status id, observed keys only (an absent key keeps the stored value).
    ...linkColumns(t),
  };
}

function browseUrl(call: TrackerCall, baseUrl: string | null, t: FetchedTicket): string | null {
  if (t.url != null) return t.url;
  const adapter = maybeAdapterFor(call.provider);
  if (adapter == null) return null;
  try {
    return adapter.browseUrl(adapter.fixedBaseUrl ?? baseUrl ?? call.apiRoot, t.key);
  } catch {
    return null;
  }
}

/** Read + store ONE workspace's sprint list. Never throws; records `error_code` on failure. */
export async function readWorkspaceSprint(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  opts: SprintReadOptions = {},
): Promise<{ ok: boolean; stored: number; code: string | null }> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  try {
    const row = await readWorkspaceTrackerRow(ctx, accountId, workspaceId);
    const access = trackerAccessOf(ctx.host, row);
    const provider = access.issue.provider;
    if (provider == null || maybeAdapterFor(provider)?.reader == null) {
      await recordFailure(ctx, accountId, workspaceId, 'no_tracker', t0);
      return { ok: false, stored: 0, code: 'no_tracker' };
    }
    const prepared = prepareTrackerCall(access, {
      cloud: ctx.host.isCloud,
      transport: opts.transport,
      github: githubAccessFor(ctx, accountId),
    });
    if (!prepared.ok) {
      await recordFailure(ctx, accountId, workspaceId, prepared.error, t0);
      return { ok: false, stored: 0, code: prepared.error };
    }
    const call = prepared.call;
    // A workspace the ticket worker has backed off (refused token, rate limit) is not read either.
    // It is RECORDED like any failure — the worker's own code — so the page names the reason instead
    // of "Reading…" for ever, and `next_read_at` moves on (a still-due row would hold a tick slot).
    // (The worker backs off on a stored 'http' code only for a 429.)
    const backoffRaw = backoffCode(accountId, workspaceId, accessFingerprint(call), t0);
    const backedOff = backoffRaw === 'http' ? 'rate_limited' : backoffRaw;
    if (backedOff != null) {
      await recordFailure(ctx, accountId, workspaceId, backedOff, t0);
      return { ok: false, stored: 0, code: backedOff };
    }
    const projectKeys = await sprintProjectKeys(ctx, accountId, workspaceId, provider, call.apiRoot);
    let repos: string[] = [];
    if (provider === 'github') {
      // Repos that use GitHub Issues first, so the per-pass repo cap keeps the ones with issues.
      const withIssues = await githubIssuesRepos(ctx, accountId, workspaceId);
      repos = [...new Set([...withIssues, ...(await workspaceRepoNames(ctx, accountId, workspaceId))])];
    }
    if (provider === 'github' ? repos.length === 0 : projectKeys.length === 0) {
      const code = provider === 'github' ? 'no_repos' : 'no_projects';
      await recordFailure(ctx, accountId, workspaceId, code, t0);
      return { ok: false, stored: 0, code };
    }
    const acSettings = await readAcFieldSettings(ctx, accountId, [workspaceId]);
    const acSettingFor = (issueTypeId: string | null): string | null => settingFor(acSettings, workspaceId, call.apiRoot, issueTypeId);
    const lister = opts.listers?.[provider] ?? SPRINT_LISTERS[provider];
    let result;
    try {
      result = await lister({
        call,
        projectKeys,
        repos,
        fallbackWindow: await fallbackWindow(accountId, workspaceId, t0),
        acSettingFor,
      });
    } catch (err) {
      const code = codeOf(err);
      ctx.log.warn({ accountId, workspaceId, code, route: 'tracker-sprint' }, 'sprint read failed (non-fatal)');
      await recordFailure(ctx, accountId, workspaceId, code, now());
      return { ok: false, stored: 0, code };
    }
    const stored = await storeSprintList(ctx, accountId, workspaceId, call, row?.baseUrl ?? null, result.tickets, acSettingFor, now());
    if (result.statusOrderError != null) {
      ctx.log.warn(
        { accountId, workspaceId, code: result.statusOrderError, route: 'tracker-sprint' },
        'sprint status order read failed (non-fatal)',
      );
    }
    const t = ctx.schema.sprintReads;
    const done = now();
    await ctx.db
      .update(t)
      .set({
        provider,
        apiRoot: call.apiRoot,
        sourceJson: result.source,
        readAt: new Date(done),
        checkedAt: new Date(done),
        errorCode: null,
        truncated: result.truncated,
        nextReadAt: new Date(done + SPRINT_READ_INTERVAL_MS),
        // The automatic status order: undefined = not read this time (a failed order read) → kept.
        ...(result.statusOrder !== undefined ? { statusOrderJson: result.statusOrder } : {}),
      })
      .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
      .execute();
    afterSprintRead(accountId, workspaceId);
    return { ok: true, stored, code: null };
  } catch (err) {
    const code = codeOf(err);
    ctx.log.warn({ accountId, workspaceId, code, route: 'tracker-sprint' }, 'sprint read failed (non-fatal)');
    try {
      await recordFailure(ctx, accountId, workspaceId, code, now());
    } catch {
      /* the next tick tries again */
    }
    return { ok: false, stored: 0, code };
  }
}

/** Upsert the returned tickets, flip the rest out of the sprint, prune the long-unseen. */
async function storeSprintList(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  call: TrackerCall,
  baseUrl: string | null,
  tickets: readonly SprintFetchedTicket[],
  acSettingFor: (issueTypeId: string | null) => string | null,
  nowMs: number,
): Promise<number> {
  const st = ctx.schema.sprintTickets;
  const at = new Date(nowMs);
  const seen = new Set<string>();
  for (const tk of tickets) {
    const ident = trackerTicketIdent(call.provider, call.apiRoot, tk.key);
    if (seen.has(ident)) continue;
    seen.add(ident);
    const values = {
      ...textColumns(tk, acSettingFor(tk.issueType?.id ?? null)),
      url: browseUrl(call, baseUrl, tk),
      provider: call.provider,
      apiRoot: call.apiRoot,
      issueKey: tk.key,
      projectKey: tk.projectKey,
      epicKey: tk.epic?.key ?? null,
      epicTitle: tk.epic?.title ?? null,
      componentsJson: tk.components != null ? JSON.stringify(tk.components) : null,
      sprintName: tk.sprintName,
      inSprint: true,
      lastSeenAt: at,
      fetchedAt: at,
      nextCheckAt: new Date(nowMs + SPRINT_READ_INTERVAL_MS),
      issueUpdatedAt: tk.issueUpdatedAt,
    };
    await ctx.db
      .insert(st)
      .values({ accountId, workspaceId, ident, firstSeenAt: at, ...values })
      // ⚠ firstSeenAt is insert-only.
      .onConflictDoUpdate({ target: [st.accountId, st.workspaceId, st.ident], set: values })
      .execute();
  }
  const idents = [...seen];
  await ctx.db
    .update(st)
    .set({ inSprint: false })
    .where(
      and(
        eq(st.accountId, accountId),
        eq(st.workspaceId, workspaceId),
        eq(st.inSprint, true),
        ...(idents.length > 0 ? [notInArray(st.ident, idents)] : []),
      ),
    )
    .execute();
  const pruned: Array<{ ident: string }> = await ctx.db
    .delete(st)
    .where(and(eq(st.accountId, accountId), eq(st.workspaceId, workspaceId), lt(st.lastSeenAt, new Date(nowMs - SPRINT_PRUNE_MS))))
    .returning({ ident: st.ident })
    .execute();
  // A pruned ticket's accepted repos go with it (keyed by ident, not by a foreign key), so a ticket
  // that comes back months later starts with the code's suggestions, not a stale choice.
  if (pruned.length > 0) {
    const str = ctx.schema.sprintTicketRepos;
    await ctx.db
      .delete(str)
      .where(
        and(
          eq(str.accountId, accountId),
          eq(str.workspaceId, workspaceId),
          inArray(
            str.ident,
            pruned.map((r) => r.ident),
          ),
        ),
      )
      .execute();
  }
  return idents.length;
}

// ---- one ticket, read live now (the write-back's pre-write check) ----

/**
 * Read ONE stored sprint ticket from the tracker now and store its text. Returns the stored text
 * columns. THROWS when the tracker cannot be read — the caller (the "Replace" write-back) must not
 * write over text it could not check. `fetch` is a test seam for `reader.fetchTicket`.
 */
export async function rereadSprintTicketNow(
  ctx: TrackerContext,
  a: {
    accountId: number;
    workspaceId: number;
    rowId: number;
    issueKey: string;
    call: TrackerCall;
    fetch?: (call: TrackerCall, key: string) => Promise<FetchedTicket>;
    now?: () => number;
  },
): Promise<{ description: string; acceptanceCriteria: string; acFieldId: string | null; acFieldName: string | null }> {
  const now = a.now ?? Date.now;
  const fetch =
    a.fetch ??
    ((call: TrackerCall, key: string) => {
      const reader = maybeAdapterFor(call.provider)?.reader;
      if (reader == null) throw new JiraFetchError('not_found');
      return reader.fetchTicket(call, key);
    });
  const t = await fetch(a.call, a.issueKey);
  const acSettings = await readAcFieldSettings(ctx, a.accountId, [a.workspaceId]);
  const cols = textColumns(t, settingFor(acSettings, a.workspaceId, a.call.apiRoot, t.issueType?.id ?? null));
  const st = ctx.schema.sprintTickets;
  await ctx.db
    .update(st)
    .set({ ...cols, fetchedAt: new Date(now()) })
    .where(and(eq(st.id, a.rowId), eq(st.accountId, a.accountId), eq(st.workspaceId, a.workspaceId)))
    .execute();
  afterSprintRead(a.accountId, a.workspaceId);
  return {
    description: cols.description,
    acceptanceCriteria: cols.acceptanceCriteria,
    acFieldId: cols.acFieldId,
    acFieldName: cols.acFieldName,
  };
}

// ---- the forced single-ticket re-read (after a write-back) ----

/** Re-read singly every sprint_tickets row with `next_check_at` = epoch 0. Bounded; never throws. */
export async function rereadForcedSprintTickets(
  ctx: TrackerContext,
  accountId: number,
  opts: SprintReadOptions & { limit?: number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now;
  const st = ctx.schema.sprintTickets;
  const rows = (await ctx.db
    .select({
      id: st.id,
      workspaceId: st.workspaceId,
      provider: st.provider,
      apiRoot: st.apiRoot,
      issueKey: st.issueKey,
    })
    .from(st)
    .where(and(eq(st.accountId, accountId), lte(st.nextCheckAt, EPOCH)))
    .orderBy(asc(st.id))
    .limit(opts.limit ?? FORCED_REREADS_PER_TICK)
    .execute()) as Array<{ id: number; workspaceId: number; provider: string; apiRoot: string; issueKey: string }>;
  let read = 0;
  const reread = new Set<number>();
  const calls = new Map<number, { call: TrackerCall; acSettings: Awaited<ReturnType<typeof readAcFieldSettings>> } | null>();
  for (const r of rows) {
    const later = new Date(now() + SPRINT_READ_INTERVAL_MS);
    try {
      if (!calls.has(r.workspaceId)) {
        const access = trackerAccessOf(ctx.host, await readWorkspaceTrackerRow(ctx, accountId, r.workspaceId));
        const prepared = prepareTrackerCall(access, {
          cloud: ctx.host.isCloud,
          transport: opts.transport,
          github: githubAccessFor(ctx, accountId),
        });
        calls.set(
          r.workspaceId,
          prepared.ok ? { call: prepared.call, acSettings: await readAcFieldSettings(ctx, accountId, [r.workspaceId]) } : null,
        );
      }
      const wc = calls.get(r.workspaceId) ?? null;
      const reader = wc != null ? maybeAdapterFor(wc.call.provider)?.reader : undefined;
      // The workspace moved to another tracker or site: this row is not re-readable; the list read
      // will flip it out of the sprint.
      if (wc == null || reader == null || wc.call.provider !== r.provider || wc.call.apiRoot !== r.apiRoot) {
        await ctx.db.update(st).set({ nextCheckAt: later }).where(and(eq(st.id, r.id), eq(st.accountId, accountId))).execute();
        continue;
      }
      const t = await reader.fetchTicket(wc.call, r.issueKey);
      const at = new Date(now());
      await ctx.db
        .update(st)
        .set({
          ...textColumns(t, settingFor(wc.acSettings, r.workspaceId, wc.call.apiRoot, t.issueType?.id ?? null)),
          fetchedAt: at,
          nextCheckAt: later,
        })
        .where(and(eq(st.id, r.id), eq(st.accountId, accountId)))
        .execute();
      read += 1;
      reread.add(r.workspaceId);
    } catch (err) {
      // ⚠ Never loop on a failing ticket: it waits for the next list read like every other row.
      ctx.log.warn({ accountId, workspaceId: r.workspaceId, code: codeOf(err), route: 'tracker-sprint' }, 'sprint ticket re-read failed (non-fatal)');
      try {
        await ctx.db.update(st).set({ nextCheckAt: later }).where(and(eq(st.id, r.id), eq(st.accountId, accountId))).execute();
      } catch {
        /* next tick */
      }
    }
  }
  // The new text has no current label yet: start the (free) label run for it now, not at the next
  // list read. It skips tickets already labelled and an account whose run is busy.
  for (const workspaceId of reread) afterSprintRead(accountId, workspaceId);
  return read;
}

// ---- the tick ----

async function defaultEntitled(accountId: number): Promise<boolean> {
  const [{ getAccountById }, { entitledProCapabilities }] = await Promise.all([
    import('../../auth/account.js'),
    import('../../pro/contract.js'),
  ]);
  const account = await getAccountById(accountId);
  return account != null && entitledProCapabilities(account).periodReports === true;
}

/** The tick body: viewed-recently AND due workspaces (≤ TICK_WORKSPACES), then forced re-reads. Never throws. */
export async function runSprintReadTick(ctx: TrackerContext, opts: SprintTickOptions = {}): Promise<void> {
  const now = opts.now ?? Date.now;
  const entitled = opts.entitled ?? defaultEntitled;
  const cache = new Map<number, boolean>();
  const isEntitled = async (accountId: number): Promise<boolean> => {
    if (!cache.has(accountId)) cache.set(accountId, await entitled(accountId).catch(() => false));
    return cache.get(accountId) === true;
  };
  // A narrow test context (the ticket worker's own tests) carries no sprint tables: nothing to read.
  if (ctx.schema.sprintReads == null || ctx.schema.sprintTickets == null) return;
  try {
    const t0 = now();
    const sr = ctx.schema.sprintReads;
    const due = (await ctx.db
      .select({ accountId: sr.accountId, workspaceId: sr.workspaceId })
      .from(sr)
      .where(and(gte(sr.viewedAt, new Date(t0 - SPRINT_VIEW_TTL_DAYS * DAY_MS)), lte(sr.nextReadAt, new Date(t0))))
      .orderBy(asc(sr.nextReadAt), asc(sr.id))
      .limit(TICK_WORKSPACES * 4)
      .execute()) as Array<{ accountId: number; workspaceId: number }>;
    let left = TICK_WORKSPACES;
    for (const w of due) {
      if (left <= 0) break;
      if (inFlight.has(flightKey(w.accountId, w.workspaceId))) continue;
      if (!(await isEntitled(w.accountId))) continue;
      left -= 1;
      await readWorkspaceSprintOnce(ctx, w.accountId, w.workspaceId, opts);
    }
    const st = ctx.schema.sprintTickets;
    const forced = (await ctx.db
      .selectDistinct({ accountId: st.accountId })
      .from(st)
      .where(lte(st.nextCheckAt, EPOCH))
      .execute()) as Array<{ accountId: number }>;
    for (const f of forced) {
      if (!(await isEntitled(f.accountId))) continue;
      await rereadForcedSprintTickets(ctx, f.accountId, opts);
    }
  } catch (err) {
    ctx.log.warn({ code: codeOf(err), route: 'tracker-sprint' }, 'sprint tick failed (non-fatal)');
  }
}

/** Is this workspace due a read now (viewed recently, `next_read_at` passed)? */
export async function isSprintReadDue(ctx: TrackerContext, accountId: number, workspaceId: number, nowMs: number): Promise<boolean> {
  const sr = ctx.schema.sprintReads;
  const rows = (await ctx.db
    .select({ id: sr.id })
    .from(sr)
    .where(
      and(
        eq(sr.accountId, accountId),
        eq(sr.workspaceId, workspaceId),
        gte(sr.viewedAt, new Date(nowMs - SPRINT_VIEW_TTL_DAYS * DAY_MS)),
        lte(sr.nextReadAt, new Date(nowMs)),
      ),
    )
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

// ---- the sentence ----

const PREPARE_MESSAGES: Record<string, (label: string, provider: TrackerProvider | null) => string> = {
  NotJira: () => MSG_NO_READING_TRACKER,
  no_tracker: () => MSG_NO_READING_TRACKER,
  NoGithubAccess: () => 'Limn cannot reach GitHub as this account here.',
  NoJiraUrl: (label, p) =>
    p === 'linear'
      ? 'The Linear workspace URL in Settings is not a linear.app address, like https://linear.app/your-workspace.'
      : `The ${label} base URL in Settings is not a valid web address.`,
  NoJiraToken: (label, p) => `No ${p === 'linear' ? 'Linear API key' : `${label} token`} is saved for this workspace. Add one in Settings.`,
  JiraTokenUnreadable: (label, p) =>
    `The saved ${p === 'linear' ? 'Linear API key' : `${label} token`} cannot be read on this server. Save it again in Settings.`,
};

/** Plain-English sentence for a stored `error_code`, naming the provider. Never anything a tracker sent. */
export function sprintReadErrorMessage(provider: TrackerProvider | null, code: string): string {
  const adapter = maybeAdapterFor(provider);
  const label = adapter?.label ?? 'the tracker';
  const prep = PREPARE_MESSAGES[code];
  if (prep != null) return prep(label, provider);
  switch (code) {
    case 'no_projects':
      return `No ${label} tickets have been seen on this workspace's pull requests yet, so Limn does not know which projects to read.`;
    case 'no_repos':
      return 'This workspace has no repositories, so Limn has no milestones to read.';
    case 'rate_limited':
      return `${label}'s rate limit is used up for now. Limn will read the sprint again in a few minutes.`;
    case 'not_found':
      return provider === 'github'
        ? 'GitHub could not find these repositories, or your GitHub account cannot see them.'
        : `${label} could not find these projects, or the saved ${provider === 'linear' ? 'key' : 'token'} cannot see them.`;
    case 'no_access':
      return `The saved ${provider === 'linear' ? 'Linear key' : `${label} token`} does not have access to these projects.`;
    case 'unknown':
      return `Could not read the sprint from ${label}.`;
    default: {
      const reader = adapter?.reader;
      if (reader == null) return `Could not read the sprint from ${label}.`;
      return reader.errorMessage(new JiraFetchError(code as JiraFetchErrorCode));
    }
  }
}

