import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { parseGithubIssueKey, type WorkspaceRepoMode } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { globalAutomationUserIds } from './automation-ids.js';
import { prOwnerId } from './true-author.js';
import { getAccountUserId } from '../auth/account.js';
import { parseProjectKeys } from '../tracker/detect.js';

// EXTERNAL REPOS (docs/DATA-MODEL.md § External repos) — THE ONE READER of `workspace_repos.mode`.
//
// An EXTERNAL member is a repo the team changes but does not maintain (an infrastructure platform's
// config repo). The workspace clones it for Implement and AI Fix and links it to tickets, but:
//
//   • its PRs are NOT watched — only its PROJECT PRs (below) reach Open PRs and Pending;
//   • nothing of it reaches Reports, Chronology, Feed, Bots, the Timeline or the trunk strip
//     (`resolveWorkspaceScope` returns WATCHED members unless a caller asks for `members: 'all'`);
//   • NO AUTOMATIC ACTION runs on any of its PRs, project PRs included (`automationAllowedFor*`).
//     A reader's press is never refused.
//
// ⚠ NEVER FILTER ON THE COLUMN ANYWHERE ELSE. A second spelling of "is this repo external" is a
// second visibility axis waiting to drift — the failure that removed `repos.inbox_watch` (0046).
//
// THE PROJECT-PR RULE, computed on READ (never stored: the maintainer set moves as people merge):
// a PR in an external repo is a project PR when EITHER
//   1. it carries a ticket key of THIS workspace's tracker that matches the workspace's
//      project-key ALLOWLIST (a GitHub Issues key: an issue in one of the workspace's WATCHED
//      repos). No allowlist ⇒ rule 1 never fires: heuristic detection would match every other
//      team's `PLAT-42` in a shared repo;
//   2. its owner (`prOwnerId` — the person a Limn-opened PR was opened for) MAINTAINS a WATCHED
//      repo of the workspace: has merged into its default branch (the `getMergers` proxy), bots
//      excluded. The reader always counts. ⚠ The external repo's OWN mergers never count, or the
//      platform team would be "your maintainers" and every PR there would show.

const { workspaceRepos, workspaceExternalRepos, workspaceTrackers, pullRequests, repos, trackerTickets } = schema;

export const EXTERNAL: WorkspaceRepoMode = 'external';

/** A member's mode as stored, defaulting anything unknown to 'watched' (the safe reading). */
export function repoModeOf(raw: string | null | undefined): WorkspaceRepoMode {
  return raw === 'external' ? 'external' : 'watched';
}

/**
 * The external member repo ids of one workspace — its home rows marked External PLUS its EXTRA
 * External memberships (`workspace_external_repos`: a repo whose home is another workspace). With
 * `workspaceId` null: the account's repos whose HOME row is External — the automation gate's
 * population (a repo Maintained anywhere is never in it).
 */
export async function externalRepoIds(accountId: number, workspaceId: number | null = null): Promise<Set<number>> {
  const rows = await db
    .select({ repoId: workspaceRepos.repoId })
    .from(workspaceRepos)
    .where(
      and(
        eq(workspaceRepos.accountId, accountId),
        eq(workspaceRepos.mode, EXTERNAL),
        workspaceId == null ? undefined : eq(workspaceRepos.workspaceId, workspaceId),
      ),
    )
    .execute();
  const out = new Set(rows.map((r) => r.repoId));
  if (workspaceId != null) {
    for (const r of await db
      .select({ repoId: workspaceExternalRepos.repoId })
      .from(workspaceExternalRepos)
      .where(and(eq(workspaceExternalRepos.accountId, accountId), eq(workspaceExternalRepos.workspaceId, workspaceId)))
      .execute())
      out.add(r.repoId);
  }
  return out;
}

/** The repo ids one workspace holds through an EXTRA External row (their home is another workspace). */
export async function extraExternalRepoIdsIn(accountId: number, workspaceId: number): Promise<number[]> {
  const rows = await db
    .select({ repoId: workspaceExternalRepos.repoId })
    .from(workspaceExternalRepos)
    .where(and(eq(workspaceExternalRepos.accountId, accountId), eq(workspaceExternalRepos.workspaceId, workspaceId)))
    .execute();
  return rows.map((r) => r.repoId);
}

/** Every EXTRA External membership of the account: (workspace, repo) pairs off the repo's home. */
export async function extraExternalMemberships(accountId: number): Promise<Array<{ workspaceId: number; repoId: number }>> {
  return db
    .select({ workspaceId: workspaceExternalRepos.workspaceId, repoId: workspaceExternalRepos.repoId })
    .from(workspaceExternalRepos)
    .where(eq(workspaceExternalRepos.accountId, accountId))
    .execute();
}

/** The WATCHED member repo ids of one workspace. */
async function watchedRepoIds(accountId: number, workspaceId: number): Promise<number[]> {
  const rows = await db
    .select({ repoId: workspaceRepos.repoId })
    .from(workspaceRepos)
    .where(
      and(
        eq(workspaceRepos.accountId, accountId),
        eq(workspaceRepos.workspaceId, workspaceId),
        eq(workspaceRepos.mode, 'watched'),
      ),
    )
    .execute();
  return rows.map((r) => r.repoId);
}

/**
 * Rule 2's population: who MAINTAINS a watched repo of this workspace — has merged a PR into its
 * default branch (the same proxy as `getMergers`, unknown branches counted), bots excluded — plus
 * the reader.
 */
export async function workspaceMaintainerIds(accountId: number, workspaceId: number): Promise<Set<number>> {
  const out = new Set<number>();
  const reader = await getAccountUserId(accountId);
  if (reader != null) out.add(reader);
  const watched = await watchedRepoIds(accountId, workspaceId);
  if (watched.length === 0) return out;
  const rows = await db
    .selectDistinct({ userId: pullRequests.mergedById })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(repos.accountId, accountId),
        inArray(pullRequests.repoId, watched),
        eq(pullRequests.state, 'merged'),
        isNotNull(pullRequests.mergedById),
        or(
          isNull(repos.defaultBranch),
          isNull(pullRequests.baseRefName),
          eq(pullRequests.baseRefName, repos.defaultBranch),
        ),
      ),
    )
    .execute();
  const bots = await globalAutomationUserIds();
  for (const r of rows) if (r.userId != null && !bots.has(r.userId)) out.add(r.userId);
  return out;
}

export interface ProjectPrFacts {
  ownerId: number | null;
  /** Every tracker ticket key stored for this PR in this workspace. */
  ticketKeys: readonly string[];
}

export interface ProjectPrRule {
  maintainers: ReadonlySet<number>;
  /** The workspace's project-key allowlist (upper-case prefixes). Empty ⇒ rule 1 never fires. */
  allowKeys: ReadonlySet<string>;
  /** `owner/name` (lower-case) of the workspace's WATCHED repos — rule 1 for GitHub Issues keys. */
  watchedRepoNames: ReadonlySet<string>;
}

const PREFIX_RE = /^([A-Z][A-Z0-9_]*)-\d+$/;

/** THE RULE, pure (unit-tested). */
export function isProjectPr(pr: ProjectPrFacts, rule: ProjectPrRule): boolean {
  if (pr.ownerId != null && rule.maintainers.has(pr.ownerId)) return true;
  for (const key of pr.ticketKeys) {
    const gh = parseGithubIssueKey(key);
    if (gh != null) {
      if (rule.watchedRepoNames.has(`${gh.owner}/${gh.repo}`)) return true;
      continue;
    }
    const prefix = PREFIX_RE.exec(key.toUpperCase())?.[1];
    if (prefix != null && rule.allowKeys.has(prefix)) return true;
  }
  return false;
}

/** The inputs of `isProjectPr` for one workspace. */
export async function projectPrRuleFor(accountId: number, workspaceId: number): Promise<ProjectPrRule> {
  const [maintainers, trackerRow, watched] = await Promise.all([
    workspaceMaintainerIds(accountId, workspaceId),
    db
      .select({ projectKeys: workspaceTrackers.projectKeys })
      .from(workspaceTrackers)
      .where(and(eq(workspaceTrackers.accountId, accountId), eq(workspaceTrackers.workspaceId, workspaceId)))
      .limit(1)
      .execute(),
    watchedRepoIds(accountId, workspaceId),
  ]);
  const names =
    watched.length === 0
      ? []
      : await db
          .select({ owner: repos.owner, name: repos.name })
          .from(repos)
          .where(and(eq(repos.accountId, accountId), inArray(repos.id, watched)))
          .execute();
  return {
    maintainers,
    allowKeys: new Set(parseProjectKeys(trackerRow[0]?.projectKeys)),
    watchedRepoNames: new Set(names.map((r) => `${r.owner}/${r.name}`.toLowerCase())),
  };
}

/**
 * THE PROJECT PRs of a workspace: PRs in its EXTERNAL repos that pass `isProjectPr`. `openOnly`
 * (the boards) reads open PRs only. [] when the workspace has no external repo — the steady state,
 * one indexed select.
 */
export async function projectPrIds(
  accountId: number,
  workspaceId: number,
  opts: { openOnly?: boolean; repoIds?: readonly number[] } = {},
): Promise<number[]> {
  let externals = [...(await externalRepoIds(accountId, workspaceId))];
  if (opts.repoIds != null) externals = externals.filter((id) => opts.repoIds!.includes(id));
  if (externals.length === 0) return [];
  const prs = await db
    .select({ id: pullRequests.id, authorId: pullRequests.authorId, limnOpenedForUserId: pullRequests.limnOpenedForUserId })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, externals),
        opts.openOnly === true ? eq(pullRequests.state, 'open') : undefined,
      ),
    )
    .execute();
  if (prs.length === 0) return [];
  const rule = await projectPrRuleFor(accountId, workspaceId);
  const keysByPr = new Map<number, string[]>();
  const ids = prs.map((p) => p.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const t of await db
      .select({ prId: trackerTickets.prId, issueKey: trackerTickets.issueKey })
      .from(trackerTickets)
      .where(
        and(
          eq(trackerTickets.accountId, accountId),
          eq(trackerTickets.workspaceId, workspaceId),
          inArray(trackerTickets.prId, chunk),
        ),
      )
      .execute()) {
      const arr = keysByPr.get(t.prId) ?? [];
      arr.push(t.issueKey);
      keysByPr.set(t.prId, arr);
    }
  }
  return prs
    .filter((p) => isProjectPr({ ownerId: prOwnerId(p), ticketKeys: keysByPr.get(p.id) ?? [] }, rule))
    .map((p) => p.id);
}

/**
 * The account-wide board population for a fold called WITHOUT a workspace (My Turn's notification
 * and CLI read): every WATCHED repo plus every workspace's project PRs. null when the account has no
 * external repo — the caller keeps its "no narrowing" path unchanged.
 */
export async function accountBoardScope(
  accountId: number,
): Promise<{ watchedRepoIds: number[]; projectPrIds: number[]; externalRepoIds: number[] } | null> {
  const rows = await db
    .select({ repoId: workspaceRepos.repoId, workspaceId: workspaceRepos.workspaceId, mode: workspaceRepos.mode })
    .from(workspaceRepos)
    .where(eq(workspaceRepos.accountId, accountId))
    .execute();
  const external = rows.filter((r) => repoModeOf(r.mode) === 'external');
  if (external.length === 0) return null;
  // A repo whose HOME is External may be External in other workspaces too: each one's project-PR
  // rule counts (a PR is a project PR of ANY workspace the repo sits in).
  const extras = await extraExternalMemberships(accountId);
  const prIds = new Set<number>();
  for (const ws of new Set([...external, ...extras].map((r) => r.workspaceId))) {
    for (const id of await projectPrIds(accountId, ws, { openOnly: true })) prIds.add(id);
  }
  return {
    watchedRepoIds: rows.filter((r) => repoModeOf(r.mode) === 'watched').map((r) => r.repoId),
    projectPrIds: [...prIds],
    externalRepoIds: external.map((r) => r.repoId),
  };
}

// ── THE AUTOMATION GATE ─────────────────────────────────────────────────────────────────────────
// ⚠ EVERY AUTOMATIC PATH asks this before it acts on a PR or a repo (auto review, auto-post, auto
// fix, the CI and ticket review sweeps, diagrams, "Resolve my Limn threads", dependency automation,
// SonarCloud's late post, Slack signals, ML scoring). False ⇒ skip, never queue. A reader's press
// never asks. `external-automation-gate.test.ts` pins the callers.

/**
 * Where a gate reads from. Absent ⇒ core's `db`. A module that holds an `AgentContext` passes it
 * (`ctx.db` / `ctx.schema`), as every agentic module reads the database; a context WITHOUT a database
 * (a unit test's fake) is answered "allowed" — those tests drive the automatic path itself.
 */
export type GateSource = { db?: unknown; schema?: Record<string, unknown> };

/* eslint-disable @typescript-eslint/no-explicit-any */
function sourceOf(on: GateSource | undefined): { d: any; t: any } | null {
  if (on == null) return { d: db, t: schema };
  const t = on.schema as any;
  if (on.db == null || t?.workspaceRepos == null || t?.pullRequests == null) return null;
  return { d: on.db, t };
}

/** False when the repo is an EXTERNAL member: no automatic action runs on it. */
export async function automationAllowedForRepo(accountId: number, repoId: number, on?: GateSource): Promise<boolean> {
  const src = sourceOf(on);
  if (src == null) return true;
  const wr = src.t.workspaceRepos;
  const rows = (await src.d
    .select({ mode: wr.mode })
    .from(wr)
    .where(and(eq(wr.accountId, accountId), eq(wr.repoId, repoId)))
    .limit(1)
    .execute()) as Array<{ mode: string | null }>;
  return repoModeOf(rows[0]?.mode) !== 'external';
}

/** `automationAllowedForRepo` for the PR's repo. An unknown PR is allowed (the caller's own lookup refuses it). */
export async function automationAllowedForPr(accountId: number, prId: number, on?: GateSource): Promise<boolean> {
  const src = sourceOf(on);
  if (src == null) return true;
  const { workspaceRepos: wr, pullRequests: pr } = src.t;
  const rows = (await src.d
    .select({ mode: wr.mode })
    .from(pr)
    .innerJoin(wr, and(eq(wr.repoId, pr.repoId), eq(wr.accountId, pr.accountId)))
    .where(and(eq(pr.accountId, accountId), eq(pr.id, prId)))
    .limit(1)
    .execute()) as Array<{ mode: string | null }>;
  return repoModeOf(rows[0]?.mode) !== 'external';
}

/** The account's external repo ids, read through `on` (see `GateSource`); empty for a fake context. */
export async function externalRepoIdsVia(accountId: number, on: GateSource): Promise<Set<number>> {
  const src = sourceOf(on);
  if (src == null) return new Set();
  const wr = src.t.workspaceRepos;
  const rows = (await src.d
    .select({ repoId: wr.repoId })
    .from(wr)
    .where(and(eq(wr.accountId, accountId), eq(wr.mode, EXTERNAL)))
    .execute()) as Array<{ repoId: number }>;
  return new Set(rows.map((r) => r.repoId));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Every external repo id of every account — for the account-less sweeps (sync, ML) to skip. */
export async function allExternalRepoIds(): Promise<Set<number>> {
  const rows = await db
    .select({ repoId: workspaceRepos.repoId })
    .from(workspaceRepos)
    .where(eq(workspaceRepos.mode, EXTERNAL))
    .execute();
  return new Set(rows.map((r) => r.repoId));
}
