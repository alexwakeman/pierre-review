// API types shared between frontend and backend.
// All timestamps are ISO-8601 strings over the wire.

export type DerivedState =
  | 'resolved'
  | 'likely_addressed'
  | 'replied_unresolved'
  | 'untouched';

export const DERIVED_STATES: DerivedState[] = [
  'untouched',
  'replied_unresolved',
  'likely_addressed',
  'resolved',
];

// Deterministic "how confident are we that the thread was addressed?" grade, computed at sync
// time alongside derivedState (see sync/derive-thread-state.ts). ADDITIVE to the 4-state
// contract — nothing keys off it for eligibility; it's advisory for confident bulk-resolve and
// the input signal to the Pro "truly addressed?" check. `none` = no addressed signal.
export type AddressedConfidence = 'none' | 'low' | 'medium' | 'high';

export const ADDRESSED_CONFIDENCES: AddressedConfidence[] = [
  'none',
  'low',
  'medium',
  'high',
];

export type PrState = 'open' | 'merged' | 'closed';

// PR status as exposed by the top-level filter. Derived from (state, isDraft):
// draft = open & isDraft, open = open & ready, merged, closed.
export type PrStatus = 'draft' | 'open' | 'merged' | 'closed';

export const PR_STATUSES: PrStatus[] = ['draft', 'open', 'merged', 'closed'];

export type ReviewState =
  | 'approved'
  | 'changes_requested'
  | 'commented'
  | 'dismissed'
  | 'pending';

// The review verdicts filterable in the timeline's Events panel — the ones that emit
// a `review_submitted` marker. 'pending' never submits an event, so it's excluded.
// Order is the UI display order.
export const REVIEW_FILTER_STATES: ReviewState[] = [
  'approved',
  'changes_requested',
  'commented',
  'dismissed',
];

export type EventType =
  | 'pr_opened'
  | 'pr_merged'
  | 'pr_closed'
  | 'pr_reopened'
  | 'pr_ready_for_review'
  | 'review_submitted'
  | 'review_comment'
  | 'pr_comment'
  | 'commit_pushed';

export const EVENT_TYPES: EventType[] = [
  'pr_opened',
  'pr_merged',
  'pr_closed',
  'pr_reopened',
  'pr_ready_for_review',
  'review_submitted',
  'review_comment',
  'pr_comment',
  'commit_pushed',
];

// Coarse buckets used for the event-type filter toggles in the UI.
export type EventCategory =
  | 'lifecycle'
  | 'reviews'
  | 'review_comments'
  | 'pr_comments'
  | 'commits';

export const EVENT_CATEGORY_BY_TYPE: Record<EventType, EventCategory> = {
  pr_opened: 'lifecycle',
  pr_merged: 'lifecycle',
  pr_closed: 'lifecycle',
  pr_reopened: 'lifecycle',
  pr_ready_for_review: 'lifecycle',
  review_submitted: 'reviews',
  review_comment: 'review_comments',
  pr_comment: 'pr_comments',
  commit_pushed: 'commits',
};

export interface User {
  id: number;
  githubLogin: string;
  displayName: string | null;
  avatarUrl: string | null;
  isBot: boolean;
}

// One row of the "@mention" autocomplete (both mention routes return these).
// `isMaintainer` is the SAME "has merged a PR here" proxy for merge rights that the
// timeline row labels, UserName and the member picker shield — computed server-side
// because only the route knows the context's repos (the PR's repo / the workspace's
// repo set), and the picker's own hosts (a ThreadCard reply box eight mounts deep)
// carry no repo id. The picker sorts these first, so maintainers can never be cut by
// its suggestion cap, and badges them with the shield.
export interface MentionCandidate extends User {
  isMaintainer: boolean;
}

// ── Third-party AI review bots ────────────────────────────────────────────────
// Pierre is "the calm layer above your review bot": it classifies which vendor an
// AI reviewer belongs to so its firehose can be triaged, not just excluded as noise.
// The kind is the vendor; display label/colour live in the frontend (lib/ui.ts
// BOT_VENDOR_META) so shared stays presentation-free.
//
// The backend cannot import this map at runtime (shared isn't shipped server-side —
// see the `REASON_PRIORITY` note in db/queries.ts), so it keeps a LOCAL copy in
// sync/bot-detection.ts; `bot-detection.test.ts` asserts the two stay in lockstep.
export type ReviewBotKind =
  | 'coderabbit'
  | 'greptile'
  | 'copilot'
  | 'qodo'
  | 'sourcery'
  | 'bito'
  | 'ellipsis'
  | 'korbit'
  | 'baz'
  | 'graphite'
  | 'cursor'
  | 'devin'
  | 'entelligence'
  | 'deepsource'
  | 'github_code_quality'
  | 'github_advanced_security'
  | 'codex';

// Bare GitHub login (lowercased, `[bot]` suffix stripped) → vendor. Verified 2026-07
// against each vendor's GitHub Marketplace listing / a live PR (App slugs, not mention
// handles). Login churn is covered by keeping every historical variant.
//
// Deliberately EXCLUDED (verified, not oversights): coding agents that AUTHOR PRs
// rather than review them — `sweep-ai`, `copilot-swe-agent` — and dependency/CI
// automation — `dependabot`, `renovate`, `snyk-bot`, `github-actions`. Those are still
// `isBot`, just not *review* bots, so they never carry a vendor triage badge.
export const REVIEW_BOTS: Record<string, ReviewBotKind> = {
  coderabbitai: 'coderabbit',
  'greptile-apps': 'greptile',
  'copilot-pull-request-reviewer': 'copilot',
  // Qodo (formerly CodiumAI): current + historical hosted logins.
  'qodo-ai': 'qodo',
  'qodo-merge': 'qodo',
  'qodo-merge-pro': 'qodo',
  'qodo-merge-for-open-source': 'qodo',
  'codiumai-pr-agent-free': 'qodo',
  'sourcery-ai': 'sourcery',
  'bito-code-review': 'bito',
  'ellipsis-dev': 'ellipsis',
  'korbit-ai': 'korbit',
  'baz-reviewer': 'baz',
  'graphite-app': 'graphite', // Diamond posts under the shared graphite-app account
  cursor: 'cursor', // Cursor Bugbot (app slug 'cursor', NOT 'bugbot')
  'devin-ai-integration': 'devin',
  'entelligence-ai-pr-reviews': 'entelligence',
  // DeepSource — GitHub App slug `deepsource-io` (inline review posts as
  // `deepsource-io[bot]`); `deepsourcebot` is the legacy machine-user alias.
  'deepsource-io': 'deepsource',
  deepsourcebot: 'deepsource',
  // GitHub Code Quality (GA 2026-07-20) — CodeQL rule findings + coverage summaries.
  'github-code-quality': 'github_code_quality',
  // GitHub Advanced Security — code-scanning / secret-scanning + AI security detections.
  'github-advanced-security': 'github_advanced_security',
  // OpenAI Codex — GitHub App slug `chatgpt-codex-connector` (verified 2026-08 against live
  // review comments in this account's corpus). NOT `codex` and NOT `openai`: both exist as
  // ordinary GitHub user accounts owned by other people, and `codex` is present in this very
  // database as a human, so matching on the brand word would misclassify a person as a vendor.
  'chatgpt-codex-connector': 'codex',
};

// Classify a login as a known AI review bot's vendor, or null. Normalises case + the
// `[bot]` suffix so it matches whether the login arrived via GraphQL (bare slug) or
// REST (`slug[bot]`).
export function reviewBotKind(login: string | null | undefined): ReviewBotKind | null {
  if (!login) return null;
  const slug = login.toLowerCase().replace(/\[bot\]$/, '');
  return REVIEW_BOTS[slug] ?? null;
}

// ── THE AUTOMATION VENDOR TABLE — one row per login, carrying BOTH facts ─────────────────────
//
// `REVIEW_BOTS` above owns the AI-reviewer family. This owns every other kind of automation that
// touches a pull request, and it is ONE table rather than five login sets plus a parallel
// login→kind map, because a login has exactly one identity and one default role and those are
// facts about the same key. Two tables keyed by login is precisely the "a fact lives at ONE
// grain" trap this codebase has paid for before: the second one drifts, and nothing detects it.
//
// ⚠ WHY THE `kind` COLUMN EXISTS AT ALL. Before this, every automation that was not an AI
// reviewer resolved to `kind: 'in_house'` via the classifier's githubType fallback — the bucket
// literally labelled "In-house AI". On the dev corpus that bucket held sonarqubecloud,
// dependabot[bot], github-actions[bot], gitguardian, socket-security, google-cla and jit-ci: 25
// of 37 such rows. Every one of them rendered as "In-house AI" with the same grey chip, so a user
// could not tell their SonarQube from their CLA bot on the screen that exists to classify them.
//
// `role` is the DEFAULT role for the login (see `ReviewerRole`); a human's choice always wins.
// `kind` is the vendor identity — orthogonal to role, and a login may legitimately appear in
// `REVIEW_BOTS` too when the same brand does both jobs. Where it does, the two tables MUST agree
// on the kind; `bot-detection.test.ts` asserts that rather than leaving it to a reader.
export const AUTOMATION_VENDORS: Record<
  string,
  { kind: AutomatedReviewerKind; role: ReviewerRole }
> = {
  // ── Dependency & version bumps ───────────────────────────────────────────────────────────
  // Measured: Dependabot was 46 of 117 merged PRs in one fortnight (39%), and because its PRs are
  // tiny and merge fast it dragged the reported median PR size to 68 lines — a blend of its own
  // 14 and the humans' 142, describing no pull request anyone had written.
  dependabot: { kind: 'dependabot', role: 'dependency' },
  'dependabot-preview': { kind: 'dependabot', role: 'dependency' },
  renovate: { kind: 'renovate', role: 'dependency' },
  'renovate-bot': { kind: 'renovate', role: 'dependency' },
  'snyk-bot': { kind: 'snyk', role: 'dependency' },
  'pyup-bot': { kind: 'pyup', role: 'dependency' },
  greenkeeper: { kind: 'greenkeeper', role: 'dependency' },
  depfu: { kind: 'depfu', role: 'dependency' },

  // ── Quality gates, scanners and CI ───────────────────────────────────────────────────────
  // They post VERDICTS, not findings: all 786 of SonarQube's comments on the measured workspace
  // were "Quality Gate Passed/Failed", so reading their volume as review substance reports
  // hundreds of pieces of feedback where there were none.
  sonarqubecloud: { kind: 'sonarqube', role: 'quality_check' },
  sonarcloud: { kind: 'sonarqube', role: 'quality_check' },
  codecov: { kind: 'codecov', role: 'quality_check' },
  codeclimate: { kind: 'codeclimate', role: 'quality_check' },
  'codefactor-io': { kind: 'codefactor', role: 'quality_check' },
  'houndci-bot': { kind: 'hound', role: 'quality_check' },
  coveralls: { kind: 'coveralls', role: 'quality_check' },
  'codacy-bot': { kind: 'codacy', role: 'quality_check' },
  // ⚠ `github-actions` held 385 submitted reviews and 3,116 comments across its two user rows
  // while roled 'review' — the largest "AI reviewer" in the account's ROI table was a CI runner.
  'github-actions': { kind: 'github_actions', role: 'quality_check' },
  'jit-ci': { kind: 'jit', role: 'quality_check' },
  'socket-security': { kind: 'socket', role: 'quality_check' },
  gitguardian: { kind: 'gitguardian', role: 'quality_check' },
  'semgrep-app': { kind: 'semgrep', role: 'quality_check' },
  'trunk-io': { kind: 'trunk', role: 'quality_check' },

  // ── Code agents — automation that WRITES CODE that is not a version bump ─────────────────
  // The category that did not exist when the first lists were written and now matters most. A
  // dependency bot and a coding agent both author PRs, so a bot-vs-human split files them
  // together — and yet a merged bump is overhead a team absorbed while a merged agent PR is work
  // it shipped. "Automation authored 40% of merges" is unreadable until you know which.
  //
  // Devin keeps its existing `devin` kind from REVIEW_BOTS (same brand, one identity) and gains
  // the role that says what it actually does.
  'devin-ai-integration': { kind: 'devin', role: 'code_agent' },
  'sweep-ai': { kind: 'sweep', role: 'code_agent' },
  'codegen-sh': { kind: 'codegen', role: 'code_agent' },
  'deepsource-autofix': { kind: 'deepsource_autofix', role: 'code_agent' },
  'pre-commit-ci': { kind: 'pre_commit_ci', role: 'code_agent' },
  'restyled-io': { kind: 'restyled', role: 'code_agent' },
  imgbot: { kind: 'imgbot', role: 'code_agent' },
  imgbotapp: { kind: 'imgbot', role: 'code_agent' },
  'transifex-integration': { kind: 'transifex', role: 'code_agent' },
  'crowdin-bot': { kind: 'crowdin', role: 'code_agent' },
  mintlify: { kind: 'mintlify', role: 'code_agent' },
  allstar: { kind: 'allstar', role: 'code_agent' },

  // ── Release & merge automation ───────────────────────────────────────────────────────────
  // Neither inspects nor reports on the code: it ACTS on the repository once other conditions are
  // met. A merge-queue bot can be the recorded merger of a large share of a repo's PRs, which is
  // why "who merged this" is never a proxy for "who did the work".
  mergify: { kind: 'mergify', role: 'release' },
  kodiak: { kind: 'kodiak', role: 'release' },
  kodiakhq: { kind: 'kodiak', role: 'release' },
  bulldozer: { kind: 'bulldozer', role: 'release' },
  'release-please': { kind: 'release_please', role: 'release' },
  releaser: { kind: 'release_please', role: 'release' },
  'semantic-release': { kind: 'semantic_release', role: 'release' },
  'semantic-release-bot': { kind: 'semantic_release', role: 'release' },
  'release-drafter': { kind: 'release_drafter', role: 'release' },
  'changeset-bot': { kind: 'changesets', role: 'release' },
  changesets: { kind: 'changesets', role: 'release' },
  autorelease: { kind: 'release_please', role: 'release' },
  'lumberbot-app': { kind: 'backport', role: 'release' },
  meeseeksdev: { kind: 'backport', role: 'release' },
  backport: { kind: 'backport', role: 'release' },

  // ── Housekeeping — process, compliance and metadata, never the code ──────────────────────
  // The long tail, defined by its volume being PURE NOISE in every review metric: a CLA bot's
  // comment on every first-time contribution is indistinguishable, to a comment counter, from a
  // reviewer finding a bug.
  'cla-bot': { kind: 'cla_assistant', role: 'housekeeping' },
  'cla-assistant': { kind: 'cla_assistant', role: 'housekeeping' },
  claassistant: { kind: 'cla_assistant', role: 'housekeeping' },
  'google-cla': { kind: 'google_cla', role: 'housekeeping' },
  googlebot: { kind: 'google_cla', role: 'housekeeping' },
  'facebook-github-bot': { kind: 'meta_cla', role: 'housekeeping' },
  dco: { kind: 'dco', role: 'housekeeping' },
  stale: { kind: 'stale_bot', role: 'housekeeping' },
  welcome: { kind: 'welcome_bot', role: 'housekeeping' },
  lock: { kind: 'lock_bot', role: 'housekeeping' },
  allcontributors: { kind: 'allcontributors', role: 'housekeeping' },
  'semantic-pull-request': { kind: 'semantic_pr', role: 'housekeeping' },
  sizebot: { kind: 'sizebot', role: 'housekeeping' },
  'react-sizebot': { kind: 'sizebot', role: 'housekeeping' },
  'diffray-bot': { kind: 'sizebot', role: 'housekeeping' },
  'codesandbox-ci': { kind: 'codesandbox', role: 'housekeeping' },
  netlify: { kind: 'netlify', role: 'housekeeping' },
  vercel: { kind: 'vercel', role: 'housekeeping' },
  'gitpod-io': { kind: 'gitpod', role: 'housekeeping' },
};

/** Normalise a login the way every vocabulary here matches it: lowercased, `[bot]` suffix
 *  stripped. The suffix stripping is load-bearing — `dependabot` and `dependabot[bot]` are
 *  SEPARATE `users` rows with different GitHub node ids on real accounts, and a lookup that
 *  covers one spelling and not the other splits one actor across two roles. */
export function normalizeBotLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, '');
}

/** The vendor identity of a non-review automation, or null. Orthogonal to `reviewBotKind`, which
 *  answers the narrower "is this an AI reviewer" and must NOT be widened to cover these. */
export function automationVendorKind(
  login: string | null | undefined,
): AutomatedReviewerKind | null {
  if (!login) return null;
  return AUTOMATION_VENDORS[normalizeBotLogin(login)]?.kind ?? null;
}

/** The DEFAULT role a login implies, or null when no vocabulary claims it. Null is not "it
 *  reviews" — see `defaultRoleFor` and `resolveActorLanes`, which fall back differently on
 *  purpose. */
export function roleForAutomationLogin(login: string | null | undefined): ReviewerRole | null {
  if (!login) return null;
  return AUTOMATION_VENDORS[normalizeBotLogin(login)]?.role ?? null;
}

const loginsWithRole = (role: ReviewerRole): ReadonlySet<string> =>
  new Set(Object.entries(AUTOMATION_VENDORS).filter(([, v]) => v.role === role).map(([k]) => k));

// The per-family login sets, DERIVED from the table above rather than restated beside it.
//
// ⚠ Deriving them is what makes the families disjoint BY CONSTRUCTION. They used to be five
// hand-written sets, which made "no login appears in two of them" a property a test had to check
// and a contributor had to remember — and the order the predicates were tried in silently decided
// the answer whenever it was violated. A login now appears exactly once, so there is nothing to
// get wrong and no precedence to reason about.
// Static analysis, coverage, scanners and CI. Deliberately EXCLUDED even though they are
// arguably quality-check tools: `deepsource-io`, `github-code-quality`,
// `github-advanced-security` — all three are already named `ReviewBotKind` vendors with rows in
// existing dashboards, so re-roling them would silently move numbers on upgrade. They stay
// `review` and remain user-flippable.
export const QUALITY_CHECK_BOTS: ReadonlySet<string> = loginsWithRole('quality_check');
export const DEPENDENCY_BOTS: ReadonlySet<string> = loginsWithRole('dependency');
export const CODE_AGENT_BOTS: ReadonlySet<string> = loginsWithRole('code_agent');
export const RELEASE_BOTS: ReadonlySet<string> = loginsWithRole('release');
export const HOUSEKEEPING_BOTS: ReadonlySet<string> = loginsWithRole('housekeeping');

/** True when a login is a known quality-check automation. */
export function qualityCheckBot(login: string | null | undefined): boolean {
  return roleForAutomationLogin(login) === 'quality_check';
}

/** True when a login is a known dependency automation. */
export function dependencyBot(login: string | null | undefined): boolean {
  return roleForAutomationLogin(login) === 'dependency';
}

/** True when a login is a known code-authoring automation. */
export function codeAgentBot(login: string | null | undefined): boolean {
  return roleForAutomationLogin(login) === 'code_agent';
}

/** True when a login is a known release / merge automation. */
export function releaseBot(login: string | null | undefined): boolean {
  return roleForAutomationLogin(login) === 'release';
}

/** True when a login is a known housekeeping automation. */
export function housekeepingBot(login: string | null | undefined): boolean {
  return roleForAutomationLogin(login) === 'housekeeping';
}

// ── The seven lanes ──────────────────────────────────────────────────────────────────────────
//
// Classified by WHAT AN ACTOR DOES, not by what it is, because that is what decides which metrics
// it contaminates. Lumping all automation into one bucket cannot distinguish "your throughput is
// inflated by dependency bumps" from "your approvals are automated" — different problems with
// different fixes.
export type ActorLane =
  | 'human'
  /** Substantive AI review — CodeRabbit, Copilot, Greptile, Cursor, Sourcery… (`REVIEW_BOTS`). */
  | 'ai_review'
  /** Quality gates, scanners and CI — SonarQube, Codecov, github-actions. Post status and
   *  approvals rather than findings, so their VOLUME must never be read as review substance:
   *  on the workspace above, all 786 of SonarQube's comments were "Quality Gate Passed/Failed". */
  | 'quality_gate'
  /** Dependency automation — authors version bumps, never reviews (`DEPENDENCY_BOTS`). */
  | 'dependency'
  /** Automation that WRITES CODE — agents, autofix, generated-content sync (`CODE_AGENT_BOTS`).
   *  Authors PRs like a dependency bot but means the opposite thing about a team, which is why
   *  the two are never one bucket. */
  | 'code_agent'
  /** Merge queues, release trains, changelog + version bumpers, backporters (`RELEASE_BOTS`).
   *  Moves code without writing or judging any. */
  | 'release'
  /** CLA/DCO, triage, labels, stale-closers, metadata, size + preview reporters
   *  (`HOUSEKEEPING_BOTS`). Volume here is pure noise in every review metric. */
  | 'housekeeping';

/** Render order: people first, then the automation that AUTHORS code (the lanes that distort
 *  throughput), then the automation that RESPONDS to it (the lanes that distort review counts). */
export const ACTOR_LANES: ActorLane[] = [
  'human',
  'code_agent',
  'dependency',
  'ai_review',
  'quality_gate',
  'release',
  'housekeeping',
];

// ── What a lane CONTAMINATES — the band a lane belongs to ────────────────────────────────────
//
// The lanes exist because different automation corrupts different metrics, so the band is not a
// cosmetic grouping: it is the answer to "which figures above should I distrust because of this".
//
//   authors  — writes the pull requests: distorts throughput, PR size, lead time
//   responds — comments/approves on them: distorts review volume, approvals, review latency
//
// `release` sits in `authors` because release trains and backporters open real pull requests; a
// merge queue that only merges contributes nothing to either count and is harmless in that band.
export type ActorLaneBand = 'people' | 'authors' | 'responds';

export const ACTOR_LANE_BAND: Record<ActorLane, ActorLaneBand> = {
  human: 'people',
  code_agent: 'authors',
  dependency: 'authors',
  release: 'authors',
  ai_review: 'responds',
  quality_gate: 'responds',
  housekeeping: 'responds',
};

// ── The effort-vs-automation breakdown on a period report ────────────────────────────────────
//
// ADDITIVE to the twelve-key metric vector, never part of it. The vector is the comparable
// artifact — adding keys invalidates every stored period against the new ones — and "how much of
// this was a person" is a NEW question rather than a correction to an old one, so it costs the
// stored periods nothing.
//
// ⚠ `comments` SPANS ALL THREE CHANNELS (inline review comments, PR issue comments, review
// bodies), unlike the vector's `bot_review_comments`, which counts inline only. That narrowness
// is why a workspace with 786 SonarQube comments reported zero bot activity: quality gates post
// issue comments, not inline ones. Do not "simplify" this back to one channel.
export interface PeriodLaneStats {
  lane: ActorLane;
  mergedPrs: number;
  openedPrs: number;
  medianPrSizeLines: number | null;
  medianLeadTimeHours: number | null;
  comments: number;
  approvals: number;
}

export interface PeriodLanes {
  lanes: PeriodLaneStats[];
  /** Share of merged PRs authored by automation, 0–100; null when nothing merged. */
  automationMergeSharePct: number | null;
  /** Median hours open → first review BY A PERSON.
   *
   *  ⚠ SINCE v2 THIS IS THE SAME MEASUREMENT AS THE VECTOR'S
   *  `median_time_to_first_human_review_hours`, and the duplication is deliberate: the vector is
   *  the comparable/forecastable artifact, this is what the lane panel renders beside the human
   *  row, and both read the one fold in `getPeriodLanes`. If they ever disagree, one of them has
   *  stopped using the union automation set. */
  medianTimeToFirstHumanReviewHours: number | null;
  /** Automation classified into a lane that produced NOTHING this period — a configured AI
   *  reviewer sitting silent is a finding, and it is invisible in every aggregate. */
  silentAutomation: { userId: number; lane: ActorLane }[];
}

// ── Bot-Triage Platform (WS1–WS6) ──────────────────────────────────────────────
// The neutral measurement + triage layer above ALL automated reviewers — the known
// vendors (ReviewBotKind), an account's own in-house AI reviewer, and Pierre's own Claude
// Review. See docs/PRO-PLATFORM.md / the bot-triage plan.

// ── WS1 automated-reviewer classification ────────────────────────────
// `vendor` = a generic PROPRIETARY third-party reviewer a user manually classifies when it
// isn't a known brand — distinct from `in_house` (the account's OWN AI). It carries no brand
// colour/label (rendered by login, like in_house) and is EXCLUDED from the cross-org
// benchmark (brand-unknown, so not comparable to a named-vendor cohort).
// ── The non-review vendor families ──────────────────────────────────────────────────────────
//
// A vendor kind per automation family, so an integration stops collapsing into `in_house` — the
// bucket literally labelled "In-house AI", which on the dev corpus held sonarqubecloud,
// dependabot[bot], github-actions[bot], gitguardian, socket-security, google-cla and jit-ci.
//
// ⚠ THESE ARE NOT `ReviewBotKind` MEMBERS AND MUST NEVER BECOME ONE. That union is the AI-reviewer
// cohort: `reviewBotKind()` decides who carries a review-bot badge, and the cross-org benchmark
// contributes rows keyed on it. Widening it would ship SonarQube's volume into a shared
// review-bot dataset that cannot be un-shipped. They join `AutomatedReviewerKind` (the identity
// axis, which is orthogonal to the role) and nothing else.
export type QualityCheckVendorKind =
  | 'sonarqube' | 'codecov' | 'codeclimate' | 'codefactor' | 'hound' | 'coveralls' | 'codacy'
  | 'github_actions' | 'jit' | 'socket' | 'gitguardian' | 'semgrep' | 'trunk';

export type DependencyVendorKind =
  | 'dependabot' | 'renovate' | 'snyk' | 'pyup' | 'greenkeeper' | 'depfu';

export type CodeAgentVendorKind =
  | 'sweep' | 'codegen' | 'deepsource_autofix' | 'pre_commit_ci' | 'restyled' | 'imgbot'
  | 'transifex' | 'crowdin' | 'mintlify' | 'allstar';

export type ReleaseVendorKind =
  | 'mergify' | 'kodiak' | 'bulldozer' | 'release_please' | 'semantic_release'
  | 'release_drafter' | 'changesets' | 'backport';

export type HousekeepingVendorKind =
  | 'cla_assistant' | 'google_cla' | 'meta_cla' | 'dco' | 'stale_bot' | 'welcome_bot'
  | 'lock_bot' | 'allcontributors' | 'semantic_pr' | 'sizebot' | 'codesandbox' | 'netlify'
  | 'vercel' | 'gitpod';

/** The three UNBRANDED kinds, legal in EVERY role — the "we know what it does, not who made it"
 *  answers. `in_house` = the account's own automation; `vendor` = a proprietary third party whose
 *  brand we have no entry for; `pierre` = this product's own reviewer. All three render by login
 *  rather than by brand, and all three are excluded from the cross-org benchmark. */
export type GenericReviewerKind = 'in_house' | 'pierre' | 'vendor';

export type AutomatedReviewerKind =
  | ReviewBotKind
  | QualityCheckVendorKind
  | DependencyVendorKind
  | CodeAgentVendorKind
  | ReleaseVendorKind
  | HousekeepingVendorKind
  | GenericReviewerKind;

/** ⚠ THE BENCHMARK ALLOW-LIST. `getBenchmarkContributions` used to decide "is this a comparable
 *  named vendor" with a DENY-list (`!== in_house && !== pierre && !== vendor`), which was correct
 *  only while `ReviewBotKind` was the entire branded universe. Every kind added above would have
 *  passed it — shipping a linter's volume into a shared cross-org review-bot cohort, permanently,
 *  for everyone, with no way to un-ship it. An allow-list cannot fail that way: a new kind is
 *  excluded until someone deliberately adds it here. */
export const REVIEW_BOT_KINDS: ReadonlySet<string> = new Set<ReviewBotKind>([
  'coderabbit', 'greptile', 'copilot', 'qodo', 'sourcery', 'bito', 'ellipsis', 'korbit',
  'baz', 'graphite', 'cursor', 'devin', 'entelligence', 'deepsource', 'github_code_quality',
  'github_advanced_security', 'codex',
]);

/** True when a kind is a comparable, branded AI-REVIEW vendor — the only kinds that may leave the
 *  tenant for the cross-org benchmark. */
export function isBenchmarkableVendorKind(kind: string | null | undefined): boolean {
  return kind != null && REVIEW_BOT_KINDS.has(kind);
}
export type ClassificationConfidence = 'high' | 'medium' | 'low';
export type ClassificationSource =
  | 'manual' | 'vendor_login' | 'github_type' | 'app_attribution'
  | 'fingerprint' | 'behavioral' | 'ai_tiebreak';

// WHAT an automated reviewer is FOR — an axis ORTHOGONAL to `AutomatedReviewerKind`, which
// says WHO it is (the vendor brand). Adding `'quality_check'` to the kind union instead would
// have been wrong twice over: a login would have to give up its brand identity (and its colour
// in BOT_VENDOR_META) to be marked a linter, and `getBenchmarkContributions` filters kinds with
// a RUNTIME string test against exactly `in_house | pierre | vendor`, so a new kind member would
// sail straight through and ship linters to the cross-org benchmark as a named review-bot cohort.
//
//   'review'        — an AI code REVIEWER (CodeRabbit, Greptile, an in-house agent, Pierre).
//   'quality_check' — static analysis / coverage / lint / CI (SonarQube, Codecov, Hound,
//                     github-actions). It posts review comments and IS automated, but it is not
//                     reviewing: counting it as a reviewer is what makes the ROI panel lie.
//   'dependency'    — version bumps (Dependabot, Renovate). Authors PRs, never reviews.
//   'code_agent'    — WRITES CODE that is not a bump: agents, autofix, generated-content sync.
//   'release'       — merge queues, release trains, changelogs, backports. Moves code.
//   'housekeeping'  — CLA/DCO, triage, labels, stale, metadata, size + preview reports.
//
// ⚠ EXACTLY ONE OF THESE IS THE REVIEWER COHORT, and it is `'review'`. Every consumer that used
// to ask `role === 'quality_check'` to mean "not a reviewer" MUST ask `role !== 'review'` now —
// the old spelling silently re-admits all four new roles into the ROI, behaviour, dedup and
// benchmark sets, which is the precise miscount this axis exists to prevent. `isReviewerRole()`
// below is the one predicate; prefer it to an inline comparison.
//
// Any automated role stays `automated: true` — `excludeBots`, the feed bot lens and the
// per-row vendor tag all keep working unchanged. The role only splits the two DERIVED SETS:
//   role 'review'                    → SCORING (ROI, behaviour, dedup, benchmark)
//   all automated (every role)       → EXCLUSION, the feed, AND bot-only PRs
// Confusing those two is the defect this feature is most likely to ship; see the CLAUDE.md note.
//
// BOT-ONLY PRs DELIBERATELY DO NOT NARROW, and the reason is worth stating because the symmetry
// is tempting: that list answers "did a human look at this before it merged". A PR reviewed only
// by SonarQube has no human reviewer, so it is exactly what the banner exists to surface. Narrowing
// it to role 'review' would leave such a PR with zero qualifying bot reviews, fail the "at least
// one automated review" leg, and drop it from the list — hiding the risk instead of flagging it.
// The scoring sets narrow because a linter's volume makes a REVIEWER's numbers lie; the risk set
// does not, because a linter's approval is not a human's.
export type ReviewerRole =
  | 'review'
  | 'quality_check'
  | 'dependency'
  | 'code_agent'
  | 'release'
  | 'housekeeping';

/** Selection order for the role picker, and the order the Bots panel groups its sections in. */
export const REVIEWER_ROLES: ReviewerRole[] = [
  'review',
  'quality_check',
  'dependency',
  'code_agent',
  'release',
  'housekeeping',
];

/** THE reviewer-cohort predicate. See the ⚠ above: `role !== 'review'` is the test, and spelling
 *  it once means a seventh role cannot be forgotten at a call site. */
export function isReviewerRole(role: ReviewerRole | null | undefined): boolean {
  return (role ?? 'review') === 'review';
}

// ── WHICH VENDORS BELONG TO WHICH ROLE — what the settings picker filters on ────────────────
//
// The Bots card asks for the ROLE first and then offers only that family's vendors, because the
// alternative is a flat list of ~60 brands in which a user looking for SonarQube scrolls past
// CodeRabbit, Dependabot and a CLA bot. Role is also the field with consequences (it decides
// which metrics count the actor), so it belongs above identity on the form rather than below it.
//
// DERIVED from `AUTOMATION_VENDORS` plus the two fixed families, so a vendor added to that table
// appears in the right dropdown with no second edit — the parallel-table trap again.
//
// The three GENERIC kinds map to `null`, meaning "legal in every role". That is what gives each
// family its own "In-house / custom" and "Other vendor" escape hatch: a user who runs an
// unbranded quality gate can say so without being pushed into a brand that is not theirs.
const KIND_ROLE_ENTRIES = new Map<AutomatedReviewerKind, ReviewerRole | null>([
  ...Object.values(AUTOMATION_VENDORS).map(
    (v) => [v.kind, v.role] as [AutomatedReviewerKind, ReviewerRole | null],
  ),
  // The AI reviewers. Listed from the REVIEW_BOTS map rather than restated, so a new vendor login
  // is enough. `devin` is deliberately overwritten by AUTOMATION_VENDORS above — same brand, and
  // what it DOES is author code.
  ...Object.values(REVIEW_BOTS).map((k) => [k, 'review'] as [AutomatedReviewerKind, ReviewerRole]),
  ['pierre', 'review'],
  ['in_house', null],
  ['vendor', null],
]);

/** The role a vendor kind belongs to, or `null` when it is legal in every role (the three generic
 *  kinds). A kind with no entry is treated as `null` — permissive, because hiding a stored value
 *  from its own picker is how a user's saved vendor silently changes on the next save. */
export function roleForVendorKind(kind: AutomatedReviewerKind): ReviewerRole | null {
  return KIND_ROLE_ENTRIES.get(kind) ?? null;
}

/**
 * The vendor kinds offered for a role: that family, plus the generic escape hatches, plus
 * `current` even when it does not belong.
 *
 * ⚠ THE `current` ARGUMENT IS NOT A CONVENIENCE. A `<select>` whose `value` is absent from its
 * options renders the FIRST option instead, so the card would show a vendor the row does not
 * hold — and the next save would write that wrong vendor. Role and identity are independently
 * owned halves (`source` vs `identitySource`), so a row legitimately carries a vendor from
 * another family: someone marks CodeRabbit a quality check without renaming it. The stored value
 * has to stay selectable.
 */
export function vendorKindsForRole(
  role: ReviewerRole,
  current?: AutomatedReviewerKind | null,
): AutomatedReviewerKind[] {
  const out: AutomatedReviewerKind[] = [];
  for (const [kind, kindRole] of KIND_ROLE_ENTRIES) {
    if (kindRole === role || kindRole === null) out.push(kind);
  }
  if (current != null && !out.includes(current)) out.push(current);
  return out;
}

/** A stored role maps 1:1 onto the lane it puts an actor in. Kept 1:1 ON PURPOSE — a user who
 *  marks a bot "Release automation" and then finds it filed under "Quality gate" has been told
 *  their choice did not take, so the two vocabularies do not get to drift into a lookup table
 *  with surprises in it. `human` has no role because a human is not an automated reviewer. */
export const REVIEWER_ROLE_LANE: Record<ReviewerRole, Exclude<ActorLane, 'human'>> = {
  review: 'ai_review',
  quality_check: 'quality_gate',
  dependency: 'dependency',
  code_agent: 'code_agent',
  release: 'release',
  housekeeping: 'housekeeping',
};

/** Short human labels — the role picker, the lane legend and the report table all read these, so
 *  a rename lands everywhere at once. */
export const REVIEWER_ROLE_LABEL: Record<ReviewerRole, string> = {
  review: 'Review bot',
  quality_check: 'Quality check',
  dependency: 'Dependency updates',
  code_agent: 'Code agent',
  release: 'Release automation',
  housekeeping: 'Housekeeping',
};

export const ACTOR_LANE_LABEL: Record<ActorLane, string> = {
  human: 'People',
  ai_review: 'AI review',
  quality_gate: 'Quality gates & CI',
  dependency: 'Dependency updates',
  code_agent: 'Code agents',
  release: 'Release automation',
  housekeeping: 'Housekeeping',
};

// A BOT IS A PER-WORKSPACE OBJECT. Everything below keys on (account, WORKSPACE, actor): ONE row
// per key, one grain, no inheritance chain, no merge and NO DEDUPLICATION anywhere.
//
// WHY THE WORKSPACE AND NOT THE REPO. A workspace is the only scope this app has — the unit a user
// selects, the unit every list and metric is computed over, and therefore the unit a judgement is
// ABOUT. Its predecessor keyed the judgement on (account, repo) and the identity on (account,
// actor): two tables, two write grains, and a listing that rendered the same vendor six times
// because it ran in six repos. With one workspace answering "which repos am I looking at", both
// questions have the SAME key — so a second table would key on the identical three columns and be
// joined at every call site, i.e. this table with extra steps. "CodeRabbit across the six repos of
// a workspace" is ONE row: one judgement, one price, one brand colour.
//
// ── ONE ROW, THREE INDEPENDENT FACTS — AND TWO PROVENANCE FLAGS THAT KEEP THEM APART ────────────
// JUDGEMENT — is this login acting as an automated reviewer HERE (`automated`), is it reviewing or
//   quality-checking (`role`), and how we know (`confidence` / `source` / `reasons`).
//   Provenance: `source`.
// IDENTITY  — what the bot IS (`kind`) and what it is CALLED (`label`).
//   Provenance: `identitySource`.
// PRICE     — `costMonthlyUsd`. No provenance flag, because nothing derives it: exactly ONE writer
//   (the cost route), and it appears in no classifier statement at all.
//
// ⚠ THE TWO PROVENANCE FLAGS ARE NOT ONE FLAG, and they are now the ONLY thing doing the job the
// two-table split did structurally. Honour them INDEPENDENTLY. Anything that gates both halves on
// one flag — a classification pass, a PATCH handler, a single "Reset to auto" control — either
// reverts a human's vendor correction on the next pass, or freezes auto-detection because somebody
// renamed a vendor. There is no table boundary left to catch it; it is a narrowed `set:` object and
// a pair of UI affordances, pinned by tests.
//
// ⚠ IDENTITY AND PRICE ARE PER WORKSPACE TOO, and that is the deliberate, accepted consequence of
// keying on the workspace. CodeRabbit named — or priced — in workspace A does NOT carry that name
// or that number into workspace B; the two rows may legitimately differ, nothing reconciles them,
// and nothing is meant to. Two rules follow, neither optional:
//   • A vendor colour/label lookup must be built from the ACTIVE workspace's listing. Reading some
//     arbitrary workspace's identity is how a bot renders orange on one screen and blue on the next.
//   • COST IS NEVER SUMMED ACROSS WORKSPACES on one screen. Within a workspace there is exactly one
//     row per actor, so a total there is a plain sum. Across workspaces, six workspaces each listing
//     a $120 CodeRabbit is either six subscriptions or one seen six ways, and the app must not
//     assert which — show the figures side by side and do not add them up.
//
// IF YOU ADD A FIELD, it lands on this row, under one of the three headings above. And if it is
// neither derived nor re-derivable — money, or a human's typed text — give it its own writer, the
// way price has one.

// The stored VERDICT about one actor: what the classifier decided, written to that actor's row in
// each workspace the pass covers.
//
// IT IS DERIVED ONCE PER ACTOR, NOT ONCE PER WORKSPACE — hence no `workspaceId` here. Every strong
// signal (vendor login, `users.githubType`, app attribution, the branded-marker fingerprint) is a
// property of the ACTOR and is scope-independent, so per-workspace derivation would multiply the
// work and the BILLED Haiku tie-break for an identical answer, and would weaken the behavioural
// score by computing it on a thin per-workspace slice. The rows stay independently overridable:
// only a HUMAN edit should ever make two of an actor's workspace rows disagree.
//
// ⚠ IT CARRIES BOTH HALVES OF THE ROW — the one place in this contract that legitimately does,
// because the classifier is the writer for both. Persisting it is therefore a per-workspace loop
// over a NARROWED `set:` object, each half gated on its OWN provenance flag:
//     kind / label                       skipped when that row's `identity_source` is 'manual'
//     automated / role / confidence / …  skipped when that row's `source`          is 'manual'
// They share a row now, so nothing but that discipline separates them: gate both on one flag and a
// human's vendor correction is reverted by the next pass, or one "not a bot" freezes the vendor
// identity across the whole workspace.
//
// ⚠ IT DOES NOT AND MUST NOT CARRY A PRICE. `monthly_cents` appears in no derived INSERT and in no
// derived `set:`; a row the classifier creates simply has no price until someone sets one.
export interface ReviewerClassification {
  userId: number;
  login: string;
  automated: boolean;
  kind: AutomatedReviewerKind | null;   // null when human
  label: string;                        // "CodeRabbit" | "In-house AI" | "acme-ci" | "Pierre · Claude"
  // What this automation is FOR (see ReviewerRole). Always 'review' for a human — the field is
  // meaningless when `automated` is false, and callers must gate on `automated` first rather
  // than reading a human's role. Persisted NOT NULL DEFAULT 'review', so it is never absent.
  //
  // ⚠ `persist()` takes this type MINUS `role` (`Omit<ReviewerClassification, 'role'>`) and derives
  // the role itself from the local quality-check login list. Round-tripping the caller's value
  // would let a stale default overwrite the migration's role fold on the next pass and put
  // SonarQube straight back into the review-bot metrics.
  role: ReviewerRole;
  confidence: ClassificationConfidence;
  source: ClassificationSource;
  reasons: string[];
}

// How much of this actor is visible across the workspace's repos. Counts are a rolling 90 days;
// `lastActiveAt` is ALL-TIME, so a long-dormant bot still reports when it last ran.
//
// It is what makes a stale row legible without a flag: a row whose counts are all 0 is a judgement
// someone recorded for a workspace this reviewer no longer touches. The numbers say it plainly, so
// no `dormantInScope` boolean is needed.
export interface ReviewerFootprint {
  reviews: number;   // reviews submitted on the workspace's PRs
  threads: number;   // inline review threads opened
  comments: number;  // issue-level PR comments
  lastActiveAt: string | null; // ISO-8601; most recent of the three, all-time
}

// The same, for ONE repo inside the workspace. Emitted only for repos where the actor actually
// has a footprint — it is what the per-repo Bots tab filters on, and it is why that tab does not
// need (and must not have) a per-repo judgement.
export interface RepoReviewerFootprintEntry extends ReviewerFootprint {
  repoId: number;
}

// How a bot's stored monthly price is READ. 'flat' = the number IS this workspace's monthly total
// for the bot. 'per_seat' = the number is a PER-SEAT unit price, multiplied ON READ by the
// workspace's derived seat count — a SEAT being a distinct HUMAN PR author across the workspace's
// repos over the trailing 30 days. The product (unit × seats) is NEVER stored: as int4 cents it
// can overflow, and a stored copy would go stale the moment the team changed.
export type CostModel = 'flat' | 'per_seat';

// THE BOT OBJECT — one actor, in one workspace. Judgement + identity + price + evidence, because
// with one scope they are all facts about the same key. The wire form of a `workspace_reviewers`
// row; it replaces the old `RepoReviewer` (one per repo) / `ReviewerIdentity` (one per account)
// pair, and there is nothing left to join.
//
// ⚠ THE TWO PROVENANCE FIELDS ARE NOT ONE FIELD. `source` governs automated/role/confidence/
// reasons; `identitySource` governs kind/label. A UI that offers one "Reset to auto" control for
// both, or a handler that stamps one when the user edited the other, reintroduces the bug the
// 0042/0043 split existed to kill — inside a single row this time, where no table boundary is
// left to catch it.
//
// ⚠ `costMonthlyUsd` is a PER-WORKSPACE fact like every other field here. The same actor's rows in
// two workspaces may legitimately hold different numbers; nothing reconciles them and nothing is
// meant to. It must NEVER be summed ACROSS workspaces on one screen — six workspaces each listing
// a $120 CodeRabbit is either six subscriptions or one seen six ways, and the app must not assert
// which. Within one workspace there is exactly one row per actor, so a total there is a plain sum;
// the Compare-workspaces surface shows them side by side and does not add them up.
export interface WorkspaceReviewer {
  workspaceId: number;
  userId: number;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  // ── judgement (provenance: `source`) ──
  automated: boolean;
  // 'review' | 'quality_check' — see ReviewerRole. A FLAG ON THIS OBJECT, not a separate kind: a
  // login keeps its brand while being marked a linter, and it may legitimately be a reviewer in one
  // workspace and a quality gate in another.
  role: ReviewerRole;
  confidence: ClassificationConfidence;
  source: ClassificationSource;
  reasons: string[];
  // `source === 'manual'` — the judgement is a human's and the classifier will not re-derive it.
  // Kept as its own field because it drives the "Reset classification" affordance, and reading it
  // off `source` at every call site is how one of them ends up wrong.
  //
  // THE AFFORDANCE IS `DELETE /api/bot-reviewers/:userId/judgement?workspaceId=`, which hands
  // automated/role/confidence/reasons back to detection and RE-DERIVES in the same request (it is
  // an UPDATE, not a row delete — the row also holds the identity and the price). Show it only when
  // this is true: resetting an already-auto row is a no-op that looks like a broken button. It is
  // the only way back, because flipping `automated` by hand re-stamps `source: 'manual'` and leaves
  // the row pinned against re-derivation, just pinned on a different value.
  //
  // ⚠ BLAST RADIUS IS THE WHOLE WORKSPACE, not one repo. Every repo in the workspace is judged by
  // this one row, so the UI must say so wherever the toggle appears — including on surfaces that
  // look repo-scoped (the per-repo Bots tab, a feed card's "not a bot?").
  isManualOverride: boolean;
  // ── identity (provenance: `identitySource`) ──
  // Vendor identity — drives BOT_VENDOR_META / automatedReviewerMeta() colour + brand name. null
  // when this actor has no vendor identity in this workspace.
  kind: AutomatedReviewerKind | null;
  // Resolved display name: a human-set label → the vendor's brand name → the login.
  label: string;
  // Provenance of `kind` + `label` ONLY, and deliberately NOT the same field as `source`: identity
  // and judgement are corrected independently. 'manual' ⇒ a human named this thing and the
  // classifier will not re-derive it; 'auto' ⇒ detection owns it.
  //
  // IT DRIVES THE "RESET NAME" AFFORDANCE — `DELETE /api/bot-reviewers/:userId/identity?workspaceId=`
  // clears kind/label, sets this back to 'auto' and re-derives immediately. Show it ONLY when this
  // is 'manual'; on an auto identity it would appear to do nothing.
  //
  // ⚠ TWO THINGS THAT RESET MUST NOT DO, both enforced server-side and both worth stating where the
  // flag is read: it must not touch `automated`/`role` (that is the other provenance flag and the
  // other route), and it must NOT clear `costMonthlyUsd`. A price shares this row but is not a
  // classification opinion; losing it as a side effect of un-naming a vendor is exactly the
  // coupling this contract keeps separated. Say so in the UI copy — "reset" reads as "delete
  // everything" otherwise.
  identitySource: 'auto' | 'manual';
  // ── price (no provenance; one writer) ──
  // What this bot costs in THIS workspace, in whole US DOLLARS (the wire unit; storage is integer
  // cents in `workspace_reviewers.monthly_cents` — money is never a float, and the two dialects
  // share one fixed rounding rule). Under `costModel: 'per_seat'` this is the STORED UNIT — the
  // per-seat price the user typed, not the monthly figure; `effectiveMonthlyUsd` below carries
  // that.
  //
  // null = NO PRICE SET. 0 is a real, deliberate price meaning "we pay nothing for this". NOTHING
  // INHERITS — so `??` vs `||` is an ordinary display bug here, not a silent wrong-price trap.
  //
  // ⚠ null NOW CARRIES A SECOND MEANING ON THE WIRE: "this account may not see prices". The Bots
  // ROI panel is paid (`botDepth`), and all four routes that echo a `WorkspaceReviewer` — the
  // listing, the PATCH, and both resets — run `stripCost` for an unentitled account, returning
  // exactly the shape a never-priced row has (`costModel: 'flat'` included) so nothing downstream
  // has to learn a fourth cost state. DECIDE WHICH MEANING APPLIES FROM `/api/me`'s `pro.botDepth`,
  // NEVER FROM THE VALUE: a surface that renders cost state without checking the capability first
  // will tell an unentitled reader "no price set" about a bot that has a price. `costStateOf`
  // (frontend lib/botCost.ts) maps null → 'none' and is correct only below a capability check.
  // (The GDPR export is the one place the real number still ships — see db/export-account.ts.)
  //
  // ⚠ RENDERING RULE, and it is the client's job because no schema can enforce it: this price is
  // per WORKSPACE. Totalling a single workspace's listing is correct (one row per actor). Totalling
  // across workspaces is not, and no surface may do it.
  costMonthlyUsd: number | null;
  // How `costMonthlyUsd` is read — see CostModel. Written ONLY by the standalone cost route,
  // exactly like the price itself (same one writer, same body; clearing the price resets this to
  // 'flat' in the same statement). A row with no price is always 'flat'.
  costModel: CostModel;
  // The figure a monthly TOTAL may sum: `costMonthlyUsd × workspaceSeatCount` under 'per_seat',
  // `costMonthlyUsd` itself under 'flat'. Null exactly when `costMonthlyUsd` is null.
  // SERVER-computed on read so exactly one place multiplies seats — a client that multiplies again
  // double-charges. Still a PER-WORKSPACE fact: never summed across workspaces.
  effectiveMonthlyUsd: number | null;
  // ── evidence ──
  footprint: ReviewerFootprint;                  // aggregated over the workspace's repos
  repoFootprints: RepoReviewerFootprintEntry[];  // only repos where the actor has a footprint
  sampleReviewBody: string | null;               // newest non-empty review body in the workspace
}

export interface DetectedReviewersResponse {
  // Echoed so the client can correct a stale stored id — an unknown/foreign id resolves to the
  // account's Default workspace rather than 404ing.
  workspaceId: number;
  reviewers: WorkspaceReviewer[];
  // The repos this listing covered, in render order. `[]` means "this workspace has no repos —
  // go move some in", which a count alone could not distinguish from "no reviewers detected yet".
  repoIds: number[];
  // The workspace's derived SEAT COUNT: distinct HUMAN PR authors across the workspace's repos
  // over the trailing 30 days, judged by the workspace's own bot verdicts (a manual "this is a
  // human" makes a seat of a `users.isBot` login; a workspace-classified in-house bot is excluded
  // even though the global table calls it human). ONE number per workspace, computed once per
  // response — it feeds every per-seat row above, so it is not repeated per reviewer.
  workspaceSeatCount: number;
  generatedAt: string;
}

// ── THE WRITE SURFACE: TWO ROUTES, SPLIT BY MUTABILITY (NOT BY GRAIN) ───────────────────────────
// There is one grain now, so there is no grain mismatch left to defend against. What remains is a
// MUTABILITY difference, and it is the reason cost still has its own route:
//
//   PATCH /api/bot-reviewers/:userId       WorkspaceReviewerPatchBody   automated/role/kind/label
//   PUT   /api/bot-reviewers/:userId/cost  ReviewerCostBody             monthly_cents
//
// `automated`, `role`, `kind` and `label` are all RE-DERIVABLE: a wrong write is fixed by the next
// classification pass or by a reset. They belong in one body, keyed by two independent provenance
// flags, and merging them removes a whole class of "which endpoint do I call" bugs.
// `monthly_cents` is derivable by nothing and is money. Keeping it on its own PUT means no combined
// body can address the column at all and the PATCH handler's `set:` object contains no cost key —
// the same structural guarantee the old two-table split provided, with one fewer table.
//
// Plus TWO RESETS, bodyless, one per PROVENANCE FLAG — the way back to auto, without which every
// edit above is permanent (a manual write pins its half against re-derivation, and flipping the
// value back by hand leaves it pinned on the new value):
//
//   DELETE /api/bot-reviewers/:userId/judgement?workspaceId=  → 200 WorkspaceReviewer (re-derived)
//   DELETE /api/bot-reviewers/:userId/identity?workspaceId=   → 200 WorkspaceReviewer (re-derived,
//                                                                PRICE KEPT)
//
// Both are UPDATE + immediate re-derive, not row deletes: the row carries the other half and the
// price, so deleting it is lossy, and a clear-without-derive would leave the human's values sitting
// under an auto label until something else happened to overwrite them.
//
// ⚠ EVERY WRITE ON THIS SURFACE IS WORKSPACE-WIDE. The old per-repo PATCH could honestly promise
// "this leaves your other repos alone"; nothing here can. A control rendered in a repo-shaped
// context — the per-repo Bots tab, a feed card's "not a bot?" — must state the workspace scope in
// its copy and, on the high-traffic surfaces, confirm before writing.

// PATCH /api/bot-reviewers/:userId — ONE patch body for the four re-derivable fields. All four are
// OPTIONAL; absent = leave alone. A body carrying NONE of them 400s (an opinion-free patch would
// stamp a provenance flag on the strength of an empty request and freeze detection).
//
// The two halves stamp their flags INDEPENDENTLY: `automated` and/or `role` stamp
// `source: 'manual'`; `kind` and/or `label` stamp `identitySource: 'manual'`. A patch that carries
// only a judgement must not touch the identity flag, and vice versa — that independence is the
// only thing stopping "not a bot here" from also un-naming the vendor now that the two facts share
// a row.
//
// ⚠ A role-only patch still stamps `source: 'manual'`, which also pins `automated` for that
// workspace. Deliberate: not stamping it would let the next classification pass re-derive `role`
// from the login seed and silently revert the edit. A visible, resettable pin beats an edit that
// quietly disappears.
//
// ⚠ IT CANNOT CARRY A PRICE. Cost has its own route precisely so no combined body can reach
// `monthly_cents`.
export interface WorkspaceReviewerPatchBody {
  // WHICH row this edits. REQUIRED — the row is the object, and it is keyed
  // (account, workspace, actor). The workspace must belong to the calling account; an unowned or
  // unknown id 404s rather than writing a row keyed into another tenant's workspace. (The composite
  // FK `(workspace_id, account_id) → workspaces(id, account_id)` makes that structural rather than
  // a check this route could forget — but return the 404 anyway; a constraint violation is a 500.)
  workspaceId: number;
  automated?: boolean;                 // stamps source: 'manual'
  role?: ReviewerRole;                 // stamps source: 'manual'
  kind?: AutomatedReviewerKind | null; // stamps identitySource: 'manual'; null = clear the vendor
  label?: string | null;               // stamps identitySource: 'manual'; null = clear the label
}

// PUT /api/bot-reviewers/:userId/cost — set or clear what this bot costs IN THIS WORKSPACE.
//
// TWO STATES ONLY:
//   a number → write it to `workspace_reviewers.monthly_cents`. 0 is real: "we pay nothing".
//   null     → write NULL. There is nothing to fall back to; the price is simply unset.
// `monthlyUsd` is REQUIRED and NULLABLE precisely so `undefined` is not a third meaning.
//
// ⚠ IT WRITES EXACTLY ONE ROW, predicate (account_id, workspace_id, author_user_id). Price is per
// workspace like every other attribute on the row: the same actor's rows in other workspaces are
// untouched and may hold different numbers. There is no fan-out, no INSERT seed, no cross-workspace
// coupling of any kind — so the editor's copy says "Price for this Workspace", not a bare "Price".
//
// ⚠ CLEARING IS A COLUMN WRITE, NOT A ROW DELETE. Cost shares its row with the judgement and the
// identity, so deleting the row would take both with it. The nullable column is what makes the two
// states expressible on a row that exists for other reasons. (When cost had its own table, NOT NULL
// + delete-to-clear was the right shape — do not carry that reflex over.)
//
// ⚠ ROUNDING IS FIXED AND SHARED WITH THE MIGRATIONS: cents = floor(usd × 100 + 0.5) in binary64.
// Do not reach for a "more exact" decimal rounding on one side — a fractional-cent price like
// $1.005 lands on 100 under this rule and 101 under exact-decimal rounding, and the two backfill
// paths were measured disagreeing on exactly that value before the rule was pinned. Rejecting
// non-integer-cent input here is what keeps the question academic for new writes.
//
// ⚠ BOUNDED: a finite number in [0, 21474836.47], multipleOf 0.01. Storage is int4 CENTS in both
// dialects (`Math.round(usd * 100)` must land in int4), and that ceiling is where the two dialects
// stop agreeing. Postgres RAISES `integer out of range` (a 500) on anything above it while SQLite's
// 64-bit integers accept the value happily, so an unbounded field means the same request succeeds
// locally and 500s in cloud, leaving a number cloud can never represent. The route must CLAMP or
// 400 — do not leave it to the driver. (Measured: monthlyUsd 99999999999 stored 2147483647 on pg
// and 9999999999900 on sqlite before both paths were clamped.) Reject non-finite values too:
// NaN/Infinity survive JSON.parse of a hand-rolled body.
export interface ReviewerCostBody {
  workspaceId: number;
  monthlyUsd: number | null;
  // How the number is to be read — 'flat' (the default; omitted means flat) or 'per_seat' (a
  // per-seat unit price, multiplied on read by the workspace's derived seat count). Only
  // meaningful when `monthlyUsd` is a number: a CLEAR (`monthlyUsd: null`) always resets the
  // stored model to 'flat' in the same single UPDATE, because a NULL price has no reading rule
  // and a per-seat leftover would silently re-meter the next number typed.
  //
  // ⚠ IT RIDES THIS BODY AND NEVER THE PATCH. The model changes what the stored number MEANS, so
  // it is money the same way the number is — the structural no-combined-body-can-address-money
  // guarantee covers both columns or it covers neither.
  costModel?: CostModel;
}

// ── WS2 Pierre-own-review provenance ────────────────────────────────
export type ReviewProvenance = 'ai_verbatim' | 'human_curated';
// Surfaced per-review on PR detail; see ReviewDetail additions below.

// ── WS3 Bot ROI / utilisation analytics ─────────────────────────────
// ⚠ `'sprint'` here does NOT mean the account's configured sprint by itself. The bot getters live
// in CORE, which cannot read the plugin-owned sprint cadence/start, so a bare `'sprint'` kind
// resolves to the same trailing 14 days as `'rolling_14'` (db/bot-window.ts). A caller that DOES
// know the real bounds — the Pro Insights chat, via `pro_settings` — passes them explicitly
// alongside the kind (see `getBotAnalytics`'s window parameter), and then `window.from`/`to` on the
// response are the true sprint dates rather than a silent 14-day stand-in.
export type BotWindowKind = 'rolling_7' | 'rolling_14' | 'rolling_30' | 'rolling_90' | 'sprint';
export type BotVerdict = 'keep' | 'tune' | 'noisy';
export interface BotVendorTrendPoint { weekStart: string; threads: number; actedOnPct: number | null; untouched: number; }
// One week of a bot's ours-vs-badge disagreement counts (the Inflation column's Pro sparkline).
export interface BotInflationWeekPoint { weekStartMs: number; overCall: number; underCall: number; }
// The per-bot severity-inflation summary riding each ROI row — see BotVendorAnalytics.mlInflation.
export interface BotVendorInflation {
  /** In-window findings carrying a vendor badge at all — the denominator the counts partition. */
  badged: number;
  /** The bot badged a finding WORSE than our model rated it (inflation — the tuning question). */
  overCall: number;
  /** Our model rated it worse than the bot's badge (what a nit-filter on the bot's own grades would drop). */
  underCall: number;
  /** Pro (`botDepth`) only: ≤12 weekly points, oldest→newest. Absent for free accounts. */
  weekly?: BotInflationWeekPoint[];
}
export interface BotVendorAnalytics {
  // Stable unique row key. Analytics are now per-REVIEWER (so in-house bots — all kind
  // 'in_house' — get their own rows), and `kind` repeats across them, so the UI keys on this.
  key: string;
  kind: AutomatedReviewerKind;
  // Per-bot display name (custom classification label → vendor name → login), not the kind label.
  label: string;
  // The reviewer's github login — the stable key the client maps per-bot cost onto. Null only
  // when the login couldn't be resolved.
  login: string | null;
  reviewers: number;
  threads: number;
  comments: number;
  actedOn: number;
  actedOnPct: number | null;
  // Not-addressed (untouched) threads: `untouched` = the total; `overdueUntouched` = the subset
  // older than the fixed overdue grace window (totals.overdueGraceMs) — i.e. the ones genuinely
  // being ignored, which is what the `noisy` verdict keys on. `medianAddressedMs` is THIS bot's
  // own MEDIAN time-to-ADDRESSED (ms) — reply | resolve | addressing commit; null when no thread
  // of its was ever addressed. Display-only.
  untouched: number;
  overdueUntouched: number;
  medianAddressedMs: number | null;
  oldestUntouchedDays: number | null;
  humanFollowThroughPct: number | null;
  noiseRatioPct: number | null;
  // "Merged past": PRs MERGED inside the window still carrying ≥1 untouched thread by this
  // bot at merge — the team's FINAL answer was to ship anyway, a strictly stronger claim than
  // `untouched` (which includes open PRs where action may still come). Keyed on the PR's
  // mergedAt (window) — the threads themselves may be older than the window. Display-only:
  // `verdict` never reads these (bot-analytics-verdict.test.ts pins verdict inputs).
  mergedPastPrs: number;
  mergedPastThreads: number;
  // ── Same-line overlap (ADVISORY — the redundancy signal), WINDOWED like every other column ──
  // `overlapThreads` = this bot's window threads landing in a ±3-line cluster (same PR + file —
  // the ONE shared definition, backend db/line-overlap.ts) that ≥1 OTHER review-role bot also
  // flagged; `overlapPct` = overlapThreads / threads, rounded 0..100 (null when threads is 0).
  // Null-line threads (outdated / file-level) NEVER count — a thread loses its line when it
  // outdates, and a per-file lump manufactures overlap out of any two chatty bots. Quality
  // checks are excluded on both sides. `topOverlapPartner` = the bot sharing the most CLUSTERS
  // with this one (cluster count, not threads; symmetric — the partner's row names this bot
  // back), or null when it overlaps with nobody. ADVISORY ONLY: a column + a tuning suggestion;
  // `verdict` never reads these (its semantics are pinned by bot-analytics-verdict.test.ts).
  overlapThreads: number;
  overlapPct: number | null;
  topOverlapPartner: { key: string; label: string; clusters: number } | null;
  // ── ML severity mix (docs/ML-SEVERITY.md), WINDOWED like every other column ──
  // ⚠ PAID with the rest of this row: these columns are withheld along with `vendors[]` for an
  // account without `botDepth`. The per-COMMENT severity badge (`GET /api/prs/:id/ml-labels`) is a
  // DIFFERENT route and stays free on every tier — that is the line the tier draws.
  // Aggregated from `ml_comment_labels` over the SAME window as the ROI numbers, for THIS bot.
  // ALL FOUR ARE ABSENT (undefined) when the bot has no labels in the window — the UI renders
  // blanks, never zeros ("no data yet" and "zero findings" are different claims). A present
  // `mlFindings: 0` means labels exist and every one is a summary/praise. The two rates divide
  // by FINDINGS (summaries + praise excluded — the phantom-gap rule) and are rounded 0..100
  // like their `…Pct` siblings; null when findings is 0. The vendor's OWN declared severity is
  // NEVER an input to any of these (measured anti-metric — see docs/ML-SEVERITY.md § Accuracy).
  mlFindings?: number;
  mlBySeverity?: MlSeverityCounts;
  mlNitPct?: number | null;
  mlHighPct?: number | null;
  // The NOT-ADDRESSED (untouched) window threads split by the predicted severity of the finding
  // that OPENED each one — "17 not addressed" is a volume complaint; "3 of them major" is a
  // decision. Same population as `untouched`, but it is a split of the LABELLED subset only:
  // a thread whose origin comment carries no label (or a summary/praise one — never findings)
  // contributes to `untouched` and to nothing here, so THESE FOUR NEED NOT SUM TO `untouched`
  // and must never be presented as if they did. Absent under the same rule as its ml* siblings
  // (no in-window labels for this bot ⇒ no ML claim at all); present-and-zero means labels
  // exist and none of the ignored threads scored that way.
  notAddressedBySeverity?: MlSeverityCounts;
  // ── The severity INFLATION column (plan P1.2/C2) ────────────────────────────────────────
  // How often this bot's OWN badge contradicted our label, over the SAME window as every other
  // column here. Counts, never shares — and they partition `badged` (the findings carrying a
  // vendor badge at all), never `mlFindings`: most findings carry no badge, and silence is not
  // agreement. Direction comes from the ONE shared `vendorAgreementOf` rule the confusion
  // matrix and the flagging drill-down's `disagree` refinement also use, so a count here equals
  // the drill-down's `filteredTotal` for the same bot + direction by construction.
  //
  // Absent under the same rule as its ml* siblings (no in-window labels for this bot). Present
  // with `badged: 0` means the bot badges nothing — the UI renders a DASH, never a zero ("never
  // inflates" and "makes no calls" are different claims).
  //
  // `weekly` is ≤12 weekly points oldest→newest over the same trend span as `trend`.
  //
  // ⚠ THE WHOLE INFLATION COLUMN IS PAID NOW, counts included. It used to be a split tier (current
  // -window counts free, the weekly history under `botDepth`) — but the Inflation cell is a cell of
  // the ROI table, and the ROI table went behind `botDepth` in one piece, so an unentitled account
  // receives no `vendors[]` to draw it in. `weekly` keeps its own absent/present flag because it is
  // an extra SCAN WIDTH in the getter, not just a field to drop.
  mlInflation?: BotVendorInflation;
  // keep | tune | noisy. Thread math first (volume, acted-on, OVERDUE-untouched), plus ONE ML
  // input: a bot past the nit gates (findings ≥ 20 AND nit share ≥ 0.7 — the same gates as the
  // nit `BotTuningSuggestion`, so chip and advisory always agree) is ESCALATED 'keep' → 'tune'.
  // The label may only escalate, and only that far: 'tune' and 'noisy' are never softened, and
  // nothing about a label can produce 'noisy'. The vendor's own declared severity is never an
  // input. Pinned by bot-analytics-verdict.test.ts.
  verdict: BotVerdict;
  // SERVER-resolved (no longer overlaid client-side from pro_settings `bots.cost`): this actor's
  // monthly price for THE WORKSPACE THIS RESPONSE WAS COMPUTED FOR, read from
  // `workspace_reviewers.monthly_cents`, in US dollars (storage is integer cents).
  //
  // IT IS ONE WORKSPACE'S PRICE, and that is the trap worth naming: this row aggregates one
  // reviewer over the requested workspace (optionally narrowed by repoIds), and the number belongs
  // to that workspace alone. Within it there is exactly one row per actor, so a total across the
  // rows of ONE response is a plain sum. ACROSS workspaces it must never be summed — six
  // workspaces each listing a $120 CodeRabbit is either six subscriptions or one seen six ways,
  // and the app must not assert which. There is no inheritance to disclose (that is why the old
  // `costInherited` companion is gone): the price either exists on this workspace's row or it does
  // not, and another workspace may legitimately hold a different number.
  //
  // null = no price recorded. 0 = recorded as free. `costPerActedOnUsd` is
  // `costMonthlyUsd / actedOn` (null when either side is missing or actedOn is 0) and inherits
  // the same caveat — under a repo-narrowed request it divides a whole subscription by part of its
  // work.
  //
  // ⚠ THIS IS THE **EFFECTIVE** MONTHLY FIGURE. Under `costModel: 'per_seat'` the server has
  // ALREADY multiplied the stored unit by the workspace's derived seat count (on read — the
  // product is never stored), so every consumer — the ROI cell, `costPerActedOnUsd`, any
  // within-workspace total — shows seat-adjusted dollars without knowing seats exist. The stored
  // unit survives as `costUnitMonthlyUsd` for tooltip copy only.
  //
  // ⚠ COST IS PAID (`botDepth`), and so is every other column on this row. The price is READ from
  // a core table and computed with no model — "core" describes where the code lives, never the
  // tier. The whole ROI table this row draws went behind `botDepth`, so an unentitled account
  // never receives a populated `vendors[]` at all (`GET /api/bot-analytics` narrows: `vendors`
  // empty, `ml`/`qualityChecks` absent, the ROI half of `totals` zeroed). An OSS/npx install can
  // neither set nor see a price unless the plugin is bound and advertising `botDepth`.
  costMonthlyUsd: number | null;
  costPerActedOnUsd: number | null;
  // How the stored price is metered — display metadata only: `costMonthlyUsd` above is already
  // effective, so no consumer multiplies anything.
  costModel: CostModel;
  // The workspace's derived seat count the effective figure was computed at ("$29/seat at 12
  // seats"). One workspace per response, so this repeats across rows by construction.
  costSeatCount: number;
  // The stored per-seat unit in dollars when `costModel === 'per_seat'`; null under 'flat' (the
  // unit IS `costMonthlyUsd` there).
  costUnitMonthlyUsd: number | null;
  // Zero window activity (no threads, comments, OR submitted reviews in the window) — the row
  // survives on its 12-week trend so a paused/quiet bot doesn't silently vanish from the table.
  dormant: boolean;
  // Most recent activity (thread opened / review comment / review submitted) across the
  // 12-week trend span; ISO. Null when nothing in the span carried a timestamp.
  lastActiveAt: string | null;
  trend: BotVendorTrendPoint[];   // ≤12 weekly points, oldest→newest
}
export interface BotAnalyticsResponse {
  enabled: boolean;
  generatedAt: string;
  window: { kind: BotWindowKind; from: string; to: string };
  vendors: BotVendorAnalytics[];  // most-threads-first
  // Automated reviewers classified `quality_check` (SonarQube, Codecov, …) — the SAME row shape,
  // computed the same way, but kept OUT of `vendors`, `totals` and `suggestions` because they are
  // not reviewers: their volume inflates thread counts and their untouched threads would earn a
  // `noisy` verdict for doing exactly their job. Rendered as a collapsed "excluded from ROI"
  // section so a user can still see they are running, and so a mis-role is discoverable rather
  // than looking like the bot vanished. Optional purely for wire back-compat with an older
  // plugin/response; treat absent as [].
  qualityChecks?: BotVendorAnalytics[];
  // `botOnlyPrs` = currently-OPEN (mergeable) PRs in the account's repos whose only review/comment
  // touch was automated (incl. Pierre-verbatim) — no human review AND no human comment. Merged PRs
  // are excluded (the banner is a "needs a human before it merges" signal); the drill-down list
  // adds merged behind a toggle. See getBotOnlyReviewPrs / getBotVendorPrs.
  // `overdueGraceMs` = the fixed grace window (currently 36h): a not-addressed thread counts as
  // `overdueUntouched` (feeding the `noisy` verdict) once it's older than this. NOT the measured
  // reply time — that's intrinsically fast (sample bias), so a flat cutoff is the fair gate. Each
  // row's own `medianResponseMs` is display-only.
  // `overlapClusters` = distinct line areas (the shared ±3-line clustering, db/line-overlap.ts)
  // that MORE THAN ONE review bot flagged in this window — quality checks and null-line
  // (outdated / file-level) threads excluded, i.e. exactly the population the per-vendor overlap
  // columns are credited from. DETERMINISTIC (thread line data, no model), which is why it sits
  // here rather than on the `ml` block, even though the UI renders it on the flagging strip.
  // ⚠ It is NOT the sum of the rows' `overlapThreads`: a cluster credits EVERY bot in it, so
  // that sum counts each shared area at least twice.
  totals: { threads: number; comments: number; actedOn: number; actedOnPct: number | null; untouched: number; botOnlyPrs: number; overdueGraceMs: number; overlapClusters: number };
  // The windowed ML label rollup for the WHOLE scope (every automated reviewer, BOTH roles —
  // quality checks post exactly the kind of finding a severity label is for). Feeds the severity
  // totals strip that used to be the standalone /api/bot-severity panel, computed over the SAME
  // window as everything else in this response so one screen carries one time grain. Optional
  // purely for wire back-compat (and omitted on the empty-scope early returns); treat absent as
  // "nothing labelled". The SPA's render gate stays `MeResponse.mlSeverity`.
  ml?: BotAnalyticsMlTotals;
  suggestions: BotTuningSuggestion[];  // WS6c, deterministic
}

// The windowed twin of BotSeverityResponse.totals (same exclusion semantics: `bySeverity` and
// every rate are FINDINGS-only; summaries and praise are labelled work, not findings).
export interface BotAnalyticsMlTotals {
  labelled: number;   // every label in window: findings + summaries + praise
  findings: number;
  summaries: number;
  praise: number;
  // Unlabelled bot text IN THE WINDOW (the coverage denominator's other half). Same
  // hasText/no-label predicate as the candidate query, additionally window-bounded — so the
  // strip's "X of Y scored" stays a statement about the window it sits over. ⚠ pending > 0 is
  // NOT "scoring in progress" — that judgement stays with isMlScoring over /api/ml-status.
  pending: number;
  // Bot text that can NEVER be scored (body IS NULL — legacy lean-storage rows whose text
  // GitHub itself no longer has). ALL-TIME within the scope, not windowed: the population is
  // old by nature and a windowed count would read 0 while badges are visibly missing below.
  // Counted separately so "pending 0" cannot claim 100% coverage while badges are missing —
  // the same honesty rule BotSeverityResponse.unscorable pins, rehomed here when the merged
  // table replaced that response's panel.
  unscorable: number;
  bySeverity: MlSeverityCounts;
  byCategory: Array<{ category: MlCategory; count: number }>;
  // Distinct `backend` strings seen in window — none containing 'modernbert-onnx' means the
  // marker fallback labelled everything (surfaced, not hidden).
  backends: string[];
  // The label scan is capped (newest-first ORDER BY); true when the cap was hit, so the numbers
  // are a sample — said out loud, same honesty rule as the unwindowed rollup.
  truncated: boolean;
}

// ── THEMES shapes (Pro, AI) — the Bots "What they're flagging" panel, the Feed "Discussion
// themes" report + the plugin theme parse ────────────────────────────────────────────────────
// Originally the Bots "Themes" tab's wire shapes, briefly retired into the synthesis seam's
// 'workspace-bots' kind and REVIVED merged with the deterministic Bots layer: BotThemesResult is
// the wire result of GET/POST /api/pro/bot-themes (the panel that replaced the SynthesisCard
// mount on the main Bots view — the three drill-down synthesis cards are unaffected). The same
// vocabulary also serves the HUMAN sibling — the Feed "Discussion themes" summary
// (HumanThemesResult reuses BotTheme + the category/severity/area/coverage shapes below) — and
// the plugin's tolerant theme parse (parseThemes), which both prompts share.
export type BotThemeCategory =
  | 'correctness'
  | 'security'
  | 'performance'
  | 'error_handling'
  | 'testing'
  | 'style'
  | 'docs'
  | 'maintainability'
  | 'other';
export type BotThemeSeverity = 'critical' | 'major' | 'minor' | 'nit';

// A PR reference carried on a theme — clickable in the UI to open that PR's own full detail tab.
// Resolved SERVER-side from the theme's members (so the number is never ambiguous across repos).
export interface ThemePrRef {
  prId: number;
  prNumber: number;
  repoFullName: string;
  title: string | null;
  authorLogin: string | null;
}

// One concrete comment/thread that a theme groups — the "click the card → all its threads"
// drill-down fetches each member's PR detail and renders the thread (review) or PR-comment (issue)
// with the existing ThreadView. `threadId` set for a review-thread member, `commentId` (prComments
// id) for an issue-comment member.
export interface ThemeThreadRef {
  prId: number;
  prNumber: number;
  repoFullName: string;
  source: 'review' | 'issue';
  threadId: number | null;
  commentId: number | null;
  path: string | null;
}

// One recurring class of issue/topic the reviewers (bots or people) raise, as read by the model.
// `occurrences` is the model's estimate of how many comments the theme covers; `bots`/`areas` are
// the reviewer/author labels + top-level dirs it spans. `prs` (clickable) + `threads` (the
// drill-down members) are RESOLVED server-side from the payload items the model grouped.
export interface BotTheme {
  title: string;
  category: BotThemeCategory;
  severity: BotThemeSeverity;
  summary: string; // one sentence
  occurrences: number;
  bots: string[];
  areas: string[];
  prs: ThemePrRef[]; // distinct PRs the theme touches (resolved), most-relevant-first
  threads: ThemeThreadRef[]; // concrete member threads/comments (capped) for the drill-down
  // DETERMINISTIC comment count (bot reports only): Σ of each cited cluster's code-computed
  // `count` over the theme's deduplicated memberIds — a code fold of code-derived numbers (D4),
  // unlike `occurrences` (the model's own estimate, kept as the render fallback). Optional
  // because human reports never set it and stored pre-count bot rows lack it.
  commentCount?: number;
}

// Per-automated-reviewer rollup (DETERMINISTIC — from the raw rows, not the model). `key` mirrors
// the ROI row identity (`u<userId>`); `actedOnPct` is the derived-state acted-on share of the
// bot's threads in the analyzed set.
export interface BotThemeBotRollup {
  key: string;
  label: string;
  login: string | null;
  kind: AutomatedReviewerKind;
  comments: number;
  actedOnPct: number | null;
}

export interface BotThemeCategoryCount { category: BotThemeCategory; count: number; }
export interface BotThemeSeverityCount { severity: BotThemeSeverity; count: number; }
export interface BotThemeAreaCount { area: string; count: number; }

// How much of the raw bot-comment stream the summary actually covered — surfaced verbatim so a
// truncated / heavily-deduped result never reads as "we looked at everything".
export interface BotThemeCoverage {
  totalComments: number; // bot comments in the analyzed set (post-scope/window, pre-dedup)
  deduped: number;       // distinct comment clusters after near-duplicate collapse
  analyzed: number;      // clusters actually sent to the model (post-cap)
  truncated: boolean;    // the host row fetch hit its cap (older comments beyond it excluded)
}

export interface BotThemesResult {
  narrative: string;                    // markdown — the 2–3 sentence overview
  themes: BotTheme[];                   // most-critical-first
  bots: BotThemeBotRollup[];            // per-reviewer volume + acted-on (deterministic)
  byCategory: BotThemeCategoryCount[];  // aggregated from themes (approximate)
  bySeverity: BotThemeSeverityCount[];  // aggregated from themes (approximate)
  byArea: BotThemeAreaCount[];          // top-level-dir distribution (deterministic)
  coverage: BotThemeCoverage;
  generatedAt: string;                  // ISO
  model: string;
}

export interface BotThemesResponse {
  enabled: boolean;             // the Pro AI-summary tier is on (else the panel shouldn't render)
  result: BotThemesResult | null; // the last generated report for this (scope, window); null = none yet
  throttled?: boolean;          // a generation was already in flight (or inside the min interval)
  creditsExhausted?: boolean;   // out of the monthly AI-credit allowance
  empty?: boolean;              // no bot comments in scope/window → nothing to summarize
}

// ── Human "Discussion" THEMES (Pro, AI) — GET/POST /api/pro/human-themes ─────────────────────
// The HUMAN sibling of the (revived) Bot "Themes" summary: the same themed AI read, but over PEOPLE'S
// review comments (non-bot authors, INCLUDING human replies inside bot threads) rather than the bots'. It
// answers "what are people actually discussing / raising in review?" — recurring concerns, debates,
// decisions, questions. STRICTLY Pro (activityDigest tier), workspace-scoped, surfaced as a Feed
// sub-tab.
// UNLIKE the bot version it does NO deterministic categorisation of the input: the funnel just
// PRIORITISES (PR-level comments, then threads that have responses, then recency) up to a safe cap —
// the categorisation/severity is the model's alone. Reuses BotTheme + the category/severity/area/
// coverage shapes; only the reviewer rollup differs (people, not bots).
export interface HumanThemeParticipant {
  userId: number;
  login: string | null;
  displayName: string | null;
  comments: number; // the participant's comment count in the analyzed set (deterministic)
}

export interface HumanThemesResult {
  narrative: string;                    // markdown — the 2–3 sentence overview
  themes: BotTheme[];                   // most-critical-first (LLM-assigned category + severity)
  participants: HumanThemeParticipant[]; // per-author volume (deterministic), most-active-first
  byCategory: BotThemeCategoryCount[];  // aggregated from themes (approximate)
  bySeverity: BotThemeSeverityCount[];  // aggregated from themes (approximate)
  byArea: BotThemeAreaCount[];          // top-level-dir distribution (deterministic)
  coverage: BotThemeCoverage;           // `deduped` == totalComments here (the human funnel does NOT dedup)
  generatedAt: string;                  // ISO
  model: string;
}

export interface HumanThemesResponse {
  enabled: boolean;
  result: HumanThemesResult | null;
  throttled?: boolean;
  creditsExhausted?: boolean;
  empty?: boolean;
}

// ── Bot BEHAVIOUR analytics — GET /api/pro/bot-behaviour (plugin, `botDepth`; the compute
// stays CORE in db/queries.ts, reached via the ProHostQueries.getBotBehaviour seam) ─────────
// A SEPARATE, deterministic (no-AI) surface from the Bot-ROI panel, developed in its own
// "Behaviour" sub-tab so it can mature without touching the shipped ROI response. Answers the
// common review-bot gripes: how fast does a bot get to a PR (TTFR), how noisy is it per line of
// code, WHEN across the day is it active (coverage / rate-limit inference), and does it keep
// finding issues AFTER its first pass. All figures are computed over the shared bot-analytics
// window; per-bot, account- + scope-scoped. Aggregate-only for now (per-PR is a follow-up).
// One weekly point in a bot's behaviour trend (oldest→newest, ≤12 weeks). Each metric carries
// its own `*Anomaly` flag — true when that week diverged from the BOT'S OWN robust baseline
// (median ± MAD over its trend), so a customer's consistency claim can be checked against
// evidence. TTFR flags only SLOWER-than-typical weeks; volume + follow-up flag EITHER direction.
export interface BotBehaviourTrendPoint {
  weekStart: string; // ISO — bucket start
  medianTtfrHours: number | null; // median time-to-first-review for PRs first touched that week
  volume: number; // the bot's touches (reviews + comments) that week
  followupRatePct: number | null; // share of that week's first-reviewed PRs the bot came back to
  ttfrAnomaly: boolean; // this week's TTFR is anomalously HIGH vs the bot's typical
  volumeAnomaly: boolean; // this week's volume diverges (either way) from typical
  followupAnomaly: boolean; // this week's follow-up rate diverges (either way) from typical
  // Findings DENSITY — how many review threads the bot OPENS per PR / per 1000 changed lines, over
  // the PRs it first touched that week. This is the "is code quality improving?" signal: a FALLING
  // density means fewer issues raised per PR / per line over time (cleaner code or better self-
  // review) — an approximate proxy (a tuned-down bot or more trivial PRs read the same way). A PR
  // the bot reviewed but opened no thread on contributes a real 0. Null when no PRs that week.
  findingsPerPr: number | null; // bot threads opened ÷ PRs reviewed that week
  findingsPerKloc: number | null; // bot threads opened ÷ (changed LoC / 1000) that week
  prsInWeek: number; // PRs the bot first touched that week (the density denominator, for confidence)
  densityAnomaly: boolean; // this week's per-KLoC density diverges (either way) from the bot's typical
}

// A single flagged divergence — the evidence behind a chart marker (observed vs the bot's own
// typical + the robust z-magnitude). `metric:'silence'` is a coverage GAP (a run of silent days
// for a normally-regular bot); its `spanDays`/`dayStart` describe the run, `z` is null.
export interface BotBehaviourAnomaly {
  metric: 'ttfr' | 'volume' | 'followup' | 'silence' | 'density';
  direction: 'high' | 'low';
  weekStart?: string; // weekly metrics — the affected week
  dayStart?: string; // silence — the run's first silent day (ISO)
  spanDays?: number; // silence — how many consecutive silent days
  observed: number; // the week's value (TTFR hours / volume / follow-up % / gap days)
  typical: number; // the bot's robust median for this metric
  z: number | null; // robust z-score magnitude (null for silence runs)
}

export interface BotBehaviourBotStat {
  key: string; // stable per-reviewer row key `u<userId>` — mirrors BotVendorAnalytics.key
  userId: number;
  login: string | null;
  kind: AutomatedReviewerKind;
  label: string; // custom classification label → vendor name → login (mirrors ROI reviewerLabel)
  prsReviewed: number; // distinct PRs the bot FIRST touched inside the window
  // Time-to-first-review: the bot's first activity (review/comment) since the PR became ready
  // for review (fallback: opened). ttfrBaseline reports which clock start dominated (transparency).
  ttfrMedianHours: number | null;
  ttfrP90Hours: number | null;
  ttfrBaseline: 'ready' | 'opened' | 'mixed' | null;
  ttfrDist: AnalyticsBin[]; // bucketed distribution (<1h, 1–4h, 4–12h, 12–24h, 1–3d, >3d)
  // ≤12 weekly points carrying TTFR / volume / follow-up + their per-week anomaly flags. The
  // trend SPAN is also the anomaly baseline (a self-baseline, so each bot is judged vs itself).
  trend: BotBehaviourTrendPoint[];
  // Follow-up cadence: median gap between the bot's consecutive touches ON THE SAME PR (how long
  // between a bot's first pass and its next comment — the "review latency after first review").
  followupLatencyMedianHours: number | null;
  // LoC-to-bot-comments: PR diff size (additions+deletions) ÷ the bot's comment count on that PR,
  // median across the window's PRs (lower = noisier per line). totalComments is the raw denominator.
  medianLocPerComment: number | null;
  totalComments: number;
  // Activity distribution across the week × hour (UTC), row-major dow*24+hour, dow 0=Sunday,
  // length 168 — the SAME convention as RepoAnalytics.activityHeatmap. Gaps/anomalies here hint at
  // rate-limit throttling or coverage windows (INFERRED from review/comment timestamps, labelled so).
  activityHeatmap: number[];
  totalActivity: number; // sum of the heatmap (bot touches in-window)
  // Daily touch counts over the trend span (oldest→newest), for the coverage strip + gap
  // detection. daySpanStart is the ISO date of dailyActivity[0]; silentRuns marks the anomalous
  // gaps (index into dailyActivity + run length) for a normally-regular bot.
  dailyActivity: number[];
  daySpanStart: string;
  silentRuns: { startDay: number; days: number }[];
  // Every flagged divergence (weekly metrics + silence runs), newest-first — the evidence behind
  // the chart markers (tooltip text / a per-chart exception count).
  anomalies: BotBehaviourAnomaly[];
  // Follow-up behaviour: does the bot come back after its first pass? followupRatePct = share of
  // reviewed PRs with >1 touch; avgFollowups = mean extra touches; followupDist buckets the count.
  followupRatePct: number | null;
  avgFollowups: number | null;
  followupDist: AnalyticsBin[]; // buckets: 0, 1, 2–3, 4+
}

// ── Cross-bot overlap + coverage (EXPERIMENTAL) — the "where do bots collide / operate" view ──
// All three are DETERMINISTIC, CORE, computed over the SELECTED window + scope from already-stored
// data (touch rows + reviewThreads.path/line — no lean-gated diffHunk needed). Overlap counts
// DISTINCT BOT ACCOUNTS (two automated reviewers = an overlap), not vendor kinds.
export interface BotCoReviewPair {
  aKey: string; // `u<userId>` of one bot
  bKey: string; // `u<userId>` of the other (aKey < bKey for stability)
  aLabel: string;
  bLabel: string;
  prs: number; // PRs BOTH bots touched in-window
}
export interface BotOverlapStats {
  reviewedPrs: number; // PRs ≥1 automated reviewer touched in-window (the denominator)
  multiReviewedPrs: number; // of those, how many ≥2 DISTINCT bots touched
  // PR counts bucketed by how many distinct bots touched them: "1 bot" | "2 bots" | "3+ bots".
  distribution: AnalyticsBin[];
  pairs: BotCoReviewPair[]; // co-review pairs, most-overlapping first (capped) — the pair matrix
  // ±3-line clusters (the ONE shared definition, backend db/line-overlap.ts; null-line threads
  // excluded) flagged by ≥2 DISTINCT bots — "same line" hits. Was exact-(path,line) equality
  // with a per-file null-line lump; the counts stepped once when the definition unified.
  lineOverlapClusters: number;
  lineOverlapPrs: number; // distinct PRs carrying ≥1 such same-line overlap
}
// Merged "where bots work" breakdown: per bot, its inline-thread volume split by the repos it
// operates in AND, within each repo, the top-level directories/areas. Powers the grouped+stacked
// bot chart (X = bot; one bar per repo; each bar stacked by directory). A single-repo scope
// collapses to one bar per bot. `dirs` are that repo's top dirs desc (capped) + an 'other' tail;
// `repos` are the bot's top repos by volume (capped), while `totalThreads` counts ALL its repos.
export interface BotRepoDirBreakdown {
  key: string; // `u<userId>`
  label: string;
  login: string | null;
  kind: AutomatedReviewerKind;
  totalThreads: number;
  repos: {
    repoId: number;
    repoName: string; // owner/name
    totalThreads: number;
    dirs: { dir: string; count: number }[];
  }[];
}

// ── ML severity/category on the Behaviour tab (CORE, free tier) ──────────────────────────────
// The label corpus (`ml_comment_labels`) folded over the SAME scope + bot set as the rest of this
// response, so a row here joins a `bots` row by `key`. Two grains, and they are NOT the same:
//   • the flat counts describe the SELECTED WINDOW (what the panel's window picker says),
//   • `weekly` describes the 84-day trend span, bucketed on the SAME week boundaries as
//     BotBehaviourTrendPoint.weekStart, so a severity chart lines up with the density chart.
//
// ⚠ TWO DIFFERENT EXCLUSIONS, on purpose. Severity counts are FINDINGS-ONLY — summaries and
// praise-category rows are labelled work but not findings, exactly as getBotSeverityRollup has it
// (a share over findings could otherwise top 100%). CATEGORY counts cover every NON-SUMMARY row,
// so `praise` appears as a category of its own: "what do the bots talk about" is a fair question
// to ask of an acknowledgment, while a walkthrough's categories are an artefact of the marker
// parser reading a summary table and stay excluded from both.
export interface BotBehaviourMlWeekPoint {
  weekStart: string; // ISO — IDENTICAL to the matching BotBehaviourTrendPoint.weekStart
  bySeverity: MlSeverityCounts; // findings-only
  byCategory: Array<{ category: MlCategory; count: number }>; // non-summary (praise included)
}

export interface BotBehaviourMlBot {
  key: string; // `u<userId>` — joins BotBehaviourBotStat.key (identity/colour come from there)
  // ── Selected window ──
  findings: number; // the denominator every share on this object divides by
  bySeverity: MlSeverityCounts; // OUR model's severity, findings-only
  // ── THE BOT'S OWN DECLARED BADGE — shown beside ours, never believed. ──────────────────
  // Findings-only, and only the ones where the vendor declared a badge at all, so it does NOT
  // sum to `findings`; `vendorDeclared` is that (usually much smaller) denominator, carried so
  // a chart can state its own sparsity instead of implying the two mixes are comparable.
  // Nothing derives from these — see MlLabel.vendorSeverity on why (0.474 vs 0.700 exact).
  byVendorSeverity: MlSeverityCounts;
  vendorDeclared: number;
  // ── The SEVERITY INFLATION INDEX — how often the two claims disagree, and which way. ──────
  // Over `vendorDeclared` (the badged findings), so `vendorAgree + vendorOverCall +
  // vendorUnderCall === vendorDeclared` — the same invariant SeverityAgreementMatrix keeps, and
  // for the same reason: a bot that declared nothing is SILENT, not in conflict, so an
  // unbadged finding counts in none of the three.
  //
  // ⚠ `vendorOverCall` is the interesting one — the bot called it WORSE than we did. That is
  // inflation, and it is a fact about the VENDOR, never a correction of ours: nothing here
  // seeds, breaks a tie for or falls back to `severity` (0.474 vs 0.700 exact on the
  // adjudicated gold-300 — see MlLabel.vendorSeverity). Direction is ordinal on both sides,
  // never confidence and never severityProb.
  vendorAgree: number;
  vendorOverCall: number; // the BOT graded it worse than we did (inflation)
  vendorUnderCall: number; // WE graded it worse than the bot did
  byCategory: Array<{ category: MlCategory; count: number }>; // non-summary, desc by count
  // ── 84-day trend span, oldest→newest, one point per trend week (same length as `trend`) ──
  weekly: BotBehaviourMlWeekPoint[];
}

export interface BotBehaviourMl {
  perBot: BotBehaviourMlBot[]; // only bots with ≥1 non-summary label in the span
  // The label scan is capped (newest-first). True when the cap was HIT, so these counts are a
  // sample rather than a total — the same honesty rule as BotSeverityResponse.truncated.
  truncated: boolean;
}

export interface BotBehaviourResponse {
  enabled: boolean; // always true (CORE / deterministic) — parallels BotAnalyticsResponse.enabled
  generatedAt: string;
  window: { kind: BotWindowKind; from: string; to: string };
  bots: BotBehaviourBotStat[]; // most-active-first
  // ML severity/category fold. ABSENT (not an empty block) when no bot in scope has a single
  // non-summary label — which is also what an install with no severity-api configured looks
  // like, since nothing ever writes a label there. The client renders no ML cards at all in
  // that case, rather than a row of empty ones.
  ml?: BotBehaviourMl;
  // Cross-bot overlap + coverage (EXPERIMENTAL), over the selected window + scope:
  overlap: BotOverlapStats; // (i) multiple bots on the same PR + (ii) same-line overlap
  repoBotDirs: BotRepoDirBreakdown[]; // (iii) merged "where bots work" — per bot × repo × directory
  // Second coverage-strip series (SHARED, not per-bot — PR inflow is an account/repo fact):
  // per-day count of human-authored, non-draft PRs opened over the SAME 84-day span + scope as
  // every bot's dailyActivity, oldest→newest, aligned to daySpanStart. Overlaid on each bot's
  // DayStrip so silent runs can be read against real PR inflow ("bot dark while PRs kept coming").
  prsOpenedPerDay: number[];
  daySpanStart: string; // ISO date of prsOpenedPerDay[0] (== every bot's daySpanStart)
}

// ── PR-scoped bot behaviour (EXPERIMENTAL) — GET /api/prs/:id/bot-behaviour ─────────────────
// The per-PR view of the aggregate Behaviour tab: for THIS PR, each automated reviewer's touch
// timeline + how its behaviour ON THIS PR compares to that bot's OWN typical (an 84-day
// account-wide robust baseline). Powers the PrDetail "Bot activity" tab + the Overview chip's
// "slower than typical" warn badge. CORE / deterministic, account-scoped (id-route → 404).
export interface PrBotTouch {
  at: string; // ISO
  kind: 'review' | 'comment';
}

export interface PrBotBehaviour {
  key: string; // `u<userId>` — mirrors the aggregate BotBehaviourBotStat.key
  userId: number;
  login: string | null;
  kind: AutomatedReviewerKind;
  label: string;
  // This PR
  firstTouchAt: string | null; // the bot's first review/comment on this PR
  ttfrHours: number | null; // first touch since ready-for-review (fallback opened)
  ttfrBasis: 'ready' | 'opened' | null; // which clock start this PR used (transparency)
  touchCount: number; // total touches on this PR
  followupCount: number; // touches after the first (== touchCount − 1)
  commentCount: number;
  touches: PrBotTouch[]; // the timeline (oldest→newest)
  // Vs the bot's own typical (84-day account-wide robust baseline; null when < the baseline
  // minimum PRs, i.e. "building baseline"). ttfrAnomaly is set only when THIS PR's TTFR is
  // anomalously SLOWER than typical (the "delays beyond typical" evidence).
  typicalTtfrHours: number | null;
  typicalFollowups: number | null; // the bot's median follow-ups per PR
  baselinePrs: number; // how many of the bot's PRs the baseline is built from
  ttfrAnomaly: { z: number; typical: number } | null; // slower-than-typical outlier on this PR
}

export interface PrBotBehaviourResponse {
  enabled: boolean; // true (CORE); the tab renders whenever a PR has automated-reviewer activity
  prId: number;
  bots: PrBotBehaviour[]; // reviewers that touched this PR, first-touch order
}

// One PR row behind a vendor's Bot-ROI panel — the drill-down list of PRs one automated REVIEWER
// touched in the window (GET /api/bot-analytics/vendor/:key/prs). Deterministic, no AI, account-
// scoped; ordered most-recent-bot-activity first.
export interface BotVendorPr {
  prId: number;
  repoId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  authorId: number | null;
  state: PrState;
  githubUrl: string;
  ciStatus: CiStatus | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  openedAt: string; // ISO-8601
  botThreads: number;   // review threads this vendor opened on the PR (in window)
  botComments: number;  // review comments this vendor authored on the PR (in window)
  botActedOn: number;   // of botThreads, acted-on (resolved | likely_addressed | human follow-up)
  botUntouched: number; // of botThreads, still `untouched`
  lastBotActivityAt: string | null; // ISO-8601 — max createdAt across this vendor's threads+comments
  // This PR has automated touch and NO human review AND NO human comment since it opened.
  botOnly: boolean;
}

export interface BotVendorPrsResponse {
  enabled: boolean;
  // The analytics-row identity this list belongs to: `u<userId>` for a per-reviewer row, or the
  // 'pierre' sentinel (per-review provenance, no userId). Mirrors BotVendorAnalytics.key.
  key: string;
  kind: AutomatedReviewerKind;
  label: string;
  // The reviewer's github login (per-reviewer rows); null for the 'pierre' sentinel or an
  // unresolved login.
  login: string | null;
  window: { kind: BotWindowKind; from: string; to: string };
  prs: BotVendorPr[]; // most-recent-bot-activity first
  generatedAt: string;
}

// One comment row behind a vendor's COMMENTS drill-down — the individual things one automated
// reviewer said in the window (GET /api/bot-analytics/vendor/:key/comments): inline review
// comments (with path + thread state), issue-level PR comments, and review BODIES, each with its
// stored ML label shipped INLINE. One request carries everything — a cross-PR list must never
// mount the per-PR label index per row (the ThreadAssessment 60-requests-for-60-empty-boxes
// failure; docs/ML-SEVERITY.md § UI).
export interface BotVendorComment {
  // Which id space `targetId` lives in — the same discriminator `ml_comment_labels` keys on.
  targetKind: MlLabelTargetKind;
  targetId: number;
  prId: number;
  prNumber: number;
  prTitle: string;
  prAuthorId: number | null;
  repoId: number;
  repoFullName: string;
  path: string | null;               // inline review comments only
  threadId: number | null;           // inline review comments only
  derivedState: DerivedState | null; // inline threads only
  body: string | null;               // full markdown — comment/review bodies are always persisted
  createdAt: string;                 // ISO-8601
  // The stored ML label for this target, or null when it has not been scored (or the deployment
  // has no scoring service) — the row still renders, just unbadged.
  mlLabel: MlLabel | null;
}

export interface BotVendorCommentsResponse {
  enabled: boolean;
  // `u<userId>` | 'pierre' — mirrors BotVendorAnalytics.key. The 'pierre' sentinel always
  // answers empty: its verbatim reviews are posted with the human's token, so there are no
  // attributable per-comment rows (same reasoning as its getBotVendorPrs special case).
  key: string;
  kind: AutomatedReviewerKind;
  label: string;
  login: string | null;
  window: { kind: BotWindowKind; from: string; to: string };
  comments: BotVendorComment[]; // newest-first, capped per source
  truncated: boolean;           // a source (or the combined stream) hit the cap
  generatedAt: string;
}

// The exact PR LIST behind getBotAnalytics's totals.botOnlyPrs count — "only a bot reviewed
// these" (GET /api/bot-analytics/bot-only-prs). Served by a DEDICATED route so the amber caption
// and its expandable list are computed from the SAME query and can never disagree: the count is a
// PR-STATE snapshot (merged-in-window OR open-and-mergeable at any age, bot-touch judged over the
// PR's ENTIRE history), NOT the 14-day feed event stream. Deterministic, no AI, account-scoped;
// the bot-only rule is getBotOnlyReviewPrs's — automated review/comment touch (incl. Pierre-
// verbatim) with NO human review AND NO human comment.
export interface BotOnlyPrItem {
  prId: number;
  number: number;
  title: string;
  repoId: number;      // for the cross-repo drill-down's repo filter
  repoFullName: string;
  botLabel: string;    // the first automated reviewer's label ("CodeRabbit" | "Pierre · Claude" | …)
  state: PrState;      // 'open' (mergeable) | 'merged' (in window)
  githubUrl: string;
  openedAt: string;    // ISO-8601 — the PR age (sortable)
  updatedAt: string;   // ISO-8601 — last activity (sortable)
  authorId: number | null;
  // The PR's only automated touch is a Pierre-verbatim review — posted with the human's
  // token, so it has NO bot-actor events and the bot-only feed isolation can't surface it
  // (the UI hides "Show in feed" for these rows).
  viaPierreOnly: boolean;
}
export interface BotOnlyPrsResponse {
  window: { kind: BotWindowKind; from: string; to: string };
  prs: BotOnlyPrItem[]; // no inherent order — a small, bounded list
  generatedAt: string;
}

// ── WS4 cross-bot dedup + consensus ─────────────────────────────────
// A member is ONE BOT in the cluster (collapsed server-side): `threadId` is its representative
// thread, `threadIds` every thread it contributed (cluster order) — the ×N pill count + the
// click-cycle. `label` is the per-reviewer label (custom classification label → vendor name →
// login), so two in-house bots read differently.
export interface BotDedupMember {
  threadId: number; userId: number; kind: AutomatedReviewerKind;
  login: string; label: string; excerpt: string | null; derivedState: DerivedState;
  addressedConfidence: AddressedConfidence;
  // Optional-ADDITIVE. NOT for IndexedDB reasons — ['bot-dedup', prId] is not in the
  // persist whitelist (main.tsx dehydrates only 'pr'/'thread'/'pr-files'), so no cached
  // member survives a reload. It is optional for the IN-MEMORY cache within one session
  // (a response fetched before a deploy… cannot happen either — a deploy needs a reload).
  // Kept optional purely as additive-wire hygiene; consumers treat absent as [threadId].
  threadIds?: number[];
}
export interface BotDedupCluster {
  path: string; line: number | null;
  members: BotDedupMember[];   // ONE per bot; entry gate = ≥2 threads from ≥2 DISTINCT USERS
  consensus: boolean;          // all same broad signal
  conflict: boolean;           // divergent severity/verdict
}
export interface BotDedupResponse { prId: number; clusters: BotDedupCluster[]; }

// ── Bot tuning suggestions (advisory; deterministic — no action attached) ───
// Three shapes share the row. A PATH suggestion (`pathGlob` set, `severity` null) keys on the
// untouched share of one (bot, path-bucket). A SEVERITY suggestion (`severity` set — today only
// 'nit', from the windowed ML label fold) keys on the nit share of the bot's scored findings.
// An OVERLAP suggestion (`partnerLabel` set; pathGlob + severity both null) keys on the share
// of the bot's threads landing on lines its top partner also flagged (the ±3-line shared
// definition) — redundant coverage. `untouchedPct` carries whichever share the suggestion keys
// on; `volume` is the population it was measured over (threads for path/overlap, scored
// findings for severity). ADVISORY every way — neither the ML nor the overlap shape may ever
// feed `botVerdict` (nothing auto-acts on either; the verdict's semantics are pinned by
// bot-analytics-verdict.test.ts).
export interface BotTuningSuggestion {
  vendorKind: AutomatedReviewerKind; label: string;
  pathGlob: string | null; severity: string | null;
  // The top overlap partner's display label — set ONLY on the overlap shape (its discriminator).
  partnerLabel?: string;
  untouchedPct: number; volume: number; rationale: string;
}

// ── Bot Tuning Advisor (Pro surface; findings computed DETERMINISTICALLY in core) ───────────
// The advisor turns the graded-comment corpus into evidence-backed configuration changes for
// each bot. Core computes the CELLS (pure aggregation over threads + ml_comment_labels — no
// LLM, no persistence); the Pro plugin maps cells → intents → emitter output. Same advisory
// rule as BotTuningSuggestion: nothing here may ever feed `botVerdict`.
//
// The nine intent kinds the plugin derives from these cells. Core never decides an intent —
// it only reports what happened; the thresholds that turn a cell into a recommendation live in
// the plugin (packages/pro/src/advisor/intents.ts). QUIET_PATH_NITS is the noise-focused
// middle ground between SUPPRESS_PATH and nothing: keep the path, stop nit-level comments
// there — the shape a cell earns when full suppression is vetoed (acted-on high-severity
// present) but the path is still nit-dominated and ignored.
export type AdvisorIntentKind =
  | 'SUPPRESS_PATH'
  | 'QUIET_PATH_NITS'
  | 'SUPPRESS_CATEGORY'
  | 'LOWER_VERBOSITY'
  | 'SCOPE_OFF'
  | 'AMPLIFY_PATH'
  | 'ESCALATE'
  | 'PROMOTE_TO_LINT'
  | 'BOOTSTRAP_CONFIG';

// One (bot × path-bucket) cell over the bot's window THREADS. `actedOnHigh` counts acted-on
// threads whose ORIGIN comment is labelled major/critical — the retro-check numerator ("this
// filter would also have hidden M high-severity findings you acted on"); `actedOnNits` is the
// same numerator for the nit-scoped filter (QUIET_PATH_NITS).
export interface AdvisorPathCell {
  botUserId: number;
  // Adaptive depth: '<seg>/<seg>/**' when that depth-2 prefix alone met the thread floor,
  // else '<seg>/**' (or the bare filename for a root-level file). Emitted cells never
  // overlap — a parent is emitted only when NONE of its depth-2 children qualified.
  pathBucket: string;
  volume: number; // threads
  actedOn: number; // merged definition: resolved | likely_addressed | human follow-up
  actedOnHigh: number;
  actedOnNits: number;
  untouched: number;
  // Untouched threads whose PR has SINCE MERGED (merged-by-now, unlike the ROI table's
  // window-merged `mergedPastPrs`) — the team's final answer was to ship anyway. The
  // suppression gate: silence on an open PR is not final; this is.
  mergedUntouched: number;
  overdueUntouched: number;
  dissent: number; // replied_unresolved threads — pushback, not silence
  bySeverity: MlSeverityCounts; // origin-comment labels, findings only (praise/summary excluded)
  samplePrIds: number[];
  sampleThreadIds: number[];
}

// One (bot × category) cell over the bot's window ML-LABELLED FINDINGS (praise + isSummary
// excluded from every denominator). Acted-on facts exist only for the THREAD-LINKED subset
// (`threadLinked` — labels whose target opened a review thread); PR comments and review bodies
// have no thread and therefore no acted-on claim.
export interface AdvisorCategoryCell {
  botUserId: number;
  category: MlCategory;
  findings: number;
  bySeverity: MlSeverityCounts;
  threadLinked: number;
  actedOn: number;
  actedOnHigh: number;
  untouched: number;
  mergedUntouched: number; // thread-linked untouched whose PR has since merged (see AdvisorPathCell)
  overdueUntouched: number;
  dissent: number;
  samplePrIds: number[];
}

// One directed (bot → partner) overlap cell: shared ±3-line clusters (db/line-overlap.ts, the
// same definition every overlap surface uses). Emitted per direction so each bot's share is a
// plain division: overlapThreads / threads.
export interface AdvisorOverlapCell {
  botUserId: number;
  partnerUserId: number;
  sharedClusters: number;
  overlapThreads: number; // THIS bot's window threads landing in ≥2-bot clusters (pooled, all partners)
  threads: number; // this bot's window threads (the share's denominator)
}

// Per-bot totals over the window — the LOWER_VERBOSITY / SCOPE_OFF / BOOTSTRAP_CONFIG inputs,
// plus the path-coverage disclosure every path-keyed finding must carry (only labels of the
// `review_comment` kind can ever resolve to a path; PR comments and review bodies never will).
export interface AdvisorBotTotals {
  botUserId: number;
  key: string; // `u<userId>` — the same row key the Bots table uses
  kind: AutomatedReviewerKind;
  label: string;
  login: string | null;
  isQualityCheck: boolean; // quality checks appear here for context but emit NO cells
  threads: number;
  actedOn: number;
  untouched: number;
  mergedUntouched: number; // untouched threads whose PR has since merged (see AdvisorPathCell)
  overdueUntouched: number;
  dissent: number;
  mlLabelled: number; // all labels in the window (incl. praise/summaries)
  mlFindings: number; // findings only
  mlNits: number;
  // Acted-on window threads whose ORIGIN comment is labelled 'nit' — the LOWER_VERBOSITY
  // retro-check numerator ("raising the severity floor would also have hidden N nits you
  // acted on"). Thread-linked labels only, by construction.
  actedOnNits: number;
  pathCoveragePct: number | null; // share of this bot's labels that can carry a path (null when unlabelled)
  verdict: BotVerdict;
}

export interface AdvisorFindingsPayload {
  generatedAt: string;
  window: { kind: BotWindowKind; from: string; to: string };
  workspaceId: number;
  bots: AdvisorBotTotals[];
  pathCells: AdvisorPathCell[];
  categoryCells: AdvisorCategoryCell[];
  overlapCells: AdvisorOverlapCell[];
  pathCoveragePct: number | null; // corpus-wide (all listed bots' labels)
  // The core cell-emission floors, echoed so the plugin/UI can state the rule instead of
  // hard-coding a second copy.
  floors: {
    minCellThreads: number;
    minCellFindings: number;
    amplifyMinActedPct: number;
    overdueGraceMs: number;
  };
}

// ── Advisor intents (derived in the PLUGIN from the cells above; deterministic) ─────────────
// An intent is a cell that crossed the plugin's decision thresholds — the "what to change"
// half of a recommendation, before any emitter runs. The recommendation text itself is
// TEMPLATED (taxonomy phrasing slots), never model-generated; the one LLM touchpoint
// (refine) may only reword prose inside a managed marker block, post-guarded.
export type AdvisorTargetWire =
  | { kind: 'path'; pathBucket: string }
  | { kind: 'category'; category: MlCategory }
  | { kind: 'severity' }
  | { kind: 'partner'; partnerUserId: number; partnerLabel: string }
  | { kind: 'bootstrap' }
  | { kind: 'lint'; template: string };

export interface AdvisorEvidence {
  windowKind: BotWindowKind;
  from: string;
  to: string;
  volume: number; // threads (path/partner/severity) or findings (category)
  actedOn: number;
  actedOnPct: number | null;
  untouched: number;
  untouchedPct: number | null;
  // Of the untouched, how many were on PRs that have since merged — the "final answer"
  // subset the suppression gate keys on; rendered as a caveat wherever untouched is.
  mergedUntouched: number;
  overdueUntouched: number;
  dissent: number;
  actedOnHigh: number;
  bySeverity?: MlSeverityCounts;
  threadLinked?: number; // category intents: the acted-on denominator (disclosed)
  samplePrIds: number[];
  pathCoveragePct: number | null; // the bot-level disclosure every path-keyed finding renders
}

// The mandatory pre-PR gate for suppress-shaped intents: what the proposed filter would ALSO
// have hidden over the evidence window. `applicable:false` = an additive intent (amplify /
// escalate / bootstrap — nothing gets hidden). `computable:false` on an applicable intent
// BLOCKS the config-PR (422); the brief still renders with the gap disclosed.
export interface AdvisorRetroCheck {
  applicable: boolean;
  computable: boolean;
  wouldHideActedOn: number;
  wouldHideActedOnHigh: number;
  wouldHideTotal: number;
  disclosure: string;
}

export interface AdvisorIntentWire {
  kind: AdvisorIntentKind;
  botUserId: number;
  botKey: string; // `u<userId>`
  botLabel: string;
  botKind: AutomatedReviewerKind;
  target: AdvisorTargetWire;
  targetKey: string; // the dedupe slot: 'src/**' | 'documentation' | 'nit' | 'u12' | 'config' | a lint template
  dedupeKey: string; // 'intent|botUserId|targetKey|windowKind' — the recommendation row's key
  rationale: string; // templated sentence (taxonomy slots), never model text
  evidence: AdvisorEvidence;
  retro: AdvisorRetroCheck;
}

// ── Advisor routes (all under /api/pro/advisor/*; Pro-gated, workspace-scoped) ──────────────
export type AdvisorRecommendationStatus =
  | 'dismissed'
  | 'pr_opened'
  | 'pr_merged'
  | 'issue_filed'
  | 'superseded';

export interface AdvisorRecommendationWire {
  dedupeKey: string;
  intent: AdvisorIntentKind;
  botUserId: number;
  status: AdvisorRecommendationStatus;
  prNumber: number | null;
  prUrl: string | null;
  issueUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdvisorCapabilityWire {
  level: 'expressible' | 'degraded' | 'unsupported';
  alternative?: string;
}

export interface AdvisorBotProfileWire {
  botUserId: number;
  kindHint: string | null;
  configPath: string | null;
  ownerContact: string | null;
  ownerRepo: string | null;
  notes: string | null;
  profileSource: 'user' | 'inferred' | null;
  hasManifest: boolean;
  manifestConfirmedAt: string | null;
}

// Per-bot adapter/capability overlay: which emitter serves this bot and what each intent
// kind degrades to there. `adapterKey` null = no known adapter — T5 (the brief) is the
// universal fallback, presented as a first-class output.
export interface AdvisorBotOverlay {
  botUserId: number;
  adapterKey: string | null;
  adapterName: string | null;
  configTargets: { path: string; format: string }[];
  capabilities: Partial<Record<AdvisorIntentKind, AdvisorCapabilityWire>> | null;
  profile: AdvisorBotProfileWire | null;
}

export interface AdvisorFindingsResponse {
  enabled: boolean;
  workspaceId: number;
  payload: AdvisorFindingsPayload;
  intents: AdvisorIntentWire[];
  overlays: AdvisorBotOverlay[];
  recommendations: AdvisorRecommendationWire[]; // stored decisions, keyed by dedupeKey
}

export interface AdvisorBriefResponse {
  workspaceId: number;
  markdown: string;
  dedupeKeys: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Chronology — the COURT LEDGER
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Every hour a pull request is open, somebody is holding the ball: a REVIEWER who has not looked
// yet, an AUTHOR who owes a response, or nobody at all — approved and waiting to land. Charge each
// interval to its holder and the hours account for themselves.
//
// ⚠ WHY THIS REPLACED A CELL MODEL. The previous feature emitted findings at a PATH-BUCKET grain
// and named things like "src/** is a bottleneck", which is meaningless: a directory is four proxies
// from anything a manager can change (directory -> file -> pull request -> thread -> commenter ->
// the wait), and on a conventional single-package repo `src/**` IS the repository. A unit is only
// useful at PR stage if it carries an OWNER, a DURATION and an EXIT CONDITION. A waiting interval
// carries all three; a directory carries none.
//
// The research is unanimous on this point: every code-review intervention with a published effect
// size acts on a WAIT owned by an identified party — a reminder on an overdue pull request
// (-60.6% lifetime, randomised, 8,500 PRs), assigning an individual rather than a group (-11.6%
// time-in-review, Meta), automatic merge (29-63% of review lifetime is post-acceptance, 569,914
// reviews). None of them act on a property of the code. The two interventions aimed at code
// properties and at people measured NOTHING: reviewer workload balancing (no significant change)
// and pull-request size (r_s = 0.26 over 845,316 PRs, the field's strongest negative result).
//
// ⚠ A BOT ACTION NEVER MOVES THE BALL. This is the whole moat and it is one predicate: a tool
// keying on `user.type === 'Bot'` cannot tell "this pull request was reviewed" from "a person
// looked at this". Human-ness here comes from the lane resolver's UNION, never `users.isBot`
// alone.
//
// ⚠ NO MODEL TOUCHES THIS. Every sentence is templated in `db/pr-intervals.ts`. An EM makes
// staffing decisions off this screen.

/** Who holds the ball. Exactly three, and they partition the open life of a pull request. */
export type PrCourt = 'reviewer' | 'author' | 'landing';

export interface CourtShare {
  court: PrCourt;
  /** Absolute hours charged to this court across the measured population. */
  hours: number;
  /** 0..1 of that population's total open hours. Always sums to 1 across the three. */
  share: number;
}

/** A pull request offered as evidence for a court claim, with the figure that earned it its place. */
export interface CourtEvidencePr {
  prId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  githubUrl: string;
  /** Hours this pull request spent in the court the row is about. */
  hoursInCourt: number;
  /** Its total open->merged hours, so a reader can see what share that was. */
  leadHours: number;
  /** ⚠ Whether the author is automation. A dependency bump sitting in the reviewer court is a
   *  different story from a colleague's feature waiting, and the row must not blur them. */
  authorIsBot: boolean;
}

/**
 * One repository's profile. THE UNIT OF THE SCREEN.
 *
 * ⚠ A SHARE WITHOUT A MAGNITUDE MANUFACTURES PROBLEMS. One real repo here is 73% author-court and
 * its p75 lead time is EIGHTEEN MINUTES — reporting the share alone would invent a crisis in a
 * healthy repository, which is the same failure as the path row it replaced. `dominant` is
 * therefore null unless the repo is BOTH lopsided AND slow, and `narrative` is null with it.
 */
export interface RepoCourtProfile {
  repoId: number;
  repoFullName: string;
  /** Human-touched merged pull requests that entered the attribution. */
  prs: number;
  /** Always three, ordered reviewer, author, landing. */
  courts: CourtShare[];
  medianLeadHours: number;
  p75LeadHours: number;
  /** The court to act on, or null when nothing here needs attention. */
  dominant: PrCourt | null;
  /**
   * ⚠ TEMPLATED, code-written, never generated. Null exactly when `dominant` is null.
   *
   * ⚠ AND IT CARRIES NO ADVICE. The first cut put the full "this is a routing problem, request a
   * named person" recommendation on every repo row, and on a real workspace six of six repos were
   * reviewer-dominant — six paragraphs of identical advice, which is the same wall of restatement
   * that made the path findings worthless. The advice belongs ONCE PER COURT (`CourtDirective`);
   * this line carries only what is specific to THIS repository.
   */
  narrative: string | null;
  /** The worst offenders in the dominant court. Empty when there is nothing to claim. */
  evidence: CourtEvidencePr[];
}

/**
 * The advice, stated ONCE for each court that has repositories under it.
 *
 * ⚠ THE ADVICE IS A PROPERTY OF THE COURT, NOT OF THE REPOSITORY, and that is why it lives here.
 * Each of the three names a genuinely different action — which is the entire reason to split the
 * clock in the first place. "Your pull requests are slow" is not a finding; "nothing is blocked on
 * the author or on checks, so this is a routing problem" is.
 *
 * The actions are the ones with published effect sizes behind them: a reminder on an overdue pull
 * request and naming an individual rather than a team (reviewer court); automatic merge, which
 * this product already ships (landing court). The author court deliberately gets no instruction
 * aimed at a person — there is no evidenced lever there, and inventing one would be the
 * performance-dashboard failure this feature exists to avoid.
 */
export interface CourtDirective {
  court: PrCourt;
  /** How many of the listed repositories sit under it. */
  repos: number;
  /** ⚠ TEMPLATED. One short paragraph. */
  directive: string;
}

/** Merged without a human review — a governance fact, not a productivity one. */
export interface UnreviewedRepoStat {
  repoId: number;
  repoFullName: string;
  merged: number;
  withoutHumanReview: number;
  share: number;
  evidence: CourtEvidencePr[];
}

/** A kind that could not be computed, or was computed and found nothing. Rendered by name —
 *  an absent section asserts "we checked and there is nothing here", which is a much stronger
 *  claim than either thing that actually happened. */
export interface FlowRefusal {
  kind: 'courts' | 'unreviewed';
  reason: string;
  basis: 'insufficient_data' | 'measured_clean';
}

/** ⚠ Retroactive history is COVERAGE-BIASED — a workspace that onboarded repos across the window
 *  shows trends that are entirely onboarding. Always rendered. */
export interface FlowCoverage {
  reposInWorkspace: number;
  reposWithData: number;
  prsScanned: number;
  /** A row scan hit its cap, so the figures cover a PREFIX of the window. */
  truncated: boolean;
  /** Merged pull requests excluded from the court split because no human ever acted on them.
   *  ⚠ They MUST be excluded: their ledger is 100% reviewer by construction and would swamp
   *  every share. They are reported separately as the unreviewed-merge finding. */
  excludedNoHumanTouch: number;
  /**
   * Merged pull requests excluded because AUTOMATION opened them.
   *
   * ⚠ THE SECOND HALF OF THE LANE SEPARATION, and it changes the answer. On a real workspace 43%
   * of merges were bot-authored and they sat LONGER than human ones (32h against 24h mean), so
   * blending them moved every share on the screen. It also made the evidence absurd: a row reading
   * "99% of open time waiting for somebody to look at it" cited `Bump actions/checkout from 4 to
   * 7`. Nobody is waiting on a dependency bump — that is housekeeping, and the Bots rail owns it.
   * This screen is about work a person wrote.
   */
  excludedBotAuthored: number;
}

export interface FlowResponse {
  workspaceId: number;
  windowDays: number;
  /** Human-touched merged pull requests behind every figure below. */
  measuredPrs: number;
  /** Workspace-wide, always three. */
  courts: CourtShare[];
  medianLeadHours: number;
  p75LeadHours: number;
  /** ⚠ TEMPLATED. The one sentence at the top of the screen. Null when nothing was measurable. */
  headline: string | null;
  /** Ranked worst-first; only repos that cleared the sample floor. */
  repos: RepoCourtProfile[];
  /** One per court that has at least one repository in `repos`, in reviewer/author/landing order. */
  directives: CourtDirective[];
  unreviewed: UnreviewedRepoStat[];
  refusals: FlowRefusal[];
  coverage: FlowCoverage;
}

export interface AdvisorConfigPrBody {
  repoId: number; // must be in the resolved workspace's membership
  botUserId: number;
  dedupeKeys: string[]; // the SELECTION only — intents are re-derived server-side
  // Refined prose per output path (from POST …/refine). Passes the deterministic diff-guard
  // server-side against the re-derived templated version — never trusted as-is.
  refinedByPath?: Record<string, string>;
}

export interface AdvisorConfigPrResponse {
  prNumber: number;
  url: string;
  // The resync-after-write copy contract: false = the PR IS on GitHub and merely couldn't
  // be confirmed locally — say "it'll show up here shortly", never offer a retry.
  visible: boolean;
  applied: { intentKind: AdvisorIntentKind; targetKey: string; status: string; note?: string }[];
}

// Dry-run of the config-PR pipeline (POST /api/pro/advisor/preview, same body as config-pr):
// the exact files the PR would commit, shown before anything is written. Runs the full gate
// chain (retro gate, parse, additive assert) so a preview that renders is a PR that builds.
export interface AdvisorPreviewFileWire {
  path: string;
  before: string | null; // the fetched default-branch content; null = the file doesn't exist yet
  after: string;
}

export interface AdvisorPreviewResponse {
  workspaceId: number;
  adapterKey: string;
  adapterName: string;
  branch: string;
  title: string;
  files: AdvisorPreviewFileWire[];
  applied: { intentKind: AdvisorIntentKind; targetKey: string; status: string; note?: string }[];
}

export interface AdvisorRefineBody {
  repoId: number;
  botUserId: number;
  dedupeKeys: string[];
  path: string; // which output file's managed block to reword
}

export interface AdvisorRefineResponse {
  path: string;
  templated: string; // always retained
  refined: string | null; // null = guard rejected / credits exhausted / no auth
  creditsExhausted?: boolean;
  guardRejected?: string; // the reason, when the LLM output failed the deterministic guard
}

export interface AdvisorProfilePutBody {
  workspaceId: number;
  kindHint?: string | null;
  configPath?: string | null;
  ownerContact?: string | null;
  ownerRepo?: string | null;
  notes?: string | null;
}

export interface AdvisorManifestConfirmBody {
  workspaceId: number;
  manifest: unknown; // validated structurally server-side (validateManifest)
}

export interface AdvisorConfigEventBody {
  workspaceId: number;
  repoId: number;
  botUserId: number;
  occurredAt: string; // ISO
  configPath?: string | null;
  description?: string | null;
}

export interface AdvisorConfigEventWire {
  id: number;
  repoId: number;
  botUserId: number;
  source: 'advisor_pr' | 'user_reported' | 'detected';
  occurredAt: string;
  configPath: string | null;
  description: string | null;
  prNumber: number | null;
  prUrl: string | null;
}

export interface AdvisorDiscoveryResponse {
  botUserId: number;
  repoId: number;
  appSlug: string | null;
  // Workflow files that mention a known bot action / the bot's login, with the matched lines.
  workflowMatches: { path: string; matches: string[] }[];
  configProbes: { path: string; found: boolean }[];
  // T3: a structurally-inferred manifest PROPOSAL (never executed unconfirmed).
  inferredManifest: unknown | null;
  inferenceTells: string[];
}

export interface AdvisorIssueResponse {
  issueUrl: string;
}

export interface AdvisorEffectResponse {
  enabled: boolean;
  panel: AdvisorEffectPanel;
  anchors: {
    ms: number;
    source: 'advisor_pr' | 'user_reported' | 'detected';
    description: string | null;
  }[];
}

// ── Advisor effect panel (verification loop; Pro-gated route, core-computed math) ───────────
// Five weekly series over the 12-week span, split before/after an anchor (a config-change
// event or a merged advisor PR) — or, with no anchor, scanned for unattributed changepoints.
// Null-vs-zero policy matches the behaviour analytics: a zero-volume week is null in `volume`
// (no baseline contribution; going-dark is the silence detector's job, not this panel's).
export interface AdvisorEffectSummary {
  weeks: number; // weeks in this segment with any data
  volumePerWeek: number | null; // median of the segment's ACTIVE weeks
  nitSharePct: number | null; // segment-total nits / findings
  actedOnPct: number | null; // segment-total acted / threads (base predicate — no follow-up set)
  highSeverityMedianHours: number | null; // pooled resolution latency of high-severity threads
}

export interface AdvisorChangepoint {
  series: 'volume' | 'nitShare' | 'actedOn';
  weekIndex: number; // index where the AFTER segment begins
  beforeMedian: number;
  afterMedian: number;
  direction: 'up' | 'down';
  z: number;
}

export interface AdvisorEffectPanel {
  generatedAt: string;
  botUserId: number;
  weekStarts: string[]; // 12, oldest → newest
  volume: (number | null)[]; // threads opened; null = zero-week
  findings: number[]; // labelled findings (praise/summary excluded)
  bySeverity: MlSeverityCounts[];
  nitSharePct: (number | null)[];
  topCategories: { category: MlCategory; counts: number[] }[]; // per-week counts, biggest first
  actedOnPct: (number | null)[];
  highSeverityMedianHours: (number | null)[];
  anchor: { ms: number; weekIndex: number } | null;
  before: AdvisorEffectSummary | null; // full weeks strictly before the anchor week
  after: AdvisorEffectSummary | null; // full weeks strictly after the anchor week
  changepoints: AdvisorChangepoint[]; // unattributed mode only (anchor null); [] otherwise
}

// ── Scope-wide bulk resolve of likely-addressed bot threads ─────────
// The "review & clear the stale-bot backlog" flow generalizes the per-PR resolve-bot-threads
// action to a WHOLE scope (the account, or one repo / the per-repo Bots tab). The client lists
// every `likely_addressed` automated-reviewer thread, reviews the list with per-thread
// checkboxes, then resolves the checked ones. Same sacred contract as the per-PR path: the
// server ALWAYS re-derives eligibility ∩ the client's explicit ids (never blind), only
// `likely_addressed` + unresolved, per-thread failures don't abort the batch, resolutions logged.
// The thread GitHub node ids are NOT shipped — the client only carries the integer thread ids
// (the resolve re-derives node ids server-side). One row PER PR: enough context for a sortable
// tabular row (author / CI / age / last-update / a bot thread-state mix) plus the FULL list of
// this PR's resolvable thread ids. UNCAPPED — every eligible PR + all its resolvable ids come
// back so the client can sort, paginate, and "Select all" (resolve the entire backlog) across
// pages; the resolve itself is client-chunked into ≤500-id POSTs.
export interface ResolvableThreadPr {
  prId: number;
  prNumber: number;
  prTitle: string;
  repoId: number;      // for the cross-repo repo filter
  repoFullName: string;
  githubUrl: string;
  authorId: number | null;
  ciStatus: CiStatus;
  openedAt: string; // ISO-8601 — the PR age
  updatedAt: string; // ISO-8601 — last activity
  // The PR's FULL review-thread state mix RESTRICTED to automated-reviewer threads (context).
  botThreadCounts: ThreadStateCounts;
  // Every RESOLVABLE (likely_addressed + unresolved) automated-reviewer thread id on this PR.
  // resolvableCount === threadIds.length === botThreadCounts.likely_addressed (uncapped now).
  resolvableCount: number;
  threadIds: number[];
  // Deterministic addressed-confidence breakdown of the resolvable ids + the subset graded
  // `high` (so the client can pre-select the safest threads).
  confidenceCounts: AddressedConfidenceCounts;
  highConfidenceThreadIds: number[];
}
export interface ResolvableThreadPrsResponse {
  prs: ResolvableThreadPr[]; // every PR with ≥1 resolvable bot thread, newest-thread-first
  totalThreads: number;      // sum of resolvableCount across all PRs (the whole backlog)
  generatedAt: string;
}
// POST body for the scope-wide resolve: the explicit reviewed thread-id list (required; ≤500 per
// request — the client chunks larger selections) + the WORKSPACE the server re-derives eligibility
// against.
//
// ⚠ THE LISTING AND THE RESOLVE MUST DERIVE THE JUDGEMENT FROM THE SAME SCOPE, and this field is
// what makes that structural. Its predecessor carried `repoIds?` while the listing was resolved
// from a team scope, so a reviewer marked automated only under a per-team override had its threads
// offered and then found ineligible — the route resolved 0 with no error anywhere. One workspace id
// on both sides cannot disagree with itself.
export interface ScopeResolveBotThreadsBody {
  threadIds: number[];
  workspaceId: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  // When this repo was ADDED to the account. Not cosmetic: it is My Turn's clock. An open PR
  // only enters the "New PRs" section when `openedAt >= createdAt`, which is what stops adding a
  // repo with 400 open PRs from dumping all of them into the inbox on day one. (It replaced a
  // separate `inboxWatchStartedAt`, written when a repo was "Watched" — an axis that no longer
  // exists: every repo in a workspace is fully live.)
  createdAt: string;
  lastFullSyncAt: string | null;
  lastIncrementalSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  // The ONE workspace this repo belongs to — a database fact (`workspace_repos`, UNIQUE
  // (account_id, repo_id)), never a set and never absent: a repo with no membership row is repaired
  // into the account's Default before any listing returns.
  //
  // IT IS ON THIS TYPE BECAUSE THE CLIENT HAS NO OTHER REPO→WORKSPACE MAPPING. Surfaces that hold
  // only a repoId — PR detail, ThreadList's bulk-resolve offer, a restored tab, a search result —
  // must name the PR's OWN workspace when they ask for a bot judgement. Using the currently
  // SELECTED workspace there is a real bug: a PR can be opened from another workspace via `?pr=`,
  // a restored tab or a search hit, and the client would then build its offer from workspace X's
  // judgements while the server re-derives from the PR's workspace Y — an offer the server refuses,
  // i.e. a dead button with an unchanged count.
  workspaceId: number;
}

// ---- Workspaces (CORE) ----
// A named grouping of an account's repos, and THE ONLY SCOPE THIS APP HAS. A repo belongs to
// EXACTLY ONE workspace — a database fact (`workspace_repos`, UNIQUE (account_id, repo_id)), so
// assigning it elsewhere is a MOVE and there is no "belongs to nothing" state. `repoIds` are the
// member repo ids; `repoCount` is their count.
//
// THE WIRE SCOPE IS A PLAIN INTEGER: `?workspace=<id>`. There is no union type, no sentinel string,
// no canonical set form and nothing to parse — its predecessor was
// `'all' | 'none' | 'teams' | <id> | <id>[]` with five client canonicalisers and three server
// parsers, which is what made "which repos am I looking at" a five-branch question whose answers
// disagreed. Absent / unknown / another tenant's id all resolve to the account's DEFAULT workspace
// (never a 404 — every id yields the same response shape, so it is not an existence oracle, and a
// stale bookmark degrades to something renderable). Every scoped response echoes the resolved
// `workspaceId` so a client can correct a stale stored id.
export interface Workspace {
  id: number;
  name: string;
  repoIds: number[];
  repoCount: number;
  // Exactly one workspace per account carries this. It is auto-created, RENAMEABLE, NOT deletable
  // (DELETE 409s on it), and it is where new repos land and where a deleted workspace's repos and
  // reviewer rows are re-homed. The client uses it to hide the delete control and to name the
  // fallback in its copy.
  isDefault: boolean;
  createdAt: string; // ISO-8601
  // ── PENDING MUTE: TWO INDEPENDENT FACTS, OR-ed. NEVER A CHAIN. ────────────────────────────
  // A muted repo's "your turn"-shaped rows are downgraded to `relevance: 'none'` — they stay on
  // the Pending board and in the broad `myTurn` count, they just stop claiming the reader's turn
  // and stop reaching the notification surfaces. See `MyTurnRelevance` and `MyTurnPr.muted`.
  //
  // ⚠ THE TWO FIELDS ARE A UNION, NOT A FALLBACK. `pendingMuted` mutes every repo in the
  // workspace; `mutedRepoIds` mutes named ones. A repo is muted when EITHER says so, and clearing
  // one never "reveals" the other as an inherited default — `null`-means-inherit is a named bug
  // class in this codebase (`workspace_reviewers.monthly_cents`, the Slack target, the sprint
  // cadence). Workspace-only would make silencing one noisy repo impossible; repo-only would make
  // silencing a 20-repo workspace twenty clicks.
  //
  // ⚠ `mutedRepoIds` IS ALWAYS A SUBSET OF `repoIds` — the mute row keys on (account, repo) alone
  // (a repo belongs to exactly one workspace, so the workspace is not a second copy of that fact),
  // and the listing intersects it with THIS workspace's membership. A repo moved to another
  // workspace therefore carries its own mute with it, which is the honest reading of "I muted that
  // repository".
  //
  // Trailing-optional for wire tolerance only; `listWorkspaces` always sets both.
  pendingMuted?: boolean;
  mutedRepoIds?: number[];
}

// What ONE Save on the Pending-mute settings section writes: either half, both, or neither.
// Each key is sent only when it CHANGED (the `buildSprintPatch` rule), and `{}` is a legal no-op.
// `mutedRepoIds` is the EXACT muted set within this workspace's membership — ids outside it are
// ignored rather than written, so a Save here can never touch another workspace's repos.
export interface WorkspacePendingMuteUpdate {
  muted?: boolean;
  mutedRepoIds?: number[];
}

export interface WorkspacesResponse {
  workspaces: Workspace[];
}

// ---- Preset prompts (declared now; implemented later by Pro + the frontend) ----
// The fixed set of one-click "ask about this scope" questions the AI answer surface offers.
export type PresetPromptKey =
  | 'attention_now'
  | 'blocked_threads'
  | 'biggest_changes'
  | 'longest_to_merge'
  | 'review_bottlenecks'
  | 'ship_ready';

export interface PresetPrompt {
  key: PresetPromptKey;
  label: string; // short user-facing button label
  question: string; // the full natural-language question sent to the model
}

// The 6 presets (the last two — review_bottlenecks + ship_ready — are the "couple more"
// beyond the four core ones).
export const PRESET_PROMPTS: PresetPrompt[] = [
  {
    key: 'attention_now',
    label: 'Needs attention',
    question: 'What needs attention now?',
  },
  {
    key: 'blocked_threads',
    label: 'Blocked threads',
    question: 'Which review threads are blocked right now?',
  },
  {
    key: 'biggest_changes',
    label: 'Biggest changes',
    question:
      'What were the biggest changes merged this sprint (largest PRs by LoC)?',
  },
  {
    key: 'longest_to_merge',
    label: 'Slowest to merge',
    question: 'Which PRs took the longest to merge?',
  },
  {
    key: 'review_bottlenecks',
    label: 'Review bottlenecks',
    question:
      'Where are the review bottlenecks — who/what is holding up merges?',
  },
  {
    key: 'ship_ready',
    label: 'Ready to ship',
    question: 'Which open PRs look ready to ship?',
  },
];

// One preset-prompt answer (Markdown), keyed by preset + the model that produced it.
export interface PresetPromptResult {
  key: PresetPromptKey;
  markdown: string;
  generatedAt: string; // ISO-8601
  model: string;
  // Resolved `owner/name#N` PR references mentioned in `markdown`, for linkification —
  // re-derived on read from the answer text (same treatment as Sprint/Retro reports), so
  // preset answers render clickable PR links/tables. Empty when the answer names no PRs.
  prRefs: DigestPrRef[];
}

// GET /api/pro/preset-prompt?key=&workspace= and its refresh POST. `enabled` false = the capability
// is off (plugin absent / not entitled); `throttled` / `creditsExhausted` mirror the digest gates.
export interface PresetPromptResponse {
  enabled: boolean;
  result: PresetPromptResult | null;
  throttled?: boolean;
  creditsExhausted?: boolean;
}

// ── Ad-hoc "Ask about the sprint" chat (Pro, Haiku) ──────────────────────────────────────────
// A free-text question answered from the SAME workspace-insights snapshot the Sprint summary uses,
// grounded (answer only from the JSON) with a soft decline for off-topic / unanswerable asks.
// When `wantChart`, a SECOND constrained Haiku pass emits this narrow spec, rendered by the
// frontend's zero-dep chart toolkit; validated strictly, dropped (chart:null) on any mismatch.
// `unit` picks the axis formatter (count→fmtNum, percent→n%, hours→fmtDuration). `type:'line'|
// 'area'` is for time-series (ISO-date labels); 'bar' for arbitrary categorical labels.
export interface SprintChatChartSpec {
  type: 'bar' | 'line' | 'area';
  title: string;
  unit: 'count' | 'percent' | 'hours';
  labels: string[];
  series: { label: string; values: (number | null)[] }[];
}

// POST /api/pro/insights/ask body. `wantBots` appends Pierre's deterministic bot-performance data
// (getBotAnalytics) to the prompt.
// How far back an Insights chat answer reaches. A per-QUESTION override of the account's
// configured comparison window (Settings → Sprint), picked from the FilterBar's Range chips while
// the Insights pane is open — it never writes back to Settings.
//
// `'sprint'` is the CURRENT sprint so far (`currentSprintWindow`), offered only when a cadence AND
// a start date are stored; the rest are trailing windows ending now, whose "previous" is the
// preceding window of equal length. There is no `'custom'` and no `'now'` — the latter recentres
// the timeline, which means nothing to a question about a date range.
// `'period'` is the one member that is NEVER a chip and never arrives alone: it names an answer
// grounded in an explicitly-bounded reporting period (the Reports "Ask about this period" mount
// sends `SprintChatBody.window`, and the resolved/echoed window's `kind` is then `'period'`). A
// bare `range: 'period'` with no bounds is unanswerable and falls back to the configured window.
export type InsightsRangeKey = 'sprint' | '7d' | '14d' | '30d' | '90d' | 'period';

// The window an answer was ACTUALLY computed over. Echoed on the response and stored on every
// history row, because a 7d answer and a 90d answer to the same question are different claims and
// the prose alone doesn't say which one you're reading.
//
// `requested` is present ONLY when it differs from `kind` — i.e. `'sprint'` was asked for with no
// sprint configured, so the window fell back to rolling 14 days. The UI says so rather than
// captioning a rolling fortnight "Sprint to date".
export interface InsightsAnswerWindow {
  kind: InsightsRangeKey;
  from: string; // ISO-8601
  to: string; // ISO-8601 (in the FUTURE for 'sprint' — the sprint's end, not "now")
  requested?: InsightsRangeKey;
}

// One prior completed turn of the conversation being continued, oldest→newest on the wire.
// Strings only — no window/chart/refs travel back: grounding is REBUILT fresh every turn, so what
// carries forward is the transcript, not stale data.
export interface SprintChatHistoryTurn {
  question: string; // what was asked (the server re-caps at its question limit)
  answer: string; // the grounded markdown the model previously produced
}

// The conversation depth cap, COUNTING the live question. The server reads at most
// `SPRINT_CHAT_MAX_TURNS − 1` prior pairs per ask (its own inlined `CHAT_MAX_PRIOR_TURNS = 9` —
// the plugin only `import type`s from this package, the AI_CREDITS_PER_USD mirror pattern); the
// frontend value-imports this the way PRESET_PROMPTS already is, to lock the input at depth 10.
export const SPRINT_CHAT_MAX_TURNS = 10;

export interface SprintChatBody {
  question: string;
  // Absent = the WORKSPACE's configured window (its `comparisonMode`, plugin migration 0032).
  // Present = this one question covers that range instead.
  range?: InsightsRangeKey;
  // Explicit bounds for THIS question — the Reports "Ask about this period" mount sends the
  // viewed period's exact `[fromMs, toMs)` so the answer covers the period on screen, not a
  // trailing window ending now. Present (and valid) ⇒ wins over `range`; the echoed and stored
  // `InsightsAnswerWindow.kind` is then `'period'`. Epoch milliseconds. The bounds reach
  // `getBotAnalytics` through the same explicit-bounds path the `'sprint'` chip uses
  // (apiVersion 18's `{kind, fromMs, toMs}` widening).
  window?: { fromMs: number; toMs: number };
  // Which WORKSPACE to ground the answer in — the wire value is the workspace id (the same plain
  // integer `?workspace=` carries, as a string on this body). Absent = the account's Default.
  // The sentinel vocabulary it used to accept ('all' | 'none' | 'teams' | '<teamId>') is gone with
  // the scope union; the plugin parses this with parseWorkspaceId and persists `ws:<id>` as the
  // cache `scope_key`, whose prefix is what stops a legacy '3' aliasing workspace 3.
  scope?: string;
  wantChart?: boolean;
  wantBots?: boolean;
  // Prior turns of THIS conversation, oldest→newest. The server reads AT MOST the newest 9 pairs
  // (`CHAT_MAX_PRIOR_TURNS`) — with the live question that is conversation depth
  // SPRINT_CHAT_MAX_TURNS. Anything older, plus anything the token budget cannot fit, is dropped
  // OLDEST-FIRST and counted in the response's `trimmedTurns`.
  history?: SprintChatHistoryTurn[];
}

export interface SprintChatResponse {
  enabled: boolean;
  // The grounded Markdown answer (or a one-line decline). Null only when the scope has no data
  // or the account is out of credits with nothing to serve.
  answer: string | null;
  // `owner/name#N` PR references resolved from `answer`, for linkification (same treatment as the
  // Sprint / Retro / preset cards). Empty when the answer names no PRs.
  prRefs: DigestPrRef[];
  // Present (non-null) only when `wantChart` was set AND the second pass produced a valid spec.
  chart?: SprintChatChartSpec | null;
  // The window the answer was grounded in. Optional on the wire so a stale persisted response
  // still parses; absent means "unknown", which the UI states rather than guessing at 14d.
  window?: InsightsAnswerWindow | null;
  // The model that actually answered — the account's resolved report model (settings →
  // config default), the same id the usage ledger and the stored history row carry.
  model?: string;
  generatedAt?: string; // ISO-8601
  throttled?: boolean;
  creditsExhausted?: boolean;
  // Model-proposed follow-up questions for the next turn (≤3, each ≤120 chars). Every entry is
  // DIGIT-FREE — the server drops any candidate containing a digit (D4: the model never authors
  // a number the UI presents as data; mirrors the synthesis ordering-mode gate). Absent when none
  // were proposed / the tail failed to parse; never persisted to history.
  followUps?: string[];
  // How many Q&A pairs of the SENT history the model did not see (depth cap + token budget
  // combined). Absent/0 = the model saw the whole transcript. The UI whispers it.
  trimmedTurns?: number;
}

// One stored past ad-hoc chat (Pro; server-persisted per account, every workspace). Carries the
// full grounded answer + chart + PR refs so re-opening a past question is FREE (no re-run/no spend).
export interface SprintChatHistoryItem {
  id: number;
  question: string;
  answer: string;
  chart: SprintChatChartSpec | null;
  prRefs: DigestPrRef[];
  wantChart: boolean;
  wantBots: boolean;
  // The stored cache key of the workspace the answer was grounded in — `ws:<workspaceId>`. Rows
  // written before the workspace refactor carried a bare team scope string and are re-keyed (or
  // cleared) by plugin migration 0020; the `ws:` prefix is what makes a legacy value unmatchable
  // rather than a silent alias onto a workspace with a different repo set.
  scope: string;
  // The window this answer covered. NULL on rows written before ranges were selectable (plugin
  // migration 0023 adds the columns and backfills nothing — a historical answer's window is not
  // recoverable, and inventing rolling-14 for it would be a fabricated caption).
  window: InsightsAnswerWindow | null;
  model: string | null;
  createdAt: string; // ISO-8601
}
// Paginated chat history (newest-first). `total` is the account's whole history size so the
// client can page (default 10/page). `enabled:false` mirrors the chat itself being flagged off.
export interface SprintChatHistoryResponse {
  enabled: boolean;
  items: SprintChatHistoryItem[];
  total: number;
}

// A saved, re-runnable ad-hoc prompt (Pro; server-stored per account + workspace, cross-device).
export interface PinnedPrompt {
  id: number;
  text: string;
  wantChart: boolean;
  wantBots: boolean;
  createdAt: string; // ISO-8601
}
export interface PinnedPromptsResponse {
  enabled: boolean;
  prompts: PinnedPrompt[];
}
export interface CreatePinnedPromptBody {
  text: string;
  wantChart?: boolean;
  wantBots?: boolean;
  // The workspace this prompt is pinned to — the workspace id as a string, exactly like
  // SprintChatBody.scope. Absent = the account's Default. Stored as the `ws:<id>` scope key.
  scope?: string;
}

export type SyncRunStatus = 'idle' | 'running' | 'ok' | 'error';

// Live progress of an in-flight sync. Present only while status === 'running'.
// `percent` is a 0..1 estimate based on how far back in time the sync has walked
// toward its cutoff (PRs are paginated newest-first); it is monotonic and reaches
// 1 when the cutoff is hit. `prsProcessed` is the honest running count.
export interface SyncProgress {
  percent: number;
  prsProcessed: number;
  pages: number;
  mode: 'full' | 'incremental';
  // Two-phase first sync: true once the fast "foreground" window (the default
  // timeline range) is fully loaded and the slower backfill of older history is
  // continuing in the background. Lets the UI drop the user into the recent view
  // immediately. Absent/false for incremental syncs and during the foreground pass.
  foregroundComplete?: boolean;
  // Set while the walk is deliberately holding still and will resume on its own:
  // 'rate_limit' = waiting out a GitHub rate-limit window (resumeAt = ISO estimate),
  // 'queued' = waiting for another sync on the same account to finish. NOT an error —
  // status stays 'running' and the red error path is reserved for unrecoverable
  // failures. Cleared (undefined) the moment the walk is moving again.
  paused?: { reason: 'rate_limit' | 'queued'; resumeAt?: string };
}

export interface SyncStatus {
  repoId: number;
  status: SyncRunStatus;
  progress: SyncProgress | null;
  lastFullSyncAt: string | null;
  lastIncrementalSyncAt: string | null;
  lastSyncError: string | null;
}

// One row of `GET /api/sync-activity` — the account's HEAVY sync work only (full-mode
// walks: first-sync backfills, deep re-syncs, and repos queued for one). Routine
// incremental ticks are deliberately excluded so the global loading bar doesn't
// flicker every few minutes.
export interface SyncActivityRepo {
  repoId: number;
  fullName: string;
  /** 0..1 walk progress (SyncProgress.percent); 0 while queued. */
  percent: number;
  prsProcessed: number;
  paused?: SyncProgress['paused'];
}

export interface SyncActivityResponse {
  backfills: SyncActivityRepo[];
  generatedAt: string;
}

/**
 * Live state of the background ML severity/category worker (CORE, free tier) — `GET
 * /api/ml-status`.
 *
 * WHY THE SYNC UI NEEDS THIS. Fetching a PR's comments from GitHub is only half of making the
 * board correct: the severity badges the user reads come from a separate CPU-bound pass over
 * the same text, which runs AFTER the walk lands (it cannot run inside it — see
 * docs/ML-SEVERITY.md). A sync indicator that stops at the end of the GitHub walk is therefore
 * announcing "complete" while the model is still working, which is what this endpoint exists to
 * stop it doing.
 *
 * ACCOUNT-WIDE, not workspace-scoped: that is the worker's own grain.
 */
export interface MlEnrichmentStatus {
  /** A severity-api is configured. False ⇒ every other field is inert and the UI shows nothing. */
  enabled: boolean;
  /** A tick is in flight right now. */
  running: boolean;
  /** Bot text with no label yet, across every workspace of the account. */
  pending: number;
  /**
   * Bot rows whose body was never STORED (`body IS NULL` — synced during the lean-storage
   * window) — no text to classify, so they are invisible to the candidate query and excluded
   * from `pending` on purpose. Repairable via hydration write-back / `pnpm ml:backfill-bodies`.
   *
   * ⚠ Must NEVER feed a scoring indicator (`isMlScoring`): nothing is draining it, so counting
   * it as pending would spin forever — the exact lie `pending` was separated from.
   */
  unscorable: number;
  /** Labels already stored for the account. */
  labelled: number;
  /** Labels written by the CURRENT (or most recent) tick — the live counter. */
  scoredThisRun: number;
  batchesThisRun: number;
  /**
   * Failed batches in the current (or most recent) tick.
   *
   * ⚠ With `scoredThisRun === 0` this is the STALLED signal, and a client must stop showing
   * progress on it. Backlog is not the same as work in flight: a handful of comments the service
   * rejects (a 500 on one batch is a real, observed case) are re-selected every tick forever, so
   * `pending > 0` alone would spin an indicator on input that will never be scored.
   */
  failuresThisRun: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** Set while the worker is backed off after repeated failures. */
  pausedUntil: string | null;
  /**
   * Did the service last answer? `null` before the first attempt, `false` when it did not.
   *
   * ⚠ A client must treat `false` as "no scoring phase to show". Without the URL pointed at a
   * live service there is backlog but nothing draining it, and a spinner that never stops is a
   * worse lie than the one this endpoint was added to fix.
   *
   * This tracks REACHABILITY only. A service that answers 500 on one batch is healthy — see
   * `failuresThisRun` for whether the tick is actually making progress.
   */
  serviceHealthy: boolean | null;
  /** The service answered from the MARKER FALLBACK, not the ONNX model — labels are weaker. */
  markerFallback: boolean;
  generatedAt: string;
}

export interface ThreadStateCounts {
  resolved: number;
  likely_addressed: number;
  replied_unresolved: number;
  untouched: number;
}

// Breakdown of a set of threads by deterministic addressed-confidence (Part A/B). Lets a PR row
// show "N high · M medium" and drive "select high-confidence only" bulk-resolve.
export interface AddressedConfidenceCounts {
  high: number;
  medium: number;
  low: number;
  none: number;
}

// ---- v1.1: CI / mergeability / triage ----

export type CiStatus =
  | 'success'
  | 'failure'
  | 'pending'
  | 'error'
  | 'expected'
  | 'unknown';

export type Mergeable = 'mergeable' | 'conflicting' | 'unknown';

export type MergeStateStatus =
  | 'clean'
  | 'dirty'
  | 'unstable'
  | 'blocked'
  | 'behind'
  | 'has_hooks'
  | 'unknown';

export interface Label {
  name: string;
  color: string;
}

// GitHub's overall review decision for a PR (GraphQL PullRequestReviewDecision, lowercased
// to match this codebase's stored-enum convention). Distinct from any individual review's
// state: this is the REPO's protection rule answering "does review still block the merge?".
//   approved          — the required approvals are in
//   changes_requested — someone requested changes and it still stands
//   review_required   — required reviews are outstanding
// null (not part of the union) means the repo requires no review at all.
export type PrReviewDecision = 'approved' | 'changes_requested' | 'review_required';

// A single CI check (CheckRun or legacy StatusContext) on the head commit,
// normalised to one display state.
export type CheckRunState =
  | 'success'
  | 'failure'
  | 'pending'
  | 'neutral'
  | 'skipped'
  | 'error'
  | 'unknown';

export interface CheckRun {
  name: string;
  state: CheckRunState;
  url: string | null;
  // For GitHub Actions checks, the Actions run id + job id parsed from the check's
  // detailsUrl (.../actions/runs/<runId>/job/<jobId>). Lets the frontend offer
  // "view logs" on a failed Actions check (fetched on demand via the job id) and
  // gate it off for third-party CI, which only has an external detailsUrl. null when
  // the check isn't an Actions job (or the detailsUrl isn't in that shape).
  runId: number | null;
  jobId: number | null;
}

// On-demand failed-check log WINDOW (GET /api/prs/:id/checks/:jobId/logs). Logs are
// fetched live from the GitHub Actions API, never stored. `available` is false when
// the logs can't be retrieved (expired after ~90 days, the job was re-run, or the
// token lacks actions:read) — `reason` explains why. `text` is the returned slice of the
// log; `totalLines` is the full line count so the UI can say "last N of M".
//
// The byte fields turn the old fixed tail into a SCROLLABLE window. The route accepts
// `?tail=` (the legacy last-N-lines form) or an explicit `?startByte=&endByte=` range;
// the response always reports back the window it actually served:
//   totalBytes  — the decoded log's full size, or null when the source can't report it
//   startByte   — inclusive offset of the first returned byte (null = served from the top)
//   endByte     — EXCLUSIVE offset just past the last returned byte (null = served to the end)
//   hasMore     — more log exists ABOVE the returned window (i.e. startByte > 0), so the
//                 client can "load earlier" when the user scrolls up. NOT "more below".
//   truncated   — the returned window is a strict subset of the whole log (either end).
export interface CheckLogsResponse {
  available: boolean;
  reason?: string;
  text: string;
  totalLines: number;
  returnedLines: number;
  totalBytes: number | null;
  startByte: number | null;
  endByte: number | null;
  hasMore: boolean;
  truncated: boolean;
}

// Re-trigger a GitHub Actions workflow run for a PR (POST /api/prs/:id/ci/rerun).
// 'failed' reruns only the failed jobs of the run (/rerun-failed-jobs); 'all' reruns
// the whole run from scratch (/rerun). Requires repo write access (re-checked
// server-side); works local + cloud via the per-account token.
export type CiRerunMode = 'failed' | 'all';

export interface CiRerunBody {
  // The Actions run id to rerun (CheckRun.runId; null-runId checks aren't rerunnable).
  runId: number;
  mode: CiRerunMode;
}

export interface CiRerunResult {
  status: 'queued';
  runId: number;
  mode: CiRerunMode;
}

// Request reviewers on a PR (POST /api/prs/:id/request-reviewers). userIds are
// resolved to GitHub logins server-side (bots + the PR author dropped); requires repo
// write access (re-checked server-side). Powers the Insights "Assign reviewers" action
// AND the CORE PR-detail "Suggested reviewers" assign. At least one of the three arrays
// must be non-empty. `userIds` are resolved to logins; `logins` are sent through as-is
// (for suggested reviewers we haven't synced as users); `teamSlugs` become team review
// requests (`team_reviewers`) — a CODEOWNERS `@org/team` requestable without expanding
// its membership.
export interface RequestReviewersBody {
  userIds?: number[];
  logins?: string[];
  teamSlugs?: string[];
}

export interface RequestReviewersResult {
  status: 'ok';
  requestedLogins: string[]; // logins actually sent to GitHub (after filtering)
}

// ---- PR merge (CORE / free tier) — a merge control next to Approve ----
// GitHub's three merge methods. 'squash' is squash-and-merge; 'rebase' is rebase-and-merge.
export type MergeMethod = 'merge' | 'squash' | 'rebase';

// ---- The one merge VERDICT (shared by every merge surface) ----
//
// GitHub exposes mergeability as three loosely-coupled fields (`mergeable`,
// `mergeStateStatus`, `reviewDecision`) plus two out-of-band states (the merge queue, an
// armed auto-merge). Every surface that renders "can this land?" — the PR-detail merge
// control, the open-PR tables, the branch-status strip — was free to combine them its own
// way, which is how the same PR ends up "Blocked" in one place and "Ready" in another.
// `MergeVerdict` is the SINGLE collapsed answer; a pure resolver derives it from the raw
// fields and everything else renders `MergeVerdictInfo`.
//
//   clean      — nothing in the way; merge is offerable now
//   blocked    — branch protection unmet (required reviews / required checks / CODEOWNERS)
//   conflicts  — conflicts with the base branch; needs a manual resolve
//   behind     — behind the base and the repo requires up-to-date branches (offer "Update")
//   unstable   — non-required checks are failing/pending; GitHub WILL still merge it
//   queued     — sitting in GitHub's merge queue (position/ETA in PrMergeOptions.mergeQueue)
//   armed      — Pierre auto-merge is armed: it lands by itself when the blockers clear
//   draft      — still a draft; merge is not offerable until it's marked ready
//   unknown    — GitHub hasn't computed mergeability yet (async) or we have no data
export type MergeVerdict =
  | 'clean'
  | 'blocked'
  | 'conflicts'
  | 'behind'
  | 'unstable'
  | 'queued'
  | 'armed'
  | 'draft'
  | 'unknown';

// ---- Why a BLOCKED pull request is blocked ----
//
// GitHub collapses at LEAST six different protection failures into the single
// `mergeStateStatus: BLOCKED` and exposes nothing on the same payload that separates them:
// required approvals not met, a standing CHANGES_REQUESTED, a required check that is red /
// pending / never reported, unresolved review threads on a repo with "Require conversation
// resolution before merging", required signed commits / linear history / deployments, and
// repository rulesets. The only GitHub-side disambiguator is `branchProtectionRule`, which is
// ADMIN-ONLY: it comes back null for the WRITE/MAINTAIN tokens most viewers hold, and
// `graphqlTolerant` NULLs forbidden fields on a partial 200 — so "this repo has no such rule"
// and "you may not see this repo's rules" are indistinguishable. Syncing it would make the
// feature look authoritative on a handful of repos and be silently blank on the rest.
//
// So the app does the honest thing instead: it lists what it can actually check against its own
// synced data, ranked, and MARKS EACH ENTRY as proven or inferred.
//
//   proven   — GitHub itself names this requirement as unmet. Only `reviewDecision` can do
//              that; nothing else on the payload names a rule.
//   inferred — the FACT is real and locally verified (CI is red, N threads are unresolved), but
//              GitHub does not say it is what BLOCKED means here. Worded as a possibility.
//
// Measured on a real database (1,552 open PRs, 572 blocked): only 89 of the 572 have ANY
// unresolved thread, so "unresolved threads are blocking this" is false for 84% of them and
// must never be asserted; and 17 are approved + blocked with no unresolved thread at all,
// which is what `unexplained` exists to answer without inventing a cause.
export type MergeBlockerKind =
  | 'changes_requested'
  | 'review_required'
  | 'checks_red'
  | 'checks_pending'
  | 'unresolved_threads'
  // The terminal entry, emitted only when nothing above fired. GitHub says a rule is unmet and
  // nothing we hold explains which — the honest answer for the approved-and-still-blocked case.
  | 'unexplained';

export interface MergeBlocker {
  kind: MergeBlockerKind;
  /** ⚠ ORDERS THE LIST, AND IS NOT SHOWN. `deriveMergeBlockers` emits proven entries first so the
   *  most certain fact leads, but the screen states the facts and stops. The first cut labelled
   *  every row PROVEN or INFERRED and explained the difference underneath; that is the reader's
   *  call to make, and three layers of hedging around one short true sentence is not help. */
  certainty: 'proven' | 'inferred';
  /** The claim itself, short enough to render inline as the verdict's one-line detail. */
  text: string;
  /** The number `text` quotes, when it quotes one (so a caller can badge it). */
  count?: number;
}

/**
 * The PR facts the blocker derivation reads, as ONE optional object on `MergeVerdictInput`.
 *
 * It is an object rather than five sibling optionals so that "this caller looked" and "this
 * caller has nothing to say" are DISTINGUISHABLE. The compact surfaces (the timeline bar
 * tooltip, the dense open-PR rows) are fed a `TimelinePr`, which carries neither threads nor a
 * review decision — handing them a list derived from silence would print "nothing we can see
 * explains it" on every blocked row in the app, which is a claim about the PR rather than about
 * what we bothered to fetch. Omit the object there and the verdict keeps its old generic
 * sentence; supply it (PR detail, where a live walk has just refreshed the row) and the ranked
 * list appears.
 *
 * ⚠ `unresolvedThreads` is `!thread.isResolved` — the ONLY population GitHub's conversation-
 * resolution rule gates on. It therefore INCLUDES the threads the app's own heuristic calls
 * `likely_addressed`: that heuristic says the code probably changed, and GitHub only cares about
 * the resolve click. `likelyAddressedThreads` is the SUBSET of the same count, carried
 * separately so one sentence can name both populations instead of two surfaces disagreeing.
 */
export interface MergeBlockFacts {
  /** GitHub's own review decision. null = the repo requires no review; undefined = not looked up. */
  reviewDecision?: PrReviewDecision | null;
  /** The head commit's check ROLLUP (every check, not only the required ones). */
  ciStatus?: CiStatus;
  /** Threads not resolved ON GITHUB (`!isResolved`), including `likely_addressed` ones. */
  unresolvedThreads?: number;
  /** Of `unresolvedThreads`, how many our `likely_addressed` heuristic thinks were acted on. */
  likelyAddressedThreads?: number;
  /**
   * Reviewers/teams still carrying an outstanding review request.
   *
   * ⚠ It NAMES a proven review blocker, it never becomes one on its own. An outstanding request
   * on a PR whose `reviewDecision` is null would say "somebody was asked and hasn't answered" on
   * a repo GitHub has just told us requires no review at all — a false cause, on the most common
   * shape in the data (1,430 of 1,552 open PRs carry a null decision, and it is genuine: GitHub
   * answers null when the base branch has no review requirement).
   */
  requestedReviewers?: number;
}

// The rendered form of a verdict: one label, one tone, one sentence of WHY, and whether a
// merge button should be live. `detail` is user-facing prose ("2 approvals required", "3
// commits behind main"), null when there's nothing more to say than the label.
export interface MergeVerdictInfo {
  verdict: MergeVerdict;
  label: string;
  tone: 'ok' | 'warn' | 'bad' | 'muted';
  canMerge: boolean;
  detail: string | null;
  /**
   * The ranked candidate causes, populated for the `blocked` verdict ONLY — and non-empty
   * whenever it is populated at all.
   *
   * Deliberately not filled in for the other eight verdicts: each of those is already a
   * complete sentence about itself ("resolve the conflicts", "3 commits behind"), and a
   * one-row list under a self-explanatory verdict is noise. `blocked` is the ONE verdict
   * where GitHub refuses to say what it means, which is the entire reason this field exists.
   *
   * Absent (rather than empty) unless the caller supplied `MergeBlockFacts` — see that type
   * for why a surface holding no thread/CI data must not be handed a list built from silence.
   */
  blockers?: MergeBlocker[];
}

// ---- Auto-merge ("arm it and walk away") ----
//
// Pierre-side, NOT GitHub's native auto-merge: a stored intent that a background pass
// re-evaluates. It is deliberately conservative — armed against an EXPECTED head SHA, so a
// new push disarms it rather than merging code the user never saw.
//
//   armed                — live; the watcher will merge when the verdict turns clean
//   merged               — the watcher merged it (terminal)
//   disarmed_head_moved  — a new commit landed on the head branch → intent no longer applies
//   disarmed_blocked     — a blocker appeared that a human must clear (conflicts, changes requested)
//   expired              — passed `expiresAt` without ever becoming mergeable
//   failed               — the merge call itself errored (see `lastReason`)
export type ArmedMergeState =
  | 'armed'
  | 'merged'
  | 'disarmed_head_moved'
  | 'disarmed_blocked'
  | 'expired'
  | 'failed';

// The live sub-state of an ARMED intent — the machine-readable half of `lastReason`, written
// by the same watcher call that writes the prose so the two can never disagree. Every TERMINAL
// outcome is already an `ArmedMergeState` member and is deliberately NOT duplicated here: a
// finished card renders off `state`, and `lastReason` is null at success anyway.
//
//   pending_first_check — armed; the watcher hasn't looked yet (up to one cron tick)
//   waiting_conflicts   — conflicts with the base; waiting for the author
//   waiting_behind      — behind the base and not being updated (updateStrategy 'none', or the
//                         update call was refused)
//   updating_rebase     — rebasing onto the base (local mode's clone-based update)
//   updating_merge      — GitHub is merging the base in (its update-branch is async)
//   awaiting_checks     — the required checks haven't finished
//   awaiting_review     — required reviews aren't in (or changes were requested)
//   blocked_protection  — branch protection unmet for a reason that isn't checks
//   enqueuing           — adding the PR to the merge queue right now
//   queued              — sitting in GitHub's merge queue
//   queued_local        — armed, but another intent on the SAME REPO holds the slot (see below)
//   merging             — the merge call is in flight
//   retrying            — a GitHub error, being retried (a persistent one ends in 'failed')
//
// ⚠ `queued` AND `queued_local` ARE DIFFERENT QUEUES and the copy must not merge them. `queued`
// means GitHub has the PR in a merge queue and is testing it; `queued_local` means Limn is
// holding it back so the intents on that repo land ONE AT A TIME. A repo with a real GitHub merge
// queue never sees `queued_local` — GitHub already serialises, and adding a second queue in front
// of it would halve throughput for nothing.
export type ArmedMergePhase =
  | 'pending_first_check'
  | 'waiting_conflicts'
  | 'waiting_behind'
  | 'updating_rebase'
  | 'updating_merge'
  | 'awaiting_checks'
  | 'awaiting_review'
  | 'blocked_protection'
  | 'enqueuing'
  | 'queued'
  | 'queued_local'
  | 'merging'
  | 'retrying';

export interface ArmedMergeRequest {
  prId: number;
  // Repo/PR identity, carried on the row itself: this payload is the ONLY thing a CROSS-PR
  // surface (the global armed-merge card) receives, and it has no PR context to look a label
  // up from.
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prTitle: string;
  mergeMethod: MergeMethod;
  // Whether to bring the branch up to date first when it's merely behind, and how.
  // 'none' = never update; a behind PR just waits (or expires).
  updateStrategy: 'rebase' | 'merge' | 'none';
  // The base branch had a merge queue at arm time: the watcher's terminal action is "add to
  // the queue" (head-pinned enqueue) instead of a direct merge, which GitHub refuses on a
  // queue-protected branch.
  viaMergeQueue: boolean;
  // When the WATCHER enqueued the PR (ISO-8601); null until then, always null for
  // direct-merge intents. While set, cancelling also removes the queue entry.
  enqueuedAt: string | null;
  armedAt: string; // ISO-8601
  // The head SHA at arming time. The watcher refuses to merge a different head — arming is
  // consent to merge THIS code, not whatever lands next.
  expectedHeadOid: string;
  state: ArmedMergeState;
  lastCheckedAt: string | null; // ISO-8601; null until the watcher has looked once
  // Machine-ish reason for the current state ('required reviews missing', 'head moved
  // abc1234→def5678', 'github: base branch modified'). Null while cleanly armed.
  lastReason: string | null;
  // Where a LIVE intent stands, as an enum the UI can switch on. Null on every terminal row
  // (read `state` there), and null for a wait the watcher can't honestly characterise — the
  // client falls back to `lastReason` in both cases.
  phase: ArmedMergePhase | null;
  expiresAt: string; // ISO-8601 — the hard stop, so an intent can't linger for weeks
  // ── The per-repo landing order ─────────────────────────────────────────────────────────────
  //
  // Arm five bumps on one repo and they cannot all land: each merge moves the trunk, so on a repo
  // that requires an up-to-date branch the other four go `behind` the moment the first lands. The
  // watcher therefore gives ONE intent per repo the slot and holds the rest at `queued_local`,
  // freshening each only when its turn comes — N branch updates and N CI runs, not N².
  //
  // Both fields are TRAILING OPTIONAL: they describe a live, direct-merge intent, so they are
  // absent on every terminal row and on every `viaMergeQueue` intent (GitHub owns that order).
  // A client that has never heard of them renders exactly what it did before.
  /** 1-based place in this repo's armed queue. 1 = holds the slot and is being worked. */
  queuePosition?: number;
  /** How many armed intents this repo has, so a card can say "2nd of 5" without a second call. */
  queueDepth?: number;
  /** This intent's required checks have FAILED, so it stepped aside and let the next through — it
   *  needs its author, not a turn. Still armed: if the checks go green it takes its place back.
   *  ⚠ Not a terminal state and NOT a disarm; `state` is still 'armed'. */
  yieldedForFailedChecks?: boolean;
}

// POST /api/prs/:id/auto-merge — arm. `updateStrategy` defaults to 'none' server-side.
export interface ArmMergeBody {
  mergeMethod: MergeMethod;
  updateStrategy?: 'rebase' | 'merge' | 'none';
}

// GET /api/auto-merge — every armed (and recently-resolved) request for the account.
export interface ArmedMergeListResponse {
  requests: ArmedMergeRequest[];
}

// GitHub's native merge queue for this PR, when the repo has one. `enabled` is the repo-level
// capability; `inQueue` is whether THIS PR is currently sitting in it. `position` is 1-based.
// All of position/state/estimatedTimeToMergeMs are null when not queued (or not reported).
export interface PrMergeQueueInfo {
  enabled: boolean;
  inQueue: boolean;
  position: number | null;
  state: string | null; // GitHub's MergeQueueEntry state (QUEUED / AWAITING_CHECKS / MERGEABLE / UNMERGEABLE / LOCKED)
  estimatedTimeToMergeMs: number | null;
}

// Pierre-side auto-merge availability + the current intent for this PR.
export interface PrAutoMergeInfo {
  // Whether the repo/viewer combination permits arming at all (viewer can merge here).
  allowedByRepo: boolean;
  // The live intent, or null when nothing is armed.
  armed: ArmedMergeRequest | null;
}

// What the merge control needs, fetched lazily (GET /api/prs/:id/merge-options) so the hot
// PR-detail path isn't slowed by a live GitHub call. allowedMethods/defaultMethod come from
// the repo's own settings; the rest is GitHub's live mergeability.
export interface PrMergeOptions {
  allowedMethods: MergeMethod[]; // the repo's enabled merge methods (GitHub order)
  defaultMethod: MergeMethod; // the first allowed method — the pre-selected default
  mergeable: boolean | null; // GitHub's async mergeable flag (null = still computing)
  mergeStateStatus: string; // clean / dirty / behind / blocked / unstable / unknown / …
  conflicts: boolean; // mergeable===false or dirty → conflicts with the base
  behind: boolean; // the head branch is behind the base (an "Update branch" is available)
  blocked: boolean; // branch protection unmet (required reviews/checks) → merge disabled
  behindBy: number; // commits the head is behind the base
  baseRef: string; // the base (trunk) branch name
  // Whether an "Update branch from trunk" is offerable now (behind AND not conflicting).
  canUpdateBranch: boolean;
  // Whether a REBASE-from-trunk is available (local mode only — GitHub's native update-branch
  // can only merge trunk in). When false the update-from-trunk is merge-only.
  canRebaseUpdate: boolean;
  // GitHub's native merge queue, when the repo has one configured. null = the repo has no
  // merge queue (or we couldn't determine it) — render nothing.
  mergeQueue: PrMergeQueueInfo | null;
  // Pierre-side auto-merge: whether arming is offerable, and the live intent if any. Always
  // present (never null) — `allowedByRepo:false, armed:null` is the "not offerable" shape.
  autoMerge: PrAutoMergeInfo;
  // GitHub's LIVE review decision, from the merge-queue probe this route already issues — the
  // one field on this payload that can say WHICH HALF of branch protection a `blocked` status
  // means. It was fetched and thrown away before: `fetchMergeQueueState` selects it (the
  // auto-merge watcher waits on it by name) but the route only mapped the queue half, and only
  // when the repo HAS a queue. Surfacing it costs zero additional GitHub calls.
  //
  // ⚠ THREE STATES, and the difference is load-bearing: a `PrReviewDecision` is GitHub's
  // answer; `null` is GitHub positively saying the base requires no review; and ABSENT means
  // the probe failed (it is best-effort, `.catch(() => null)`) so we never looked. Absent must
  // never be read as "no review required" — the merge control falls back to the synced row.
  reviewDecision?: PrReviewDecision | null;
}

export interface MergePrBody {
  method: MergeMethod;
}

// POST/DELETE /api/prs/:id/merge-queue — enqueue / dequeue on GitHub's native merge queue.
// `method` is only meaningful on enqueue (some repos allow a per-entry method).
export interface MergeQueueEnqueueBody {
  method?: MergeMethod;
}

export interface MergeQueueResult {
  // The PR's queue state after the call. `inQueue:false` after a successful dequeue.
  inQueue: boolean;
  position: number | null;
  state: string | null;
}
export interface MergePrResult {
  merged: boolean;
  sha: string | null; // the merge commit SHA GitHub created
  state: 'merged';
}

// Close a PR without merging (reversible — GitHub can reopen it). No body; permission is
// author-or-write, re-checked server-side.
export interface ClosePrResult {
  closed: boolean;
  state: 'closed';
}

// Update the PR's branch from the base/trunk before merging. strategy 'rebase' is local-only
// (clone-based); 'merge' works everywhere (native GitHub update-branch in cloud). No conflict
// resolution in the free tier — a conflicting PR returns 409 with { conflicts: true }.
export interface UpdateBranchBody {
  strategy?: 'rebase' | 'merge';
}
export interface UpdateBranchResult {
  ok: true;
  headSha: string | null; // the new head SHA after the update (null when GitHub-native)
  strategy: 'rebase' | 'merge';
}

// An outstanding review request on a PR (user resolved via the users array;
// team requests carry only a name).
//
// ⚠ `teamName` HERE IS GITHUB'S OWN TEAM (`@org/team`) — NOT this app's workspace. It is parsed
// straight out of a GitHub payload and stored in `reviewRequests.teamName`. Workspace-side names
// (`PeriodWorkspaceRow.name`, `Workspace.name`) are the OPPOSITE category and follow the app's
// own vocabulary; renaming this one breaks GitHub-team review-request rendering. Do not touch it.
export interface RequestedReviewer {
  userId: number | null;
  teamName: string | null;
}

// A single file changed by a PR, with its per-file line counts. Stored as a JSON
// column on pull_requests (synced from GitHub's pullRequest.files connection) and
// surfaced in the PR-detail "Changes" tab. `githubUrl` deep-links to the file's
// diff in the PR's "Files changed" view (built server-side in getPrDetail).
export interface PrFileChange {
  path: string;
  additions: number;
  deletions: number;
  githubUrl: string;
}

// The DB-stored shape of a changed file (the `files` JSON column on pull_requests):
// the API's PrFileChange minus the `githubUrl`, which is derived on read.
export type StoredPrFile = Omit<PrFileChange, 'githubUrl'>;

// Hard cap on how many repositories a single account may ADD. Enforced on the
// add-repo route (backend, the source of truth) and surfaced in the add-repo UI.
export const MAX_REPOS_PER_ACCOUNT = 100;

// The single most useful reason a PR matters right now, in priority order.
export type ReasonTag =
  | 'awaiting_your_review'
  | 'your_pr_new_comments'
  | 'ci_failing'
  | 'merge_conflicts'
  | 'approved_ready'
  | 'stalled'
  | 'untouched_threads'
  | 'in_progress';

// Reason tags in descending priority — index 0 is most urgent. Used for the
// open-PRs sort and for the strip's "needs attention" filter.
export const REASON_PRIORITY: ReasonTag[] = [
  'awaiting_your_review',
  'your_pr_new_comments',
  'ci_failing',
  'merge_conflicts',
  'approved_ready',
  'stalled',
  'untouched_threads',
  'in_progress',
];

// "My turn" = the two reasons that are actionable by you specifically.
export const MY_TURN_REASONS: ReasonTag[] = [
  'awaiting_your_review',
  'your_pr_new_comments',
];

export function isMyTurnReason(tag: ReasonTag): boolean {
  return MY_TURN_REASONS.includes(tag);
}

export interface NewSinceLastViewed {
  commits: number;
  comments: number;
  reviews: number;
}

export interface LocalUser {
  login: string;
  githubId: string;
  avatarUrl: string | null;
  // The user's GitHub display name (the `name` field from `gh api user` / OAuth).
  // null when GitHub has no name set; the UI falls back to the login. Shown wherever
  // the signed-in identity appears (header, greeting) in place of the @handle.
  displayName: string | null;
}

// Premium (@pierre/pro) capability map, mirrored from a backend singleton the
// plugin populates at boot. All-false in OSS mode (plugin absent). Flows to the
// frontend through /api/me exactly like claudeReviewEnabled.
export interface ProCapabilities {
  activityDigest: boolean; // per-repo LLM headlines digest (Activity)
  reviewMemory: boolean; // Claude Review learnings
  // AI Fix (packages/pro/ai-fix). Two independent gates so the cheap, read-only
  // analysis can ship without the expensive, write-capable fixer:
  aiAnalysis: boolean; // CI failure analysis (Haiku, read-only) + the AI-Fix Analysis tab
  // Per-PR AI summary (cheap Haiku, read-only). Split OUT of aiAnalysis so it can ship on the
  // cheap SUMMARY tier (on in cloud, credit-metered) while CI-analysis + the fixer stay on the
  // pro+ advanced-AI tier. On whenever the digest/summary tier is on (or advanced AI is).
  prSummary: boolean;
  aiFix: boolean; // agentic inline code fix + push (Agent SDK, needs write access)
  workspaceInsights: boolean; // workspace review-intelligence "Insights" (no AI; pure reads)
  // Agentic Claude Review (Agent SDK). The product lives in the plugin (routes/manager/
  // prompts); the SDK-run infra + tables stay in core behind the ctx.review seam. Gated
  // by PRO_ADVANCED_AI_ENABLED (formerly PRO_CLAUDE_REVIEW_ENABLED, kept as an alias); all-false
  // in cloud / OSS. The frontend hides the tab/banner when false. This flag now gates the whole
  // "pro+" AI tier — aiAnalysis + aiFix + claudeReview flip together.
  claudeReview: boolean;
  // Slack digest delivery (Pro): a per-account webhook receives the freshly-generated sprint +
  // repo digest on a cadence. The report is AI-generated (Haiku), so this mirrors activityDigest.
  slackDigest: boolean;
  // Jira/Linear ticket-link enrichment in PR detail (Pro; no AI). Gated (like workspaceInsights) on
  // PRO_DIGEST_ENABLED. Config (provider + base URL) is PER WORKSPACE, in pro_workspace_settings.
  issueLinks: boolean;
  // Review-bot triage tier — CORE/FREE. The Bots rail view reads the core bot routes and shows
  // regardless; this flag is true whenever the plugin is LOADED (independent of the paid PRO_*
  // flags) so the free bot Settings section (pro_settings-backed) stays reachable. All-false only
  // when the plugin is absent.
  //
  // ⚠ IT NO LONGER COVERS THE ROI COST OVERLAY, OR THE ROI TABLE AT ALL. That whole panel moved to
  // the paid `botDepth` flag below; what `botTriage` still buys is classification, identity, the
  // bot-only governance caution, the tuning suggestions and the thread-resolve flows.
  botTriage: boolean;
  // Bot Tuning Advisor (paid, gated like workspaceInsights): the Bots "Advisor" inner tab,
  // the per-row Tune/Drop pills, findings → config-PR/brief/issue outputs, the effect panel.
  // The free amber TuningSuggestions box renders regardless of this flag.
  botAdvisor: boolean;
  // Period-over-period reporting (paid, gated like workspaceInsights): the Insights "Reports"
  // sub-tab — a stored, forwardable artifact per sprint with a coverage-honest comparison, a
  // refusable forecast and a narrated summary. Gates the sub-tab itself; the metrics behind it
  // are CORE compute, but there is no free surface for them.
  periodReports: boolean;
  // Non-AI paid DEPTH tier (paid, gated like workspaceInsights — NOT like botTriage, which is
  // true whenever the plugin is merely loaded): behaviour trends/anomalies, the per-bot
  // drill-down, overlap, where-bots-work, the inflation sparkline/history, and the per-seat
  // ROI cost overlay. The compute behind these surfaces is CORE; this flag gates the surfaces.
  botDepth: boolean;
  // The work plan (paid, gated like workspaceInsights/periodReports): the prioritised
  // "what should I work on today" worklist under the Activity daily-brief strip, plus its
  // optional Haiku narration. Gates the WHOLE panel, both halves — the deterministic worklist is
  // CORE compute (db/work-plan.ts) but has no free surface, and the narration is the billed POST.
  // The ranked rows render with or without a plan, so this flag is the panel's only gate.
  workPlan: boolean;
}

// Which GitHub sign-in methods this (cloud) deployment offers — GET /api/auth/providers.
// Read UNAUTHENTICATED by the SignInGate to render the right button(s), and SIGNED-IN by the
// Settings "GitHub App" section, which needs `appSlug` to build the install link. The two
// GitHub App flows are distinct and neither implies the other: /login/oauth/authorize mints a
// user token (sign-in), while /apps/<slug>/installations/new grants repo access — and ONLY an
// installation produces webhook deliveries (see docs/REALTIME-SYNC.md).
export interface AuthProvidersResponse {
  oauth: boolean;
  app: boolean;
  // Empty unless the GitHub App provider is enabled.
  appSlug: string;
}

// ---- the LARGE-PR FLAG (CORE, free, no AI) ----------------------------------------------
//
// A subtle warning on a pull request whose CODE churn is big enough that reviewing it well is
// unlikely. "Code" is the load-bearing word: documentation, structured config, lockfiles,
// generated/vendored output and binary payloads are all excluded before the sum, by the backend's
// `db/code-loc.ts` classifier. A 4,000-line lockfile bump is not a large PR.
//
// ⚠ THE WIRE CARRIES A NUMBER (`codeLoc`), NEVER A BOOLEAN `isLarge`. The comparison against the
// threshold is a pure RENDER-TIME operation, so changing the threshold in Settings repaints every
// surface instantly with no query-cache invalidation anywhere — and the number is also what lets a
// tooltip say "2,140 lines of code" instead of just "large".
//
// ⚠ `codeLoc: null` IS A REAL AND COMMON STATE, and it means UNKNOWN, never "not large". Roughly a
// fifth of synced PRs have no stored per-file breakdown or no observed size at all; rendering
// "not large" about a PR nobody measured would be a false claim. Render nothing for a null.
//
// ⚠ `codeLocIsLowerBound` MUST BE READ ASYMMETRICALLY. GitHub's `files(first: 100)` connection
// truncates, and it truncates exactly the biggest pull requests — the ones this feature exists
// for. When the flag is set, `codeLoc` is a FLOOR: over-threshold is safe to assert, but
// under-threshold proves nothing and must not be presented as "this PR is fine".
//
// The three fields are TRAILING OPTIONAL on every type that carries them. That is not a style
// choice: these are `packages/shared` WIRE types (not `ProContext`), and a trailing optional
// field is the additive shape that keeps the plugin `apiVersion` at 21 — a required one would be
// a breaking contract change. It also keeps IndexedDB-persisted responses written before this
// feature existed type-honest.

/** The product default when an account has stored no threshold of its own — lines of CODE churn
 *  (additions + deletions) at or above which a PR is flagged. Mirrored, deliberately, by
 *  `resolveLargePrThreshold` in the backend's `db/code-loc.ts`: `shared` is a TYPES-ONLY package
 *  the backend may only `import type` from (see PACKAGING), so the backend cannot import this
 *  value at runtime. Change both together. */
export const LARGE_PR_CODE_LOC_DEFAULT = 1500;

/** Body of POST /api/me/large-pr-threshold. `null` RESETS to the product default — it is the
 *  "no opinion" state, not a sentinel. Anything else must be a positive integer. */
export interface LargePrThresholdBody {
  threshold: number | null;
}

/** Response of POST /api/me/large-pr-threshold — the same two fields `/api/me` echoes, so the
 *  Settings panel can render the result without a refetch. */
export interface LargePrThresholdResponse {
  status: 'ok';
  largePrCodeLocThreshold: number;
  largePrCodeLocThresholdIsDefault: boolean;
}

export interface MeResponse {
  user: LocalUser | null;
  // (Claude Review is now the Pro `pro.claudeReview` capability — the old top-level
  // `claudeReviewEnabled` flag was removed; read it off `pro` instead.)
  // Deployment mode. 'cloud' tells the SPA to show a sign-out control and treat a
  // 401 from /api/me as "signed out" (vs local, where /api/me never 401s).
  deploymentMode: 'local' | 'cloud';
  // Premium capability flags (all-false in OSS mode).
  pro: ProCapabilities;
  // Is ML severity/category enrichment of bot comments live on this deployment? FREE TIER, so
  // it deliberately does NOT live inside `pro` — `entitledProCapabilities` zeroes that whole
  // object for a cloud account on the free plan, which is exactly this feature's audience.
  // True iff the backend has a reachable severity-api configured (SEVERITY_API_URL); false
  // under `npx pierre-review`, which ships no model. Gates every ML query the SPA makes.
  mlSeverity: boolean;
  // CLOUD-ONLY: whether this account has consented to contribute aggregate, de-identified
  // weekly review-bot stats to the cross-org benchmark network (opt-in, default false). Drives
  // the Settings consent toggle. Always false in local mode (local never contributes).
  benchmarkOptIn: boolean;
  // The RESOLVED large-PR threshold for this account, in lines of CODE churn — the stored
  // per-account value, or LARGE_PR_CODE_LOC_DEFAULT when the user has never set one. Always a
  // positive integer, so every renderer compares against a number and never has to know about
  // the null.
  //
  // TOP-LEVEL, and deliberately NOT inside `pro`: the large-PR flag is a FREE feature, and
  // `entitledProCapabilities` zeroes that whole object for a cloud account on the free plan —
  // which is exactly this feature's audience (the same argument as `mlSeverity` above).
  largePrCodeLocThreshold: number;
  // True when nothing is stored and the number above IS the product default. The one thing the
  // resolved figure can't say on its own, and the Settings field needs it to show an empty input
  // with a "Default (1,500)" placeholder rather than a value the user never typed.
  largePrCodeLocThresholdIsDefault: boolean;
  // Orgs whose sync is currently BLOCKED because the sign-in token isn't authorized for their
  // SAML SSO (cloud). Populated by the sync when it hits the SAML wall; drives the global
  // "Reconnect GitHub for <org>" banner. Empty in the normal case + always empty in local mode.
  authNotices: AuthNotice[];
  // Month-to-date AI balances (summary turns + agent credits), fetched on login so the SPA has
  // the spend baseline from the first authenticated call (seeds the Track-usage panel + any
  // meter). null when unavailable. A null limit/allowance inside means that seam is unmetered.
  aiUsage: AiUsageResponse | null;
}

// ---- Pro per-account settings (packages/pro `pro_settings`; via GET/PUT /api/pro/settings) ----
export type SlackDigestCadence = 'off' | 'daily' | 'twice_daily';
export type IssueProvider = 'jira' | 'linear';

// Read shape (GET /api/pro/settings). ⚠ The Slack config left this type in plugin migration 0030 —
// it is per-WORKSPACE now; see `SlackTargetsResponse` below.
// How the Insights flow-metrics + sprint report frame their comparison window:
//  - 'rolling_7' / 'rolling_14': the trailing N days vs the immediately-preceding N days. No sprint
//    needed; always a full window (no "day-1 cliff"), good for teams that don't run sprints.
//  - 'sprint': like-for-like by SPRINT POSITION — this sprint SO FAR vs the SAME elapsed slice of
//    the previous sprint. Requires a configured sprint (start + cadence); with none it falls back
//    to 'rolling_14'.
export type SprintComparisonMode = 'rolling_7' | 'rolling_14' | 'sprint';

export interface ProSettings {
  // ⚠ NOTHING IN THIS SECTION IS AN ACCOUNT FACT ANY MORE. The sprint LENGTH and its phase anchor
  // went per-WORKSPACE in plugin migration 0031; the COMPARISON MODE followed them in plugin
  // migration 0032, and none of the three has an account-level default beneath it —
  // `resolveSprintCadence` / `resolveComparisonMode` read the workspace row or answer the product
  // default, two states, no chain. All three fields are RETAINED ONLY SO THE FIELD SET DOES NOT
  // MOVE UNDER A STALE CLIENT (a client reading `settings.sprint.comparisonMode` off an absent
  // `sprint` would throw) and are now ALWAYS null; the `pro_settings` columns behind them are
  // dormant — never selected, never written. Edit the real values on `WorkspaceProSettings` via
  // GET/PUT /api/pro/settings/workspace.
  //
  // ⚠ `comparisonMode: null` HERE IS NOT "rolling_14". Emitting the product default from a route
  // that no longer stores the setting would tell a reader their account is on a mode that may not
  // be what any of their workspaces resolves to — a dormant column read back onto the wire is how
  // a retired grain keeps answering questions.
  sprint: {
    /** @deprecated ALWAYS null — the cadence is per-workspace. See `WorkspaceProSettings`. */
    cadenceDays: number | null;
    /** @deprecated ALWAYS null — the phase anchor is per-workspace. See `WorkspaceProSettings`. */
    startDate: string | null;
    /** @deprecated ALWAYS null — the comparison mode is per-workspace as of plugin migration
     *  0032. Read `WorkspaceProSettings.comparisonMode`. */
    comparisonMode: SprintComparisonMode | null;
  };
  // (There is NO `slack` section here any more. The digest is a PER-WORKSPACE delivery as of
  // plugin migration 0030 — see `WorkspaceSlackTargetResponse` below and
  // GET/PUT/DELETE /api/pro/slack/target?workspace=<id>.
  // It is a different GRAIN and cannot share this account patch's single Save button: one Save
  // spanning both grains is where a per-team edit silently travels to every team.)
  // (There is NO `aiUpdate` policy any more. The per-repo Haiku digests and the sprint report
  // regenerate ONLY when a user clicks Refresh/Regenerate — the ticking cron that read a
  // manual|interval|on_change mode from `pro_settings` was deleted. The one remaining automated
  // caller is the SLACK DIGEST cron, which independently rebuilds both on the account's configured
  // cadence; an account with no Slack cadence is genuinely manual-only.)
  /**
   * @deprecated ALWAYS EMPTY — `{provider: null, baseUrl: null, projectKeys: []}`. The issue
   * tracker moved to the WORKSPACE grain in plugin migration 0031 (`pro_workspace_settings`,
   * GET/PUT /api/pro/settings/workspace → `WorkspaceProSettings.issue`), because the enricher's
   * input is a PR and a PR's repo belongs to exactly one workspace. The `pro_settings.issue_*`
   * columns are dormant — never selected, never written — so this block has nothing to read and
   * emits the empty shape rather than a stale one. Retained ONLY so the field set does not move
   * under a stale client; DELETE once no client reads it.
   */
  issue: { provider: IssueProvider | null; baseUrl: string | null; projectKeys: string[] };
  // Bot-Triage Platform (WS8 control surface), now down to the Slack bot digest + two vestigial
  // fields.
  //
  // ⚠ THE DETECTION AND ATTRIBUTION FIELDS WERE REMOVED FROM THE WIRE. `inhouseDetect` /
  // `autoTagHighConfidence` / `loginAllowlist` / `deepDetect` / `aiTiebreak` had no production
  // consumer — CORE's `classifyReviewer` never received them (core cannot read the plugin's
  // `pro_settings` table at all), so they were switches wired to nothing. `tagPierreReviews` /
  // `pierreFooter` went too: the hidden marker is now stamped unconditionally, because it is the
  // ONLY producer of the 'pierre' AutomatedReviewerKind and a user turning it off silently deleted
  // the Bot-ROI "Limn · Claude" row. Their `pro_settings` COLUMNS stay dormant (like
  // `bot_auto_resolve*` below) — no migration, no data loss, nothing reads them.
  bots: {
    /** @deprecated ALWAYS false. The "Review bots" Slack block is a property of the DELIVERY as of
     *  plugin migration 0033 — `SlackTarget.botDigest`, one row per (account, workspace), edited on
     *  GET/PUT /api/pro/slack/target?workspace=. `pro_settings.bot_slack_digest` is dormant and the
     *  account PUT strips the field. Retained only so the shape does not move under a stale
     *  client. */
    slackDigest: boolean;       // WS5
    autoResolve: boolean;       // WS6b master enable
    autoResolveDays: number;
    /**
     * @deprecated LEGACY, READ-ONLY. Per-bot monthly cost stored in the plugin-owned
     * `pro_settings.bot_cost_json` blob, superseded by `account_reviewers.monthly_cents` in CORE
     * (one row per (account, actor), nullable — NULL is "no price set", 0 is "free" — edited on
     * the bot row in Activity → Bots → Settings). Cost became CORE/free in the move: an OSS/npx
     * install can now set and see a price — but the READ is `botDepth`-gated as of the ROI panel
     * going paid, so an unentitled account gets `costMonthlyUsd: null` on every row regardless of
     * where the number came from. This legacy blob's read-time fallback is subject to the same
     * strip (it fills `costMonthlyUsd`, which is what gets nulled).
     *
     * Plugin migration 0019 copies what it can into that column. Unlike its predecessor it writes
     * nothing but the price: cost sits on the actor's own identity row, so importing one
     * fabricates no classification judgement.
     *
     * IT CANNOT COPY EVERYTHING, which is why this field survives on the wire. The blob has had
     * TWO shapes: entries keyed by `login` (migratable — join `users` on the login) and older
     * entries keyed by vendor `kind` (NOT migratable — a kind names a brand, not an actor, so
     * there is no `author_user_id` to key a row on, and the kind→login map lives in this file,
     * not in SQL). Kind-keyed entries stay in the blob and keep driving the ROI panel through the
     * read-time fallback, which fills a row ONLY where the server-resolved `costMonthlyUsd` is
     * null.
     *
     * RETIRE — this field, `bot_cost_json`, `parseCost` and that fallback branch — one release
     * after the one that ships `account_reviewers`, gated on a manual
     * `SELECT count(*) FROM pro_settings WHERE bot_cost_json IS NOT NULL` reaching zero. There is
     * no write path any more (`ProSettingsUpdate.bots.cost` is gone), so the set can only shrink.
     */
    cost: { login: string; monthlyUsd: number }[];  // WS3b
  };
}

// Write shape (PUT /api/pro/settings) — a partial patch; only present sections/fields change.
// `slack.webhookUrl` is write-only ('' clears it).
export interface ProSettingsUpdate {
  // ⚠ NOTHING IN THIS SECTION IS WRITABLE ANY MORE. `cadenceDays` / `startDate` were dropped from
  // the PUT body schema in plugin migration 0031 and `comparisonMode` in plugin migration 0032 —
  // all three are per-WORKSPACE now, with no account default beneath any of them. A stale client
  // still sending one is SILENTLY STRIPPED by `additionalProperties: false` + ajv
  // `removeAdditional` and still gets a 200: nothing changes, which is the right outcome, but it
  // is silent, hence written down (the standing failure mode for every field retired from this
  // patch). The whole section is retained only so the shape does not move under a stale client.
  sprint?: {
    /** @deprecated STRIPPED by the PUT schema. Write `WorkspaceProSettingsUpdate.sprint`. */
    cadenceDays?: number | null;
    /** @deprecated STRIPPED by the PUT schema. Write `WorkspaceProSettingsUpdate.sprint`. */
    startDate?: string | null;
    /** @deprecated STRIPPED by the PUT schema (plugin migration 0032). Write
     *  `WorkspaceProSettingsUpdate.comparisonMode`. */
    comparisonMode?: SprintComparisonMode;
  };
  // (No `slack` section — see the read shape. A stale client still sending one is SILENTLY
  // STRIPPED by the PUT body schema's `additionalProperties: false` + ajv `removeAdditional`, and
  // the request still 200s. That is the right outcome, but it is silent, so it is written down.)
  // (No `aiUpdate` — the AI-summary update policy was removed; see the read shape above.)
  /**
   * @deprecated STRIPPED by the PUT body schema (plugin migration 0031) — the issue tracker is a
   * per-WORKSPACE setting now. Write `WorkspaceProSettingsUpdate.issue` on
   * PUT /api/pro/settings/workspace instead. A stale client sending this still gets a 200 with
   * nothing changed.
   */
  issue?: { provider?: IssueProvider | null; baseUrl?: string | null; projectKeys?: string[] | null };
  // Bot-Triage settings patch (WS8). Only present fields change.
  //
  // `cost` was REMOVED here on purpose: per-bot cost is now written through
  // `PUT /api/bot-reviewers/:userId/cost` (`ReviewerCostBody`) into core `account_reviewers`.
  // Two live writers to one price is how the two silently disagree, so this one was
  // retired rather than mirrored.
  // The read (`ProSettings.bots.cost`) survives as a deprecated legacy fallback — see there.
  //
  // The detection + Limn-attribution fields were removed too (see the read shape). Their columns
  // stay dormant in `pro_settings`; nothing writes them any more.
  //
  // Failure mode for a stale client that still sends a removed key (`bots.cost`,
  // `bots.aiTiebreak`, `aiUpdate`, …): the PUT body schema has `additionalProperties: false` and
  // ajv runs with `removeAdditional`, so the key is SILENTLY STRIPPED rather than 400'd. That is
  // the right outcome (nothing changes, the request still succeeds) but it is silent, so it is
  // written down here.
  bots?: {
    /** @deprecated STRIPPED by the PUT schema (plugin migration 0033). Write
     *  `WorkspaceSlackTargetUpdate.botDigest` on PUT /api/pro/slack/target?workspace= instead. */
    slackDigest?: boolean; autoResolve?: boolean; autoResolveDays?: number;
  };
}

// ---- THE PER-WORKSPACE Pro CONFIG (GET/PUT /api/pro/settings/workspace?workspace=<id>) -------
//
// ONE table, ONE route, ONE grain. `pro_workspace_settings` is keyed (account_id, workspace_id)
// and now carries BOTH per-workspace configs: the sprint cadence (plugin migration 0029) and the
// Jira/Linear issue tracker (plugin migration 0031). The Slack delivery target is the third
// per-workspace fact and keeps its own table only because a ROW THERE IS A DELIVERY TARGET —
// its existence is the setting.
//
// ⚠ THERE IS NO ACCOUNT-LEVEL DEFAULT UNDER ANY OF THESE, AND THAT IS THE DESIGN. All three used
// to fall back to `pro_settings` (the cadence through one resolver, the issue tracker and the
// comparison mode as the only grain there was). Plugin migrations 0031 and 0032 retired every
// fallback: two states, no chain — the workspace has a value, or it has none.
// `ProSettings.sprint` and `ProSettings.issue` are deprecated husks that always read empty; the
// columns behind them are dormant.
//
// ⚠ "NO CADENCE" IS THE PRODUCT DEFAULT AND IT IS NOT A NUMBER. A workspace with no stored
// cadence has no sprint grid at all: `comparisonMode: 'sprint'` degrades to the rolling-14 window
// and the Reports sprint grain refuses. That is exactly what an unconfigured account did before
// this change — the fallback that was removed pointed at an account pair that was itself usually
// null. Do not invent a default sprint length here; there has never been one.
//
// ⚠ `comparisonMode` IS HERE AS OF PLUGIN MIGRATION 0032, AND THE OLD JUSTIFICATION FOR KEEPING IT
// ACCOUNT-WIDE WAS FALSE. It read "a reading preference with no per-team meaning" — but the mode
// and the cadence COMPOSE: under `'sprint'` a workspace WITH a cadence gets a sprint-position
// window while one WITHOUT silently gets rolling-14 (`resolveComparisonWindow`). One account
// setting therefore produced two different window SHAPES across a reader's workspaces, with
// nothing on screen saying so. The mode is a property of how a TEAM reads its own numbers, so it
// sits on the same row as the cadence it composes with — and the same two-state rule applies: a
// workspace has a stored mode, or it uses the PRODUCT DEFAULT `'rolling_14'`. There is no
// inheritance chain and `pro_settings.comparison_mode` is dormant.

// Where a configured project key is looked for. Both scopes ALWAYS scan the PR TITLE; the only
// question is whether the HEAD BRANCH is scanned too.
//
// ⚠ NOTHING HAS EVER SCANNED COMMIT MESSAGES, in any scope. Detection reads the PR title and the
// head branch name and nothing else.
//
// ⚠ THIS ONLY BITES IN ALLOWLIST MODE. With no project keys configured the branch is never
// scanned anyway — a lowercase branch key (`eng-123`) is structurally indistinguishable from
// `node-18` / `release-2` / a dependency bump, which is why branch scanning is allowlist-gated in
// the first place. So `'title'` narrows an allowlisted setup and changes nothing otherwise.
//
// Default is `'title_branch'` — today's behaviour — so nobody's detection changes silently.
export type IssueMatchScope = 'title' | 'title_branch';

// The issue tracker, per workspace. provider/baseUrl configure the deep-link target; projectKeys
// is an optional allowlist of project prefixes (e.g. ['ENG','PROJ']) — when non-empty, ONLY keys
// with a listed prefix are detected (near-zero false positives). Empty → heuristic detection,
// which is title-only and uppercase-only by construction.
export interface WorkspaceIssueSettings {
  provider: IssueProvider | null;
  baseUrl: string | null;
  projectKeys: string[];
  matchScope: IssueMatchScope;
}

export interface WorkspaceProSettings {
  workspaceId: number;
  // The sprint pair — what every window on this workspace is framed by. Both null = no sprint.
  cadenceDays: number | null;
  startDate: string | null;      // ISO (date @ UTC midnight); null = no phase anchor set
  issue: WorkspaceIssueSettings;
  // How this workspace's Insights / flow-metrics comparison window is framed (plugin migration
  // 0032). ALWAYS a value — an unset workspace reads the product default `'rolling_14'`, which is
  // the ONLY default there is; nothing inherits from the account.
  //
  // ⚠ IT COMPOSES WITH `cadenceDays`, WHICH IS WHY THEY SHARE A ROW. `'sprint'` on a workspace
  // with no cadence degrades to the rolling-14 window; on one with a cadence it is a
  // sprint-position comparison. Reading the two off different grains is how one setting produced
  // two window shapes with nothing on screen saying which you got.
  comparisonMode: SprintComparisonMode;
}

/**
 * @deprecated TRANSITIONAL NAME. Renamed to `WorkspaceProSettings` when the issue tracker joined
 * the row; the three fields below are the RETIRED account-fallback disclosure and are now NEVER
 * EMITTED (a reader gets `undefined`). DELETE this alias, and the frontend's reads of `source` /
 * `accountCadenceDays` / `accountStartDate`, together.
 */
export interface WorkspaceSprintSettings extends WorkspaceProSettings {
  /** @deprecated never emitted — there is no other source. */
  source?: 'workspace' | 'account';
  /** @deprecated never emitted — there is no account cadence. */
  accountCadenceDays?: number | null;
  /** @deprecated never emitted — there is no account cadence. */
  accountStartDate?: string | null;
}

// Write shape (PUT /api/pro/settings/workspace?workspace=<id>). A PARTIAL patch over ONE
// workspace's row: an omitted section is untouched, so the two Settings sections keep their own
// Save buttons without either one clobbering the other's fields.
//
// ⚠ `sprint.cadenceDays: null` CLEARS the cadence — it NULLS THE PAIR, it does NOT delete the row.
// The row also holds the issue tracker now, so a delete would take an unrelated setting with it.
// A row whose cadence pair is null is exactly equivalent to no row: there is nothing left for it
// to "follow", so the two states cannot disagree.
export interface WorkspaceProSettingsUpdate {
  sprint?: {
    // Required WITHIN the section (not optional) precisely so "clear" is an explicit ask and never
    // the accidental result of an omitted field.
    cadenceDays: number | null;
    // OMITTED keeps the stored phase anchor, so a cadence-only edit does not silently re-phase the
    // grid; sent as null clears it.
    startDate?: string | null;
  };
  issue?: {
    provider?: IssueProvider | null;
    baseUrl?: string | null;
    // [] / null clears the allowlist (→ heuristic, title-only detection).
    projectKeys?: string[] | null;
    matchScope?: IssueMatchScope;
  };
  // The comparison-window mode for THIS workspace (plugin migration 0032). TOP-LEVEL, not inside
  // `sprint`: that section declares `cadenceDays` REQUIRED so that clearing a cadence is always an
  // explicit ask, which would make a mode-only patch impossible to express. Omitted = unchanged;
  // there is no "clear" — the mode always has a value, and writing `'rolling_14'` IS the default.
  comparisonMode?: SprintComparisonMode;
}

/**
 * @deprecated The FLAT sprint patch. The PUT body now nests it under `sprint`, and this shape is
 * `additionalProperties: false` against that schema — a client still sending `{cadenceDays, …}`
 * at the top level has BOTH KEYS SILENTLY STRIPPED and gets a 200 with nothing saved. DELETE with
 * the alias above.
 */
export interface WorkspaceSprintUpdate {
  cadenceDays: number | null;
  startDate?: string | null;
}

// ---- The PER-WORKSPACE Slack digest (GET/PUT/DELETE /api/pro/slack/target?workspace=<id>) ----
//
// The digest is delivered PER WORKSPACE. One row per (account, workspace) in the plugin's
// `workspace_slack_targets` table; a row EXISTS ⇒ that workspace's report is generated on this
// schedule and posted to this channel, and no row ⇒ that workspace gets nothing.
//
// ⚠ THE ROUTE EDITS EXACTLY ONE WORKSPACE — THE ONE IN `?workspace=`. There is no picker and no
// "apply to all" fan-out: the Settings modal configures the workspace the reader is currently in,
// like every other per-workspace control. `DELETE` is how a workspace stops being a target; that
// is a VERB rather than "absent from a submitted list", so no save can drop a delivery by
// omission.
//
// ⚠ THERE IS NO ACCOUNT-LEVEL WEBHOOK AND NO INHERITANCE. A nullable "inherit" column would be
// the null-means-INHERIT bug class CLAUDE.md names — and inheriting a webhook is worse than
// inheriting a number: it silently posts a new team's private figures into whichever channel the
// account owner configured years ago. Two states: a channel, or none.
//
// ⚠ THE CAP IS NOW A SWEEP BOUND, AND IT IS STILL DISCLOSED. With no picker, the population the
// cron bills for is "every workspace that HAS a target row" — so the cap moved onto the act of
// ADDING one: configuring a target for a workspace when `configuredCount` already equals `cap` is
// REFUSED (400) with the number in the message. Each target is its own sprint-report generation on
// every send, so this is a spend bound, not a UI nicety. `cap` and `configuredCount` ride the GET
// so the UI can warn BEFORE the Save rather than explaining a refusal after it.
export const SLACK_TARGET_WORKSPACE_CAP = 12;

// One workspace's delivery target as the API returns it.
//
// ⚠ THE WEBHOOK URL IS WRITE-ONLY — never returned by any route. `configured` is all a reader
// gets, and it is always true for a row that exists (the column is NOT NULL): it is on the wire so
// the SPA can render "•••••••• (unchanged)" from a field rather than from the row's mere presence.
export interface SlackTarget {
  workspaceId: number;
  workspaceName: string;
  configured: boolean;
  cadence: SlackDigestCadence;
  hour1: number; // 0-23, local to `timezone`
  hour2: number; // second daily send, used only for 'twice_daily'
  timezone: string | null; // IANA tz; null = server tz
  lastSentAt: string | null; // ISO-8601; null = never delivered
  // Whether this delivery carries the deterministic "Review bots" signal-to-noise block (plugin
  // migration 0033). Defaults to false for a target row that has never set it.
  //
  // ⚠ IT LIVES ON THE TARGET ROW BECAUSE THE ROW IS THE DELIVERY. It used to be
  // `pro_settings.bot_slack_digest`, one flag per account, under a comment claiming the block was
  // "not a per-team fact" — a premise that died when the digest itself became per-workspace in
  // plugin 0030: from that point one account flag decided the CONTENT of N independently-scheduled
  // messages about N different teams' bots. The 0033 migration copies the account flag onto every
  // existing target row, so nobody loses the block on upgrade.
  botDigest: boolean;
}

// GET/PUT/DELETE /api/pro/slack/target?workspace=<id> all answer with this.
export interface WorkspaceSlackTargetResponse {
  // Echoed like every scoped response — `?workspace=` that is absent / unparseable / unknown /
  // another tenant's degrades to the account's DEFAULT workspace, never a 404.
  workspaceId: number;
  workspaceName: string;
  // null = this workspace has no channel and receives nothing.
  target: SlackTarget | null;
  // The sweep bound and how much of it is used, so the UI never hard-codes the number it discloses
  // (the count it enforces and the sentence it prints would then be two spellings of one rule).
  // `configuredCount` counts the ACCOUNT's target rows, this workspace included.
  cap: number;
  configuredCount: number;
}

// Write shape (PUT /api/pro/slack/target?workspace=<id>) — a partial patch over ONE row.
//
// `webhookUrl` is OPTIONAL and omitting it KEEPS the stored secret (the field is write-only, so a
// form that re-submitted what it was shown would blank it). A workspace with NO stored row and no
// `webhookUrl` is REFUSED — an undeliverable row would sit in the sweep being skipped forever.
// To stop delivering, DELETE; `cadence: 'off'` pauses while keeping the channel.
export interface WorkspaceSlackTargetUpdate {
  webhookUrl?: string;
  cadence?: SlackDigestCadence;
  hour1?: number;
  hour2?: number;
  timezone?: string | null;
  // Include the "Review bots" block in THIS workspace's digest (plugin migration 0033). Omitted =
  // unchanged. It is a content switch on one delivery, not an account preference — see
  // `SlackTarget.botDigest`.
  botDigest?: boolean;
}

/** @deprecated The multi-select write shape. `PUT /api/pro/slack/targets` IS DELETED — settings
 *  are for the current workspace only. Use `WorkspaceSlackTargetUpdate`. DELETE once no client
 *  imports it. */
export interface SlackTargetUpdate extends WorkspaceSlackTargetUpdate {
  workspaceId: number;
}

/** @deprecated `GET /api/pro/slack/targets` IS DELETED. Use `WorkspaceSlackTargetResponse`. */
export interface SlackTargetsResponse {
  targets: SlackTarget[];
  cap: number;
  workspaces: { id: number; name: string }[];
}

/** @deprecated `PUT /api/pro/slack/targets` IS DELETED. Use `WorkspaceSlackTargetUpdate`. */
export interface SlackTargetsUpdate {
  targets: SlackTargetUpdate[];
}

// Lean PR shape for the timeline. No bodies, no diff hunks.
export interface TimelinePr {
  id: number;
  repoId: number;
  number: number;
  title: string;
  authorId: number | null;
  state: PrState;
  isDraft: boolean;
  isStalled: boolean;
  openedAt: string;
  firstReviewAt: string | null;
  lastCommitAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  threadCounts: ThreadStateCounts;
  // Diff size (synced pull_requests columns, not hydrated) — the open-PR drill-down's
  // LoC column. Three small ints, cheap enough to ride the lean timeline payload.
  additions: number;
  deletions: number;
  changedFiles: number;
  // v1.1 triage fields
  ciStatus: CiStatus;
  mergeable: Mergeable;
  mergeStateStatus: MergeStateStatus;
  labels: Label[];
  reasonTag: ReasonTag;
  reviewRequestedFromMe: boolean;
  // Standing review state, derived from each reviewer's LATEST decisive review,
  // independent of CI / mergeability. Drive the review-status outline on open timeline
  // bars (green = approved, red = changes requested). Mutually exclusive: a PR with any
  // blocking changes_requested is `isChangesRequested` (never `isApproved`). Always
  // present; the UI only emphasises them on open PRs.
  isApproved: boolean;
  isChangesRequested: boolean;
  // null on closed/merged PRs (no "new" badges once a PR is done) and when
  // the PR has never been viewed.
  newSinceLastViewed: NewSinceLastViewed | null;
  // ---- the LARGE-PR FLAG (see the block above LARGE_PR_CODE_LOC_DEFAULT) ----
  // Code-only churn: additions + deletions over this PR's non-documentation, non-config files.
  // ⚠ null = UNKNOWN (no stored file breakdown / never-observed size), NEVER "not large".
  // ⚠ `codeLocIsLowerBound` means the file list was truncated: over-threshold is safe to assert,
  // under-threshold is not. Trailing + optional so this stays an additive wire change.
  codeLoc?: number | null;
  codeLocIsLowerBound?: boolean;
}

export interface OpenPrsResponse {
  prs: TimelinePr[];
}

// Per-repo "merge rights" inference: the distinct users who have actually merged
// a PR in that repo (GraphQL mergedBy). Used to badge maintainers on the
// timeline. Reference data — not bounded by the timeline window or filters.
export interface RepoMergers {
  repoId: number;
  userIds: number[];
}

export type MergersResponse = RepoMergers[];

// ---- contributor profile stats (the user popover) ----

// One contributor's ALL-TIME activity totals over the synced data, scoped to the caller's
// account and (optionally) a repo subset. Deliberately COUNTS ONLY — `users` is a global
// table, so echoing back a login/avatar for an arbitrary id would turn this id-addressed
// route into a cross-tenant profile lookup. The SPA already holds the account-scoped roster
// (`useUsers()` → `listUsers(accountId)`) and joins on `userId` itself.
export interface UserContributionStats {
  userId: number;
  // PRs this user AUTHORED, split by the same four buckets as `PrStatus`.
  prsMerged: number;
  prsOpen: number;
  prsDraft: number;
  prsClosed: number;
  // Reviews this user SUBMITTED, counted the same way the timeline counts them: any
  // verdict, but excluding `pending` drafts AND the body-less `commented` review GitHub
  // wraps around a batch of inline comments (see `isSubstantiveReview`). Those inline
  // comments are already in `comments`, so counting the wrapper too would double-count
  // one act — over half the rows for an active reviewer.
  reviewsGiven: number;
  // Comments this user wrote — PR-level (issue) comments + inline review-thread replies.
  comments: number;
  // The repos the totals cover: null = every repo in the account (no narrowing was asked
  // for), otherwise the exact ids counted. Lets the popover caption itself honestly.
  repoIds: number[] | null;
}

// ---- insights (per-repo sprint stats) ----

// Open review-requests still pending for one reviewer in a repo — the review-load
// signal that surfaces a bottleneck reviewer.
export interface RepoReviewLoad {
  userId: number;
  pending: number;
}

// One open PR in the Insights per-repo list. Independent of the timeline filters
// (the panel has its own Stale toggle), so isStalled is carried per row.
export interface InsightsOpenPr {
  prId: number;
  number: number;
  title: string;
  authorId: number | null;
  isDraft: boolean;
  isStalled: boolean;
  openedAt: string;
  githubUrl: string;
}

// One weekly bucket of the per-repo "average time a PR stays open" trend. The
// metric is PR CYCLE TIME bucketed by CLOSE week: over PRs merged/closed in this
// week, the mean (closedAt − openedAt). `avgOpenHours` is null for a week with no
// merged/closed PRs (the chart shows a gap / bridges it). Buckets span
// InsightsResponse.chartWindowDays back from now, oldest first.
export interface InsightsTimePoint {
  // ISO timestamp for the start of the weekly bucket.
  bucketStart: string;
  // Mean hours a PR stayed open, over PRs closed in this bucket. null = no sample.
  avgOpenHours: number | null;
  // How many merged/closed PRs fell in this bucket (the average's sample size).
  count: number;
}

// A per-repo snapshot for the Insights panel. Counts are current state; the
// time-windowed figures carry their window in InsightsResponse. Per repo only
// (no cross-repo/workspace aggregation yet).
export interface RepoInsights {
  repoId: number;
  repoFullName: string;
  // Currently-open PRs, split by draft.
  openPrs: number;
  draftPrs: number;
  // PRs merged within InsightsResponse.mergedWindowDays.
  mergedLast7d: number;
  // Open PRs flagged stalled (open threads + no recent commit; see stallThresholdDays).
  stalledPrs: number;
  // Median hours from open → first review, over PRs opened within reviewWindowDays
  // that have received a review. null when there's no sample.
  medianHoursToFirstReview: number | null;
  // The oldest currently-open, non-draft PR with no review yet — the thing most at
  // risk of falling through the cracks. null when every open PR has a review.
  oldestUnreviewed: {
    prId: number;
    number: number;
    title: string;
    openedAt: string;
    githubUrl: string;
  } | null;
  // Reviewers with the most pending review-requests (top few, desc). userId resolves
  // against the global user list (GET /api/users).
  reviewLoad: RepoReviewLoad[];
  // ALL currently-open PRs in this repo (oldest first; capped), independent of the
  // timeline filters — the collapsible per-repo list with its own Stale toggle. Each
  // carries isStalled so the client can filter without another round-trip.
  openPrList: InsightsOpenPr[];
  // Weekly "average time a PR stays open" trend (cycle time by close week) over
  // InsightsResponse.chartWindowDays, oldest first. One point per week.
  openDurationTrend: InsightsTimePoint[];
}

export interface InsightsResponse {
  repos: RepoInsights[];
  // Window descriptors so the UI copy stays in sync with the server's windows.
  mergedWindowDays: number;
  reviewWindowDays: number;
  stallThresholdDays: number;
  // Span (days, back from now) covered by each repo's openDurationTrend; weekly buckets.
  chartWindowDays: number;
  generatedAt: string;
}

// ---- Repo analytics drill-down (GET /api/insights/:repoId/analytics) ----
// A heavier, on-demand per-repo bundle of chart series, loaded only when the
// drill-down panel opens. Every WEEKLY series is an array aligned 1:1 to
// `weekBuckets` (index i ↔ weekBuckets[i], oldest first); distribution series are
// labelled bins; the scatter + heatmap carry their own shapes.

// A labelled histogram bin (a categorical bar).
export interface AnalyticsBin {
  label: string;
  count: number;
}

// One PR in the size-vs-cycle-time scatter.
export interface SizeCyclePoint {
  prNumber: number;
  loc: number; // additions + deletions
  hoursOpen: number; // close − open
  merged: boolean; // merged vs closed-without-merge
}

// Median time-open per LOC bucket, over PRs closed in the window — surfaces whether
// review time scales (super-linearly) with PR size. medianHours is null for an empty
// bucket. Buckets share the labels of `sizeDist`, ordered XS→XL.
export interface SizeCycleBucket {
  label: string;
  medianHours: number | null;
  count: number;
}

// Per-reviewer weekly review counts (reviews submitted), aligned to weekBuckets.
export interface ReviewerLoadSeries {
  userId: number; // resolves against GET /api/users
  total: number;
  weekly: number[];
}

export interface RepoAnalytics {
  repoId: number;
  repoFullName: string;
  windowDays: number;
  stallThresholdDays: number;
  generatedAt: string;
  // Shared x-axis for every weekly series: ISO bucket-start, oldest first.
  weekBuckets: string[];

  // Flow & throughput
  throughput: { opened: number[]; merged: number[]; closed: number[] };
  // Backlog of open PRs at each week's end, with the stalled subset (open + no
  // commit within stallThresholdDays at that snapshot).
  backlog: { open: number[]; stalled: number[] };

  // Speed & latency
  // Median hours open→first-review for PRs OPENED each week (null = no sample).
  reviewLatencyTrend: { medianHours: (number | null)[]; count: number[] };
  // Cycle time decomposed for PRs CLOSED each week: open→first-review and
  // first-review→close (mean hours; 0 when count is 0).
  cycleBreakdown: { toFirstReview: number[]; reviewToMerge: number[]; count: number[] };
  // Distribution of time-to-first-review across PRs first-reviewed in the window.
  reviewLatencyDist: AnalyticsBin[];

  // Review health
  // Review threads by derived state, bucketed by the thread's createdAt week.
  threadMix: {
    resolved: number[];
    likely_addressed: number[];
    replied_unresolved: number[];
    untouched: number[];
  };
  // Submitted reviews by verdict, bucketed by submittedAt week.
  reviewVerdicts: {
    approved: number[];
    changes_requested: number[];
    commented: number[];
    dismissed: number[];
  };
  // Reviews given per reviewer per week (top reviewers; rest folded into an
  // `others` row with userId = null-sentinel -1).
  reviewerLoad: ReviewerLoadSeries[];

  // Size & risk
  sizeDist: AnalyticsBin[]; // PRs opened in window, by LOC bucket
  sizeVsCycle: SizeCyclePoint[]; // PRs closed in window (capped)
  sizeCycleByBucket: SizeCycleBucket[]; // median time-open per LOC bucket (all closed)

  // Cadence: activity counts by weekday×hour (UTC), row-major dow*24+hour,
  // dow 0=Sunday. Length 168.
  activityHeatmap: number[];

  // CI recovery (from the ci_status_events transition log), per weekly bucket (aligned to
  // weekBuckets): the median hours a PR head spent red before CI went green again that week,
  // plus how many recoveries (incidents) resolved in the week. medianHours null = no sample.
  // Empty array when the repo has no CI transition history yet.
  ciRecovery: { weekStart: string; medianHours: number | null; incidents: number }[];
  // Top CI failure reasons over the window, by failing check/stage name (desc). Empty when
  // there's no CI transition history.
  ciFailuresByStage: { stage: string; count: number }[];
}

// Lean event shape for the timeline. No bodies.
export interface TimelineEvent {
  id: number;
  repoId: number;
  actorId: number | null;
  prId: number | null;
  type: EventType;
  occurredAt: string;
  // For navigation: the thread this event points at, when applicable.
  threadId: number | null;
  // For review_comment markers: the derived state of the thread this comment
  // belongs to (resolved / likely_addressed / replied_unresolved / untouched),
  // so the timeline's "Threads" filter can narrow markers to a specific state
  // rather than showing every comment on a matching PR. null for other events.
  derivedState: DerivedState | null;
  // The underlying entity row id (events.ref_id). For commit_pushed this is the
  // commit row id, letting the marker modal resolve the commit via /api/prs/:id
  // without bloating the timeline payload.
  refId: number | null;
  // For review_submitted markers: the review outcome (drives icon/colour).
  reviewState: ReviewState | null;
}

export interface TimelineResponse {
  prs: TimelinePr[];
  events: TimelineEvent[];
  /**
   * Set only when a server-side row cap truncated the result — i.e. the requested window
   * held more PRs or events than one response may safely materialise. The board is showing
   * the most RECENT rows; narrow the range to see the rest. Absent in the normal case.
   */
  truncated?: true;
}

export interface CommentDetail {
  id: number;
  authorId: number | null;
  body: string;
  diffHunk: string | null;
  createdAt: string;
  // Deep link to this comment on GitHub (#discussion_r<id>); null until synced.
  url: string | null;
}

export interface ThreadDetail {
  id: number;
  prId: number;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  derivedState: DerivedState;
  // Deterministic addressed-confidence + a compact machine reason tag (see Part A). Advisory.
  addressedConfidence: AddressedConfidence;
  addressedReason: string | null;
  originalCommenterId: number | null;
  createdAt: string;
  comments: CommentDetail[];
  // Deep link to the thread on GitHub (its first comment's #discussion_r anchor);
  // null until synced.
  url: string | null;
}

export interface ReviewDetail {
  id: number;
  authorId: number | null;
  state: ReviewState;
  body: string | null;
  submittedAt: string;
  // Deep link to the review on GitHub (#pullrequestreview-<id>); null until synced.
  url: string | null;
  // Bot-triage (compute-on-read in getPrDetail): when the review's author is classified
  // automated, the vendor/in_house/pierre kind (else absent/null → a human review).
  automatedKind?: AutomatedReviewerKind | null;
  // Set ONLY for kind==='pierre' — whether the posted body was Claude's verbatim summary
  // ('ai_verbatim') or a materially human-edited review ('human_curated').
  provenance?: ReviewProvenance | null;
}

export interface PrCommentDetail {
  id: number;
  authorId: number | null;
  body: string;
  createdAt: string;
  // Deep link to the comment on GitHub (#issuecomment-<id>); null until synced.
  url: string | null;
}

export interface CommitDetail {
  id: number;
  sha: string;
  authorId: number | null;
  committerId: number | null;
  message: string | null;
  committedAt: string;
}

// A Jira/Linear ticket reference detected in a PR (compute-on-read by the Pro enricher, from
// the PR title + head branch). Rendered as a link chip in the PR-detail Overview.
export interface TicketRef {
  key: string; // e.g. "PROJ-123"
  url: string; // deep link into the configured Jira/Linear workspace
  provider: IssueProvider;
}

export interface PrDetail {
  id: number;
  repoId: number;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  // Jira/Linear ticket links (Pro, compute-on-read via registerPrDetailEnricher). Tri-state:
  //   null → feature off or no provider configured (render nothing)
  //   []   → provider configured but no ticket key found (render a muted "No ticket found")
  //   [..] → render a link chip per detected ticket
  tickets: TicketRef[] | null;
  authorId: number | null;
  state: PrState;
  isDraft: boolean;
  isStalled: boolean;
  openedAt: string;
  firstReviewAt: string | null;
  lastCommitAt: string | null;
  mergedAt: string | null;
  // Who merged the PR (GraphQL `mergedBy`), distinct from the author; null on
  // open/closed-unmerged PRs. Resolved via the `users` array below.
  mergedById: number | null;
  closedAt: string | null;
  updatedAt: string;
  githubUrl: string;
  // The head commit SHA (null until synced). Drives the Claude Review tab's
  // "you already reviewed this exact SHA" warning.
  headSha: string | null;
  // v1.2 Checks/Overview tab: CI + mergeability + labels + per-job checks +
  // outstanding reviewers (head-commit derived).
  ciStatus: CiStatus;
  mergeable: Mergeable;
  mergeStateStatus: MergeStateStatus;
  // GitHub's overall review decision (GraphQL PullRequest.reviewDecision), synced onto the
  // PR row. This is what makes a `blocked` merge verdict able to say WHY: `mergeStateStatus`
  // alone only says "protection unmet", while 'review_required' / 'changes_requested' names
  // the actual blocker. null = the repo has no review requirement, or it isn't synced yet.
  reviewDecision: PrReviewDecision | null;
  labels: Label[];
  checkRuns: CheckRun[];
  // Diff size summary (from GitHub's pullRequest.additions/deletions/changedFiles).
  // `changedFilesCount` is the true file count, which may exceed `files.length` when
  // a PR touches more files than the synced page (files is capped at 100).
  additions: number;
  deletions: number;
  changedFilesCount: number;
  // Per-file breakdown for the "Changes" tab (capped at 100 files; ordered as
  // GitHub returns them). Empty until a sync has populated it.
  files: PrFileChange[];
  requestedReviewers: RequestedReviewer[];
  // Whether the viewer may approve this PR: they have GitHub WRITE/MAINTAIN/ADMIN
  // permission on the repo AND are not the PR's author. Computed on read from the
  // synced repos.viewerPermission + the account's user id. The approve route
  // re-checks this server-side.
  viewerCanApprove: boolean;
  // Whether the viewer may PUSH to the repo: they have GitHub WRITE/MAINTAIN/ADMIN
  // permission on the repo. Unlike viewerCanApprove this does NOT exclude the author
  // (an author can push to their own PR branch). Gates the Pro "AI Fix" push
  // controls; the push route re-checks server-side. Computed on read from the synced
  // repos.viewerPermission.
  viewerCanPush: boolean;
  // Whether the viewer may CLOSE this PR without merging: they have WRITE+ permission on
  // the repo OR they authored it (GitHub lets an author close their own PR). The close
  // route re-checks server-side. Gates the Overview "Close" action (open, non-merged PRs).
  viewerCanClose: boolean;
  // Whether the viewer's STANDING review on this PR (their latest decisive review:
  // approved / changes_requested / dismissed) is 'approved'. When true the Approve
  // control renders disabled ("Approved") — you've already approved and it still
  // stands. Distinct from viewerCanApprove (the right to approve at all).
  viewerHasApprovedStanding: boolean;
  threads: ThreadDetail[];
  reviews: ReviewDetail[];
  comments: PrCommentDetail[];
  commits: CommitDetail[];
  // Users referenced by any nested entity, for client-side lookup.
  users: User[];
  // Incremental review: when the local user last viewed this PR, and what's
  // happened since (null when never viewed or the PR is closed/merged).
  lastViewedAt: string | null;
  newSinceLastViewed: NewSinceLastViewed | null;
  // Set (cloud) when on-demand hydration was BLOCKED by the repo owner's org policy — the
  // GitHub token authenticates but isn't authorized for that org, so the description, CI
  // jobs, comment bodies etc. couldn't be fetched. The SPA renders a "why is this blank +
  // how to fix" banner. null when hydration succeeded (the normal case).
  authNotice?: AuthNotice | null;
}

// Why a PR's on-demand detail couldn't be fully hydrated in cloud (an org authorization
// wall, not a bug). `org` is the repo owner whose policy blocked the token.
export interface AuthNotice {
  kind: 'saml_sso';
  org: string;
}

// ---- my turn ----

/**
 * WHY THIS ROW IS ON YOUR PLATE — three values, because the boolean it replaces conflated two
 * genuinely different relationships and the card copy has to tell them apart.
 *
 *   • `'direct'`     — the work is tied to YOU: a review was requested of you, it is your PR,
 *                      your PR was approved, your thread got a reply, you asked for the Claude
 *                      run — OR somebody @-mentioned your login on the PR. ⚠ The mention arm
 *                      holds EVEN IN A REPO YOU ONLY READ; that is the whole reason it is not
 *                      folded into the maintainer test below. (Derived offline into
 *                      `pr_mentions` by sync/mention-scan.ts; with no rows this arm contributes
 *                      nothing and nothing widens.) Card copy: "YOUR TURN".
 *   • `'maintained'` — a NEW PR by somebody else in a repo you maintain (WRITE/MAINTAIN/ADMIN on
 *                      the repo, or you have landed a PR on its default branch). Your patch of
 *                      ground, not your work — ORBIT, not ownership. Card copy: "IN YOUR REPOS".
 *   • `'none'`       — a stranger's PR in a repo you merely track. It still needs a review, so
 *                      it still paints; it just may not interrupt you. Card copy: "REVIEW OR
 *                      REPLY".
 *
 * `'direct'` WINS over `'maintained'` — a mention in a repo you also maintain is still about you.
 *
 * ⚠ THIS NARROWS NOTHING, ANYWHERE. Every row and every card still ships; relevance decides how a
 * card is LABELLED and which count it lands in, never whether it exists. Narrowing the population
 * by it would delete work rather than route it.
 *
 * ⚠ IT IS ALSO THE CARRIER OF THE PENDING MUTE, and that is deliberate rather than an overload of
 * convenience. Muting a workspace or a repo (`Workspace.pendingMuted` / `.mutedRepoIds`) forces
 * every one of its rows to `'none'` inside `getMyTurn`, at the ONE place `personal` is folded from
 * `relevance` — so the card relabels, the notification stops, the `myTurnPersonal` figures drop it
 * and the broad `myTurn` population is untouched, all from one write. A second boolean AND-ed into
 * five notification surfaces would have been five predicates that can disagree with each other,
 * which is the drift this single fold exists to prevent. `muted` rides alongside as an
 * EXPLANATION only (see `MyTurnPr.muted`): nothing counts it, nothing filters on it.
 */
export type MyTurnRelevance = 'direct' | 'maintained' | 'none';

// A PR reference shared by the my-turn sections (enough to render a row and
// navigate on click).
export interface MyTurnPr {
  prId: number;
  repoFullName: string;
  number: number;
  title: string;
  authorId: number | null;
  state: PrState;
  openedAt: string;
  githubUrl: string;
  // ISO — WHEN THE THING THAT NEEDS YOU HAPPENED, which is a DIFFERENT column per section:
  // review requested (`firstReviewRequestedAt`), your PR's last update, the newest approval,
  // or the open time for a new PR (where opening genuinely IS the event). `openedAt` is the
  // wrong moment for the first three, so nothing may date one of those rows off it.
  //
  // ⚠ THIS IS THE SAME CLOCK AS `MyTurnCard.since`, RESOLVED ONCE — getWorkspaceInsights reads
  // this field rather than re-deriving it, so a card and the browser notification built off the
  // same fold can never disagree about when an item landed on your plate.
  //
  // Trailing-optional for wire tolerance only (the e2e mock, any response predating the field);
  // `getMyTurn` always sets it and `openedAt` is the consumer's fallback.
  since?: string;
  // ADVISORY: is this row personally relevant to the viewer, or is it "someone opened a PR in a
  // repo you happen to track"?
  //
  // ⚠ NOW DERIVED — `relevance !== 'none'`. It is still written by the server on every row and
  // still means exactly what it always meant (the union of the two positive relevances), so no
  // consumer breaks; it simply no longer carries the DISTINCTION the card copy needs. Read
  // `relevance` for anything that LABELS a row; read this only to answer "may we interrupt?".
  //
  // ⚠ IT NARROWS NOTHING ON THIS WIRE. `GET /api/my-turn` keeps returning EVERY row — the CLI
  // status board and the Done tab's restorability contract both need the full set — and the
  // "Needs attention" board keeps painting every card. The flag exists for the NOTIFICATION
  // surfaces (the welcome-back banner, the Workspace-dropdown badges, browser notifications),
  // which must not tap you on the shoulder for a stranger's PR in a repo you have never touched.
  //
  // Trailing-optional for wire tolerance only; `getMyTurn` always sets it. Absent ⇒ treat as
  // true — that is the pre-narrowing behaviour, and erring towards notifying is the safe way
  // round for a response we can't classify.
  personal?: boolean;
  // THE THREE-VALUED RELEVANCE — what `personal` collapsed, un-collapsed. See `MyTurnRelevance`.
  //
  // Trailing-optional for wire tolerance only; `getMyTurn` always sets it. Absent ⇒ fall back to
  // `personal` (`true` ⇒ 'direct', `false` ⇒ 'none'): a response predating this field cannot
  // distinguish 'maintained', and only the "New PRs" section can ever be that value.
  relevance?: MyTurnRelevance;
  // ⚠ DISPLAY ONLY, AND NO COUNTER MAY EVER READ IT. This row's repo is muted for Pending
  // (`Workspace.pendingMuted` or `.mutedRepoIds`), which is WHY its `relevance` is `'none'` —
  // the downgrade has already happened upstream and every figure, lens and label follows from
  // `relevance` alone. The flag exists so a screen can say "muted" instead of silently demoting a
  // card the reader last saw as theirs; the moment something counts it, there are two answers to
  // "is this personal?" and they can disagree.
  //
  // Absent ⇒ not muted. Set only when true, so a normal response carries nothing new.
  muted?: boolean;
}

export interface AwaitingReviewItem extends MyTurnPr {
  // Other reviewers still pending alongside you, for context.
  alsoRequested: number;
}

export interface YourPrActivityItem extends MyTurnPr {
  newSinceLastViewed: NewSinceLastViewed;
  // Human-readable summary of what's new, e.g. "3 new comments · 1 new commit".
  summary: string;
}

// A PR you authored that is still open and has a standing approval — at least one
// approving review and no outstanding changes-requested. I.e. someone approved your
// PR, so it's likely ready to merge. `approvals` is how many reviewers approved;
// mergeable/mergeStateStatus let the row hint whether GitHub would actually let it
// merge yet (it's shown even when blocked — the approval itself is the signal).
export interface ApprovedPrItem extends MyTurnPr {
  approvals: number;
  mergeable: Mergeable;
  mergeStateStatus: MergeStateStatus;
}

// A new open PR (by someone other than you, non-draft) in one of the account's repos,
// opened at or after that repo was ADDED (`Repo.createdAt` — see the note there for why the
// cutoff exists). Surfaced so new work doesn't get missed. Dismissing one is sticky: it
// acknowledges that specific PR and does not resurface on later activity.
//
// The name is historical — it predates the removal of the per-repo "Watched" flag, which used
// to be both the membership test and the clock. Nothing is opted into any more: every repo the
// account has added qualifies. The identifier is kept because `MyTurnDismissKind`
// ('watched_repo_pr') is a value STORED in `my_turn_dismissals.kind`, and renaming the type
// without renaming that value would be worse than the stale word.
export type WatchedRepoPrItem = MyTurnPr;

export interface ThreadAwaitingItem {
  threadId: number;
  prId: number;
  repoFullName: string;
  prNumber: number;
  path: string;
  line: number | null;
  derivedState: DerivedState;
  // Last reply (the one awaiting your response), truncated.
  lastReplyExcerpt: string;
  // Full markdown of the awaiting reply; null on rows synced lean before full-body
  // persistence — the consumer falls back to `lastReplyExcerpt`.
  lastReplyBody: string | null;
  lastReplyAt: string;
  lastReplyAuthorId: number | null;
  githubUrl: string;
  /** See `MyTurnPr.personal`. Always true here — you opened the thread, so a reply on it is
   *  personally addressed to you by construction. Carried anyway so a notification surface can
   *  read ONE field across every section instead of knowing which sections are exempt. */
  personal?: boolean;
  /** See `MyTurnPr.relevance`. Always `'direct'` here, for the same by-construction reason —
   *  UNLESS the thread's repo is muted for Pending, which downgrades it to `'none'` like every
   *  other section. */
  relevance?: MyTurnRelevance;
  /** See `MyTurnPr.muted`. DISPLAY ONLY; no counter reads it. */
  muted?: boolean;
}

// A completed Claude review that hasn't been actioned yet — no GitHub review/
// comments posted from it. Surfaced in My Turn so finished reviews don't get
// forgotten. headStale = the reviewed head no longer matches the PR's head.
export interface ClaudeReviewToAction {
  reviewId: number;
  prId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  verdict: ClaudeReviewVerdict | null;
  finishedAt: string | null;
  headStale: boolean;
  githubUrl: string;
  /** See `MyTurnPr.personal`. Always true here — you asked for the run. */
  personal?: boolean;
  /** See `MyTurnPr.relevance`. Always `'direct'` here — you asked for the run — UNLESS the run's
   *  repo is muted for Pending, which downgrades it to `'none'` like every other section. */
  relevance?: MyTurnRelevance;
  /** See `MyTurnPr.muted`. DISPLAY ONLY; no counter reads it. */
  muted?: boolean;
}

export interface MyTurnResponse {
  awaitingReview: AwaitingReviewItem[];
  yourPrs: YourPrActivityItem[];
  // Your authored, open PRs with a standing approval (ready to merge). Deduped
  // against `yourPrs` — an approved PR shows here, not under "new activity".
  approvedPrs: ApprovedPrItem[];
  threadsAwaiting: ThreadAwaitingItem[];
  // New open PRs by others, opened at or after their repo was added (deduped against the
  // sections above). Empty when the account has no repos.
  watchedRepoPrs: WatchedRepoPrItem[];
  // Completed Claude reviews awaiting action (empty when Claude Review is disabled).
  claudeReviewsToAction: ClaudeReviewToAction[];
  // Users referenced by any row, for client-side lookup.
  users: User[];
}

// ---- my turn: completed / dismissed (the "Done" tab) ----
// Previously-dismissed entries, for the My Turn "Done" tab (past 90 days). Only the
// dismissal-backed kinds appear here (review_request + thread + claude_review, from
// myTurnDismissals) — "Your PRs" are cleared via mark-viewed, not a restorable
// dismissal. Each carries when it was dismissed and can be moved back to the inbox
// ("To do" = un-dismiss).
// Whether un-dismissing ("To do") would actually return the entry to the inbox.
// The inbox is derived live from GitHub state, so an entry whose PR has since been
// merged/closed (or thread resolved, or Claude run superseded) can no longer be
// actioned: restoring it would be a silent no-op. The UI shows a working "To do"
// button only when `restorable`, else a static `reason` chip ("PR merged", …).
interface Restorability {
  restorable: boolean;
  // Why it can't be restored; present only when `restorable` is false.
  reason?: string;
}

export interface DismissedReviewItem extends MyTurnPr, Restorability {
  kind: 'review_request';
  dismissedAt: string;
}

export interface DismissedThreadItem extends ThreadAwaitingItem, Restorability {
  kind: 'thread';
  dismissedAt: string;
}

// A dismissed Claude review (local-only feature). Keyed by the run id; opening it
// jumps to the PR's Claude Review tab, "To do" restores it to the inbox (only if it
// is still that PR's most-recent unposted run).
export interface DismissedClaudeReviewItem extends Restorability {
  kind: 'claude_review';
  reviewId: number;
  prId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  verdict: ClaudeReviewVerdict | null;
  githubUrl: string;
  dismissedAt: string;
}

// A dismissed new-PR entry. Opening it loads the PR; "To do" restores it to the inbox (only
// if the PR is still open and its repo is still on the account).
export interface DismissedWatchedRepoPrItem extends MyTurnPr, Restorability {
  kind: 'watched_repo_pr';
  dismissedAt: string;
}

// A dismissed "your PR was approved" entry. Opening it loads the PR; "To do" restores
// it (only while the PR is still open and approved).
export interface DismissedApprovedPrItem extends MyTurnPr, Restorability {
  kind: 'pr_approved';
  dismissedAt: string;
}

export type DismissedItem =
  | DismissedReviewItem
  | DismissedThreadItem
  | DismissedWatchedRepoPrItem
  | DismissedApprovedPrItem
  | DismissedClaudeReviewItem;

export interface DismissedMyTurnResponse {
  items: DismissedItem[];
  // Users referenced by any item, for client-side lookup.
  users: User[];
}

// ---- my turn: activity Feed (the account's repos, last 14 days) ----
// One activity entry in the Feed. A denormalized, render-ready view of
// an `events` row (commit pushes excluded) — the frontend mirrors these into an
// append-only IndexedDB store. `id` is the stable `events.id`, used to dedupe on
// merge. Excludes `commit_pushed`; includes `pr_ready_for_review` / `pr_reopened`.
export interface FeedEvent {
  id: number;
  type: EventType;
  occurredAt: string;
  repoId: number;
  repoFullName: string;
  prId: number | null;
  prNumber: number | null;
  prTitle: string | null;
  prState: PrState | null;
  actorId: number | null;
  // The underlying entity row id (for the timeline "Show" deep link).
  refId: number | null;
  // review_submitted → the verdict (approved / changes_requested / …); else null.
  reviewState: ReviewState | null;
  // review_comment / pr_comment → a short preview of the comment; else null.
  // (Kept for the legacy IndexedDB activity mirror.)
  excerpt: string | null;
  // Full markdown body for text events (review_comment / pr_comment /
  // review_submitted); null for non-text events. Null on rows synced lean before
  // full-body persistence — the consumer falls back to `excerpt`.
  content: string | null;
}

export interface FeedResponse {
  events: FeedEvent[];
  // Actors referenced by any entry, for client-side login/avatar lookup.
  users: User[];
}

// ---- request payloads ----

// Adding a repo is the WHOLE decision — there is no second per-repo visibility axis to set
// alongside it. An added repo is fully live in its workspace (Feed, Activity, My Turn, Bots),
// so the old `watch?: boolean` is gone rather than defaulted.
export interface CreateRepoBody {
  owner: string;
  name: string;
}

// ---- repo search (Add-repo picker) ----

// A single GitHub repository-search hit, shaped for the Add-repo picker. Sourced
// live from the GitHub GraphQL search API (never persisted) — only the fields the
// picker renders. `isOwnedOrMember` floats repos you own or are an org member of
// to the top of the result list.
export interface RepoSearchResult {
  githubNodeId: string;
  owner: string;
  name: string;
  fullName: string; // "owner/name"
  description: string | null;
  ownerAvatarUrl: string | null;
  stargazerCount: number;
  openPrCount: number;
  url: string;
  isPrivate: boolean;
  isOwnedOrMember: boolean;
}

// One page of repo-search results. `cursor` feeds the next page's request when
// `hasNextPage` is true (GitHub's opaque endCursor); null when exhausted.
export interface RepoSearchResponse {
  results: RepoSearchResult[];
  hasNextPage: boolean;
  cursor: string | null;
}

// The viewer's recently-active repositories, detected from their GitHub activity (recent
// pushes + contributions), for the first-run onboarding "add what you're working on"
// picker. Already-added repos are filtered out; results are ordered most-recently-pushed
// first. Sourced live from GitHub — never persisted. Reuses RepoSearchResult so the picker
// rows render identically. Local sees whatever the `gh` token sees (private + org repos);
// cloud sees whatever the OAuth/App token can read.
export interface SuggestedReposResponse {
  results: RepoSearchResult[];
}

export interface RepoSearchQuery {
  q: string;
  cursor?: string;
  limit?: number;
}

// ---- cross-repo text search (CORE, no AI; served by /api/search) ----
// A full-text search over the LOCAL search_index (PR titles + descriptions, review bodies,
// review-comments, PR-comments, and authors) across the caller's workspace-scoped repos. Case-
// insensitive substring match, so you can "pinpoint where certain text exists". A review-comment
// hit carries its `threadId` so the UI deep-links straight to the thread.
export type SearchHitKind = 'pr' | 'review' | 'review_comment' | 'pr_comment';

export interface SearchHit {
  kind: SearchHitKind;
  prId: number;
  prNumber: number;
  prTitle: string;
  prState: PrState;
  repoId: number;
  repoFullName: string; // "owner/name"
  // The matched entity's id within its kind (review / review-comment / PR-comment id; = prId for a
  // 'pr' hit) — the in-app anchor for the result.
  refId: number;
  // For a review_comment hit: the owning review thread's id, so the result opens the PR's Threads
  // tab scrolled to that thread. Null for the other kinds.
  threadId: number | null;
  authorId: number | null;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  snippet: string; // a short excerpt of the matched text, centred on the first matched term
  createdAt: string; // ISO-8601
}

// A person whose login / display name matches the query and who has authored indexed activity in
// the searched scope — the "People" facet of a search ("find alice's work").
export interface SearchPerson {
  id: number;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  matchCount: number; // indexed items in scope this person authored
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  people: SearchPerson[];
  total: number; // total hits matching the query in scope (drives pagination)
}

export interface MarkViewedBody {
  sha?: string;
}

// POST /api/prs/:id/refresh — live PR-detail freshness. The SPA polls this every ~5s while
// a PR pane is open and visible (probe-gated server-side: a quiet tick is one free
// conditional REST 304), and the PrDetail header's manual Refresh button sends {wait:true}.
export interface PrRefreshBody {
  // true = the manual button: unconditionally bust the server's hydration cache and queue
  // behind any in-flight sync (the post-write-resync composition) so the click's answer is
  // a read of GitHub AFTER now. Absent/false = the poll, which may honestly do nothing.
  wait?: boolean;
}

export interface PrRefreshResponse {
  // The stored PR reflects GitHub as of this request. false = the refresh could not run
  // (no token / network / GitHub failure / a concurrent sync raced us) — the stored data
  // is still perfectly renderable, just possibly stale; NEVER an error state.
  synced: boolean;
  // Something MAY have changed: the PR's updatedAt moved, or a forced full walk refreshed
  // the hydration-only detail (checkRuns are blind to updatedAt). The client invalidates
  // its caches ONLY when true — an unchanged tick must not churn the timeline.
  changed: boolean;
  updatedAt: string; // ISO-8601, the row's updatedAt after the refresh
}

// Dismissing a "my turn" entry. Auto-resurfaces when newer activity arrives:
// a review_request reappears when its PR is updated again; a thread reappears
// on a newer reply; a claude_review reappears when a newer review run finishes
// (the dismissal is keyed by the run's id, so a fresh run is a new entry); a
// pr_approved reappears when a NEWER approval lands (compared against the latest
// approving review's timestamp — not the PR's updatedAt, which any commit bumps).
// A watched_repo_pr dismissal is sticky — it acknowledges that specific new PR and
// does not resurface on activity (the PR leaves the inbox for good once dismissed,
// or when it's merged/closed).
export type MyTurnDismissKind =
  | 'review_request'
  | 'thread'
  | 'watched_repo_pr'
  | 'pr_approved'
  | 'claude_review';

export interface MyTurnDismissBody {
  kind: MyTurnDismissKind;
  // PR id for review_request, watched_repo_pr and pr_approved; thread id for thread;
  // Claude-review run id for claude_review.
  refId: number;
}

// WHY an item is on your plate — the six sections of GET /api/my-turn, one value each, carried by
// `MyTurnCard.reason`. Five of them ARE `MyTurnDismissKind` verbatim (the section is dismissable,
// and the value is what POST /api/my-turn/dismiss takes). `'your_pr'` is the sixth — "your PRs
// with new activity since you last looked" — and it deliberately has NO dismissal kind: opening
// the PR is its dismissal (the pr_views marker), so there is no row to write and nothing to restore.
//
// ⚠ NOT `MyTurnReason`, which is a DIFFERENT, older union ('requested' | 'authored' | 'merged' |
// 'reviewed' | 'commented'): that one says how you PARTICIPATE in a feed row, this one says which
// My Turn SECTION an item came from. They are one `sed` away from each other and mean opposite
// things — the `-Card-` infix is load-bearing.
export type MyTurnCardReason = MyTurnDismissKind | 'your_pr';

export interface UpdateUserBody {
  isBot: boolean;
}

export interface TimelineQuery {
  from?: string;
  to?: string;
  repoIds?: string; // comma-separated
  // comma-separated PR ids. When present (non-empty), returns EXACTLY those PRs + all their
  // events, bypassing every other filter — a pr-focus tab uses this so its subject PR loads
  // regardless of the board's repo/date/status filters. Account-scoped server-side.
  prIds?: string;
  userIds?: string; // comma-separated
  types?: string; // comma-separated EventType
  // comma-separated PrStatus. Absent = no status filter (all). Present (even
  // empty) = explicit set; an empty value shows nothing.
  statuses?: string;
  // comma-separated ReviewState (approved/changes_requested/commented/dismissed) —
  // filters review_submitted events by verdict. Absent = no filter (all verdicts);
  // present (even empty) = explicit set, an empty value showing no review markers.
  // Only affects review_submitted events; other event types are untouched.
  reviewStates?: string;
  excludeBots?: string; // "true" | "false"
  // comma-separated user ids of bots to KEEP visible even when excludeBots is on — the
  // per-repo "allowed bots" override (some bots are important to always see). Ignored
  // when excludeBots is false. Absent = no allow-list (exclude every bot).
  allowBotIds?: string;
  // "true" → drop "stale" open PRs: open PRs with no commit / comment / review
  // event inside [from, to]. They (and their events) are removed so the row can
  // disappear entirely. Absent/"false" = keep them.
  excludeStale?: string;
}

// ---- Claude Review (agentic PR review) ----
// The app's first agentic feature: an in-app Claude Agent SDK run that reviews a
// PR and returns structured findings. Claude's output is read-only reference; the
// user authors their own review body/verdict and ticks which findings to post.

export type ClaudeReviewModel =
  | 'claude-sonnet-5'
  | 'claude-opus-4-8'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5';

// Runtime list for the model picker (frontend bundles shared; the backend keeps a
// local copy and only `import type`s from here — shared isn't shipped at runtime).
// Ordered by recommendation (the DEFAULT first): Sonnet 5 is near-Opus quality at
// Sonnet cost — the best-value default; Opus 4.8 stays for the hardest runs; Sonnet
// 4.6 for continuity; Haiku 4.5 is the cheap fast option — ideal for a quick pass on
// a small/bounded diff; it does not accept the `effort` knob, so it runs at the
// model's own default thinking depth.
export const CLAUDE_REVIEW_MODELS: ClaudeReviewModel[] = [
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

// Friendly labels (with a short cost/quality hint) for the model picker.
export const CLAUDE_REVIEW_MODEL_LABELS: Record<ClaudeReviewModel, string> = {
  'claude-sonnet-5': 'Claude Sonnet 5 (best value)',
  'claude-opus-4-8': 'Claude Opus 4.8 (most thorough)',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-haiku-4-5': 'Claude Haiku 4.5 (fast, cheap)',
};

export type ClaudeReviewStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type ClaudeReviewScope = 'diff_only' | 'worktree';

// The RESOLVED review mode a run actually used, chosen by the deterministic router
// (or forced by the user) BEFORE the agent runs:
//  - 'skip'       — the diff is entirely noise (generated/vendored/lockfile/binary);
//                   nothing substantive to review, so no agent runs.
//  - 'diff_only'  — small/localized change; reviewed from the diff alone, tool-less,
//                   with NO cloned worktree (fast, fixed turn count).
//  - 'worktree'   — large/cross-cutting/contract-changing; reviewed with the full
//                   cloned worktree as explorable context (the original behaviour).
export type ReviewMode = 'skip' | 'diff_only' | 'worktree';

// What the user asked for when starting a run. 'auto' lets the router decide (and is
// the only path that can resolve to 'skip'); 'diff_only'/'worktree' force that mode,
// overriding the router's metrics.
export type RequestedReviewMode = 'auto' | 'diff_only' | 'worktree';

// Runtime list for the depth picker (frontend bundles shared; the backend keeps a
// local copy and only `import type`s from here — shared isn't shipped at runtime).
export const REQUESTED_REVIEW_MODES: RequestedReviewMode[] = [
  'auto',
  'diff_only',
  'worktree',
];

// The deterministic routing decision's inputs + outcome, recorded on every run so
// the thresholds can be calibrated (and the choice audited) after the fact. All
// metrics are computed over the noise-stripped diff's non-noise files.
export interface ReviewRouteReason {
  // What the user asked for ('auto' = let the router decide).
  requested: RequestedReviewMode;
  // Who actually chose the resolved mode.
  decidedBy: 'router' | 'user';
  // Number of (non-noise) files changed.
  changedFiles: number;
  // Total added + deleted lines across those files.
  linesChanged: number;
  // Distinct directories touched.
  dirsTouched: number;
  // Distinct top-level path segments (subsystems) touched.
  subsystems: number;
  // A modified/removed exported-or-public symbol, or a changed IDL/schema/route path
  // — the load-bearing "needs broad context" signal.
  apiTouch: boolean;
  // Fraction of changed lines that delete existing code (deletions / linesChanged);
  // computed + logged for calibration, not yet a gate input.
  modifyingFraction: number;
  // Every changed file is a brand-new file (purely additive). Logged for calibration.
  allFilesNew: boolean;
  // The first gate ceiling that forced 'worktree' (e.g. 'files', 'lines', 'dirs',
  // 'subsystems', 'apiTouch'); null when the run stayed diff_only / skip / was forced.
  trippedBy: string | null;
}

export type ClaudeReviewVerdict = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';

export type ClaudeFindingSeverity =
  | 'blocker'
  | 'warning'
  | 'nit'
  | 'question'
  | 'praise';

export type ClaudeFindingSide = 'LEFT' | 'RIGHT';

// One line-level finding from a review run. Claude's wording (title/body/
// suggestion) is read-only; only `included` (the user's tick) is mutable.
export interface ClaudeFinding {
  id: number;
  reviewId: number;
  path: string;
  // null ⇒ no line anchor (file-level / unanchored).
  line: number | null;
  side: ClaudeFindingSide;
  // SHA-256 of `path` (hex) — GitHub's PR "Files changed" diff anchor, so the
  // code ref can deep-link into the PR diff at this file/line.
  diffAnchorId: string;
  severity: ClaudeFindingSeverity;
  title: string;
  body: string;
  // The user's reworded version (markdown). When set and the finding is
  // included, this posts instead of `body`. null ⇒ use Claude's wording.
  editedBody: string | null;
  suggestion: string | null;
  // The unified-diff hunk this finding covers, for showing the code in context.
  // null for older runs / unanchored findings.
  diffHunk: string | null;
  // false ⇒ couldn't map onto an addable diff line → can't post on its own line.
  anchored: boolean;
  // Whether the finding's file is part of the PR's diff. true ⇒ an unanchored
  // finding posts inline on the file's first change; false ⇒ the file is outside the
  // PR's diff (e.g. a deep review on an unchanged file) so it posts as a standalone
  // PR-level comment. (Anchored findings are always fileInDiff.)
  fileInDiff: boolean;
  // The user ticked this finding to post it as an inline comment.
  included: boolean;
  postedAt: string | null;
  githubCommentId: string | null;
  // How a posted comment was attached: 'inline' (a review comment on a diff line)
  // or 'pr_comment' (a standalone PR-level issue comment, for an unanchored finding
  // posted individually). null until posted; drives the GitHub permalink scheme
  // (#discussion_r vs #issuecomment).
  postedCommentKind: 'inline' | 'pr_comment' | null;
  createdAt: string;
}

// One review run (re-review = a new run; history kept, keyed by head SHA).
export interface ClaudeReview {
  id: number;
  prId: number;
  headSha: string;
  status: ClaudeReviewStatus;
  model: ClaudeReviewModel;
  scope: ClaudeReviewScope | null;
  // The deterministic routing decision: the mode this run actually used, and the
  // metrics behind it. Null on pre-routing rows (older runs / not yet decided).
  // `scope` above is the AGENT's self-report; a run with reviewMode 'diff_only' but
  // scope 'worktree' is the agent flagging that a deeper review was warranted.
  reviewMode: ReviewMode | null;
  routeReason: ReviewRouteReason | null;
  // Claude's output (read-only reference).
  summary: string | null;
  verdict: ClaudeReviewVerdict | null;
  // The user-authored review that actually gets posted.
  userBody: string | null;
  userVerdict: ClaudeReviewVerdict | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  // Cache-token split — on a multi-turn run the input is mostly cache reads, the
  // dominant cost the plain inputTokens figure hid. Null on older/uncaptured runs.
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  numTurns: number | null;
  // Full noise-stripped diff size (chars) + whether the diff-size cap truncated the
  // prompt — for cost-comparing capped vs uncapped runs. Null on older runs.
  diffBytes: number | null;
  diffCapped: boolean | null;
  error: string | null;
  excludedFiles: string[];
  postedReviewId: string | null;
  postedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  findings: ClaudeFinding[];
}

// A lighter run row for the history selector (no findings).
export interface ClaudeReviewSummary {
  id: number;
  headSha: string;
  status: ClaudeReviewStatus;
  model: ClaudeReviewModel;
  scope: ClaudeReviewScope | null;
  reviewMode: ReviewMode | null;
  verdict: ClaudeReviewVerdict | null;
  userVerdict: ClaudeReviewVerdict | null;
  costUsd: number | null;
  postedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

// One entry in the cross-PR "prior Claude reviews" list (GET /api/claude-reviews):
// a PR's most-recent SUCCEEDED review, enriched with its PR/repo coordinates so
// the list can render and deep-link without a second fetch.
export interface ClaudeReviewListItem {
  reviewId: number;
  prId: number;
  repoFullName: string; // `${owner}/${name}`
  prNumber: number;
  prTitle: string;
  prState: PrState;
  // Claude's high-level summary (read-only).
  summary: string | null;
  verdict: ClaudeReviewVerdict | null;
  headSha: string;
  status: ClaudeReviewStatus;
  createdAt: string; // ISO-8601
  finishedAt: string | null; // ISO-8601 — "last run" time
}

export interface ClaudeReviewListResponse {
  reviews: ClaudeReviewListItem[];
}

export type ClaudeAuthStatus = 'ok' | 'none';

export interface ClaudeReviewResponse {
  // Whether the feature is enabled at all (ENABLE_CLAUDE_REVIEW).
  enabled: boolean;
  // Claude-auth availability for running a review.
  auth: ClaudeAuthStatus;
  authMessage?: string;
  // ⚠ NO `hasUserKey`. The STORED Anthropic key is RETIRED: the SPA form is gone, the routes are
  // gone, and nothing reads `~/.pierre-review/config.json`'s `anthropicApiKey` any more. Local
  // Claude Review now has exactly TWO credential rungs — an ambient Claude session (preferred, so
  // a subscription pays) and the environment's `ANTHROPIC_API_KEY` — both of which `auth` already
  // reports. A field saying "a key is stored" would have described a value that no longer changes
  // any run's behaviour.
  // The per-review USD budget cap a run will use (the user's local override, or the
  // operator default when unset) and the hard ceiling the user can set it to. Local
  // mode only; meaningless (and ignored) in cloud.
  reviewBudgetUsd: number;
  reviewBudgetMax: number;
  // The latest run for the PR (with findings), or null if never run.
  review: ClaudeReview | null;
  // All prior runs for the PR (newest first), lighter shape.
  history: ClaudeReviewSummary[];
}

// ⚠ `SetClaudeKeyBody` / `ClaudeKeyResponse` / `ClaudeKeyStatusResponse` ARE DELETED, along with
// `GET`/`PUT /api/claude-review/key`. The BYO Anthropic key that lived in
// `~/.pierre-review/config.json` is retired: local Claude Review resolves credentials from an
// ambient Claude session first (so a subscription pays) and otherwise leaves the environment's
// `ANTHROPIC_API_KEY` in place — two rungs, no stored secret, no form. Cloud never used any of
// this (it runs on `SUMMARY_ANTHROPIC_API_KEY` and the section never rendered there).
//
// An already-stored `anthropicApiKey` is left on disk untouched and simply never read: the
// decision was to stop reading it, not to destroy somebody's file. Do not re-add a route "just to
// clear it" — that is a write path back.

// Set (a positive number, clamped server-side to the max) or clear (null → operator
// default) the local per-review budget cap.
export interface SetReviewBudgetBody {
  usd: number | null;
}

export interface ReviewBudgetResponse {
  reviewBudgetUsd: number;
}

export type ClaudeReviewPhase =
  | 'cloning'
  | 'fetching_diff'
  | 'deciding'
  | 'reviewing'
  | 'persisting';

export interface ClaudeReviewProgress {
  phase: ClaudeReviewPhase;
  message?: string;
  // A newest-last rolling log of short, human-readable lines describing what the
  // agent is doing right now (tool calls, brief text snippets). Live progress
  // only — NOT persisted to the DB; rides the /status poll while running.
  recentActivity?: string[];
  // The resolved review mode, set once the router has decided (and carried through
  // the rest of the run), so the UI can show the depth while the review runs.
  reviewMode?: ReviewMode;
  // Live, cumulative token usage + a running cost ESTIMATE (from a per-model price
  // table — the persisted run uses the SDK's authoritative cost). Present once the
  // agent has produced at least one turn. Live-only; not persisted.
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estCostUsd: number;
  };
}

export interface ClaudeReviewStatusResponse {
  status: ClaudeReviewStatus | 'idle';
  reviewId: number | null;
  progress: ClaudeReviewProgress | null;
}

// Server-Sent-Events payload streamed by GET /api/prs/:id/claude-review/stream.
// A `snapshot` is sent once on connect (the current state), `progress` on every
// phase/activity/usage change while the run is live, and a single terminal `done`
// (carrying the persisted final status) right before the stream closes. This is
// the real-time replacement for polling the /status endpoint.
export type ClaudeReviewStreamEvent =
  | {
      type: 'snapshot' | 'progress';
      status: ClaudeReviewStatus | 'idle';
      reviewId: number | null;
      progress: ClaudeReviewProgress | null;
    }
  | { type: 'done'; status: ClaudeReviewStatus | 'idle'; reviewId: number | null };

// A finding whose file isn't part of the PR's diff (e.g. a deep review flagging an
// unchanged file). It can't anchor to a diff line, so it posts as a standalone
// PR-level (issue) comment, marked as outside the PR's diff.
export interface PostReviewPrComment {
  findingId: number;
  path: string;
  body: string;
}

// The exact GitHub review payload — returned verbatim by the dry-run preview and
// used as the body of the real POST.
export interface PostReviewComment {
  path: string;
  line: number;
  side: ClaudeFindingSide;
  body: string;
}

export interface PostReviewPreview {
  commitId: string;
  body: string;
  event: ClaudeReviewVerdict;
  comments: PostReviewComment[];
  // Findings whose file isn't in the PR diff — posted as standalone PR-level
  // comments alongside the review (not dropped).
  prComments: PostReviewPrComment[];
}

export interface PostReviewResult {
  postedReviewId: string | null;
  postedAt: string;
  postedCommentCount: number;
  // Number of findings posted as standalone PR-level comments (file outside the diff).
  prCommentCount: number;
}

// Result of posting a single finding as a standalone inline comment (not a review).
export interface PostCommentResult {
  githubCommentId: string | null;
  postedAt: string;
}

// ---- request payloads (Claude review) ----

export interface GenerateReviewBody {
  model: ClaudeReviewModel;
  // Review depth. Omitted / 'auto' lets the deterministic router decide; an explicit
  // 'diff_only' or 'worktree' forces that mode, overriding the router's metrics.
  mode?: RequestedReviewMode;
}

// Saves the user's authored draft; never mutates Claude's summary/verdict.
export interface UpdateReviewBody {
  userBody?: string;
  userVerdict?: ClaudeReviewVerdict;
}

// Tick a finding for inline posting and/or save the user's reworded body. An
// empty-string editedBody clears the reword (reverts to Claude's wording).
export interface UpdateFindingBody {
  included?: boolean;
  editedBody?: string;
}


// A review currently in flight, for the global progress banner. Surfaced from the
// review manager's in-memory state joined with the PR's coordinates.
export interface ActiveReview {
  reviewId: number;
  prId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  status: ClaudeReviewStatus;
  phase: ClaudeReviewPhase | null;
}

export interface ActiveReviewsResponse {
  reviews: ActiveReview[];
}

export interface PostReviewBody {
  userVerdict: ClaudeReviewVerdict;
}

// ---- AI Fix (Pro: PR summary + CI failure analysis + agentic inline fix) ----
// A Pro-only suite (packages/pro/ai-fix). Two cheap read-only tools (PR summary, CI
// failure analysis via Haiku) plus an Agent-SDK run that MODIFIES files in a cloned
// worktree, captures a unified-diff patch, and — with repo write access — pushes to
// the PR's head branch or a new branch (opening a PR). All wire types mirror the
// Claude Review shapes above; the backend keeps local `import type`s (shared isn't
// shipped at runtime).

// The fixer reuses the Claude Review model set.
export type AiFixModel = ClaudeReviewModel;

// ---- read-only analyses (aiAnalysis capability) ----

export interface PrSummaryResponse {
  enabled: boolean;
  // The generated overview (markdown), or null if never generated.
  summary: string | null;
  model: string | null;
  // The head SHA the summary was generated against; lets the UI flag staleness.
  headSha: string | null;
  generatedAt: string | null;
  // Metered (paid cloud) plan out of credits: generation is refused and the last summary is
  // served unchanged. Absent (undefined) for unmetered/local accounts. Drives the disabled
  // Generate button + "out of credits" note (mirrors the digest/sprint report).
  creditsExhausted?: boolean;
}

// An honesty score: how confident the analysis is (in the root cause, and in whether
// Pierre's agentic fixer could actually fix it). Drives how much the report elaborates.
export type AiConfidence = 'high' | 'medium' | 'low';

export interface CiAnalysisResponse {
  enabled: boolean;
  // The root-cause + potential-fixes report (markdown), or null if never generated.
  analysis: string | null;
  model: string | null;
  headSha: string | null;
  generatedAt: string | null;
  // Whether the PR currently has failing CI (drives whether the tool is offered).
  hasFailures: boolean;
  // How sure the analysis is about the root cause.
  rootCauseConfidence: AiConfidence | null;
  // How likely Pierre's agentic fixer (edit repo files + push) could fix it, given the
  // available context. Low for external/quality-gate/unknown causes.
  fixability: AiConfidence | null;
  // Metered (paid cloud) plan out of credits: generation is refused and the last stored
  // analysis is served unchanged. REQUIRED (unlike PrSummaryResponse's optional twin) because
  // the CI-analysis tier move makes this a routine state rather than an edge case — a caller
  // that forgets it renders an enabled Generate button that always 402s.
  creditsExhausted: boolean;
}

// One failing check the client asks the analyzer to consider. `jobId` is the GitHub
// Actions job id (null for external checks like SonarCloud, which carry no Actions
// log). Passing the NAME too lets the analyzer reason about failing checks it can't
// fetch logs for (a code-analysis gate) instead of treating them as "no output".
export interface FailingCheckInput {
  name: string;
  jobId: number | null;
  state: string;
}

// Body for POST …/ci-analysis — the full set of failing checks from the client
// (pr.checkRuns), since the checkRuns JSON is lean-gated in the DB.
export interface GenerateCiAnalysisBody {
  checks: FailingCheckInput[];
}

// ---- the agentic fixer (aiFix capability) ----

export type AiFixStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

// What seeded the fix prompt: the stored CI analysis, the latest Claude review, a
// user-picked set of the PR's own review comments, or a plain request (summary/description
// only).
export type AiFixSeed = 'ci_analysis' | 'review' | 'plain' | 'comments';

// ---- comment-seeded fixes ("fix from comments") ----

// Which of the PR's comment id spaces a target lives in. The three are DISTINCT id
// spaces (review_comments / pr_comments / reviews), exactly as ml_comment_labels keys
// them — so a bare id is ambiguous and every target carries its kind.
export type AiFixCommentKind = 'review_comment' | 'pr_comment' | 'review';

// One comment the user dragged into the fix scope. The client sends only (kind, id); the
// server resolves the body, author, file anchor and code hunk itself — a client-supplied
// body would be an unauthenticated way to put arbitrary text in an agent's prompt.
export interface AiFixCommentTargetRef {
  kind: AiFixCommentKind;
  id: number;
}

// A resolved target as STORED on the run, so the report renders (and stays honest) long
// after the PR detail moved on. `ref` is the stable prompt label ("C1", "C2", …) the agent
// must cite; it is assigned server-side in list order and is what maps a verdict back to
// its comment.
export interface AiFixCommentTarget extends AiFixCommentTargetRef {
  ref: string;
  authorId: number | null;
  authorLogin: string | null;
  isBot: boolean;
  // File anchor (review comments only; null for PR-level comments and review bodies).
  path: string | null;
  line: number | null;
  // The thread this comment belongs to, when it has one — the reply target for a pushback.
  threadId: number | null;
  url: string | null;
  // Short preview for the report card; the full body went to the agent, not the wire.
  excerpt: string;
}

// What the agent concluded about ONE seeded comment. `verdict` is the disposition;
// `pushback` is set only when the agent is DISAGREEING (invalid / out_of_scope / rejected)
// and is the argued rebuttal, ready for the user to send as a reply — nothing posts it
// automatically.
export type AiFixCommentDisposition =
  | 'fixed'
  | 'partially_fixed'
  | 'already_addressed'
  | 'invalid'
  | 'out_of_scope'
  | 'needs_human';

export interface AiFixCommentVerdict {
  // The prompt label the agent cited; matched back to AiFixCommentTarget.ref.
  ref: string;
  // Null when the agent cited a ref that was not in the seed set (kept, not dropped —
  // a fabricated ref is information about the run).
  target: AiFixCommentTarget | null;
  verdict: AiFixCommentDisposition;
  // Whether the agent judged the comment technically correct, independent of whether it
  // fixed anything (a valid comment can still be out of scope).
  //
  // ⚠ THREE-STATE, and `null` is load-bearing: it means NOT ASSESSED — the row was synthesized
  // for a comment the agent never reported on, or one that never fit the prompt at all. A
  // two-state field forced those rows to `false`, which rendered as a positive claim that a
  // reviewer's comment was judged WRONG, sitting directly above prose saying nothing is known
  // about it. On a bot-flooded PR that fired on every skipped comment.
  valid: boolean | null;
  // Why — grounded in the code it read.
  reasoning: string;
  // The argued rebuttal, for a comment the agent is pushing back on. Null otherwise.
  pushback: string | null;
  // A durable takeaway worth remembering about this reviewer/bot's comment, if any.
  learning: string | null;
  // Paths the agent says it edited for this comment. Advisory — the authoritative
  // changeset is still the captured git diff, never the agent's self-report.
  filesTouched: string[];
}

export type AiFixPhase =
  | 'fetching_diff'
  | 'cloning'
  | 'fixing'
  | 'capturing'
  | 'persisting';

export interface AiFixProgress {
  phase: AiFixPhase;
  message?: string;
  // Newest-last rolling log of short lines describing the agent's tool calls / text.
  // Live-only; not persisted.
  recentActivity?: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estCostUsd: number;
  };
}

// Live PR head + fork info, so the UI can gate the branch picker. `canPushSameBranch`
// is false when the head is a fork we can't write to (or the viewer lacks write).
export interface PrHeadInfo {
  headSha: string;
  headRef: string;
  headRepoFullName: string;
  isFork: boolean;
  maintainerCanModify: boolean;
  baseRef: string;
  canPushSameBranch: boolean;
  // Suggested name for a new branch, pre-derived from the head ref (e.g. `${ref}-ai-fix`).
  suggestedBranch: string;
}

// One fix run (history kept; a re-run is a new row).
export interface AiFix {
  id: number;
  prId: number;
  status: AiFixStatus;
  model: string;
  seed: AiFixSeed;
  // Set once the run succeeds:
  summary: string | null;
  commitMessage: string | null;
  // The captured unified-diff patch (includes new files; binary-safe). Null until
  // the run succeeds.
  patch: string | null;
  filesChanged: string[];
  // The base commit the patch applies onto (the live PR head at generate time).
  baseSha: string | null;
  // A stored, reviewable rebase resolution (the fix replayed onto the trunk with
  // conflicts resolved), or null. Only rebase produces this reviewable artifact.
  resolved: AiFixResolved | null;
  // The Claude review this fix was seeded from, if any.
  sourceReviewId: number | null;
  // seed === 'comments' only: the comments the run was given, in the order the prompt
  // listed them, and what the agent concluded about each. Both null on every other seed —
  // and `commentVerdicts` is null (not []) on a comments run whose agent reported nothing,
  // which is a different fact from "it reported an empty list".
  commentTargets: AiFixCommentTarget[] | null;
  commentVerdicts: AiFixCommentVerdict[] | null;
  costUsd: number | null;
  numTurns: number | null;
  error: string | null;
  // Set once pushed:
  pushedBranch: string | null;
  pushedPrNumber: number | null;
  pushedPrUrl: string | null;
  pushedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

// A lighter shape for the run history list — enough to show every fix Pierre made
// for a PR with its commit message + where it landed (branch / PR / when).
export interface AiFixSummary {
  id: number;
  status: AiFixStatus;
  model: string;
  seed: AiFixSeed;
  commitMessage: string | null;
  filesChanged: string[];
  pushedBranch: string | null;
  pushedPrNumber: number | null;
  pushedPrUrl: string | null;
  pushedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AiFixResponse {
  enabled: boolean;
  auth: ClaudeAuthStatus;
  authMessage?: string;
  // Whether the viewer may push (mirrors PrDetail.viewerCanPush; also re-checked
  // server-side on push).
  viewerCanPush: boolean;
  // Live head/fork info for the branch picker (null when it can't be fetched).
  headInfo: PrHeadInfo | null;
  // The latest run, or null if never run.
  fix: AiFix | null;
  history: AiFixSummary[];
}

export interface AiFixStatusResponse {
  status: AiFixStatus | 'idle';
  fixId: number | null;
  progress: AiFixProgress | null;
}

export type AiFixStreamEvent =
  | {
      type: 'snapshot' | 'progress';
      status: AiFixStatus | 'idle';
      fixId: number | null;
      progress: AiFixProgress | null;
    }
  | { type: 'done'; status: AiFixStatus | 'idle'; fixId: number | null };

// Start a fix run.
export interface GenerateFixBody {
  model: AiFixModel;
  seed?: AiFixSeed;
  // When seed === 'review', the review text to seed the prompt with.
  reviewText?: string;
  // When seed === 'comments', the comments to work through — (kind, id) pairs only. The
  // server resolves each one against THIS PR's rows and silently drops anything that
  // doesn't belong to it, so a forged id is inert rather than an error. Capped
  // (AI_FIX_MAX_COMMENT_TARGETS) because every target costs prompt budget.
  commentTargets?: AiFixCommentTargetRef[];
}

// How many comments one comments-seeded run will accept. A 60-thread bot-flooded PR is this app's
// normal workload, and the whole set would blow the prompt budget the reference diff also has to
// fit in — so the UI surfaces this cap rather than letting the server truncate a bigger basket.
//
// ⚠ The GUARANTEE is narrower than "25 always fit", and saying otherwise was a real bug: the
// server renders each comment with its body and anchor hunk under its own char budget, and a
// basket of 25 unusually LONG comments still loses a tail (reported per comment as "did not fit
// the prompt budget", never silently). The budgets are sized so that a realistically-sized 25 fits;
// they live in `packages/pro/src/ai-fix/comment-seed.ts` (SEED_CHAR_BUDGET) and `prompts.ts`
// (FIX_COMMENTS_DIFF_BUDGET) and are ONE decision with this number — change none of the three
// without re-measuring the other two.
export const AI_FIX_MAX_COMMENT_TARGETS = 25;

// Push a completed fix. `target` is which branch to push onto; a 'new' branch also
// opens a PR against the base branch.
export interface AiFixPushBody {
  target: 'existing' | 'new';
  // Required when target === 'new' — the branch name to create.
  branch?: string;
  // How to reconcile with the trunk before pushing. 'plain' (default) pushes the
  // fix as-is (never force-pushes; may leave the PR conflicted). 'merge' merges the
  // trunk in as a merge commit (never force-pushes). 'rebase' pushes the previously
  // resolved+reviewed rebase artifact (force-with-lease on the existing branch).
  strategy?: AiFixPushStrategy;
  // For 'merge': let Claude resolve any conflicts as part of the push job.
  autoResolve?: boolean;
  // Model for the conflict-resolution agent (defaults like the fixer).
  model?: AiFixModel;
}

export interface AiFixPushResult {
  pushedBranch: string;
  commitSha: string;
  // Set when target === 'new' (a PR was opened).
  prNumber?: number;
  prUrl?: string;
  strategy: AiFixPushStrategy;
  // Whether any conflict resolution happened during this push.
  resolvedConflicts: boolean;
  // Whether the push rewrote history (force-with-lease). Only ever true for a rebase
  // onto the PR's own existing branch.
  forcePushed: boolean;
}

// ---- trunk-conflict handling (rebase / merge before push) ----

export type AiFixPushStrategy = 'plain' | 'merge' | 'rebase';

// The state of the fix branch (baseSha + patch) relative to the PR's trunk (its base
// branch), computed by a local trial merge before offering resolution options.
export interface AiFixMergePreview {
  // True when the tool is available (aiFix on + a stored, pushable fix).
  available: boolean;
  trunk: string; // the base branch name compared against
  trunkSha: string | null; // its current tip (null if the fetch failed)
  behindBy: number; // commits on trunk not in the fix branch
  aheadBy: number; // commits on the fix branch not in trunk
  clean: boolean; // merges cleanly (no conflicts)
  conflictFiles: string[];
}

// Progress phases for the async resolve / merge / push jobs. Shared with the fixer's
// CodingProgress on the backend; a superset covering both.
export type AiFixResolvePhase =
  | 'cloning'
  | 'applying_fix'
  | 'fetching_trunk'
  | 'rebasing'
  | 'merging'
  | 'resolving_conflicts'
  | 'verifying'
  | 'pushing';

export interface AiFixResolveProgress {
  phase: AiFixResolvePhase;
  message?: string;
  // Newest-last rolling log of the resolver agent's tool calls / text (live-only).
  recentActivity?: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estCostUsd: number;
  };
}

export interface AiFixResolveStatusResponse {
  status: AiFixStatus | 'idle';
  fixId: number | null;
  progress: AiFixResolveProgress | null;
  // Set on a terminal failure (e.g. unresolved conflicts).
  error?: string | null;
}

export type AiFixResolveStreamEvent =
  | {
      type: 'snapshot' | 'progress';
      status: AiFixStatus | 'idle';
      fixId: number | null;
      progress: AiFixResolveProgress | null;
    }
  | {
      type: 'done';
      status: AiFixStatus | 'idle';
      fixId: number | null;
      error?: string | null;
    };

// The stored, reviewable result of a rebase resolution (the fix replayed onto the
// trunk with conflicts resolved). The `git am` mbox that reproduces it is kept
// server-side; the client sees only the reviewable unified diff + metadata.
export interface AiFixResolved {
  strategy: AiFixPushStrategy; // 'rebase' — the only strategy with a reviewable artifact
  diff: string; // unified `git diff <trunk>..HEAD` for FileDiffView
  filesChanged: string[];
  conflictFiles: string[]; // files whose conflicts Claude resolved
  resolvedConflicts: boolean; // whether any conflict resolution happened
  trunk: string;
  trunkSha: string;
  at: string; // ISO timestamp
}

// Start a rebase-resolve job (rebase the fix onto the trunk, agentically resolving
// conflicts, and store a reviewable artifact — no push yet).
export interface AiFixRebaseBody {
  autoResolve?: boolean;
  model?: AiFixModel;
}

// ---- PR write actions (review threads, comments, approve, inline review comments) ----
// Standard product features (not feature-gated, not cloud-disabled) for acting on a
// PR directly from the dashboard. Each maps to a per-account GitHub mutation; the
// optimistic local stamp keeps the UI in sync until the next sync.

// ---- request payloads ----

// Reply to an existing review thread (GraphQL addPullRequestReviewThreadReply).
export interface ReplyToThreadBody {
  body: string;
}

// Resolve (true) or unresolve (false) a review thread.
export interface ResolveThreadBody {
  resolved: boolean;
}

// Bulk-resolve review-bot threads that a later commit has likely addressed — Pierre's
// "clear the bot backlog in one click." The client sends the explicit reviewed list of
// thread ids (never automatic); the server re-validates each belongs to the PR/account,
// is bot-originated AND in state `likely_addressed`, then resolves it on GitHub.
export interface ResolveBotThreadsBody {
  threadIds: number[];
}

export interface ResolveBotThreadsResult {
  resolved: number; // threads successfully resolved on GitHub
  failed: number; // threads that errored or were rejected by the server guardrail
  results: {
    threadId: number;
    ok: boolean;
    derivedState: DerivedState | null; // the new stored state (null on failure)
  }[];
}

// Post a new issue-level (PR) comment.
export interface CreatePrCommentBody {
  body: string;
}

// Approve the PR. Only allowed when the viewer has write+ permission and isn't the
// author (the server re-checks). An optional body accompanies the approval.
export interface ApprovePrBody {
  body?: string;
}

// Add ONE inline review comment, posted immediately as a standalone comment.
export interface AddReviewCommentBody {
  path: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  body: string;
}

// ---- result types ----

// Reply result: the newly-created review comment, in the standard detail shape.
export type ReplyResult = CommentDetail;

export interface ResolveThreadResult {
  threadId: number;
  isResolved: boolean;
  derivedState: DerivedState;
}

// New PR comment result: the standard issue-comment detail shape.
export type CreatePrCommentResult = PrCommentDetail;

// Approve result: the submitted review, in the standard review detail shape.
export type ApprovePrResult = ReviewDetail;

export interface AddReviewCommentResult {
  commentId: number | null;
  url: string | null;
  line: number;
  side: 'LEFT' | 'RIGHT';
  // false ⇒ GitHub re-anchored the comment to a different line (the requested
  // (path, line, side) didn't land on an addable diff line).
  anchored: boolean;
  // ---- immediate-visibility contract ----
  // This is the ONE GitHub write in the app with no optimistic local stamp: REST's
  // POST /pulls/:n/comments returns the comment's own ids but NOT the enclosing review
  // THREAD's node id, and without that a forged local thread row would have no
  // reply/resolve identity. So instead of an echo, the route re-reads the PR through the
  // idempotent targeted-sync path and then VERIFIES the comment row exists locally.
  //
  // true  ⇒ the comment is in the local DB; refetching the PR detail is GUARANTEED to
  //         render the new thread, so the UI may SHOW it rather than promise a future sync.
  // false ⇒ when `commentId != null` the comment IS on GitHub, we just couldn't confirm it
  //         here (the resync failed, raced, or the PR has more review threads than one sync
  //         page returns). Copy must claim no more than "it'll appear on the next sync" —
  //         never "it failed", and never invite a retry, which would double-post.
  visible: boolean;
  // Local `reviewThreads.id` the comment landed in, so the Changes tab can scroll to and
  // highlight the new thread. Always null when `visible` is false — there is no row to point at.
  threadId: number | null;
}

// ---- Changes tab: per-file diff patches (GET /api/prs/:id/files) ----

// GitHub's per-file PR diff status (REST `status`), passed through verbatim.
export type PrFileDiffStatus =
  | 'added'
  | 'modified'
  | 'removed'
  | 'renamed'
  | 'changed'
  | 'copied'
  | 'unchanged';

// One changed file with its unified-diff patch, loaded on demand for the Changes
// tab. `patch` is null for binary/too-large files. `githubUrl` deep-links to the
// file's diff in the PR's "Files changed" view; `blobUrl` links to the file blob.
export interface PrFileDiff {
  path: string;
  previousPath?: string | null;
  status: PrFileDiffStatus;
  additions: number;
  deletions: number;
  patch: string | null;
  githubUrl: string;
  blobUrl: string;
}

export interface PrFilesResponse {
  files: PrFileDiff[];
  // true ⇒ the PR has more files than the server's fetch cap; not all are listed.
  truncated: boolean;
}

// ---- Activity tab (Workstream 1; CORE, always-on, no AI) ----

// Per-repo current-state stats for an Activity repo card. A RepoInsights subset
// (reuses getInsights internals) plus the oldest still-unreviewed open PR.
export interface ActivityRepoStats {
  openPrs: number;
  draftPrs: number;
  mergedLast7d: number;
  stalledPrs: number;
  medianHoursToFirstReview: number | null;
  oldestUnreviewed: {
    prId: number;
    number: number;
    title: string;
    openedAt: string;
    githubUrl: string;
  } | null;
  // Review-bot signal-to-noise over this repo's open PRs — Pierre as the calm layer
  // above CodeRabbit/Greptile/Copilot/Qodo. Deterministic, no AI: `botThreads` = review
  // threads originated by a known AI review bot; `botThreadsActedOn` = those in state
  // resolved|likely_addressed (the "acted-on" heuristic). 0 when no review bot is active.
  botThreads: number;
  botThreadsActedOn: number;
}

export interface ActivityRepo {
  repoId: number;
  repoFullName: string; // `${owner}/${name}`
  stats: ActivityRepoStats;
  // Sum of buildThreadCounts over the repo's open-PR ids (the one new aggregation).
  threadTotals: ThreadStateCounts;
  maintainerIds: number[]; // from getMergers
  attentionCount: number; // PRs needing attention (my-turn reason | stalled | untouched>0)
  hasUnread: boolean; // any PR newSinceLastViewed != null
  prs: TimelinePr[]; // caller groups by authorId
}

export interface ActivityResponse {
  repos: ActivityRepo[];
  generatedAt: string; // ISO-8601
}

// Repo-scoped Claude review history (retrieval; no new storage). One PR with all
// its runs (newest-first) — richer than the cross-PR latest-only list.
export interface RepoClaudeReviewPr {
  prId: number;
  prNumber: number;
  prTitle: string;
  prState: PrState;
  authorId: number | null;
  runs: ClaudeReviewSummary[];
}

export interface RepoClaudeReviewsResponse {
  enabled: boolean;
  prs: RepoClaudeReviewPr[];
}

// ---- Pro per-repo digest (Workstream 2; @pierre/pro, flagged) ----

// One resolved PR reference inside a digest's markdown. The Haiku digests reference
// PRs as "#123" tokens; the backend resolves each to its synced PR so the frontend
// can linkify the token and open the PR as a new tab. `prId` is null when a "#N"
// token didn't resolve to a known PR in that repo (render it as plain text).
export interface DigestPrRef {
  prNumber: number;
  prId: number | null;
  repoId: number;
  repoFullName: string;
  title: string | null;
  // GitHub login of the PR author, resolved alongside the ref so the digest can show
  // "title #<number> · by <author>" for every concrete PR mention. Null when unknown.
  authorLogin: string | null;
  // The PR author's user id (resolves against a `users` roster for avatar/display).
  // Null when unknown / unresolved. Enrichment for the tabular digest view.
  authorId: number | null;
  state: PrState | null;
  // At-a-glance enrichment for the TABULAR digest/sprint rendering (a PR-referencing
  // bullet becomes a table row: PR | CI | age | author | diff | summary). All are
  // 0/null for an unresolved "#N" token (prId null). ciStatus is the head-commit rollup
  // ('unknown'/null = no checks); additions/deletions/changedFiles are the diff size;
  // openedAt drives the "age" column.
  ciStatus: CiStatus | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  openedAt: string | null; // ISO-8601
}

export interface RepoDigest {
  repoId: number;
  repoFullName: string;
  // Markdown change-report: a bulleted list of key events. May contain "#123" PR
  // tokens (resolved in `prRefs`). Chained from the prior digest to highlight change.
  summary: string;
  // Resolved "#N" references mentioned in `summary`, for linkification.
  prRefs: DigestPrRef[];
  model: string;
  generatedAt: string; // ISO-8601
  costUsd: number | null;
  stale: boolean;
}

export interface RepoDigestsResponse {
  enabled: boolean;
  model: string;
  digests: RepoDigest[];
  generatedAt: string; // ISO-8601
  budgetReached?: boolean;
  // The account's month-to-date credit allowance is spent (metered cloud plan). Set when a
  // refresh was skipped without billing; the already-stored `digests` still render, and the
  // Generate/Regenerate controls disable with an "out of AI credits" message.
  creditsExhausted?: boolean;
}

// Server-Sent-Events payload streamed by POST /api/pro/activity/digests/refresh/stream.
// `start` announces the repo denominator; one `repo` event fires as EACH repo's digest
// finishes (cache hits arrive instantly, regenerations as their Haiku call returns),
// carrying the fresh digest so the client can drop it straight into the cache — this is
// what makes the UI update live instead of only after a manual reload. `done` closes the
// stream. `throttled` means the min-interval/in-flight guard served cache without billing.
export type DigestRefreshEvent =
  // `creditsExhausted` closes the stream immediately (metered cloud plan out of credits) —
  // nothing regenerates and the stored digests are left intact.
  | { type: 'start'; throttled?: boolean; creditsExhausted?: boolean }
  // Sent once, after a cheap payload-hash pass, listing ONLY the repos whose content
  // actually changed since their last digest — the repos that will really regenerate.
  // Everything else is already up to date and is left untouched (no LLM, no skeleton).
  // `toRegenerate.length` is the honest progress denominator.
  | { type: 'plan'; toRegenerate: number[] }
  | {
      type: 'repo';
      index: number; // 1-based position among the repos being regenerated
      total: number; // == toRegenerate.length
      digest: RepoDigest;
      // true = served from the payload-hash cache (unchanged repo, $0, no LLM call);
      // false = freshly regenerated.
      cached: boolean;
    }
  | { type: 'error'; repoId: number; message: string }
  | { type: 'done'; total: number; completed: number; budgetReached?: boolean };

// NOTE: the old cross-repo "Feed digest" (FeedDigest*) was removed. The Activity "Feed"
// entry now renders the COLLECTION of per-repo RepoDigests directly (scoped to the active
// workspace's repos), each in a collapsible card — one source of truth, no aggregate LLM pass.

// ---- Consolidated Feed (CORE, no AI; the Activity "Feed" entry's main list) ----
// One flat, purely-chronological (newest-first) stream of real activity events (opens /
// merges / reviews / comments, plus commit pushes that addressed a review thread). Each
// item carries an `isMyTurn` flag — true when the event is on a PR the viewer participates
// in (authored / requested reviewer / previously reviewed or commented) AND the actor is
// someone other than the viewer. That flag replaces the old two-source (my_turn vs feed)
// synthesis + dedup, so there is now exactly ONE row per underlying event. Click nav: any
// item → the PR detail tab (its Show/Focus links then drive the timeline).

// One review thread that a feed item's change likely addressed — a commit touched the
// thread's file AFTER its last comment, so the thread flipped to 'likely_addressed'.
// Rendered inline under the item so the reader sees WHAT changed without opening the PR.
export interface FeedAffectedThread {
  threadId: number;
  path: string;
  line: number | null;
  derivedState: DerivedState;
  // A short preview of the thread's opening comment (what the reviewer originally asked).
  excerpt: string;
  // The thread's original commenter (whose point was likely addressed); resolved via the
  // response's `users` array.
  authorId: number | null;
}

// The relationship(s) that make a feed item "my turn" — surfaced as a reason pill so the
// reader knows WHY the item concerns them. Ordered most-relevant first.
export type MyTurnReason = 'requested' | 'authored' | 'merged' | 'reviewed' | 'commented';

export interface ConsolidatedFeedItem {
  // Stable unique id, e.g. "feed:1234", "feed:commitrun:99:1234", "feed:claude:42".
  id: string;
  // True when this event is "my turn": it's on a PR the viewer participates in
  // (authored / requested reviewer / reviewed / commented / merged) and the actor isn't
  // the viewer. Drives the yellow card + the "My Turn only" filter.
  isMyTurn: boolean;
  // The relationships that make this item "my turn" (see MyTurnReason), most-relevant first;
  // empty for non-my-turn rows. The UI renders the primary reason as a pill.
  myTurnReasons: MyTurnReason[];
  // An activity EventType ('pr_opened' | 'pr_merged' | 'pr_closed' | 'review_submitted' |
  // 'review_comment' | 'pr_comment' | 'commit_pushed'), or one of the SYNTHESIZED kinds that
  // have no `events` row behind them: 'claude_review' (a Claude Review run), 'ci_failed' (a
  // failed check on a PR head, from `ci_status_events`) and 'trunk_ci_failed' (a failed check
  // on a repo's default branch, from `trunk_ci_status_events`).
  //
  // ⚠ DELIBERATELY A BARE `string`, NOT `EventType`. That is what lets a synthesized kind exist
  // without widening `EVENT_TYPES` / `EVENT_CATEGORY_BY_TYPE` / the Timeline's type filter /
  // the Welcome-back counter — five surfaces that read the `events` table's enum and have
  // nothing to do with the Feed.
  kind: string;
  occurredAt: string; // ISO-8601 — the item's relevant timestamp (sort + display)
  repoId: number;
  repoFullName: string;
  prId: number | null;
  prNumber: number | null;
  prTitle: string | null;
  prState: PrState | null;
  actorId: number | null;
  // Inlined content for comment-based items (thread reply, review_comment, pr_comment);
  // null otherwise.
  content: string | null;
  // Thread ("awaiting your reply") items only — for code anchor + thread-scoped nav.
  threadId: number | null;
  // The review-thread derived state for thread-bearing items (kind 'review_comment' with a
  // threadId) — 'untouched' | 'replied_unresolved' | 'likely_addressed' | 'resolved'. Powers
  // the Bots pane's state-filter pills. Optional: undefined/null on non-thread items and on
  // feeds that don't attach it.
  derivedState?: DerivedState | null;
  // True when the item's PR is STILL awaiting its first review — open, not draft, and
  // firstReviewAt null. A LIVE snapshot recomputed per request (the same card can match
  // today and not tomorrow), never stored. Powers the "Needs review" pill. Optional:
  // undefined/null on PR-less items and on feeds that don't attach it.
  prAwaitingReview?: boolean | null;
  // Issue-level PR-comment items (kind 'pr_comment') only: the comment id, so a click can
  // deep-link straight to + highlight that comment in the PR detail's Overview tab. null
  // on every other kind.
  commentId: number | null;
  path: string | null;
  line: number | null;
  // A coarse reason for the My Turn badge ('awaiting_your_review' when a review is
  // requested of you; 'your_pr_new_comments' for activity on a PR you authored); null for
  // non-My-Turn rows.
  reasonTag: ReasonTag | null;
  reviewState: ReviewState | null;
  githubUrl: string | null;
  // Merge context: who merged the PR (pr_merged items) — null otherwise. Backfilled
  // into `users`.
  mergedById: number | null;
  // Review context: who submitted reviews on this PR, each with their latest standing
  // state (for merge/review-credit cards); null when not loaded / no reviews. User ids
  // are backfilled into `users`.
  reviewers: { userId: number; state: ReviewState }[] | null;
  // At-a-glance PR state, enriched for the page's PRs and surfaced on 'pr_opened'
  // cards: the CI rollup ('unknown' when there are no checks) and the changed-file
  // count. null when not enriched / unknown.
  ciStatus: CiStatus | null;
  changedFilesCount: number | null;
  // Context — review threads this item's change likely addressed. Populated for
  // 'commit_pushed' feed items (a push that touched a thread's file after its last
  // comment). Rendered inline so the reader sees WHAT changed. null/empty otherwise.
  affectedThreads: FeedAffectedThread[] | null;
  // For a coalesced commit-push item: how many commits the push run contained (so the
  // row can read "pushed N commits"). null for non-commit items.
  commitCount: number | null;
  // Short human-readable "what changed" summary (e.g. "pushed 3 commits · addressed 2
  // threads"); null when the row chrome already says everything.
  changeSummary: string | null;
  // CI-failure items ('ci_failed' / 'trunk_ci_failed') only: the check name(s) this card
  // reports as failing. ONE item is emitted per failed RUN — per (PR-or-branch, head sha,
  // check name) — so this normally holds exactly one name; it is an array because a red
  // rollup with no named contexts emits an empty one (an honest "CI failed, checks unknown").
  //
  // ⚠ NORMALISED to bare NAMES. The two sources store different shapes under the same column
  // name: `ci_status_events.failing_checks` is `string[]`, `trunk_ci_status_events`' (like
  // `branch_commits`') is `BranchCheckRun[]`. The wire carries names only, so no consumer has
  // to know which side a card came from.
  //
  // OPTIONAL, like `uncappedTotal`/`counts`: feed responses are IndexedDB-persisted
  // (PersistQueryClientProvider), so a cached response written before this field existed must
  // stay type-honest.
  failingChecks?: string[] | null;
  // CI-failure items only: the commit sha the failure was observed on (the PR head, or the
  // default-branch head). Rendered short and used to dedupe re-observations. Optional for the
  // same stale-cache reason as `failingChecks`.
  ciHeadSha?: string | null;
  // Claude Review items (kind 'claude_review') only: the run id — so the card can
  // deep-link into the PR's Claude Review tab — and Claude's verdict for the badge.
  // null on every other kind.
  claudeReviewId: number | null;
  claudeVerdict: ClaudeReviewVerdict | null;
  // Consolidated top-level PR comment(s) folded INTO a coinciding "host" event — a
  // review_submitted OR a lifecycle action (pr_merged / pr_closed) — where the same actor
  // posted the comment(s) within a short window (GitHub's "Comment and close/merge", or a
  // review + summary comment). When non-empty the host card is the headline and these render
  // below as an "Also commented" block, INSTEAD of separate pr_comment rows. Chronological.
  // Empty for every other kind / an un-coalesced host.
  mergedComments: { commentId: number; content: string; occurredAt: string }[];
  // ---- the LARGE-PR FLAG (see the block above LARGE_PR_CODE_LOC_DEFAULT) ----
  // Code-only churn on this item's PR — the docs/config/lockfile-free companion to
  // `changedFilesCount` above. Enriched for the PRs on the requested PAGE only, like
  // `ciStatus`/`changedFilesCount`, so hidden items cost nothing.
  // ⚠ null = UNKNOWN, never "not large". ⚠ A lower bound reads asymmetrically. Optional for the
  // same stale-IndexedDB-cache reason as `failingChecks`.
  codeLoc?: number | null;
  codeLocIsLowerBound?: boolean;
}

// Server-computed facet counts over the WHOLE loadable stream (the post-cap `ordered` set
// the page is sliced from), so the SPA's pill badges reflect every matching item — not just
// the loaded page of 50. Computed with the same coalescing / caps / capability-gating /
// my-turn enrichment the page uses, so it reconciles with the client by construction; each
// facet is independent of the active pills (a count is "how many exist", not "how many show").
export interface ConsolidatedFeedCounts {
  total: number; // == ConsolidatedFeedResponse.total (the full loadable stream length)
  myTurn: number; // items flagged isMyTurn
  claude: number; // kind 'claude_review'
  comments: number; // kind 'review_comment' | 'pr_comment'
  prEvents: number; // kind pr_opened|pr_merged|pr_closed|pr_reopened|pr_ready_for_review|review_submitted
  commits: number; // kind 'commit_pushed' — the count behind the opt-in "Commits" pill
  // kind 'ci_failed' | 'trunk_ci_failed' — the count behind the opt-in "CI failures" pill.
  // Zero (and no items) unless the request set `includeCiFailures=true`.
  ciFailures: number;
  // DISTINCT PRs with a pr_opened|pr_ready_for_review item still awaiting a first review
  // (prAwaitingReview === true) — the "Needs review" pill. A PR count, not an event count:
  // a draft-first PR has both kinds in the window and must not read as two PRs.
  awaitingReview: number;
  bots: number; // actorId in the GLOBAL users.isBot set (matches FeedView's isBotActor)
  byBotActor: Record<string, number>; // actorId -> count; populated only in the bot-only feed
  byThreadState: Record<string, number>; // DerivedState -> count over items carrying a derivedState
}

export interface ConsolidatedFeedResponse {
  // The requested page of the merged, newest-first stream (see the `limit`/`offset`
  // query params). `items` is just this page; `total` is the full stream length so the
  // client knows when to stop "Load more". Users are those referenced by THIS page.
  items: ConsolidatedFeedItem[];
  // Actors/authors referenced by items on this page, for client-side login/avatar lookup.
  users: User[];
  total: number;
  // The PRE-cap stream length (post-coalesce, before the plain-activity cap). When it
  // exceeds `total`, older plain rows were dropped by the cap and the client should
  // disclose "total most recent of uncappedTotal". OPTIONAL only so a stale
  // IndexedDB-persisted response (PersistQueryClientProvider) stays type-honest; the
  // server ALWAYS sends it.
  uncappedTotal?: number;
  // Facet counts over the whole loadable stream (see ConsolidatedFeedCounts). OPTIONAL only
  // so a stale IndexedDB-persisted response (PersistQueryClientProvider) stays type-honest;
  // the server ALWAYS sends it.
  counts?: ConsolidatedFeedCounts;
  generatedAt: string; // ISO-8601
}

// ---- Workspace review-intelligence "Insights" (Pro; `workspaceInsights` capability) ----
// Discrete, Feed-style cards computed on the sync cadence from data already synced (NO
// AI): PRs stalled on review, review threads left untouched, reviewer load/queue depth,
// and reviewer-routing suggestions. Scoped to the workspace's repos. "Sprint" is
// the trailing 2 weeks. Each card is a self-contained work item, ranked most-urgent first.
export type InsightKind =
  | 'my_turn' // an item on YOUR plate — the GET /api/my-turn population, as cards
  | 'ci_failing' // a RED BUILD you are on the hook for — your open PR, or your repo's trunk
  | 'stalled_review' // an open PR awaiting review too long
  | 'untouched_thread' // a review thread nobody has responded to
  | 'reviewer_load' // a reviewer's pending-queue depth (+ sprint load)
  | 'reviewer_routing' // a PR with no reviewer + who should review it
  // ⚠ THE TWO "FORWARD" KINDS. Every kind above is something that is WRONG; these two are
  // something that is READY, and they exist because the Pending board's ranked head has to be
  // able to say "the shortest path to a merged PR" and not only "here is what is broken". They
  // were previously computed by `db/work-plan.ts` off its own standalone open-PR query, which
  // made the ranked list a SECOND POPULATION beside the board — the defect the Pending
  // consolidation removes. All seven WorkPlanKinds now fold off these cards.
  | 'merge' // approved-or-clean and GitHub will take it
  | 'update_branch' // mergeStateStatus === 'behind' — GitHub is REFUSING the merge
  | 'bot_signal' // AI-review-bot signal-to-noise across the sprint (deterministic)
  | 'bot_only_review'; // PRs whose only review(s) came from an automated reviewer (WS7)

export type InsightSeverity = 'info' | 'warn' | 'high';

interface InsightCardBase {
  id: string; // stable-ish key (e.g. `stalled:<prId>`)
  kind: InsightKind;
  severity: InsightSeverity; // drives the card's accent (info/warn/high)
}

// Shared PR context carried by every PR-bearing insight card — enough to render the
// at-a-glance CI / size indicators and open the PR without a second fetch.
export interface InsightPrRef {
  prId: number;
  repoId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  authorId: number | null;
  githubUrl: string;
  ciStatus: CiStatus | null; // head-commit CI rollup (null = no checks)
  changedFiles: number; // files touched
  additions: number; // LOC added
  deletions: number; // LOC removed
  openedAt: string; // ISO-8601 PR open time — drives the deterministic LOC×age priority + the age column
  // ── Who opened it: automation, or a person? ────────────────────────────────────────────────
  //
  // On the Pending board a Dependabot bump and a colleague's refactor are the same shape of row
  // and want completely different attention, so the SOURCE has to be legible without opening the
  // PR. Both fields are REQUIRED and built by the one `prRef` builder, because an optional
  // `authorIsBot` that arrives undefined renders as "a person" — a claim about a human that we
  // did not make. (Same rule as MyTurnCard.relevance: an absent field may never invent an
  // identity on screen.)
  //
  // ⚠ RESOLUTION ORDER, and it is not the login: a MANUAL workspace judgement wins in BOTH
  // directions (a login in AUTOMATION_VENDORS marked "human" is a person; a no-name service
  // account marked automated is a bot), then `users.isBot`. Only then does the login seed a
  // VENDOR. This is the stored-beats-seed rule that the reviewer table already lives by.
  authorIsBot: boolean;
  /** The vendor family when one is recognised. ⚠ `null` WITH `authorIsBot: true` is a real and
   *  common state — an unbranded CI account — and renders as a generic "Bot", never as a person. */
  authorBotKind: AutomatedReviewerKind | null;
  // ---- the LARGE-PR FLAG (see the block above LARGE_PR_CODE_LOC_DEFAULT) ----
  // Code-only churn, beside the raw `additions`/`deletions`/`changedFiles` above — those three
  // are the whole diff, this one has the docs/config/lockfile/generated churn removed.
  // ⚠ null = UNKNOWN, never "not large". ⚠ A lower bound reads asymmetrically.
  //
  // Unlike `authorIsBot`/`authorBotKind` — which are REQUIRED here because an absent flag would
  // render a bot as a person — an absent `codeLoc` renders NOTHING at all, which is exactly the
  // right answer for "we don't know". So it can be, and is, trailing optional.
  codeLoc?: number | null;
  codeLocIsLowerBound?: boolean;
}

// A CORE suggested reviewer (used by BOTH the PR-detail "Suggested reviewers" row and the
// Insights `reviewer_routing` card) — rich enough to carry BOTH GitHub users and CODEOWNERS
// teams, and users we haven't synced.
// `kind` discriminates:
//   'user' → `login` is always set (the assign key); `userId` is set when we've synced
//            that user (drives the avatar / profile link) and null otherwise.
//   'team' → `teamSlug` is the assign key (sent as `team_reviewers`); `teamName` is the
//            'org/team' display label. userId/login are null.
// `reason` is the human rationale; `source` records where the suggestion came from.
//
// ⚠ `kind: 'team'`, `teamSlug` AND `teamName` ARE GITHUB'S OWN TEAMS — not this app's workspaces.
// `teamSlug` is the literal key sent in GitHub's `team_reviewers` REST body and `kind === 'team'`
// is tested by the renderers. They are one `sed` away from the workspace vocabulary and are the
// opposite category: renaming them breaks CODEOWNERS `@org/team` suggestions and the assign call.
export interface ReviewerSuggestion {
  kind: 'user' | 'team';
  login: string | null;
  userId: number | null;
  teamSlug: string | null;
  teamName: string | null;
  reason: string;
  source: 'codeowners' | 'history';
}

// Response of GET /api/prs/:id/suggested-reviewers — the CORE "Suggested" row, served as
// its OWN live query (short staleTime, NOT persisted to IndexedDB) rather than embedded in
// the aggressively-cached PR detail, so it always reflects current state (e.g. it empties
// the moment a reviewer is requested). `users` carries any CODEOWNERS-resolved users the PR
// detail didn't already include (for avatar/link rendering). Empty when the PR doesn't
// warrant suggestions (has a reviewer/review, or isn't open+non-draft).
export interface SuggestedReviewersResponse {
  suggestedReviewers: ReviewerSuggestion[];
  users: User[];
}

// An item that is on YOUR plate, as a first-class card on the needs-attention board.
//
// ⚠ THIS IS THE SAME POPULATION AS `GET /api/my-turn`, WORKSPACE-SCOPED — the server builds these
// cards by calling the very same fold (`getMyTurn(accountId, scope)`), one card per row of its six
// sections, never a re-derivation. And the daily brief's "N need your review or reply" IS the
// number of `my_turn` cards emitted here, so the strip's number and the list the user lands on
// cannot disagree. (It used to be a count of feed EVENTS in a rolling 14 days, which corresponded
// to no clickable list at all — that is the defect this card kind exists to close.)
//
// `dismissRefId` is the `my_turn_dismissals` refId to POST to /api/my-turn/dismiss with `reason`
// as the kind — a PR id, a thread id or a Claude-review run id depending on the reason. It is null
// for exactly one reason, `'your_pr'`: opening the PR is that section's dismissal (the pr_views
// marker), so there is no dismissal kind and no row to write.
export interface MyTurnCard extends InsightCardBase, InsightPrRef {
  kind: 'my_turn';
  reason: MyTurnCardReason;
  /** the my_turn_dismissals refId; null for 'your_pr', which has no dismissal kind */
  dismissRefId: number | null;
  /** set only when reason === 'thread' */
  threadId: number | null;
  /** one-line "what happened", e.g. "3 new comments · 1 new commit" or "@alice replied 3d ago" */
  detail: string;
  /** ISO — when the thing that needs you happened */
  since: string;
  /** ADVISORY relevance flag, READ off the same `getMyTurn` row the rest of this card is built
   *  from (never re-derived here — the `since` rule, applied to the second thing every surface
   *  would otherwise answer twice). See `MyTurnPr.personal` for the rule.
   *
   *  ⚠ THE BOARD IS NOT NARROWED BY IT. Every card still paints: a new PR in a repo you only
   *  read does still need a review, and hiding it would delete work rather than route it. The
   *  flag is for the NOTIFICATION surfaces, which reach for the user rather than waiting to be
   *  opened, and it is computed BEFORE the 50-card cap so `myTurnPersonalTotal` describes the
   *  whole population and not the slice that fitted.
   *
   *  ⚠ DERIVED from `relevance` (`!== 'none'`) and kept required so no consumer breaks. It is the
   *  right field for "may we interrupt?" and the WRONG one for card copy — a card that reads
   *  "YOUR TURN" off this says it over a stranger's PR in a repo you happen to have write on. */
  personal: boolean;
  /** THE THREE-VALUED RELEVANCE the card's label is written from — see `MyTurnRelevance`. READ
   *  off the same `getMyTurn` row as `personal` and `since`, never re-derived here.
   *
   *  Trailing-optional for wire tolerance only (an e2e mock, a response predating the field);
   *  `getWorkspaceInsights` always sets it. Absent ⇒ fall back to `personal`. */
  relevance?: MyTurnRelevance;
  /** THIS CARD'S REPO IS MUTED FOR PENDING — see `MyTurnPr.muted`, which this is READ off (never
   *  re-derived here, the `since`/`relevance` rule applied a third time).
   *
   *  ⚠ DISPLAY ONLY. It explains a `relevance` of `'none'` the reader deliberately caused; it is
   *  not an input to `personal`, to any brief count, to the relevance lens or to the ranker, all
   *  of which read `relevance`. Set only when true. */
  muted?: boolean;
}

// Which relationship puts a red build on the viewer's plate. TWO ARMS, and they are two different
// claims — the card's copy says which, exactly as `MyTurnRelevance` does for the my_turn board.
export type CiFailureArm =
  | 'your_pr' // an OPEN PR you AUTHORED whose head CI is red — your code, your fix
  | 'trunk'; // the DEFAULT BRANCH of a repo you MAINTAIN is red right now

// A red build the viewer is on the hook for (CORE, deterministic, no AI).
//
// ⚠ THE POPULATION IS DELIBERATELY NARROW, and the two things it does NOT cover are the whole
// design (both were built, measured against real data, and cut — see the comments in
// `getWorkspaceInsights`' ci_failing block):
//   • "PRs I MERGED whose CI is failing" is not here. `pull_requests.ci_status` is FROZEN at the
//     merge instant (a merged PR is never re-walked), so it answers "did this land red" — a retro
//     metric — not "is something broken now".
//   • "the commit that TURNED trunk red" is not here either. Trunk CI is non-monotone, a fifth of
//     `branch_commits` rows carry an unknown CI status, and a chronically-red repo has no streak
//     start at all. The card names the LANDING PR of the CURRENT red head, which is a fact we
//     store, and says nothing about who broke it.
//
// ⚠ EVERY PR FIELD IS NULLABLE, and a null is ORDINARY. On the `trunk` arm ~11% of red heads are
// direct pushes to the default branch (a legitimate steady state, not a sync gap) and others
// simply have no association observed yet — the card must still say trunk is red and just not
// name a PR. On the `your_pr` arm they are always set.
export interface CiFailingCard extends InsightCardBase {
  kind: 'ci_failing';
  arm: CiFailureArm;
  repoId: number;
  repoFullName: string;
  // Always 'failure' | 'error' — RED IS ALWAYS THAT PAIR, never one of them (db/triage.ts,
  // getWorkspaceMetricsDetail and lib/ui.ts all spell the same two).
  ciStatus: CiStatus;
  /** The PR: the viewer's own on 'your_pr'; the LANDING PR of the red trunk head on 'trunk',
   *  null there whenever the sha resolves to none (see the ⚠ above). */
  prId: number | null;
  prNumber: number | null;
  prTitle: string | null;
  /** 'trunk' only — the default-branch head the failure is reported on. Null on 'your_pr'. */
  headSha: string | null;
  /** 'trunk' only — who merged the landing PR, when one resolved. Null otherwise. */
  mergedById: number | null;
  /** 'trunk' only — `mergedById` IS the viewer: they put this commit on trunk themselves. This is
   *  an ATTRIBUTION OF LANDING, never of BREAKING: the build may have been red before it. */
  viewerMerged: boolean;
  /** one-line "what is red and why it is yours", built server-side like the my_turn card's */
  detail: string;
  /** ISO — THE HONEST CLOCK, and it means something different per arm, which is why it is not
   *  called "redSince": there is no stored per-PR CI transition to read that from.
   *  'your_pr' → the head commit's time (the code the verdict is about);
   *  'trunk'   → when we last REFRESHED the branch snapshot (our observation, not the commit's).
   *  Null when neither is known. */
  observedAt: string | null;
  /** The PR page on 'your_pr'; the COMMIT page on 'trunk' — a trunk run's checks live on the
   *  commit, the same rule the trunk_ci_failed feed item follows. Render via safeExternalUrl. */
  githubUrl: string;
}

export interface StalledReviewCard extends InsightCardBase, InsightPrRef {
  kind: 'stalled_review';
  ageHours: number; // hours the PR has been open awaiting review
  requestedReviewerIds: number[]; // reviewers still on the hook (GitHub-pending)
  requestedTeamNames: string[]; // GitHub TEAMS still on the hook — display names, not slugs
}

export interface UntouchedThreadCard extends InsightCardBase, InsightPrRef {
  kind: 'untouched_thread';
  threadId: number;
  path: string;
  ageHours: number;
  originalCommenterId: number | null;
  // When the thread's originalCommenter is an automated reviewer, the vendor kind + display label
  // (so the card can show a bot pill). Undefined/null when a human opened the thread.
  botKind?: AutomatedReviewerKind | null;
  botLabel?: string | null;
}

export interface ReviewerLoadCard extends InsightCardBase {
  kind: 'reviewer_load';
  reviewerId: number;
  pendingCount: number; // open PRs where they're requested & haven't reviewed
  reviewsThisSprint: number; // reviews they submitted in the sprint window
  pendingPrs: {
    prId: number;
    repoFullName: string;
    prNumber: number;
    prTitle: string;
  }[];
}

export interface ReviewerRoutingCard extends InsightCardBase, InsightPrRef {
  kind: 'reviewer_routing';
  topPaths: string[]; // representative changed paths (e.g. "auth/login.ts")
  // Who + why — the SAME rich shape as the PR-detail "Suggested reviewers" row (users AND
  // @org/team suggestions), built by the shared enrichReviewerSuggestions pipeline, so bots are
  // structurally impossible and CODEOWNERS/teams are first-class here too.
  suggestedReviewers: ReviewerSuggestion[];
}

// Per-vendor rollup carried by the bot_signal card.
export interface BotSignalVendorStat {
  kind: AutomatedReviewerKind; // vendor, in-house, or Pierre (widened from ReviewBotKind for the bot-triage platform)
  threads: number; // review threads this bot opened in the sprint window
  actedOn: number; // of those, in state resolved|likely_addressed (the acted-on heuristic)
  untouched: number; // in state untouched (the pure backlog/noise)
  oldestUntouchedDays: number | null; // age of the oldest still-untouched thread
}

// A cross-repo, cross-bot "signal-to-noise" summary — the un-copyable view no single
// review bot can produce ("CodeRabbit left 214 comments this sprint; 38% acted on; 46
// untouched, oldest 9 days"). Deterministic (no AI); aggregate (no single PR ref).
export interface BotSignalCard extends InsightCardBase {
  kind: 'bot_signal';
  totalThreads: number;
  totalActedOn: number;
  totalUntouched: number;
  actedOnPct: number | null; // totalActedOn / totalThreads, 0-100 (null when no threads)
  oldestUntouchedDays: number | null;
  vendors: BotSignalVendorStat[]; // most-threads-first
}

// "Only a bot reviewed this" governance risk (WS7): PRs merged (or open-and-mergeable)
// whose ONLY reviews come from automated reviewers (incl. Pierre-verbatim) — no human
// review. Deterministic; a rubber-stamping-fatigue trust/safety hook. Aggregate (a PR
// list, no single ref).
export interface BotOnlyReviewCard extends InsightCardBase {
  kind: 'bot_only_review';
  prs: { prId: number; number: number; title: string; repoFullName: string;
         botLabel: string; state: string; githubUrl: string }[];
}

// ---- the two "forward" cards (see InsightKind) ----------------------------------------------
//
// DELIBERATELY TWO INTERFACES, NOT ONE WITH A UNION `kind`. `Record<InsightCard['kind'], …>`
// maps (KIND_LABEL, kindRank) and the board's render switch are per-kind, and a shared interface
// would let one of them silently cover both. They carry identical fields today; that is a
// coincidence of the current predicates, not a contract.
//
// ⚠ `detail` IS CODE-WRITTEN AND MUST BE TIME-FREE. It is re-derived by the ranker as the row's
// `reason` (through the ONE exported `mergeCardDetail`), so a relative clock in it would let the
// card and the ranked row drift apart between two polls of the same unchanged data.

/** Approved-or-clean and GitHub will take it: the shortest path to a merged PR. */
export interface MergeReadyCard extends InsightCardBase, InsightPrRef {
  kind: 'merge';
  /** GitHub's protection-aware state, verbatim. Always a member of READY_MERGE_STATES. */
  mergeStateStatus: MergeStateStatus;
  /** ⚠ null = NOT OBSERVED, never "not conflicting" — the three-state rule for a column that may
   *  only be cleared on a positive statement from GitHub. */
  mergeable: Mergeable | null;
  /** ISO head-commit clock; null ⇒ the ranker falls back to `openedAt`. */
  lastCommitAt: string | null;
  /** Carried for the RANKER's relevance weight. ⚠ The board's relevance LENS deliberately does
   *  not filter on it — see the lens predicate in AttentionView. */
  relevance: MyTurnRelevance;
  /** CODE-WRITTEN, time-free. See the ⚠ above. */
  detail: string;
  /** Does this account have write access to the repo? The board's merge controls are HIDDEN
   *  without it, exactly as PrDetail's Actions row is.
   *
   *  ⚠ It rides the CARD because the board must not fetch to find out. PrDetail answers this from
   *  the live `merge-options` call (3 GitHub calls per PR); fifty cards doing the same on mount
   *  would be 150 calls to paint a board. This is the synced `repos.viewerPermission`, and it is
   *  a VISIBILITY gate only — never the authority. The merge route re-checks permission, the head
   *  oid and the live merge state before anything irreversible happens. */
  viewerCanPush: boolean;
}

/** `mergeStateStatus === 'behind'` — GitHub is REFUSING the merge until the branch is updated.
 *  ⚠ NOT "the base branch moved on" (`behindBy > 0`), which is true of most healthy PRs. */
export interface UpdateBranchCard extends InsightCardBase, InsightPrRef {
  kind: 'update_branch';
  mergeStateStatus: 'behind';
  mergeable: Mergeable | null;
  lastCommitAt: string | null;
  relevance: MyTurnRelevance;
  detail: string;
  /** See MergeReadyCard.viewerCanPush — same field, same reason, same "visibility gate, never the
   *  authority" caveat. */
  viewerCanPush: boolean;
}

export type InsightCard =
  | MyTurnCard
  | CiFailingCard
  | StalledReviewCard
  | UntouchedThreadCard
  | ReviewerLoadCard
  | ReviewerRoutingCard
  | MergeReadyCard
  | UpdateBranchCard
  | BotSignalCard
  | BotOnlyReviewCard;

// ---- Workspace DORA-ish flow metrics (Insights header; no AI) ----
// Best-effort DORA mapping from synced PR/CI data (there is NO stored CI-state history,
// so recovery is a current-state proxy — see fields). Each stat carries the current
// sprint value + the prior sprint's (for a Δ trend arrow). Weekly series align to
// `weekBuckets` (a shared x-axis, oldest first) and reuse the repo-analytics chart format.
export interface WorkspaceMetricStat {
  value: number | null; // this sprint SO FAR (null = no sample)
  previous: number | null; // the SAME elapsed slice of the prior sprint (apples-to-apples)
  // How many items fed each figure (for counts this equals the value; for medians/percentages
  // it's the sample behind the statistic). Drives the low-confidence guard.
  sampleSize?: number;
  previousSampleSize?: number;
  // True when the comparison is too thin to state a trend (either side below the sample floor,
  // typical early in a sprint). The tile hides the delta arrow and the AI report must state the
  // raw "so far" figure WITHOUT a percentage / "cliff" / "spike" — it's noise, not a signal.
  lowConfidence?: boolean;
}

export interface WorkspaceMetrics {
  // Which window model produced value/previous — the panel + AI report label accordingly
  // ("day N of M · vs same point last sprint" for 'sprint'; "rolling N days · vs prior N days" for
  // 'rolling_*'). Optional for back-compat with cached responses predating the setting.
  comparisonMode?: SprintComparisonMode;
  sprintDays: number; // FULL length of the sprint/rolling window in days (e.g. 14)
  // How far into the sprint we are. The stat tiles compare "this sprint so far" against the
  // SAME elapsed slice of the previous sprint (elapsed-matched), so on day 1 you compare day-1
  // vs day-1 — not a few hours against a complete prior sprint (which read as a false "cliff").
  // At sprint end elapsedDays === sprintDays and it's the full-vs-full comparison. Optional for
  // back-compat with cached responses predating this field.
  elapsedDays?: number; // days elapsed so far (may be fractional early in the sprint)
  elapsedFraction?: number; // elapsedDays / sprintDays, clamped 0..1
  weekBuckets: string[]; // ISO bucket-start per week, oldest first (chart x-axis)

  // Currently-open PRs (non-draft) across the repos — a snapshot count (no trend).
  openPrs: number;

  // Deployment frequency → PRs merged to a base branch.
  merges: WorkspaceMetricStat;
  // Lead time for changes → median hours open → merge.
  leadTimeHours: WorkspaceMetricStat;
  // Review responsiveness → median hours open → first review.
  timeToFirstReviewHours: WorkspaceMetricStat;
  // Change failure rate (inverted) → % of merged PRs whose head CI was green.
  mergeCiSuccessPct: WorkspaceMetricStat;
  // Time to restore (snapshot proxy) → open PRs currently red on CI + how long sat.
  ciFailingNow: number;
  ciFailingMedianAgeHours: number | null;

  // Time to restore (REAL, from the ci_status_events transition log) → median hours a
  // PR head spends red before CI goes green again. Null until enough history accrues.
  ciRecoveryHours: WorkspaceMetricStat;

  // Weekly series (length === weekBuckets.length).
  throughput: { opened: number[]; merged: number[] }; // flow + deploy frequency
  leadTimeTrend: (number | null)[]; // median open→merge hours, by merge week
  ciSuccessTrend: (number | null)[]; // % merged PRs green, by merge week
  ciRecoveryTrend: (number | null)[]; // median CI recovery hours, by resolution week

  // Review load per merged PR, split human vs bot, by merge week — how much review a shipped PR
  // attracts and whether human scrutiny keeps pace with bots. Each value = review touches (reviews
  // + inline + issue comments) by humans / bots ÷ PRs merged that week; null for a merge-less week.
  // "bot" = any bot-flagged author (users.isBot). A falling human line while bot rises = review is
  // shifting onto the bots. Optional for back-compat with cached responses predating the field.
  reviewLoad?: { human: (number | null)[]; bot: (number | null)[] };

  // ── Self-review depth (Phase 2) — how well the team reviews its own code over time. All by
  // merge week, aligned to weekBuckets; optional for cached-response back-compat. ──
  // % of merged PRs that got a changes-requested review — a falling line = cleaner first drafts.
  changesRequestedTrend?: (number | null)[];
  // Merged-PR COUNTS by review coverage: got a human review / only a bot / nobody. A stacked read
  // of "what shipped with real human eyes" vs bot-only vs unreviewed over time (governance).
  reviewCoverage?: { human: number[]; botOnly: number[]; unreviewed: number[] };
  // Median % of a merged PR's commits pushed AFTER its first review — how much churn happens post-
  // review (proxy for how "baked" PRs are on submission). Only PRs that WERE reviewed contribute.
  reworkTrend?: (number | null)[];
  // Median hours a review thread stays open before it's resolved, by resolution week, split by
  // whether a bot self-resolved vs a human addressed it. Only counts resolves the sync WITNESSED
  // (resolvedAt set going forward), so it's empty until post-deploy syncs observe some. "How fast
  // devs address review feedback over time" — the human line is the signal that matters.
  resolutionLatencyTrend?: { human: (number | null)[]; bot: (number | null)[] };
  // Median hours from review REQUESTED to first review, by first-review week — review pickup
  // responsiveness. Only defined for PRs with a request event (empty until sync backfills
  // firstReviewRequestedAt), so unlike TTFR-from-open it doesn't skew as data accrues.
  reviewPickupTrend?: (number | null)[];

  // CI failure reasons over the window, by check/stage name (top stages, desc). The
  // dimension that tells you WHY CI is failing over time.
  ciFailureReasons: { stage: string; count: number }[];
}

export interface WorkspaceInsightsResponse {
  enabled: boolean; // false when the capability is off (plugin absent)
  generatedAt: string; // ISO-8601
  sprint: { from: string; to: string };
  metrics: WorkspaceMetrics | null; // workspace flow-metrics header (null = the workspace has no repos)
  cards: InsightCard[];
  users: User[]; // actors referenced by the cards (avatar/login lookup)
  /** THE UNCAPPED `my_turn` POPULATION — a DISCLOSURE, never a figure to display on its own.
   *
   *  `my_turn` cards are emitted capped at MY_TURN_CARD_CAP (50); this is the pre-cap length, so
   *  on a workspace with 148 things on your plate it reads 148 while `cards` carries 50. THE CARD
   *  COUNT REMAINS THE FIGURE EVERY SURFACE DISPLAYS — the brief's `myTurn`, the board's header
   *  and the isolation banner all count cards, and they agree with each other by construction.
   *  This field exists ONLY so a surface can append "of N" and stop reading as "covered
   *  everything" (the no-silent-caps rule); a surface that rendered THIS as the headline would
   *  recreate the "the number goes nowhere" bug — 148 with no list of 148 behind it.
   *
   *  Absent when the my_turn fold didn't run (an empty workspace); `undefined` and "not capped"
   *  are both non-disclosures, which is why every consumer gates on `myTurnTotal > shown`.
   *  Every OTHER card kind is capped at INSIGHT_CARD_CAP (15) and stays silent about it on
   *  purpose: those are SURVEYS of the workspace, where 15 is a digestible sample of a long tail.
   *  Only my_turn is a personal worklist the user works through, where a cap is a lie. */
  myTurnTotal?: number;
  /** The uncapped `my_turn` population RESTRICTED TO `MyTurnCard.personal` rows — the same
   *  pre-cap array as `myTurnTotal`, folded a second time. It exists so the notification
   *  surfaces get a MATCHED PAIR: a narrow count whose denominator is also narrow.
   *
   *  ⚠ A narrow count paired with `myTurnTotal` would be one row mixing two populations — and
   *  the cap disclosure ("50 of 148") gates on the shown figure EQUALLING the count it is
   *  qualifying, so a narrow line without this field silently loses its "+" for ever. Absent
   *  under exactly the same condition as `myTurnTotal` (the fold didn't run). */
  myTurnPersonalTotal?: number;
  /** The uncapped population of `relevance === 'direct'` cards — work tied to YOU. Folded off the
   *  SAME pre-cap array as the two totals above, in the same pass. */
  myTurnDirectTotal?: number;
  /** The uncapped population of `relevance === 'maintained'` cards — new PRs in repos you
   *  maintain. `myTurnDirectTotal + myTurnMaintainedTotal === myTurnPersonalTotal` by
   *  construction; it is spelled out rather than left to a subtraction so a surface that displays
   *  "in your repos" on its own has a real denominator of its own. */
  myTurnMaintainedTotal?: number;
  /** The uncapped population of `relevance === 'none'` cards — the "review or reply" backlog.
   *
   *  ⚠ ITS OWN FOLD, NEVER `myTurnTotal - myTurnPersonalTotal`. The cap disclosure only fires
   *  when the displayed figure equals the count it qualifies, so a line whose denominator was
   *  subtracted from a different population silently loses its "of N" (and mixes two populations
   *  in one row). Every displayed count gets its own total — that is the whole rule. */
  myTurnOtherTotal?: number;
  /** The uncapped `ci_failing` population — the same disclosure `myTurnTotal` is, for the OTHER
   *  kind that is a personal worklist rather than a survey of the workspace.
   *
   *  ⚠ `ci_failing` shares INSIGHT_CARD_CAP (15) with the survey kinds, which stay silent about
   *  their cap on purpose (15 is a digestible sample of a long tail). This one may not: "3 red
   *  builds are yours" is a number the viewer works through, so a silent cap on it is a lie in
   *  exactly the way my_turn's was. Absent when the fold didn't run (an empty workspace) —
   *  `undefined` and "not capped" are both non-disclosures, so consumers gate on `total > shown`. */
  ciFailingTotal?: number;
}

// The attention cards (your turn / red builds / stalled reviews / untouched threads / reviewer
// load / needs-a-reviewer / ready-to-land / behind-trunk), served CORE/free by GET /api/attention
// for the **Pending** rail entry — the same cards the (Pro) Insights pane computes in core
// getWorkspaceInsights, minus the bot-signal cards (those live in the free Bots console).
// No AI, no capability gate.
export interface AttentionCardsResponse {
  cards: InsightCard[];
  users: User[];
  /**
   * THE "DO NEXT" HEAD — card ids in the deterministic rank order of `db/work-plan.ts`
   * (`score = 0.50·proximity + 0.30·stallRisk + 0.20·relevanceWeight`), capped at
   * WORK_PLAN_ITEM_CAP with one row seated per non-empty kind.
   *
   * ⚠ IT IS AN ORDERING, NOT A FILTER. The board renders ONE list partitioned into head and
   * tail where `head ∪ tail === cards` and the two are disjoint. That is what keeps every cap
   * disclosure ("50 of 148") arithmetically true and keeps the brief strip and the board one
   * population. A future "improvement" that instead FILTERED `cards` down to the head would
   * break `capFor`'s `shown === count` guard with no error, on exactly the workspaces where the
   * disclosure matters.
   *
   * ⚠ FREE ON EVERY TIER — this is code-derived rank, not narration. The Pro layer only
   * decorates these rows (see WorkPlanItem.cardId).
   *
   * TRAILING OPTIONAL, and the reason is NOT persistence (`shouldDehydrateQuery` persists only
   * pr | thread | pr-files, so this response never reaches IndexedDB): the SPA and the server
   * deploy independently and `useAttentionCards` serves a 60s-stale cached body, so a response
   * predating this field must render a HEADLESS board rather than throw.
   */
  doNextIds?: string[];
}

// ---- POST /api/attention/liveness — the board's batched "is this still true?" probe ----------
//
// GET /api/attention is DB-only, which is what lets it render fifty cards for the price of one
// query. The cost of that is staleness against GITHUB: a PR merged, closed or unblocked by
// someone else keeps its card until the adaptive scheduler walks that repo (2-15 min). This route
// closes the gap for a whole board in ONE call — see sync/pr-liveness-sweep.ts.
//
// ⚠ IT REFRESHES ROWS AND REPORTS A COUNT; IT RETURNS NO CARDS. The client's only permitted
// response to `changed > 0` is to refetch `['attention-cards']` AND `['daily-brief']` together.
// Dropping a card client-side would break `capFor`'s `shown === count` guard and silently delete
// the "50 of 148" disclosure — the board is `head ∪ tail === cards`, disjoint, and every
// disclosure divides one half of one snapshot by the other.
export interface AttentionLivenessBody {
  /**
   * The local PR ids the board is currently rendering, deduplicated.
   *
   * ⚠ CAPPED SERVER-SIDE, AND AN OVER-CAP REQUEST IS A 400 RATHER THAN A TRUNCATION (the
   * `?cells=` precedent on the peer benchmark): a silently-dropped tail is a board that thinks it
   * was freshened and was not. The client ranks before it slices, so the ids that matter most —
   * the rows offering a Merge button — are the ones that fit.
   *
   * Ids the caller does not own, or that belong to another workspace, are simply absent from the
   * resolve; they are never an error and never an existence oracle.
   */
  prIds: number[];
}

export interface AttentionLivenessResponse {
  /** The resolved workspace — echoed like every other scoped response. */
  workspaceId: number;
  /** How many of the supplied ids resolved to PRs the caller owns in this workspace. */
  checked: number;
  /** Of those, how many the (bounded, expensive) mergeability pass could also re-read. */
  mergeStateChecked: number;
  /**
   * Rows whose BOARD-VISIBLE state moved (state / draft / merge state / mergeable / the PR's own
   * clock). `> 0` is the client's signal to refetch the board — and it is deliberately narrower
   * than "a row was written": a `reviewDecision` GitHub merely restated moves no card, and on
   * real data most open PRs carry one it restates every time.
   */
  changed: number;
  /** Of those, how many left the open set entirely — i.e. cards that are about to disappear. */
  leftOpenSet: number;
  /**
   * The account's GitHub budget was exhausted, so nothing was re-read.
   * ⚠ NOT AN ERROR — rate limits are pre-empted, never surfaced as failures; red is for
   * unrecoverable faults. The board keeps its synced rows, exactly as before this route existed.
   */
  paused: { resumeAt: string | null } | null;
}

// The Insights flow-metric header (WorkspaceMetrics tiles + trend charts) computed for a SINGLE
// repo — powers the per-repo console's "Insights-style" panel (getWorkspaceInsights narrowed to
// that one repo, its workspace resolved from the repo itself). Metrics-only; the repo console
// renders these tiles NON-clickable.
export interface RepoWorkspaceMetricsResponse {
  enabled: boolean; // false when the Pro plugin/capability is off
  metrics: WorkspaceMetrics | null; // null = repo not owned / no data
}

// ---- Workspace flow-metric DRILL-DOWN (Insights; clicking a metric tile) ----
// Each of the 6 flow-metric tiles opens a drill-down tab; this is the per-metric PR
// list behind each. Loaded on demand (a separate, heavier read than the always-loaded
// WorkspaceMetrics), scoped to the workspace's repos + the current sprint. Lets the user see
// WHERE issues cluster (which PRs/repos drag a metric).
//
// The "Open PRs" tile is deliberately NOT a key here: it routes to the sortable open-PRs
// drill-down over /api/open-prs (TimelinePr rows, drafts included) — the ONE open-PR list —
// rather than a capped MetricPr sub-tab duplicating it.
export type WorkspaceMetricKey =
  | 'merges' // deploy frequency → all merged PRs (per repo)
  | 'lead_time' // open → merge, merged + open, longest first
  | 'review_latency' // open → first review, longest first
  | 'merge_ci' // merged PRs by CI-at-merge (failures first)
  | 'ci_recovery' // red → green recovery, slowest first
  | 'ci_red'; // currently CI-failing open branches

export const WORKSPACE_METRIC_KEYS: WorkspaceMetricKey[] = [
  'merges',
  'lead_time',
  'review_latency',
  'merge_ci',
  'ci_recovery',
  'ci_red',
];

// One PR row in a metric drill-down list. Carries the shared PR context plus the
// metric-specific figures (only the fields relevant to the list it appears in are
// populated; the rest are null). Users referenced by authorId / mergedById /
// reviewerIds resolve against WorkspaceMetricsDetail.users.
export interface MetricPr {
  prId: number;
  repoId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  authorId: number | null;
  state: PrState;
  githubUrl: string;
  ciStatus: CiStatus | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  openedAt: string; // ISO-8601
  updatedAt: string; // ISO-8601 — GitHub last-activity ts (drives the sortable "Updated" column)
  mergedAt: string | null; // ISO-8601 (merged PRs)
  // Metric-specific figures (null unless relevant to this row's list):
  leadTimeHours: number | null; // open→merge (merged) / open→now (open) — merges + lead_time
  reviewLatencyHours: number | null; // open→first review — review_latency
  recoveryHours: number | null; // red→green — ci_recovery
  redAgeHours: number | null; // how long currently red — ci_red
  mergedById: number | null; // who merged — merges
  reviewerIds: number[]; // distinct reviewers — review_latency
}

export interface WorkspaceMetricsDetail {
  sprint: { from: string; to: string };
  merges: MetricPr[]; // merged in the sprint (per repo on the client)
  leadTime: MetricPr[]; // merged-in-sprint + currently-open, longest lead first
  reviewLatency: MetricPr[]; // reviewed PRs, longest open→first-review first
  mergeCi: MetricPr[]; // merged-in-sprint PRs, CI-failed-at-merge first
  ciRecovery: MetricPr[]; // PRs with a red→green recovery, slowest first
  ciRed: MetricPr[]; // currently CI-failing open PRs, longest red first
  users: User[]; // actors referenced by any list
}

export interface WorkspaceMetricsDetailResponse {
  enabled: boolean; // false when the capability is off (plugin absent)
  detail: WorkspaceMetricsDetail | null; // null when the workspace has no repos
}

// ---- "Where is the work happening?" — per-repo activity under Flow metrics ----
//
// The workspace's flow metrics answer HOW MUCH and HOW FAST; this answers WHERE. One row per
// repository over a rolling 14-day window, rendered as TWO side-by-side bar charts in the same
// repo order: PRs opened (split human vs automation) and lines changed.
//
// ⚠ TWO CHARTS, NEVER ONE BLENDED SCORE. A "0.5·z(PRs) + 0.5·z(lines)" activity index is the exact
// shape this codebase rejects in five places — "a blended figure is a number no PR resembles"
// (actor lanes), "a workspace-wide rate is a number no member of any cell resembles" (benchmark
// placement), "the pooled headline rate and the fitted-subset rate ... must be labelled apart and
// NEVER SUBTRACTED". Every figure below is a plain count over a stated window and population, so a
// reader can check any of them against the repo itself; a fused scalar reconciles with nothing on
// the panel above it. A grouped two-series chart is equally wrong here for a mechanical reason:
// BarChart's `niceMax` gives every series ONE y-axis, and a PR count (≈5) beside a line count
// (≈5000) draws the count sub-pixel.
export interface WorkspaceRepoActivityRow {
  repoId: number;
  repoFullName: string; // "owner/name" — the chart's axis uses the trailing segment
  /** PRs OPENED in the window, split by who opened them. The split is the whole point: on the dev
   *  corpus Dependabot opened 97 of 758 PRs in a fortnight and topped one repository outright, so
   *  a blended bar would crown a config repo as "where the work is happening" on dependency bumps.
   *
   *  "Automation" is `resolveActorLanes`' `automatedIds`, never `automatedReviewerUserIds` alone —
   *  the duplicate-identity defence. ⚠ Its CANDIDATE set is (workspace verdict ∪ globally
   *  `users.isBot`); a login vocabulary hit counts on its own for a candidate but admits nobody to
   *  the set, so an unflagged, unclassified actor with a vendor login is counted as a PERSON here.
   *  That is the same answer every other lane consumer gives, which is the point of routing through
   *  the one resolver rather than re-deriving "is this a bot" per surface.
   *  The seven lanes are DELIBERATELY folded into one series here: the dependency vs
   *  code_agent split resists collapsing when the question is "what distorted this metric", but the
   *  question this chart asks is "was a person doing it", where human-vs-not is the right grain. */
  prsOpenedHuman: number;
  prsOpenedAutomation: number;
  /** Lines changed = raw `additions + deletions` over the window's PRs, summed over the SIZED ones
   *  only (`sizedPrs`), or null when none of them was ever sized.
   *
   *  ⚠ RAW, NOT `codeLocFor`'s code-only measure. That one excludes docs/config/generated/binary
   *  files and is a deliberate LOWER BOUND — `files(first: 100)` truncates, so its own rule is
   *  "over-threshold is safe to assert, under-threshold is not". Correct for a per-PR "large PR"
   *  badge; wrong for a cross-repo comparison, because the PRs it silently under-counts are exactly
   *  the biggest ones, i.e. the repositories this chart exists to rank. */
  linesChanged: number | null;
  /** ⚠ UNKNOWN SIZE IS NOT ZERO SIZE. `additions`/`deletions`/`changedFiles` are NOT NULL DEFAULT
   *  0, so "we never observed this PR's size" and "this PR changed nothing" are byte-identical
   *  rows — 18.3% of the dev corpus over all history (though 0 of 758 inside a live 14-day window,
   *  because the state is concentrated in old backfilled rows). A bar that quietly sums 80% of a
   *  repository's PRs is not that repository's line count, and BarChart draws `null` and `0`
   *  identically (both `v <= 0`), so the count has to be DISCLOSED in words rather than implied by
   *  a missing bar. */
  sizedPrs: number;
  unsizedPrs: number;
  /** True when `repos.createdAt >= windowStart` — this repository was added PART-WAY through the
   *  window, so its bars cover less than 14 days of history.
   *
   *  ⚠ MARKED, NEVER PRO-RATED AND NEVER SILENT. Scaling a young repo up to a full window
   *  fabricates pull requests nobody opened; leaving it unmarked draws a newly-onboarded team as
   *  "quiet", which is the retroactive-coverage defect (39→570 merges over six months turned out
   *  to be entirely repo onboarding). A partial bar is an honest count — it just has to say so. */
  addedDuringWindow: boolean;
}

export interface WorkspaceRepoActivity {
  windowDays: number; // always 14 — see `from`/`to`
  from: string; // ISO-8601, inclusive
  to: string; // ISO-8601, exclusive
  /** The repositories that saw at least one PR opened in the window, DESC by `prsOpenedHuman +
   *  prsOpenedAutomation` and capped. Both charts render this array in this order, so the lines
   *  chart is ranked by the PR count too — which is why `omitted` exists. */
  repos: WorkspaceRepoActivityRow[];
  activeRepos: number; // repos with ≥1 PR opened in the window (the M in "N of M")
  workspaceRepos: number; // the workspace's whole membership, active or not
  /** What the cap cut, so the truncation is stated rather than inferred. NO SILENT CAPS: a chart
   *  ranked by PRs opened can drop the repository that leads on lines changed, and a note that
   *  says only "top 12" gives the reader no way to know that happened. */
  omitted: { repos: number; prsOpened: number; linesChanged: number | null };
}

// The workspace flow-metric header (DORA-ish tiles + trend charts) as a standalone CORE/free
// payload, served by /api/workspace-metrics — moved out of the Pro Insights bundle onto Reports.
export interface WorkspaceMetricsResponse {
  metrics: WorkspaceMetrics | null; // null = the workspace has no repos
  /** The resolved scope. Every scoped response echoes it (docs/API.md) so the SPA can correct a
   *  stale bookmark — `?workspace=` resolves an unknown/foreign id to the account's Default rather
   *  than 404ing, and without the echo the client never learns which workspace it is looking at.
   *  This route was the one scoped endpoint missing it. */
  workspaceId: number;
  /** "Where is the work happening?" — absent when the workspace has no repos. Trailing-optional
   *  for the same reason the fields on `WorkspaceMetrics` are: SPA and server deploy
   *  independently. */
  repoActivity?: WorkspaceRepoActivity;
}

// (The "Compare workspaces" surface — `WorkspaceComparisonRow`/`WorkspaceComparisonResponse` and
// `GET /api/workspace-metrics/compare` — was DELETED with its rail entry. Cross-workspace
// comparison now lives inside Reports as the "By workspace" axis: `PeriodByWorkspace` below,
// window-pure period vectors rather than the snapshot WorkspaceMetrics matrix.)

// ---- Period-over-period reporting (the Insights "Reports" sub-tab) ----
// A stored, forwardable artifact for ONE completed period ("18 Aug – 1 Sep"), its comparison
// against the prior one, and a refusable forecast. Metrics are CORE (db/period-metrics.ts);
// the storage, the narration and the routes are plugin-owned.
//
// Two properties make the whole thing hold together, and neither is negotiable:
//
// 1. **Every metric is WINDOW-PURE** — a function of events timestamped in `[fromMs, toMs)` and
//    nothing else. No "as of now" snapshot may enter the vector, because a stored historical
//    period has to stay reproducible and a snapshot is not. That is why `openPrs`,
//    `ciFailingNow`, open-PR age and current thread state are all ABSENT here even though the
//    DORA header above carries them. (Trunk red share is absent for a different reason:
//    `trunk_ci_status_events` has no backfill, so it is not computable for a past period at all.)
// 2. **Retroactive history is systematically biased unless coverage is respected.** Merged-PR
//    counts by 14-day period over the last 6 months read 570, 572, 557, … , 232, 177, 39, which
//    looks like explosive growth; the number of repos CONTRIBUTING to those same periods is
//    18, 19, 18, … , 9, 6, 4. The "trend" is repo onboarding, not team output. Hence
//    `PeriodCoverage`, the stable-subset comparison, and a forecast that refuses rather than
//    fits a line through an artifact.
// ── VERSION 2: the vector stopped describing a blend of people and machines ──────────────────
//
// v1 measured "what happened in this workspace" without asking who did it, and on any workspace
// with real automation that is a different question from the one a reader thinks they are asking.
// Three v1 figures were not thin samples or edge cases — they were wrong about the team:
//
//   • `median_time_to_first_review_hours` read **0h**. It attributed to whoever reviewed FIRST,
//     and `github-actions[bot]` auto-approved 61 of 115 PRs at zero minutes. The human median was
//     **18.3h**. A lead reading 0h concludes review latency is solved.
//   • `median_pr_size_lines` read **68**, a blend of Dependabot's 14 and the humans' 142 —
//     a number no pull request in the workspace resembled, understating human PR size by 2.1×.
//   • `human_review_comments` counted the second row of every duplicated bot identity as a human,
//     because `dependabot` and `dependabot[bot]` are separate user rows and one of each pair sat
//     at `automated = 0`.
//
// So v2 renames the review-latency metric to say whose latency it is, adds the human-only twins
// of the two throughput figures, adds the automation share itself as a first-class trendable
// metric, and moves every bot/human split onto the SAME union automation set the lanes use — so
// the table and the lane panel below it can no longer disagree about who is a person.
//
// The cost was accepted deliberately: bumping the version invalidates every stored comparison,
// because a v1 row's `median_time_to_first_review_hours` and a v2 row's
// `median_time_to_first_human_review_hours` are not the same measurement and must never be
// subtracted from one another. `payloadHashFor` folds this constant, so the bump alone makes
// every stored row stale and the next read regenerates it.
export const PERIOD_METRICS_SCHEMA_VERSION = 2;

export type PeriodMetricKey =
  | 'merged_prs' | 'human_merged_prs' | 'opened_prs'
  | 'automation_merge_share_pct' | 'median_lead_time_hours'
  | 'median_time_to_first_human_review_hours' | 'merge_ci_success_pct'
  | 'median_pr_size_lines' | 'median_human_pr_size_lines' | 'review_threads_opened'
  | 'threads_replied_within_36h_pct' | 'bot_review_comments'
  | 'human_review_comments' | 'bot_comments_per_merged_pr'
  | 'reviewer_concentration_pct';

// CLOSED + ORDERED at schema version 2. This order IS the render order and is part of the
// contract; adding a metric bumps PERIOD_METRICS_SCHEMA_VERSION, and rows stored under an older
// version simply lack the field — which must render "no prior", never 0.
//
// The human-only twin is placed IMMEDIATELY AFTER the blended figure on purpose. Read adjacently,
// `merged_prs 117 / human_merged_prs 71` and `median_pr_size_lines 68 /
// median_human_pr_size_lines 142` state the automation gap without a word of narration; split
// across a table they are two facts nobody joins up.
//
// ⚠ `median_time_to_first_human_review_hours` attributes on the FIRST HUMAN REVIEW's timestamp,
// NOT `openedAt` — deliberately different from the `timeToFirstReviewHours` tile on
// WorkspaceMetrics. Bucketing by open date right-censors a recent window (PRs opened in-window but
// not yet reviewed contribute nothing, biasing the median DOWN); attributing on the review event
// keeps it window-pure and uncensored. It is not a bug and must not be "fixed" into agreement with
// the tile. It also does NOT read `pull_requests.first_review_at`, which is stamped by whichever
// actor reviewed first and is the contaminated column this metric was renamed to escape.
export const PERIOD_METRIC_KEYS: PeriodMetricKey[] = [
  'merged_prs',
  'human_merged_prs',
  'opened_prs',
  'automation_merge_share_pct',
  'median_lead_time_hours',
  'median_time_to_first_human_review_hours',
  'merge_ci_success_pct',
  'median_pr_size_lines',
  'median_human_pr_size_lines',
  'review_threads_opened',
  'threads_replied_within_36h_pct',
  'bot_review_comments',
  'human_review_comments',
  'bot_comments_per_merged_pr',
  'reviewer_concentration_pct',
];

export type PeriodMetricDirection = 'up_good' | 'down_good' | 'neutral';

export interface PeriodMetricValue {
  key: PeriodMetricKey;
  value: number | null;      // null = no data. NEVER render as 0.
  sampleSize: number;        // items behind the statistic (for a count, === value)
  // `sampleSize` is below this metric's floor, so the FIGURE ITSELF is thin — distinct from a
  // `PeriodMetricDelta` being insignificant, which is a statement about the CHANGE.
  //
  // It is computed in core and carried on the wire rather than derived in the SPA, because the
  // floors live in ONE place (`PERIOD_METRIC_META` in db/period-metrics.ts) and a second copy in
  // the frontend would drift the moment one of them was tuned — which is exactly the kind of
  // duplication that has bitten this codebase before.
  //
  // Optional: rows stored before this existed simply carry no opinion, which renders as no marker
  // rather than as a false "sample is fine".
  lowSample?: boolean;
}

// A metric's this-vs-prior comparison. `prior` null means NO PRIOR PERIOD — the UI must
// render that distinctly from "no change" (delta 0).
export interface PeriodMetricDelta {
  key: PeriodMetricKey;
  value: number | null;
  prior: number | null;
  absoluteChange: number | null;   // value - prior; null when either side is null
  percentChange: number | null;    // null when prior is null OR prior === 0
  // True only when ALL of: both periods meet the metric's sample floor, the absolute change
  // meets its absolute floor, and the two periods are coverage-comparable. Otherwise the delta
  // is still CARRIED (the raw figures are real) but the UI must state it without a percentage —
  // a percentage off a tiny base is noise wearing a suit, which this codebase has learned twice.
  significant: boolean;
  direction: PeriodMetricDirection;
  // The CURRENT side's sample is below the metric's floor. Distinct from `significant`, which is
  // about the CHANGE and also weighs the prior side and the absolute floor: a metric can be
  // insignificant on a perfectly healthy sample (it barely moved), and can be thin while still
  // clearing both floors. The row renders `value` from THIS object, so this is the sample that
  // belongs beside it. Optional for rows stored before it existed.
  lowSample?: boolean;
}

// Why a comparison or forecast could not be produced. A NAMED refusal, never a fabricated number.
export type PeriodRefusalReason =
  | 'no_prior_period'
  | 'cadence_changed'
  | 'partial_coverage'
  | 'insufficient_history'
  | 'too_volatile'
  // The periods in the series are NOT EQUALLY SPACED, so a trend line fitted through them would
  // read their own uneven lengths as signal. This is the CALENDAR-MONTH refusal: `db/forecast.ts`
  // fits Theil-Sen on x = the ARRAY INDEX, and calendar months run 28-31 days — a ±5.4% swing in
  // every COUNT metric that the estimator cannot distinguish from a real move, which would make
  // February a genuine-looking dip EVERY YEAR. See PeriodGrain.
  | 'uneven_periods';

/**
 * The two period grains the Reports surface offers, and they COEXIST — sprint is the default.
 *
 *  • `'sprint'` — the ARITHMETIC grid: a configured length in days, phase-anchored to a start
 *    day, so every period is exactly `cadenceDays` long. Keys are `sprint-<YYYY-MM-DD of the
 *    period start, UTC>`.
 *  • `'month'` — the CALENDAR grid: real months aligned to the 1st (UTC), 28-31 days long, with
 *    NO configuration at all. Keys are `month-<YYYY-MM>`, because a `YYYY-MM-DD` start day does
 *    not express a month — two grains writing one key space is how a reader forwards a document
 *    without knowing what it measures.
 *
 * ⚠ THE GRAIN IS A READING CHOICE CARRIED ON THE REQUEST, NEVER A STORED SETTING. Folding it into
 * the sprint-cadence row would silently move the free flow-metrics comparison window on another
 * tab, which nobody asked for by picking a grain on Reports.
 *
 * ⚠ A MONTH ROW STILL CARRIES ITS REAL DAY COUNT in `cadenceDays` (28/29/30/31) — never a
 * sentinel 30 or 0. It is a disclosure on a forwarded artifact and an input to the payload hash;
 * a false day count there is a false claim in a document. What it must NOT be is a comparability
 * test: see `cadence_changed`.
 */
export type PeriodGrain = 'sprint' | 'month';

export interface PeriodCoverage {
  trackedRepos: number;     // repos in scope already tracked at period start
  totalRepos: number;       // repos in scope now
  complete: boolean;        // trackedRepos === totalRepos
}

export type PeriodForecast =
  | { available: true; key: PeriodMetricKey; point: number; low: number; high: number;
      basis: string; periodsUsed: number }
  | { available: false; key: PeriodMetricKey; reason: PeriodRefusalReason };

export interface PeriodMovement {
  key: PeriodMetricKey;
  absoluteChange: number;
  percentChange: number | null;
  rank: number;                 // 0 = biggest mover
  favourable: boolean;          // change is in the metric's good direction
}

export interface PeriodSuggestedQuestion {
  id: string;
  text: string;
  // The pre-bound scope, so selecting a pill needs no re-derivation by the model.
  scope: { metric: PeriodMetricKey; repoIds: number[]; fromMs: number; toMs: number };
}

export interface PeriodReport {
  // `'sprint-' + <period start as YYYY-MM-DD, UTC>`, e.g. 'sprint-2026-08-18'. Sortable,
  // deterministic, and URL-path safe — it travels as a path segment, which is why it is not
  // punctuated with a colon.
  periodKey: string;
  periodStart: string;          // ISO-8601
  periodEnd: string;            // ISO-8601
  // Which grid this period sits on (see PeriodGrain). It is READ FROM THE STORED ROW, never
  // assumed: the column has existed since the table was created and four sites used to hard-code
  // `'sprint'` here, which would have persisted a month row and served it as a sprint one.
  grain: PeriodGrain;
  // The period's length in DAYS. At `'sprint'` grain this is the configured cadence and is the
  // same on every row; at `'month'` grain it is the real length of THAT calendar month (28-31)
  // and legitimately differs between adjacent periods.
  //
  // ⚠ A COMPARISON REFUSES ON GRAIN FIRST, AND ON `cadenceDays` ONLY WITHIN THE SPRINT GRAIN.
  // January is 31 days and February is 28: keying the refusal on the day count alone would make
  // EVERY month-over-month comparison answer 'cadence_changed' — silently, and it is precisely
  // the comparison the grain exists to provide.
  cadenceDays: number;
  coverage: PeriodCoverage;
  // Headline values over the workspace's FULL current membership — that is what the reader
  // means by "this period".
  metrics: PeriodMetricValue[];
  // The like-for-like comparison, recomputed over the COVERAGE-STABLE SUBSET (the intersection
  // of the two periods' tracked repo sets) so the delta is not measuring repo onboarding.
  // `refusal` set and `deltas` empty when no honest comparison is possible.
  comparison: {
    priorPeriodKey: string | null;
    subsetRepoIds: number[];
    subsetDisclosure: string;   // e.g. 'covers 17 of 19 repos tracked across both periods'
    deltas: PeriodMetricDelta[];
    refusal: PeriodRefusalReason | null;
  };
  forecasts: PeriodForecast[];
  // Who did the work — effort vs automation (§ ActorLane). Optional: rows stored before the lane
  // breakdown existed carry none, which renders as an absent panel rather than a false 0%.
  lanes?: PeriodLanes;
  // What the projection was fitted on, e.g. "fitted on the 6 of 8 repos tracked across all 5
  // periods". The forecast series is measured over ONE stable repo subset (a workspace that
  // onboarded a repo last week would otherwise never forecast at all), so the subset has to be
  // stated — a projection over most of the workspace is useful, a projection the reader thinks
  // covers all of it is misleading. Absent when the forecast was refused outright.
  forecastDisclosure?: string;
  movements: PeriodMovement[];
  suggested: PeriodSuggestedQuestion[];
  narrative: string | null;     // markdown; null on a backfilled (un-narrated) period
  model: string | null;
  metricsSchemaVersion: number;
  generatedAt: string;          // ISO-8601
  // The stored `data_fingerprint` no longer matches a recompute — the past moved underneath a
  // report someone may already have forwarded. A stored report is IMMUTABLE once generated: the
  // free GET only sets this flag and offers regeneration, it must NEVER silently regenerate.
  stale: boolean;
  // Served from the ARCHIVE — this artifact was measured under a cadence the workspace no longer
  // runs (or has aged past the look-back horizon), so the live grid cannot name its window.
  // Optional and absent on every live report.
  //
  // ⚠ AN ARCHIVED REPORT IS FROZEN AND CARRIES `stale: false` BY CONSTRUCTION. `stale` exists to
  // offer a REGENERATION, and an archived period cannot be regenerated at all — its window is not
  // on the current grid. A stale badge here would name an action that does not exist. The UI must
  // caption it "kept as generated", never invite a refresh.
  archived?: true;
  // MONTH-TO-DATE: this period is STILL OPEN. Live, computed on the request, and NEVER STORED —
  // there is no row, no `payload_hash`, no narration, no model call and no billing.
  //
  // ⚠ DO NOT "IMPROVE" IT INTO A STORED ROW. Two mechanisms make an open period unstorable:
  // (a) the free cached-read GET recomputes every stored row's data fingerprint, which folds
  //     every metric VALUE — an open month's fingerprint moves on every merge, so the row would
  //     read `stale` on essentially every load, forever, inviting a regenerate each time;
  // (b) `payloadHashFor` folds nothing `Date.now()`-derived on purpose, or a dormant workspace
  //     re-bills on a timer — and an open period's upper bound IS `Date.now()`.
  // `stale` is therefore always false here and the SPA must render no staleness badge and no
  // Generate button; "in progress" is the caption, not "not generated yet".
  inProgress?: true;
  // Whole days elapsed in an open period, for the in-progress caption. Present only with
  // `inProgress`. ⚠ It is clock-derived, so it must never enter a payload hash or a fingerprint —
  // which is structurally impossible here, because an in-progress period is never persisted.
  elapsedDays?: number;
}

// One preserved artifact the CURRENT cadence grid cannot name. It is a POINTER, not the document:
// `archivedKey` (`<periodKey>@cad<days>`) is what the one-report GET reads it back at.
//
// ⚠ NOTHING IS DELETED TO PRODUCE THIS LIST. A stored report stops being listed as a live period
// when the cadence moves or it ages out, and it stops EXISTING only when the account is erased.
export interface PeriodArchivedReport {
  archivedKey: string;
  periodKey: string;
  // The grain it was measured at. Optional/additive — absent means `'sprint'`, which is what
  // every row written before the calendar grain existed is.
  grain?: PeriodGrain;
  periodStart: string;
  periodEnd: string;
  // The cadence it was MEASURED under — not the workspace's current one. This is the number that
  // makes the entry readable: "5 Aug – 19 Aug, 14-day sprint" beside a workspace now on 21 days.
  cadenceDays: number;
  hasNarrative: boolean;
  model: string | null;
  // Why the live grid cannot name it. Two different facts and the reader needs to know which:
  // 'cadence_changed' is a setting somebody made (and can undo); 'outside_history' is age.
  reason: 'cadence_changed' | 'outside_history';
}

export interface PeriodReportListItem {
  periodKey: string; periodStart: string; periodEnd: string;
  cadenceDays: number; hasNarrative: boolean; model: string | null;
  coverageComplete: boolean;
  // ⚠ WHICH GRID THIS PERIOD IS ON. Optional/additive (absent ⇒ `'sprint'`), but the SPA must
  // read it rather than infer one: two grains write the single `insightsReportKey` store field,
  // and a picker whose only distinguishing mark is a date range lets a reader forward a document
  // without knowing whether it measures a fortnight or a calendar month. It also decides the
  // title formatter — a month rendered by the sprint formatter reads "1 Aug – 1 Sep", a
  // 32-day span that does not exist.
  grain?: PeriodGrain;
  // An OPEN period (month-to-date). Live, never stored, never narrated: `hasNarrative` is always
  // false and the detail read goes to the month-to-date route, not to a stored row.
  inProgress?: true;
}

export interface PeriodReportsListResponse {
  enabled: boolean; workspaceId: number;
  // No sprint cadence configured yet ⇒ the surface REFUSES to generate and shows a setup prompt
  // pointing at the sprint setting. There is deliberately no silent fallback to a rolling
  // 14 days: a period the user never chose is not an artifact they will forward.
  cadenceConfigured: boolean;
  periods: PeriodReportListItem[];
  // Optional so a plugin build that predates it still satisfies the type; present on every
  // response the current plugin serves. See PeriodReportModelInfo.
  modelInfo?: PeriodReportModelInfo;
  // The cadence this list was gridded on. Optional/additive. The SPA uses it to say which sprint
  // length these periods are, and to point at the right control when the reader wants to change it.
  cadenceDays?: number | null;
  /**
   * @deprecated ALWAYS `'workspace'` since plugin migration 0031 removed the account-level
   * fallback — every cadence is the workspace's own, so there is no longer another answer. Still
   * emitted (rather than dropped) because the SPA's disclosure reads correctly on the surviving
   * value; DELETE the field and that branch together.
   */
  cadenceSource?: 'workspace' | 'account';
  // The grain this list was gridded on — it echoes the request's `?grain=`, so a client can tell
  // "the server ignored my grain" from "there is nothing at this grain". Optional/additive;
  // absent means `'sprint'`.
  grain?: PeriodGrain;
  // Stored artifacts the current grid cannot name (a retired cadence, or aged past the horizon).
  // Optional and additive; an empty array and an absent field mean the same thing. Listing them
  // separately is what stops a cadence change turning most of the history into clickable rows that
  // open blank — see PeriodArchivedReport.
  archived?: PeriodArchivedReport[];
}

// ---- The Reports "By workspace" axis (C4 — Compare workspaces folded into Reports) ----
// One row per WORKSPACE the account owns, carrying the SAME window-pure 15-key vector the headline
// table renders (`getPeriodMetrics` over that workspace's full membership) — NOT the snapshot
// WorkspaceMetrics matrix the deleted Compare rail entry used, which was not window-pure and would
// have put an "as of now" number under a dated period heading.
//
// ⚠ NO MONEY TRAVELS HERE, AND NONE MAY BE ADDED. A bot's price is a per-workspace fact, so a
// cross-workspace surface can never total it — the vector has no cost key and this row adds none.
//
// ⚠ ONE POPULATION PER ROW: `current` and `prior` for a given workspace are both computed over
// that workspace's FULL membership (there is no coverage-stable subset here). The honesty about
// repos that onboarded mid-window travels as `coverage` — disclosure beside the figures, never a
// silent substitution of a different population into the subtraction.
export interface PeriodWorkspaceRow {
  workspaceId: number;
  name: string;
  isDefault: boolean;
  // Repos tracked at the window's start vs the workspace's membership now — the same shape (and
  // the same annotation duty) as PeriodReport.coverage, per workspace.
  coverage: PeriodCoverage;
  // The full vector in PERIOD_METRIC_KEYS order. An empty workspace yields the all-null vector —
  // still a row (the axis must name it), and every null renders "—", never 0.
  metrics: PeriodMetricValue[];
}

export interface PeriodByWorkspace {
  // Rows for the viewed period, listWorkspaces order (Default first, then by name).
  // EMPTY when `refusal` is set — a refused axis has no honest rows.
  current: PeriodWorkspaceRow[];
  // Rows for the period before it, same order. `null` = no prior period window exists on the
  // cadence grid — which must render as "no prior", never as a column of zeros.
  prior: PeriodWorkspaceRow[] | null;
  priorPeriodKey: string | null;
  // ⚠ THE WHOLE AXIS REFUSES WHEN THE COMPARED WORKSPACES DO NOT SHARE THE VIEWED WORKSPACE'S
  // SPRINT CADENCE. The axis hands ONE window to every workspace; a team on a 7-day sprint
  // measured over a 14-day window contributes roughly double its per-sprint throughput to a
  // column headed "this period". `cadence_changed` is reused rather than given a new member —
  // it already means "measured over different-length windows, do not subtract".
  //
  // ⚠ IT REFUSES WHOLESALE RATHER THAN DROPPING THE MISMATCHED ROWS. Silently restricting the
  // table's membership would make one team's Reports change shape because ANOTHER team edited
  // their sprint length — a surface mutating for a reason its reader cannot see.
  refusal?: PeriodRefusalReason;
  // Which workspaces diverge, named so the reader can act without opening Settings for each one.
  // Names and cadences only; there are no figures to give. Present only alongside `refusal`.
  refusalWorkspaces?: { workspaceId: number; name: string; cadenceDays: number | null }[];
}

export interface PeriodReportResponse {
  enabled: boolean; workspaceId: number; report: PeriodReport | null;
  modelInfo?: PeriodReportModelInfo;
  // The "By workspace" axis, computed LIVE on this GET (never stored on the report row — a stored
  // report predating the axis still renders, and the axis reflects today's workspace roster).
  // OPTIONAL and additive: an older plugin omits it, an older client ignores it. Omitted when the
  // account owns fewer than two workspaces (one row compares nothing) and when there is no report.
  byWorkspace?: PeriodByWorkspace;
}

export interface PeriodReportGenerateResponse {
  enabled: boolean; workspaceId: number;
  report: PeriodReport | null;
  generated: boolean;                  // false = served from cache, $0
  creditsExhausted?: boolean;
  cadenceMissing?: boolean;
  // What the run ACTUALLY cost, from the server's own metering — the receipt that sits beside the
  // pre-flight quote. Absent on a cached ($0) or credit-blocked generation, both of which spend
  // nothing, so its absence is meaningful and must not render as a zero charge.
  spend?: PeriodReportSpend;
}

export interface PeriodReportSpend {
  model: string; credits: number; usd: number;
  inputTokens: number; outputTokens: number;
}

export interface PeriodChatTurn { question: string; answer: string; createdAt: string; }
export interface PeriodChatResponse {
  enabled: boolean; answer: string; creditsExhausted?: boolean;
}

// Estimated spend BEFORE the user presses generate, shown next to the model selector — a model
// switch that silently costs 5× is a support ticket. The ACTUAL spend is reported after the run.
export interface PeriodReportCostEstimate {
  model: string; estimatedCredits: number; estimatedUsd: number;
}

// The model selector's state, carried on BOTH free GETs.
//
// ⚠ THE QUOTE IS SERVED, NEVER RECOMPUTED CLIENT-SIDE. Both halves of it — the per-model token
// prices and the typical prompt size — are the SERVER's, and the first cut of this feature had the
// SPA hold its own copy of both: two price tables and two token envelopes (6000/900 against the
// server's 4000/1100) quoting 13 and 39 credits for the very clicks the server priced at 12 and 36.
// Neither number was wrong by much and neither could ever be checked against the other, which is
// the failure mode: a duplicated constant that only manifests as a slightly-off promise about
// money. The SPA renders `estimates` verbatim and adds a friendly label per id.
export interface PeriodReportModelInfo {
  // The account's effective default (pro_settings.report_model, else the deployment's default).
  model: string;
  // Selectable models, cheapest first, each with its pre-flight quote.
  estimates: PeriodReportCostEstimate[];
}

// ---- Comment-validity assessment (Pro; reuses the prSummary capability) ----
// A Haiku "is this review comment valid, given the thread + diff context?" assessment,
// keyed to a review thread's ORIGINATING (root) comment and retained after generation.
// `verdict` is a short at-a-glance label; `assessment` is the full Markdown rationale
// (critical but not dismissive). One row per (account, root comment).
export type CommentAssessmentVerdict =
  | 'valid' // the comment holds up — worth acting on
  | 'partly' // partially valid / needs nuance or scoping
  | 'weak' // shaky — likely a false positive / low value
  | 'unclear'; // not enough context to judge

export interface CommentAssessment {
  threadId: number;
  commentId: number; // the root comment the assessment is about
  verdict: CommentAssessmentVerdict;
  assessment: string; // Markdown rationale
  model: string;
  generatedAt: string; // ISO-8601
}

// GET /api/pro/threads/:id/assessment and its POST refresh. `enabled` false = capability off;
// `creditsExhausted` mirrors the other AI gates; `noAuth` = no resolvable Claude/Anthropic auth.
export interface CommentAssessmentResponse {
  enabled: boolean;
  assessment: CommentAssessment | null;
  creditsExhausted?: boolean;
  noAuth?: boolean;
}

// ── Pro: "was this thread / PR comment TRULY addressed?" check ───────
// A Haiku verdict on whether the concern a review thread or PR-level comment raised was actually
// resolved by later changes — the SEMANTIC layer above the deterministic addressedConfidence
// (Part A). Works for review threads (bot OR human) AND PR-level comments (which carry no
// derivedState at all). One row per (account, targetKind, targetId), retained + $0-on-unchanged.
export type AddressedVerdict =
  | 'addressed' // clearly resolved by a later change
  | 'likely' // probably resolved, some uncertainty
  | 'partial' // partially addressed
  | 'not_addressed' // no evidence the concern was handled
  | 'unclear'; // insufficient context to judge

export const ADDRESSED_VERDICTS: AddressedVerdict[] = [
  'addressed',
  'likely',
  'partial',
  'not_addressed',
  'unclear',
];

export type AddressedTargetKind = 'thread' | 'pr_comment';

export interface AddressedCheck {
  targetKind: AddressedTargetKind;
  targetId: number; // reviewThreads.id (thread) or prComments.id (pr_comment)
  prId: number;
  verdict: AddressedVerdict;
  confidence: number; // 0-100
  rationale: string; // Markdown
  model: string;
  generatedAt: string; // ISO-8601
}

// GET /api/pro/threads/:id/addressed | /api/pro/pr-comments/:id/addressed and their POST refresh.
export interface AddressedCheckResponse {
  enabled: boolean;
  check: AddressedCheck | null;
  creditsExhausted?: boolean;
  noAuth?: boolean;
}

// PR-wide batch (one item at a time). The rollup answers "can I safely resolve these?".
export interface AddressedCheckSummary {
  addressed: number;
  likely: number;
  partial: number;
  not_addressed: number;
  unclear: number;
}
export interface PrAddressedCheckResponse {
  enabled: boolean;
  prId: number;
  checks: AddressedCheck[];
  summary: AddressedCheckSummary;
  creditsExhausted?: boolean;
  noAuth?: boolean;
  generatedAt: string;
}
// SSE progress events for the PR-wide batch (mirrors the digest refresh stream).
export type AddressedCheckProgress =
  | { type: 'start'; total: number }
  | {
      type: 'item';
      targetKind: AddressedTargetKind;
      targetId: number;
      verdict: AddressedVerdict;
      confidence: number;
      done: number;
      total: number;
    }
  | { type: 'error'; message: string }
  | {
      type: 'done';
      summary: AddressedCheckSummary;
      creditsExhausted?: boolean;
      noAuth?: boolean;
    };

// ---- AI usage tracking (Pro; transparency) ----
// The two AI seams are metered DIFFERENTLY:
//  - SUMMARY (cheap one-shot Haiku completions — digests, sprint report, insights chat, PR
//    summary, CI analysis, themes) is metered by a monthly TURN COUNT: N summaries/month,
//    reset at the UTC month boundary. Each real (billed) completion is one turn; a $0 cache
//    hit doesn't count. The paid plan default is 500 turns/mo (~$5 of Haiku).
//  - AGENTIC (Agent-SDK runs — Claude Review, AI Fix) is metered by CREDITS ($ cost), because a
//    single run's cost varies wildly. Cost is tracked in USD server-side but NEVER surfaced as
//    dollars — only as CREDITS (conversion below). The paid plan default is a $15/mo allowance.
// Covers ALL usage on the account, including work outside the active workspace.
export const AI_CREDITS_PER_USD = 1250; // $1 of model cost = 1250 credits (1 credit ≈ $0.0008)

// The per-seam month-to-date balances. A null limit/allowance = unmetered (local / unlimited);
// the UI shows no meter for that seam. Shared by AiUsageResponse and MeResponse.aiUsage so the
// login fetch and the Track-usage panel agree on the same numbers.
export interface AiUsageBalances {
  // SUMMARY seam — monthly TURN budget.
  summaryTurnsUsed: number;
  summaryTurnLimit: number | null;
  summaryTurnsRemaining: number | null;
  // AGENTIC seam — monthly CREDIT budget.
  agentCreditsUsed: number;
  agentAllowanceCredits: number | null;
  agentCreditsRemaining: number | null;
}

export interface AiUsageResponse extends AiUsageBalances {
  enabled: boolean;
  monthStart: string; // ISO-8601 — start of the current calendar month (the MTD window)
}

// ---- Sprint report (Pro; Haiku summary of the Insights, gated on activityDigest) ----
// A single cross-repo report generated from the current Insights state: headline
// metrics + prioritised, PR-linked issues, with repos ranked by activity + code volume.
// Tied to the Insights via `stale` (the Insights changed since it was generated →
// regenerate). PRs are referenced as `owner/name#N` and resolved via `prRefs`.
export interface SprintReport {
  summary: string; // markdown: headline metrics then bulleted, prioritised issues
  prRefs: DigestPrRef[]; // PRs referenced in the summary (cross-repo `owner/name#N`)
  model: string;
  generatedAt: string; // ISO-8601
  costUsd: number | null;
  stale: boolean; // the Insights changed since this was generated
  sprint: { from: string; to: string };
}

// REMOVED: `RetroReport` / `RetroReportResponse` — the Insights "Retro" sub-tab, its route
// (`/api/pro/insights/retro`), its generator and its `retro_reports` cache table are gone
// (plugin migration 0018 drops the table). The retrospective is now a quick-question PILL on
// the grounded Insights chat, which answers from the SAME chat payload every other pill uses.
//
// The one capability that did NOT survive the fold is Themes + Sentiment: those needed the
// retro's own 50-item corpus of raw comment/review bodies, which the chat payload does not
// carry. Discussion themes already have a home in the Feed's Pro "Themes" tab, so the pill's
// prompt deliberately does not ask for them.
//
// Historical `ai_usage` rows with `feature = 'retro_report'` survive on purpose — that money
// was really spent and must keep counting toward month-to-date credits (the column is free
// text, so a removed feature needs no migration).

export interface SprintReportResponse {
  enabled: boolean; // false when the AI digest capability is off
  model: string;
  report: SprintReport | null; // null = not generated yet (or nothing to report right now)
  // True when a refresh request was served from cache because it hit the per-account
  // throttle / in-flight guard (a regeneration ran < MIN_INTERVAL_SEC ago). Lets the client
  // explain a no-op "Regenerate" ("refreshed moments ago") instead of it reading as broken.
  throttled?: boolean;
  // True when the account's month-to-date credit allowance is spent (metered cloud plan): the
  // refresh was skipped without billing, any cached `report` still renders, and the client
  // disables Generate/Regenerate with an "out of AI credits" message.
  creditsExhausted?: boolean;
}

// ---- Claude Review learnings / memory (Workstream 3; @pierre/pro, flagged) ----

// The 9 captured action kinds (see PRO-PLATFORM.md §5.2).
export type ReviewLearningKind =
  | 'finding_dismissed'
  | 'finding_kept'
  | 'finding_reworded'
  | 'finding_reword_cleared'
  | 'finding_posted'
  | 'review_body_rewritten'
  | 'verdict_overridden'
  | 'review_posted'
  | 'run_requested';

// One aggregated retrieval signal shown BEFORE a run ("Matches from past reviews").
export interface LearningMatch {
  glob: string;
  category: string | null;
  kind: string;
  summary: string;
  confidence: 'low' | 'medium' | 'high';
  example?: { claude?: string | null; you?: string | null };
  // Provenance/transparency (for the "what feeds the next review" surface): how many raw
  // captured actions this signal aggregates, when the most recent one landed, and the
  // per-kind breakdown. Optional so an older plugin build still satisfies the type.
  count?: number;
  lastActionAt?: string | null; // ISO-8601
  kinds?: { kind: string; count: number }[];
}

export interface ReviewLearningsResponse {
  enabled: boolean;
  matches: LearningMatch[];
  // The VERBATIM markdown block that will be injected into the next review's prompt as
  // `priorReviewContext` — byte-identical to what the plugin sends to Claude, so the UI can
  // show "exactly what feeds the next review". null when there's nothing to inject.
  contextBlock?: string | null;
}

// One raw captured action, for the per-review action log (Surface 2).
export interface ReviewAction {
  id: number;
  kind: ReviewLearningKind;
  category: string | null;
  path: string | null;
  glob: string | null;
  claudeText: string | null;
  userText: string | null;
  claudeVerdict: ClaudeReviewVerdict | null;
  userVerdict: ClaudeReviewVerdict | null;
  postedCommentKind: string | null;
  createdAt: string; // ISO-8601
}

export interface ReviewActionsResponse {
  actions: ReviewAction[];
}

// ---- Default-branch status (CORE, no AI) -------------------------------------------------
//
// "Is trunk green?" — the question every PR view sidesteps, because everything else in this
// app is PR-shaped. A broken default branch invalidates every open PR's CI at once, so it
// gets its own strip rather than being inferred from PR checks.

// One FAILING check on a default-branch commit. Deliberately the PR side's `CheckRun` shape
// plus ONE field, rather than a second check vocabulary: `state` is the same `CheckRunState`,
// so the frontend renders a trunk failure with the same icon/colour/label metadata it uses for
// a PR failure, and `runId`/`jobId` are parsed from the same Actions `detailsUrl` shape (so a
// future "trunk failure logs" viewer needs no migration and no new type).
//
// `workflowName` is the GitHub Actions workflow the check belongs to ("CI", "Release"), i.e.
// how a human actually names the failure. Null in two real cases: a legacy StatusContext
// (third-party CI posting a bare commit status has no workflow at all) and a CheckRun whose
// check suite isn't an Actions run. Never inferred — null means "GitHub didn't give us one".
export interface BranchCheckRun extends CheckRun {
  workflowName: string | null;
}

// One trunk commit inside a BranchMergedPr's consolidation — just enough for the PR row's
// tooltip ("what landed"): the sha and the headline. Newest first within the PR.
export interface BranchMergedPrCommit {
  sha: string;
  messageHeadline: string;
}

// One PR merged into the default branch, CONSOLIDATING its retained trunk commits — the unit
// the expanded branch row lists (the per-commit list it replaced lives on only as this PR's
// tooltip). Grouped from `branch_commits.prNumber` (GitHub's `associatedPullRequests`, one
// number picked deterministically per commit), so a squash-merged PR carries one commit and a
// merge-commit PR carries several.
export interface BranchMergedPr {
  // The PR number, always present (a group only exists for commits WITH a number — direct
  // pushes are chart-only, never listed).
  prNumber: number;
  // The LOCAL `pullRequests.id`, resolved per request within (accountId, repoId) — a PR number
  // is unique only WITHIN a repo, so it is never resolved by number alone. Null means "that PR
  // isn't synced for this account" (squash-merged before the backfill window, or a repo added
  // later): the client links out to github.com rather than dropping the reference.
  prId: number | null;
  // From the synced PR row; null when unresolved (the client falls back to the newest commit's
  // headline).
  title: string | null;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  // The PR row's mergedAt when resolved, else the newest consolidated commit's committedAt —
  // never null, so "in the order they were merged" is always well-defined. ISO-8601.
  mergedAt: string;
  // The NEWEST consolidated trunk commit's rollup — for a merge-commit PR that is the merge
  // commit itself, i.e. the trunk state this PR produced.
  ciStatus: CiStatus;
  // Newest first. What the tooltip lists.
  commits: BranchMergedPrCommit[];
}

// One repo's default-branch health. Everything is nullable-until-synced: a freshly added repo
// has a row with no branch data, and rendering "unknown" is correct there.
export interface RepoBranchStatus {
  repoId: number;
  branchName: string | null;
  headSha: string | null;
  ciStatus: CiStatus;
  lastCommitAt: string | null; // ISO-8601
  // The HEAD commit's failing checks, DERIVED server-side from the `commits` entry whose sha is
  // `headSha` — deliberately NOT a second stored copy, so there is one writer, one reader and
  // one invariant. Drives the repo row's inline "failing · build +2" summary.
  //
  // Empty when trunk is green, when nothing has synced yet, or when the head's rollup reported a
  // failure but its individual checks weren't retrievable. Also empty in the rare case where the
  // head commit's row fell outside the stored window (a rebase with a backdated committer date),
  // which degrades to today's behaviour: the CI label alone.
  failingChecks: BranchCheckRun[];
  // The most recently merged PRs on this branch (merge order, newest first), capped
  // server-side — each consolidating its retained trunk commits. Empty until the first branch
  // sync, and empty for a branch that only ever sees direct pushes (those stay visible in the
  // trend chart's cells; they are deliberately not listed).
  mergedPrs: BranchMergedPr[];
}

// GET /api/branch-status?repoIds= — one entry per repo in scope (repos with no synced branch
// data still appear, with nulls, so the strip's row count matches the repo list).
export interface BranchStatusResponse {
  repos: RepoBranchStatus[];
}

// One UTC day of trunk history, on ONE shared axis: `failed` = trunk commits that day with a
// red rollup ('failure'/'error'), `passed` = commits with a 'success' rollup (pending/unknown
// count as neither — the cells split red-over-green by these two), and `merged` = PRs merged
// into the default branch that day (the line band above the cells; a null base is excluded —
// it is not evidence the PR landed on trunk, and an unknown default branch name yields a
// flat-zero line rather than a guess).
export interface BranchTrendDay {
  day: string; // 'YYYY-MM-DD' (UTC)
  failed: number;
  passed: number;
  merged: number;
}

// GET /api/branch-trends?repoId= — the ONE lazy per-day series behind an expanded
// default-branch row (rendered as a single coverage-style strip: failure cells + merged-PRs
// line). Fetched only on expand, never part of /api/branch-status (which stays lean: the
// strip is a hot workspace-wide read; this covers the WIDER retained window the sync keeps
// for exactly this endpoint).
//
// `daily` is DENSE from the oldest RETAINED commit's day to today — not padded back to the
// full 90 days, because on a busy repo the commit-count cap can trim inside the date window,
// and days before the oldest retained commit are trimmed history, not quiet days. The merged
// line is truncated to the SAME span on purpose (alignment is the point of the shared axis).
// Empty until the repo has been branch-synced.
export interface BranchTrendsResponse {
  repoId: number;
  daily: BranchTrendDay[];
}

// ---- Comment annotations platform (Pro; plugin-owned storage) ------------------------------
//
// The generalisation of the one-off `comment_assessments` table: any AI judgement ABOUT a
// review comment/thread, keyed uniformly by (kind, targetKind, targetId) so a new judgement
// type is a new `kind` rather than a new table + route + hook. The rows live in the plugin's
// `pr_comment_annotations`; these are only the wire shapes.
//
//   addressed — was the concern actually dealt with by later changes?
//   validity  — is the comment itself well-founded, given the thread + diff? (the old
//               comment_assessments; its rows are backfilled into this table)
//   simplify  — could the change this comment asks for be made simpler / smaller?
export type AnnotationKind = 'addressed' | 'validity' | 'simplify';

// What an annotation hangs off. `targetId` is that entity's own primary key:
//   thread         → reviewThreads.id
//   review_comment → reviewComments.id
//   pr_comment     → prComments.id
export type AnnotationTargetKind = 'thread' | 'review_comment' | 'pr_comment';

// A RUN kind — deliberately NOT an `AnnotationKind`, and the distinction is load-bearing.
//
// `AnnotationKind` is the STORED discriminator: it is the `kind` column, the per-kind payload-hash
// cache, the `counts` map, the `kinds=` filter on the cached GET, and the key of every per-kind
// prompt/vocabulary record in the plugin. `'review'` is none of those things — it asks for ONE
// combined model call per target that returns all three judgements at once, and it writes the SAME
// rows a run of each kind would write. So there is no `review` row, no `review` payload hash and
// no `counts.review`: a combined run and three separate runs are INDISTINGUISHABLE in storage,
// which is exactly what keeps each kind's staleness (and its $0-on-unchanged cache) independent.
export type AnnotationRunKind = AnnotationKind | 'review';

// One anchor a run may be narrowed to — the per-thread / per-comment "check this one" button, as
// opposed to a whole-PR sweep.
//
// The anchor is the ENTITY THE USER CLICKED, not the row that gets written: for a review thread it
// is `{'thread', reviewThreads.id}` even though the run also writes rows keyed on that thread's
// ROOT `reviewComments.id`. Absent or empty on the request body means the whole PR.
//
// TWO RULES GOVERN HOW THE SERVER APPLIES THIS, and getting either wrong is a silent bug rather
// than an error:
//
// 1. EXPANSION — an anchor selects every enumerated target BELONGING to it, not the one whose ids
//    happen to match. The three kinds key their rows on DIFFERENT pairs for the same thread:
//    `addressed` on `('thread', threadId)`, `validity` on the thread's ROOT `('review_comment', id)`,
//    and `simplify` on `('review_comment', id)` for EVERY comment in the thread. So an equality
//    match on `(targetKind, targetId)` finds only the `addressed` target: a "Check review" on one
//    thread would report `generated: 1`, render a single chip, and silently produce neither a
//    validity nor a simplify verdict — with no error to notice. A `{'thread', T}` anchor therefore
//    selects `('thread', T)` PLUS every `('review_comment', C)` whose comment C sits in thread T.
//    `{'pr_comment', P}` and `{'review_comment', C}` select just themselves.
//
// 2. INTERSECTION ONLY — `targets` is a POST-FILTER over the targets enumerated from the
//    already-account-scoped PR corpus. It is NEVER a fetch key: nothing may be loaded BY these
//    ids. They arrive from the client, and a "load the named targets" implementation would let
//    `{'review_comment', <another tenant's comment id>}` on a PR I own read a foreign comment
//    body, spend my credits summarising it, and store the result where my own cached GET serves
//    it back. An anchor matching nothing in the corpus is counted `skipped`, never fetched.
export interface AnnotationRunTarget {
  targetKind: AnnotationTargetKind;
  targetId: number;
}

// One stored judgement. `verdict` is kind-specific free text (the client maps it to a chip),
// `confidence` is 0-100 or null when the kind doesn't produce one, `body` is markdown
// rationale. `stale` is computed on READ: the target has changed since the annotation was
// generated (a newer reply, a newer commit), so the verdict may no longer hold.
export interface CommentAnnotation {
  kind: AnnotationKind;
  targetKind: AnnotationTargetKind;
  targetId: number;
  prId: number;
  verdict: string | null;
  confidence: number | null;
  body: string;
  model: string;
  /**
   * The GROUNDING DIFF the verdict was actually judged against, as the JSON written by the
   * plugin's `annotations/evidence.ts#encodeEvidence`:
   *   {"v":1,"baseSha":…,"headSha":…,"path":…,"outcome":"changed"|"untouched"|"unavailable",
   *    "patch":…|null,"previousPath":…|null,"note":…|null}
   *
   * Populated for `addressed` on a THREAD target only — that is the one judgement about later
   * code. Every other row stores null (a PR-level comment has no file anchor; simplify/validity
   * judge the comment, not the code that followed it), as does any row written before the
   * plugin's migration 0022.
   *
   * OPTIONAL because it is produced by the private plugin: a core-only (OSS) build serves
   * annotations routes that never set it, and rows predating 0022 have nothing to show.
   */
  evidence?: string | null;
  createdAt: string; // ISO-8601
  stale: boolean;
}

// GET /api/pro/prs/:id/annotations?kinds= — every annotation the account holds for one PR.
// `counts` is per-kind over the returned set (every AnnotationKind is present, 0 when none),
// `staleCount` is how many of them are stale.
export interface PrAnnotationsResponse {
  prId: number;
  annotations: CommentAnnotation[];
  counts: Record<AnnotationKind, number>;
  staleCount: number;
  generatedAt: string; // ISO-8601 — when this response was assembled
}

// POST /api/pro/prs/:id/annotations/run — generate across a PR. `kind` is a RUN kind, so it can
// be one `AnnotationKind` or `'review'` (all three in one call per target — see
// `AnnotationRunKind`). `targetKinds` narrows which entity TYPES to consider (default: all
// three); `targets` narrows to specific anchors (one thread, one comment) and is what the
// per-item "Check review" button sends.
//
// An absent/empty `targets` still MEANS the whole PR on the wire — the server contract is
// unchanged — but no UI sends that any more: the PR-wide sweep bar was removed, so in practice
// every run is one anchor. Keep the whole-PR path working; it is what `planRun`'s
// `anchors.length === 0` branch covers and what the run-gate clock still bounds.
//
// REMOVED: `onlyStale`. It only ever had one sender (the sweep bar's "Re-check stale" control),
// and with the bar gone there is no surface that asks for "just the ones that moved" — the
// per-item button always re-checks exactly what was clicked. A client that still posts the field
// is now silently ignored rather than honoured, which is the acceptable failure here (the run it
// gets is a superset of the one it asked for, and the payload-hash cache makes the unchanged
// targets free anyway).
export interface AnnotationRunBody {
  kind: AnnotationRunKind;
  targetKinds?: AnnotationTargetKind[];
  targets?: AnnotationRunTarget[];
}

// The outcome of a run. `cached` = a payload-hash hit ($0); `skipped` = ineligible targets
// (nothing to judge); `truncated` = the per-run target cap was hit, so a second run would do
// more; `creditsExhausted` = the metered plan ran out mid-run and the rest was refused.
//
// The counting UNIT differs by run kind, which matters when a caller sums across runs: a per-kind
// run counts TARGETS, which is exactly one stored row each; a combined `'review'` run also counts
// targets (a thread or a comment), but each one is up to THREE rows. So `generated` is "how many
// things did we judge", never "how many rows did we write".
export interface AnnotationRunResponse {
  kind: AnnotationRunKind;
  requested: number;
  generated: number;
  cached: number;
  skipped: number;
  failed: number;
  truncated: boolean;
  creditsExhausted: boolean;
  // No usable Anthropic credential, so the run returned before billing anything. This is a
  // SUCCESSFUL 200 carrying zero work — the run was refused, not attempted and failed, so
  // `failed` stays 0 and there is nothing in the other counters to distinguish it from
  // "everything was already cached". Without this flag the button can only say "nothing was
  // produced", which reads as a broken feature rather than an unconfigured one; the client
  // infers the difference from counters otherwise, and an inference is not something to make a
  // user act on. Optional so an older plugin build simply omits it.
  noAuth?: boolean;
}

// ── ML severity + category enrichment of bot comments (CORE, free tier) ──────────────────
//
// Labels produced by the `severity-api` microservice (the sibling `pierre-ml` repo): a
// fine-tuned ModernBERT-ONNX severity classifier plus a deterministic multi-label category
// parser. The backend calls it during a background enrichment pass over BOT-authored text
// (see docs/ML-SEVERITY.md); nothing here is generated by an LLM and nothing here is billed.
//
// AVAILABILITY: free tier, but only where the service is reachable — cloud (Railway private
// networking) and a local dev checkout running the sibling repo. It is DARK under
// `npx pierre-review`, which has no model to talk to. The SPA reads `MeResponse.mlSeverity`
// rather than inferring it.

// Severity, LOWERCASED at the wire boundary so it reads like every other union in this file
// (the service itself answers `NIT | MINOR | MAJOR | CRITICAL`). Ordered nit → critical;
// `MlSeverityOrd` is the service's own 0..3 ordinal, kept for thresholding without a lookup.
export type MlSeverity = 'nit' | 'minor' | 'major' | 'critical';
export const ML_SEVERITIES: MlSeverity[] = ['critical', 'major', 'minor', 'nit'];

// The service's NINE fixed categories, verbatim. Deliberately NOT `BotThemeCategory`
// (LLM-authored, a different vocabulary): conflating them would silently mix a
// deterministic marker parse with a Haiku theme judgement in the same chart.
// `praise` (added with severity-api v2, 2026-08) marks a NON-FINDING — the bot
// acknowledging a fix, confirming a resolution, withdrawing a concern, or pure thanks.
// Praise rows must be excluded from severity-weighted views (like summaries are).
export type MlCategory =
  | 'correctness_bug'
  | 'security'
  | 'performance'
  | 'style_readability'
  | 'maintainability_refactor'
  | 'testing'
  | 'documentation'
  | 'nitpick'
  | 'praise';
export const ML_CATEGORIES: MlCategory[] = [
  'correctness_bug',
  'security',
  'performance',
  'style_readability',
  'maintainability_refactor',
  'testing',
  'documentation',
  'nitpick',
  'praise',
];

// What a label hangs off. `targetId` is that entity's own primary key:
//   review_comment → reviewComments.id
//   pr_comment     → prComments.id
//   review         → reviews.id            (the review BODY — a bot's summary verdict)
// NOTE this is NOT `AnnotationTargetKind`: that union has `thread` and no `review`, and the
// two id spaces do not overlap. A badge that looks a review id up as a pr_comment finds the
// wrong row, so the unions stay separate.
export type MlLabelTargetKind = 'review_comment' | 'pr_comment' | 'review';

// How sure the service's deterministic marker reader is that it read a REAL vendor-declared
// severity badge, rather than inferring one from surrounding prose. Metadata about
// `MlLabel.vendorSeverity` only — it says nothing about our own severity's confidence, which
// is `severityProb`.
export type MlVendorConfidence = 'high' | 'medium' | 'low';

export interface MlLabel {
  targetKind: MlLabelTargetKind;
  targetId: number;
  severity: MlSeverity;
  // 0..3, nit → critical. The service's own ordinal; use it for thresholds/sorting.
  severityOrd: number;
  // Confidence in the CHOSEN class, 0..1. Advisory — see docs/ML-SEVERITY.md on CRITICAL recall.
  severityProb: number;
  // ── THE BOT'S OWN CLAIM, not ours. Show it, never derive from it. ─────────────────────
  // The severity the review bot declared for ITSELF in its own markup — CodeRabbit's "Major"
  // badge and the equivalents — as read by the service's deterministic marker parser. `null`
  // whenever the vendor declared nothing (the common case) and equally when the deployed
  // severity-api is an older build that does not report it; the two are indistinguishable
  // here and neither needs distinguishing, because both render as "no vendor claim".
  //
  // ⚠ THIS IS THE LESS ACCURATE NUMBER OF THE TWO ON THIS OBJECT. Measured on
  // `gold_v2_sample` (300 comments, fresh label-free adjudication, marker-stratified, held out
  // properly): our `severity` scores 0.700 exact / 0.303 ordinal MAE, the vendor's own badge
  // 0.474 / 0.697. So this is advisory ONLY — nothing may correct, override, seed or fall back
  // our `severity` from it, and no rollup may count it. It exists so a UI can put the two side
  // by side ("CodeRabbit: Major · Pierre: Minor"), because the DISAGREEMENT is the product.
  vendorSeverity: MlSeverity | null;
  // The marker reader's confidence in the line above — `null` alongside a null claim, and also
  // when an older service reports the claim without a confidence. Never a confidence in OUR
  // label; that is `severityProb`.
  vendorSeverityConfidence: MlVendorConfidence | null;
  // Multi-label; never empty (the parser falls back to a single best guess).
  categories: MlCategory[];
  // PR-walkthrough / summary comment rather than a specific finding. A separate axis, NOT a
  // category — a summary still gets a severity, and excluding summaries is what makes the
  // "findings" counts mean anything.
  isSummary: boolean;
  // Which backends served it, verbatim from the service. A value WITHOUT `modernbert-onnx`
  // means the model was not loaded and the marker heuristic answered — surfaced so a
  // degraded deployment is visible rather than silently lower-quality.
  backend: string;
  modelVersion: string;
  createdAt: string;
}

// The ONE per-PR index every badge reads (mirrors PrAnnotationsResponse). Cached with
// staleTime Infinity: N cards on a PR share one request, and a target with no label renders
// nothing and issues nothing.
export interface PrMlLabelsResponse {
  prId: number;
  labels: MlLabel[];
  generatedAt: string;
}

// ── Bots interface: the high-level severity rollup ──────────────────────────────
// FINDINGS ONLY — walkthrough/summary comments are counted by `summaries`, never here, so these
// four always sum to the matching `findings` count. Every rate in this payload divides by
// findings, so folding summaries in would let a share exceed 100%.
export interface MlSeverityCounts {
  nit: number;
  minor: number;
  major: number;
  critical: number;
}

export interface MlBotSeverityRow {
  // 'u<userId>' — the same reviewer key the ROI/behaviour rows use, so a row joins to them.
  reviewerKey: string;
  userId: number;
  login: string;
  // Display name override, else the vendor brand, else the login (resolved server-side).
  label: string;
  kind: AutomatedReviewerKind | null;
  // Every label for this bot: findings, summaries AND praise. `bySeverity` covers the
  // findings only, so it sums to `labelled - summaries - praise`.
  labelled: number;
  bySeverity: MlSeverityCounts;
  // MAJOR + CRITICAL as a share of this bot's FINDING labels, 0..1. Bucketing the top two
  // is deliberate: the model under-recalls CRITICAL alone (docs/ML-SEVERITY.md § accuracy).
  highShare: number;
  summaries: number;
  // v2 non-finding class: acknowledgments/withdrawals/thanks. Excluded from bySeverity and
  // highShare for the same reason summaries are.
  praise: number;
  // Descending by count, capped server-side. Summary comments are excluded.
  topCategories: Array<{ category: MlCategory; count: number }>;
}

export interface BotSeverityResponse {
  workspaceId: number;
  // The repos actually covered. `[]` means "this workspace is empty", which is a real state
  // and not the same as "no data".
  repoIds: number[];
  // False when the ML service is not configured for this deployment — the panel renders an
  // explanatory note instead of an empty chart.
  enabled: boolean;
  // Coverage: how much of the bot corpus in scope has been labelled yet. The enrichment is a
  // background sweep, so a fresh install is legitimately partial and must SAY so rather than
  // presenting a partial rollup as complete.
  labelled: number;
  pending: number;
  // Bot rows with NO stored body (lean-storage-window legacy) — permanently outside `pending`
  // and the worker's reach until repaired (hydration write-back / `pnpm ml:backfill-bodies`).
  // Counted separately so "pending 0" cannot claim 100% coverage while badges are missing.
  unscorable: number;
  totals: {
    bySeverity: MlSeverityCounts;
    byCategory: Array<{ category: MlCategory; count: number }>;
    summaries: number;
    praise: number;
    findings: number;
  };
  rows: MlBotSeverityRow[];
  // Distinct `backend` strings seen in scope. Non-empty and lacking `modernbert-onnx` on every
  // entry means the whole corpus was labelled by the marker fallback.
  backends: string[];
  // The rollup reads a bounded window of the corpus (newest labels first). True when that bound
  // was HIT, so the numbers below it are a sample rather than the whole picture — said out loud
  // rather than presented as a total, which is the same honesty rule as `pending`.
  truncated: boolean;
  generatedAt: string;
}

// ── "What the bots are flagging" — the drill-down behind the ML totals strip ─────────────
//
// Every tile and chip on the Bots rail's ML strip opens the SAME route with a different
// selector. The one hard requirement of this contract is that the drill-down's `total` IS the
// tile's number — not an independently-derived count that happens to agree. That is why the
// selector arms below name POPULATIONS of the strip's own windowed label scan rather than SQL
// predicates: the strip's buckets are a JS fold over a JSON `categories` column that no
// portable SQL predicate can express (see docs/ML-SEVERITY.md), so the only way the two agree
// is to run the identical scan and the identical fold, then slice.

// Severity ordinals, shared.
// `MlLabel.severityOrd` carries OUR ordinal. `vendorSeverity` carries NO ordinal — it is a
// bare enum — so any direction comparison (did the bot call it worse or milder than we did?)
// needs this map. Exported once so the three places that would otherwise hand-roll
// `{nit:0,minor:1,major:2,critical:3}` (backend fold, frontend matrix, tests) cannot drift.
// ⚠ This is an ORDERING aid, not a licence: see MlLabel.vendorSeverity — nothing may correct,
// seed or fall back OUR severity from the vendor's.
export const ML_SEVERITY_ORD: Record<MlSeverity, number> = {
  nit: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

// ── The ONE selector: which tile/chip is being drilled ───────────────────────────────────
// A discriminated union, not six routes. Every arm names a POPULATION of the SAME windowed
// label scan that `BotAnalyticsMlTotals` is folded from — which is what lets the drill-down's
// `total` be the tile's number by construction rather than by coincidence.
export type BotFlaggingSelector =
  // "Findings" tile → the findings bucket: severity coerced, NOT isSummary, NOT praise.
  | { kind: 'findings' }
  // The "+ N walkthrough/summary" sub-line of the Findings tile → isSummary rows.
  // ⚠ BACKEND ORDER: isSummary is tested BEFORE praise, so a praise-flavoured walkthrough is
  // a SUMMARY here — the OPPOSITE of the client-side `pillOf` display helper, deliberately.
  // Nothing may re-derive these counts on the client; the drill-down's numbers are the
  // server's, and `pillOf` is for display pills only.
  | { kind: 'summaries' }
  // "High severity" tile → ['major','critical']; "Nits" tile → ['nit'].
  // Always FINDINGS-ONLY (bySeverity is incremented only inside the findings branch).
  | { kind: 'severity'; severities: MlSeverity[] }
  // "Top topic" tile AND each of the five category chips — the SAME arm, because tile 4 IS
  // `ml.byCategory[0]` and chip 1 is the same object. Findings-only, multi-label membership.
  | { kind: 'category'; category: MlCategory }
  // "Same-line overlap" tile → DETERMINISTIC line clusters, not ML rows. This arm returns a
  // different item shape (see the discriminated response below).
  | { kind: 'overlap' };

// ── Refinement applied AFTER the selector (both are server-side, because paging is) ──────
export type VendorSeverityAxis = MlSeverity | 'none'; // 'none' = the bot declared nothing

// One cell of the ours-vs-vendor confusion matrix, used as a filter.
export interface SeverityAgreementCellRef {
  vendor: VendorSeverityAxis;
  ours: MlSeverity;
}

// 'any' = ours ≠ theirs in either direction; 'over' = the BOT called it worse than we did
// (vendorOrd > oursOrd); 'under' = the bot called it milder. Direction is defined by
// ML_SEVERITY_ORD on both sides — never by "confidence", never by severityProb.
export type VendorDisagreeDirection = 'any' | 'over' | 'under';

export interface BotFlaggingRefine {
  /** Narrow to one confusion-matrix cell. null = the whole selector population. */
  cell: SeverityAgreementCellRef | null;
  /** Disagreements only, optionally directional. null = no narrowing. */
  disagree: VendorDisagreeDirection | null;
  /**
   * Narrow to a SET of bots — `users.id`s (`BotFlaggingComment.authorUserId`, i.e. the numbers
   * behind `u<userId>` keys), never vendor key strings. null = every bot in the selector
   * population.
   *
   * This is what lets the Behaviour tab's inflation index open the comments behind ITS OWN
   * numbers: that panel's bots come from `automatedReviewerUserIds(role: 'review')` while this
   * drill-down resolves role `'all'`, and BOTH role choices are deliberate — so the two sides can
   * only agree if the caller states the exact bot set its number was summed over.
   *
   * ⚠ A LIST, NOT A SINGLE ID, PRECISELY BECAUSE OF THE CARD-LEVEL "View all N →". A per-BAR click
   * was always consistent (it carries one author), but the card-level button asserted a total
   * summed over the panel's role-`'review'` bots and then opened a list resolved over role
   * `'all'` — so a workspace whose quality-check bots emit vendor badges would read "View all 359"
   * and land on 612, with nothing on screen explaining the gap. Sending the ids makes the two
   * consistent BY CONSTRUCTION rather than by the coincidence that no shipped quality-check bot
   * badges anything today.
   *
   * ⚠ `[]` MEANS "NO BOTS" AND MUST NEVER WIDEN TO "ALL" — the `repoIds` rule (`if (ids)`, never
   * `ids.length > 0`). An empty list yields an empty page; only `null` widens.
   *
   * Ids from another account simply match nothing — the scan this filters is already
   * accountId-scoped, so an empty list is the answer for "not yours" and for "no such bot" alike,
   * and neither is an existence oracle.
   */
  authorUserIds: number[] | null;
}

// ── The confusion matrix ─────────────────────────────────────────────────────────────────
// ⚠ THIS IS A DISPLAY OF TWO CLAIMS, NEVER A RECONCILIATION. `vendorSeverity` scores 0.474
// exact / 0.697 ordinal MAE on the adjudicated gold-300 against our 0.700 / 0.303, so the
// matrix exists to show WHERE they differ; nothing here feeds `severity`, `botVerdict`, the
// nit-ratio gate, or any tile. `vendorSeverity` appears ONLY in this matrix, in `refine`, and
// in display — never in a selector predicate and never in `total`.
//
// ⚠ CATEGORY IS OURS-ONLY AND IS ABSENT FROM THIS SHAPE ON PURPOSE. Vendors declare no
// machine-readable category, so there is no vendor category to disagree with and none may be
// inferred. The UI must state this next to the matrix.
export interface SeverityAgreementMatrix {
  /** Dense 5×4 (vendor axis incl. 'none' × our four). Zero cells are PRESENT, not omitted. */
  cells: Array<{ vendor: VendorSeverityAxis; ours: MlSeverity; count: number }>;
  /** Rows carrying a vendor claim at all — the matrix's own honest denominator, the
   *  `BotBehaviourMlBot.vendorDeclared` precedent. `undeclared` is the 'none' column's sum. */
  declared: number;
  undeclared: number;
  agree: number; // vendorSeverity === severity
  overCall: number; // the BOT called it worse than we did
  underCall: number; // the bot called it milder
  /** Every row in the selector population, declared or not. agree+over+under === declared. */
  total: number;
}

// ── The card item ────────────────────────────────────────────────────────────────────────
// EXTENDS BotVendorComment so `lib/botComments.ts` (pillOf / vendorDisagrees /
// commentFacetCounts / selectComments, all typed on BotVendorComment) works on it unchanged.
// The four added fields are exactly what a CROSS-BOT list needs and the single-bot list does
// not: who said it, and where on the file.
export interface BotFlaggingComment extends BotVendorComment {
  authorUserId: number;
  authorLogin: string | null;
  /** Workspace custom label → vendor pretty name → display name/login (reviewerLabel rules). */
  authorLabel: string;
  authorKind: AutomatedReviewerKind;
  /** review_thread line for inline comments; null for PR comments, review bodies, and
   *  OUTDATED threads (GitHub nulls the line when a thread outdates). */
  line: number | null;
  /** `https://github.com/<owner>/<name>/pull/<n>`. ⚠ There is deliberately NO per-comment
   *  permalink: `review_threads` has no `url` column and the numeric REST comment id is not
   *  stored, so a fabricated anchor would 404. */
  prUrl: string;
}

// ── The cluster item (Same-line overlap) ─────────────────────────────────────────────────
export interface BotFlaggingClusterMember {
  threadId: number; // the representative thread (this bot's first in the cluster)
  threadIds: number[]; // every thread this bot contributed (the ×N pill)
  line: number | null; // this member's own line (the cluster carries the anchor)
  derivedState: DerivedState;
  addressedConfidence: AddressedConfidence;
  /** The thread's OPENING comment by its OWN bot (author-filtered, lower-id tiebreak), with
   *  its body and inline ML label. null when the thread has no comment by its own author —
   *  the member still renders, unbodied. */
  comment: BotFlaggingComment | null;
}

export interface BotFlaggingCluster {
  /** Stable across pages: `${prId}:${line ?? 'x'}:${path}`. Opaque; equality only. */
  clusterId: string;
  prId: number;
  prNumber: number;
  prTitle: string;
  prAuthorId: number | null;
  repoId: number;
  repoFullName: string;
  prUrl: string;
  path: string;
  /** The cluster ANCHOR (its lowest line) — `LineOverlapCluster.line`. */
  lineStart: number;
  /** max(member lines). The ±3 window means lineEnd - lineStart <= LINE_OVERLAP_WINDOW. */
  lineEnd: number;
  /** One member per BOT (collapsed, the getBotDedupClusters rule) — always >= 2. */
  members: BotFlaggingClusterMember[];
  threadCount: number; // Σ members[].threadIds.length
}
// NOTE: deliberately NO `consensus`/`conflict` here. The per-PR dedup derives those from
// `inferSeverity()` — a coarse REGEX over an excerpt — and importing that vocabulary into a
// screen whose whole point is the ML severity comparison would put a THIRD severity scale on
// one card. The members' badges side by side ARE the comparison.

// ── The paginated response (ONE route, discriminated on `kind`) ──────────────────────────
interface BotFlaggingBase {
  /** Echoed so a stale bookmark renders honestly (?workspace= degrades to Default, never 404). */
  workspaceId: number;
  window: { kind: BotWindowKind; from: string; to: string };
  selector: BotFlaggingSelector;
  refine: BotFlaggingRefine;
  /** The SELECTOR population's size — this is the number that must equal the tile. */
  total: number;
  /** After `refine`. Equals `total` when refine is empty. What the list's caption reports. */
  filteredTotal: number;
  /** Ours-vs-vendor over the SELECTOR population, PRE-refine — the commentFacetCounts /
   *  ConsolidatedFeedResponse.counts rule, so a cell never zeroes itself out once clicked. */
  matrix: SeverityAgreementMatrix;
  /** OPAQUE. Feed back verbatim as `?cursor=`. null = no further page.
   *  Today it encodes the offset into the folded population (`o:<n>`) BECAUSE the population is
   *  a JS fold over a JSON column that no portable SQL predicate can express. Opaque so a later
   *  keyset switch is not a wire break. */
  nextCursor: string | null;
  /** The 50k label scan (or the cluster cap) was hit — the numbers are a most-recent sample.
   *  Same honesty rule as ROLLUP_SCAN_CAP / BotSeverityResponse.truncated. */
  truncated: boolean;
  generatedAt: string;
}

export interface BotFlaggingCommentsResponse extends BotFlaggingBase {
  kind: 'comments';
  items: BotFlaggingComment[];
}

export interface BotFlaggingClustersResponse extends BotFlaggingBase {
  kind: 'clusters';
  items: BotFlaggingCluster[];
}

export type BotFlaggingResponse = BotFlaggingCommentsResponse | BotFlaggingClustersResponse;

// ---------------------------------------------------------------------------------------
// Bot comment VOLUME per PR (PAID `botDepth` — deterministic, no model, no new table)
// ---------------------------------------------------------------------------------------
//
// ⚠ ALL THREE VOLUME ROUTES 402 WITHOUT `botDepth` (`/api/bot-analytics/volume`, `…/volume/prs`,
// `…/volume/scatter`). Both surfaces below live inside the paid ROI panel, so there is no free
// half to narrow for — unlike `/api/bot-analytics`, which serves a free caution and therefore
// narrows instead of refusing. Deterministic and core-computed; "core" is where the code lives.
//
// Two surfaces, one getter family (backend db/bot-volume.ts):
//   • the Bots ROI tab's "avg bot comments per PR" column + the PR drill-down behind it, and
//   • the Behaviour tab's LOC-vs-bot-comment-volume chart.
//
// ⚠ THE POPULATION IS **MERGED** PRs, AND THE WINDOW APPLIES TO `mergedAt`. Not opened-in-window,
// not updated-in-window. Two reasons, and both are load-bearing for how the numbers read:
//   • a still-open PR has not finished collecting bot comments, so averaging over it drags every
//     mean down by an amount that depends only on how recently the window started; and
//   • it is the same anchor `BotVendorAnalytics.mergedPastPrs` already uses, so the ROI tab keeps
//     ONE time grain across its columns.
// Measured on the dev corpus at 180d: the same repos hold 997 PRs by `openedAt` and 686 by
// `mergedAt` (erxes/erxes), so the choice moves every average materially and must be stated in
// any caption the UI writes.
//
// ⚠ WHAT COUNTS AS ONE "BOT COMMENT" — all THREE text kinds an automated reviewer can emit, the
// same three the ML label corpus is built from: a `review_comments` row (one inline remark), a
// `pr_comments` row (one PR-level remark), and a submitted `reviews` row (the review body — the
// "walkthrough"/summary post). A `reviews` row counts even when its body is EMPTY (a bare
// approval), because that is what the corpus measurement these surfaces were specced against
// counted; the measured cost of that choice is erxes/erxes 16.89 vs 15.98 avg and go-redis
// 4.91 vs 4.32 — the zero-comment PR counts are IDENTICAL either way, so no product signal
// turns on it. `state: 'pending'` reviews (drafts, invisible on GitHub) are excluded.
//   ⚠ This is a WIDER definition than `BotAnalyticsResponse.totals.comments`, which counts only
//   the first two kinds. The two numbers are not interchangeable and neither is derivable from
//   the other — do not caption one with the other's total.
//
// ⚠ NOBODY RE-DERIVES A COUNT CLIENT-SIDE. The server's number is the number; the column, the
// drill-down and the chart all fold the SAME per-(PR, bot) counts, which is why they cannot
// disagree.
//
// Nothing here feeds `botVerdict` — it is display-only (bot-analytics-verdict.test.ts pins that
// verdict's inputs).

/** The five LOC buckets every baseline is conditioned on. Edges (additions+deletions):
 *  xs `<50` · s `50–200` · m `200–600` · l `600–2k` · xl `2k+`. Half-open, low edge inclusive.
 *  The numeric edges live in ONE runtime table (backend db/bot-volume.ts `SIZE_BUCKETS`) and
 *  ride the wire as `BotVolumeSizeBucketStat.minLoc/maxLoc`, so no client re-spells them. */
export type BotVolumeSizeBucket = 'xs' | 's' | 'm' | 'l' | 'xl';

/** Which population `BotVolumePrRow.expected` was averaged over — an EXPLICIT discriminator, not
 *  something to infer from nulls, because "we have no baseline" and "this PR is exactly average"
 *  are different claims that must read differently on screen.
 *   • `'bucket'` — the mean of this PR's own repo × size bucket (the honest comparison).
 *   • `'repo'`   — the bucket held fewer than the small-sample floor, so the repo's own mean over
 *                  every merged PR in the window stood in. NOT size-conditioned: say so.
 *   • `'none'`   — no baseline at all (PR size never observed, or the repo itself is under the
 *                  floor). `expected` and `ratio` are both null. */
/**
 * How a row's `expected` was derived — and, when it is `'low_expectation'`, why there is no
 * ratio despite `expected` being present.
 *
 * `'bucket'`  this repo's mean for PRs of this size — the intended comparison.
 * `'repo'`    the repo mean, NOT size-matched (the size bucket was too thin). Disclosed on screen.
 * `'low_expectation'` plenty of comparable PRs, but they average under the floor, so a multiplier
 *              would amplify Poisson noise into a finding. Measured on erxes/30d: the `<50` cell
 *              held 43 PRs at a mean of 0.9, where one PR drawing 4 comments reads 4.4× — and
 *              across 43 PRs you expect about one such row by chance alone. `expected` and
 *              `baselinePrs` are still populated so the UI can show what was compared; `ratio` is
 *              null on purpose.
 * `'none'`     no comparable population at all (unsized PR, or a repo under the sample floor).
 *
 * ⚠ `'low_expectation'` and `'none'` BOTH yield a null ratio and are NOT the same fact. One means
 * "we found plenty of comparable PRs and they are all near-silent", the other "we could not find
 * comparable PRs". Collapsing them loses the only information that distinguishes a quiet repo
 * from an unmeasurable one.
 */
export type BotVolumeBaselineKind = 'bucket' | 'repo' | 'none' | 'low_expectation';

/** `'comments'` (DEFAULT) = raw bot-comment count, desc. `'ratio'` = bucket-relative, desc.
 *  ⚠ The default is raw count by product decision, but raw count MOSTLY RANKS BY SIZE — measured
 *  correlation of log10(LOC+1) against bot-comment count is 0.615 on go-redis and 0.539 on erxes,
 *  and bot comments per 100 LOC FALL monotonically across the buckets (erxes 32.91 → 8.33 → 4.32
 *  → 2.08 → 0.30), i.e. size is sublinear in comments. `'ratio'` is what surfaces the PR that was
 *  actually torn apart, and the corpus proves it: erxes #7802 is 17 LOC across 1 file and drew 25
 *  bot comments — 3.68× its bucket's expectation — yet ranks **123rd of 686** under `'comments'`
 *  and **8th** under `'ratio'`. A screen that offers only the default has shipped a size ranking. */
export type BotVolumePrSort = 'comments' | 'ratio';

export interface BotVolumeRefine {
  /**
   * Narrow to a SET of bots — `users.id`s (the numbers behind `u<userId>` keys), never vendor key
   * strings. Deliberately the SAME spelling and the same rules as `BotFlaggingRefine.authorUserIds`
   * (one drill-down convention on this surface, not two).
   *
   * ⚠ `[]` MEANS "NO BOTS" AND MUST NEVER WIDEN TO "ALL" — the `repoIds` rule (`if (ids)`, never
   * `ids.length > 0`). Only `null` widens.
   *
   * ⚠ IT ALSO MOVES THE BASELINE. `expected` is re-averaged over the SAME narrowed bot set, or a
   * one-bot list would be compared against every bot's combined expectation and every ratio would
   * read low. Ids this account does not own simply match nothing (the scan is already
   * accountId-scoped), which is what stops it being an existence oracle.
   */
  authorUserIds: number[] | null;
}

export interface BotVolumeBot {
  /** Stable row key, `u<userId>` — the `BotVendorAnalytics.key` spelling, so the ROI table can
   *  join this row onto the one it already renders. */
  key: string;
  authorUserId: number;
  /** Workspace custom label → vendor pretty name → display name/login (reviewerLabel rules). */
  label: string;
  login: string | null;
  kind: AutomatedReviewerKind;
  /** `'quality_check'` bots are INCLUDED here (the bot set is role `'all'`). Split them out the
   *  way `BotAnalyticsResponse` splits `vendors` from `qualityChecks` — this response does not
   *  pre-split, because the chart wants both. */
  role: ReviewerRole;
  /** Every counted bot comment by this bot, over the window's merged PRs in scope. */
  comments: number;
  /** DISTINCT merged-in-window PRs carrying ≥1 comment by this bot. */
  prsCommentedOn: number;
  /**
   * ⚠ THE TWO AVERAGES DIFFER BY THE DENOMINATOR AND NOTHING ELSE, AND THE GAP IS ENORMOUS —
   * this is why neither is called `avgCommentsPerPr`. On mrdoob/three.js, 656 of 796 merged PRs
   * carry ZERO bot comments, so the same bot reads ~6× higher "per PR it commented on" than
   * "per PR in scope". A reader cannot tell them apart from the number alone, so the FIELD NAME
   * has to. Whichever one a column shows, its header must name the denominator.
   *
   * `avgCommentsPerCommentedPr` = comments / prsCommentedOn — "when this bot shows up, how much
   * does it say". THE HEADLINE ROI COLUMN. null when prsCommentedOn is 0.
   *
   * `avgCommentsPerScopePr` = comments / `BotVolumeTotals.prs` — "what does this bot add to the
   * average PR here", counting the PRs it ignored. null when the scope has no merged PRs.
   */
  avgCommentsPerCommentedPr: number | null;
  avgCommentsPerScopePr: number | null;
  /** The most this bot said on any ONE merged PR in the window — the "torn to pieces" ceiling. */
  maxCommentsOnOnePr: number;
}

export interface BotVolumeTotals {
  /** Merged-in-window PRs in scope — the denominator of `avgCommentsPerScopePr`, and the honest
   *  denominator for any "N of M PRs" caption. */
  prs: number;
  /** The subset with an OBSERVED size (see `BotVolumePrRow.loc`) — the denominator every LOC
   *  chart and every bucket baseline actually uses. `prs - sizedPrs` is a real population on a
   *  lean-storage install (135 of three.js's 796 here), never zero-LOC PRs. */
  sizedPrs: number;
  comments: number;
  prsWithBotComments: number;
  /** `prs - prsWithBotComments`. Present as its own field because it is the number that makes the
   *  two averages legible ("656 of 796 merged PRs drew nothing"). */
  prsWithNoBotComments: number;
  /** Same denominator contract as the per-bot pair above, over ALL bots. */
  avgCommentsPerCommentedPr: number | null;
  avgCommentsPerScopePr: number | null;
  maxCommentsOnOnePr: number;
}

export interface BotVolumeResponse {
  /** Echoed so a stale bookmark renders honestly (?workspace= degrades to Default, never 404). */
  workspaceId: number;
  window: { kind: BotWindowKind; from: string; to: string };
  /** Most comments first. A bot with zero window comments is OMITTED (unlike the ROI table's
   *  dormant rows — this response has no trend to keep such a row meaningful). */
  bots: BotVolumeBot[];
  totals: BotVolumeTotals;
  /** The merged-PR scan cap was hit: every number is a most-recent sample, not a total. Same
   *  honesty rule as `BotFlaggingBase.truncated`. */
  truncated: boolean;
  generatedAt: string;
}

export interface BotVolumePrBotShare {
  key: string; // `u<userId>`
  authorUserId: number;
  label: string;
  comments: number;
}

export interface BotVolumePrRow {
  prId: number;
  prNumber: number;
  prTitle: string;
  /** `https://github.com/<owner>/<name>/pull/<n>`. */
  prUrl: string;
  repoId: number;
  repoFullName: string;
  /** The PR's `openedAt`, ISO. */
  createdAt: string;
  /** ISO. Never null in this population (merged-only) — typed non-null on purpose. */
  mergedAt: string;
  additions: number;
  deletions: number;
  /**
   * `additions + deletions`, or **null when the PR's size was never observed**. Under lean
   * storage the three size columns default to 0 and a PR whose detail never hydrated is
   * indistinguishable from a genuinely empty one, so `changedFiles === 0 && additions === 0 &&
   * deletions === 0` is read as UNKNOWN: `loc`/`changedFiles` null, `sizeBucket` null,
   * `baseline: 'none'`, `expected`/`ratio`/`commentsPer100Loc` all null. **Never 0** — a
   * fabricated zero would put the PR in the `xs` bucket and manufacture a spectacular ratio.
   */
  loc: number | null;
  changedFiles: number | null;
  /** Bot comments on this PR from the refined bot set (every bot when `refine` is empty). */
  botComments: number;
  /** Who said what, most comments first. Sums to `botComments` by construction. */
  byBot: BotVolumePrBotShare[];
  sizeBucket: BotVolumeSizeBucket | null;
  /**
   * The mean bot-comment count of the baseline population (see `baseline`), 2dp. null ⇔
   * `baseline === 'none'`.
   *
   * `ratio` = botComments / expected, 2dp — "3.7×" is `ratio: 3.7`. null when there is no
   * baseline AND when `expected` is 0. An `expected` of 0 cannot hide a finding: this PR is
   * itself a member of its own baseline population, so a mean of 0 forces `botComments` to 0 too.
   *
   * ⚠ RENDER `expected` AND `baselinePrs` BESIDE THE MULTIPLIER, never behind a tooltip. A
   * near-zero expectation inflates the ratio without inflating the finding: measured on this
   * corpus, bevyengine/bevy #24971 reads **42.86×** off 3 bot comments against an expectation of
   * 0.07 (over 61 PRs), while erxes #7802's 3.68× is 25 comments against 6.80. Both numbers are
   * correct; only one is a PR someone should look at, and only the surrounding numbers say which.
   * The small-sample floor fixes thin SAMPLES — nothing fixes a small MEAN except showing it.
   */
  expected: number | null;
  ratio: number | null;
  baseline: BotVolumeBaselineKind;
  /** How many PRs the baseline was averaged over — the small-sample disclosure. 0 when
   *  `baseline === 'none'`. A ratio computed off 2 PRs is noise dressed as a finding, which is
   *  why a bucket under the floor degrades to `'repo'` rather than answering. */
  baselinePrs: number;
  /**
   * ⚠ RAW DENSITY, DELIBERATELY NOT THE SORT AND NOT A HEADLINE. It EXPLODES on small PRs —
   * measured across erxes's buckets it runs 57.65 → 8.99 → 4.46 → 2.23 → 0.83 per 100 LOC, so
   * ranking on it returns a list of one-line PRs every time. The bucket-relative `ratio` is the
   * honest form. null when `loc` is null; `loc` of 0 divides by 1 (a rename-only PR).
   */
  commentsPer100Loc: number | null;
}

export interface BotVolumePrsResponse {
  workspaceId: number;
  window: { kind: BotWindowKind; from: string; to: string };
  refine: BotVolumeRefine;
  sort: BotVolumePrSort;
  /** Merged-in-window PRs in scope — the population, including the ones no bot touched. */
  total: number;
  /** PRs carrying ≥1 comment from the refined bot set — what the list actually enumerates, and
   *  what its caption must report ("140 of 796 merged PRs drew bot comments"). */
  filteredTotal: number;
  items: BotVolumePrRow[];
  /** OPAQUE. Feed back verbatim as `?cursor=`. null = no further page. Today it encodes an offset
   *  into the sorted fold (`o:<n>`), because the population is a JS fold over three grouped
   *  counts and the sort keys are derived — opaque so a later keyset switch is not a wire break. */
  nextCursor: string | null;
  truncated: boolean;
  generatedAt: string;
}

export interface BotVolumeScatterPoint {
  prId: number;
  repoId: number;
  /** Always a real observed size — unsized PRs are DROPPED from the series (they have no x). */
  loc: number;
  changedFiles: number;
  botComments: number;
}

export interface BotVolumeSizeBucketStat {
  bucket: BotVolumeSizeBucket;
  /** Display label ('<50', '50–200', …) — minted server-side so every surface spells the edges
   *  the same way. */
  label: string;
  minLoc: number;
  /** Exclusive upper edge; null on the open-ended `xl` bucket. */
  maxLoc: number | null;
  /** SIZED merged PRs in this bucket across the whole scope. */
  prs: number;
  comments: number;
  /** comments / prs, 2dp. null when prs is 0 (an empty bucket renders as a gap, never a zero). */
  avgComments: number | null;
  /** Σcomments / Σmax(loc,1) × 100, 2dp — the SUBLINEARITY readout, and the one place a density
   *  belongs: aggregated per bucket it is stable, whereas the same figure per PR explodes. */
  commentsPer100Loc: number | null;
}

export interface BotVolumeScatterResponse {
  workspaceId: number;
  window: { kind: BotWindowKind; from: string; to: string };
  /** One point per SIZED merged PR, newest-merged first, capped. */
  points: BotVolumeScatterPoint[];
  /** The five bucket means over every sized PR THE SCAN RETURNED — the expectation curve to draw
   *  through the cloud. Dense: every bucket is present even at `prs: 0`.
   *  ⚠ Not necessarily the whole window: the scan itself stops at 5000 merged PRs, and that bit is
   *  not on this response (see `truncated`). */
  buckets: BotVolumeSizeBucketStat[];
  sizedPrs: number;
  /** Merged PRs whose size was never observed. They are absent from `points` and from every
   *  bucket, so the chart must disclose them rather than let the eye read a smaller corpus. */
  unsizedPrs: number;
  /** The POINT cap bit ONLY — "showing the most recent N points". The SCAN cap is reported
   *  SEPARATELY by `scanTruncated`; the two are never folded together, because the chart's
   *  cloud and its expectation curve are truncated by different limits and a reader told only
   *  "truncated" cannot tell which claim is weakened. */
  truncated: boolean;
  /** TRUE when the underlying scan itself stopped at its cap, i.e. `buckets` (and therefore the
   *  expectation curve, and every "×  expected" ratio derived from the same baseline) describe
   *  the most-recent N merged PRs rather than the whole window.
   *
   *  ⚠ THIS IS THE HONESTY BIT, NOT A PERFORMANCE DETAIL. `truncated` above can read `false`
   *  while this is `true` — the points shown are genuinely all of them, but the curve they are
   *  judged against is a sample. Presenting a sampled baseline as the scope's baseline is the
   *  exact failure the autopsy was removed for, so the chart MUST disclose this rather than
   *  quietly draw a curve that looks authoritative. */
  scanTruncated: boolean;
  generatedAt: string;
}

// ---------------------------------------------------------------------------------------
// Emoji reactions on comments (CORE, free tier — no AI, no ML, no stored state)
// ---------------------------------------------------------------------------------------
//
// Reactions are FETCHED ON DEMAND and NEVER STORED. There is no column, no migration and no
// sync cost: the fat walk query is untouched, and a batched client-side loader turns "every
// comment on screen wants its reactions" into ONE request per tick (see the backend route
// POST /api/reactions/lookup and the frontend hooks/useReactions.ts).
//
// The wire deliberately addresses a target by its LOCAL database id, not its GitHub node id:
//   • those ids are already on CommentDetail / PrCommentDetail / ReviewDetail, so no read
//     payload had to grow a field,
//   • and the server resolves local id → node id through an accountId-scoped join, which
//     makes tenancy STRUCTURAL. A client cannot name a node id it does not own, so the id
//     list can never become an existence oracle over another tenant's GitHub content or a
//     way to spend this account's GitHub quota on arbitrary nodes.

/**
 * GitHub's fixed reaction set, lowercased at the wire boundary (the same convention as
 * MlSeverity). Exactly eight — `ReactionContent` in the GraphQL schema. The picker offers all
 * eight because a reaction added on github.com must be renderable here; the BAR renders only
 * the non-empty groups.
 */
export type ReactionContent =
  | 'thumbs_up'
  | 'thumbs_down'
  | 'laugh'
  | 'hooray'
  | 'confused'
  | 'heart'
  | 'rocket'
  | 'eyes';

/** Picker order — GitHub's own order on the web UI. */
export const REACTION_CONTENTS: ReactionContent[] = [
  'thumbs_up',
  'thumbs_down',
  'laugh',
  'hooray',
  'confused',
  'heart',
  'rocket',
  'eyes',
];

/** The glyph rendered for each content value. */
export const REACTION_EMOJI: Record<ReactionContent, string> = {
  thumbs_up: '👍',
  thumbs_down: '👎',
  laugh: '😄',
  hooray: '🎉',
  confused: '😕',
  heart: '❤️',
  rocket: '🚀',
  eyes: '👀',
};

/**
 * The three reactable things this product renders. Same three id spaces as MlLabelTargetKind
 * — `review_comments.id`, `pr_comments.id`, `reviews.id` — so every lookup MUST carry the kind.
 *
 * ⚠ There is deliberately NO `'thread'`. `PullRequestReviewThread` is NOT in GitHub's
 * `Reactable` interface (verified against the live schema): a thread as a whole cannot carry
 * reactions, only its constituent comments can. A thread-level bar would be a fabrication that
 * could never round-trip to github.com.
 */
export type ReactionTargetKind = 'review_comment' | 'pr_comment' | 'review';

/** One non-empty reaction group on a target. Zero-count groups are filtered server-side. */
export interface ReactionGroupSummary {
  content: ReactionContent;
  /** Reactor count. Always ≥ 1 — GitHub returns all eight groups, mostly zeroed, and the
   *  server drops the empty ones so the wire (and every consumer's filter) stays small. */
  count: number;
  /** True when the signed-in token is one of the reactors — the "pressed" chip state. */
  viewerHasReacted: boolean;
}

/** A target addressed by (kind, LOCAL id). */
export interface ReactionTargetRef {
  kind: ReactionTargetKind;
  id: number;
}

/** Everything the bar needs for one target. */
export interface ReactionState extends ReactionTargetRef {
  groups: ReactionGroupSummary[];
  /**
   * GitHub's own `viewerCanReact` — false on a locked conversation or an archived repo even
   * for a maintainer, true for any authenticated user on a public repo. This is the ONLY gate
   * on the add affordance; do NOT substitute `repos.viewer_permission`, which answers a
   * different question.
   */
  viewerCanReact: boolean;
}

/**
 * The batched read. A POST because the target list is a body, not a path — the same
 * "mutating VERB with GET-shaped cost" shape as POST /api/prs/:id/refresh, and it keeps the
 * cross-origin guard applying.
 */
export interface ReactionLookupBody {
  targets: ReactionTargetRef[];
}

export interface ReactionLookupResponse {
  /**
   * One entry per target the account owns AND GitHub answered for. A target that is unknown,
   * foreign, deleted upstream or invisible to the token is simply ABSENT — "no reactions" and
   * "we could not see it" both mean "render nothing", and an explicit 404 per id would be the
   * oracle the local-id addressing exists to avoid.
   */
  results: ReactionState[];
  generatedAt: string;
}

/** Toggle one reaction. `add:false` removes it. */
export interface ReactionWriteBody extends ReactionTargetRef {
  content: ReactionContent;
  add: boolean;
}

/**
 * The post-write state, read straight off the mutation payload's `subject` — GitHub hands back
 * the fresh group set in the same round trip, which is how this write route satisfies the house
 * rule that a GitHub write must stamp/confirm rather than promise "on the next sync". Nothing
 * is stored locally, so there is nothing to stamp: this response IS the new truth.
 */
export type ReactionWriteResponse = ReactionState;

// ---- Synthesis (P2.1): ONE cached, credit-metered Haiku pass over a drill-down's item set ----
//
// The D3 decision made wire-shaped: C3 (drill-down verdicts) and C6 (workspace bot themes) are the
// SAME capability at different grains — a deterministic item set assembled server-side, one model
// pass that GROUPS it, and a rendered card whose every number is computed from the validated
// grouping (D4: the model authors no numbers). One plugin endpoint (`/api/pro/synthesis`), one
// cache table (`pro_synthesis`), one output contract.
//
// ⚠ THE ONE-PREDICATE RULE (§8.3) is what these shapes exist to carry: for each `kind`, the item
// set the model sees is produced by the SAME core query the drill-down's list and count read
// (core `db/synthesis-input.ts` getSynthesisInput). A synthesis over a second predicate would
// summarise a different population than the receipt list below it.

/** The P2.1 drill-down grains plus the ORDERING grains: 'brief' (the daily-brief narration,
 *  N1), 'rollup' (the cross-workspace "Elsewhere" line, N5) and 'person' (the 1:1-prep
 *  narration, N4 — one digit-free phrase per person-vector line), plus the SECTIONS grain
 *  'person_report' (the People report's per-person narrative — digit-free prose per fixed
 *  section id over the person vector + its evidence rows; see SynthesisSectionItem). Every
 *  widening here was additive — no version change (exactly the growth path the P2.1 comment
 *  promised). */
export type SynthesisScopeKind =
  | 'bot-flagging'
  | 'bot-threads'
  | 'bot-volume'
  | 'workspace-bots'
  | 'brief'
  | 'rollup'
  | 'person'
  | 'person_report';

/**
 * The flagging drill-down's population selector, as the synthesis descriptor spells it.
 * `'overlap'` is deliberately absent: that arm lists deterministic same-line clusters, not
 * comments — there is nothing left for a clustering model to add to it.
 */
export type SynthesisFlaggingSelect = 'findings' | 'summaries' | 'severity' | 'category';

/**
 * The scope descriptor — what `getSynthesisInput` folds and what `scope_key` serialises.
 *
 * `workspaceId` + `repoIds` are RESOLVER-PRODUCED (host `resolveWorkspaceScope` / the plugin's
 * `resolveRequestScope` + membership intersection): `repoIds ⊆ the workspace's membership`, and
 * `[]` is an ordinary empty workspace, never "widen to the account". The narrowing fields carry
 * the drill-down's own seed verbatim:
 *   - `botUserId`  — the one-bot narrowing ('bot-flagging' + 'bot-volume'; the store-seed rule).
 *   - `direction`  — the inflation drill-down's over/under narrowing ('bot-flagging' only).
 *   - `select`/`severities`/`category` — the flagging tile's population ('bot-flagging' only;
 *     `select` defaults to 'findings'; `severities` requires select='severity', `category`
 *     requires select='category').
 * `window` is ignored — and canonicalised out of the cache key — for 'bot-threads': the resolve
 * backlog is a CURRENT-STATE set, not a windowed one (its drill-down takes no window either).
 *
 * The PERSON grains — 'person' (ORDERING, N4) and 'person_report' (SECTIONS, the People
 * report) — carry their OWN three fields and nothing else: `userId` is the SUBJECT (a person,
 * resolved through the lane resolver core-side — never `botUserId`, which is a bot-population
 * narrowing) and `fromMs`/`toMs` are the REAL period bounds off the cadence grid (the enum
 * `window` slot is canonicalised out for them, exactly like the other ordering grains — an
 * arbitrary-bounds period has no BotWindowKind spelling). All three name a POPULATION: garbage
 * 400s, it never degrades to a different person or period.
 */
export interface SynthesisScope {
  kind: SynthesisScopeKind;
  workspaceId: number;
  repoIds: number[];
  window: BotWindowKind;
  botUserId?: number;
  direction?: VendorDisagreeDirection;
  select?: SynthesisFlaggingSelect;
  severities?: MlSeverity[];
  category?: MlCategory;
  /** 'person' / 'person_report' only: the subject's user id. */
  userId?: number;
  /** 'person' / 'person_report' only: the period's real bounds (epoch ms, half-open
   *  `[fromMs, toMs)`). */
  fromMs?: number;
  toMs?: number;
}

/** The item family a synthesis row belongs to — the prefix of its `id` ref. `brief_line` is the
 *  brief/rollup ordering grains' family: one line of the deterministic daily brief (or one
 *  workspace of the roll-up), whose id ENCODES its computed counts (see the daily-brief section
 *  below). `person_metric` is the 'person' grain's family: one non-null line of the 1:1 person
 *  vector, its id encoding the metric key + computed value + PERSON_METRICS_SCHEMA_VERSION for
 *  the same content-hash reason. `path_area` is the 'person_report' grain's path-area family:
 *  one top directory bucket of the subject's windowed commits, its id encoding
 *  bucket + file count (content hash — an area-mix change changes the id changes the hash). */
export type SynthesisItemKind =
  | 'review_comment'
  | 'pr_comment'
  | 'review'
  | 'thread'
  | 'pr'
  | 'brief_line'
  | 'person_metric'
  | 'path_area';

/**
 * One row of the model's input — the EXACT row the drill-down lists, reduced to what a grouping
 * pass needs. `id` is a NAMESPACED ref (`rc:<n>` / `pc:<n>` / `rv:<n>` / `th:<n>` / `pr:<n>`)
 * because the source ids live in different tables' id spaces and can collide numerically
 * (the BotReviewCommentRow lesson); it is also the token the model cites back, which the server
 * validates against this set. `createdAt` is the per-item STABLE field the payload hash folds —
 * GitHub creation time, never a re-upserted or hydrated value.
 */
export interface SynthesisInputItem {
  id: string;
  kind: SynthesisItemKind;
  authorLabel: string;
  createdAt: string; // ISO
  /** Whitespace-collapsed + capped server-side. '' when the source text is gone. */
  body: string;
  path?: string | null;
  severity?: MlSeverity | null;
}

/**
 * `getSynthesisInput`'s return: the CAPPED item rows plus the truncation disclosure. `totalCount`
 * is the drill-down's own filtered total (count ≡ list ≡ input, §8.3); `analyzedCount` is what
 * survived the cap + hydration. Silent truncation is forbidden — the card renders
 * "Summarised X of Y" from exactly these two numbers.
 */
export interface SynthesisInput {
  kind: SynthesisScopeKind;
  workspaceId: number;
  items: SynthesisInputItem[];
  totalCount: number;
  analyzedCount: number;
  truncated: boolean;
}

/**
 * One validated cluster. `itemIds` ⊆ the input set (strays dropped + logged server-side), and
 * `count` is |itemIds| COMPUTED SERVER-SIDE — the rendered "34 style nits on generated files"
 * takes its 34 from here, never from model prose (D4).
 */
export interface SynthesisCluster {
  label: string;
  itemIds: string[];
  count: number;
  /** An Advisor-intent hint — links to the Advisor, never an action in itself. */
  configFixable?: boolean;
}

/** A Phase-3 ordering-mode item ('brief'/'rollup'): a ref from the input set plus a DIGIT-FREE
 *  phrase (regex-validated server-side; a digit or unknown ref rejects the item and the caller
 *  falls back to its templated line). Numbers are appended by the CALLER from computed values. */
export interface SynthesisOrderingItem {
  ref: string;
  phrase: string;
}

/** The 'person_report' SECTIONS mode's fixed vocabulary — the only section ids the server
 *  accepts (an unknown or duplicate id drops the item, plugin-side). Deliberately a CLOSED set:
 *  the model picks which of these to write, never invents its own headings. */
export type PersonReportSectionId =
  | 'worked_on'            // what they worked on (from PR titles + path areas)
  | 'nature_of_changes'    // the semantic read: what kind of changes these were
  | 'collaboration'        // review flow: giving/receiving, thread back-and-forth
  | 'waiting_and_risk';    // what's waiting on them / on their PRs, loose ends

/** A Phase-3 SECTIONS-mode item ('person_report'): at most one per PersonReportSectionId, a
 *  DIGIT-FREE paragraph (regex-validated + length-capped server-side) grounded in the input
 *  items it cites via `refs` (⊆ the input set; strays dropped; a section left with zero valid
 *  refs is dropped — evidence-based or absent). Every figure near this prose is code-rendered
 *  from the vector/evidence wire fields, never model-authored (D4). */
export interface SynthesisSectionItem {
  id: PersonReportSectionId;
  prose: string;           // DIGIT-FREE, server-validated, length-capped
  refs: string[];          // ⊆ input ids — the citations the UI renders as chips
}

/** The stored, validated synthesis — what the GET serves and the card renders. */
export interface StoredSynthesis {
  kind: SynthesisScopeKind;
  /** The canonical serialised descriptor — the cache row's identity (and the client's shared
   *  mutation-key segment, so two mounts of one scope share in-flight state). */
  scopeKey: string;
  clusters: SynthesisCluster[];
  /** ORDERING mode only ('brief'/'rollup'): the validated {ref, phrase} list, model order.
   *  Every ref ∈ the input set, every phrase digit-free (server-validated; a rejected item is
   *  simply absent — the caller renders its templated line). Empty/absent for cluster kinds. */
  ordering?: SynthesisOrderingItem[];
  /** SECTIONS mode only ('person_report'): the validated section list, fixed-vocabulary ids,
   *  digit-free prose, refs ⊆ the input set (zero-ref sections dropped server-side). Absent for
   *  every other kind; `[]` is a stored-but-unparseable generation (the deterministic vector +
   *  evidence cards stay primary, and storing the row stops a click from loop-billing). */
  sections?: SynthesisSectionItem[];
  /** Input items the model left unclustered — recomputed server-side as input − clustered. */
  remainderIds: string[];
  remainderCount: number;
  /** Coverage at generation time: `analyzedCount` of `totalCount` items were summarised. */
  analyzedCount: number;
  totalCount: number;
  truncated: boolean;
  model: string;
  generatedAt: string; // ISO
}

/**
 * The wire envelope for GET + POST `/api/pro/synthesis`. `enabled:false` = the AI-summary tier is
 * off (OSS / flag-less run) — the SPA renders nothing, never an error. `stale` rides the free GET:
 * the input set's recomputed payload hash no longer matches the stored row (items aged out of the
 * window, new comments landed, or a schema/prompt version bump) — the card shows a stale badge +
 * Regenerate, it never regenerates on its own.
 */
export interface SynthesisResponse {
  enabled: boolean;
  synthesis: StoredSynthesis | null;
  stale?: boolean;
  /** POST only: a generation is already in flight, or inside the min-interval — cached row served,
   *  nothing billed. */
  throttled?: boolean;
  /** POST only: metered plan out of credits — cached row served, nothing billed. */
  creditsExhausted?: boolean;
  /** POST only: the scope resolves to zero items — nothing to summarise, nothing stored. */
  empty?: boolean;
}

// ---- The daily brief (plan P3.1 / N1) + the cross-workspace roll-up (P3.3 / N5) ----
//
// A deterministic, computed-on-read fold of "what needs me this morning" for ONE workspace —
// COUNTS ONLY, free tier, no storage, no AI (the Pro narration rides the synthesis seam's
// ordering mode above and never touches these shapes). Every line REUSES the fold of the surface
// it deep-links to (the consolidated feed's my-turn facet, the /api/attention cards, the
// resolvable-backlog listing, the repos head columns), so the strip's number and the surface it
// opens cannot disagree. ⚠ NO cost/money fields anywhere here — the roll-up especially must
// never invite summing cost across workspaces (§8.18).

/** One anomalous review bot this week (a narrow volume-only self-baseline — see
 *  db/daily-brief.ts). `login`/`kind` travel so the client can seed the bot-detail tab's meta
 *  without a second lookup; label is the display name (classification label → login → #id). */
export interface DailyBriefBotAnomaly {
  userId: number;
  label: string;
  login: string | null;
  kind: string | null; // AutomatedReviewerKind, type-light like TabBotMeta.kind
}

/** A repo whose DEFAULT branch currently reads red (head snapshot columns). `name` is the short
 *  repo name (the fullName's tail); `repoId` is the deep-link target (the repo console). */
export interface DailyBriefTrunkRepo {
  repoId: number;
  name: string;
}

export interface DailyBriefCounts {
  /** my_turn cards on /api/attention (one card = one thing on your plate) — the SAME fold as
   *  GET /api/my-turn, workspace-scoped, so the strip's number is the list it opens. */
  myTurn: number;
  /** The UNCAPPED my_turn population (WorkspaceInsightsResponse.myTurnTotal, passed straight
   *  through — same fold, same window, same scope). A DISCLOSURE ONLY: `myTurn` above stays the
   *  figure the strip displays, because it is the number of cards the board will actually paint.
   *  This exists so the line can add a compact "of 148" marker instead of silently restating
   *  "148 things need you" as "50". Absent when nothing was capped-or-counted; consumers gate on
   *  `myTurnTotal > myTurn`, never render it alone.
   *
   *  ⚠ Reporting THIS as the strip's figure would recreate the bug this whole surface exists to
   *  fix: a number whose list you cannot open. The board paints 50. */
  myTurnTotal?: number;
  /** `myTurn`, restricted to cards flagged `MyTurnCard.personal` — the figure a NOTIFICATION
   *  surface displays (the welcome-back banner, the Workspace-dropdown badges, browser
   *  notifications), where "someone opened a PR in a repo you only read" is noise rather than a
   *  summons. The BOARD keeps displaying `myTurn`: those PRs do still need a review.
   *
   *  Absent on a response predating the narrowing; a consumer then falls back to `myTurn`
   *  (the old, broad behaviour — notifying too much beats notifying about nothing). */
  myTurnPersonal?: number;
  /** The uncapped population behind `myTurnPersonal` — `WorkspaceInsightsResponse.
   *  myTurnPersonalTotal`, passed straight through.
   *
   *  ⚠ THIS IS WHY THE FIELD EXISTS. The cap disclosure only fires when the figure being
   *  qualified equals the count it came from, so pairing `myTurnPersonal` with `myTurnTotal`
   *  would both mix two populations in one row AND silently drop the "of N" from every capped
   *  narrow line. Pair narrow with narrow; consumers gate on
   *  `myTurnPersonalTotal > myTurnPersonal`. */
  myTurnPersonalTotal?: number;
  /** THE THREE-WAY SPLIT of the same `myTurn` cards, by `MyTurnCard.relevance`. Each is counted
   *  off the CARDS the board paints (exactly like `myTurn` and `myTurnPersonal`), each is paired
   *  with its OWN uncapped total, and the three are MUTUALLY EXCLUSIVE and EXHAUSTIVE:
   *
   *      myTurnDirect + myTurnMaintained + myTurnOther === myTurn
   *      myTurnDirect + myTurnMaintained             === myTurnPersonal
   *
   *  The brief renders TWO lines off this — "N need your attention" (`myTurnPersonal`, the
   *  interrupting population, unchanged) and "M need review or reply" (`myTurnOther`) — and each
   *  must open a board filtered to ITS OWN number. `myTurnDirect`/`myTurnMaintained` are the
   *  banner's split ("2 yours · 3 in your repos").
   *
   *  ⚠ NOT ONE OF THESE MAY BE A SUBTRACTION. `myTurn - myTurnPersonal` would be arithmetically
   *  right and STILL wrong: it has no total of its own, and `capFor` gates the "of N" disclosure
   *  on the displayed figure equalling the count it qualifies, so a borrowed denominator drops
   *  the disclosure on exactly the capped workspaces it exists for. Pair narrow with narrow.
   *
   *  All six trailing-optional; a response predating them leaves every consumer on the
   *  `myTurn`/`myTurnPersonal` pair it used before. */
  myTurnDirect?: number;
  /** The uncapped population behind `myTurnDirect` (`WorkspaceInsightsResponse.myTurnDirectTotal`,
   *  passed straight through — folded off the pre-cap array). */
  myTurnDirectTotal?: number;
  /** `myTurn` cards with `relevance === 'maintained'` — new PRs in repos you maintain. */
  myTurnMaintained?: number;
  /** The uncapped population behind `myTurnMaintained`, passed straight through. */
  myTurnMaintainedTotal?: number;
  /** `myTurn` cards with `relevance === 'none'` — the "review or reply" line's own figure. */
  myTurnOther?: number;
  /** The uncapped population behind `myTurnOther`, passed straight through. ⚠ Its own fold, never
   *  `myTurnTotal - myTurnPersonalTotal` (see the block above). */
  myTurnOtherTotal?: number;
  /** `ci_failing` cards on /api/attention — red builds the viewer is on the hook for (their own
   *  open PR, or trunk in a repo they maintain). Counted off the CARDS, like every figure above.
   *
   *  ⚠ IT OVERLAPS `trunkRed` BELOW AND THEY ARE NOT THE SAME LINE. `trunkRed` names EVERY repo in
   *  the workspace whose trunk is red, maintained or not, and each of its lines opens that repo's
   *  console. This counts the subset that is YOURS — plus your own red PRs, which `trunkRed` knows
   *  nothing about — and its line opens the attention board isolated to `ci_failing`. Two figures,
   *  two populations, two destinations; folding either into the other would give one of them a
   *  list it does not match. */
  ciFailing?: number;
  /** The uncapped population behind `ciFailing` (`WorkspaceInsightsResponse.ciFailingTotal`,
   *  passed straight through). ⚠ The matched denominator — pair narrow with narrow. */
  ciFailingTotal?: number;
  /** stalled_review cards on /api/attention (one card = one PR). */
  stalled: number;
  /** untouched_thread cards on /api/attention (one card = one thread). */
  untouchedThreads: number;
  /** reviewer_routing ("needs a reviewer") cards on /api/attention. */
  needsReviewer: number;
  /** The resolvable bot-thread backlog (the review-&-resolve tab's own totalThreads). */
  resolveBacklog: number;
  botAnomalies: DailyBriefBotAnomaly[];
  trunkRed: DailyBriefTrunkRepo[];
}

/** One workspace's line in the roll-up ("Elsewhere") — counts only, never cost. */
export interface DailyBriefWorkspaceLine {
  workspaceId: number;
  name: string;
  counts: DailyBriefCounts;
}

/** GET /api/daily-brief — free, counts only; echoes the resolved workspace like every scoped
 *  route. `rollup` is present only when `?rollup=1` was asked AND the account has other
 *  workspaces; it lists the OTHER workspaces (the viewed one is the main `counts`). */
export interface DailyBriefResponse {
  workspaceId: number;
  counts: DailyBriefCounts;
  generatedAt: string; // ISO — when this fold was computed (may be ≤5 min stale, TTL cache)
  rollup?: DailyBriefWorkspaceLine[];
}

// ---- 1:1 prep — the person-period vector (plan P4.2 / N4) ----
//
// A small fixed vector describing ONE PERSON's fortnight in ONE workspace — what an EM walks into
// a 1:1 already knowing. PREP, NOT SCORING: nothing here ranks people against each other, no
// cross-person shape exists on this wire, and every consumer copies that posture (the People list
// is alphabetical, never sort-by-metric).
//
// The period vector's honesty rules apply unchanged: `null` is "no data" and NEVER renders 0; a
// thin sample is flagged server-side (`lowSample` — the floors live in core, not in a second SPA
// copy); coverage travels beside the figures (repos onboarded mid-window AND a person first
// observed mid-window both disclose). ⚠ `users` is a GLOBAL table, so this shape carries the
// person's login + display name ONLY — no other profile fields ever travel here.

// This spelling is CANONICAL; core (db/person-period.ts) inlines a copy for the same
// release-guard reason the period keys are inlined (shared is types-only and not shipped), and a
// core test asserts the two are identical.
export const PERSON_METRICS_SCHEMA_VERSION = 1;

export type PersonMetricKey =
  // -- windowed (two-sided `[fromMs, toMs)` predicates; reproducible for a past period) --
  | 'merged_prs_authored'
  | 'opened_prs_authored'
  | 'reviews_given'
  | 'review_comments_written'
  | 'median_review_response_hours'
  | 'median_first_human_review_hours_their_prs'
  | 'review_threads_on_their_prs'
  // -- live-state (a "now" reading; re-asking about a past period may answer differently) --
  | 'their_pr_threads_addressed'
  | 'awaiting_their_review'
  | 'open_prs_authored';

/** CLOSED + ORDERED at schema version 1 — the render order, exactly like PERIOD_METRIC_KEYS. */
export const PERSON_METRIC_KEYS: PersonMetricKey[] = [
  'merged_prs_authored',
  'opened_prs_authored',
  'reviews_given',
  'review_comments_written',
  'median_review_response_hours',
  'median_first_human_review_hours_their_prs',
  'review_threads_on_their_prs',
  'their_pr_threads_addressed',
  'awaiting_their_review',
  'open_prs_authored',
];

/** Whether the figure is window-pure or a live "now" reading. Computed in CORE and carried on
 *  the wire (the `lowSample` precedent) so the SPA never re-derives it from a second copy. */
export type PersonMetricBasis = 'window' | 'live';

export interface PersonMetricValue {
  key: PersonMetricKey;
  value: number | null; // null = no data. NEVER render as 0.
  sampleSize: number;
  basis: PersonMetricBasis;
  /** Below this metric's core-side sample floor — the figure is real but thin. */
  lowSample: boolean;
}

// ---- Person-period EVIDENCE (the People report; ADDITIVE, computed on read) ----
//
// The receipt rows under the vector: for each metric with a showable population, the capped
// newest-first rows it was computed over — the SAME fold, the SAME predicates, one extra
// `ORDER BY … LIMIT` variant per metric (never a sibling fold that can drift; the
// tile-number-vs-hydration lesson). Absent unless the caller asked (`?evidence=1` /
// `opts.evidence`); requesting it never changes a metric cell. Every group caps at
// PERSON_EVIDENCE_CAP with the undisplayed remainder in `more` ("and N more" is code-rendered).

/** Per-group evidence cap. Core inlines a copy (shared is types-only and not shipped); the
 *  person-period test asserts the two spellings agree. */
export const PERSON_EVIDENCE_CAP = 8; // per group; "and N more" from `more`

/** One review-thread root on the subject's PRs — the `review_threads_on_their_prs` population,
 *  with TODAY'S state chip riding the same row (`their_pr_threads_addressed` renders as a
 *  highlight on this list, never a second population). */
export interface PersonEvidenceThreadRef {
  prId: number; prNumber: number; repoFullName: string;
  threadId: number; path: string | null;
  excerpt: string;                  // root-comment excerpt, whitespace-collapsed + capped
  /** The ROOT comment was written by the subject themself (a self-review note) — the synthesis
   *  input then labels it with their login rather than 'reviewer'. Optional (additive). */
  selfAuthoredRoot?: boolean;
  derivedState: DerivedState;       // TODAY'S state (live, like the metric it evidences)
  createdAt: string;                // ISO — the thread root's window anchor
}

/** One top directory area of the subject's windowed authored work: paths off their PRs' commits
 *  bucketed to the first two segments (`apps/backend/**` style). Counts are code-rendered. */
export interface PersonPathArea { bucket: string; files: number; commits: number }

export interface PersonPeriodEvidence {
  /** PR-backed metrics → capped DigestPrRef rows, newest-first, + the undisplayed rest. The
   *  median keys list the SAMPLE PRs the median was computed over (per-PR hours do NOT travel —
   *  the figure stays the vector's); the live keys list today's sets. */
  prs: Partial<Record<PersonMetricKey, { rows: DigestPrRef[]; more: number }>>;
  /** review_comments_written → their own inline/issue comments, bodies INLINE (BotVendorComment
   *  shape reuse; `mlLabel` is whatever is stored — normally null for humans). */
  comments: { rows: BotVendorComment[]; more: number };
  /** review_threads_on_their_prs / their_pr_threads_addressed → thread excerpts (ONE list). */
  threads: { rows: PersonEvidenceThreadRef[]; more: number };
  /** Top directory areas over commits on PRs they authored in-window. */
  pathAreas: PersonPathArea[];
}

export interface PersonPeriod {
  userId: number;
  login: string;
  /** Display name when known; the ONLY other identity field that travels (global-table rule). */
  name: string | null;
  /** All keys in PERSON_METRIC_KEYS order, ALWAYS present — a missing key and a null value are
   *  different facts and only one of them is legal here. */
  metrics: PersonMetricValue[];
  /** Repo-coverage honesty, same shape + duty as PeriodReport.coverage: repos that onboarded
   *  mid-window under-count the person's period and must be ANNOTATED, never silently. */
  coverage: PeriodCoverage;
  /** The person's earliest observed activity in this workspace scope (ISO), null when the scope
   *  has never seen them act (they may still be awaiting-review-only). */
  firstSeenAt: string | null;
  /** True when firstSeenAt falls AFTER the window opened — the person-grain coverage bias: a
   *  mid-window joiner's figures under-count their period exactly like an onboarding repo's. */
  firstObservedMidWindow: boolean;
  metricsSchemaVersion: number;
  /** The receipt rows under the vector (see PersonPeriodEvidence) — ABSENT unless requested
   *  (`?evidence=1`); an older host answering an evidence-asking plugin simply omits it. */
  evidence?: PersonPeriodEvidence;
}

/** GET /api/pro/insights/person/:userId — Pro `periodReports`. `person: null` covers every
 *  degrade in ONE shape (unknown/foreign user, a bot, no activity in this workspace, a period
 *  key off the grid) so the route is never an existence oracle. Narration is NOT here — it rides
 *  the synthesis seam's own GET/POST (kind 'person'), one seam per datum. */
export interface PersonPeriodResponse {
  enabled: boolean;
  workspaceId: number;
  /** False = no sprint cadence configured — same refusal (and same setup prompt) as Reports. */
  cadenceConfigured: boolean;
  /** Echo of the resolved period, so the client can build the synthesis descriptor without
   *  re-deriving grid maths. Absent when `person` is null. */
  periodKey?: string;
  periodStart?: string; // ISO
  periodEnd?: string; // ISO (exclusive, matching the half-open window)
  person: PersonPeriod | null;
}

// ── AUTHORING AUTOMATION: the output vector for a bot that writes PRs ────────────────────────
//
// The People report's bot sections answer "what did this automation produce?" from
// `getBotAnalytics` — threads, comments, acted-on. That is REVIEW output, and it is the whole
// story only for the `review` and `quality_check` roles. The picker also offers `dependency`,
// `code_agent`, `release` and `housekeeping` automation, whose real output is PRs they AUTHORED:
// for those, every review column is legitimately zero and a wall of zeros reads as "it did
// nothing" when the truth is "it did a different thing". This vector is that different thing.
//
// ⚠ It is NOT a second spelling of the person vector. A person's numbers answer "how is this
// teammate doing"; an automation's answer "what is this thing costing us" — hence
// `prs_merged_without_human_review` (the cheap ones) and `human_review_comments_received` (the
// expensive ones) rather than response times and review load. Do not add a metric here just
// because PersonPeriod has it.
export type AutomationMetricKey =
  | 'prs_opened'
  | 'prs_merged'
  | 'prs_closed_unmerged'
  | 'merge_rate_pct'
  | 'median_hours_to_merge'
  | 'median_pr_size_lines'
  | 'prs_merged_without_human_review'
  | 'human_review_comments_received'
  | 'repos_touched';

export const AUTOMATION_METRIC_KEYS: AutomationMetricKey[] = [
  'prs_opened',
  'prs_merged',
  'prs_closed_unmerged',
  'merge_rate_pct',
  'median_hours_to_merge',
  'median_pr_size_lines',
  'prs_merged_without_human_review',
  'human_review_comments_received',
  'repos_touched',
];

/** `value: null` is "no sample", NEVER 0 — the period-metrics rule. `sampleSize` is the row
 *  count the figure was folded over, so a median over two PRs can be captioned as such. */
export interface AutomationMetricValue {
  key: AutomationMetricKey;
  value: number | null;
  sampleSize: number;
}

/** Receipt rows under the vector — the PRs themselves, capped like the person evidence
 *  (PERSON_EVIDENCE_CAP) with an honest `…More` remainder per group. */
export interface AutomationOutputEvidence {
  /** Merged inside the window, newest first. */
  merged: DigestPrRef[];
  mergedMore: number;
  /** Closed inside the window WITHOUT merging — the automation's wasted churn. */
  closedUnmerged: DigestPrRef[];
  closedUnmergedMore: number;
  /** Its PRs that pulled human review comments in the window — where it cost people time. */
  humanReviewed: DigestPrRef[];
  humanReviewedMore: number;
}

export interface AutomationOutput {
  userId: number;
  login: string | null;
  displayName: string | null;
  /** What the workspace says this automation DOES; null when unclassified. Drives the caption,
   *  never the maths — the vector is identical whatever the role. */
  role: ReviewerRole | null;
  /** Repos it touched in the window, by PR count, descending. Capped for rendering. */
  repos: Array<{ repoId: number; repoFullName: string; prs: number }>;
  metrics: AutomationMetricValue[];
  /** ABSENT unless requested (`?evidence=1`), matching the person route's shape. */
  evidence?: AutomationOutputEvidence;
}

/** GET /api/bot-authoring — CORE, free, deterministic, no AI. `output: null` covers every
 *  degrade in ONE shape (unknown/foreign user, a HUMAN, no authored PRs in this workspace) so
 *  the route is not an existence oracle — the same posture as the person route. */
export interface AutomationOutputResponse {
  workspaceId: number;
  window: { fromMs: number; toMs: number };
  output: AutomationOutput | null;
}

// ---- The work plan (Pro): "what should I work on today" ----------------------------------
//
// A prioritised worklist for ONE workspace, plus an optional Haiku-written narration of it.
// It sits directly under the daily-brief strip, and the relationship between the two is the
// whole design constraint:
//
//   THE BRIEF SAYS HOW MUCH. THE PLAN SAYS IN WHAT ORDER. THEY ARE ONE POPULATION.
//
// `WorkPlanEvidence` is folded from the SAME `/api/attention` cards `computeBriefCounts` counts
// (plus two signals the cards never carried — "can land now" and "behind trunk"), so a plan that
// disagreed with the strip above it would be a bug in one fold, not two opinions. `counts` below
// is carried on the wire precisely so that agreement is ASSERTABLE rather than assumed.
//
// ── THE DIVISION OF LABOUR, WHICH IS THE SAFETY PROPERTY ─────────────────────────────────────
// EVERY FIGURE, ID, LINK AND RANK IS CODE-DERIVED. The model receives the already-ranked items
// and may only (a) choose which of them to foreground, (b) order those, and (c) write one
// sentence each about WHY NOW. It may not invent an item, restate a number, or drop work from
// the board — anything it omits still renders, below, under its own heading.
//
// That is enforced three ways, not by prompt alone: ids the model names are intersected with the
// evidence (unknown ⇒ dropped and COUNTED, see `droppedIds`); every string it produces passes the
// digit gate, so a figure cannot reach the screen through prose; and the UI renders model text in
// the `--ai-*` palette beneath code-derived chips, never mixed into the same line.
export type WorkPlanKind =
  /** Approved-or-clean and GitHub will take it: the shortest path to a merged PR. */
  | 'merge'
  /** `mergeStateStatus === 'behind'` — GitHub is REFUSING the merge until it is updated.
   *  ⚠ Not "the base branch moved on", which is true of most healthy PRs. */
  | 'update_branch'
  /** The viewer's own open PR whose head-commit CI rollup is red. */
  | 'unblock_ci'
  /** A review was requested of the viewer. */
  | 'review'
  /** A thread is waiting on the viewer's reply. */
  | 'reply'
  /** An untouched review thread on someone's open PR — nobody has answered it. */
  | 'thread'
  /** A review has been requested of SOMEONE and nobody has moved. Ageing, unowned. */
  | 'nudge';

/** The code-derived evidence behind one row. Every field here is a fact a reader can check by
 *  following the row's link — that is the bar for putting anything in this object. */
export interface WorkPlanFacts {
  /** Standing approvals on the PR. */
  approvals?: number;
  /** GitHub's protection-aware merge state, passed through verbatim. */
  mergeStateStatus?: MergeStateStatus;
  /** Head-commit CI rollup. Red is ALWAYS the pair `failure` | `error`, never one of them. */
  ciStatus?: CiStatus | null;
  /** Review threads with no reply and no follow-up commit touching the file. */
  untouchedThreads?: number;
  /** Reviewers still on the hook — users AND GitHub teams (a team request has no user id). */
  pendingReviewers?: number;
  /** Files the PR touches, for "is this a five-minute job or an afternoon". */
  changedFiles?: number;
  /** Hours since `clock`. ⚠ DERIVED FROM `now`, so it must never enter a payload hash. */
  ageHours?: number;
  /** WHICH clock `ageHours` measures. Never assume "since opened" — the four signals age
   *  against four different instants, and saying so is the difference between a fact and a
   *  plausible number. */
  clock?: 'opened' | 'requested' | 'last_commit' | 'thread_created' | 'observed';
}

export interface WorkPlanItem {
  /** Namespaced and stable across ticks: `wp:<kind>:<prId|repoId[:threadId]>`. It is the join
   *  key between the evidence and the model's steps, so it may never encode a time. */
  id: string;
  kind: WorkPlanKind;
  /**
   * WHAT THIS ROW IS ABOUT — and it is NOT derivable from `prId` or from the id shape.
   *
   * ⚠ Two different questions were once answered by one predicate, and both halves shipped wrong.
   * "Is this row the PR's ONE job?" (the per-PR dedup: two threads on a PR are two jobs, so a
   * thread row answers NO) is a different question from "is this row about a pull request?" (a
   * thread row answers YES — it is a conversation on one). Deriving the second from the first told
   * the model that a review thread was "the repository default branch", and told the card to draw
   * it as one.
   *
   * `'repo'` today means exactly one thing: the red-trunk arm of `unblock_ci`, which is about a
   * default branch and whose `prId` — when it has one — is only the PR that landed the current
   * head. Anything `'repo'` must never be described, drawn or narrated as a pull request.
   */
  subject: 'pr' | 'repo';
  /** null only on a repo-grained row (a red trunk whose head sha resolves to no PR). */
  prId: number | null;
  repoId: number;
  repoFullName: string;
  prNumber: number | null;
  prTitle: string | null;
  threadId?: number | null;
  /** Pre-built server-side. ⚠ Still render it through `safeExternalUrl()`. */
  githubUrl: string;
  /** The same three tiers the attention board and My Turn use: `direct` = it names you,
   *  `maintained` = it is in a repo you maintain, `none` = shared work in scope. A row's copy
   *  may never claim ownership the tier does not support. */
  relevance: MyTurnRelevance;
  facts: WorkPlanFacts;
  /** 0..1 — how few steps from landing. A mergeable, approved PR is 1. */
  proximity: number;
  /** 0..1 — how likely this is to sit untouched, from its own clock. */
  stallRisk: number;
  /** The deterministic rank. Items arrive sorted by it, descending. */
  score: number;
  /** A CODE-WRITTEN one-liner naming the concrete blocker ("behind trunk", "2 approvals,
   *  checks green"). ⚠ NEVER model output — this renders even when nothing was generated. */
  reason: string;
  /**
   * The `InsightCard.id` this row was folded from — THE JOIN KEY between a narration step and a
   * board row. The SPA resolves `WorkPlanStep.id → WorkPlanItem.id → cardId` to land each model
   * sentence under the right card.
   *
   * ⚠ Deliberately ABSENT from the plugin's `itemSignature` allow-list, so it never enters
   * `workPlanPayloadHash`: it is redundant with `id` + `prId`, and folding it in would move every
   * stored hash for no change in meaning.
   *
   * Trailing optional for the same independent-deploy reason as `AttentionCardsResponse.doNextIds`.
   */
  cardId?: string;
}

export interface WorkPlanEvidence {
  workspaceId: number;
  /** ISO — when this fold ran. ⚠ NEVER folded into a payload hash: a dormant workspace must
   *  stay a cache hit forever rather than re-billing on a timer. */
  generatedAt: string;
  /** Ranked, capped. */
  items: WorkPlanItem[];
  /** The UNCAPPED population per kind, so a capped list can disclose what it left out. */
  totals: Partial<Record<WorkPlanKind, number>>;
  /** ⚠ THE ALIGNMENT CONTRACT. These are folded from the same `/api/attention` cards the daily
   *  brief counts, carried here so the panel can be asserted equal to the strip above it rather
   *  than hoped equal. A divergence is a defect in ONE fold. */
  counts: {
    myTurn: number;
    myTurnPersonal?: number;
    ciFailing?: number;
    stalled: number;
    untouchedThreads: number;
    needsReviewer: number;
  };
}

/** One narrated step. `why` is model prose; the row it decorates is entirely code-derived. */
export interface WorkPlanStep {
  /** MUST be an id from the evidence. Anything else was dropped before storage. */
  id: string;
  /** One sentence, digit-free, ≤ the phrase cap. */
  why: string;
}

export interface StoredWorkPlan {
  /** One sentence framing the day. Digit-free. */
  headline: string;
  steps: WorkPlanStep[];
  /** What can wait until tomorrow, in one sentence. null when the model offered none. */
  parked: string | null;
  model: string;
  generatedAt: string;
  /** How many ids the model named that the evidence did not contain. Rendered when non-zero:
   *  a silent drop would let a hallucinated reference vanish without trace. */
  droppedIds: number;
}

/** GET (cache read + staleness probe) and POST (billed generation) share this envelope, exactly
 *  like the synthesis seam. `enabled: false` is the OSS/free answer and is never an error. */
export interface WorkPlanResponse {
  enabled: boolean;
  /** Always present when enabled — the deterministic worklist renders with or without a plan. */
  evidence: WorkPlanEvidence | null;
  plan: StoredWorkPlan | null;
  /** GET only: the stored plan was written against different evidence. */
  stale?: boolean;
  /** POST only: already generating, or inside the min-interval — cached row served, $0 spent. */
  throttled?: boolean;
  /** POST only: metered plan out of credits — cached row served, nothing billed. */
  creditsExhausted?: boolean;
  /** POST only: nothing needs doing in this workspace — nothing generated, nothing stored. */
  empty?: boolean;
}

// ── The bot PEER BENCHMARK — GET /api/pro/bot-benchmark (plugin-owned, rides `botDepth`) ────────
//
// The cohort side of "how does our bot compare": per-(vendor x activity band) distributions fitted
// in `packages/ml` (`bot_monitor.panel.fit`), published as a bundled JSON artifact and PROJECTED
// here. Nothing on this wire is account-scoped — the artifact is IDENTICAL FOR EVERY TENANT, names
// no repository and no actor, and carries counts + quantile grids only. Hence no `workspaceId` echo
// and no `?workspace=`: there is no tenant data in the response and therefore no IDOR surface.
//
// ⚠ REFUSALS ARE THE PRODUCT, NOT A DEGRADED STATE. Every arm below is discriminated on `status`
// so a refused metric has NO `grid`/`quantiles`/`nRepos` keys AT COMPILE TIME — the TypeScript
// equivalent of the fitter's `_refusal()`, which omits them so that reading a percentile off a
// refusal raises instead of returning a plausible small number. An interface with optional fields
// would silently discard that guarantee, so never normalise a refusal into a distribution shape
// (`{ quantiles: null }`, `{ nRepos: 0 }`, `grid: []` are all the same defect).

/** Whether a bigger number is better, worse, or neither. SERVED here, CONSUMED by the renderer —
 *  no colour, arrow or verdict may be invented without it. */
export type BotBenchmarkDirection = 'higher_is_better' | 'lower_is_better' | 'neutral';

/** `code` = counted from the corpus rows. `model` = inferred by the severity model. ⚠ Rides the
 *  METRIC ENTRY, not only the spec table, so a consumer looping a cell's metrics can tell them
 *  apart without joining back — a model-derived figure and a code-derived one must be labelled
 *  apart in any panel that mixes them. */
export type BotBenchmarkDerivation = 'code' | 'model';

/** Recomputed AT READ TIME against `corpus.observedAtMax` — the stored value decays on disk. */
export type BotBenchmarkStaleness = 'fresh' | 'aging' | 'stale' | 'expired';

/** Why an answer was withheld, with the numbers behind it so the SPA can write the sentence from
 *  `observed`/`required` rather than inventing one. */
export interface BotBenchmarkRefusal {
  rule: string; // e.g. 'cell_floor'
  message: string; // authored by the fitter; safe to render verbatim
  observed: Record<string, number>; // e.g. { contributing_repos: 1 }
  required: Record<string, number>; // e.g. { contributing_repos: 30 }
}

/** A metric's DEFINITION. ⚠ Shipped in full and never trimmed as "just docs": `numerator` /
 *  `denominator` / `population` / `minUnits` are the mitigation for this feature's biggest
 *  correctness risk — the app's own columns are NOT these columns (the app's acted-on rate folds
 *  in the `likely_addressed` commit heuristic and divides by every in-window thread; the cohort's
 *  divides by settled, fully-read threads). A size optimisation that deletes this prose is a
 *  correctness regression, not a saving. */
export interface BotBenchmarkMetricSpec {
  name: string;
  definition: string;
  numerator: string;
  denominator: string;
  population: string; // keys into BotBenchmarkManifest.populations
  derivation: BotBenchmarkDerivation;
  direction: BotBenchmarkDirection;
  minUnits: number;
  unit: string; // 'rate' | 'hours' | 'count' | …
}

/** A metric that is STRUCTURALLY ABSENT from every cell — not empty, not zero. The three
 *  model-derived metrics while the corpus is unscored. Passing them through is what lets the SPA
 *  say "severity comparison arrives when the corpus is scored" instead of showing nothing. */
export interface BotBenchmarkAbsentMetric {
  name: string;
  definition: string;
  derivation: BotBenchmarkDerivation;
  direction: BotBenchmarkDirection;
  unit: string;
  reason: string; // e.g. 'not_scored'
  note: string;
  requires: Record<string, string>; // the precondition, spelled out
}

/** Evidence about the distribution's shape, and a REFUSAL to name a parametric family in fit v1. */
export interface BotBenchmarkShape {
  n: number;
  family: string | null; // always null in fit v1
  familyReason: string;
  zeroShare: number | null;
  skew: number | null;
  excessKurtosis: number | null;
  iqrOverMedian: number | null;
}

/** The 21-knot empirical inverse CDF. `p` and `v` are parallel and ascending in `p`. */
export interface BotBenchmarkGrid {
  p: number[];
  v: number[];
}

interface BotBenchmarkMetricCommon {
  derivation: BotBenchmarkDerivation;
  population: string;
  /** Per-repository drop tally, keyed by `BotBenchmarkManifest.exclusionReasons`. ⚠ Not one number
   *  called "excluded": `vendor_silent` and `below_min_units` mean opposite things about whether a
   *  blind spot exists. */
  excluded: Record<string, number>;
  reposConsidered: number;
}

export interface BotBenchmarkMetricFitted extends BotBenchmarkMetricCommon {
  status: 'fitted';
  nRepos: number;
  /** The headline five, READ OUT OF THE GRID so the two can never disagree. */
  quantiles: Record<string, number>; // p10 / p25 / p50 / p75 / p90
  grid: BotBenchmarkGrid;
  mean: number;
  sd: number | null;
  min: number;
  max: number;
  /** ⚠ THE ONLY THING THAT SAYS HOW MUCH THE MEDIAN COULD MOVE. At the 30-repo floor a rate's
   *  median CI routinely spans 20 points; "your 41% vs the cohort's 38%" without it is reporting
   *  noise as a gap. `null` below n=2. */
  ciMedian95: [number, number] | null;
  shape: BotBenchmarkShape;
}

export interface BotBenchmarkMetricRefused extends BotBenchmarkMetricCommon {
  status: 'refused';
  refusal: BotBenchmarkRefusal;
}

export type BotBenchmarkMetric = BotBenchmarkMetricFitted | BotBenchmarkMetricRefused;

/** Per-cell disclosure counters. ⚠ PER CELL and cells OVERLAP — one repository belongs to one cell
 *  per vendor it runs, so these must never be summed across cells (`manifest.corpus` holds the
 *  corpus-wide totals). `counts` is an open map on purpose: a new disclosure counter in the fitter
 *  should reach the SPA without a mapper edit. */
export interface BotBenchmarkCoverage {
  counts: Record<string, number>;
  observedAt: { min: string; max: string } | null;
}

/** ⚠ RULE 2's DECLARED SLOTS. `pooledOver`/`widenedFrom` are permanently null in fit v1 because
 *  nothing widens; a future widening MUST fill them, and a consumer is entitled to refuse any cell
 *  whose cohort is not exactly its key. */
export interface BotBenchmarkCohort {
  vendor: string;
  activityBand: number;
  pooledOver: string[] | null;
  widenedFrom: string | null;
  /** ⚠ HOW MANY BANDS THIS VENDOR EARNED (fit v2; 0 on a v1 artifact, which published one
   *  vendor-agnostic table). It must ride EVERY rendered percentile: "you are in the upper fifth"
   *  is honest at 5 bands and a misrepresentation at 10, and the band counts are 10/10/9/7/4/3/2
   *  across the seven fitted vendors. */
  nBands: number;
  /** e.g. `"6 of 10"` — the denominator, pre-rendered so it cannot be dropped by a caller that
   *  forgot it existed. Empty string on a v1 artifact. */
  bandLabel: string;
  /** The SUPPORT units' observed activity range — the interval the rank cut actually drew, not the
   *  range over all members (a repository placed into the band can sit outside it). `null` on a v1
   *  artifact. */
  panelPrsPerPeriod: [number, number] | null;
  /** Repositories that DEFINED the cut in this band. */
  reposBandSupport: number;
}

interface BotBenchmarkCellPresent {
  vendor: string;
  activityBand: number;
  cohort: BotBenchmarkCohort;
  coverage: BotBenchmarkCoverage;
  metrics: Record<string, BotBenchmarkMetric>;
  /** ⚠ `status: 'fitted'` means AT LEAST ONE of the thirteen cleared the floor — which is why the
   *  counts ride beside it. A card gated on the status alone can be drawn for a cell where twelve
   *  metrics refused, and the status would not say so. */
  metricsFitted: number;
  metricsRefused: number;
  metricsTotal: number;
}

export interface BotBenchmarkCellFitted extends BotBenchmarkCellPresent {
  status: 'fitted';
}

export interface BotBenchmarkCellRefused extends BotBenchmarkCellPresent {
  status: 'refused';
  refusal: { rule: string; message: string };
}

/** Why the artifact holds no cell at this key at all. Three DIFFERENT sentences: "your bot's cohort
 *  is structurally impossible", "this stratum is empty", "we have never seen this vendor". */
export type BotBenchmarkAbsentReason =
  | 'vendor_unfittable'
  | 'cell_not_in_corpus'
  | 'vendor_not_in_corpus_vocabulary';

export interface BotBenchmarkCellAbsent {
  status: 'absent';
  vendor: string;
  activityBand: number;
  reason: BotBenchmarkAbsentReason;
  message: string;
  /** Only on `vendor_unfittable` — how much of the corpus the refusal dropped. */
  unfittable?: BotBenchmarkUnfittableVendor;
}

export type BotBenchmarkCellEntry =
  | BotBenchmarkCellFitted
  | BotBenchmarkCellRefused
  | BotBenchmarkCellAbsent;

/** A vendor string that names no product, so it forms NO cell at any n. ⚠ Counts are CORPUS-grain:
 *  "we refused this much" is a statement about the corpus, and an understated refusal is the same
 *  failure as an unstated one, one decimal place quieter. */
export interface BotBenchmarkUnfittableVendor {
  vendor: string;
  reason: string;
  repos: number;
  reviewBotComments: number;
}

/** One rank band of `panelPrsPerPeriod` (MERGED PRs in the frame's 14-day window, ANY AUTHOR). */
export interface BotBenchmarkBand {
  band: number;
  /** [min, max] of the SUPPORT repositories' merged-PR counts — the interval the cut drew. */
  panelPrsPerPeriod: [number, number];
  repos: number;
}

/** One vendor's whole stratification. ⚠ PER VENDOR, not per artifact: the cut is drawn over each
 *  vendor's own support repositories, so one repository running two products lands in two
 *  different bands of two differently-sized ladders. A single flat band table (fit v1) is not a
 *  projection of this and is deliberately not fanned out into one. */
export interface BotBenchmarkVendorBands {
  vendor: string;
  nBands: number;
  reposBandSupport: number;
  /** Ascending by `band`. The PLACEMENT RULE reads the HIGH edges only, in this order. */
  bands: BotBenchmarkBand[];
}

/** Which (vendor, band) keys the artifact actually holds — the SPA's selectable set, so it can
 *  render the picker without fetching a single cell. */
export interface BotBenchmarkCellKey {
  vendor: string;
  band: number;
  status: 'fitted' | 'refused';
  metricsFitted: number;
  metricsTotal: number;
}

export interface BotBenchmarkManifest {
  /** The artifact's WHOLE identity, and the only one — never the filename.
   *  `fit-v1+corpus-v3+panel-…+model-unscored+params-…`. */
  fitKey: string;
  fitVersion: number;
  generatedAt: string;
  corpus: {
    corpusVersion: string;
    benchmarkCorpusVersion: number;
    panelSha256: string;
    walkIds: string[];
    observedAtMin: string;
    observedAtMax: string;
    rows: Record<string, number>;
    reposTotal: number;
    reposOk: number;
    reposAbsent: Record<string, number>;
  };
  scoring: {
    state: string; // 'unscored' | 'scored' | 'mixed_model_versions' | 'scored_unversioned'
    modelVersion: string | null;
    backend: string | null;
    scoredComments: number;
    note: string;
  };
  /** ⚠ `corpusAgeDays` and `state` are RECOMPUTED per request against `corpusObservedAtMax` — the
   *  stored pair is as-of `generatedAt` and decays on disk. Copying it ships an artifact that says
   *  "fresh" forever. */
  staleness: {
    asOf: string;
    corpusObservedAtMax: string;
    corpusAgeDays: number;
    state: BotBenchmarkStaleness;
    thresholdsDays: { aging: number; stale: number; expired: number };
    note: string;
  };
  params: {
    minReposPerCell: number;
    settleHours: number;
    overdueGraceHours: number[];
    quantileGrid: number[];
    quantileMethod: string;
    bootstrapSamples: number;
    bootstrapSeed: number;
    shapeMinN: number;
    stalenessThresholdsDays: { aging: number; stale: number; expired: number };
  };
  cohortAxes: { vendor: string; activityBand: string };
  /** ⚠ PER VENDOR (fit v2). EMPTY on a fit v1 artifact — and placement then REFUSES rather than
   *  reading a stratum that does not describe the vendor it is being asked about. */
  activityBands: BotBenchmarkVendorBands[];
  metricSpecs: BotBenchmarkMetricSpec[];
  absentMetrics: BotBenchmarkAbsentMetric[];
  populations: Record<string, string>;
  unfittableVendors: BotBenchmarkUnfittableVendor[];
  exclusionReasons: Record<string, string>;
  coverageNote: string;
  available: BotBenchmarkCellKey[];
  /** ⚠ `cellsFitted === 0` is a FIRST-CLASS state — the SPA renders ONE banner ("every cohort
   *  needs 30 repositories") instead of thirteen identical refusal paragraphs per cell, and
   *  `metricCellsRefusedByRule` hands it the reason distribution. It is no longer TODAY's state:
   *  the bundled fit v2 corpus fits 43 of 45 cells over 2,204 repositories. Keep the branch — a
   *  vendor cell can still refuse permanently, and a build with no corpus at all is a different
   *  field entirely (`available: false`). */
  summary: {
    vendors: string[];
    cellsTotal: number;
    cellsFitted: number;
    cellsRefused: number;
    metricCellsTotal: number;
    metricCellsFitted: number;
    metricCellsRefusedByRule: Record<string, number>;
    units: number;
  };
}

/** Why no artifact is being served. NOT an error and NOT a refusal — a build-configuration fact:
 *  an OSS/dev checkout, or a `--with-pro` image where the `data/` copy step was forgotten. The
 *  SPA's sentence ("peer benchmarking isn't available in this build") is a different sentence from
 *  "there isn't enough peer data yet", so it must be a different field. */
export type BotBenchmarkUnavailableReason =
  | 'artifact_missing'
  | 'artifact_unreadable'
  | 'fit_version_unsupported';

/** ⚠ THE GUARANTEE: the SPA can always render a sentence. There is no code path where it receives
 *  an empty object and has to guess between "no data", "not entitled", "not built" and "not enough
 *  peers". */
export interface BotBenchmarkResponse {
  available: boolean;
  reason?: BotBenchmarkUnavailableReason;
  message?: string;
  manifest?: BotBenchmarkManifest;
  /** Present only when `?cells=` was sent; one entry per requested key, in request order. */
  cells?: BotBenchmarkCellEntry[];
}

/** The `?cells=` cap. The response body IS the work on this route (a fitted cell is ~10 KB and no
 *  response compression is registered in this backend), so the cap bounds the work per request
 *  while the rate tier bounds the request count — complementary, neither a substitute. ⚠ Over-cap
 *  is a 400, never a silent truncation: a truncated cell list reads to the consumer as "those
 *  cohorts do not exist", which is the one claim this feature must never make by accident. */
export const BOT_BENCHMARK_MAX_CELLS = 24;

// ── The CUSTOMER'S PLACEMENT in the peer cohort — GET /api/pro/bot-benchmark/placement ──────────
//
// The other half of "how does our bot compare". `GET /api/pro/bot-benchmark` serves the COHORT and
// makes no claim about any caller; this route computes the caller's OWN metric vector over the
// corpus's populations and places it. They are two decisions and they stayed two routes, because
// mixing them is how a benchmark starts comparing two columns that share a name and nothing else.
//
// ⚠ THE UNIT OF COMPARISON IS ONE (repository, vendor) PAIR. Never a workspace aggregate: every
// distribution in every cell is over (repo, vendor) units, so a workspace-wide acted-on rate is a
// number no member of any cell resembles and its percentile is a rank in a distribution it does not
// belong to. Bands are per vendor, so one repository running CodeRabbit and Copilot gets TWO
// placements. A workspace view is n placements side by side, or it is nothing.
//
// ⚠ THE CUSTOMER'S METRICS ARE NOT THE APP'S METRICS. `getBotAnalytics.actedOnPct` folds the
// `likely_addressed` commit heuristic into its numerator and divides by every in-window thread;
// `overdueUntouched` uses a fixed 36 h grace; `overlapPct` clusters anchors within ±3 lines. All
// three stay exactly as they are — this route computes the corpus's definitions from scratch
// (`packages/ml/docs/METRIC-CONTRACT.md`, pinned by a golden cross-language fixture). Two
// independent implementations of `acted_on_rate` do not compare a customer to a cohort; they
// compare two questions and render the difference as a finding.

/** Why no cohort exists for this (vendor, activity) pair. FIVE DIFFERENT SENTENCES, and collapsing
 *  them into one "no peer data" is the failure these arms exist to prevent. */
export type BotBenchmarkPlacementRefusalReason =
  /** "We have never measured this bot." DeepSource, `github_code_quality`,
   *  `github_advanced_security`, `codex` and every unbranded reviewer. */
  | 'vendor_not_in_corpus_vocabulary'
  /** "This is not a product." The corpus's catch-all strings (`in_house`, `unknown`, `''`). */
  | 'vendor_unfittable'
  /** "We have too little of this bot." Measured, then declined to stratify — a single cohort
   *  spanning the vendor's whole activity range is the ABSENCE of a stratum, not a coarse one. */
  | 'vendor_unstratifiable'
  /** The vendor has cells; this band is not among them. Never widened to the nearest band. */
  | 'cell_not_in_corpus'
  /** ⚠ ONE OF TWO REFUSALS THAT ARE ABOUT THE CUSTOMER, NOT THE CORPUS. A repository the host has
   *  held for less than the activity window has a PARTIAL window, so its merged-PR count is an
   *  undercount and would place it too LOW — silently. `repos.createdAt` is the app's only
   *  visibility axis and is already load-bearing for My Turn's cutoff. */
  | 'repo_window_incomplete'
  /** ⚠ THE OTHER ONE: a COMPLETE window the repository simply did not use. `walkBudget` is derived
   *  from the merge count, so zero merges means the fold reads ZERO pull requests — and every
   *  reviewer then returns `vendor_silent`, "said nothing here", however much it actually wrote.
   *  Observed: a repository whose 20 merged PRs carried 20 CodeRabbit findings, all merged 40 days
   *  ago, reported all thirteen metrics as silence. An empty read must REFUSE rather than resolve
   *  to a claim about a bot — the distinction this whole feature is built on. Note this is NOT
   *  `repo_window_incomplete`: the window is whole, the work is elsewhere in time. */
  | 'repo_inactive_in_window';

/** Why one metric was withheld for this unit. The corpus's own exclusion vocabulary — spelled
 *  identically so a refusal stays joinable to `BotBenchmarkManifest.exclusionReasons` — plus one
 *  customer-side-only arm the corpus cannot have. */
export type BotBenchmarkUnitExclusionReason =
  | 'repo_not_walked'
  /** ⚠ CUSTOMER-SIDE ONLY, AND IT MUST OUTRANK `vendor_silent`. `walkBudget` is derived from the
   *  repository's merge count in the activity window, so a repository that merged nothing recently
   *  has a budget of zero and the fold reads NO pull requests — every counter is 0 and the reviewer
   *  would otherwise be reported as having said nothing. Observed: twenty real findings on pull
   *  requests merged 40 days ago, rendered as silence across all thirteen metrics.
   *  NOT `repo_not_walked`: the walk succeeded. Nothing was read because there was nothing in the
   *  window to read — a fact about the repository's recent activity, not about our access to it. */
  | 'no_prs_in_window'
  /** No comment from this vendor anywhere in the repository's outcome population. ⚠ UNDEFINED,
   *  NEVER 0.0 — uninstalled, path-scoped and category-suppressed are indistinguishable from here
   *  and all three differ from "commented and was ignored". This is the rule whose violation
   *  manufactures the product's headline finding out of nothing. */
  | 'vendor_silent'
  /** Live in the repository, nothing inside THIS metric's population — a reviewer whose comments
   *  all sit on unmerged pull requests. A different claim: the bot is demonstrably reviewing. */
  | 'vendor_absent_from_population'
  /** Live in the population, population empty — a summariser that opens no review threads has no
   *  thread-outcome rate. Unreachable on the volume side by construction. */
  | 'denominator_empty'
  /** Smaller than the metric's `minUnits`. A refusal and not a caveat, twice over: a per-repository
   *  rate over two threads is noise wearing a percentage sign, AND the cohort EXCLUDED units like
   *  this one, so comparing against a distribution it would not have joined is not a comparison. */
  | 'below_min_units'
  /** ⚠ CUSTOMER-SIDE ONLY. A comment whose body and excerpt are both null (a legacy row from the
   *  2026-06 lean window) cannot be classified as a finding or an approval, so the two
   *  body-reading volume metrics refuse rather than guess. */
  | 'body_unobserved';

/** Every counter the fold accumulates, published in full. ⚠ NOT SUMMARISED: a metric value that
 *  disagrees with the cohort says something is odd, a counter says which population, which gate and
 *  which row. Open maps keyed by the fitter's own names so a new counter needs no wire edit. */
export interface BotBenchmarkPlacementCounters {
  volume: Record<string, number>;
  outcome: Record<string, number>;
  /** Grace hours → count, e.g. `{ '72': 11, '168': 4 }`. */
  overdueEligible: Record<string, number>;
  overdueUntouched: Record<string, number>;
  /** Repository-level disclosure. Belongs to no vendor's population and is never a numerator. */
  repository: Record<string, number>;
}

/** The cohort side of one comparison — read off the placed cell, never recomputed. */
export interface BotBenchmarkPlacementCohortMetric {
  nRepos: number;
  quantiles: Record<string, number>;
  /** ⚠ THE ONLY THING THAT SAYS HOW MUCH THE MEDIAN COULD MOVE. At the 30-repo floor a rate's
   *  median CI routinely spans 20 points; "your 41% vs the cohort's 38%" without it is reporting
   *  noise as a gap. An anomaly whose value lies INSIDE this interval is suppressed. */
  ciMedian95: [number, number] | null;
  direction: BotBenchmarkDirection;
  minUnits: number;
  unit: string;
}

export type BotBenchmarkPlacementMetric =
  | {
      status: 'compared';
      value: number;
      /** The customer's OWN denominator size for this metric — the thing `minUnits` is applied to. */
      units: number;
      /** 0-100. Fraction-below-plus-half-ties off the cell's 21-knot inverse CDF. */
      percentile: number;
      cohort: BotBenchmarkPlacementCohortMetric;
    }
  | {
      /** The customer has a real value; the COHORT refused this metric in this cell. A percentile
       *  is structurally unavailable — never 0, never a plausible small number. */
      status: 'uncompared';
      value: number;
      units: number;
      reason: 'cohort_metric_refused';
      cohortRefusal: { rule: string; message: string };
    }
  | { status: 'excluded'; reason: BotBenchmarkUnitExclusionReason; message: string };

/** ⚠ FOUR KINDS, FOUR ACTIONS. A single "this bot is anomalous" verdict is not actionable; the
 *  point of the split is that each one maps to a different thing to do about it. */
export type BotBenchmarkAnomalyKind = 'volume' | 'engagement' | 'latency' | 'overlap';

/**
 * ⚠ AN ANOMALY NEEDS BOTH A SHARE AND A MAGNITUDE — the Chronology lesson, verbatim: "lopsided AND
 * slow, or say nothing". A percentile alone invents a crisis in a healthy repository, because the
 * 95th percentile of a cohort that is fine everywhere is still fine. Both gates are published, not
 * just their conjunction, so a reader can see WHY it fired and a reviewer can argue with the
 * threshold instead of the verdict.
 */
export interface BotBenchmarkAnomaly {
  kind: BotBenchmarkAnomalyKind;
  /** The metric name it fired on — the fitter's vocabulary, joinable to `metricSpecs`. */
  metric: string;
  /** What to DO about it. One sentence, templated — never model-generated. */
  action: string;
  /** GATE 1 — rank within the cohort. */
  share: { percentile: number; threshold: number; direction: BotBenchmarkDirection };
  /** GATE 2 — absolute distance from the cohort median, in the metric's own unit. */
  magnitude: { value: number; cohortMedian: number; gap: number; threshold: number; unit: string };
  /** The customer's own denominator — the sample this claim rests on. */
  units: number;
  /** What `units` COUNTS, as a plain noun ("merged pull requests", "finished comment threads").
   *  ⚠ IT VARIES BY METRIC and the SPA must not guess it: one rule counts merged PRs and three
   *  count threads, so a single hard-coded noun renders a false sample size. Trailing-optional
   *  because SPA and plugin deploy independently; absent, the clause drops the noun rather than
   *  inventing one. */
  unitsNoun?: string;
  /** The cohort it is a rank within, and how many bands that rank is out of. ⚠ "Upper fifth" is
   *  honest at 5 bands and a misrepresentation at 10. */
  cohortRepos: number;
  bandLabel: string;
}

export interface BotBenchmarkPlacementActivity {
  /** ⚠ MERGED PULL REQUESTS IN THE LAST 14 DAYS, **ANY AUTHOR**. The cohort's axis comes from
   *  GH Archive's merged `PullRequestEvent` count with NO author predicate, so machine-authored
   *  merges are IN the banding axis even though they are OUT of the volume denominator. Two
   *  populations, two jobs: the denominator excludes bumps so a vendor is not judged against
   *  lockfiles; the axis includes them because it proxies how busy the repository is. Excluding
   *  them here would place a bump-heavy repository one or more bands too low (MEASURED: machine
   *  merges are a median 13.2% of merges per cell, IQR 9.3-17.6%). */
  mergedPrsLast14d: number;
  /** The per-repository pull-request cap the corpus walk enforced, applied to the customer's set:
   *  `min(150, round(mergedPrsLast14d * 90 / 14))`. ⚠ A FIDELITY CHOICE, not a definition. */
  walkBudget: number;
  /** How many of the repository's pull requests the fold actually read (`<= walkBudget`). */
  prsConsidered: number;
  /** Days since the host first held this repository. Below the activity window the placement
   *  refuses — a partial window is a silent undercount. */
  repoHeldDays: number;
}

export type BotBenchmarkPlacementCohort =
  | {
      status: 'placed';
      activityBand: number;
      nBands: number;
      /** e.g. `"6 of 10"`. ⚠ Rides every rendered percentile. */
      bandLabel: string;
      /** The support units' observed activity range — the interval the rank cut actually drew. */
      bandRange: [number, number];
      cohortRepos: number;
      /** Set only when the customer is busier than the top band's own high edge. A real caveat
       *  about the outermost band ("the busiest CodeRabbit repository we measured lands 258 merges
       *  a fortnight; you land 400"), NOT a refusal — the outermost bands are open in the direction
       *  they face. */
      aboveTopBandBy: number | null;
    }
  | {
      status: 'refused';
      reason: BotBenchmarkPlacementRefusalReason;
      message: string;
      /** R2 only — how far short the vendor fell, straight off the artifact's refusal block, so
       *  the UI can say HOW MUCH rather than "no data". */
      observed?: Record<string, number>;
      required?: Record<string, number>;
    };

/** ⚠ AN ARRAY, NOT ONE ACTOR. The corpus's unit is `(repository, VENDOR)`, so two logins the
 *  workspace classifies as the same vendor are ONE unit — merging them is the corpus semantics,
 *  and reporting only the first would be a false claim about which account produced the numbers. */
export interface BotBenchmarkPlacementReviewer {
  userId: number;
  login: string;
  label: string | null;
}

// ── WHAT THE REVIEWER COSTS PER UNIT OF WORK ────────────────────────────────────────────────────
//
// The price is `workspace_reviewers.monthly_cents`, read through the same rules every other cost
// surface reads it through. Five of those rules decide the SHAPE of everything below:
//
//  ⚠ 0. EVERY MONEY FIGURE HERE IS A RATE AT THE CURRENT PRICE, NEVER A HISTORY. We know one price
//     (today's) and one throughput (recently observed), and neither licenses a statement about what
//     was spent in the past. The block shipped prorating today's price across the reviewer's whole
//     comment span — "US$236.53 over 8.6 weeks" — which the app cannot evidence: the price may have
//     changed, the subscription may be younger than the span, and nothing bounds the span by how
//     long the host has held the repository. A cap would have kept the false claim and shrunk it,
//     so the CLAIM changed instead: `$/month`, `$ per acted-on thread` at the observed pace, and a
//     span that annualises the WORK and carries no money at all.
//  ⚠ 1. `null` IS NOT `0`. `null` = nobody has said what this costs; `0` = a real, deliberate
//     "we pay nothing for this". They are different facts and nothing may coalesce one into the
//     other. The no-price case is expressed by the ABSENCE of `BotBenchmarkPlacementUnit.cost` —
//     not by a zero, not by an empty object, not by a refusal arm. A "$0.00 per acted-on thread"
//     is a CLAIM about a reviewer nobody priced; absence is the truth. ⚠ AND A THIRD STATE JOINS
//     THEM: a price ENTERED that could not be stated (`monthlyUsd: null`, `pricedReviewers: 0`,
//     every figure refusing `price_unresolved`) — because the only alternative was answering the
//     no-price case, which is silence on a card where a human typed a number.
//  ⚠ 2. `per_seat` MULTIPLIES ON READ. `monthlyUsd` below is always the EFFECTIVE monthly figure
//     (unit × the workspace's derived human seat count); the product is never stored, because it
//     can exceed int4 as cents and would go stale. `unitMonthlyUsd`/`seats` carry the two halves
//     for the tooltip, and a consumer that multiplies again double-charges. ⚠ AND A SEAT COUNT OF
//     ZERO IS RULE 1 ONE LEVEL DOWN: multiplying a real per-developer price by a derived 0 produces
//     a COMPUTED zero that is indistinguishable from a STORED one, and the block then says
//     "recorded as free" about a reviewer somebody priced. Such a row is EXCLUDED and counted in
//     `seatCountZero`, exactly as an unresolvable seat count is.
//  ⚠ 3. THE PRICE IS PER WORKSPACE, AND THE UNIT BELOW IS PER (REPOSITORY, VENDOR) — WHICH IS WHY
//     THE MONEY MOVED OFF IT. One $120/month subscription covering six repositories produced SIX
//     blocks each carrying $120, so every figure was "the whole Workspace subscription measured
//     against ONE repository's work": an upper bound, never a share, and a column a reader adds up
//     unless told not to. The disclosure that told them not to (`sharedWithUnits`, "4 cards here
//     carry this price") was a caveat compensating for a grain mismatch, and a caveat is the
//     weakest fix available. THE GRAIN MOVED INSTEAD: money is now stated once per VENDOR over the
//     whole Workspace (`BotBenchmarkWorkspaceRollup.cost`), where the price and the work it is
//     divided by finally describe the same population, and double-counting is impossible because
//     there is one card and one figure. `BotBenchmarkPlacementCost` survives as the per-repository
//     computation that fold sums; it is NOT reachable from any response type any more.
//  ⚠ 4. THE WHOLE ROUTE IS `botDepth`-GATED, which is the only reason a price may travel on it at
//     all. Do not lift any of this onto a free payload — every other route that echoes a price
//     runs `stripCost` for an unentitled account.
//  ⚠ 5. AND MONEY IS ABSENT ENTIRELY FROM A REPO-NARROWED REQUEST. A `?repoIds=`-narrowed call is
//     the per-repository view, whose grain is exactly the one rule 3 says a price may not be
//     stated at — so the server builds no rollup for it and no cost travels on it at all. That is
//     a STRUCTURAL guarantee rather than a renderer's discretion: it holds even if a future
//     component goes looking for a figure to draw.

/** Why a cost figure is withheld. TEN SENTENCES, joining the fourteen this tab already
 *  distinguishes — and the eleventh state, "no price set", is the ABSENCE of the block. */
export type BotBenchmarkCostRefusalReason =
  /** ⚠ A PARTIAL WINDOW IS AN UNDERCOUNT, AND HERE IT LANDS IN A DENOMINATOR. The placement refuses
   *  a repository held for less than the activity window because its merge count is too low; cost
   *  divides BY that count, so the same undercount inflates every figure — a repository tracked for
   *  three days would report five times its true cost per merged PR, which is this tab's most
   *  quotable number. Same fact as `repo_window_incomplete` one level up, same sentence. */
  | 'repo_window_incomplete'
  /** ⚠ THE DIVISION THE PLACEMENT ALREADY REFUSED. Zero merges in the activity window is
   *  `repo_inactive_in_window` one level up; cost must not resurrect it as a divide-by-zero. */
  | 'no_merges_in_window'
  /** ⚠ THE WORK HAS NO MEASURABLE PACE. The span is the reviewer's OWN observed working period on
   *  the walked slice (earliest → latest comment), and fewer than two timestamped comments — or
   *  several in one instant — leaves no stretch of time at all. Every reviewer-side figure is a
   *  RATE at the current price, so all three refuse: a rate asserts a RECENT PACE, and counts with
   *  no observable stretch behind them are not evidence of one. ⚠ THIS IS WIDER THAN THE
   *  ARITHMETIC — `unactedUsd` and `conversionGapUsd` no longer divide by the span at all, and
   *  still refuse, because the warrant for the claim comes from the observation and not from the
   *  formula. `perMergedPr` is unaffected: it carries the 14-day window at both ends. */
  | 'span_unobserved'
  /** The customer's own `acted_on_rate` was withheld for this unit, so nothing may be derived from
   *  it. ⚠ THE GATE IS THE METRIC, NOT THE RAW COUNT: the fold withholds a rate over a handful of
   *  threads (`below_min_units`) precisely because it is noise wearing a percentage sign, and
   *  reading the counters straight past that gate resurrects the number it refused.
   *  `metric`/`metricReason` name which gate fired rather than a generic "not enough data". */
  | 'own_rate_withheld'
  /** The rate is real and it is 0: NO thread this reviewer settled here was acted on, so a cost PER
   *  acted-on thread is a division by zero. ⚠ The UNACTED figure and the COUNTERFACTUAL still
   *  render here — this is exactly the case they exist for, and the unacted figure is then the
   *  WHOLE MONTHLY PRICE. */
  | 'nothing_acted_on'
  /** ⚠ A REAL PRICE OF EXACTLY 0. Every figure derived from it is exactly 0.00, which is TRUE and
   *  says nothing — so the derived figures refuse with a sentence instead of printing a row of
   *  zeros that reads as a broken panel. The price itself still renders, as "recorded as free". */
  | 'price_is_zero'
  /** The cohort published no fitted `acted_on_rate` in this cell, so there is no median to swap
   *  in. The customer's own figures are unaffected and still render. */
  | 'cohort_rate_unfitted'
  /** The cohort's median acted-on rate is 0 — the counterfactual's denominator would be 0. */
  | 'cohort_rate_zero'
  /** ⚠ A PRICE WAS ENTERED AND NONE OF IT COULD BE STATED — `monthlyUsd` is `null`, which is NOT a
   *  price of 0 and NOT an absent block. Every priced row folded into this unit is per-seat and
   *  every one was dropped: the seat seam is absent, or the workspace resolved to zero human seats.
   *  ⚠ THE ALTERNATIVE WAS SILENCE, and silence was wrong: dropping the rows and then answering "no
   *  price" hands the no-price experience (no block at all) to a workspace where somebody typed a
   *  number, and takes `seatPriceUnresolved`/`seatCountZero` off the screen with it. The block
   *  renders, every figure refuses, and the two counters say which of the two happened. */
  | 'price_unresolved'
  /**
   * ⚠ THE CHOSEN MONTH IS TOO THIN TO PRICE — a rollup-only reason, and the successor to the
   * order statistic `span_unobserved` used to guard.
   *
   * The Workspace rollup's `$ per acted-on thread` divides a monthly price by the threads acted on
   * inside ONE named calendar month (`COST_WINDOW_DAYS`). Under a floor of ten such threads the
   * quotient is a price divided by a handful — noise wearing a dollar sign, and it MOVES BY TENS OF
   * PER CENT on one thread landing either side of the window's edge. This is `below_min_units`'
   * argument applied to money rather than to a rate, and it is stated as its own reason because the
   * remedy is different: `below_min_units` is answered by pooling, this one only by time.
   *
   * ⚠ IT WITHHOLDS THE PER-THREAD MONEY AND NOTHING ELSE. The pooled counters, the acted-on rate
   * and `unacted.unactedUsd` are over the whole read slice and are unaffected — a thin month is not
   * a reason to stop reporting what the subscription buys.
   *
   * ⚠ AND IT IS A REFUSAL, NEVER A FALLBACK. A reviewer with months of history and an empty recent
   * month is DORMANT; smearing its lifetime average over the current price would answer a question
   * nobody asked with a number nothing measured.
   */
  | 'window_underpopulated'
  /** ⚠ THE ESTATE IS PARTIAL, SO EVERY WORKSPACE-GRAIN FIGURE WOULD BE A FALSE EXACT CLAIM — the
   *  rollup-only reason, and it OUTRANKS all nine above it. `BOT_BENCHMARK_MAX_PLACEMENT_REPOS`
   *  bounds the fold at twelve repositories, and past that the response carries `truncated: true`.
   *  A per-repository figure survives truncation intact (each one is about its own repository and
   *  nothing else); a WORKSPACE figure does not, because its denominator is a sum over repositories
   *  and some of the terms are missing. "$4.10 per acted-on thread across your Workspace" computed
   *  over eight of fourteen repositories is not an approximation of the answer, it is a different
   *  question with the same words — and it is wrong in the direction that inflates the cost, since
   *  the price is whole and the work is partial. ⚠ THE COUNTERS AND THE SPREAD STILL RENDER: a sum
   *  of counts over eight repositories is an honest sum over eight repositories, and a rank
   *  distribution is a shape rather than a total. It is the MONEY that refuses. */
  | 'workspace_truncated';

export interface BotBenchmarkCostRefusal {
  status: 'refused';
  reason: BotBenchmarkCostRefusalReason;
  message: string;
  /** `own_rate_withheld` only — the fitter's metric name and the unit exclusion that withheld it. */
  metric?: string;
  metricReason?: BotBenchmarkUnitExclusionReason;
}

/**
 * THE OBSERVED SPAN — the stretch of time this reviewer's own output on the walked slice covers.
 *
 * ⚠ IT MEASURES THE WORK AND NEVER THE MONEY, AND THAT IS THE CORRECTION IT CARRIES. It shipped
 * with a `usd` field — `monthlyUsd × days ÷ 30.44` — and every reviewer-side figure was a share of
 * it, so the card asserted "US$236.53 over 8.6 weeks": a historical spend the app cannot evidence.
 * The price may have changed, the subscription may be younger than the span, and nothing bounds the
 * span by how long the host has held the repository. A CAP WOULD HAVE KEPT THE CLAIM AND SHRUNK IT;
 * the claim was the defect, so `usd` is GONE from this type and every money figure is now a RATE at
 * the current price, with the span used only to restate a COUNT as a count per month
 * (`actedPerMonth = actedThreads × 30.44 ÷ days`). Do not put a price back on this interface.
 *
 * ⚠ IT IS STILL NOT THE 14-DAY WINDOW, and it is still disclosed. The slice is
 * `ORDER BY updated_at DESC LIMIT walkBudget` with NO time predicate, and `walkBudget` is
 * calibrated to roughly ninety days, so the pace measured here is a pace over months while
 * `perMergedPr` sits on the fortnight at both ends of its fraction. `spanNote` says so.
 *
 * ⚠ AND IT IS READ OFF THE REVIEWER'S COMMENTS, NOT OFF MERGE TIMES. The thread-outcome population
 * is every HUMAN-AUTHORED pull request in the slice, merged or not, and a bot writes while a pull
 * request is OPEN — so a span read off merge timestamps would be narrower than the population it
 * measures.
 *
 * `null` ⇒ the span could not be observed, and every reviewer-side figure REFUSES with
 * `span_unobserved` rather than asserting a pace nothing was measured over.
 */
export interface BotBenchmarkCostSpan {
  /** Days between the reviewer's earliest and latest observed comment on the pull requests read.
   *  ⚠ ALWAYS > 0 AT SIX DECIMAL PLACES — a span that is zero-length, or that rounds to none, is
   *  `null` instead. This rounded figure is the one the per-month arithmetic divides by, so the
   *  quotients on this block are recomputable from the payload. */
  days: number;
  /** ISO-8601, so the panel can state the period rather than only its length. */
  fromIso: string;
  toIso: string;
  /** How many of its comments carried a readable timestamp. ⚠ ≥ 2 by construction. */
  comments: number;
}

/**
 * ⚠ WHAT THE PRICE CURRENTLY BUYS AND NOBODY ACTS ON — measured, own data only, PER MONTH, and NOT
 * the counterfactual.
 *
 * `monthlyUsd × (1 − actedOnRate)`: the share of the CURRENT monthly price that buys feedback
 * nobody acts on, at the pace recently observed. ⚠ A RATE, NEVER A HISTORY — it shipped as
 * `span.usd × (1 − actedOnRate)`, a spend over the reviewer's whole comment span, which is a claim
 * about the past that a current price and a recent throughput do not license.
 *
 * It answers a DIFFERENT question from `BotBenchmarkCostAtPeerEngagement.conversionGapUsd` ("what
 * better engagement would be worth"), it is always the LARGER of the two whenever the cohort median
 * is below 1, and the two must never be rendered in one sentence. The headline shipped printing the
 * counterfactual gap under this one's words.
 *
 * ⚠ IT SURVIVES A ZERO ACTED-ON RATE, which is the whole reason it is its own arm rather than a
 * field on `BotBenchmarkCostYours`: at `actedOnRate === 0` the per-thread figure is a division by
 * zero and refuses, and this figure is the entire monthly price — the strongest finding the block
 * can produce.
 */
export interface BotBenchmarkCostUnacted {
  status: 'value';
  /** `actedThreads ÷ settledThreads`, DERIVED FROM THE COUNTS rather than copied off the metric —
   *  one source, so the rate and the counts beside it on screen cannot disagree. */
  actedOnRate: number;
  actedThreads: number;
  settledThreads: number;
  /** `monthlyUsd × (1 − actedOnRate)`, US dollars A MONTH. ⚠ BOUNDED in `[0, monthlyUsd]` — the
   *  second factor is a rate — and that bound is structural, not a clamp. */
  unactedUsd: number;
}

/** The customer's own arithmetic: their price, THEIR MEASURED THREADS, their engagement. ⚠ COUNTED,
 *  NEVER PROJECTED — `actedThreads` is `threadsSettledCompleteActed`, an actual number of threads
 *  over the walked slice, and the span beside it is that same slice's own stretch of time. */
export interface BotBenchmarkCostYours {
  status: 'value';
  /** ⚠ REAL COUNTS, from the fold's own outcome counters — the numerator and denominator of
   *  `acted_on_rate`, which is why they are consistent with the metric row above by construction. */
  actedThreads: number;
  settledThreads: number;
  actedOnRate: number;
  /** `actedThreads × 30.44 ÷ span.days` — the same count restated as a PACE, threads acted on per
   *  month. ⚠ THE SPAN'S ONLY JOB: it annualises the WORK so a monthly price has something current
   *  to divide by. It is on the wire because the quotient below is otherwise uncheckable. */
  actedPerMonth: number;
  /** `monthlyUsd ÷ actedPerMonth`. ⚠ ARITHMETICALLY IDENTICAL to the `span.usd ÷ actedThreads` it
   *  replaced — the change was in the CLAIM, not the value — and still NOT `windowUsd ÷ a
   *  projection`. */
  perActedOnUsd: number;
}

/**
 * ⚠ ONE FACTOR SWAPPED, AND IT IS A COUNTERFACTUAL RATHER THAN A PEER DISTRIBUTION.
 *
 * "Your volume, your price, THEIR engagement rate" — the cohort's median `acted_on_rate` replaces
 * the customer's, and NOTHING ELSE MOVES. Multiplying a cohort-p50 volume by a cohort-p50
 * engagement rate and calling the result "what a peer pays" is a real statistical error: THE MEDIAN
 * OF A PRODUCT IS NOT THE PRODUCT OF THE MEDIANS, it would be invisible on screen, and it would be
 * wrong in a direction nobody could check. Do not construct a "peer cost" from two cohort
 * quantiles, and do not let a second cohort figure into this arm.
 */
export interface BotBenchmarkCostAtPeerEngagement {
  status: 'value';
  /** THE ONE SWAPPED FACTOR — the cohort's median `acted_on_rate` in this (vendor, band) cell. */
  cohortActedOnRate: number;
  /** `settledThreads × cohortActedOnRate` — the customer's OWN settled-thread count with the
   *  cohort's rate. Fractional, and counterfactual by construction rather than by projection. */
  actedThreadsAtPeer: number;
  /** `actedThreadsAtPeer × 30.44 ÷ span.days` — that count as a monthly PACE, the divisor below.
   *  On the wire for the same reason its sibling on `BotBenchmarkCostYours` is. */
  actedPerMonthAtPeer: number;
  /** `monthlyUsd ÷ actedPerMonthAtPeer`. */
  perActedOnUsd: number;
  /** yours − counterfactual, per acted-on thread. `null` when the customer's own figure refused
   *  (nothing acted on), where a difference has no left-hand side. */
  perActedOnGapUsd: number | null;
  /**
   * WHAT BETTER ENGAGEMENT WOULD BE WORTH, PER MONTH: `monthlyUsd × (cohortRate − yourRate)` — the
   * additional share of the SAME monthly price that peer-level engagement would convert. SIGNED:
   * negative means this team engages MORE than the cohort's median, a real and good state that must
   * not be rendered as waste. ⚠ A RATE, NEVER A HISTORY — it shipped multiplied by `span.usd`,
   * which made it a claim about money already spent (see `BotBenchmarkCostSpan`).
   *
   * ⚠ IT IS A DIFFERENCE OF TWO SHARES, NEVER A RATIO, AND THAT IS WHAT BOUNDS IT. The first cut
   * was `× (1 − yourRate ÷ cohortRate)`, which is bounded only while `yourRate` is at or below the
   * cohort median: a team engaging at three times a real fitted median (there are cells whose
   * `acted_on_rate` p50 is 0.24) produced a NEGATIVE figure four times the entire spend, and the
   * renderer stated it as a dollar amount of that spend. Both factors here are rates in [0,1], so
   * this is bounded in `[−monthlyUsd, monthlyUsd]` in both directions, structurally.
   *
   * ⚠ AND IT IS NOT THE SAME QUANTITY AS `BotBenchmarkCostUnacted.unactedUsd`. That one is what the
   * price currently buys and nobody acts on; this one is what closing the gap to the median is
   * worth. They differ by a factor of the cohort rate, and a sentence that names one while printing
   * the other is the defect this pair of fields was split apart to prevent.
   *
   * ⚠ NOT NULLABLE: this arm is only reached when `acted_on_rate` COMPARED, which is exactly the
   * condition under which both rates exist — so it is defined even when `yours` REFUSED.
   */
  conversionGapUsd: number;
}

/**
 * ⚠ THE PER-REPOSITORY COST COMPUTATION — **NEVER SERIALISED, AND NO LONGER BUILT ON ANY REQUEST**.
 *
 * Nothing reachable from `BotBenchmarkPlacementResponse` carries this any more, and that is the
 * point rather than an oversight. The price is per WORKSPACE and this block's unit is one
 * (repository, vendor) pair, so every figure in it is the whole subscription measured against ONE
 * repository's work: an UPPER BOUND, never a share, and six repositories of CodeRabbit rendered six
 * cards each carrying the same $120. Nothing legitimate can be done with such a column — adding it
 * up is the "$720" defect, and reading one row as "what this repository costs" is the same error
 * one row at a time. It shipped with a `sharedWithUnits` disclosure telling the reader not to add
 * them, which is a caveat compensating for a grain mismatch; the grain moved instead.
 *
 * ⚠ AND IT IS HONESTLY DEAD ON THE REQUEST PATH — say so rather than implying otherwise. The
 * placement route builds the rollup from the RAW per-repository facts (merge counts, thread counts,
 * observed spans, each repository's own cohort median), not from n of these blocks, because a sum
 * of per-repository COSTS is not the estate's cost: the price is one subscription and would be
 * counted once per repository. So `buildUnitCost` is now reached only by `benchmark-cost.test.ts`.
 *
 * It is kept, with its 34 tests, because it is the PINNED SPECIFICATION of the rules the rollup
 * imports piecewise from `cost.ts` — `resolveUnitPrice`'s three-valued price, `resolveSpan`'s three
 * ways to have no observable stretch, the guard ORDER, and every refusal sentence. Deleting it
 * would delete the executable statement of those rules while leaving four call sites depending on
 * them. What travels to a client is `BotBenchmarkWorkspaceRollup.cost`, one figure per vendor over
 * the whole Workspace, where the price and the work it divides finally describe the same
 * population.
 *
 * ⚠ DO NOT RE-ATTACH IT TO A UNIT. The repo-grained view of this feature (the repository's own Bots
 * tab) is precisely the view that may not state a price at all.
 */
export interface BotBenchmarkPlacementCost {
  /** The EFFECTIVE monthly price in THIS Workspace, US dollars — seat-multiplied already (rule 2),
   *  and the BASIS OF EVERY REVIEWER-SIDE FIGURE HERE, each of which is a rate at this price rather
   *  than a spend over a past period.
   *  ⚠ THREE VALUES, THREE MEANINGS. `0` is a real, stored price ("we pay nothing for this").
   *  `null` is NOT that and NOT an absent block: it is a price somebody ENTERED that could not be
   *  stated, because every priced row folded here is per-seat and every one was dropped —
   *  `pricedReviewers` is then `0`, `seatPriceUnresolved`/`seatCountZero` say which, and every
   *  figure refuses with `price_unresolved`. A unit with NO price carries no cost block at all. */
  monthlyUsd: number | null;
  costModel: CostModel;
  /** The STORED per-seat unit and the workspace's derived human seat count. Both `null` under
   *  `'flat'`, where the stored figure IS the monthly one. */
  unitMonthlyUsd: number | null;
  seats: number | null;
  /** How many of the unit's folded reviewer logins carried a price. ⚠ Two logins the workspace
   *  classifies as one vendor are ONE unit, so their prices are SUMMED — the sanctioned
   *  within-workspace total (one row per actor) — and this says how many rows went into it. */
  pricedReviewers: number;
  /** ⚠ A DISCLOSURE, NOT A FIGURE: folded reviewers whose price is per-seat and whose seat count
   *  this build could not resolve (the host seam is absent). Their price is EXCLUDED from
   *  `monthlyUsd` rather than read as the unmultiplied unit, which would understate it. Normally 0. */
  seatPriceUnresolved: number;
  /** ⚠ A SEPARATE DISCLOSURE FROM `seatPriceUnresolved`, AND ITS OWN SENTENCE — folded reviewers
   *  whose price is per-seat and whose workspace resolved to ZERO human seats. A computed zero is
   *  not a stored zero: somebody typed US$15 per developer and the derived seat count (distinct
   *  human pull-request authors over a fixed trailing 30 days) came back empty, which is a failure
   *  of the proxy and not a bill of nothing. Multiplying it out shipped a real "Recorded as free"
   *  on a priced reviewer. Excluded from `monthlyUsd` exactly like the unresolved case; normally 0. */
  seatCountZero: number;
  /** The 14-day activity window the placement is BANDED on. ⚠ IT IS THE BASIS OF `perMergedPr`
   *  ALONE — that figure divides this window's price by this window's merges, both ends of the
   *  fraction inside it. Every reviewer-side figure is a rate at `monthlyUsd` instead. */
  windowDays: number;
  /** `monthlyUsd × windowDays ÷ 30.44`. ⚠ A MONTH IS NOT 28 DAYS and it is not 30 either. `null`
   *  exactly when `monthlyUsd` is. */
  windowUsd: number | null;
  /** ⚠ THE WORK'S MEASUREMENT WINDOW — see `BotBenchmarkCostSpan`; it carries no money. `null` ⇒
   *  the three reviewer-side arms refuse with `span_unobserved`; `perMergedPr` is unaffected. */
  span: BotBenchmarkCostSpan | null;
  /** ⚠ VESTIGIAL, AND KEPT ONLY AS THE RECORD OF A FIX THAT DID NOT WORK. It counted how many
   *  blocks in one response carried this same Workspace price, so the panel could say "4 cards here
   *  carry it — do not add them up". That is a caveat compensating for a grain mismatch, and the
   *  grain moved instead (rule 3): money is now stated once per vendor over the whole Workspace,
   *  where adding is structurally impossible because there is one figure. Nothing reads this on a
   *  wire any more — this whole type is off the wire. */
  sharedWithUnits: number;
  /** `windowUsd ÷ mergedPrsLast14d`. ⚠ INDEPENDENT OF THE REVIEWER: it divides a price by a
   *  repository's own merges, so it still renders when every metric about the bot was withheld —
   *  and it is the ONE figure here anchored on the 14-day window at both ends. ⚠ A RATIO, NOT A
   *  WINDOWED TOTAL: it is dollars per merged pull request and does not scale with the window, so a
   *  renderer must not suffix it "per 14 days" (that shipped, and reads as $/PR/fortnight). */
  perMergedPr:
    | { status: 'value'; value: number; mergedPrs: number }
    | BotBenchmarkCostRefusal;
  /** ⚠ WHAT THE PRICE CURRENTLY BUYS AND NOBODY ACTS ON, PER MONTH — measured, and a DIFFERENT
   *  quantity from the counterfactual gap. */
  unacted: BotBenchmarkCostUnacted | BotBenchmarkCostRefusal;
  yours: BotBenchmarkCostYours | BotBenchmarkCostRefusal;
  atPeerEngagement: BotBenchmarkCostAtPeerEngagement | BotBenchmarkCostRefusal;
  /** ⚠ THE TIME BASE'S OWN CAVEAT, SERVED SO A RENDERER CANNOT DROP IT. The reviewer-side figures
   *  are RATES at today's price over a recently-measured pace; the span is the measurement window
   *  for that pace and NOT a billing period; `perMergedPr` is on the fortnight instead. A card
   *  carrying all of that has to say which figure sits on which — and must not imply, as the note
   *  this replaced did, that a subscription was prorated across the span. */
  spanNote: string;
}

export interface BotBenchmarkPlacementUnit {
  repoId: number;
  repoOwner: string;
  repoName: string;
  /** The automated reviewer(s) this unit folds, in the app's own vocabulary. */
  reviewers: BotBenchmarkPlacementReviewer[];
  /** The CORPUS vendor string this reviewer maps onto — `null` when the app knows a brand the
   *  corpus has never seen (the placement then refuses with `vendor_not_in_corpus_vocabulary`). */
  vendor: string | null;
  /** The app's own `AutomatedReviewerKind`, so the SPA can label the bot even when the corpus
   *  cannot place it. */
  botKind: string | null;
  activity: BotBenchmarkPlacementActivity;
  placement: BotBenchmarkPlacementCohort;
  counters: BotBenchmarkPlacementCounters;
  /** Keyed by the fitter's metric names. */
  metrics: Record<string, BotBenchmarkPlacementMetric>;
  /** Empty is the common and healthy answer. */
  anomalies: BotBenchmarkAnomaly[];
  // ⚠ NO `cost` HERE, AND NOTHING MAY PUT ONE BACK. A unit is one (repository, vendor) pair and the
  // price is per WORKSPACE, so any money on this object is the whole subscription measured against
  // one repository's work — an upper bound wearing the grammar of a fact. Money is stated once per
  // vendor over the whole estate, on `BotBenchmarkWorkspaceRollup.cost`. See
  // `BotBenchmarkPlacementCost`'s own header for the full argument.
}

// ── THE WORKSPACE ROLLUP — one card per VENDOR, over every repository it is live in ──────────────
//
// The unit above is the unit of COMPARISON, and it has to be: every distribution in every corpus
// cell is over (repository, vendor) pairs, so a workspace-wide rate is a number no cohort member
// resembles. The unit above is NOT the unit of DECISION. "Is CodeRabbit worth what we pay for it"
// is a question about a subscription, and a subscription is bought once for a Workspace — so the
// answer has to be computed once for a Workspace too, and the rail's Benchmark tab now shows one
// card per vendor with the per-repository placements folded into it as EVIDENCE rather than as
// twelve separate verdicts.
//
// ⚠ THE TWO GRAINS DO DIFFERENT JOBS AND NEITHER SUBSTITUTES FOR THE OTHER. The per-repository card
// (thirteen metric strips, band placement, anomalies, refusals) still exists — it moved to the
// repository's own Bots tab, where its grain matches the screen it is on. The rollup states the
// money, the pooled counters, the spread of placements and the estate-matched expectation. What the
// rollup must never do is compute a percentile: it has no cohort, because there is no distribution
// of workspaces.
//
// ⚠ RATES ARE ADDITIVE; SPANS ARE NOT. Where the fold needs a per-month pace across repositories it
// SUMS THE PER-REPOSITORY RATES. Unioning the observation spans instead — earliest comment anywhere
// to latest comment anywhere — is the tempting shortcut and it is wrong in a way that reads as
// plausible: a reviewer that ran in one repository in January and another in July has a seven-month
// union and was working for two, which understates its pace by a factor of three and its cost per
// acted-on thread by the same. A repository whose own span is unobservable contributes NOTHING to
// the sum and is counted in `spanUnobservedRepos`, never imputed from its siblings.

/** Why a whole rollup section is withheld. FIVE SENTENCES, and they are not interchangeable: three
 *  are about the corpus having nothing to compare against, one is about the estate being a single
 *  repository (where a "spread" is a category error rather than a thin sample), and one is about
 *  the customer having no settled threads to rate. ⚠ Distinct from `BotBenchmarkCostRefusalReason`
 *  on purpose — those withhold a MONEY figure and every one of them has a remedy involving a price;
 *  these withhold a COMPARISON and none of them do. */
export type BotBenchmarkRollupRefusalReason =
  /** The vendor is live in exactly ONE repository, so there is no spread to describe. ⚠ NOT a
   *  small-sample caveat: one point has no distribution, and rendering "1 of 1 repositories above
   *  the median" invites a reader to see a pattern in a single placement. The repository's own card
   *  says everything there is to say. */
  | 'single_repo'
  /** No repository this vendor is live in was PLACED in a cohort band with a comparable acted-on
   *  rate, so no percentile exists to spread. The per-repository refusals say why, each in its own
   *  words; this is their sum and it is an absence, never a middling score. */
  | 'no_placed_repos'
  /** The corpus published no fitted `acted_on_rate` median for any band this estate lands in, so
   *  there is no peer rate to swap in for the customer's. ⚠ Different from `no_placed_repos`: the
   *  repositories may well be placed, with the cohort refusing this one metric in their cells. */
  | 'no_fitted_cohort_rate'
  /** This vendor settled no threads anywhere in the estate — a summariser that opens no review
   *  threads, or a reviewer whose every thread is still open. The denominator of every rate here is
   *  a settled-thread count, and dividing by nothing would render engagement as 0%, which is a
   *  claim about a reviewer that has not yet been given the chance to be acted on. */
  | 'no_settled_threads'
  /** The corpus has never measured this brand at all, so nothing about a peer may be stated —
   *  Sonar, GitHub Advanced Security, `github-actions` and every unbranded reviewer land here. ⚠ The
   *  CARD STILL RENDERS: its counters and its cost are the customer's own facts and owe the corpus
   *  nothing. Only the two comparison sections refuse. */
  | 'vendor_not_in_corpus';

/** The refused arm shared by every rollup section, shaped like `BotBenchmarkCostRefusal` so one
 *  renderer draws both. */
export interface BotBenchmarkRollupRefusal {
  status: 'refused';
  reason: BotBenchmarkRollupRefusalReason;
  message: string;
}

/**
 * ONE ROW OF THE EVIDENCE TABLE — a repository this vendor is live in, and what it contributed.
 *
 * ⚠ THE ROLLUP IS A FOLD AND THIS IS ITS AUDIT TRAIL. Every headline figure on the card is a sum
 * over these rows, so a reader who doubts the total can find the repository responsible for it
 * without leaving the card. A card whose spread says "3 of 5 above the median" and whose table
 * lists four repositories is caught by the reader, which is the entire reason the table ships
 * beside the numbers rather than behind a link.
 *
 * ⚠ COUNTS ARE PUBLISHED UNCONDITIONALLY, RATES ARE GATED. `settledThreads`/`actedThreads` are
 * counts and are always real; `actedOnRate` is `null` whenever this repository's own metric was
 * WITHHELD (`below_min_units` and friends), because a rate over four threads is exactly the number
 * that gate exists to refuse and printing it in a small table cell does not make it less noise. The
 * counts still pool into the card's headline — pooling is the remedy for a thin sample, which is
 * why the gate applies to the ROW and not to the fold.
 */
export interface BotBenchmarkRollupContribution {
  repoId: number;
  repoOwner: string;
  repoName: string;
  /** ⚠ ANY AUTHOR — the same banding axis the per-repository placement used, so the table and the
   *  card it sits on cannot disagree about how busy this fortnight was. */
  mergedPrsLast14d: number;
  /** Where this repository landed, or `null` when its placement refused. ⚠ `nBands` rides along
   *  because "band 6" is honest at 10 bands and a misrepresentation at 3. */
  band: { activityBand: number; nBands: number; bandLabel: string } | null;
  /** ⚠ THE ROW SAYS WHY RATHER THAN GOING BLANK. A repository whose placement refused still earns a
   *  row — it is live, it contributed counts, and it is part of the estate the money is divided by;
   *  dropping it would make the table disagree with `liveInRepos`. `null` when the placement
   *  succeeded. */
  placementRefusal: BotBenchmarkPlacementRefusalReason | null;
  /** This repository's own acted-on rate, `null` when its metric was withheld. See the header. */
  actedOnRate: number | null;
  /** 0-100 within this repository's own cohort band. `null` unless the metric COMPARED — never 0,
   *  which would read as "worst in the cohort" for a comparison that did not happen. */
  percentile: number | null;
  /** The rate's denominator and numerator, always real counts. These are what pool. */
  settledThreads: number;
  actedThreads: number;
  /** The reviewer's own observed working period in this repository, in days. ⚠ `null` is a real and
   *  common state, and it means this repository contributed NOTHING to the card's per-month pace —
   *  never that its pace was zero, and never that it borrows a sibling's span. */
  spanDays: number | null;
}

/**
 * HOW THIS VENDOR'S PLACEMENTS ARE SPREAD ACROSS THE ESTATE — a shape, never a total.
 *
 * ⚠ THE ONE HONEST WAY TO SUMMARISE n PERCENTILES. Averaging them is the obvious alternative and it
 * is meaningless twice over: the percentiles come from DIFFERENT cohorts (a different band, often a
 * different n), and a mean of ranks is not the rank of anything. So the card counts how many
 * repositories fall below, at, and above the cohort median, and says that. "Above the median in
 * four of six repositories" is a sentence a reader can check against the table underneath it.
 *
 * ⚠ THE POPULATION IS NARROWER THAN THE CARD'S. Only repositories that were PLACED and whose
 * `acted_on_rate` COMPARED can hold a percentile at all, so `placed` is routinely smaller than
 * `liveInRepos` and the renderer must say which denominator it is quoting.
 */
export type BotBenchmarkRollupSpread =
  | {
      status: 'value';
      /** The subset with a comparable percentile. ⚠ `below + at + above === placed`, and a renderer
       *  that quotes `liveInRepos` here is quoting the wrong denominator. */
      placed: number;
      below: number;
      at: number;
      above: number;
    }
  | BotBenchmarkRollupRefusal;

/**
 * THE ESTATE-MATCHED EXPECTATION — what this vendor's engagement would be if every repository ran at
 * its OWN cohort's median, and what the difference is worth.
 *
 * ⚠ ONE FACTOR IS SWAPPED, NEVER TWO — `BotBenchmarkCostAtPeerEngagement`'s rule, one grain up. The
 * thread COUNTS and the PRICE stay the customer's; only the RATE comes from the cohort, and it comes
 * from each repository's OWN cell rather than from a single blended median. Multiplying a cohort
 * volume by a cohort rate and calling the product "what a peer pays" is a real statistical error
 * (the median of a product is not the product of the medians), invisible on screen and wrong in a
 * direction nobody could check.
 *
 * ⚠⚠ AND THE TWO HALVES OF THE COMPARISON SHARE ONE POPULATION, WHICH IS WHY BOTH ARE ON THE WIRE.
 * `expectedRate` can only be computed over the repositories whose cohort published a median — call
 * that the FITTED subset — so the customer's rate it is compared against must be computed over the
 * SAME subset. It is NOT the card's headline acted-on rate, which is pooled over every live
 * repository including the unfitted ones. They are different numbers, they routinely differ by
 * several points, and putting them in one row without their denominators is the defect
 * docs/PERIOD-REPORTING.md names "ONE ROW MUST NEVER MIX THE HEADLINE AND SUBSET POPULATIONS" —
 * shipped three times in that feature before it was believed. `fittedRepos` and `excludedRepos` ride
 * the wire so the renderer is physically able to label them apart, and so a test can assert that it
 * did.
 */
export type BotBenchmarkRollupExpectation =
  | {
      status: 'value';
      /** ⚠ THE CUSTOMER'S OWN RATE **OVER THE FITTED SUBSET ONLY** — the left-hand side of every
       *  comparison below, and NOT the same number as the card's pooled headline rate. Named
       *  `…OnFitted` rather than `yoursRate` because the shorter name is what invited the mixing. */
      yoursRateOnFitted: number;
      /** `Σ(settled × cohortMedian) ÷ Σ settled` over the fitted subset — the estate-weighted peer
       *  rate. ⚠ WEIGHTED BY THE CUSTOMER'S OWN THREAD COUNTS, so a busy repository's cohort counts
       *  for more than a quiet one's; an unweighted mean of medians would let a repository with four
       *  threads move the expectation as far as one with four hundred. */
      expectedRate: number;
      /** How many live repositories carried a fitted cohort median. The denominator of BOTH rates
       *  above. */
      fittedRepos: number;
      /** How many live repositories did NOT, and are therefore absent from both. ⚠ Published rather
       *  than left to a subtraction: `liveInRepos − fittedRepos` is the same arithmetic and gives a
       *  renderer nothing to display when it wants to say WHICH repositories are missing from the
       *  comparison. */
      excludedRepos: number;
      /** `Σ(settled × cohortMedian)` over the fitted subset — the counterfactual thread count.
       *  Fractional by construction. */
      actedAtPeer: number;
      /** That count as a monthly PACE — `Σ(settled × cohortMedian × 30.44 ÷ spanDays)`, summed per
       *  repository. ⚠ A SUM OF PER-REPOSITORY RATES, never a count over a union span. `null` when
       *  no fitted repository had an observable span, or when those that did work out to no pace at
       *  all — either way there is nothing here for a price to be divided by. */
      actedPerMonthAtPeer: number | null;
      /** `monthlyUsd ÷ actedPerMonthAtPeer` — what an acted-on thread would cost at peer
       *  engagement. `null` whenever the money could not be stated; `moneyRefusal` says why. */
      perActedOnUsd: number | null;
      /** `monthlyUsd × (expectedRate − yoursRateOnFitted)`: what closing the gap to the median would
       *  be worth, per month, at today's price. SIGNED — negative means this estate engages MORE
       *  than its cohorts' medians, a real and good state that must not be worded as waste.
       *  ⚠ A DIFFERENCE OF TWO SHARES, NEVER A RATIO, AND THAT IS WHAT BOUNDS IT: both factors are
       *  rates in [0,1], so this is bounded in `[−monthlyUsd, monthlyUsd]` structurally rather than
       *  by a clamp. The ratio form shipped once and rendered −4.1 × the spend AS MONEY.
       *  ⚠ AND IT IS NOT `cost.unacted.unactedUsd`. That is what the price currently buys and nobody
       *  acts on; this is what closing the gap is worth. They differ by a factor of the peer rate,
       *  and a sentence naming one while printing the other is why they are two fields. */
      conversionGapUsd: number | null;
      /** ⚠ WHY THE TWO MONEY FIGURES ABOVE ARE `null`, WHEN THEY ARE — never left to the reader to
       *  infer from a blank. The rates survive without a price (they are the customer's own
       *  measurements met with the corpus's), so this arm does not refuse wholesale for want of one;
       *  the money halves go quiet with a sentence instead, and the sentence is the SAME sentence
       *  `cost` is refusing with, so a truncated estate does not produce two accounts of one cause.
       *  ⚠ `null` HAS EXACTLY TWO READINGS AND THE CARD DISAMBIGUATES THEM: both figures are
       *  present, or the card carries NO `cost` block at all — nobody priced this reviewer, so
       *  there is no money anywhere on it and nothing to explain the absence of. */
      moneyRefusal: BotBenchmarkCostRefusal | null;
    }
  | BotBenchmarkRollupRefusal;

/**
 * WHAT THIS VENDOR COSTS PER UNIT OF WORK, AT THE GRAIN THE PRICE IS ACTUALLY BOUGHT AT.
 *
 * One subscription, one card, one figure. The per-repository block this folds
 * (`BotBenchmarkPlacementCost`) divided a Workspace price by ONE repository's work and had to
 * disclose that six other cards carried the same number; here the numerator and the denominator
 * describe the same population, so there is nothing to disclose and nothing to add up.
 *
 * ⚠ EVERY FIGURE IS A RATE AT TODAY'S PRICE, NEVER A HISTORY — the per-repository block's rule 5,
 * unchanged. We know one price (today's) and one throughput (recently observed), and neither
 * licenses a claim about what was spent in the past.
 *
 * ⚠ THE ARMS REUSE `BotBenchmarkCostUnacted`/`BotBenchmarkCostYours` DELIBERATELY, so one set of
 * components renders both grains — but two of their fields mean something wider here and the doc
 * comments below say which. Nothing else changes shape.
 */
export interface BotBenchmarkWorkspaceCost {
  /** The EFFECTIVE monthly price in THIS Workspace, US dollars, seat-multiplied already. ⚠ THREE
   *  VALUES, THREE MEANINGS, exactly as one grain down: `0` is a real stored price, `null` is a
   *  price somebody ENTERED that could not be stated (every priced row per-seat and every one
   *  dropped), and a vendor with NO price carries no cost block at all. */
  monthlyUsd: number | null;
  costModel: CostModel;
  unitMonthlyUsd: number | null;
  seats: number | null;
  pricedReviewers: number;
  seatPriceUnresolved: number;
  seatCountZero: number;
  /** The 14-day activity window, the basis of `perMergedPr` ALONE. */
  windowDays: number;
  /** `monthlyUsd × windowDays ÷ 30.44`. `null` exactly when `monthlyUsd` is. */
  windowUsd: number | null;
  /** How many repositories this vendor is live in — the estate every sum below runs over. ⚠ THE
   *  DENOMINATOR'S SIZE IS PART OF THE CLAIM: "$3.20 per acted-on thread" over one repository and
   *  over nine are different assertions and the card must be able to say which. */
  coveredRepos: number;
  /** ⚠ A DISCLOSURE ABOUT THE EVIDENCE TABLE, AND NO LONGER ABOUT THE MONEY. Live repositories
   *  where this reviewer's own earliest-to-latest comment stretch could not be read, so
   *  `contributions[].spanDays` is `null` for them. It USED to be load-bearing — that stretch was
   *  the per-month pace's divisor, and a repository without one contributed nothing to it — and it
   *  is not any more: the money divides by a chosen calendar month at both ends. Kept because the
   *  column it explains is still published; normally 0. */
  spanUnobservedRepos: number;
  /** ⚠ A SECOND DISCLOSURE WITH A DIFFERENT CAUSE: live repositories the host has held for less than
   *  the activity window, whose merge count is a partial-window UNDERCOUNT. They are excluded from
   *  `perMergedPr`'s denominator — leaving them in would inflate the estate's cost per merged pull
   *  request, silently and in the flattering direction for the finding. Their counters and threads
   *  still pool: only the merge-count sum is affected, because only it divides by a window. */
  partialWindowRepos: number;
  /** `windowUsd ÷ Σ mergedPrsLast14d` over the estate. ⚠ INDEPENDENT OF THE REVIEWER — it divides a
   *  price by the repositories' own merges and asks nothing of the bot, so it survives every metric
   *  being withheld, which is exactly when it is most worth reading. ⚠ A RATIO, NOT A WINDOWED
   *  TOTAL: dollars per merged pull request, which does not scale with the window, so a renderer
   *  must not suffix it "per 14 days" (that shipped, and reads as $/PR/fortnight). */
  perMergedPr: { status: 'value'; value: number; mergedPrs: number } | BotBenchmarkCostRefusal;
  /** ⚠ WHAT THE PRICE CURRENTLY BUYS AND NOBODY ACTS ON, PER MONTH, POOLED — AND OVER THE WHOLE
   *  READ SLICE, NOT OVER `costWindowDays`. `actedOnRate` here is `Σ acted ÷ Σ settled` over every
   *  thread the walk read in every live repository: the card's HEADLINE rate, and NOT the
   *  fitted-subset rate the expectation compares against, and NOT the windowed rate `yours` now
   *  carries. THREE populations, three fields, never one row — the renderer names each. It survives
   *  a rate of 0, which is the strongest finding this block can produce. */
  unacted: BotBenchmarkCostUnacted | BotBenchmarkCostRefusal;
  /**
   * The customer's own arithmetic OVER `costWindowDays` — one named calendar month at BOTH ends of
   * the fraction.
   *
   * ⚠ ITS POPULATION IS NARROWER THAN `unacted`'S AND THAT IS THE POINT. `actedThreads` /
   * `settledThreads` here count only the threads whose SETTLE POINT fell inside the window, so they
   * are a subset of the pooled pair above and the two rates routinely differ. Both are on the wire
   * so a renderer can label them apart and a test can assert that it did.
   *
   * ⚠ `actedPerMonth === actedThreads`, BY CONSTRUCTION AND NOT BY COINCIDENCE. The window IS a
   * month (`COST_WINDOW_DAYS === 30.44`), so a count inside it already is a monthly pace: there is
   * no annualising factor left to get wrong, and `perActedOnUsd` is exactly `monthlyUsd ÷
   * actedThreads` — a division a reader can check against the two numbers printed beside it.
   *
   * ⚠ WHAT THIS REPLACED: `Σ(acted × 30.44 ÷ spanDays)`, where `spanDays` was the reviewer's own
   * earliest-to-latest comment on the walked slice. That window was DATA-DERIVED (237 days on a
   * real card, on a repository the app had held for 52), an ORDER STATISTIC with no robustness
   * (one old comment on one long-lived pull request set the whole denominator) and NEVER RENDERED,
   * so the figure could not be recomputed from anything on screen.
   */
  yours: BotBenchmarkCostYours | BotBenchmarkCostRefusal;
  /** ⚠ THE BASIS, SERVED SO A RENDERER CANNOT DROP IT — one sentence naming the two numbers the
   *  per-thread figure divides and saying they cover the same month. It replaced a 106-word span
   *  caveat, every clause of which was about a time base that no longer exists. */
  basisNote: string;
  /**
   * ⚠ THE CHOSEN WINDOW, IN DAYS — `COST_WINDOW_DAYS`, one calendar month (30.44), the same length
   * `monthlyUsd` is quoted for. SERVED rather than assumed: a renderer that inlined "30" would
   * silently disagree with the server the day the constant moves, on a card whose whole claim is
   * that both halves of a fraction cover the same month.
   *
   * ⚠ NOT `windowDays` — that is the cohort's 14-day banding window and `perMergedPr`'s basis
   * ALONE. Two windows on one card, two fields, and neither may be read for the other's figure.
   *
   * Trailing and OPTIONAL: an older plugin sends no such key, and the panel must not print a
   * window it was not told.
   */
  costWindowDays?: number;
  /** ⚠ A THIRD DISCLOSURE, WITH THE THIRD CAUSE: live repositories the host has held for less than
   *  `costWindowDays`. Their month of work is a known UNDERCOUNT while the price is whole, so the
   *  per-acted-on figure would read too high — the same argument as `workspace_truncated`, one
   *  grain down, and it refuses `yours` rather than being disclosed and carried. Trailing and
   *  OPTIONAL. Normally 0. */
  costWindowIncompleteRepos?: number;
}

/**
 * ONE VENDOR, ONE CARD, THE WHOLE WORKSPACE.
 *
 * ⚠ THE KEY IS THE WORKSPACE'S VENDOR KEY, NOT `owner/name` AND NOT `vendor`. The per-repository
 * card's identity is its repository and its React key is `repoId:vendor`; a rollup card has n
 * repositories and would collide with itself on that. And it cannot key on `vendor` either, because
 * `vendor` is `null` for every brand the corpus has never seen — which is most of the reviewers a
 * real workspace runs — so n unbranded vendors would collapse onto one `null` card. `key` is what
 * the workspace's own automation table is keyed on, and an unbranded bot's price is exactly as real
 * as a branded one's.
 */
export interface BotBenchmarkWorkspaceRollup {
  /** The workspace's own automation key — the identity, and the React key. See the header. */
  key: string;
  /** The CORPUS vendor string, `null` when the corpus has never seen this brand. Fine for a label,
   *  never an identity. */
  vendor: string | null;
  /** The app's own `AutomatedReviewerKind`, so the SPA can label a bot the corpus cannot place. */
  botKind: string | null;
  /** ⚠ AN ARRAY: two logins the workspace classifies as one vendor are ONE card, and reporting only
   *  the first would be a false claim about which account produced the numbers. */
  reviewers: BotBenchmarkPlacementReviewer[];
  /** Repositories in this response where the vendor produced observable work. ⚠ THE POPULATION OF
   *  EVERY SUM ON THIS CARD, and the length of `contributions`. */
  liveInRepos: number;
  /** Repositories the request folded at all. `liveInRepos < reposConsidered` is the ordinary case —
   *  a reviewer runs on some of an estate — and the card says both so "live in 3 of 11" is a
   *  sentence rather than an inference. */
  reposConsidered: number;
  /** ⚠ PLAIN SUMS OVER THE LIVE REPOSITORIES, key by key, with an absent key contributing 0. THE
   *  ADDITIVITY INVARIANT: the whole equals the sum of the parts for EVERY key, which is what makes
   *  the evidence table checkable against the headline. Nothing here is a rate, so nothing here
   *  needs a denominator to be honest. */
  counters: BotBenchmarkPlacementCounters;
  /** The audit trail — one row per live repository, in the order the fold read them. */
  contributions: BotBenchmarkRollupContribution[];
  spread: BotBenchmarkRollupSpread;
  expectation: BotBenchmarkRollupExpectation;
  /** ⚠ ABSENT WHEN NO PRICE IS SET FOR THIS VENDOR IN THIS WORKSPACE — not empty, not zero. A
   *  "$0.00 per acted-on thread" is a claim about a reviewer nobody priced; absence is the truth. */
  cost?: BotBenchmarkWorkspaceCost;
}

export interface BotBenchmarkPlacementResponse {
  /** ⚠ ONE BANNER, NOT n IDENTICAL PARAGRAPHS. `false` covers the whole-artifact states: no corpus
   *  in this build, or a `fit_version` this build will not half-read. */
  available: boolean;
  reason?: BotBenchmarkUnavailableReason;
  message?: string;
  /** Echoed on every scoped response — unlike the cohort route, this one IS tenant data. */
  workspaceId: number;
  /** The artifact's whole identity, so a placement can be joined back to the cohort it used. */
  fitKey?: string;
  /** Recomputed per request against `corpus.observedAtMax` — the stored value decays on disk. */
  staleness?: { corpusAgeDays: number; state: BotBenchmarkStaleness };
  /** The parameters the fold ran on, read from the artifact and never inlined. */
  params?: { settleHours: number; overdueGraceHours: number[]; activityWindowDays: number };
  units?: BotBenchmarkPlacementUnit[];
  /**
   * ONE ENTRY PER VENDOR, FOLDED OVER THE WHOLE WORKSPACE — the estate-grain answer, and the only
   * place on this route money now travels.
   *
   * ⚠ ABSENT ON A `?repoIds=`-NARROWED REQUEST, STRUCTURALLY. A narrowed call is the per-repository
   * view, and the per-repository grain is exactly the one a Workspace price may not be stated at
   * (`BotBenchmarkPlacementCost`'s header has the argument). So the server does not build a rollup
   * for a narrowed request at all, rather than building one and trusting every present and future
   * renderer to decline to draw it. The guarantee is "there is no figure to find", not "please do
   * not look".
   *
   * ⚠ AND ABSENT IS NOT EMPTY. `[]` means the fold ran and no vendor was live anywhere in the
   * estate; the key being missing means the fold did not run.
   */
  rollup?: BotBenchmarkWorkspaceRollup[];
  /** ⚠ STRUCTURAL ABSENCE, PASSED THROUGH. `high_severity_share` / `nit_share` /
   *  `distinct_category_count` are model-derived and appear in NO cell while the corpus is
   *  unscored. It matters most HERE, because the host already HAS these numbers — ML severity is a
   *  shipped free feature — so the temptation is to render the customer's severity distribution
   *  against nothing, or against a placeholder. The key is not there to read. */
  absentMetrics?: BotBenchmarkAbsentMetric[];
  /** Prose caveats that are NOT refusals: the cohort's fixed historical fortnight versus the
   *  customer's trailing one, the public-repository corpus, the recency cap. */
  disclosures?: string[];
  /** ⚠ NEVER A SILENT TRUNCATION. `true` when the workspace held more (repository × reviewer)
   *  pairs than one request may fold; the omitted pairs are not "no data". */
  truncated?: boolean;
}

/** The per-request cap on REPOSITORIES folded. The response body is small; the WORK is a real fold
 *  over the tenant's pull requests, threads and comments, and the repository count is the cost
 *  driver (each one reads up to its own `walkBudget` pull requests and everything hanging off
 *  them). This bounds the work per request while the rate tier bounds the request count —
 *  complementary, neither a substitute.
 *
 *  ⚠ NEVER A SILENT TRUNCATION. Over the cap the response sets `truncated: true` and the caller
 *  narrows with `?repoIds=`; the omitted repositories are not "no data". */
export const BOT_BENCHMARK_MAX_PLACEMENT_REPOS = 12;
