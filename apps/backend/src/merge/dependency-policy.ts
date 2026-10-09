// ── DEPENDENCY AUTO-MERGE (CORE, free, both modes) ──────────────────────────────────────────────
//
// docs/MERGE-CI-TRUNK.md § Dependency auto-merge. Two features over ONE classifier:
//
//   • "Merge or arm all" on Pending → Dependencies (`runDependencyMergeAll`, a click): every
//     listed dependency-automation PR the account can push to is merged now when GitHub says it
//     can land, otherwise armed "merge when ready" through the ordinary consent-anchored watcher.
//   • "Merge dependency updates automatically" (`workspaces.dependency_auto_merge`, OFF by
//     default; `runDependencyPolicyTick`): the server arms those PRs itself, pinned to their
//     current head, marked `armedByPolicy`. The watcher (merge/auto-merge-runner.ts) lands a
//     policy intent exactly as it lands a click's: once the REQUIRED checks pass ('clean' /
//     'has_hooks' / 'unstable' — a red OPTIONAL check never blocks it).
//
// WHICH PRs: `authorAutomationFor(...).role === 'dependency'` over the workspace's own bot maps —
// the SAME resolution the Dependencies tab's membership reads (db/queries.ts `depPrIds`), so a PR
// cannot be "a dependency update" here and a person's PR in the tab.
//
// ⚠ THE SETTING IS THE CONSENT, SO A NEW HEAD IS RE-ARMED. When the bot pushes, rule 1 of the
// watcher disarms (`disarmed_head_moved`) as it always does; the next sweep sees an intent that is
// not armed on a head that is not the pinned one, and arms the new head. An intent that ENDED on
// the SAME head (expired, failed, lost access, retargeted) is never re-armed on that head.
// ⚠ A PERSON'S CANCEL WINS FOR EVER: the DELETE route records the PR in `auto_merge_policy_skips`
// and the sweep never arms a PR with a row there.
import type { FastifyBaseLogger } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import type {
  AutomatedReviewerKind,
  DependencyMergeItem,
  DependencyMergeSkipReason,
} from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { onOff, recordWorkspaceSettingEvent } from '../db/workspace-setting-events.js';
import { getAccessToken, getAccountUserId } from '../auth/account.js';
import {
  getWorkspaceRepoIds,
  markPrMergedLocally,
  resolveAuthorAutomationInputs,
  WRITE_PERMISSIONS,
} from '../db/queries.js';
import { authorAutomationFor } from '../db/dependency-cards.js';
import { isConflicting } from '../db/pending-classify.js';
import { stampPrMergeQueueStateNonFatal } from '../db/pr-merge-queue-stamp.js';
import {
  fetchMergeQueueState,
  fetchPrMergeSnapshot,
  mergePullRequest,
} from '../github/mutations.js';
import { asSyncLogger } from '../sync/resync-after-write.js';
import { noteMergeLanded } from '../sync/unsettled-prs.js';
import { armIntentLive, defaultMergeMethod } from './arm-intent.js';

const { autoMergePolicySkips, autoMergeRequests, pullRequests, repos, users, workspaces } = schema;

/** GitHub's "it would land right now" states — `READY_MERGE_STATES` (db/triage.ts) in the REST
 *  spelling. `unstable` is in it: a click may merge a PR whose only red checks are optional. */
const LIVE_READY_STATES = new Set(['clean', 'has_hooks', 'unstable']);

/** Arms per sweep, across every account — each costs 2–3 GitHub calls, so this bounds a tick. */
const POLICY_ARMS_PER_TICK = 10;

// ── The setting ──────────────────────────────────────────────────────────────────────────────

/** null = no such workspace on this account. */
export async function getDependencyAutoMerge(
  accountId: number,
  workspaceId: number,
): Promise<{ enabled: boolean } | null> {
  const rows = await db
    .select({ on: workspaces.dependencyAutoMerge })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
    .limit(1)
    .execute();
  const row = rows[0];
  return row ? { enabled: row.on === true } : null;
}

/** The ONE writer. Off writes NULL (the default). false = no such workspace. */
export async function setDependencyAutoMerge(
  accountId: number,
  workspaceId: number,
  enabled: boolean,
): Promise<boolean> {
  const before = await getDependencyAutoMerge(accountId, workspaceId);
  if (before == null) return false;
  const rows = await db
    .update(workspaces)
    .set({ dependencyAutoMerge: enabled ? true : null })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
    .returning({ id: workspaces.id })
    .execute();
  if (rows.length === 0) return false;
  // Chronology's settings history: only a real change is recorded.
  if (before.enabled !== enabled) {
    await recordWorkspaceSettingEvent(
      accountId,
      workspaceId,
      'dependency_auto_merge',
      `Dependency auto-merge ${onOff(enabled)}`,
    );
  }
  return true;
}

/** A person cancelled this PR's intent: the setting never re-arms it. Idempotent. */
export async function recordPolicySkip(accountId: number, prId: number): Promise<void> {
  await db
    .insert(autoMergePolicySkips)
    .values({ accountId, prId })
    .onConflictDoNothing({ target: [autoMergePolicySkips.accountId, autoMergePolicySkips.prId] })
    .execute();
}

// ── The classifier ───────────────────────────────────────────────────────────────────────────

export interface DependencyPrRow {
  id: number;
  repoId: number;
  owner: string;
  name: string;
  number: number;
  title: string;
  isDraft: boolean;
  headSha: string | null;
  mergeStateStatus: string | null;
  mergeable: string | null;
  inMergeQueue: boolean | null;
  viewerPermission: string | null;
}

/**
 * The OPEN dependency-automation PRs in `repoIds` (optionally narrowed to `prIds`), classified with
 * `workspaceId`'s bot maps. Drafts are included (the bulk dialog names them as skipped).
 */
export async function listDependencyPrs(
  accountId: number,
  workspaceId: number,
  repoIds: number[],
  prIds?: number[],
): Promise<DependencyPrRow[]> {
  if (repoIds.length === 0 || (prIds && prIds.length === 0)) return [];
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
      mergeStateStatus: pullRequests.mergeStateStatus,
      mergeable: pullRequests.mergeable,
      inMergeQueue: pullRequests.inMergeQueue,
      viewerPermission: repos.viewerPermission,
      authorId: pullRequests.authorId,
      dependencyVendor: pullRequests.dependencyVendor,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(repos.accountId, accountId),
        inArray(pullRequests.repoId, repoIds),
        eq(pullRequests.state, 'open'),
        ...(prIds ? [inArray(pullRequests.id, prIds)] : []),
      ),
    )
    .execute();
  if (rows.length === 0) return [];
  const inputs = await resolveAuthorAutomationInputs(accountId, workspaceId);
  const authorIds = [...new Set(rows.map((r) => r.authorId).filter((x): x is number => x != null))];
  if (authorIds.length > 0) {
    for (const u of await db
      .select({ id: users.id, login: users.githubLogin })
      .from(users)
      .where(inArray(users.id, authorIds))
      .execute()) {
      inputs.loginOf.set(u.id, u.login);
    }
  }
  return rows
    .filter(
      (r) =>
        authorAutomationFor(
          r.authorId,
          (r.dependencyVendor as AutomatedReviewerKind | null) ?? null,
          inputs,
        )?.role === 'dependency',
    )
    .map(({ authorId: _a, dependencyVendor: _d, ...r }) => ({
      ...r,
      mergeStateStatus: r.mergeStateStatus as string | null,
      mergeable: r.mergeable as string | null,
      inMergeQueue: r.inMergeQueue ?? null,
    }));
}

/** The synced-state skip, or null when the PR is worth a try. ONE fold for the dialog and the run. */
function syncedSkip(
  pr: DependencyPrRow,
  intentState: string | undefined,
): DependencyMergeSkipReason | null {
  if (pr.isDraft) return 'draft';
  if (!WRITE_PERMISSIONS.has(pr.viewerPermission ?? '')) return 'no_write_access';
  if (isConflicting(pr)) return 'conflicts';
  if (pr.inMergeQueue === true) return 'already_queued';
  if (intentState === 'armed') return 'already_armed';
  return null;
}

async function intentsFor(
  accountId: number,
  prIds: number[],
): Promise<Map<number, { state: string; expectedHeadOid: string }>> {
  if (prIds.length === 0) return new Map();
  const rows = await db
    .select({
      prId: autoMergeRequests.prId,
      state: autoMergeRequests.state,
      expectedHeadOid: autoMergeRequests.expectedHeadOid,
    })
    .from(autoMergeRequests)
    .where(and(eq(autoMergeRequests.accountId, accountId), inArray(autoMergeRequests.prId, prIds)))
    .execute();
  return new Map(rows.map((r) => [r.prId, { state: r.state, expectedHeadOid: r.expectedHeadOid }]));
}

// ── "Merge or arm all" ───────────────────────────────────────────────────────────────────────

/**
 * Process the Dependencies tab's listed PRs IN ORDER, one at a time. `dryRun` reads synced rows
 * only (no GitHub, nothing written) and answers merge / arm / skipped — what the confirm dialog
 * counts. A real run probes each PR live: in GitHub's merge queue → skipped; a queue repo → armed
 * (the watcher enqueues); conflicting → skipped; ready → merged (pinned to the live head, stamped
 * and cascaded like the merge route); anything else, or a merge GitHub refuses as not mergeable
 * → armed. Never throws per PR: a failure is that PR's outcome.
 */
export async function runDependencyMergeAll(args: {
  accountId: number;
  workspaceId: number;
  repoIds: number[];
  prIds: number[];
  dryRun: boolean;
  log: FastifyBaseLogger;
}): Promise<DependencyMergeItem[]> {
  const { accountId, log } = args;
  const ordered = [...new Set(args.prIds)];
  const prs = await listDependencyPrs(accountId, args.workspaceId, args.repoIds, ordered);
  const byId = new Map(prs.map((p) => [p.id, p]));
  const intents = await intentsFor(accountId, prs.map((p) => p.id));
  const items: DependencyMergeItem[] = [];
  let token: string | null = null;
  const methodByRepo = new Map<number, Awaited<ReturnType<typeof defaultMergeMethod>>>();

  for (const prId of ordered) {
    const pr = byId.get(prId);
    if (!pr) {
      items.push({
        prId,
        repoFullName: '',
        prNumber: 0,
        prTitle: '',
        outcome: { action: 'skipped', reason: 'not_found' },
      });
      continue;
    }
    const ident = {
      prId,
      repoFullName: `${pr.owner}/${pr.name}`,
      prNumber: pr.number,
      prTitle: pr.title,
    };
    const skip = syncedSkip(pr, intents.get(prId)?.state);
    if (skip) {
      items.push({ ...ident, outcome: { action: 'skipped', reason: skip } });
      continue;
    }
    if (args.dryRun) {
      const ready = LIVE_READY_STATES.has(pr.mergeStateStatus ?? '');
      items.push({ ...ident, outcome: { action: ready ? 'merge' : 'arm' } });
      continue;
    }
    try {
      token ??= await getAccessToken(accountId);
      if (!methodByRepo.has(pr.repoId)) {
        methodByRepo.set(pr.repoId, await defaultMergeMethod(token, pr.owner, pr.name));
      }
      const method = methodByRepo.get(pr.repoId) ?? null;
      if (method == null) {
        items.push({
          ...ident,
          outcome: { action: 'failed', message: 'The repository allows no merge method.' },
        });
        continue;
      }
      const queue = await fetchMergeQueueState(token, pr.owner, pr.name, pr.number).catch(
        () => null,
      );
      if (queue) {
        await stampPrMergeQueueStateNonFatal(prId, accountId, queue.inQueue, queue.state, log);
      }
      if (queue?.inQueue) {
        items.push({ ...ident, outcome: { action: 'skipped', reason: 'already_queued' } });
        continue;
      }
      if (!queue?.enabled) {
        const m = await fetchPrMergeSnapshot(token, pr.owner, pr.name, pr.number);
        if (m.mergeable === false || m.mergeableState === 'dirty') {
          items.push({ ...ident, outcome: { action: 'skipped', reason: 'conflicts' } });
          continue;
        }
        if (m.mergeableState === 'draft') {
          items.push({ ...ident, outcome: { action: 'skipped', reason: 'draft' } });
          continue;
        }
        if (LIVE_READY_STATES.has(m.mergeableState)) {
          const out = await mergePullRequest(token, pr.owner, pr.name, pr.number, {
            method,
            expectedHeadSha: m.headSha,
          });
          if (out.ok) {
            // Stamp + cascade exactly like POST /api/prs/:id/merge.
            await markPrMergedLocally(prId, accountId, await getAccountUserId(accountId));
            await noteMergeLanded(accountId, prId, asSyncLogger(log));
            items.push({ ...ident, outcome: { action: 'merged' } });
            continue;
          }
          if (out.reason !== 'not_mergeable') {
            items.push({
              ...ident,
              outcome: {
                action: 'failed',
                message:
                  out.reason === 'head_moved'
                    ? 'The branch moved just before the merge.'
                    : out.message.split('\n')[0]!.slice(0, 200),
              },
            });
            continue;
          }
          // GitHub refused it as not mergeable yet — arm instead.
        }
      }
      const armed = await armIntentLive({
        accountId,
        prId,
        owner: pr.owner,
        name: pr.name,
        number: pr.number,
        token,
        mergeMethod: method,
        // GitHub's update-branch, never the clone rebase: a force-push onto a Dependabot /
        // Renovate branch makes those bots stop maintaining the PR. Same as the policy sweep.
        updateStrategy: 'merge',
        queue,
        log,
      });
      items.push({
        ...ident,
        outcome: armed.ok
          ? { action: 'armed' }
          : armed.code === 'AlreadyQueued'
            ? { action: 'skipped', reason: 'already_queued' }
            : { action: 'failed', message: armed.message },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      items.push({
        ...ident,
        outcome: { action: 'failed', message: message.split('\n')[0]!.slice(0, 200) },
      });
    }
  }
  return items;
}

// ── The policy sweep ─────────────────────────────────────────────────────────────────────────

let sweeping = false;

/**
 * Arm the open dependency updates of every workspace with the setting on. Runs on the auto-merge
 * watcher's cron, just before it. Bounded (`POLICY_ARMS_PER_TICK`), per-account try/catch, never
 * throws. A PR is armed when: open, not a draft, not conflicting, not in GitHub's merge queue, the
 * account can push to the repo, no person cancelled it (`auto_merge_policy_skips`), and it has no
 * intent — or an ended one pinned to a DIFFERENT head (the bot pushed since).
 */
export async function runDependencyPolicyTick(log: FastifyBaseLogger): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  let budget = POLICY_ARMS_PER_TICK;
  try {
    const roster = await db
      .select({ accountId: workspaces.accountId, workspaceId: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.dependencyAutoMerge, true))
      .execute();
    for (const ws of roster) {
      if (budget <= 0) break;
      try {
        const repoIds = await getWorkspaceRepoIds(ws.workspaceId, ws.accountId);
        const prs = (await listDependencyPrs(ws.accountId, ws.workspaceId, repoIds)).filter(
          (p) =>
            !p.isDraft &&
            !isConflicting(p) &&
            p.inMergeQueue !== true &&
            p.headSha != null &&
            WRITE_PERMISSIONS.has(p.viewerPermission ?? ''),
        );
        if (prs.length === 0) continue;
        const ids = prs.map((p) => p.id);
        const [intents, skipRows] = await Promise.all([
          intentsFor(ws.accountId, ids),
          db
            .select({ prId: autoMergePolicySkips.prId })
            .from(autoMergePolicySkips)
            .where(
              and(
                eq(autoMergePolicySkips.accountId, ws.accountId),
                inArray(autoMergePolicySkips.prId, ids),
              ),
            )
            .execute(),
        ]);
        const skipped = new Set(skipRows.map((r) => r.prId));
        const due = prs.filter((p) => {
          if (skipped.has(p.id)) return false;
          const intent = intents.get(p.id);
          if (!intent) return true;
          return intent.state !== 'armed' && intent.expectedHeadOid !== p.headSha;
        });
        if (due.length === 0) continue;
        const token = await getAccessToken(ws.accountId);
        const methodByRepo = new Map<number, Awaited<ReturnType<typeof defaultMergeMethod>>>();
        for (const pr of due) {
          if (budget <= 0) break;
          budget -= 1;
          try {
            if (!methodByRepo.has(pr.repoId)) {
              methodByRepo.set(pr.repoId, await defaultMergeMethod(token, pr.owner, pr.name));
            }
            const method = methodByRepo.get(pr.repoId) ?? null;
            if (method == null) continue;
            const out = await armIntentLive({
              accountId: ws.accountId,
              prId: pr.id,
              owner: pr.owner,
              name: pr.name,
              number: pr.number,
              token,
              mergeMethod: method,
              // GitHub's own update-branch (no force-push of the bot's branch), in both modes.
              updateStrategy: 'merge',
              armedByPolicy: true,
              // An intent that ENDED on this head is never re-armed on it.
              refuseIfHead: intents.get(pr.id)?.expectedHeadOid ?? null,
              log,
            });
            if (out.ok) {
              log.info(
                { prId: pr.id, repo: `${pr.owner}/${pr.name}`, number: pr.number },
                'dependency auto-merge: armed',
              );
            }
          } catch (err) {
            log.warn({ err, prId: pr.id }, 'dependency auto-merge: could not arm');
          }
        }
      } catch (err) {
        log.warn(
          { err, accountId: ws.accountId, workspaceId: ws.workspaceId },
          'dependency auto-merge: sweep failed for workspace',
        );
      }
    }
  } catch (err) {
    log.error({ err }, 'dependency auto-merge sweep failed');
  } finally {
    sweeping = false;
  }
}
