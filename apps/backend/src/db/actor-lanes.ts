// WHO DID THE WORK — the four lanes, resolved per user id for one workspace.
//
// The period report's twelve metrics answer "what happened"; this answers "how much of it was a
// person". Both are needed, because on a real workspace the blend is severe enough to make the
// headline figures describe nobody:
//
//   BNG, one fortnight — 117 merged PRs, of which 46 were Dependabot.
//     median PR size: Dependabot 14 lines · humans 142 lines · REPORTED 68
//
//   That 68 is not a compromise between two numbers, it is a number no pull request in that
//   workspace resembled, and it understated real human PR size by 2.1×.
//
// ── WHY FOUR LANES AND NOT "BOT vs HUMAN" ────────────────────────────────────────────────────
//
// Because automation contaminates DIFFERENT metrics depending on what it does, and one bucket
// cannot tell those apart:
//
//   • a DEPENDENCY bot authors PRs   → distorts throughput, lead time, PR size
//   • a QUALITY GATE responds/approves → distorts review counts and approvals
//   • an AI REVIEWER writes findings   → the only automation whose review volume means anything
//
// "Your throughput is inflated by bumps" and "your approvals are automated" are different
// problems with different fixes, and a single `isBot` flag can state neither. The same workspace
// showed SonarQube posting 786 comments — every one of them a "Quality Gate Passed/Failed" badge
// — so folding its volume in with an AI reviewer's findings would report 786 pieces of feedback
// where there were none.
//
// ── THE DUPLICATE-IDENTITY DEFENCE ───────────────────────────────────────────────────────────
//
// Real accounts carry the SAME actor as two user rows with CONFLICTING flags: `dependabot` and
// `dependabot[bot]`, `github-actions` and `github-actions[bot]`. On the measured account one of
// each pair sat at `workspace_reviewers.automated = 0`, i.e. counted as a human. Merging the rows
// is not an option — they have different GitHub node ids and may be genuinely different accounts
// (an App vs a user of the same name) — so this resolver never trusts a single signal:
//
//   automated  ⇐  workspace verdict ∪ users.isBot ∪ the login vocabularies
//   human      ⇐  only when NO signal fires, or a human explicitly said so
//
// A genuine manual "this is a person" still wins (that rule is load-bearing elsewhere and is not
// weakened here); what does not win is the mere ABSENCE of an automated verdict.
import { inArray } from 'drizzle-orm';
import type { ActorLane } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { dependencyBot, qualityCheckBot } from '../sync/bot-detection.js';
import {
  automatedReviewerUserIds,
  classificationKindForUser,
  manualHumanUserIds,
  reviewerRoleForUser,
  type BotScope,
} from './queries.js';

const { users } = schema;

/** The vendor `kind`s that denote SUBSTANTIVE AI review, as opposed to a scanner wearing a vendor
 *  brand. Anything classified with one of these is in the `ai_review` lane even if its login is
 *  unknown to the local vocabulary — a user's manual vendor classification is a real judgement. */
const AI_REVIEW_KINDS = new Set<string>([
  'coderabbit',
  'greptile',
  'copilot',
  'qodo',
  'sourcery',
  'bito',
  'ellipsis',
  'korbit',
  'baz',
  'graphite',
  'cursor',
  'devin',
  'entelligence',
  'codex',
  // `vendor` = a generic proprietary reviewer a HUMAN classified when it wasn't a known brand.
  // That is a real judgement that the actor reviews, so it belongs here.
  'vendor',
]);

// ⚠ `in_house` IS NOT IN THAT SET, and the shared type's description ("the account's OWN AI")
// is not what the column actually holds. Measured on the live database: of 37 rows carrying
// `kind: 'in_house'`, 25 were assigned by `source: 'github_type'` — the fallback for "this is a
// GitHub App and we don't recognise the brand". That bucket contains sonarqubecloud,
// dependabot[bot], github-actions[bot], gitguardian, socket-security, google-cla and jit-ci.
// Not one of them is an AI reviewer.
//
// Treating it as one produced the exact failure this module exists to prevent: `github-actions`
// landed in `quality_gate` while `github-actions[bot]` — the SAME actor, second user row, the one
// carrying the `in_house` classification — landed in `ai_review`. One CI bot, two lanes, both
// under-counted, and the "is our AI review tooling earning its licence" number quietly inflated
// by 384 automated approvals.
//
// So an unbranded automation falls through to the `quality_gate` default. That is the asymmetric
// choice stated in `resolveActorLanes`: under-claiming an AI reviewer costs nothing anyone acts
// on, over-claiming one corrupts the single number a team would use to cancel a subscription.

export interface ActorLanes {
  /** Lane per user id, for every actor with a classification signal. Absent ⇒ `human`. */
  lane: Map<number, ActorLane>;
  /** Every id NOT in the human lane — the union automated set this resolver derived. */
  automatedIds: Set<number>;
  laneOf(userId: number | null | undefined): ActorLane;
}

/**
 * Resolve the lane of every actor that could appear in a workspace's metrics.
 *
 * ORDER IS THE CONTRACT, because the categories genuinely overlap — `github-advanced-security` is
 * a scanner with a vendor brand, SonarQube is a quality check that some accounts have classified
 * by hand. Earlier rules win:
 *
 *   1. no automation signal at all            → human
 *   2. stored role `quality_check`            → quality_gate   (an explicit human judgement)
 *   3. known dependency login                 → dependency
 *   4. known quality-check login              → quality_gate
 *   5. vendor kind in AI_REVIEW_KINDS         → ai_review
 *   6. anything else automated                → quality_gate   (CI scripts, github-actions)
 *
 * Rule 6 is deliberately NOT `ai_review`: an unrecognised automation is far more likely to be a
 * CI script than a reviewer, and the cost of the two mistakes is asymmetric. Miscounting a script
 * as a quality gate understates nothing anyone acts on; miscounting it as an AI reviewer inflates
 * the one number a team would use to judge whether their review tooling is earning its licence.
 */
export async function resolveActorLanes(
  accountId: number,
  scope: BotScope,
): Promise<ActorLanes> {
  const [automatedFromWorkspace, kindMap, roleMap, vouchedHuman] = await Promise.all([
    automatedReviewerUserIds(accountId, scope.workspaceId, 'all'),
    classificationKindForUser(accountId, scope.workspaceId),
    reviewerRoleForUser(accountId, scope.workspaceId),
    manualHumanUserIds(accountId, scope.workspaceId),
  ]);
  // ⚠ THE ONE SIGNAL THAT BEATS THE UNION. Widening automation detection to `users.isBot` and the
  // login vocabularies is what fixes the duplicated identities — and it also re-admits an actor a
  // person has explicitly marked human, because such an actor usually has a bot-ish login or a
  // stale global flag, which is exactly WHY someone corrected it by hand.
  const vouched = new Set(vouchedHuman);

  // The GLOBAL bot flag, which catches exactly what the workspace verdict misses: an actor nobody
  // has opened the Bots tab for, and the second row of a duplicated identity. `users` is a global
  // table, so this is read by id — never handed to a tenant.
  const flaggedBotIds = new Set<number>();
  const loginById = new Map<number, string>();
  const candidateIds = new Set<number>([...automatedFromWorkspace, ...kindMap.keys(), ...roleMap.keys()]);
  const botRows = await db
    .select({ id: users.id, login: users.githubLogin, isBot: users.isBot })
    .from(users)
    .where(inArray(users.isBot, [true]))
    .execute();
  for (const r of botRows) {
    flaggedBotIds.add(r.id);
    loginById.set(r.id, r.login);
    candidateIds.add(r.id);
  }
  // Logins for the workspace-classified ids the global flag did not cover.
  const missing = [...candidateIds].filter((id) => !loginById.has(id));
  if (missing.length > 0) {
    const rows = await db
      .select({ id: users.id, login: users.githubLogin })
      .from(users)
      .where(inArray(users.id, missing))
      .execute();
    for (const r of rows) loginById.set(r.id, r.login);
  }

  const workspaceAutomated = new Set(automatedFromWorkspace);
  const lane = new Map<number, ActorLane>();
  const automatedIds = new Set<number>();

  for (const id of candidateIds) {
    if (vouched.has(id)) continue; // a person said this is a person — nothing overrules that
    const login = loginById.get(id) ?? '';
    const isDependency = dependencyBot(login);
    const isQualityLogin = qualityCheckBot(login);
    // THE UNION (see the header). A login vocabulary hit counts on its own, which is what covers
    // the duplicated-identity row whose stored verdict says `automated: 0`.
    const automated =
      workspaceAutomated.has(id) || flaggedBotIds.has(id) || isDependency || isQualityLogin;
    if (!automated) continue;

    automatedIds.add(id);
    const role = roleMap.get(id);
    const kind = kindMap.get(id);
    if (role === 'quality_check') lane.set(id, 'quality_gate');
    else if (isDependency) lane.set(id, 'dependency');
    else if (isQualityLogin) lane.set(id, 'quality_gate');
    else if (kind != null && AI_REVIEW_KINDS.has(kind)) lane.set(id, 'ai_review');
    else lane.set(id, 'quality_gate');
  }

  return {
    lane,
    automatedIds,
    laneOf: (userId) => (userId == null ? 'human' : (lane.get(userId) ?? 'human')),
  };
}
