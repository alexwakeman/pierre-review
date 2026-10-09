import { and, eq, isNull } from 'drizzle-orm';
import {
  TRACKER_PROVIDERS_AVAILABLE,
  linearSiteRoot,
  type IssueMatchScope,
  type TrackerProvider,
  type WorkspaceIssueSettings,
  type WorkspaceTrackerSettings,
  type WorkspaceTrackerUpdate,
} from '@pierre-review/shared';
import type { TrackerContext } from './context.js';
import { parseProjectKeys } from './detect.js';
import { maybeAdapterFor } from './registry.js';
import { openTrackerToken, storeTrackerToken, type HostSeal, type OpenedToken } from './secret.js';

// THE WORKSPACE'S ISSUE TRACKER — one row per (account, workspace) in core `workspace_trackers`
// (migration 0088 / pg 0075). It was half of the plugin's `pro_workspace_settings` row (plugin
// 0031 + 0035) until apiVersion 23; ./legacy-import.ts MOVED the values here once, token included,
// in its stored form.
//
// ⚠ NO CHAIN. A stored choice (a provider, or a chosen "None"), else the AUTOMATIC default below —
// derived from this workspace's OWN repos, never an account-level value (the plugin retired that in
// 0031). A repo with no workspace membership has no tracker — ABSENT, NEVER ANOTHER WORKSPACE'S
// (./enricher.ts).

/** The raw row (sqlite returns Date for timestamps). ⚠ `authToken` is the STORED form. */
export interface WorkspaceTrackerRow {
  provider: string | null;
  baseUrl: string | null;
  projectKeys: string | null;
  matchScope: string | null;
  authEmail: string | null;
  authToken: string | null;
}

/** ⚠ NULL reads as `'title_branch'` — the behaviour before the setting existed. */
export const DEFAULT_MATCH_SCOPE: IssueMatchScope = 'title_branch';
const VALID_MATCH_SCOPE: readonly IssueMatchScope[] = ['title', 'title_branch'];

/** The STORED `workspace_trackers` row for one workspace, or null. ⚠ Only the writer and the
 *  automatic-default fold read this directly; every other reader goes through
 *  `readWorkspaceTrackerRow`, which applies the default. */
export async function readStoredTrackerRow(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
): Promise<WorkspaceTrackerRow | null> {
  const t = ctx.schema.workspaceTrackers;
  const rows = (await ctx.db
    .select({
      provider: t.provider,
      baseUrl: t.baseUrl,
      projectKeys: t.projectKeys,
      matchScope: t.matchScope,
      authEmail: t.authEmail,
      authToken: t.authToken,
    })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .limit(1)
    .execute()) as WorkspaceTrackerRow[];
  return rows[0] ?? null;
}

// ── THE AUTOMATIC DEFAULT (migration 0094; docs/TRACKERS.md § Automatic default) ──────────────
// A workspace with NO stored choice (no row, or a row whose provider is NULL) uses GitHub Issues
// when at least one of its repos uses it (`repos.uses_github_issues`, ./github/issues-usage.ts), else
// no tracker. A stored choice always wins, "None" included — stored as `NONE_PROVIDER`, because NULL
// means "no choice".
//
// ⚠ THIS IS THE ONE PLACE THE DEFAULT IS APPLIED. `readWorkspaceTrackerRow` returns the EFFECTIVE
// row, so the enricher, the worker, the ticket routes, the merged panel, the GitHub closing-issues
// step and the Settings screen (`useTrackerOn`) all read the same provider. The worker's population
// (`readingWorkspaces`) is a set query and repeats the rule through `autoDetectedWorkspaces` below.

/** The stored spelling of an explicit "None". Not a provider: `maybeAdapterFor('none')` is null. */
export const NONE_PROVIDER = 'none';

/** Whether a stored row leaves the provider to the automatic default. */
export function isProviderUnchosen(row: Pick<WorkspaceTrackerRow, 'provider'> | null): boolean {
  return row == null || row.provider == null;
}

/** The workspace's repos that use GitHub Issues (`owner/name`, sorted). [] when the context carries
 *  no `repos` table (a narrow test context). */
export async function githubIssuesRepos(ctx: TrackerContext, accountId: number, workspaceId: number): Promise<string[]> {
  const r = ctx.schema.repos;
  const wr = ctx.schema.workspaceRepos;
  // A narrow test context may carry no `repos` table, or one without the 0094 columns.
  if (r?.usesGithubIssues == null || wr == null) return [];
  const rows = (await ctx.db
    .select({ owner: r.owner, name: r.name })
    .from(wr)
    .innerJoin(r, and(eq(r.id, wr.repoId), eq(r.accountId, wr.accountId)))
    .where(and(eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId), eq(r.usesGithubIssues, true)))
    .execute()) as Array<{ owner: string; name: string }>;
  return rows.map((x) => `${x.owner}/${x.name}`).sort();
}

/** A stored row (or none) → the EFFECTIVE row: the automatic default applied when nothing is chosen. */
export function effectiveTrackerRow(stored: WorkspaceTrackerRow | null, detectedRepos: readonly string[]): WorkspaceTrackerRow | null {
  if (!isProviderUnchosen(stored) || detectedRepos.length === 0) return stored;
  return {
    provider: 'github',
    baseUrl: stored?.baseUrl ?? null,
    projectKeys: stored?.projectKeys ?? null,
    matchScope: stored?.matchScope ?? null,
    authEmail: stored?.authEmail ?? null,
    authToken: stored?.authToken ?? null,
  };
}

/** Workspaces (of one account, or of all) with no stored choice and a repo that uses GitHub Issues —
 *  the worker's auto-detected population. */
export async function autoDetectedWorkspaces(
  ctx: TrackerContext,
  accountId: number | null,
): Promise<Array<{ accountId: number; workspaceId: number }>> {
  const r = ctx.schema.repos;
  const wr = ctx.schema.workspaceRepos;
  const t = ctx.schema.workspaceTrackers;
  // A narrow test context may carry no `repos` table, or one without the 0094 columns.
  if (r?.usesGithubIssues == null || wr == null) return [];
  const rows = (await ctx.db
    .selectDistinct({ accountId: wr.accountId, workspaceId: wr.workspaceId })
    .from(wr)
    .innerJoin(r, and(eq(r.id, wr.repoId), eq(r.accountId, wr.accountId)))
    .leftJoin(t, and(eq(t.accountId, wr.accountId), eq(t.workspaceId, wr.workspaceId)))
    .where(
      and(
        eq(r.usesGithubIssues, true),
        isNull(t.provider),
        ...(accountId != null ? [eq(wr.accountId, accountId)] : []),
      ),
    )
    .execute()) as Array<{ accountId: number; workspaceId: number }>;
  return rows;
}

/** The EFFECTIVE tracker row for one workspace (the automatic default applied), or null. */
export async function readWorkspaceTrackerRow(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
): Promise<WorkspaceTrackerRow | null> {
  const stored = await readStoredTrackerRow(ctx, accountId, workspaceId);
  if (!isProviderUnchosen(stored)) return stored;
  return effectiveTrackerRow(stored, await githubIssuesRepos(ctx, accountId, workspaceId));
}

/**
 * A stored provider is LIVE only when an adapter implements it. A value naming a provider with no
 * adapter (a hand-written UPDATE, or a row written by a newer build and read by an older one) reads
 * as "no tracker" rather than travelling on.
 */
function liveProvider(raw: string | null | undefined): TrackerProvider | null {
  return maybeAdapterFor(raw) != null ? (raw as TrackerProvider) : null;
}

/** The public tracker half of a row. */
export function issueOf(row: WorkspaceTrackerRow | null): WorkspaceIssueSettings {
  const scope = row?.matchScope as IssueMatchScope | null | undefined;
  return {
    provider: liveProvider(row?.provider),
    baseUrl: row?.baseUrl ?? null,
    projectKeys: parseProjectKeys(row?.projectKeys ?? null),
    matchScope: scope != null && VALID_MATCH_SCOPE.includes(scope) ? scope : DEFAULT_MATCH_SCOPE,
  };
}

/** The stored row → the wire (GET/PUT /api/workspaces/:id/tracker). `detectedRepos` are the
 *  workspace's repos that use GitHub Issues; with no choice stored they decide the provider. */
export function toWorkspaceTrackerSettings(
  workspaceId: number,
  stored: WorkspaceTrackerRow | null,
  detectedRepos: readonly string[] = [],
): WorkspaceTrackerSettings {
  const row = effectiveTrackerRow(stored, detectedRepos);
  return {
    workspaceId,
    issue: issueOf(row),
    providerChosen: !isProviderUnchosen(stored),
    githubIssuesRepos: [...detectedRepos],
    // ⚠ `hasToken`, NEVER THE TOKEN. This is the only place the row reaches the wire, and the stored
    // value (sealed or plain) must not ride along in any form.
    jira: {
      email: row?.authEmail ?? null,
      hasToken: row?.authToken != null && row.authToken !== '',
    },
  };
}

/**
 * The base URL a tracker's links are built on: the provider's FIXED site when it has one (GitHub
 * Issues: github.com — the workspace's stored base URL is ignored, and kept for a switch back), else
 * the stored base URL; null when there is none.
 */
export function trackerBaseUrl(issue: Pick<WorkspaceIssueSettings, 'provider' | 'baseUrl'>): string | null {
  const adapter = maybeAdapterFor(issue.provider);
  if (adapter == null) return null;
  if (adapter.fixedBaseUrl != null) return adapter.fixedBaseUrl;
  const b = issue.baseUrl?.trim() ?? '';
  return b === '' ? null : b;
}

/** The ONE liveness test for a tracker — a provider with an adapter AND a base URL to link to
 *  (`trackerBaseUrl`). A TYPE PREDICATE so a caller narrows instead of re-asserting the pair: two
 *  spellings of "configured" is how the Settings screen says "configured" while the PR panel
 *  renders nothing. Read the base URL through `trackerBaseUrl`, never `issue.baseUrl`. */
export function isIssueConfigured(
  issue: WorkspaceIssueSettings,
): issue is WorkspaceIssueSettings & { provider: TrackerProvider } {
  return issue.provider != null && trackerBaseUrl(issue) != null;
}

/** Everything a tracker call needs for ONE workspace, token OPENED. Never serialised. */
export interface WorkspaceTrackerAccess {
  issue: WorkspaceIssueSettings;
  email: string | null;
  token: OpenedToken;
}

/** The access half of an already-read row (so a caller answers from ONE read). */
export function trackerAccessOf(host: HostSeal | undefined, row: WorkspaceTrackerRow | null): WorkspaceTrackerAccess {
  return {
    issue: issueOf(row),
    email: row?.authEmail ?? null,
    token: openTrackerToken(host, row?.authToken),
  };
}

export async function readWorkspaceTrackerAccess(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
): Promise<WorkspaceTrackerAccess> {
  return trackerAccessOf(ctx.host, await readWorkspaceTrackerRow(ctx, accountId, workspaceId));
}

export async function readWorkspaceTracker(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
): Promise<WorkspaceTrackerSettings> {
  const stored = await readStoredTrackerRow(ctx, accountId, workspaceId);
  return toWorkspaceTrackerSettings(workspaceId, stored, await githubIssuesRepos(ctx, accountId, workspaceId));
}

function normalizeBaseUrl(raw: string | null): string | null {
  if (raw == null) return null;
  const t = raw.trim().replace(/\/+$/, '');
  if (t === '') return null;
  if (!/^https?:\/\//i.test(t)) return null; // only accept absolute http(s) URLs
  return t;
}

/** The SITE a stored base URL points at (host + port, lower-cased), or null. A saved token belongs
 *  to ONE site. ⚠ Read off the STORED URL, not the provider's fold: a provider with a fixed site
 *  (GitHub Issues) sends the Jira token nowhere and keeps the stored Jira URL, so switching to it and
 *  back to the same Jira site keeps the token — while any move of the URL itself still drops it. */
function siteOf(baseUrl: string | null): string | null {
  const root = normalizeBaseUrl(baseUrl);
  if (root == null) return null;
  // ⚠ A LINEAR SITE IS THE WORKSPACE, NOT THE HOST: every Linear workspace lives on linear.app, and a
  // personal API key belongs to exactly one of them, so `linear.app/acme` → `linear.app/other` drops it.
  const linear = linearSiteRoot(root);
  if (linear != null) return linear;
  try {
    return new URL(root).host.toLowerCase();
  } catch {
    return null;
  }
}

type MutableCols = WorkspaceTrackerRow;

/** A Linear personal API key's own prefix (Linear's settings page issues `lin_api_…`). */
export const LINEAR_KEY_RE = /^lin_api_[A-Za-z0-9]{8,}$/;

/**
 * A patch the PUT refuses with a sentence, or null. Only the Linear key has a shape worth checking
 * up front: a Jira token, a GitHub token or a Linear OAuth token pasted into the Linear field would
 * otherwise be saved, sealed, and fail on every read as "Linear rejected this key".
 */
export function trackerPatchError(existing: WorkspaceTrackerRow | null, patch: WorkspaceTrackerUpdate): string | null {
  const provider = patch.issue?.provider !== undefined ? patch.issue.provider : (existing?.provider ?? null);
  const token = typeof patch.jira?.token === 'string' ? patch.jira.token.trim() : '';
  if (provider === 'linear' && token !== '' && !LINEAR_KEY_RE.test(token)) {
    return 'That is not a Linear personal API key. Create one in Linear under Settings → Security & access; it starts with lin_api_.';
  }
  return null;
}

/**
 * Merge a validated patch over the existing row, returning a FULLY-SPECIFIED column set. ⚠ EVERY
 * COLUMN IS SEEDED FROM `existing` — a column not seeded is NULLED by the upsert on any unrelated
 * patch, and the token is the one whose loss would hurt most.
 */
export function mergeTracker(
  existing: WorkspaceTrackerRow | null,
  patch: WorkspaceTrackerUpdate,
  host: HostSeal | undefined = undefined,
): MutableCols {
  const out: MutableCols = {
    provider: existing?.provider ?? null,
    baseUrl: existing?.baseUrl ?? null,
    projectKeys: existing?.projectKeys ?? null,
    matchScope: existing?.matchScope ?? null,
    authEmail: existing?.authEmail ?? null,
    authToken: existing?.authToken ?? null,
  };

  if (patch.issue) {
    const i = patch.issue;
    // ⚠ A CHOSEN "None" IS STORED, as `NONE_PROVIDER` — NULL would hand the workspace back to the
    // automatic default (GitHub Issues when a repo uses it).
    if (i.provider !== undefined)
      out.provider =
        i.provider != null && TRACKER_PROVIDERS_AVAILABLE.includes(i.provider) ? i.provider : NONE_PROVIDER;
    if (i.baseUrl !== undefined) out.baseUrl = normalizeBaseUrl(i.baseUrl);
    if (i.projectKeys !== undefined) {
      // Normalise (uppercase, well-shaped prefixes only, deduped, capped), store comma-joined; an
      // empty result clears the allowlist (→ heuristic, title-only detection).
      const parsed = parseProjectKeys((i.projectKeys ?? []).join(','));
      out.projectKeys = parsed.length > 0 ? parsed.join(',') : null;
    }
    if (i.matchScope !== undefined && VALID_MATCH_SCOPE.includes(i.matchScope)) out.matchScope = i.matchScope;
  }

  // ⚠ A SAVED TOKEN BELONGS TO ONE SITE. Pointing the tracker at a different HOST removes it, so a
  // token typed for `acme.atlassian.net` is never sent to whatever the URL says next. (A new token
  // sent in the same patch is kept — it was typed for the new site.) The plugin's rule, unchanged.
  if (out.authToken != null && siteOf(existing?.baseUrl ?? null) !== siteOf(out.baseUrl)) {
    out.authToken = null;
  }

  if (patch.jira) {
    const j = patch.jira;
    if (j.email !== undefined) {
      const e = (j.email ?? '').trim();
      // The schema already refuses whitespace and ':' (a colon would break HTTP Basic).
      out.authEmail = e === '' ? null : e;
    }
    // WRITE-ONLY: an omitted token keeps the saved one; `clearToken` removes it.
    const token = typeof j.token === 'string' ? j.token.trim() : '';
    if (token !== '') out.authToken = storeTrackerToken(host, token);
    else if (j.clearToken === true) out.authToken = null;
  }

  return out;
}

/**
 * The ONE writer of `workspace_trackers`. A partial patch over ONE workspace's row. ⚠ IT NEVER
 * DELETES — clearing writes NULLs, so a cleared value can never be resurrected by the legacy move
 * (./legacy-import.ts copies with ON CONFLICT DO NOTHING onto an existing row).
 *
 * The caller has ALREADY proved the workspace is this account's; the named composite FK
 * `workspace_trackers_workspace_account_fk` makes a cross-account pair fail in the database anyway.
 */
export async function writeWorkspaceTracker(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  patch: WorkspaceTrackerUpdate,
): Promise<WorkspaceTrackerSettings> {
  const t = ctx.schema.workspaceTrackers;
  // ⚠ The STORED row, never the effective one: a patch that does not name a provider must leave an
  // unchosen workspace on the automatic default, not freeze today's detection into a choice.
  const existing = await readStoredTrackerRow(ctx, accountId, workspaceId);
  const cols = mergeTracker(existing, patch, ctx.host);
  const now = new Date();
  await ctx.db
    .insert(t)
    .values({ accountId, workspaceId, ...cols, updatedAt: now })
    .onConflictDoUpdate({
      // ⚠ EXACTLY the table's unique index (`workspace_trackers_account_workspace`).
      target: [t.accountId, t.workspaceId],
      set: { ...cols, updatedAt: now },
    })
    .execute();
  return readWorkspaceTracker(ctx, accountId, workspaceId);
}
