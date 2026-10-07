import { and, eq } from 'drizzle-orm';
import type { TrackerProvider } from '@pierre-review/shared';
import type { TicketRef } from '@pierre-review/shared';
import type { TrackerContext } from './context.js';
import { buildTicketRefs, maybeAdapterFor } from './registry.js';
import {
  isIssueConfigured,
  readWorkspaceTrackerRow,
  trackerAccessOf,
  trackerBaseUrl,
  type WorkspaceTrackerAccess,
} from './settings.js';
import type { DetectInput, DetectedTicket } from './types.js';

// THE PR'S TICKETS — compute-on-read from the PR title + head branch against the WORKSPACE's
// tracker. Core `getPrDetail` calls `prTicketRefs` (via pr/detail-enricher.ts); the ticket routes,
// the Open PRs ticket row and the worker all run the SAME detection (`detectForAccess`).
//   null → no tracker for this PR (PrDetail.tickets = null: no ticket UI)
//   []   → a tracker, no ticket found (a muted "No ticket found")
//   [..] → a link chip per ticket
//
// ── ⚠ THE CONFIG IS PER WORKSPACE, AND THE PR NAMES ITS OWN ─────────────────────────────────────
// A repo belongs to EXACTLY ONE workspace (`workspace_repos` unique on (account, repo); assignment
// is an upsert = a MOVE), so one indexed read answers "which tracker". A repo with NO membership row
// degrades to "no tracker": falling back to the Default workspace would render one team's tracker
// against another team's PR — chips deep-linking into a Jira that PR's team does not use, from a
// setting they cannot see. ABSENT, NEVER WRONG.

/**
 * The workspace a repo belongs to, or null. Scoped by (accountId, repoId) — a repo id belonging to
 * another tenant finds nothing rather than that tenant's workspace.
 */
export async function workspaceIdForRepo(
  ctx: TrackerContext,
  accountId: number,
  repoId: number,
): Promise<number | null> {
  const t = ctx.schema.workspaceRepos;
  const rows = (await ctx.db
    .select({ workspaceId: t.workspaceId })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.repoId, repoId)))
    .limit(1)
    .execute()) as Array<{ workspaceId: number }>;
  return rows[0]?.workspaceId ?? null;
}

export interface PrTicketDetection {
  workspaceId: number;
  access: WorkspaceTrackerAccess;
  keys: string[];
  /** The provider READS its links (GitHub Issues) and this PR's were never read: `keys` is [] for
   *  want of an answer, NOT "no ticket". Views show nothing rather than "No ticket found". */
  linksUnknown: boolean;
}

/** True when this provider's links are the WHOLE answer (GitHub Issues) and the PR's have not been
 *  read yet. A provider whose links only ADD to detection (Linear) never answers "unknown". */
export function linksUnknownFor(provider: TrackerProvider | null, pr: DetectInput): boolean {
  return maybeAdapterFor(provider)?.linker?.required === true && pr.closingIssues == null;
}

/**
 * Detection (with sources) over an ALREADY-READ workspace access — the ONE rule, shared by the PR
 * chips, the ticket routes, the Open PRs batch and the worker. null = no live tracker configured.
 */
export function detectForAccess(access: WorkspaceTrackerAccess, pr: DetectInput): DetectedTicket[] | null {
  const issue = access.issue;
  if (!isIssueConfigured(issue)) return null;
  const adapter = maybeAdapterFor(issue.provider);
  const baseUrl = trackerBaseUrl(issue);
  if (adapter == null || baseUrl == null) return null;
  return adapter.detect(
    { provider: issue.provider, baseUrl, projectKeys: issue.projectKeys, matchScope: issue.matchScope },
    pr,
  );
}

/** Just the keys, in detection order. null = no tracker. */
export function detectKeysWithAccess(access: WorkspaceTrackerAccess, pr: DetectInput): string[] | null {
  return detectForAccess(access, pr)?.map((d) => d.key) ?? null;
}

/**
 * ⚠ THE ONE DETECTION PATH for one PR, shared by the PR chips and the ticket routes, so "a ticket
 * Limn detected on this PR" means the same thing on both. The ticket routes REQUIRE the requested
 * key to be one of these, which is what stops them being a generic tracker proxy.
 */
export async function detectPrTickets(
  ctx: TrackerContext,
  accountId: number,
  pr: DetectInput & { repoId: number; id?: number },
): Promise<PrTicketDetection | null> {
  const workspaceId = await workspaceIdForRepo(ctx, accountId, pr.repoId);
  if (workspaceId == null) return null;
  const access = trackerAccessOf(ctx.host, await readWorkspaceTrackerRow(ctx, accountId, workspaceId));
  let input: DetectInput = pr;
  // A provider whose links are READ (GitHub Issues, Linear) detects from the PR's stored links; a
  // caller that did not load them (the PR-detail enricher) has them read here — one indexed row.
  if (
    maybeAdapterFor(access.issue.provider)?.linker != null &&
    pr.closingIssues === undefined &&
    pr.linearLinks === undefined &&
    pr.id != null
  ) {
    input = { ...pr, ...(await storedLinks(ctx, accountId, pr.id)) };
  }
  const keys = detectKeysWithAccess(access, input);
  return keys == null
    ? null
    : { workspaceId, access, keys, linksUnknown: linksUnknownFor(access.issue.provider, input) };
}

/** The stored-link columns every detection caller selects (GitHub's closing issues, Linear's
 *  attachments + the Linear workspace they were read against). */
export function prLinkColumns(pr: TrackerContext['schema'][string]) {
  return { closingIssues: pr.closingIssues, linearLinks: pr.linearLinks, linearLinksRoot: pr.linearLinksRoot };
}

type RawLinks = { closingIssues?: unknown; linearLinks?: unknown; linearLinksRoot?: unknown };

/** A row selected with `prLinkColumns` → the DetectInput link fields (a driver may hand back JSON text). */
export function withParsedLinks<T extends RawLinks>(
  row: T,
): Omit<T, keyof RawLinks> & Required<Pick<DetectInput, 'closingIssues' | 'linearLinks' | 'linearLinksRoot'>> {
  return {
    ...row,
    closingIssues: parseClosingIssues(row.closingIssues ?? null),
    linearLinks: parseClosingIssues(row.linearLinks ?? null),
    linearLinksRoot: typeof row.linearLinksRoot === 'string' ? row.linearLinksRoot : null,
  };
}

/** A PR's stored links (this account only); null = never read. */
export async function storedLinks(
  ctx: TrackerContext,
  accountId: number,
  prId: number,
): Promise<Required<Pick<DetectInput, 'closingIssues' | 'linearLinks' | 'linearLinksRoot'>>> {
  const t = ctx.schema.pullRequests;
  const rows = (await ctx.db
    .select(prLinkColumns(t))
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.id, prId)))
    .limit(1)
    .execute()) as RawLinks[];
  const { closingIssues, linearLinks, linearLinksRoot } = withParsedLinks(rows[0] ?? {});
  return { closingIssues, linearLinks, linearLinksRoot };
}

/** A PR's stored GitHub closing-issue keys (this account only); null = never read. */
export async function storedClosingIssues(ctx: TrackerContext, accountId: number, prId: number): Promise<string[] | null> {
  return (await storedLinks(ctx, accountId, prId)).closingIssues;
}

/** A stored JSON key-list column → keys (a driver may hand back the JSON text). null = never read. */
export function parseClosingIssues(raw: unknown): string[] | null {
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : null;
}

/**
 * PrDetail.tickets for one PR — the tri-state above. `canFetchDetails` (the Claude Review / story
 * panel's "Fill from KEY"): a READING provider AND a token saved for THIS workspace. A token that
 * cannot be opened still counts — the click then says "save the token again", which is more useful
 * than a button that silently never appears. Never throws.
 */
export async function prTicketRefs(
  ctx: TrackerContext,
  input: { accountId: number; prId?: number; repoId: number; title: string; headRefName: string | null },
): Promise<TicketRef[] | null> {
  try {
    const found = await detectPrTickets(ctx, input.accountId, { ...input, id: input.prId });
    if (found == null || found.linksUnknown) return null;
    const { issue } = found.access;
    const baseUrl = trackerBaseUrl(issue);
    if (!isIssueConfigured(issue) || baseUrl == null) return null;
    const refs = buildTicketRefs(issue.provider, baseUrl, found.keys);
    const reader = maybeAdapterFor(issue.provider)?.reader;
    if (reader == null) return refs;
    const canFetchDetails = reader.credential === 'none' || found.access.token.state !== 'none';
    return refs.map((r) => ({ ...r, canFetchDetails }));
  } catch {
    return null; // best-effort; never fail the PR-detail read
  }
}
