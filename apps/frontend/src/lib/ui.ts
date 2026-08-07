import type {
  AddressedConfidence,
  AddressedVerdict,
  AutomatedReviewerKind,
  CheckRunState,
  CiStatus,
  DerivedState,
  EventType,
  Mergeable,
  MergeStateStatus,
  MergeVerdict,
  MergeVerdictInfo,
  MlCategory,
  MlSeverity,
  MyTurnReason,
  PrReviewDecision,
  PrState,
  ReasonTag,
  ReviewBotKind,
  ThreadStateCounts,
  TimelinePr,
  User,
} from '@pierre-review/shared';
import { AI_CREDITS_PER_USD, reviewBotKind } from '@pierre-review/shared';

// AI cost is conveyed in CREDITS, never dollars (1¢ = 5 credits ⇒ $1 = 500 credits), to
// decouple the app's price from its underlying running cost. Raw USD stays in the data;
// format it as credits at the display edge. Used everywhere AI spend surfaces (Track usage,
// Claude Review) so the whole app is non-currency + consistent.
export function usdToCredits(usd: number): number {
  return Math.max(0, Math.round(usd * AI_CREDITS_PER_USD));
}

export interface StateMeta {
  label: string;
  color: string;
  description: string;
}

export const DERIVED_STATE_META: Record<DerivedState, StateMeta> = {
  untouched: {
    label: 'Untouched',
    color: '#ef4444',
    description: 'No reply, and no follow-up commit touched the file.',
  },
  replied_unresolved: {
    label: 'Replied',
    color: '#f59e0b',
    description:
      'Someone replied, but the thread is unresolved and no later commit touched the file.',
  },
  likely_addressed: {
    label: 'Likely addressed',
    color: '#3b82f6',
    description:
      'A commit touched this file after the last comment. Heuristic — it may be a false positive.',
  },
  resolved: {
    label: 'Resolved',
    color: '#22c55e',
    description: 'Marked resolved on GitHub.',
  },
};

// Deterministic "how sure are we the thread was addressed?" grade (Part A/B). Advisory — drives
// the confidence pill + confidence-aware bulk-resolve. Distinct hues from the state colors so the
// two badges read independently side by side.
export const CONFIDENCE_META: Record<AddressedConfidence, StateMeta> = {
  high: {
    label: 'High',
    color: '#16a34a',
    description:
      'Strong deterministic evidence the thread was addressed — GitHub marked the lines outdated AND a later commit touched them, or the bot itself confirmed/resolved it.',
  },
  medium: {
    label: 'Medium',
    color: '#d97706',
    description:
      'One change signal — a later commit touched the file, or GitHub marked the lines outdated (could be an unrelated edit or a rebase).',
  },
  low: {
    label: 'Low',
    color: '#94a3b8',
    description: 'Only a reply — no follow-up change detected.',
  },
  none: {
    label: 'None',
    color: '#94a3b8',
    description: 'No addressed signal.',
  },
};

// Pro Haiku "was it TRULY addressed?" verdict vocabulary (Part C). The SEMANTIC layer — rendered
// with a ✨ to distinguish it from the deterministic CONFIDENCE_META.
export const ADDRESSED_VERDICT_META: Record<AddressedVerdict, { label: string; color: string }> = {
  addressed: { label: 'Addressed', color: '#16a34a' },
  likely: { label: 'Likely addressed', color: '#3b82f6' },
  partial: { label: 'Partially addressed', color: '#d97706' },
  not_addressed: { label: 'Not addressed', color: '#ef4444' },
  unclear: { label: 'Unclear', color: '#94a3b8' },
};

// ML severity of a BOT comment (CORE, free tier) — the `severity-api` model's four classes.
// Its own hues, deliberately: this badge sits next to a StateBadge and a ConfidenceBadge in the
// same header, and three pills that share a palette read as one gradient rather than three
// independent facts. Raw hex, like every meta record here, because badges compose the colour at
// low opacity for the background (`${color}22`).
export const ML_SEVERITY_META: Record<MlSeverity, StateMeta> = {
  critical: {
    label: 'Critical',
    color: '#dc2626',
    description:
      'The model rates this the most serious class of finding. Advisory — CRITICAL is the class it under-recalls, so treat major+critical together as "high".',
  },
  major: {
    label: 'Major',
    color: '#ea580c',
    description: 'A substantive problem the model expects to need a real change.',
  },
  minor: {
    label: 'Minor',
    color: '#0284c7',
    description: 'A small but genuine issue.',
  },
  nit: {
    label: 'Nit',
    color: '#78716c',
    description: 'Trivial or optional — style, wording, preference.',
  },
};

// Human labels for the model's eight fixed categories. NOT `BotThemeCategory` (nine values, an
// LLM's vocabulary) — the two must not be mixed in one chart.
export const ML_CATEGORY_LABEL: Record<MlCategory, string> = {
  correctness_bug: 'Correctness',
  security: 'Security',
  performance: 'Performance',
  style_readability: 'Style',
  maintainability_refactor: 'Maintainability',
  testing: 'Testing',
  documentation: 'Docs',
  nitpick: 'Nitpick',
  praise: 'Praise',
};

export const PR_STATE_META: Record<PrState, { label: string; color: string }> = {
  open: { label: 'Open', color: '#3b82f6' },
  merged: { label: 'Merged', color: '#22c55e' },
  closed: { label: 'Closed', color: '#9ca3af' },
};

export const EVENT_META: Record<
  EventType,
  { label: string; color: string; shape: 'dot' | 'diamond' | 'triangle' | 'square' }
> = {
  pr_opened: { label: 'PR opened', color: '#3b82f6', shape: 'dot' },
  pr_merged: { label: 'PR merged', color: '#8957e5', shape: 'dot' },
  pr_closed: { label: 'PR closed', color: '#9ca3af', shape: 'dot' },
  pr_reopened: { label: 'PR reopened', color: '#3b82f6', shape: 'dot' },
  pr_ready_for_review: { label: 'Ready for review', color: '#3b82f6', shape: 'dot' },
  review_submitted: { label: 'Review', color: '#22c55e', shape: 'triangle' },
  review_comment: { label: 'Review comment', color: '#f59e0b', shape: 'dot' },
  pr_comment: { label: 'PR comment', color: '#a78bfa', shape: 'square' },
  commit_pushed: { label: 'Commit', color: '#6b7280', shape: 'diamond' },
};

// Reason tags: short label + colour + whether it's a "you" reason (gets the
// pulsing ring + my-turn grouping).
export const REASON_META: Record<
  ReasonTag,
  { label: string; color: string; myTurn: boolean }
> = {
  awaiting_your_review: { label: 'Awaiting your review', color: '#3b82f6', myTurn: true },
  your_pr_new_comments: { label: 'Your PR · new comments', color: '#22c55e', myTurn: true },
  ci_failing: { label: 'CI failing', color: '#ef4444', myTurn: false },
  merge_conflicts: { label: 'Merge conflicts', color: '#f97316', myTurn: false },
  approved_ready: { label: 'Approved · ready to merge', color: '#22c55e', myTurn: false },
  stalled: { label: 'Stalled', color: '#eab308', myTurn: false },
  untouched_threads: { label: 'Untouched threads', color: '#f59e0b', myTurn: false },
  in_progress: { label: 'In progress', color: '#9ca3af', myTurn: false },
};

// Why a feed item is "My Turn" — the reason pill on the card. `label` is the short pill
// text, `title` the hover explanation. See MyTurnReason (most-relevant first).
export const MY_TURN_REASON_META: Record<MyTurnReason, { label: string; title: string }> = {
  requested: {
    label: 'Review requested',
    title: 'A review was requested from you on this PR',
  },
  authored: { label: 'You authored', title: 'You opened this PR' },
  merged: { label: 'You merged', title: 'You merged this PR' },
  reviewed: { label: 'You reviewed', title: 'You previously reviewed this PR' },
  commented: { label: 'You commented', title: 'You previously commented on this PR' },
};

// Automated-reviewer vendors: display label + accent colour. Keyed by the shared
// AutomatedReviewerKind = ReviewBotKind ∪ 'in_house' ∪ 'pierre' (vendor classification lives
// in @pierre-review/shared reviewBotKind; presentation lives here). Drives the PrDetail
// "Bots" chip, the feed vendor tag, the bot-signal / bot-ROI cards, so a review-comment card
// reads "CodeRabbit flagged…" (or "In-house AI" / "Pierre · Claude") not a bare bot login.
export const BOT_VENDOR_META: Record<
  AutomatedReviewerKind,
  { label: string; color: string }
> = {
  coderabbit: { label: 'CodeRabbit', color: '#ff7a45' },
  greptile: { label: 'Greptile', color: '#16a34a' },
  copilot: { label: 'Copilot', color: '#8957e5' },
  qodo: { label: 'Qodo', color: '#7c3aed' },
  sourcery: { label: 'Sourcery', color: '#0d9488' },
  bito: { label: 'Bito', color: '#e11d48' },
  ellipsis: { label: 'Ellipsis', color: '#64748b' },
  korbit: { label: 'Korbit', color: '#2563eb' },
  baz: { label: 'Baz', color: '#db2777' },
  graphite: { label: 'Graphite', color: '#475569' },
  cursor: { label: 'Cursor', color: '#334155' },
  devin: { label: 'Devin', color: '#0891b2' },
  entelligence: { label: 'Entelligence', color: '#ca8a04' },
  deepsource: { label: 'DeepSource', color: '#0ea5e9' },
  github_code_quality: { label: 'GitHub Code Quality', color: '#4338ca' },
  github_advanced_security: { label: 'GitHub Advanced Security', color: '#b91c1c' },
  in_house: { label: 'In-house AI', color: '#6b7280' },
  // Generic proprietary vendor (user-classified, brand unknown) — neutral tint; like
  // in_house it is NOT branded, so buildBotColorMap gives each one a distinct palette hue.
  vendor: { label: 'Vendor', color: '#71717a' },
  pierre: { label: 'Limn · Claude', color: '#d97757' },
};

// Display meta for an automated-reviewer kind (vendor / in-house / Pierre). The one lookup
// for "how do I render this AutomatedReviewerKind" — used wherever a classified kind is in
// hand (bot-signal / bot-ROI cards, provenance badges, dedup rollups).
export function automatedReviewerMeta(kind: AutomatedReviewerKind): {
  label: string;
  color: string;
} {
  return BOT_VENDOR_META[kind];
}

// Classify a user (by login) as a known AI review bot → its vendor kind + display meta, or
// null for humans / non-review bots. The one call site for "is this actor a review bot".
export function botVendorMeta(
  user: Pick<User, 'githubLogin'> | null | undefined,
): { kind: ReviewBotKind; label: string; color: string } | null {
  const kind = reviewBotKind(user?.githubLogin);
  return kind ? { kind, ...BOT_VENDOR_META[kind] } : null;
}

// A curated categorical palette for bots that DON'T have a recognizable brand colour — every
// in-house bot, an unbranded reviewer, or a collision that needs breaking. 10 mid-tone hues
// spread across the wheel, each legible on both light and dark surfaces (used as chart strokes,
// small swatches, and text-on-10%-tint pills). ORDER MATTERS: buildBotColorMap assigns greedily
// from the front, so we lead with hues furthest from the most COMMON review-bot brand colours
// (CodeRabbit orange, Copilot/Qodo purple, Sourcery teal, Korbit blue, Greptile green) — this
// way the usual 1–3 in-house bots land on pink/lime/cyan, clearly distinct from the brands they
// sit beside, before we reach the brand-adjacent hues at the tail.
export const BOT_PALETTE: readonly string[] = [
  '#ec4899', // pink
  '#84cc16', // lime
  '#06b6d4', // cyan
  '#ef4444', // red
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#f59e0b', // amber
  '#14b8a6', // teal
  '#22c55e', // green
  '#f97316', // orange
] as const;

// The generic fallback tint for an automated reviewer we can't place (no login, roster not
// loaded yet) — the same neutral gray in_house has always used.
const BOT_FALLBACK_COLOR = BOT_VENDOR_META.in_house.color;

// The kinds that carry a distinctive BRAND colour worth preserving (recognition beats a
// palette slot). `in_house` (and anything unknown) is deliberately excluded — those are the
// bots that need a distinct palette colour instead of the shared gray.
function isBrandedKind(kind: AutomatedReviewerKind): boolean {
  return kind !== 'in_house' && kind !== 'vendor';
}

// Build a stable login → colour map for a roster of automated reviewers (brand-aware hybrid):
//   1. branded kinds (known vendors + Pierre) keep their BOT_VENDOR_META brand colour, and
//   2. in-house / unknown bots each get a DISTINCT palette colour (greedy, skipping any hue a
//      brand already claimed), so no two bots share a colour until the palette is exhausted.
// Keyed by login (unique per user) and seeded by a stable login sort, so a given bot resolves
// to the same colour across every surface + view (the map is account-wide, not per-view).
export function buildBotColorMap(
  roster: { login: string; kind: AutomatedReviewerKind }[],
): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  const sorted = [...roster].sort((a, b) => a.login.localeCompare(b.login));
  // Pass 1: branded vendors + Pierre claim their brand colour.
  for (const r of sorted) {
    if (map.has(r.login) || !isBrandedKind(r.kind)) continue;
    const c = BOT_VENDOR_META[r.kind].color;
    map.set(r.login, c);
    used.add(c.toLowerCase());
  }
  // Pass 2: in-house / unknown bots each take the next palette colour not already in use;
  // once the palette is exhausted, colours repeat (acceptable beyond the palette size).
  let cursor = 0;
  for (const r of sorted) {
    if (map.has(r.login)) continue;
    let chosen = BOT_PALETTE[cursor % BOT_PALETTE.length]!;
    for (let k = 0; k < BOT_PALETTE.length; k++) {
      const cand = BOT_PALETTE[(cursor + k) % BOT_PALETTE.length]!;
      if (!used.has(cand.toLowerCase())) {
        chosen = cand;
        cursor += k + 1;
        break;
      }
      if (k === BOT_PALETTE.length - 1) cursor += 1; // all used → cycle from the next slot
    }
    map.set(r.login, chosen);
    used.add(chosen.toLowerCase());
  }
  return map;
}

// Resolve one bot's colour: the account-wide map by login → its brand colour (branded kinds)
// → the neutral fallback. `login`/map absent (roster still loading) degrades to brand-by-kind,
// so a branded bot never flashes and an in-house bot briefly shows gray before its palette hue.
export function resolveBotColor(
  colorMap: Map<string, string>,
  bot: { login?: string | null; kind: AutomatedReviewerKind },
): string {
  if (bot.login) {
    const c = colorMap.get(bot.login);
    if (c) return c;
  }
  return isBrandedKind(bot.kind) ? BOT_VENDOR_META[bot.kind].color : BOT_FALLBACK_COLOR;
}

// The reason tags that make a PR "need attention" — mirrors the backend's
// ACTIVITY_ATTENTION_REASONS (db/queries.ts) so the per-PR ⚠ badge and the repo-level
// attentionCount agree exactly.
const ATTENTION_REASONS = new Set<ReasonTag>([
  'awaiting_your_review',
  'your_pr_new_comments',
  'ci_failing',
  'merge_conflicts',
  'untouched_threads',
]);

// Whether an open PR needs attention (your turn · stalled · untouched threads / CI /
// conflicts). Keep in lockstep with getActivity's attentionCount predicate.
export function prNeedsAttention(pr: {
  isStalled: boolean;
  threadCounts: ThreadStateCounts;
  reasonTag: ReasonTag;
}): boolean {
  return pr.isStalled || pr.threadCounts.untouched > 0 || ATTENTION_REASONS.has(pr.reasonTag);
}

// A PR's "volume of activity" proxy for the open-PR sort: how much discussion it has
// accumulated (total review threads across every state — untouched + replied + likely-
// addressed + resolved). Cheap (already on the lean TimelinePr) and monotonic in activity.
export function prActivityVolume(pr: TimelinePr): number {
  const c = pr.threadCounts;
  return c.untouched + c.replied_unresolved + c.likely_addressed + c.resolved;
}

// Order a repo's / scope's OPEN PRs for the Activity console lists. Precedence:
//   1. maintainer-authored first (prioritised so they land on the first page) —
//      `isMaintainerAuthor(pr)` = the PR's author has merge rights in the PR's repo,
//   2. recentness of activity (updatedAt, newest first),
//   3. volume of activity (prActivityVolume, most first),
//   4. PR number desc — a stable final tiebreak.
// Returns a sorted COPY (never mutates the input). Both Activity open-PR lists share this
// so the cross-repo Feed panel and the per-repo list order identically.
export function sortOpenPrsByActivity(
  prs: TimelinePr[],
  isMaintainerAuthor: (pr: TimelinePr) => boolean,
): TimelinePr[] {
  return [...prs].sort((a, b) => {
    const ma = isMaintainerAuthor(a) ? 0 : 1;
    const mb = isMaintainerAuthor(b) ? 0 : 1;
    if (ma !== mb) return ma - mb;
    // ISO-8601 strings sort chronologically under localeCompare; reverse for newest-first.
    const r = b.updatedAt.localeCompare(a.updatedAt);
    if (r !== 0) return r;
    const v = prActivityVolume(b) - prActivityVolume(a);
    if (v !== 0) return v;
    return b.number - a.number;
  });
}

// CI rollup → dot colour + label. `null` when there are no checks at all.
export const CI_META: Record<
  CiStatus,
  { label: string; color: string } | null
> = {
  success: { label: 'CI passing', color: '#22c55e' },
  failure: { label: 'CI failing', color: '#ef4444' },
  error: { label: 'CI error', color: '#ef4444' },
  pending: { label: 'CI running', color: '#eab308' },
  expected: { label: 'CI expected', color: '#9ca3af' },
  unknown: null,
};

// Should the PR Overview's "Checks" row render at all?
//
// Two independent reasons to show it, and the gate must not fire without one of them — `Row`
// always paints its uppercase label, so a row whose every child renders null is a bare "CHECKS"
// heading next to an empty column.
//
//  1. There are check runs to list.
//  2. CI is red but `checkRuns` did not hydrate (an expired/SAML-blocked token, a partial
//     statusCheckRollup, a head pushed since the last sync). The row then exists ONLY to carry
//     the CI-failure diagnosis — and that card is Pro (`CiAnalysisCard` returns null without the
//     prSummary capability), so on the free tier this branch can never produce content and MUST
//     NOT open the row. That is why the capability is an argument here rather than a detail of
//     the card: the row's visibility depends on its child's.
export function checksRowVisible(
  checkCount: number,
  ciStatus: CiStatus | null | undefined,
  prSummary: boolean,
): boolean {
  if (checkCount > 0) return true;
  return prSummary && (ciStatus === 'failure' || ciStatus === 'error');
}

// Per-check display: icon glyph + colour + short label.
export const CHECK_STATE_META: Record<
  CheckRunState,
  { label: string; color: string; icon: string }
> = {
  success: { label: 'passed', color: '#22c55e', icon: '✓' },
  failure: { label: 'failed', color: '#ef4444', icon: '✕' },
  pending: { label: 'running', color: '#eab308', icon: '•' },
  neutral: { label: 'neutral', color: '#9ca3af', icon: '–' },
  skipped: { label: 'skipped', color: '#9ca3af', icon: '⤼' },
  error: { label: 'error', color: '#ef4444', icon: '!' },
  unknown: { label: 'unknown', color: '#9ca3af', icon: '?' },
};

// ---- The ONE merge verdict --------------------------------------------------------------
//
// Everything that renders "can this land?" resolves it here. Before this existed, each
// surface combined GitHub's fields its own way and the PR-detail Overview read
// `mergeable === 'mergeable'` as a green "mergeable" — which is WRONG, and wrong on ~444 of
// the open PRs in a real database:
//
//   • `mergeable` reports ONLY merge-CONFLICT state (MERGEABLE / CONFLICTING / UNKNOWN). A PR
//     whose required checks are failing is still `mergeable: 'mergeable'`.
//   • `mergeStateStatus` is the branch-protection-aware field, and the one to lead with:
//       clean     — mergeable and passing
//       blocked   — protection unmet (required checks failing / required reviews missing)
//       unstable  — NON-required checks are red; GitHub WILL still merge it
//       behind    — the base moved and this repo requires up-to-date branches
//       dirty     — conflicts with the base
//       has_hooks — mergeable, with a pre-receive hook to run
//       unknown   — GitHub hasn't computed it yet
//     It is ACTOR-AGNOSTIC (it does not model an admin's bypass power), which is exactly why
//     it needs no branch-protection API call to be trustworthy.
//
// So: mergeStateStatus first, `mergeable` only as the conflict corroborator.
export interface MergeVerdictInput {
  mergeable: Mergeable;
  mergeStateStatus: MergeStateStatus;
  // Draft-ness is its own stored boolean — GitHub's MergeStateStatus.DRAFT is deliberately
  // not modelled in the enum (see sync/upsert.ts), so it is passed separately.
  isDraft?: boolean;
  // Names the review half of a `blocked` status when it's known (PrDetail carries it; the
  // lean timeline PR does not). Absent → the blocked reason stays generic, never invented.
  reviewDecision?: PrReviewDecision | null;
  // Out-of-band states only the live merge-options fetch knows about.
  inMergeQueue?: boolean;
  queuePosition?: number | null;
  autoMergeArmed?: boolean;
  // Commits behind the base, when known — turns "behind" into "3 commits behind".
  behindBy?: number;
}

function blockedDetail(decision: PrReviewDecision | null | undefined): string {
  switch (decision) {
    case 'review_required':
      return 'required reviews aren’t in yet';
    case 'changes_requested':
      return 'a reviewer requested changes';
    // Approved but still blocked ⇒ the review requirement is satisfied, so the blocker is
    // the other half of branch protection.
    case 'approved':
      return 'required checks aren’t passing';
    default:
      return 'required checks or reviews aren’t satisfied';
  }
}

const MERGE_STATE_STATUSES: readonly MergeStateStatus[] = [
  'clean',
  'dirty',
  'unstable',
  'blocked',
  'behind',
  'has_hooks',
  'unknown',
];

/**
 * Narrow a RAW mergeStateStatus string to the modelled enum. `PrMergeOptions` carries
 * GitHub's live REST value as a plain `string` (it can return values we don't model, e.g.
 * `draft`), so the live merge path funnels through this instead of casting.
 */
export function toMergeStateStatus(raw: string | null | undefined): MergeStateStatus {
  const lower = (raw ?? '').toLowerCase();
  return (MERGE_STATE_STATUSES as readonly string[]).includes(lower)
    ? (lower as MergeStateStatus)
    : 'unknown';
}

/**
 * Collapse GitHub's mergeability fields (+ the two out-of-band states) into ONE verdict.
 * Pure: same input, same answer, on every surface.
 */
export function mergeVerdict(pr: MergeVerdictInput): MergeVerdictInfo {
  const mss = pr.mergeStateStatus;

  // Out-of-band first — being in the queue or armed is the truest answer to "what happens
  // next", and both outrank the raw status they're waiting on.
  if (pr.inMergeQueue) {
    return {
      verdict: 'queued',
      label: 'in merge queue',
      tone: 'ok',
      canMerge: false,
      detail: pr.queuePosition != null ? `position ${pr.queuePosition}` : null,
    };
  }
  if (pr.autoMergeArmed) {
    return {
      verdict: 'armed',
      label: 'auto-merge armed',
      tone: 'ok',
      // Arming doesn't take the manual merge away — the user can still land it by hand.
      canMerge: true,
      detail: 'it lands by itself once the blockers clear',
    };
  }

  // Conflicts outrank draft: a conflicting draft still needs a human to resolve them, and
  // that is more actionable than "it's a draft".
  if (mss === 'dirty' || pr.mergeable === 'conflicting') {
    return {
      verdict: 'conflicts',
      label: 'conflicts',
      tone: 'bad',
      canMerge: false,
      detail: 'resolve the conflicts with the base branch',
    };
  }
  if (pr.isDraft) {
    return {
      verdict: 'draft',
      label: 'draft',
      tone: 'muted',
      canMerge: false,
      detail: 'mark it ready for review to merge',
    };
  }
  if (mss === 'blocked') {
    return {
      verdict: 'blocked',
      label: 'blocked',
      tone: 'bad',
      canMerge: false,
      detail: blockedDetail(pr.reviewDecision),
    };
  }
  if (mss === 'behind') {
    return {
      verdict: 'behind',
      label: 'behind base',
      tone: 'warn',
      // GitHub itself refuses the merge in this state (the repo requires up-to-date
      // branches), so offering a merge button would just produce a 405.
      canMerge: false,
      detail:
        pr.behindBy != null && pr.behindBy > 0
          ? `${pr.behindBy} commit${pr.behindBy === 1 ? '' : 's'} behind — update the branch first`
          : 'update the branch first',
    };
  }
  if (mss === 'unstable') {
    return {
      verdict: 'unstable',
      label: 'checks failing',
      tone: 'warn',
      // The load-bearing subtlety: 'unstable' means only NON-required checks are red, so
      // GitHub will merge it. Warn, don't block.
      canMerge: true,
      detail: 'some non-required checks are failing — GitHub will still merge it',
    };
  }
  if (mss === 'clean' || mss === 'has_hooks') {
    return {
      verdict: 'clean',
      label: 'ready to merge',
      tone: 'ok',
      canMerge: true,
      detail: null,
    };
  }
  // 'unknown': GitHub computes mergeability asynchronously and briefly reports nothing. We
  // render it honestly and do NOT kick off a repair pass — a background re-fetch on every
  // unknown would be a per-render GitHub call for a state that resolves itself.
  return {
    verdict: 'unknown',
    label: 'mergeability unknown',
    tone: 'muted',
    canMerge: false,
    detail: null,
  };
}

// Tailwind classes per tone, so every compact surface tints a verdict identically.
export const MERGE_TONE_CLASS: Record<MergeVerdictInfo['tone'], string> = {
  ok: 'text-green-600 dark:text-green-400',
  warn: 'text-orange-600 dark:text-orange-400',
  bad: 'text-red-600 dark:text-red-400',
  muted: 'text-gray-400 dark:text-gray-500',
};

// Chip backgrounds for the dense list rows (RepoOpenPrList).
export const MERGE_TONE_CHIP: Record<MergeVerdictInfo['tone'], string> = {
  ok: 'bg-green-500/15 text-green-700 dark:text-green-400',
  warn: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  bad: 'bg-red-500/15 text-red-600 dark:text-red-400',
  muted: 'bg-gray-500/10 text-gray-500 dark:text-gray-400',
};

// Which verdicts deserve the ⚠ on the COMPACT surfaces (open-PR rows, timeline tooltips).
// `blocked` joins conflicts/behind/unstable here — it is the whole point of the fix: a PR
// whose required checks are red used to render as plain "mergeable" with no warning at all.
const COMPACT_WARN_VERDICTS: ReadonlySet<MergeVerdict> = new Set<MergeVerdict>([
  'conflicts',
  'blocked',
  'behind',
  'unstable',
]);

// The subset a DRAFT may still fall back to. Deliberately narrower: these two are branch
// facts a human has to act on whether or not the PR is ready, so they survive the draft
// verdict. `blocked`/`unstable` do NOT — required reviews being absent is what "draft" means,
// and unstable's copy ("GitHub will still merge it") is a lie about a draft.
const DRAFT_COMPACT_WARN_VERDICTS: ReadonlySet<MergeVerdict> = new Set<MergeVerdict>([
  'conflicts',
  'behind',
]);

/**
 * The verdict a dense row should SHOW, or null when there is nothing worth the pixels
 * ('clean' / 'unknown' are already conveyed by the row's other affordances).
 *
 * Drafts are the trap: `mergeVerdict` returns 'draft' before it ever looks at behind/blocked,
 * and 'draft' isn't a compact warning — so a draft that was ALSO behind its base silently lost
 * its ⚠ on the timeline bar and the open-PR rows, which the verdict resolver's predecessor
 * (which had no draft branch at all) did show. Re-deriving with `isDraft` dropped recovers the
 * co-occurring condition for the compact surfaces ONLY; the main chain stays untouched, since
 * leading with 'draft' really is the most important fact about the PR everywhere else.
 */
export function mergeVerdictWarning(pr: MergeVerdictInput): MergeVerdictInfo | null {
  const info = mergeVerdict(pr);
  if (COMPACT_WARN_VERDICTS.has(info.verdict)) return info;
  if (info.verdict !== 'draft') return null;
  const underneath = mergeVerdict({ ...pr, isDraft: false });
  return DRAFT_COMPACT_WARN_VERDICTS.has(underneath.verdict) ? underneath : null;
}

// The verdicts the auto-merge watcher can WAIT OUT on its own: blocked/behind clear via CI,
// reviews or an update-branch; unknown resolves itself. Conflicts and drafts need a human
// push, which DISARMS the intent — advertising "merge when ready" there would promise a wait
// that can only end by cancelling itself. Deliberately the MergeVerdict vocabulary (no third
// "armable" enum beside canMerge / READY_MERGE_STATES).
const ARM_WAIT_VERDICTS: ReadonlySet<MergeVerdict> = new Set<MergeVerdict>([
  'blocked',
  'behind',
  'unknown',
]);

/**
 * Whether the dedicated "Merge when ready" control is worth offering — i.e. arming would DO
 * something the plain Merge button doesn't. True while a self-clearing blocker is in the way
 * (blocked / behind / unknown) OR when the PR is mergeable RIGHT NOW but trailing its base
 * (`canMerge && behindBy > 0` — arming updates from trunk first, then lands it). A fully
 * clean, up-to-date PR gets no button (arming it is just a delayed merge — press Merge).
 *
 * ⚠ `behindBy > 0` is true of MOST healthy PRs and only ever WIDENS this button's
 * eligibility. It must never gate the plain Merge button (only the 'behind' VERDICT —
 * mergeStateStatus — means GitHub is blocking), and the verdict passed here must never have
 * been fed `autoMergeArmed` ('armed' reports canMerge:true, which would make an armed PR
 * look like the clean-but-behind case).
 */
export function mergeWhenReadyEligible(input: {
  allowedByRepo: boolean;
  methodCount: number;
  queueEnabled: boolean;
  alreadyArmed: boolean;
  verdict: Pick<MergeVerdictInfo, 'verdict' | 'canMerge'>;
  behindBy: number;
}): boolean {
  if (!input.allowedByRepo || input.methodCount === 0 || input.queueEnabled || input.alreadyArmed) {
    return false;
  }
  if (ARM_WAIT_VERDICTS.has(input.verdict.verdict)) return true;
  return input.verdict.canMerge && input.behindBy > 0;
}

export function userLabel(user: User | undefined, fallbackId: number | null): string {
  if (user) return user.displayName || user.githubLogin;
  return fallbackId == null ? 'unknown' : `user ${fallbackId}`;
}

/** GitHub profile URL for a login (e.g. `octocat` → https://github.com/octocat). */
export function profileUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}`;
}

/**
 * Sanitise a URL that came from DATA before putting it in an `href` / `src`.
 *
 * React does NOT protect you here. `<a href={someUrl}>` renders whatever string it is given;
 * for a `javascript:` URL React 18 logs a console warning and then renders it anyway. So a
 * URL that arrived from GitHub is a script-execution sink one click wide.
 *
 * And plenty of these URLs are attacker-influenceable. `checkRuns[].url` is a check run's
 * `details_url` or a commit status's `target_url` — set by whatever third-party CI app posted
 * the status on a watched repository. Same class: ticket links derived from a configurable base
 * URL, and any `html_url` a future GraphQL field returns.
 *
 * The consequence is not theoretical: the dashboard origin is also the API origin, so script
 * running there can drive every write action (post a review, resolve threads, merge) with the
 * caller's own session — or, in local mode, with no credential needed at all.
 *
 * Returns undefined for anything that is not http(s), so `href={safeExternalUrl(u)}` renders a
 * plain non-navigating anchor rather than a live weapon. Callers that need a fallback can do
 * `safeExternalUrl(u) ?? pr.githubUrl`.
 */
export function safeExternalUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  let url: URL;
  try {
    // A relative URL is fine and stays relative — base only matters for parsing.
    url = new URL(trimmed, window.location.origin);
  } catch {
    return undefined;
  }
  // Allowlist, not blocklist: `javascript:`, `data:`, `vbscript:`, `blob:` and every future
  // scheme are rejected by default. mailto: is not used in a data-derived href anywhere.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return trimmed;
}

// Prefill for "replying" to a comment: GitHub issue comments are flat (no native
// reply threading), so a reply is a new comment that quotes the original as a `> `
// blockquote and @mentions its author. The user edits from there. Empty bodies
// (e.g. lean mode before hydration) just yield the bare mention.
export function buildQuotedReply(body: string | null, authorLogin: string | null): string {
  const mention = authorLogin ? `@${authorLogin} ` : '';
  const trimmed = (body ?? '').trim();
  if (trimmed === '') return mention;
  const quoted = trimmed
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${quoted}\n\n${mention}`;
}

export function indexUsers(users: User[] | undefined): Map<number, User> {
  const map = new Map<number, User>();
  for (const u of users ?? []) map.set(u.id, u);
  return map;
}

// Single source of truth for a plain calendar date. Locale-aware: the runtime
// locale decides field order + separators, so en-GB renders "02/05/2026" (dd/mm/
// yyyy) and en-US "05/02/2026" (mm/dd/yyyy). 2-digit day/month + 4-digit year give
// an unambiguous, stable-width date. Every date the app shows goes through here (or
// dateTime), so the format stays consistent everywhere.
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  const fmt = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (abs < min) return 'just now';
  if (abs < hr) return fmt(Math.round(diff / min), 'min');
  if (abs < day) return fmt(Math.round(diff / hr), 'hour');
  if (abs < 30 * day) return fmt(Math.round(diff / day), 'day');
  return formatDate(iso);
}

// Absolute date *with* time of day, e.g. "02/05/2026, 09:04" — used where the exact
// moment matters (the activity feed) rather than a fuzzy "4 days ago". The date part
// matches formatDate (locale-aware dd/mm/yyyy ordering) for consistency.
export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// (The "Watched repo" eye glyph — `WATCHED_TITLE` / `watchedGlyphHtml()` / its React twin
// `<WatchedBadge>` / the `.tl-repo-watch` rule — is DELETED along with the whole "watched"
// concept. A workspace IS the scope now, so every repo in one is fully live and there is no
// per-repo visibility state left for a badge to report.)
