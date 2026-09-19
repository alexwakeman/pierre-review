// ── THE DEPENDENCIES TAB'S CARD HELPERS (CORE, pure, deterministic, no AI) ───────────────────
//
// Who opened a PR when it was automation, what a dependency PR's next step is, and the sentences
// its card says. `getWorkspaceInsights` (db/queries.ts) calls these while it folds the board, and
// `db/work-plan.ts` reads `dependencyProximityBase` to score the cards.
//
// ⚠ PURE ON PURPOSE (spec D15): no `db/client`, and no `db/triage` — which opens the DB client at
// load. `READY_MERGE_STATES.has()` is evaluated by the CALLER and handed in as `readyToMerge`, so
// every rule here is unit-tested without a database (dependency-cards.test.ts).
import type {
  AutomatedReviewerKind,
  CiStatus,
  DependencyPrState,
  DoNextProximityBase,
  Mergeable,
  MergeStateStatus,
  PrAutomation,
  PrReviewDecision,
  ReviewerRole,
} from '@pierre-review/shared';
import { DEPENDENCY_STATE_BASE, REVIEW_BOT_KINDS } from '@pierre-review/shared';
import { reviewBotKind, roleForBotLogin } from '../sync/bot-detection.js';
import { canonicalAdvisoryId } from '../sync/security-detect.js';
import { isConflicting, isRedCiStatus } from './pending-classify.js';

/** Everything the author resolution reads, resolved ONCE per fold. */
export interface AuthorAutomationInputs {
  /** The widened `hiddenBotUserIds` union for the workspace. */
  automatedIds: ReadonlySet<number>;
  /** `classificationKindForUser`. */
  kindOf: ReadonlyMap<number, AutomatedReviewerKind>;
  /** `manualRoleUserIds` — roles a PERSON chose (automated rows only). */
  manualRoleOf: ReadonlyMap<number, ReviewerRole>;
  /** `reviewerRoleForUser` — stored roles (derived or manual). */
  storedRoleOf: ReadonlyMap<number, ReviewerRole>;
  /** Login per author id (the fold's author ids only). */
  loginOf: ReadonlyMap<number, string>;
}

/**
 * WHO MADE THIS CHANGE, when it was automation. ONE function behind the card field, the lens side
 * and the Dependencies-tab membership, so the three cannot disagree.
 *
 *   1. `dependencyVendor` set (a tool's own marker on the PR)  → { role:'dependency', kind: vendor,
 *      source: author is automated ? 'account' : 'marker' }. The marker wins the ROLE even over an
 *      automated author with another role (Socket Fix / Frogbot run as github-actions).
 *   2. author null or not in `automatedIds`                     → null (a person; a manual "human"
 *      already removed the actor from the set).
 *   3. role = manualRoleOf ?? roleForBotLogin(login) ?? (reviewBotKind(login) ? 'review')
 *            ?? (stored role ≠ 'review' ? stored) ?? (kind ∈ REVIEW_BOT_KINDS ? 'review')
 *            ?? 'code_agent'
 *      ⚠ The last resort is `code_agent`, NOT `resolveActorLanes`' `quality_gate`: an unknown
 *      automation that OPENS a pull request writes code. Different question, deliberate divergence.
 *      ⚠ A DERIVED 'review' is the default an unknown login gets, so it is not evidence — the
 *      resolveActorLanes rule; every other stored role was positively concluded and wins.
 *   4. kind = kindOf.get(id) ?? null; source 'account'.
 */
export function authorAutomationFor(
  authorId: number | null,
  dependencyVendor: AutomatedReviewerKind | null,
  x: AuthorAutomationInputs,
): PrAutomation | null {
  const automated = authorId != null && x.automatedIds.has(authorId);
  if (dependencyVendor != null) {
    return { role: 'dependency', kind: dependencyVendor, source: automated ? 'account' : 'marker' };
  }
  if (!automated) return null;
  const login = x.loginOf.get(authorId) ?? null;
  const stored = x.storedRoleOf.get(authorId);
  const kind = x.kindOf.get(authorId) ?? null;
  const role: ReviewerRole =
    x.manualRoleOf.get(authorId) ??
    roleForBotLogin(login) ??
    (reviewBotKind(login) != null ? 'review' : null) ??
    (stored != null && stored !== 'review' ? stored : null) ??
    (kind != null && REVIEW_BOT_KINDS.has(kind) ? 'review' : null) ??
    'code_agent';
  return { role, kind, source: 'account' };
}

/** A dependency PR's next step, folded from its synced columns. FIRST MATCH WINS, in this order:
 *  conflicts (mergeStateStatus 'dirty' OR mergeable 'conflicting') → ci_red (ciStatus failure|error,
 *  and GitHub would not merge it) → behind (mss 'behind') → ready (`readyToMerge`, i.e.
 *  READY_MERGE_STATES.has(mss)) → needs_review (reviewDecision review_required|changes_requested) →
 *  blocked (mss 'blocked') → unknown. ⚠ NULL columns are NOT OBSERVED and fall through to `unknown`,
 *  never to `ready`.
 *  ⚠ A RED BUILD GITHUB WOULD STILL MERGE IS `ready`: `unstable` means only NON-required checks are
 *  red, and it is mergeable (`mergeVerdict()`, READY_MERGE_STATES). So this card and a person's
 *  `merge` card say one thing about one state — "Can land now, but non-required checks are red". */
export function dependencyPrState(p: {
  mergeStateStatus: MergeStateStatus | null;
  mergeable: Mergeable | null;
  ciStatus: CiStatus | null;
  reviewDecision: PrReviewDecision | null;
  readyToMerge: boolean;
}): DependencyPrState {
  if (isConflicting(p)) return 'conflicts';
  if (isRedCiStatus(p.ciStatus) && !p.readyToMerge) return 'ci_red';
  if (p.mergeStateStatus === 'behind') return 'behind';
  if (p.readyToMerge) return 'ready';
  if (p.reviewDecision === 'review_required' || p.reviewDecision === 'changes_requested') {
    return 'needs_review';
  }
  if (p.mergeStateStatus === 'blocked') return 'blocked';
  return 'unknown';
}

/** The state as a sentence. CODE-WRITTEN, TIME-FREE (the forward-card rule — it is hashed nowhere
 *  today, but it is the ranker's `reason` shape), and it says what the state chip beside it cannot.
 *  `readyDetail` is the caller's `mergeCardDetail('merge', mss, 0)`, so a ready dependency PR and a
 *  `merge` card say the same sentence. */
export function dependencyStateDetail(
  state: DependencyPrState,
  p: {
    baseRefName: string | null;
    mergeStateStatus: MergeStateStatus | null;
    reviewDecision: PrReviewDecision | null;
  },
  readyDetail: string,
): string {
  switch (state) {
    case 'conflicts':
      return `Conflicts with ${p.baseRefName ?? 'the base branch'}`;
    case 'ci_red':
      return 'CI is failing';
    case 'behind':
      return 'GitHub blocks the merge until the branch is updated';
    case 'ready':
      return readyDetail;
    case 'needs_review':
      return p.reviewDecision === 'changes_requested'
        ? 'Changes were requested'
        : 'Needs an approving review';
    case 'blocked':
      return 'Required checks or reviews aren’t satisfied';
    case 'unknown':
      return 'GitHub has not worked out if it can merge this yet';
  }
}

/** The security sentence for a proven fix PR, or '' — when only alerts put the card here, and for
 *  an INFERRED fix, whose header already says "Likely security fix" (a sentence could only repeat it,
 *  or explain what we cannot know; the why lives in the card's info popover). `advisoryIds` are the
 *  ids the FIX names (the PR's own markers) — never an alert's, which the PR may not fix. */
export function securityFixDetail(
  fix: 'proven' | 'inferred' | null,
  advisoryIds: readonly string[],
): string {
  if (fix == null || fix === 'inferred') return '';
  const [first] = advisoryIds;
  if (first == null) return 'Fixes a known security advisory';
  const more = advisoryIds.length - 1;
  return more > 0 ? `Fixes ${first} and ${more} more` : `Fixes ${first}`;
}

/** Every id a security card names, as the wire carries it: complete up to this safety cap — the
 *  detector's own per-PR cap — so a reader knows the list is whole below it. */
const ADVISORY_IDS_MAX = 50;

/** Fix ids first, then each alert's ids, canonical, deduplicated, capped at the 50-id safety cap. */
export function unionAdvisoryIds(
  fixIds: readonly string[],
  alerts: readonly { advisoryIds: readonly string[] }[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...fixIds, ...alerts.flatMap((a) => a.advisoryIds)]) {
    const id = canonicalAdvisoryId(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= ADVISORY_IDS_MAX) break;
  }
  return out;
}

/** Where a Dependencies-tab card starts on the Do next scale. `state` null = a person's PR a
 *  security tool flagged (no merge row of its own) → 'security_alert'. 'ready' splits on approval
 *  exactly like a `merge` card. Everything else reads DEPENDENCY_STATE_BASE. */
export function dependencyProximityBase(
  state: DependencyPrState | null,
  approvals: number,
): DoNextProximityBase {
  if (state == null) return 'security_alert';
  if (state === 'ready') return approvals > 0 ? 'merge_approved' : 'merge_unapproved';
  return DEPENDENCY_STATE_BASE[state];
}
