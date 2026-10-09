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
import type { StoredTicketRow } from './store.js';

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
  /** Keys present ONLY because a person added them by hand (detection alone would not name them) —
   *  the ones a reader can remove (`DELETE /api/prs/:id/tracker-ticket/manual`). */
  manualOnlyKeys: string[];
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
  const found = adapter.detect(
    { provider: issue.provider, baseUrl, projectKeys: issue.projectKeys, matchScope: issue.matchScope },
    pr,
  );
  // A ticket a person LINKED BY HAND is one of the PR's tickets like a detected one, and stays
  // 'manual' even when the title names it too — so a later title edit cannot prune what a person
  // added. Not filtered by the project allowlist: a person named it on purpose.
  const manual = new Set(
    (pr.manualKeys ?? []).map((k) => adapter.normalizeKey(k)).filter((k): k is string => k != null && adapter.isKey(k)),
  );
  if (manual.size === 0) return found;
  const out: DetectedTicket[] = found.map((d) => (manual.has(d.key) ? { ...d, from: 'manual' } : d));
  for (const key of manual) {
    if (!out.some((d) => d.key === key)) out.push({ key, from: 'manual', order: out.length });
  }
  return out;
}

/**
 * The keys of a PR's stored rows a person linked by hand, on the workspace's CURRENT provider and
 * site — a manual row left over from another tracker is not one of its tickets (and the worker's
 * prune removes it, like any key detection no longer names).
 */
export function manualKeysOf(
  rows: ReadonlyArray<Pick<StoredTicketRow, 'detectedFrom' | 'provider' | 'apiRoot' | 'issueKey'>>,
  access: WorkspaceTrackerAccess,
): string[] {
  const provider = access.issue.provider;
  const adapter = maybeAdapterFor(provider);
  if (adapter == null) return [];
  const root = adapter.siteRoot(trackerBaseUrl(access.issue));
  if (root == null) return [];
  return rows
    .filter((r) => r.detectedFrom === 'manual' && r.provider === provider && r.apiRoot === root)
    .map((r) => r.issueKey);
}

/** One PR's manually linked rows (this account only) — the columns `manualKeysOf` reads. */
export async function readManualRows(
  ctx: TrackerContext,
  accountId: number,
  prId: number,
): Promise<Array<Pick<StoredTicketRow, 'detectedFrom' | 'provider' | 'apiRoot' | 'issueKey'>>> {
  const t = ctx.schema.trackerTickets;
  return (await ctx.db
    .select({ detectedFrom: t.detectedFrom, provider: t.provider, apiRoot: t.apiRoot, issueKey: t.issueKey })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.prId, prId), eq(t.detectedFrom, 'manual')))
    .execute()) as Array<Pick<StoredTicketRow, 'detectedFrom' | 'provider' | 'apiRoot' | 'issueKey'>>;
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
  if (input.manualKeys === undefined && pr.id != null) {
    input = { ...input, manualKeys: manualKeysOf(await readManualRows(ctx, accountId, pr.id), access) };
  }
  const keys = detectKeysWithAccess(access, input);
  if (keys == null) return null;
  const detected = (input.manualKeys ?? []).length > 0 ? new Set(detectKeysWithAccess(access, { ...input, manualKeys: [] }) ?? []) : null;
  return {
    workspaceId,
    access,
    keys,
    linksUnknown: linksUnknownFor(access.issue.provider, input),
    manualOnlyKeys: detected == null ? [] : keys.filter((k) => !detected.has(k)),
  };
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
  return (await prTicketView(ctx, input)).tickets;
}

/**
 * PrDetail's ticket fields: `tickets` (the tri-state above) and `ticketsAddable` — the PR's workspace
 * has a READING tracker, so the Story check's paste box can add a ticket by hand. ⚠ `addable` is
 * true even while `tickets` is null for want of read links (GitHub Issues, `linksUnknown`): those
 * PRs are exactly the ones most likely to need a hand-added ticket. Never throws.
 */
export async function prTicketView(
  ctx: TrackerContext,
  input: { accountId: number; prId?: number; repoId: number; title: string; headRefName: string | null },
): Promise<{ tickets: TicketRef[] | null; addable: boolean }> {
  try {
    const found = await detectPrTickets(ctx, input.accountId, { ...input, id: input.prId });
    if (found == null) return { tickets: null, addable: false };
    const { issue } = found.access;
    const baseUrl = trackerBaseUrl(issue);
    if (!isIssueConfigured(issue) || baseUrl == null) return { tickets: null, addable: false };
    const reader = maybeAdapterFor(issue.provider)?.reader;
    const addable = reader != null;
    if (found.linksUnknown) return { tickets: null, addable };
    const manualOnly = new Set(found.manualOnlyKeys);
    const refs = buildTicketRefs(issue.provider, baseUrl, found.keys).map((r) =>
      manualOnly.has(r.key) ? { ...r, manual: true } : r,
    );
    if (reader == null) return { tickets: refs, addable };
    const canFetchDetails = reader.credential === 'none' || found.access.token.state !== 'none';
    return { tickets: refs.map((r) => ({ ...r, canFetchDetails })), addable };
  } catch {
    return { tickets: null, addable: false }; // best-effort; never fail the PR-detail read
  }
}
