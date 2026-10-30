// ── DEPENDENCY AUTOMATION: APPROVE + RESOLVE CONFLICTS (CORE, free) ─────────────────────────────
//
// docs/MERGE-CI-TRUNK.md § Dependency automation. Settings → Dependencies holds, per workspace and
// every one OFF by default: "merge" (merge/dependency-policy.ts, the older switch), "approve" and
// "resolve conflicts" (this file), and ONE policy (size, security-only, ecosystems) that gates all
// three. The decisions are pure and tested in merge/dependency-rules.ts; this file gathers values,
// claims, writes and records.
//
// WHO: approval and conflict resolution act ONLY on PRs opened by a bot the reader TRUSTS — its
// STORED row in this workspace says automated, role `dependency`, and `dependency_trusted`
// (`isTrustedDependencyBot`). Never a login guess: a person can open a fork PR under any login.
//
// APPROVE (`runDependencyAutomationTick`, on the auto-merge watcher's cron just before the merge
// sweep): an open, non-draft, same-repo PR whose SYNCED CI is `success` (green, not merely not red)
// and whose review decision is not already `approved`, in a repo the reader can push to. Re-read
// LIVE first (one GET): the head must be the synced one (the approval is pinned to it with
// `commit_id`), it must not be a fork, and its title + body are what the policy measures.
//
// RESOLVE CONFLICTS: first ask the bot to rebase — Dependabot by the `@dependabot rebase` comment,
// Renovate by ticking its rebase checkbox in the PR body — once per head, and wait REBASE_WAIT_MS
// (a rebase is a new head, so a successful one ends the story). If the bot can't be asked, the ask
// failed, or the wait ran out: an AI run through the in-app resolver ("Resolve with Claude" / Codex,
// the provider seam), behind the AUTOMATIC-RUN budget gate (`automaticRunAllowed`; skipped, never
// queued). Its answer is committed and pushed UNATTENDED only when every conflicted file is
// supported and every decidable region carries a choice the model was sure of
// (`aiResolutionCommit`); merge strategy onto the PR's own branch, never a rebase. The pushed head
// (`resultSha`) must then be GREEN again before it is approved or armed.
//
// ⚠ CLAIM BEFORE WRITE, NEVER RETRY: every action inserts its (account, PR, head, action) row as
// `running` BEFORE the GitHub write (`claimAction`, a unique index); no row inserted → somebody
// already did it. A failure is recorded with GitHub's words and never retried at that head.
// ⚠ EVERY WRITE STAMPS OR SETTLES, THEN CASCADES: the approval stamps the review + clears the
// request + re-reads + schedules the settle ladder; the rebase comment stamps the comment; the body
// edit re-reads; the AI push lands through the resolver's own path (which settles).
// ⚠ A PERSON'S CANCEL WINS: a PR in `auto_merge_policy_skips` is left alone by all three switches.
import type { FastifyBaseLogger } from 'fastify';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  DEFAULT_AI_FIX_MODEL,
  DEFAULT_DEPENDENCY_POLICY,
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
  AI_COMMIT_REFUSAL_TEXT,
  aiResolutionCommit,
  botCanRebase,
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
/** How long an AI conflict run may take before it is given up on. */
const AI_RUN_TIMEOUT_MS = 45 * 60_000;
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
  maxLevel: workspaces.dependencyMaxLevel,
  securityOnly: workspaces.dependencySecurityOnly,
  ecosystems: workspaces.dependencyEcosystems,
};

type SettingsRow = {
  autoMerge: boolean | null;
  autoApprove: boolean | null;
  autoResolve: boolean | null;
  maxLevel: string | null;
  securityOnly: boolean | null;
  ecosystems: string[] | null;
};

function settingsOf(row: SettingsRow): DependencyAutomationSettings {
  return {
    autoMerge: row.autoMerge === true,
    autoApprove: row.autoApprove === true,
    autoResolveConflicts: row.autoResolve === true,
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
  return rows.map((r) => ({
    id: r.id,
    prId: r.prId,
    repoFullName: `${r.owner}/${r.name}`,
    prNumber: r.number,
    prTitle: r.title,
    action: r.action as DependencyAutomationActionKind,
    state: r.state as DependencyAutomationActionState,
    detail: r.detail ?? null,
    at: r.updatedAt.toISOString(),
  }));
}

// ── Claims ───────────────────────────────────────────────────────────────────────────────────

/** Claim one action at one head. The row id, or null when it was already taken (by anyone, ever). */
export async function claimAction(
  accountId: number,
  prId: number,
  headSha: string,
  action: DependencyAutomationActionKind,
): Promise<number | null> {
  const rows = await db
    .insert(daa)
    .values({ accountId, prId, headSha, action, state: 'running' })
    .onConflictDoNothing({ target: [daa.accountId, daa.prId, daa.headSha, daa.action] })
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

/** The heads Limn's AI run pushed — each must be GREEN (not merely not red) before it is approved
 *  or armed. Keyed `${prId}:${sha}`. */
export async function aiPushedHeads(accountId: number, prIds: number[]): Promise<Set<string>> {
  if (prIds.length === 0) return new Set();
  const rows = await db
    .select({ prId: daa.prId, sha: daa.resultSha })
    .from(daa)
    .where(and(eq(daa.accountId, accountId), inArray(daa.prId, prIds), eq(daa.action, 'ai_resolve'), eq(daa.state, 'done')))
    .execute();
  return new Set(rows.filter((r) => r.sha != null).map((r) => `${r.prId}:${r.sha}`));
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

// ── The AI fallback's context (bound at boot where agentic AI runs) ─────────────────────────

let aiCtx: AgentContext | null = null;

/** Called by `startAgenticBackground` (review/agentic.ts): without it the AI fallback never runs. */
export function bindDependencyAutomationAi(ctx: AgentContext): void {
  aiCtx = ctx;
}

/** AI runs this process is watching, by PR id. */
const aiWatching = new Set<number>();

// ── The tick ─────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  id: number;
  repoId: number;
  owner: string;
  name: string;
  number: number;
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
 * Approve and resolve conflicts on the trusted dependency bots' PRs of every workspace with either
 * switch on. Runs on the auto-merge watcher's cron, before the merge sweep (an approval may be what
 * lets that PR land). Bounded (`ACTIONS_PER_TICK`), per-workspace try/catch, never throws.
 */
export async function runDependencyAutomationTick(log: FastifyBaseLogger, now: number = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  const budget = { left: ACTIONS_PER_TICK };
  try {
    const roster = await db
      .select({ accountId: workspaces.accountId, workspaceId: workspaces.id, ...settingsColumns })
      .from(workspaces)
      .execute();
    for (const ws of roster) {
      if (budget.left <= 0) break;
      const settings = settingsOf(ws as SettingsRow);
      if (!settings.autoApprove && !settings.autoResolveConflicts) continue;
      try {
        await tickWorkspace(ws.accountId, ws.workspaceId, settings, budget, log, now);
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
  log: FastifyBaseLogger,
  now: number,
): Promise<void> {
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
  const prs = rows.filter(
    (r): r is typeof r & { headSha: string; authorId: number } =>
      r.headSha != null && r.authorId != null && !r.isDraft && WRITE_PERMISSIONS.has(r.viewerPermission ?? ''),
  ) as Candidate[];
  if (prs.length === 0) return;
  const ids = prs.map((p) => p.id);
  const [skipRows, actionRows, facts] = await Promise.all([
    db
      .select({ prId: autoMergePolicySkips.prId })
      .from(autoMergePolicySkips)
      .where(and(eq(autoMergePolicySkips.accountId, accountId), inArray(autoMergePolicySkips.prId, ids)))
      .execute(),
    db
      .select({ prId: daa.prId, headSha: daa.headSha, action: daa.action, state: daa.state, createdAt: daa.createdAt })
      .from(daa)
      .where(and(eq(daa.accountId, accountId), inArray(daa.prId, ids)))
      .execute(),
    prPolicyFacts(accountId, ids),
  ]);
  const cancelled = new Set(skipRows.map((r) => r.prId));
  const actionAt = (prId: number, head: string, action: DependencyAutomationActionKind) =>
    actionRows.find((a) => a.prId === prId && a.headSha === head && a.action === action) ?? null;

  let token: string | null = null;
  const viewerUserId = await getAccountUserId(accountId);

  for (const pr of prs) {
    if (budget.left <= 0) return;
    if (cancelled.has(pr.id)) continue; // a person's cancel wins, for every switch
    const f = facts.get(pr.id);
    if (!f) continue;
    const conflicting = isConflicting(pr);

    if (conflicting) {
      if (!settings.autoResolveConflicts) continue;
      const rebase = actionAt(pr.id, pr.headSha, 'rebase_request');
      const ai = actionAt(pr.id, pr.headSha, 'ai_resolve');
      const kind = trusted.get(pr.authorId) ?? null;
      const step = conflictStep(
        {
          rebase: rebase ? { state: rebase.state, at: rebase.createdAt.getTime() } : null,
          ai: ai ? { state: ai.state } : null,
        },
        botCanRebase(kind),
        now,
      );
      if (step === 'none' || step === 'wait') continue;
      if (step === 'ai' && (aiCtx == null || aiWatching.has(pr.id))) continue;
      token ??= await getAccessToken(accountId);
      const live = await fetchPrForAutomation(token, pr.owner, pr.name, pr.number).catch(() => null);
      if (!live || live.state !== 'open' || live.isDraft || live.headSha !== pr.headSha || live.isFork) continue;
      if (!(await policyAdmits(settings.policy, f, pr, { live })).ok) continue;
      budget.left -= 1;
      if (step === 'ask_bot') {
        const req = rebaseRequestFor(kind, live.body);
        if (req) {
          await askBotToRebase(accountId, pr, kind, req, token, viewerUserId, log);
          continue;
        }
        // Renovate without its checkbox: nothing to ask — straight to the AI, if it can run.
        if (aiCtx == null) continue;
      }
      await startAiFallback(aiCtx!, accountId, pr, log);
      continue;
    }

    // ── APPROVE ──
    if (!settings.autoApprove) continue;
    if (pr.reviewDecision === 'approved') continue;
    if (pr.ciStatus !== 'success') continue; // green, not merely not red (pushed heads included)
    if (viewerUserId == null || viewerUserId === pr.authorId) continue;
    if (actionAt(pr.id, pr.headSha, 'approve')) continue;
    // Synced facts first: a PR the policy refuses on what we already know costs no GitHub call.
    const synced = await policyAdmits(settings.policy, f, pr);
    if (!synced.ok && synced.final) continue;
    token ??= await getAccessToken(accountId);
    // The live re-read the approval needs anyway: the head it pins, fork-ness, title + body.
    const live = await fetchPrForAutomation(token, pr.owner, pr.name, pr.number).catch(() => null);
    if (!live || live.state !== 'open' || live.isDraft || live.headSha !== pr.headSha || live.isFork) continue;
    if (!(await policyAdmits(settings.policy, f, pr, { live })).ok) continue;
    budget.left -= 1;
    await approve(accountId, pr, viewerUserId, classifyFrom(f, live), f.securityFix, token, log);
  }
}

function updateWords(cls: DependencyUpdateClass, securityFix: boolean): string {
  const size = cls.level ? `${cls.level} ` : '';
  return securityFix ? `a ${size}security fix` : `a ${size}dependency update`;
}

async function approve(
  accountId: number,
  pr: Candidate,
  viewerUserId: number,
  cls: DependencyUpdateClass,
  securityFix: boolean,
  token: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const claim = await claimAction(accountId, pr.id, pr.headSha, 'approve');
  if (claim == null) return;
  try {
    const gh = await submitPrReview(token, pr.owner, pr.name, pr.number, {
      event: 'APPROVE',
      // Pinned to the head we checked: a push since makes GitHub refuse it.
      commitId: pr.headSha,
      body: `Approved automatically: ${updateWords(cls, securityFix)} from a trusted bot, with CI green.\n\n${LIMN_MARKER}`,
    });
    await settleAction(claim, 'done', updateWords(cls, securityFix));
    // STAMP, then SETTLE, then CASCADE — the approve route's own tail.
    await upsertLocalReview(pr.id, viewerUserId, gh);
    await clearOwnReviewRequest(pr.id, accountId, viewerUserId);
    await resyncPrAfterWrite({ prId: pr.id, accountId, log });
    schedulePrSettle(accountId, pr.id, asSyncLogger(log), { mergeStateNot: 'blocked' });
    await notePrChangedForPr(accountId, pr.id);
    log.info({ prId: pr.id, repo: `${pr.owner}/${pr.name}`, number: pr.number }, 'dependency automation: approved');
  } catch (err) {
    await settleAction(claim, 'failed', firstLine(err));
    log.warn({ err, prId: pr.id }, 'dependency automation: approval failed');
  }
}

async function askBotToRebase(
  accountId: number,
  pr: Candidate,
  kind: string | null,
  req: NonNullable<ReturnType<typeof rebaseRequestFor>>,
  token: string,
  viewerUserId: number | null,
  log: FastifyBaseLogger,
): Promise<void> {
  const claim = await claimAction(accountId, pr.id, pr.headSha, 'rebase_request');
  if (claim == null) return;
  const bot = BOT_BRAND[kind ?? ''] ?? 'the bot';
  try {
    if (req.method === 'comment') {
      const gh = await addIssueComment(token, pr.owner, pr.name, pr.number, req.body);
      await settleAction(claim, 'done', `Asked ${bot} to rebase`);
      await upsertLocalPrComment(pr.id, viewerUserId, gh);
    } else {
      const out = await updatePullRequestBody(token, pr.owner, pr.name, pr.number, req.body);
      if (!out.ok) {
        await settleAction(claim, 'failed', out.message);
        return;
      }
      await settleAction(claim, 'done', `Asked ${bot} to rebase`);
      await resyncPrAfterWrite({ prId: pr.id, accountId, log });
    }
    await notePrChangedForPr(accountId, pr.id);
  } catch (err) {
    await settleAction(claim, 'failed', firstLine(err));
    log.warn({ err, prId: pr.id }, 'dependency automation: rebase request failed');
  }
}

async function startAiFallback(
  ctx: AgentContext,
  accountId: number,
  pr: Candidate,
  log: FastifyBaseLogger,
): Promise<void> {
  // THE AUTOMATIC-RUN BUDGET GATE: over budget → skipped, never queued (the next tick re-derives).
  if (!(await automaticRunAllowed(ctx, accountId, 'dependency conflicts'))) return;
  const claim = await claimAction(accountId, pr.id, pr.headSha, 'ai_resolve');
  if (claim == null) return;
  const [{ startAiResolve }, { runOpen }] = await Promise.all([
    import('../coding/ai-resolve/run.js'),
    import('../api/routes/conflicts.js'),
  ]);
  const res = await startAiResolve(ctx, {
    accountId,
    prId: pr.id,
    model: DEFAULT_AI_FIX_MODEL,
    headSha: pr.headSha,
    log,
    runOpen,
  }).catch((err) => {
    log.warn({ err, prId: pr.id }, 'dependency automation: AI run did not start');
    return null;
  });
  if (res == null || (res.status !== 'started' && res.status !== 'running')) {
    // Nothing was written and no model ran: give the claim back so a later tick may try.
    if (res?.status === 'no_conflicts' || res?.status === 'no_auth') {
      await settleAction(claim, 'failed', res.status === 'no_auth' ? 'No AI sign-in.' : 'No longer conflicts.');
    } else {
      await releaseClaim(claim);
    }
    return;
  }
  aiWatching.add(pr.id);
  void watchAndLand(claim, accountId, pr, log).finally(() => aiWatching.delete(pr.id));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for the AI run, then commit its answer UNATTENDED when it is complete. NEVER REJECTS. */
async function watchAndLand(claim: number, accountId: number, pr: Candidate, log: FastifyBaseLogger): Promise<void> {
  try {
    const { peekSession } = await import('../conflict/session.js');
    const { getAiResolution } = await import('../coding/ai-resolve/run.js');
    const { landSessionResolution } = await import('../api/routes/conflicts.js');
    const deadline = Date.now() + AI_RUN_TIMEOUT_MS;
    while (peekSession(accountId, pr.id)?.aiRunning === true) {
      if (Date.now() > deadline) {
        await settleAction(claim, 'failed', 'The AI run took too long.');
        return;
      }
      await sleep(3_000);
    }
    const view = getAiResolution(accountId, pr.id);
    const rec = peekSession(accountId, pr.id);
    if (!view || !rec || view.status !== 'succeeded') {
      await settleAction(claim, 'failed', view?.error ?? 'The AI run didn’t finish.');
      return;
    }
    const model = rec.model;
    if (!model || model.headSha !== pr.headSha || rec.sessionId !== view.sessionId) {
      await settleAction(claim, 'failed', 'The branch moved during the AI run.');
      return;
    }
    if (!model.prBranchPushable) {
      await settleAction(claim, 'failed', model.prBranchUnavailableReason ?? 'The branch can’t be pushed to.');
      return;
    }
    const plan = aiResolutionCommit(model.files, view.choices);
    if (!plan.ok) {
      await settleAction(claim, 'failed', `Not pushed: ${AI_COMMIT_REFUSAL_TEXT[plan.refusal]}.`);
      return;
    }
    const out = await landSessionResolution(
      rec,
      {
        sessionId: rec.sessionId,
        expectedHeadSha: model.headSha,
        expectedBaseSha: model.baseSha,
        modelHash: rec.modelHash,
        // A merge commit onto the bot's branch — never a rebase, which would rewrite it.
        strategy: 'merge',
        target: { kind: 'pr_branch' },
        files: plan.files,
      },
      log,
    );
    if (!out.ok) {
      await settleAction(claim, 'failed', out.message);
      return;
    }
    await settleAction(
      claim,
      'done',
      `Resolved with ${view.provider === 'codex' ? 'Codex' : 'Claude'} and pushed ${out.result.commitSha.slice(0, 7)}`,
      out.result.commitSha,
    );
    await notePrChangedForPr(accountId, pr.id);
    log.info({ prId: pr.id, sha: out.result.commitSha }, 'dependency automation: conflicts resolved');
  } catch (err) {
    log.warn({ err, prId: pr.id }, 'dependency automation: AI conflict run failed');
    await settleAction(claim, 'failed', firstLine(err)).catch(() => {});
  }
}

/** Test seam only. */
export const __testing = {
  reset(): void {
    ticking = false;
    aiCtx = null;
    aiWatching.clear();
    liveClassCache.clear();
  },
};
