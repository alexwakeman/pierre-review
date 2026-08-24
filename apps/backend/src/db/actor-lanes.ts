// WHO DID THE WORK — the seven lanes, resolved per user id for one workspace.
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
// ── WHY LANES AND NOT "BOT vs HUMAN" ─────────────────────────────────────────────────────────
//
// Because automation contaminates DIFFERENT metrics depending on what it does, and one bucket
// cannot tell those apart:
//
//   • a DEPENDENCY bot authors bumps   → distorts throughput, lead time, PR size
//   • a CODE AGENT authors real changes → distorts the same metrics and means the OPPOSITE
//   • a QUALITY GATE responds/approves  → distorts review counts and approvals
//   • an AI REVIEWER writes findings    → the only automation whose review volume means anything
//   • RELEASE automation merges/tags    → its merges are governance events, not work
//   • HOUSEKEEPING greets and labels    → pure noise in every one of the above
//
// "Your throughput is inflated by bumps" and "your approvals are automated" are different
// problems with different fixes, and a single `isBot` flag can state neither. The same workspace
// showed SonarQube posting 786 comments — every one of them a "Quality Gate Passed/Failed" badge
// — so folding its volume in with an AI reviewer's findings would report 786 pieces of feedback
// where there were none.
//
// The dependency/code-agent split is the one that most resists being collapsed back: both author
// pull requests, so any "bot vs human" view puts them together, and yet a merged Dependabot bump
// is overhead a team absorbed while a merged agent PR is work it shipped. A single "automation
// authored 40% of merges" figure that mixes them tells the reader nothing they can act on.
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
import type { ActorLane, ReviewerRole } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { roleForBotLogin } from '../sync/bot-detection.js';
import {
  automatedReviewerUserIds,
  classificationKindForUser,
  manualHumanUserIds,
  manualRoleUserIds,
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

// MIRRORED from `REVIEWER_ROLE_LANE` in @pierre-review/shared — the backend cannot import shared
// at RUNTIME (a value import fails the release build), so the map is spelled twice and
// `actor-lanes.test.ts` asserts the two are identical. It is deliberately 1:1: a user who picks
// "Release automation" and finds the actor filed under "Quality gate" has been told their choice
// did not take.
const ROLE_LANE: Record<ReviewerRole, Exclude<ActorLane, 'human'>> = {
  review: 'ai_review',
  quality_check: 'quality_gate',
  dependency: 'dependency',
  code_agent: 'code_agent',
  release: 'release',
  housekeeping: 'housekeeping',
};

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
 * by hand, and Copilot both reviews and (elsewhere) authors. Earlier rules win:
 *
 *   1. manual "this is a person"              → human          (nothing overrules it)
 *   2. no automation signal at all            → human
 *   3. MANUAL role                            → that role's lane
 *   4. known login vocabulary                 → that role's lane
 *   5. stored role other than 'review'        → that role's lane   (a seed we derived)
 *   6. vendor kind in AI_REVIEW_KINDS         → ai_review
 *   7. anything else automated                → quality_gate   (CI scripts, unknown apps)
 *
 * ⚠ RULES 3 AND 5 ARE THE SAME COLUMN READ TWICE, AND SPLITTING THEM IS THE POINT. `role` defaults
 * to `'review'`, so a stored `'review'` is ambiguous: it means "a person chose Review bot" on a
 * manual row and "we have never heard of this login" on every other. Collapsing the two either
 * ignores the user's choice (mark Copilot a code agent, watch the report keep calling it AI
 * review) or lets a stale default beat a login we positively recognise. `manualRoleUserIds`
 * carries the disambiguation, and it is automated-rows-only so a manual HUMAN cannot be handed a
 * bot lane by whatever role their row happens to carry.
 *
 * Rule 7 is deliberately NOT `ai_review`, and it is also NOT `housekeeping`: an unrecognised
 * automation is far more likely to be a CI script than a reviewer, and the cost of the mistakes is
 * asymmetric. Miscounting a script as a quality gate understates nothing anyone acts on;
 * miscounting it as an AI reviewer inflates the one number a team would use to judge whether their
 * review tooling is earning its licence, and filing it under housekeeping would quietly drop it
 * out of every count instead of merely declining to credit it.
 */
export async function resolveActorLanes(
  accountId: number,
  scope: BotScope,
): Promise<ActorLanes> {
  const [automatedFromWorkspace, kindMap, roleMap, vouchedHuman, manualRoles] = await Promise.all([
    automatedReviewerUserIds(accountId, scope.workspaceId, 'all'),
    classificationKindForUser(accountId, scope.workspaceId),
    reviewerRoleForUser(accountId, scope.workspaceId),
    manualHumanUserIds(accountId, scope.workspaceId),
    manualRoleUserIds(accountId, scope.workspaceId),
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
    // ONE call, not five predicates in an order this file gets to choose: the vocabularies are
    // asserted pairwise disjoint, so `roleForBotLogin` has exactly one answer per login.
    const loginRole = roleForBotLogin(login);
    // THE UNION (see the header). A login vocabulary hit counts on its own, which is what covers
    // the duplicated-identity row whose stored verdict says `automated: 0`.
    const automated = workspaceAutomated.has(id) || flaggedBotIds.has(id) || loginRole != null;
    if (!automated) continue;

    automatedIds.add(id);
    const manualRole = manualRoles.get(id);
    const storedRole = roleMap.get(id);
    const kind = kindMap.get(id);
    if (manualRole != null) lane.set(id, ROLE_LANE[manualRole]);
    else if (loginRole != null) lane.set(id, ROLE_LANE[loginRole]);
    // A DERIVED `'review'` is the default an unknown login gets, so it is not evidence and does
    // not short-circuit; every other derived role was positively concluded and does.
    else if (storedRole != null && storedRole !== 'review') lane.set(id, ROLE_LANE[storedRole]);
    else if (kind != null && AI_REVIEW_KINDS.has(kind)) lane.set(id, 'ai_review');
    else lane.set(id, 'quality_gate');
  }

  return {
    lane,
    automatedIds,
    laneOf: (userId) => (userId == null ? 'human' : (lane.get(userId) ?? 'human')),
  };
}
