// THE TEAM POLICY, stored and read (docs/TEAM-POLICY.md; the format is shared `team-policy.ts`).
//
// ONE writer, `recordRepoTeamPolicy`, fed by the default-branch snapshot with what GitHub said:
//   • `undefined` — GitHub said nothing this time (the read failed or was skipped): change nothing.
//   • `null`      — GitHub said there is NO file on the default branch: delete the row.
//   • text        — parse it (strictly) and store the policy or the problems.
// ⚠ A row is cleared only on a POSITIVE statement from GitHub (CLAUDE.md § Conventions).
//
// ONE reader for enforcement, `effectiveRepoTeamPolicy`: the policy every automation and AI run on
// that repo's PRs must obey, or null. Null when there is no file, when the file is invalid, OR when
// this copy has no licence key and no running evaluation (an organisation feature). Callers never
// read the table or the licence themselves.
import { and, eq, inArray } from 'drizzle-orm';
import { parseTeamPolicy, policyAllowsAutomation, TEAM_POLICY_MAX_BYTES, type TeamPolicy } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { orgFeaturesUnlockedFor } from '../licence/status.js';
import type { GateSource } from './external-repos.js';

const { repoTeamPolicies } = schema;

/** What one snapshot learnt about a repo's policy file. */
export type PolicyFileObservation = { text: string | null; commitOid: string | null; unreadable?: string } | undefined;

export async function recordRepoTeamPolicy(
  accountId: number,
  repoId: number,
  seen: PolicyFileObservation,
  nowMs = Date.now(),
): Promise<void> {
  if (seen === undefined) return;
  if (seen.text == null) {
    await db
      .delete(repoTeamPolicies)
      .where(and(eq(repoTeamPolicies.accountId, accountId), eq(repoTeamPolicies.repoId, repoId)))
      .execute();
    return;
  }
  const parsed =
    seen.unreadable != null
      ? { ok: false as const, errors: [seen.unreadable] }
      : Buffer.byteLength(seen.text, 'utf8') > TEAM_POLICY_MAX_BYTES
        ? {
            ok: false as const,
            errors: [`The file is larger than ${TEAM_POLICY_MAX_BYTES / 1024} KB.`],
          }
        : parseTeamPolicy(seen.text);
  const values = {
    policyJson: parsed.ok ? parsed.policy : null,
    errorsJson: parsed.ok ? [] : parsed.errors,
    commitOid: seen.commitOid,
    readAt: new Date(nowMs),
  };
  await db
    .insert(repoTeamPolicies)
    .values({ accountId, repoId, ...values })
    .onConflictDoUpdate({
      target: [repoTeamPolicies.accountId, repoTeamPolicies.repoId],
      set: { ...values },
    })
    .execute();
}

export interface StoredRepoTeamPolicy {
  repoId: number;
  policy: TeamPolicy | null;
  errors: string[];
  commitOid: string | null;
  readAt: Date;
}

/** The stored rows for these repos (no licence check: Settings shows them either way). */
export async function storedRepoTeamPolicies(accountId: number, repoIds: readonly number[]): Promise<Map<number, StoredRepoTeamPolicy>> {
  const out = new Map<number, StoredRepoTeamPolicy>();
  if (repoIds.length === 0) return out;
  const rows = await db
    .select()
    .from(repoTeamPolicies)
    .where(and(eq(repoTeamPolicies.accountId, accountId), inArray(repoTeamPolicies.repoId, [...repoIds])))
    .execute();
  for (const r of rows) {
    out.set(r.repoId, {
      repoId: r.repoId,
      policy: (r.policyJson as TeamPolicy | null) ?? null,
      errors: r.errorsJson ?? [],
      commitOid: r.commitOid,
      readAt: r.readAt,
    });
  }
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Read through the caller's context like the automation gate (`GateSource`); a fake context (no
 *  database, or a schema without the table) reads "no policy", so mocked tests drive their path. */
function sourceOf(on: GateSource | undefined): { d: any; t: any } | null {
  if (on == null) return { d: db, t: schema };
  const t = on.schema as any;
  if (on.db == null || t?.repoTeamPolicies == null || t?.pullRequests == null) return null;
  return { d: on.db, t };
}

async function storedPolicyOf(src: { d: any; t: any }, accountId: number, repoId: number): Promise<TeamPolicy | null> {
  const rp = src.t.repoTeamPolicies;
  const rows = (await src.d
    .select({ policy: rp.policyJson })
    .from(rp)
    .where(and(eq(rp.accountId, accountId), eq(rp.repoId, repoId)))
    .limit(1)
    .execute()) as Array<{ policy: unknown }>;
  return (rows[0]?.policy as TeamPolicy | null | undefined) ?? null;
}

/**
 * THE policy to obey for this repo's PRs, or null (no file, an invalid file, or this copy does not
 * unlock organisation features). Every enforcement point calls this or `effectivePrTeamPolicy`.
 */
export async function effectiveRepoTeamPolicy(
  accountId: number,
  repoId: number,
  on?: GateSource,
  nowMs = Date.now(),
): Promise<TeamPolicy | null> {
  const src = sourceOf(on);
  if (src == null) return null;
  const policy = await storedPolicyOf(src, accountId, repoId);
  if (policy == null) return null;
  return (await orgFeaturesUnlockedFor(accountId, nowMs)) ? policy : null;
}

/** The same, by PR id (scoped to the account: another account's PR, or an unknown one, reads null). */
export async function effectivePrTeamPolicy(
  accountId: number,
  prId: number,
  on?: GateSource,
  nowMs = Date.now(),
): Promise<TeamPolicy | null> {
  const src = sourceOf(on);
  if (src == null) return null;
  const pr = src.t.pullRequests;
  const rows = (await src.d
    .select({ repoId: pr.repoId })
    .from(pr)
    .where(and(eq(pr.id, prId), eq(pr.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ repoId: number }>;
  const repoId = rows[0]?.repoId;
  return repoId == null ? null : effectiveRepoTeamPolicy(accountId, repoId, on, nowMs);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The auto lane's one question: does this PR's repo's policy leave auto review on? */
export async function policyAllowsAutoReview(on: GateSource | undefined, accountId: number, prId: number): Promise<boolean> {
  return policyAllowsAutomation(await effectivePrTeamPolicy(accountId, prId, on), 'auto_review');
}

/**
 * May DEPENDENCY AUTOMATION act on this PR (approve, merge, rebase, resolve conflicts, AI fix)?
 * False when the repo's policy switches it off (`"automation": {"dependencies": false}`), or names
 * trusted bots and the PR's author is not one of them. Asked by `beginDependencyAction` before any
 * claim or write. Core db (dependency automation reads it directly).
 */
export async function dependencyActionAllowedByPolicy(accountId: number, prId: number): Promise<boolean> {
  const policy = await effectivePrTeamPolicy(accountId, prId);
  if (policy == null) return true;
  if (!policyAllowsAutomation(policy, 'dependencies')) return false;
  const trusted = policy.dependencies.trustedBots;
  if (trusted == null) return true;
  const { pullRequests, users } = schema;
  const row = (
    await db
      .select({ login: users.githubLogin })
      .from(pullRequests)
      .innerJoin(users, eq(users.id, pullRequests.authorId))
      .where(and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  return row != null && trusted.includes(row.login.toLowerCase());
}
