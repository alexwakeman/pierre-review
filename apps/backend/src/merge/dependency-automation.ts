// ── DEPENDENCY AUTOMATION: APPROVE, RESOLVE CONFLICTS, FIX WITH AI (CORE, free) ─────────────────
//
// docs/MERGE-CI-TRUNK.md § Dependency automation. Settings → Dependencies holds, per workspace and
// every one OFF by default: "merge" (merge/dependency-policy.ts, the older switch), "approve",
// "resolve conflicts" and "fix with AI" (this file), and ONE policy (size, security-only,
// ecosystems) that gates them all. The decisions are pure and tested in merge/dependency-rules.ts;
// this file gathers values, claims, writes and records.
//
// WHO: approval, conflict resolution and the AI fix act ONLY on PRs opened by a bot the reader
// TRUSTS — its STORED row in this workspace says automated, role `dependency`, and
// `dependency_trusted` (`isTrustedDependencyBot`). Never a login guess.
//
// APPROVE (`runDependencyAutomationTick`, on the auto-merge watcher's cron just before the merge
// sweep): an open, non-draft, same-repo PR whose SYNCED CI is `success` (green, not merely not red)
// and whose review decision is not already `approved`, in a repo the reader can push to. Re-read
// LIVE first (one GET): the head must be the synced one (the approval is pinned to it with
// `commit_id`), it must not be a fork, and its title + body are what the policy measures.
//
// RESOLVE CONFLICTS (also run by "fix with AI" — one path): first ask the bot to rebase, once per
// head, and wait REBASE_WAIT_MS. Then ONE unattended AI Fix session with the MERGE item
// (`resolveConflicts`, sandbox/session/fix-merge.ts): the agent merges the base and resolves in the
// sandbox, the host checks the merge commit (parents, markers), and AI Fix's own Push sends the merge
// commit onto the PR's own branch, never a rebase. Behind the AUTOMATIC-RUN budget gate; no container
// runtime ⇒ the same one skip row as the CI fix. A merge that fails Limn's check pushes nothing.
// ⚠ CONFLICTING AND RED, with "fix with AI" on: that SAME one session also gets the CI review's fixable
// items at the current head (the CI-only seed + `resolveConflicts`; merge first, the CI fixes on top; none ⇒
// merge only). ONE `ai_resolve` row: ONE AI run against the cap. "Resolve their conflicts" alone never
// fixes CI.
//
// FIX WITH AI: a red PR (not conflicting) whose failure is proven LIVE gets ONE unattended AI Fix (plain seed: the
// failing checks' log excerpts) — an UNATTENDED sandboxed session (one build turn, then it closes) —
// pushed through AI Fix's own Push. ≤ DEPENDENCY_AI_FIX_DAILY_CAP AI runs (fixes + conflict runs) per PR
// per 24 h. Every pushed head (`resultSha`) must be GREEN again before it is approved or armed.
// ⚠ NO CONTAINER RUNTIME ⇒ ONE `skipped` row per head ("No container runtime on this computer."),
// written BEFORE any claim (`recordSandboxSkip`): no `limn/deps` line, no cap use, and later ticks at
// that head read nothing. A BUSY sandbox writes nothing at all; a later tick decides.
//
// ⚠ TEAMS (merge/deps-claim.ts): before ANY action, the head's `limn/deps` commit status is read
// and claimed; a teammate's live claim or finished action of the same family ⇒ a SKIPPED row
// ("robin is handling this"), never a failure.
// ⚠ CLAIM BEFORE WRITE, NEVER RETRY: every action inserts its (account, PR, head, action) row as
// `running` BEFORE the GitHub write (`claimAction`, a unique index); no row inserted → somebody
// already did it. A failure is recorded with GitHub's words and never retried at that head.
// ⚠ THE LOG IS A TRUE RECORD: a row says `done` only after GitHub accepted the write; "Merged"
// (`merge_landed`) only from the auto-merge watcher's merged outcome, never from arming.
// ⚠ EVERY WRITE STAMPS OR SETTLES, THEN CASCADES: the approval stamps the review + clears the
// request + re-reads + schedules the settle ladder; the rebase comment stamps the comment; the body
// edit re-reads; the AI pushes land through the resolver's / AI Fix's own paths (which settle).
// ⚠ A PERSON'S CANCEL WINS: a PR in `auto_merge_policy_skips` is left alone by every switch, and a
// person cancelling the AI fix in its tab ends it (recorded, never retried).
import type { FastifyBaseLogger } from 'fastify';
import { and, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  DEFAULT_AI_FIX_MODEL,
  DEFAULT_DEPENDENCY_POLICY,
  DEPENDENCY_AI_FIX_DAILY_CAP,
  DEPENDENCY_ECOSYSTEMS,
  type DependencyAutomationActionKind,
  type DependencyAutomationActionState,
  type DependencyAutomationLogItem,
  type DependencyAutomationPatch,
  type DependencyAutomationPolicy,
  type DependencyAutomationSettings,
  type DependencyBot,
  type DependencyEcosystem,
  type WorkspaceDependencyAutomationResponse,
} from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { onOff, recordWorkspaceSettingEvent } from '../db/workspace-setting-events.js';
import { getAccessToken, getAccountUserId } from '../auth/account.js';
import {
  clearOwnReviewRequest,
  getWorkspaceRepoIds,
  upsertLocalPrComment,
  upsertLocalReview,
  WRITE_PERMISSIONS,
} from '../db/queries.js';
import { isConflicting } from '../db/pending-classify.js';
import {
  addIssueComment,
  fetchPrForAutomation,
  submitPrReview,
  updatePullRequestBody,
  type PrAutomationSnapshot,
} from '../github/mutations.js';
import { asSyncLogger, resyncPrAfterWrite } from '../sync/resync-after-write.js';
import { notePrChangedForPr, schedulePrSettle } from '../sync/pr-settle.js';
import type { AgentContext } from '../review/agent-context.js';
import { automaticRunAllowed } from '../review/budget-gate.js';
import {
  AI_RUN_WINDOW_MS,
  aiFixEligibility,
  botCanRebase,
  dependencyConflictInstruction,
  dependencyFixInstruction,
  dependencyMergeAndCiPreamble,
  classifyDependencyUpdate,
  conflictStep,
  isTrustedDependencyBot,
  parseLevel,
  policyNeedsLevel,
  policyVerdict,
  rebaseRequestFor,
  type DependencyUpdateClass,
  type PolicyRefusal,
} from './dependency-rules.js';
import { setDependencyAutoMerge } from './dependency-policy.js';
import {
  depsHeldNow,
  endDepsClaim,
  familyOfAction,
  markAiPushedHead,
  postDepsClaim,
  readDepsClaim,
  rememberDepsAwaitingCi,
  rememberDepsHold,
  renewDepsClaim,
  type ClaimAction,
  type DepsClaimEnd,
  type DepsClaimHandle,
  type DepsHold,
} from './deps-claim.js';

const {
  autoMergePolicySkips,
  dependencyAutomationActions: daa,
  pullRequests,
  repos,
  users,
  workspaceReviewers,
  workspaces,
} = schema;

/** GitHub writes per tick across every account (an approval, a rebase ask, an AI start). */
const ACTIONS_PER_TICK = 6;
/** How long an AI fix — a CI fix or a conflict run — may take (the sandbox's boot — a first image pull is slow — then its one build turn)
 *  before it is given up on. */
const AI_FIX_TIMEOUT_MS = 90 * 60_000;
/** The automation log's window and length. */
const LOG_DAYS = 14;
const LOG_MAX = 40;

/** The hidden marker every body Limn posts carries (`isLimnPostedComment`). */
const LIMN_MARKER = '<!-- pierre:claude-review-dependency v=1 -->';

const BOT_BRAND: Record<string, string> = { dependabot: 'Dependabot', renovate: 'Renovate' };

// ── The settings ─────────────────────────────────────────────────────────────────────────────

/** The policy from a workspace row's three columns (the merge sweep reads it too). */
export function policyFromColumns(row: {
  maxLevel: string | null;
  securityOnly: boolean | null;
  ecosystems: string[] | null;
}): DependencyAutomationPolicy {
  const known = new Set<string>(DEPENDENCY_ECOSYSTEMS);
  return {
    maxLevel: parseLevel(row.maxLevel) ?? DEFAULT_DEPENDENCY_POLICY.maxLevel,
    securityOnly: row.securityOnly === true,
    ecosystems: Array.isArray(row.ecosystems)
      ? (row.ecosystems.filter((e) => known.has(e)) as DependencyEcosystem[])
      : null,
  };
}

const settingsColumns = {
  autoMerge: workspaces.dependencyAutoMerge,
  autoApprove: workspaces.dependencyAutoApprove,
  autoResolve: workspaces.dependencyAutoResolve,
  autoFix: workspaces.dependencyAutoFix,
  maxLevel: workspaces.dependencyMaxLevel,
  securityOnly: workspaces.dependencySecurityOnly,
  ecosystems: workspaces.dependencyEcosystems,
};

type SettingsRow = {
  autoMerge: boolean | null;
  autoApprove: boolean | null;
  autoResolve: boolean | null;
  autoFix: boolean | null;
  maxLevel: string | null;
  securityOnly: boolean | null;
  ecosystems: string[] | null;
};

function settingsOf(row: SettingsRow): DependencyAutomationSettings {
  return {
    autoMerge: row.autoMerge === true,
    autoApprove: row.autoApprove === true,
    autoResolveConflicts: row.autoResolve === true,
    autoFix: row.autoFix === true,
    policy: policyFromColumns(row),
  };
}

/** null = no such workspace on this account. */
export async function getDependencyAutomationSettings(
  accountId: number,
  workspaceId: number,
): Promise<DependencyAutomationSettings | null> {
  const row = (
    await db
      .select(settingsColumns)
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  return row ? settingsOf(row as SettingsRow) : null;
}

/** The workspace's dependency bots — STORED rows, automated with role `dependency`. */
export async function listDependencyBots(accountId: number, workspaceId: number): Promise<DependencyBot[]> {
  const rows = await db
    .select({
      userId: workspaceReviewers.authorUserId,
      login: users.githubLogin,
      kind: workspaceReviewers.kind,
      label: workspaceReviewers.label,
      trusted: workspaceReviewers.dependencyTrusted,
    })
    .from(workspaceReviewers)
    .innerJoin(users, eq(users.id, workspaceReviewers.authorUserId))
    .where(
      and(
        eq(workspaceReviewers.accountId, accountId),
        eq(workspaceReviewers.workspaceId, workspaceId),
        eq(workspaceReviewers.automated, true),
        eq(workspaceReviewers.role, 'dependency'),
      ),
    )
    .orderBy(users.githubLogin)
    .execute();
  return rows.map((r) => ({
    userId: r.userId,
    login: r.login,
    kind: r.kind ?? null,
    label: r.label ?? null,
    trusted: r.trusted === true,
    canRebase: botCanRebase(r.kind ?? null),
  }));
}

export async function getDependencyAutomation(
  accountId: number,
  workspaceId: number,
): Promise<WorkspaceDependencyAutomationResponse | null> {
  const settings = await getDependencyAutomationSettings(accountId, workspaceId);
  if (!settings) return null;
  return { workspaceId, settings, bots: await listDependencyBots(accountId, workspaceId) };
}

/**
 * THE ONE WRITER of the panel. Only what the patch names changes. `autoMerge` goes through the
 * older setting's own writer (it records its own history line). `trustedBotIds` is the FULL trusted
 * set among the workspace's dependency bots: listed ones become trusted, the rest untrusted; an id
 * that is not one of them is ignored. false = no such workspace.
 */
export async function setDependencyAutomation(
  accountId: number,
  workspaceId: number,
  patch: DependencyAutomationPatch,
): Promise<boolean> {
  const before = await getDependencyAutomationSettings(accountId, workspaceId);
  if (!before) return false;
  if (patch.autoMerge !== undefined) {
    if (!(await setDependencyAutoMerge(accountId, workspaceId, patch.autoMerge))) return false;
  }
  const set: Partial<typeof workspaces.$inferInsert> = {};
  if (patch.autoApprove !== undefined) set.dependencyAutoApprove = patch.autoApprove ? true : null;
  if (patch.autoResolveConflicts !== undefined) {
    set.dependencyAutoResolve = patch.autoResolveConflicts ? true : null;
  }
  if (patch.autoFix !== undefined) set.dependencyAutoFix = patch.autoFix ? true : null;
  if (patch.maxLevel !== undefined) {
    set.dependencyMaxLevel = patch.maxLevel === DEFAULT_DEPENDENCY_POLICY.maxLevel ? null : patch.maxLevel;
  }
  if (patch.securityOnly !== undefined) set.dependencySecurityOnly = patch.securityOnly ? true : null;
  if (patch.ecosystems !== undefined) {
    set.dependencyEcosystems = patch.ecosystems == null ? null : [...new Set(patch.ecosystems)].sort();
  }
  if (Object.keys(set).length > 0) {
    await db
      .update(workspaces)
      .set(set)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
      .execute();
  }
  if (patch.trustedBotIds !== undefined) {
    const bots = await listDependencyBots(accountId, workspaceId);
    const want = new Set(patch.trustedBotIds);
    for (const b of bots) {
      const trusted = want.has(b.userId);
      if (trusted === b.trusted) continue;
      await db
        .update(workspaceReviewers)
        .set({ dependencyTrusted: trusted ? true : null })
        .where(
          and(
            eq(workspaceReviewers.accountId, accountId),
            eq(workspaceReviewers.workspaceId, workspaceId),
            eq(workspaceReviewers.authorUserId, b.userId),
          ),
        )
        .execute();
    }
  }
  // Chronology's settings history: only a real change is recorded.
  const lines: string[] = [];
  if (patch.autoApprove !== undefined && patch.autoApprove !== before.autoApprove) {
    lines.push(`Dependency approvals ${onOff(patch.autoApprove)}`);
  }
  if (patch.autoResolveConflicts !== undefined && patch.autoResolveConflicts !== before.autoResolveConflicts) {
    lines.push(`Dependency conflict resolution ${onOff(patch.autoResolveConflicts)}`);
  }
  if (patch.autoFix !== undefined && patch.autoFix !== before.autoFix) {
    lines.push(`Dependency AI fixes ${onOff(patch.autoFix)}`);
  }
  for (const line of lines) {
    await recordWorkspaceSettingEvent(accountId, workspaceId, 'dependency_automation', line);
  }
  return true;
}


// ── The log ──────────────────────────────────────────────────────────────────────────────────

/** What the automation did in the workspace's repos, newest first (DB only). */
export async function listDependencyAutomationLog(
  accountId: number,
  repoIds: number[],
  now: Date = new Date(),
): Promise<DependencyAutomationLogItem[]> {
  if (repoIds.length === 0) return [];
  const since = new Date(now.getTime() - LOG_DAYS * 86_400_000);
  const rows = await db
    .select({
      id: daa.id,
      prId: daa.prId,
      action: daa.action,
      state: daa.state,
      detail: daa.detail,
      teammateLogin: daa.teammateLogin,
      teammateHandled: daa.teammateHandled,
      updatedAt: daa.updatedAt,
      owner: repos.owner,
      name: repos.name,
      number: pullRequests.number,
      title: pullRequests.title,
    })
    .from(daa)
    .innerJoin(pullRequests, and(eq(pullRequests.id, daa.prId), eq(pullRequests.accountId, accountId)))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(daa.accountId, accountId),
        eq(repos.accountId, accountId),
        inArray(pullRequests.repoId, repoIds),
        gte(daa.updatedAt, since),
      ),
    )
    .orderBy(desc(daa.updatedAt), desc(daa.id))
    .limit(LOG_MAX)
    .execute();
  // A skipped row names the teammate whose Limn holds the head; their name from the synced users.
  const logins = [...new Set(rows.map((r) => r.teammateLogin).filter((l): l is string => l != null))];
  const names = new Map<string, string | null>();
  if (logins.length > 0) {
    const us = await db
      .select({ login: users.githubLogin, name: users.displayName })
      .from(users)
      .where(inArray(sql`lower(${users.githubLogin})`, logins.map((l) => l.toLowerCase())))
      .execute();
    for (const u of us) names.set(u.login.toLowerCase(), u.name ?? null);
  }
  return rows.map((r) => ({
    id: r.id,
    prId: r.prId,
    repoFullName: `${r.owner}/${r.name}`,
    prNumber: r.number,
    prTitle: r.title,
    action: r.action as DependencyAutomationActionKind,
    state: r.state as DependencyAutomationActionState,
    detail: r.detail ?? null,
    teammate:
      r.state === 'skipped' && r.teammateLogin
        ? {
            login: r.teammateLogin,
            name: names.get(r.teammateLogin.toLowerCase()) ?? null,
            handled: r.teammateHandled === true,
          }
        : null,
    at: r.updatedAt.toISOString(),
  }));
}

// ── Claims ───────────────────────────────────────────────────────────────────────────────────

/**
 * Claim one action at one head. The row id, or null when it was already taken (by anyone, ever). A
 * `skipped` row (a teammate held the head) is not an attempt: a later claim TAKES IT OVER (and an
 * `arm_merge` row that is not running, below).
 */
export async function claimAction(
  accountId: number,
  prId: number,
  headSha: string,
  action: DependencyAutomationActionKind,
): Promise<number | null> {
  const now = new Date();
  const rows = await db
    .insert(daa)
    .values({ accountId, prId, headSha, action, state: 'running' })
    .onConflictDoUpdate({
      target: [daa.accountId, daa.prId, daa.headSha, daa.action],
      set: {
        state: 'running',
        detail: null,
        resultSha: null,
        teammateLogin: null,
        teammateHandled: null,
        createdAt: now,
        updatedAt: now,
      },
      // A merge ARM is local state, not a GitHub write: the sweep's own `due` rule (no live intent,
      // never the head an intent ENDED on) decides when it may arm again, so only a running arm
      // blocks it. Every other action: only a skip is taken over — done or failed is for ever.
      setWhere: action === 'arm_merge' ? ne(daa.state, 'running') : eq(daa.state, 'skipped'),
    })
    .returning({ id: daa.id })
    .execute();
  return rows[0]?.id ?? null;
}

async function settleAction(
  id: number,
  state: 'done' | 'failed',
  detail: string | null,
  resultSha: string | null = null,
): Promise<void> {
  await db
    .update(daa)
    .set({ state, detail: detail?.slice(0, 300) ?? null, resultSha, updatedAt: new Date() })
    .where(eq(daa.id, id))
    .execute();
}

/** Undo a claim that never wrote anything (the AI could not start). */
async function releaseClaim(id: number): Promise<void> {
  await db.delete(daa).where(and(eq(daa.id, id), eq(daa.state, 'running'))).execute();
}

/** The log's words for a teammate's hold. */
function holdDetail(hold: DepsHold): string {
  return hold.kind === 'handling' ? `${hold.login} is handling this` : `${hold.login} handled this`;
}

/**
 * A teammate's Limn holds this head (`limn/deps`): record it as SKIPPED — never a failure, never an
 * attempt. Written once per (PR, head, action) and refreshed only when the teammate or the kind of
 * hold changes, so the log does not churn. A real row (running / done / failed) is never touched.
 */
export async function recordTeammateSkip(
  accountId: number,
  prId: number,
  headSha: string,
  action: DependencyAutomationActionKind,
  hold: DepsHold,
): Promise<void> {
  const handled = hold.kind === 'handled';
  const now = new Date();
  await db
    .insert(daa)
    .values({
      accountId,
      prId,
      headSha,
      action,
      state: 'skipped',
      detail: holdDetail(hold),
      teammateLogin: hold.login,
      teammateHandled: handled,
    })
    .onConflictDoUpdate({
      target: [daa.accountId, daa.prId, daa.headSha, daa.action],
      set: { detail: holdDetail(hold), teammateLogin: hold.login, teammateHandled: handled, updatedAt: now },
      setWhere: and(
        eq(daa.state, 'skipped'),
        sql`(${daa.teammateLogin} IS NOT ${hold.login} OR ${daa.teammateHandled} IS NOT ${handled ? 1 : 0})`,
      ),
    })
    .execute();
}

/**
 * THE SANDBOX IS MISSING (AI Fix runs only as a sandboxed session): record the head as SKIPPED with the
 * reason and no teammate — BEFORE any claim, so nothing is written to GitHub and nothing counts toward
 * the AI-run cap (a skip is invisible to the sweep's steps). A later claim takes it over once a runtime
 * exists. Written once per (PR, head, action) and refreshed only when the sentence changes, so the log
 * does not churn; a teammate's skip and every real row are never touched.
 */
export async function recordSandboxSkip(
  accountId: number,
  prId: number,
  headSha: string,
  action: DependencyAutomationActionKind,
  detail: string,
): Promise<void> {
  const text = detail.slice(0, 300);
  await db
    .insert(daa)
    .values({ accountId, prId, headSha, action, state: 'skipped', detail: text })
    .onConflictDoUpdate({
      target: [daa.accountId, daa.prId, daa.headSha, daa.action],
      set: { detail: text, updatedAt: new Date() },
      setWhere: and(eq(daa.state, 'skipped'), isNull(daa.teammateLogin), sql`${daa.detail} IS NOT ${text}`),
    })
    .execute();
}

/** A claimed row lost the GitHub race after all: it becomes the teammate's skip. */
async function claimBecameSkip(id: number, hold: DepsHold): Promise<void> {
  await db
    .update(daa)
    .set({
      state: 'skipped',
      detail: holdDetail(hold),
      teammateLogin: hold.login,
      teammateHandled: hold.kind === 'handled',
      updatedAt: new Date(),
    })
    .where(and(eq(daa.id, id), eq(daa.state, 'running')))
    .execute();
}

const firstLine = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);

/** At boot: a row still `running` lost its process mid-action. Recorded as failed, never retried. */
export async function reconcileDependencyActionsOnStartup(): Promise<void> {
  await db
    .update(daa)
    .set({ state: 'failed', detail: 'Limn stopped before this finished.', updatedAt: new Date() })
    .where(eq(daa.state, 'running'))
    .execute();
}

/** The heads Limn's AI runs pushed (a conflict resolution or a CI fix) — each must be GREEN (not
 *  merely not red) before it is approved or armed. Keyed `${prId}:${sha}`. */
export async function aiPushedHeads(accountId: number, prIds: number[]): Promise<Set<string>> {
  if (prIds.length === 0) return new Set();
  const rows = await db
    .select({ prId: daa.prId, sha: daa.resultSha })
    .from(daa)
    .where(
      and(
        eq(daa.accountId, accountId),
        inArray(daa.prId, prIds),
        inArray(daa.action, ['ai_resolve', 'ai_fix']),
        eq(daa.state, 'done'),
      ),
    )
    .execute();
  return new Set(rows.filter((r) => r.sha != null).map((r) => `${r.prId}:${r.sha}`));
}

// ── One action's claim: the team line, then the DB row ──────────────────────────────────────

/** What every action carries into its claim. */
export interface ClaimCtx {
  /** The workspace's team-claims switch (`team_claims_enabled`, ON unless a stored false). */
  claimsOn: boolean;
  log: FastifyBaseLogger;
}

/** A claimed action: its DB row and its `limn/deps` line (unmarked when no line went up). */
export interface ActionClaim {
  id: number;
  line: DepsClaimHandle;
}

/**
 * CLAIM BEFORE WRITE, for teams: (1) read the head's `limn/deps` lines — a teammate holding it ⇒
 * a SKIPPED row ("Robin is handling this"), nothing else; (2) the DB claim (compare-and-set; null ⇒
 * done before, never again); (3) post our pending line and re-read — a teammate who won the race ⇒
 * our claim becomes their skip. null ⇒ do nothing. Never throws for GitHub (it acts unmarked).
 */
export async function beginDependencyAction(
  c: ClaimCtx,
  pr: { id: number; accountId: number; owner: string; name: string; headSha: string },
  action: ClaimAction,
  now: number = Date.now(),
  opts: { ciGreen?: boolean } = {},
): Promise<ActionClaim | null> {
  if (depsHeldNow(pr.accountId, pr.id, pr.headSha, familyOfAction(action), now)) return null;
  const target = { accountId: pr.accountId, prId: pr.id, owner: pr.owner, name: pr.name, headSha: pr.headSha, action };
  const read = await readDepsClaim(target, c.claimsOn, c.log, now, opts);
  if (read.awaitingCi) {
    // An AI-pushed head (any machine's) whose CI is not green: not armed yet, no skip row.
    rememberDepsAwaitingCi(target, now);
    return null;
  }
  if (read.hold) {
    rememberDepsHold(target, read.hold, now);
    await recordTeammateSkip(pr.accountId, pr.id, pr.headSha, action, read.hold);
    c.log.info({ prId: pr.id, action, teammate: read.hold.login }, 'dependency automation: a teammate holds this PR');
    return null;
  }
  const id = await claimAction(pr.accountId, pr.id, pr.headSha, action);
  if (id == null) return null;
  const posted = await postDepsClaim(read.login, target, c.log);
  if (posted.hold) {
    rememberDepsHold(target, posted.hold);
    await claimBecameSkip(id, posted.hold);
    return null;
  }
  return { id, line: posted.handle };
}

/** Settle the DB row and post the final line together. Never throws. */
async function finishAction(
  claim: ActionClaim,
  state: 'done' | 'failed',
  detail: string | null,
  log: FastifyBaseLogger,
  resultSha: string | null = null,
): Promise<void> {
  await settleAction(claim.id, state, detail, resultSha).catch((err) =>
    log.warn({ err, claimId: claim.id }, 'dependency automation: could not record the outcome'),
  );
  const end: DepsClaimEnd = state === 'done' ? { outcome: 'done', pushedSha: resultSha } : { outcome: 'failed' };
  await endDepsClaim(claim.line, end, log);
  // The pushed commit carries its own line, so EVERY machine waits for its CI before arming it.
  if (state === 'done' && resultSha != null) await markAiPushedHead(claim.line, resultSha, log);
}

/** For the merge sweep (dependency-policy.ts): the arm's outcome, recorded with its line. */
export async function finishDependencyAction(
  claim: ActionClaim,
  state: 'done' | 'failed',
  detail: string | null,
  log: FastifyBaseLogger,
): Promise<void> {
  await finishAction(claim, state, detail, log);
}

/** For the merge sweep: nothing was armed — the claim is given back. */
export async function giveBackDependencyAction(claim: ActionClaim, why: string, log: FastifyBaseLogger): Promise<void> {
  await giveBack(claim, why, log);
}

/** Give the claim back: nothing was written. The row goes, and the line says it is free. */
async function giveBack(claim: ActionClaim, why: string, log: FastifyBaseLogger): Promise<void> {
  await releaseClaim(claim.id).catch(() => {});
  await endDepsClaim(claim.line, { outcome: 'released', why }, log);
}

/**
 * THE MERGE LANDED (the auto-merge watcher's 'merged' outcome — GitHub accepted the merge, or the
 * queue merged OUR entry — never inferred from arming): record it for a POLICY intent, so the log
 * says "Merged". Idempotent per (PR, head). Never throws.
 */
export async function recordDependencyMergeLanded(accountId: number, prId: number, headSha: string): Promise<void> {
  try {
    await db
      .insert(daa)
      .values({ accountId, prId, headSha, action: 'merge_landed', state: 'done', detail: null })
      .onConflictDoNothing({ target: [daa.accountId, daa.prId, daa.headSha, daa.action] })
      .execute();
  } catch {
    /* the log is a record, never a reason to fail a landing */
  }
}

// ── The policy, applied ──────────────────────────────────────────────────────────────────────

export interface PrPolicyFacts {
  id: number;
  title: string;
  body: string | null;
  headRefName: string | null;
  headSha: string | null;
  labels: string[];
  filePaths: string[];
  securityFix: boolean;
}

/** The synced facts the policy reads, per PR. */
export async function prPolicyFacts(accountId: number, prIds: number[]): Promise<Map<number, PrPolicyFacts>> {
  if (prIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: pullRequests.id,
      title: pullRequests.title,
      body: pullRequests.body,
      headRefName: pullRequests.headRefName,
      headSha: pullRequests.headSha,
      labels: pullRequests.labels,
      files: pullRequests.files,
      securityFix: pullRequests.securityFix,
    })
    .from(pullRequests)
    .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, prIds)))
    .execute();
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        title: r.title,
        body: r.body ?? null,
        headRefName: r.headRefName ?? null,
        headSha: r.headSha ?? null,
        labels: (r.labels ?? []).map((l) => l.name),
        filePaths: (r.files ?? []).map((f) => f.path),
        securityFix: r.securityFix != null,
      },
    ]),
  );
}

/** Live reads of a PR's title + body, per (PR, head) — the size of an update never changes at one
 *  head, so a refused PR is not re-read every two minutes. Process-local and bounded. */
const liveClassCache = new Map<string, DependencyUpdateClass>();
const LIVE_CACHE_MAX = 500;

function classifyFrom(f: PrPolicyFacts, live: PrAutomationSnapshot | null): DependencyUpdateClass {
  return classifyDependencyUpdate({
    title: live?.title ?? f.title,
    body: live?.body ?? f.body,
    headRefName: live?.headRef ?? f.headRefName,
    labels: live?.labels ?? f.labels,
    filePaths: f.filePaths,
  });
}

export type PolicyAdmission =
  | { ok: true }
  /** `final`: no live read could change the answer (the refusal is not an unread size, or the
   *  size was already read live at this head). */
  | { ok: false; refusal: PolicyRefusal; final: boolean };

/**
 * Does the workspace's policy admit this PR? With `live` (a snapshot the caller already read), it
 * classifies from that and remembers it for the head. Otherwise synced facts first; when only the
 * SIZE is missing and the policy needs it, ONE live read (remembered per head) — `token` null means
 * "synced facts only". The merge sweep and this file's tick share it.
 */
export async function policyAdmits(
  policy: DependencyAutomationPolicy,
  f: PrPolicyFacts,
  pr: { owner: string; name: string; number: number },
  opts: { token?: string | null; live?: PrAutomationSnapshot | null } = {},
): Promise<PolicyAdmission> {
  const key = `${f.id}:${f.headSha ?? ''}`;
  const remember = (cls: DependencyUpdateClass): void => {
    if (liveClassCache.size >= LIVE_CACHE_MAX) liveClassCache.clear();
    liveClassCache.set(key, cls);
  };
  const verdict = (cls: DependencyUpdateClass, read: boolean): PolicyAdmission => {
    const v = policyVerdict(policy, cls, f.securityFix);
    if (v.ok) return { ok: true };
    return { ok: false, refusal: v.refusal, final: read || v.refusal !== 'size_unknown' || !policyNeedsLevel(policy) };
  };
  if (opts.live) {
    const cls = classifyFrom(f, opts.live);
    remember(cls);
    return verdict(cls, true);
  }
  const cached = liveClassCache.get(key);
  const first = verdict(cached ?? classifyFrom(f, null), cached != null);
  if (first.ok || first.final || !opts.token) return first;
  try {
    const snap = await fetchPrForAutomation(opts.token, pr.owner, pr.name, pr.number);
    const cls = classifyFrom(f, snap);
    remember(cls);
    return verdict(cls, true);
  } catch {
    return first; // unreadable now: refused this tick, asked again next
  }
}

// ── The AI context (bound at boot where agentic AI runs) ────────────────────────────────────

let aiCtx: AgentContext | null = null;

/** Called by `startAgenticBackground` (review/agentic.ts): without it no AI run (conflicts or CI
 *  fixes) ever starts. */
export function bindDependencyAutomationAi(ctx: AgentContext): void {
  aiCtx = ctx;
}

/** AI runs this process is watching, by PR id (a conflict run or a CI fix). */
const aiWatching = new Set<number>();

// ── The tick ─────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  id: number;
  accountId: number;
  repoId: number;
  owner: string;
  name: string;
  number: number;
  title: string;
  isDraft: boolean;
  headSha: string;
  ciStatus: string | null;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  mergeable: string | null;
  inMergeQueue: boolean | null;
  viewerPermission: string | null;
  authorId: number;
}

let ticking = false;

/**
 * Approve, resolve conflicts and fix CI on the trusted dependency bots' PRs of every workspace with
 * any of those switches on. Runs on the auto-merge watcher's cron, before the merge sweep (an
 * approval may be what lets that PR land). Bounded (`ACTIONS_PER_TICK`), per-workspace try/catch,
 * never throws.
 */
export async function runDependencyAutomationTick(log: FastifyBaseLogger, now: number = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  const budget = { left: ACTIONS_PER_TICK };
  try {
    const roster = await db
      .select({
        accountId: workspaces.accountId,
        workspaceId: workspaces.id,
        teamClaims: workspaces.teamClaimsEnabled,
        ...settingsColumns,
      })
      .from(workspaces)
      .execute();
    for (const ws of roster) {
      if (budget.left <= 0) break;
      const settings = settingsOf(ws as SettingsRow);
      if (!settings.autoApprove && !settings.autoResolveConflicts && !settings.autoFix) continue;
      try {
        const c: ClaimCtx = { claimsOn: ws.teamClaims !== false, log };
        await tickWorkspace(ws.accountId, ws.workspaceId, settings, budget, c, now);
      } catch (err) {
        log.warn({ err, accountId: ws.accountId, workspaceId: ws.workspaceId }, 'dependency automation: workspace failed');
      }
    }
  } catch (err) {
    log.error({ err }, 'dependency automation tick failed');
  } finally {
    ticking = false;
  }
}

async function tickWorkspace(
  accountId: number,
  workspaceId: number,
  settings: DependencyAutomationSettings,
  budget: { left: number },
  c: ClaimCtx,
  now: number,
): Promise<void> {
  const log = c.log;
  // WHO: the TRUSTED bots' stored rows. No trusted bot → nothing to do, no PR read at all.
  const botRows = await db
    .select({
      userId: workspaceReviewers.authorUserId,
      automated: workspaceReviewers.automated,
      role: workspaceReviewers.role,
      trusted: workspaceReviewers.dependencyTrusted,
      kind: workspaceReviewers.kind,
    })
    .from(workspaceReviewers)
    .where(and(eq(workspaceReviewers.accountId, accountId), eq(workspaceReviewers.workspaceId, workspaceId)))
    .execute();
  const trusted = new Map(
    botRows
      .filter((r) => isTrustedDependencyBot({ automated: r.automated, role: r.role, trusted: r.trusted ?? null }))
      .map((r) => [r.userId, r.kind ?? null]),
  );
  if (trusted.size === 0) return;
  const repoIds = await getWorkspaceRepoIds(workspaceId, accountId);
  if (repoIds.length === 0) return;

  const rows = await db
    .select({
      id: pullRequests.id,
      repoId: pullRequests.repoId,
      owner: repos.owner,
      name: repos.name,
      number: pullRequests.number,
      title: pullRequests.title,
      isDraft: pullRequests.isDraft,
      headSha: pullRequests.headSha,
      ciStatus: pullRequests.ciStatus,
      reviewDecision: pullRequests.reviewDecision,
      mergeStateStatus: pullRequests.mergeStateStatus,
      mergeable: pullRequests.mergeable,
      inMergeQueue: pullRequests.inMergeQueue,
      viewerPermission: repos.viewerPermission,
      authorId: pullRequests.authorId,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(repos.accountId, accountId),
        inArray(pullRequests.repoId, repoIds),
        eq(pullRequests.state, 'open'),
        inArray(pullRequests.authorId, [...trusted.keys()]),
      ),
    )
    .execute();
  const prs = rows
    .filter(
      (r): r is typeof r & { headSha: string; authorId: number } =>
        r.headSha != null && r.authorId != null && !r.isDraft && WRITE_PERMISSIONS.has(r.viewerPermission ?? ''),
    )
    .map((r) => ({ ...r, accountId })) as Candidate[];
  if (prs.length === 0) return;
  const ids = prs.map((p) => p.id);
  const [skipRows, actionRows, facts, sandboxSkipRows] = await Promise.all([
    db
      .select({ prId: autoMergePolicySkips.prId })
      .from(autoMergePolicySkips)
      .where(and(eq(autoMergePolicySkips.accountId, accountId), inArray(autoMergePolicySkips.prId, ids)))
      .execute(),
    db
      .select({ prId: daa.prId, headSha: daa.headSha, action: daa.action, state: daa.state, createdAt: daa.createdAt })
      .from(daa)
      // A SKIPPED row (a teammate held the head) is not an attempt: invisible to every step below.
      .where(and(eq(daa.accountId, accountId), inArray(daa.prId, ids), ne(daa.state, 'skipped')))
      .execute(),
    prPolicyFacts(accountId, ids),
    // The heads already recorded as "no container runtime" (`recordSandboxSkip`: no teammate), for the
    // CI fix and the conflict run alike (both are AI Fix sessions).
    db
      .select({ prId: daa.prId, headSha: daa.headSha, action: daa.action })
      .from(daa)
      .where(
        and(
          eq(daa.accountId, accountId),
          inArray(daa.prId, ids),
          inArray(daa.action, ['ai_fix', 'ai_resolve']),
          eq(daa.state, 'skipped'),
          isNull(daa.teammateLogin),
        ),
      )
      .execute(),
  ]);
  const cancelled = new Set(skipRows.map((r) => r.prId));
  const sandboxSkipped = new Set(sandboxSkipRows.map((r) => `${r.prId}:${r.headSha}:${r.action}`));
  const actionAt = (prId: number, head: string, action: DependencyAutomationActionKind) =>
    actionRows.find((a) => a.prId === prId && a.headSha === head && a.action === action) ?? null;
  // THE AI-RUN CAP: CI fixes and conflict runs together, per PR, rolling 24 hours.
  const aiRunsInWindow = (prId: number): number =>
    actionRows.filter(
      (a) => a.prId === prId && (a.action === 'ai_fix' || a.action === 'ai_resolve') && a.createdAt.getTime() >= now - AI_RUN_WINDOW_MS,
    ).length;
  // "Fix with AI" covers conflicts too — through the SAME conflict steps, never a second path.
  // Only while the AI can run: a stored "Fix them with AI" whose switch is hidden (AI off) must not
  // keep asking bots to rebase with "Resolve their conflicts" off.
  const conflictsOn = settings.autoResolveConflicts || (settings.autoFix && aiCtx != null);

  let token: string | null = null;
  const viewerUserId = await getAccountUserId(accountId);

  for (const pr of prs) {
    if (budget.left <= 0) return;
    if (cancelled.has(pr.id)) continue; // a person's cancel wins, for every switch
    // A teammate's Limn holds this head (remembered): no GitHub read until it can have changed.
    if (depsHeldNow(accountId, pr.id, pr.headSha, null, now)) continue;
    const f = facts.get(pr.id);
    if (!f) continue;
    const conflicting = isConflicting(pr);
    const kind = trusted.get(pr.authorId) ?? null;

    if (conflicting) {
      if (!conflictsOn) continue;
      const rebase = actionAt(pr.id, pr.headSha, 'rebase_request');
      const ai = actionAt(pr.id, pr.headSha, 'ai_resolve');
      const step = conflictStep(
        {
          rebase: rebase ? { state: rebase.state as 'running' | 'done' | 'failed', at: rebase.createdAt.getTime() } : null,
          ai: ai ? { state: ai.state as 'running' | 'done' | 'failed' } : null,
        },
        botCanRebase(kind),
        now,
      );
      if (step === 'none' || step === 'wait') continue;
      const aiBlocked =
        aiCtx == null ||
        aiWatching.has(pr.id) ||
        aiRunsInWindow(pr.id) >= DEPENDENCY_AI_FIX_DAILY_CAP ||
        (await aiFixDeps.isFixRunning(pr.id).catch(() => true));
      if (step === 'ai' && aiBlocked) continue;
      if (step === 'ai') {
        // THE SANDBOX first, as for the CI fix: busy ⇒ a later tick; no runtime already recorded at this
        // head ⇒ nothing more to say (no GitHub read).
        const sandbox = await aiFixDeps.sandbox(aiCtx!).catch(() => ({ ok: true as const }));
        if (!sandbox.ok && (sandbox.reason === 'busy' || sandboxSkipped.has(`${pr.id}:${pr.headSha}:ai_resolve`))) continue;
      }
      // A teammate's remembered hold on this action costs no GitHub read and no budget.
      if (depsHeldNow(accountId, pr.id, pr.headSha, 'conflicts', now)) continue;
      token ??= await getAccessToken(accountId);
      const live = await fetchPrForAutomation(token, pr.owner, pr.name, pr.number).catch(() => null);
      if (!live || live.state !== 'open' || live.isDraft || live.headSha !== pr.headSha || live.isFork) continue;
      if (!(await policyAdmits(settings.policy, f, pr, { live })).ok) continue;
      budget.left -= 1;
      if (step === 'ask_bot') {
        const req = rebaseRequestFor(kind, live.body);
        if (req) {
          await askBotToRebase(c, pr, kind, req, token, viewerUserId);
          continue;
        }
        // Renovate without its checkbox: nothing to ask — straight to the AI, if it can run.
        if (aiBlocked) continue;
      }
      // Red too, and "Fix them with AI" on: the CI review's fixable items ride in the SAME session.
      const withCi = settings.autoFix && (pr.ciStatus === 'failure' || pr.ciStatus === 'error');
      await startAiConflictFix(aiCtx!, c, pr, kind, live.baseRef, withCi);
      continue;
    }

    // ── FIX CI WITH AI ──
    const red = pr.ciStatus === 'failure' || pr.ciStatus === 'error';
    if (red) {
      const ok = aiFixEligibility(
        {
          settingOn: settings.autoFix,
          trusted: true, // the PR list is the trusted bots' PRs only
          cancelled: false, // checked above
          aiAvailable: aiCtx != null,
          ciStatus: pr.ciStatus,
          conflicting,
          triedAtHead: actionAt(pr.id, pr.headSha, 'ai_fix') != null,
          aiRunsInWindow: aiRunsInWindow(pr.id),
          fixRunning: aiWatching.has(pr.id) || (aiCtx != null && (await aiFixDeps.isFixRunning(pr.id))),
        },
        DEPENDENCY_AI_FIX_DAILY_CAP,
      );
      if (!ok.ok) continue;
      if (depsHeldNow(accountId, pr.id, pr.headSha, 'ai_fix', now)) continue;
      // THE SANDBOX (AI Fix runs only there), before any GitHub read: a busy computer waits for a later
      // tick with nothing written; no runtime at a head ALREADY recorded as such costs nothing more. A
      // new head with no runtime goes on, so its live failure is proven before the skip is recorded.
      const sandbox = await aiFixDeps.sandbox(aiCtx!).catch(() => ({ ok: true as const }));
      if (!sandbox.ok && (sandbox.reason === 'busy' || sandboxSkipped.has(`${pr.id}:${pr.headSha}:ai_fix`))) continue;
      token ??= await getAccessToken(accountId);
      const live = await fetchPrForAutomation(token, pr.owner, pr.name, pr.number).catch(() => null);
      if (!live || live.state !== 'open' || live.isDraft || live.headSha !== pr.headSha || live.isFork) continue;
      if (!(await policyAdmits(settings.policy, f, pr, { live })).ok) continue;
      budget.left -= 1;
      await startAiFix(aiCtx!, c, pr, kind);
      continue;
    }

    // ── APPROVE ──
    if (!settings.autoApprove) continue;
    if (pr.reviewDecision === 'approved') continue;
    if (pr.ciStatus !== 'success') continue; // green, not merely not red (pushed heads included)
    if (viewerUserId == null || viewerUserId === pr.authorId) continue;
    if (actionAt(pr.id, pr.headSha, 'approve')) continue;
    if (depsHeldNow(accountId, pr.id, pr.headSha, 'approve', now)) continue;
    // Synced facts first: a PR the policy refuses on what we already know costs no GitHub call.
    const synced = await policyAdmits(settings.policy, f, pr);
    if (!synced.ok && synced.final) continue;
    token ??= await getAccessToken(accountId);
    // The live re-read the approval needs anyway: the head it pins, fork-ness, title + body.
    const live = await fetchPrForAutomation(token, pr.owner, pr.name, pr.number).catch(() => null);
    if (!live || live.state !== 'open' || live.isDraft || live.headSha !== pr.headSha || live.isFork) continue;
    if (!(await policyAdmits(settings.policy, f, pr, { live })).ok) continue;
    budget.left -= 1;
    await approve(c, pr, viewerUserId, classifyFrom(f, live), f.securityFix, token);
  }
}

function updateWords(cls: DependencyUpdateClass, securityFix: boolean): string {
  const size = cls.level ? `${cls.level} ` : '';
  return securityFix ? `a ${size}security fix` : `a ${size}dependency update`;
}

async function approve(
  c: ClaimCtx,
  pr: Candidate,
  viewerUserId: number,
  cls: DependencyUpdateClass,
  securityFix: boolean,
  token: string,
): Promise<void> {
  const { log } = c;
  const claim = await beginDependencyAction(c, pr, 'approve');
  if (claim == null) return;
  let gh: Awaited<ReturnType<typeof submitPrReview>>;
  try {
    gh = await submitPrReview(token, pr.owner, pr.name, pr.number, {
      event: 'APPROVE',
      // Pinned to the head we checked: a push since makes GitHub refuse it.
      commitId: pr.headSha,
      body: `Approved automatically: ${updateWords(cls, securityFix)} from a trusted bot, with CI green.\n\n${LIMN_MARKER}`,
    });
  } catch (err) {
    await finishAction(claim, 'failed', firstLine(err), log);
    log.warn({ err, prId: pr.id }, 'dependency automation: approval failed');
    return;
  }
  // "Approved" is recorded only now: GitHub ACCEPTED the review.
  await finishAction(claim, 'done', updateWords(cls, securityFix), log);
  try {
    // STAMP, then SETTLE, then CASCADE — the approve route's own tail.
    await upsertLocalReview(pr.id, viewerUserId, gh);
    await clearOwnReviewRequest(pr.id, pr.accountId, viewerUserId);
    await resyncPrAfterWrite({ prId: pr.id, accountId: pr.accountId, log });
    schedulePrSettle(pr.accountId, pr.id, asSyncLogger(log), { mergeStateNot: 'blocked' });
    await notePrChangedForPr(pr.accountId, pr.id);
  } catch (err) {
    log.warn({ err, prId: pr.id }, 'dependency automation: approved; the local stamp failed');
  }
  log.info({ prId: pr.id, repo: `${pr.owner}/${pr.name}`, number: pr.number }, 'dependency automation: approved');
}

async function askBotToRebase(
  c: ClaimCtx,
  pr: Candidate,
  kind: string | null,
  req: NonNullable<ReturnType<typeof rebaseRequestFor>>,
  token: string,
  viewerUserId: number | null,
): Promise<void> {
  const { log } = c;
  const claim = await beginDependencyAction(c, pr, 'rebase_request');
  if (claim == null) return;
  const bot = BOT_BRAND[kind ?? ''] ?? 'the bot';
  try {
    if (req.method === 'comment') {
      const gh = await addIssueComment(token, pr.owner, pr.name, pr.number, req.body);
      await finishAction(claim, 'done', `Asked ${bot} to rebase`, log);
      await upsertLocalPrComment(pr.id, viewerUserId, gh);
    } else {
      const out = await updatePullRequestBody(token, pr.owner, pr.name, pr.number, req.body);
      if (!out.ok) {
        await finishAction(claim, 'failed', out.message, log);
        return;
      }
      await finishAction(claim, 'done', `Asked ${bot} to rebase`, log);
      await resyncPrAfterWrite({ prId: pr.id, accountId: pr.accountId, log });
    }
    await notePrChangedForPr(pr.accountId, pr.id);
  } catch (err) {
    // A throw AFTER the write was recorded leaves the row 'done' (settleAction only touches its row).
    const row = (await db.select({ state: daa.state }).from(daa).where(eq(daa.id, claim.id)).limit(1).execute())[0];
    if (row?.state === 'running') await finishAction(claim, 'failed', firstLine(err), log);
    log.warn({ err, prId: pr.id }, 'dependency automation: rebase request failed');
  }
}

/**
 * THE CONFLICT RUN: an UNATTENDED AI Fix session with the MERGE item (`resolveConflicts`): the spend gate
 * first (over ⇒ skipped, never queued), then THE SANDBOX (no container runtime ⇒ one `skipped` row,
 * `recordSandboxSkip`, no claim and no GitHub write; busy ⇒ nothing), then the claim (DB + `limn/deps`),
 * then the session: the agent merges the base and resolves in the sandbox, the host checks the merge
 * commit, and AI Fix's own Push sends it onto the bot's branch (`watchFixAndPush`). A merge that fails
 * Limn's check pushes nothing and is recorded as failed. Never retried at a head; a person's cancel wins.
 * `withCi` (the PR is red too and "Fix them with AI" is on): the SAME session also gets the CI review's
 * fixable items at this head — the merge first, the CI fixes on top, ONE run, ONE row.
 * ⚠ NEVER WHILE A READER HAS THE MANUAL RESOLVER OPEN on the PR (its session has a watcher or is
 * committing): their decisions are theirs to land. Skipped without a claim; a later tick looks again.
 */
async function startAiConflictFix(
  ctx: AgentContext,
  c: ClaimCtx,
  pr: Candidate,
  kind: string | null,
  baseRef: string,
  withCi = false,
): Promise<void> {
  const { log } = c;
  const deps = aiFixDeps;
  if (!(await deps.allowed(ctx, pr.accountId))) return;
  const { peekSession } = await import('../conflict/session.js');
  const open = peekSession(pr.accountId, pr.id);
  if (open != null && (open.commitRunning || open.subscribers.size > 0)) return;
  const sandbox = await deps.sandbox(ctx).catch(() => ({ ok: true as const }));
  if (!sandbox.ok) {
    if (sandbox.reason === 'no_runtime') {
      await recordSandboxSkip(pr.accountId, pr.id, pr.headSha, 'ai_resolve', NO_SANDBOX_DETAIL).catch((err) =>
        log.warn({ err, prId: pr.id }, 'dependency automation: could not record the sandbox skip'),
      );
      log.info({ prId: pr.id }, 'dependency automation: conflict run skipped, no container runtime');
    }
    return;
  }
  const claim = await beginDependencyAction(c, pr, 'ai_resolve');
  if (claim == null) return;
  const bot = BOT_BRAND[kind ?? ''] ?? 'a dependency bot';
  const start = (combined: boolean) =>
    deps
      .startFix(ctx, {
        accountId: pr.accountId,
        prId: pr.id,
        instruction: combined ? dependencyMergeAndCiPreamble({ bot, baseRef }) : dependencyConflictInstruction({ title: pr.title, bot, baseRef }),
        resolveConflicts: true,
        ...(combined ? { withCi: true } : {}),
      })
      .catch((err) => {
        log.warn({ err, prId: pr.id }, 'dependency automation: the conflict run did not start');
        return null;
      });
  let res = await start(withCi);
  // The combined seed had no MERGE item (AI Fix's own merge gate disagreed with the synced facts): the plain
  // merge-only run, under the SAME claim, so the tick never claims and gives back at every pass.
  if (withCi && res?.status === 'nothing_to_fix') res = await start(false);
  if (res == null || res.status !== 'queued' || res.fixId == null) {
    if (res?.status === 'no_auth') await finishAction(claim, 'failed', 'No AI sign-in.', log);
    else {
      // Nothing was written and no model ran: give the claim back so a later tick may try.
      await giveBack(claim, "didn't start", log);
      if (res?.status === 'no_runtime') await recordSandboxSkip(pr.accountId, pr.id, pr.headSha, 'ai_resolve', NO_SANDBOX_DETAIL).catch(() => {});
    }
    return;
  }
  renewDepsClaim(claim.line, log);
  aiWatching.add(pr.id);
  void watchFixAndPush(ctx, claim, pr, res.fixId, deps, log, 'conflicts').finally(() => aiWatching.delete(pr.id));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── FIX CI WITH AI ───────────────────────────────────────────────────────────────────────────

/** The log's sentence for a head skipped because this computer has no container runtime. */
export const NO_SANDBOX_DETAIL = 'No container runtime on this computer.';

/** The seams the AI fix uses — replaceable in tests. */
export interface AiFixDeps {
  allowed: (ctx: AgentContext, accountId: number) => Promise<boolean>;
  /** The head's failing checks, read LIVE, with log excerpts. null = not proven failing (or unreadable). */
  readFailures: (
    ctx: AgentContext,
    pr: Candidate,
  ) => Promise<{ failures: Array<{ checkName: string; step: string | null; excerpt: string }>; otherFailing: string[] } | null>;
  startFix: (
    ctx: AgentContext,
    // `resolveConflicts`: the conflict run (the MERGE item); absent ⇒ the CI fix. `withCi` (with it): the
    // combined run — the CI review's fixable items too, `instruction` then being Limn's own preamble.
    input: { accountId: number; prId: number; instruction: string; resolveConflicts?: boolean; withCi?: boolean },
  ) => Promise<{ status: string; fixId?: number; message?: string }>;
  // `hasWork`: Push has something to send (a VALID merge for a conflict run); `mergeReason`: why a merge
  // is not pushable. Absent (an older seam) ⇒ read from `patch`. `ciItems`: the CI items shown to the agent.
  fixState: (
    ctx: AgentContext,
    accountId: number,
    fixId: number,
  ) => Promise<{
    status: string;
    patch: string | null;
    error: string | null;
    provider: string | null;
    hasWork?: boolean;
    mergeReason?: string | null;
    ciItems?: number;
  } | null>;
  push: (ctx: AgentContext, accountId: number, fixId: number) => Promise<{ ok: true; sha: string } | { ok: false; message: string }>;
  /** Does an AI Fix session (anyone's — a reader's click or an earlier automatic one) hold the PR? */
  isFixRunning: (prId: number) => Promise<boolean>;
  /** Could a sandboxed AI Fix session start now (a runtime, a free session, the build slot)? Never reserves. */
  sandbox: (
    ctx: AgentContext,
  ) => Promise<{ ok: true } | { ok: false; reason: 'no_runtime' | 'busy'; message: string }>;
  /** Stop THIS fix's session (it overran its time): closed as cancelled, so nothing pushes it later. */
  stop: (ctx: AgentContext, accountId: number, prId: number, fixId: number) => Promise<void>;
  pollMs: number;
}

const defaultAiFixDeps: AiFixDeps = {
  allowed: (ctx, accountId) => automaticRunAllowed(ctx, accountId, 'dependency CI fix'),
  async readFailures(ctx, pr) {
    const { readCiInputs } = await import('../review/ci-review/prepare.js');
    const inputs = await readCiInputs(ctx, {
      accountId: pr.accountId,
      prId: pr.id,
      owner: pr.owner,
      name: pr.name,
      headSha: pr.headSha,
      prior: null,
    });
    // LIVE PROOF: the head's checks, read now, show a failure. Nothing failing (it went green, or
    // was re-run) or unreadable ⇒ not proven: no claim, no run.
    if (inputs.ok) {
      const sent = inputs.plan.sent.map((x) => ({ checkName: x.check.checkName, step: x.step, excerpt: x.excerpt.text }));
      const shown = new Set(sent.map((x) => x.checkName));
      return { failures: sent, otherFailing: inputs.failingChecks.filter((n) => !shown.has(n)) };
    }
    if (inputs.failingChecks && inputs.failingChecks.length > 0) {
      return { failures: [], otherFailing: inputs.failingChecks };
    }
    return null;
  },
  async startFix(ctx, input) {
    const { startFix } = await import('../coding/ai-fix/manager.js');
    if (input.withCi) {
      // THE COMBINED RUN: the CI-only seed (the CI review's fixable items at the PR's current head) with the
      // merge REQUIRED, Limn's preamble above it. Unattended, the default provider, pushed below.
      return startFix(ctx, {
        accountId: input.accountId,
        prId: input.prId,
        model: DEFAULT_AI_FIX_MODEL,
        seed: 'review',
        sourceReviewId: null,
        preamble: input.instruction,
        resolveConflicts: true,
        trigger: 'auto',
      });
    }
    return startFix(ctx, {
      accountId: input.accountId,
      prId: input.prId,
      model: DEFAULT_AI_FIX_MODEL,
      seed: 'plain',
      instruction: input.instruction,
      // An automatic fix: the default provider, no picker. auto-push.ts never pushes it (not the
      // reader's own PR) — this file pushes it below, under its own rules.
      trigger: 'auto',
      ...(input.resolveConflicts ? { resolveConflicts: true } : {}),
    });
  },
  async fixState(ctx, accountId, fixId) {
    const { getFixById } = await import('../coding/ai-fix/persist.js');
    const row = await getFixById(ctx, accountId, fixId);
    if (!row) return null;
    const r = row as { status: string; patch?: string | null; error?: string | null; provider?: string | null; mergeJson?: unknown; mergeBundle?: string | null; reviewItems?: string | null };
    const { fixRowHasWork, readMergeState } = await import('../sandbox/session/fix-merge.js');
    const merge = readMergeState(r.mergeJson ?? null);
    let ciItems = 0;
    try {
      const items = JSON.parse(r.reviewItems ?? '[]') as Array<{ kind?: string; included?: boolean }>;
      ciItems = Array.isArray(items) ? items.filter((i) => i?.kind === 'ci_failure' && i.included !== false).length : 0;
    } catch {
      /* unreadable items: the log names the merge only */
    }
    return {
      ciItems,
      status: r.status,
      patch: r.patch ?? null,
      error: r.error ?? null,
      provider: r.provider ?? null,
      hasWork: fixRowHasWork(r),
      mergeReason: merge && merge.status !== 'valid' ? (merge.reason ?? 'The merge is not ready.') : null,
    };
  },
  async push(ctx, accountId, fixId) {
    const { pushFix } = await import('../coding/ai-fix/push.js');
    // The Push button's own path: write access re-checked, the branch must still be the fix's base
    // (never forced), the PR settled after the write.
    const out = await pushFix(ctx, { accountId, fixId, target: 'existing' });
    return out.ok ? { ok: true, sha: out.result.commitSha } : { ok: false, message: out.message };
  },
  async isFixRunning(prId) {
    const { isFixRunning } = await import('../coding/ai-fix/manager.js');
    return isFixRunning(prId);
  },
  async sandbox() {
    const { fixSandboxReadiness } = await import('../sandbox/session/fix.js');
    return fixSandboxReadiness();
  },
  async stop(ctx, accountId, prId, fixId) {
    const { fixIdHoldingPr, stopFixSession } = await import('../sandbox/session/fix.js');
    // Only when THIS fix still holds the PR (one fix per PR): never a later fix a person started.
    if (fixIdHoldingPr(prId) === fixId) await stopFixSession(ctx, accountId, prId);
  },
  pollMs: 5_000,
};

let aiFixDeps: AiFixDeps = defaultAiFixDeps;

/**
 * An UNATTENDED AI Fix for a trusted bot's PR whose CI failed: the spend gate first (over ⇒ skipped,
 * never queued), the failure proven LIVE, then THE SANDBOX (no container runtime ⇒ one `skipped` row,
 * `recordSandboxSkip`, no claim and no GitHub write; busy ⇒ nothing, a later tick decides), then the
 * claim (DB + `limn/deps`), then AI Fix's own run — an UNATTENDED sandboxed session (plain seed: the
 * failing checks and their log excerpts; one build turn, then it closes) — then AI Fix's own Push onto
 * the bot's branch. The pushed head must go GREEN again before anything approves or arms it
 * (`aiPushedHeads`). Never retried at a head; a person's cancel of the fix wins (Stop closes an
 * unattended session as cancelled). A start that loses the sandbox race after the claim gives it back.
 */
async function startAiFix(ctx: AgentContext, c: ClaimCtx, pr: Candidate, kind: string | null): Promise<void> {
  const { log } = c;
  const deps = aiFixDeps;
  if (!(await deps.allowed(ctx, pr.accountId))) return;
  const ci = await deps.readFailures(ctx, pr).catch(() => null);
  if (ci == null || (ci.failures.length === 0 && ci.otherFailing.length === 0)) return;
  const sandbox = await deps.sandbox(ctx).catch(() => ({ ok: true as const }));
  if (!sandbox.ok) {
    if (sandbox.reason === 'no_runtime') {
      await recordSandboxSkip(pr.accountId, pr.id, pr.headSha, 'ai_fix', NO_SANDBOX_DETAIL).catch((err) =>
        log.warn({ err, prId: pr.id }, 'dependency automation: could not record the sandbox skip'),
      );
      log.info({ prId: pr.id }, 'dependency automation: AI fix skipped, no container runtime');
    }
    return;
  }
  const claim = await beginDependencyAction(c, pr, 'ai_fix');
  if (claim == null) return;
  const instruction = dependencyFixInstruction({
    title: pr.title,
    bot: BOT_BRAND[kind ?? ''] ?? 'a dependency bot',
    failures: ci.failures,
    otherFailing: ci.otherFailing,
  });
  const res = await deps.startFix(ctx, { accountId: pr.accountId, prId: pr.id, instruction }).catch((err) => {
    log.warn({ err, prId: pr.id }, 'dependency automation: AI fix did not start');
    return null;
  });
  if (res == null || res.status !== 'queued' || res.fixId == null) {
    if (res?.status === 'no_auth') await finishAction(claim, 'failed', 'No AI sign-in.', log);
    else {
      // Busy (`too_many` / `build_busy`, the pre-check lost a race), over budget, or anything else: nothing
      // was written, so the claim goes back and a later tick decides again.
      await giveBack(claim, "didn't start", log);
      // The runtime went away since the pre-check: the same one skip row as the pre-check writes.
      if (res?.status === 'no_runtime') await recordSandboxSkip(pr.accountId, pr.id, pr.headSha, 'ai_fix', NO_SANDBOX_DETAIL).catch(() => {});
    }
    return;
  }
  renewDepsClaim(claim.line, log);
  aiWatching.add(pr.id);
  void watchFixAndPush(ctx, claim, pr, res.fixId, deps, log).finally(() => aiWatching.delete(pr.id));
}

/** Wait for the fix (a CI fix, or the conflict run), then push it. Records the TRUE outcome. NEVER REJECTS. */
async function watchFixAndPush(
  ctx: AgentContext,
  claim: ActionClaim,
  pr: Candidate,
  fixId: number,
  deps: AiFixDeps,
  log: FastifyBaseLogger,
  what: 'ci' | 'conflicts' = 'ci',
): Promise<void> {
  try {
    const deadline = Date.now() + AI_FIX_TIMEOUT_MS;
    let state = await deps.fixState(ctx, pr.accountId, fixId);
    while (state != null && (state.status === 'queued' || state.status === 'running')) {
      if (Date.now() > deadline) {
        // The session would run on (and spend) with nobody waiting for it: stop it first.
        await deps.stop(ctx, pr.accountId, pr.id, fixId).catch(() => {});
        await finishAction(claim, 'failed', 'The AI fix took too long.', log);
        return;
      }
      await sleep(deps.pollMs);
      state = await deps.fixState(ctx, pr.accountId, fixId);
    }
    if (state == null) {
      await finishAction(claim, 'failed', 'The AI fix disappeared.', log);
      return;
    }
    if (state.status === 'cancelled') {
      // A person's cancel wins: recorded, never retried at this head.
      await finishAction(claim, 'failed', 'Cancelled.', log);
      return;
    }
    if (state.status !== 'succeeded') {
      await finishAction(claim, 'failed', state.error ? firstLine(state.error) : 'The AI fix failed.', log);
      return;
    }
    if (state.mergeReason) {
      // Limn's check of the merge failed: nothing is pushed (the fix may depend on the merge).
      await finishAction(claim, 'failed', `Not pushed: ${firstLine(state.mergeReason)}`, log);
      return;
    }
    if (!(state.hasWork ?? (state.patch ?? '').trim() !== '')) {
      await finishAction(claim, 'failed', 'The AI changed nothing.', log);
      return;
    }
    const out = await deps.push(ctx, pr.accountId, fixId);
    if (!out.ok) {
      await finishAction(claim, 'failed', `Not pushed: ${out.message}`, log);
      return;
    }
    const by = state.provider === 'codex' ? 'Codex' : 'Claude';
    const verb = what === 'ci' ? 'Fixed' : (state.ciItems ?? 0) > 0 ? 'Resolved conflicts and fixed CI' : 'Resolved';
    await finishAction(claim, 'done', `${verb} with ${by} and pushed ${out.sha.slice(0, 7)}`, log, out.sha);
    await notePrChangedForPr(pr.accountId, pr.id).catch(() => {});
    log.info({ prId: pr.id, sha: out.sha }, what === 'conflicts' ? 'dependency automation: conflicts resolved' : 'dependency automation: CI fixed');
  } catch (err) {
    log.warn({ err, prId: pr.id }, 'dependency automation: AI fix failed');
    await finishAction(claim, 'failed', firstLine(err), log).catch(() => {});
  }
}

/** Test seam only. */
export const __testing = {
  reset(): void {
    ticking = false;
    aiCtx = null;
    aiWatching.clear();
    liveClassCache.clear();
    aiFixDeps = defaultAiFixDeps;
  },
  setAiFixDeps(d: Partial<AiFixDeps>): void {
    aiFixDeps = { ...defaultAiFixDeps, ...d };
  },
  /** Resolves once no AI run is being watched (bounded). */
  async settle(maxMs = 2_000): Promise<void> {
    const end = Date.now() + maxMs;
    while (aiWatching.size > 0 && Date.now() < end) await sleep(5);
  },
};
