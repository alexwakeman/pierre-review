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
  | 'github_advanced_security';

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
};

// Classify a login as a known AI review bot's vendor, or null. Normalises case + the
// `[bot]` suffix so it matches whether the login arrived via GraphQL (bare slug) or
// REST (`slug[bot]`).
export function reviewBotKind(login: string | null | undefined): ReviewBotKind | null {
  if (!login) return null;
  const slug = login.toLowerCase().replace(/\[bot\]$/, '');
  return REVIEW_BOTS[slug] ?? null;
}

// Bare GitHub login (lowercased, `[bot]` suffix stripped) → a QUALITY-CHECK automation:
// static analysis, coverage, lint. These post review comments like a review bot, so every
// layer of the classifier already flags them `automated` — but they are NOT reviewers, and
// counting them as such is what makes the Bot-ROI panel read as noise. See `ReviewerRole`.
//
// This map only SEEDS the default role for a login nobody has classified by hand. It is
// deliberately NOT a parallel `AutomatedReviewerKind`: role and vendor identity are
// orthogonal axes, and a login may hold a brand kind AND the quality_check role at once.
//
// Deliberately EXCLUDED even though they are arguably quality-check tools: `deepsource-io`,
// `github-code-quality`, `github-advanced-security` — all three are already named
// `ReviewBotKind` vendors with rows in existing dashboards, so seeding them quality_check
// would silently move numbers on upgrade. They stay `review` and remain user-flippable.
//
// The backend keeps a hand-synced LOCAL copy in `sync/bot-detection.ts` (it cannot import
// shared at runtime); `bot-detection.test.ts` fails on drift, exactly as for REVIEW_BOTS.
export const QUALITY_CHECK_BOTS: ReadonlySet<string> = new Set([
  // SonarQube Cloud (ex-SonarCloud) — current + legacy app slugs. Both are already in the
  // backend's KNOWN_BOTS but absent from REVIEW_BOTS, so today they resolve to `in_house`
  // via the githubType step: the exact miscount this role exists to fix.
  'sonarqubecloud',
  'sonarcloud',
  'codecov',
  'codeclimate',
  'codefactor-io',
  'houndci-bot',
  'coveralls',
  'codacy-bot',
]);

// True when a login is a known quality-check automation (see QUALITY_CHECK_BOTS). Normalises
// case + the `[bot]` suffix so it matches whether the login arrived via GraphQL or REST.
export function qualityCheckBot(login: string | null | undefined): boolean {
  if (!login) return false;
  return QUALITY_CHECK_BOTS.has(login.toLowerCase().replace(/\[bot\]$/, ''));
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
export type AutomatedReviewerKind = ReviewBotKind | 'in_house' | 'pierre' | 'vendor';
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
//   'quality_check' — static analysis / coverage / lint (SonarQube, Codecov, Hound). It posts
//                     review comments and IS automated, but it is not reviewing: counting it as
//                     a reviewer is what makes the ROI panel's volume and noise numbers lie.
//
// A quality_check reviewer stays `automated: true` — `excludeBots`, the feed bot lens and the
// per-row vendor tag all keep working unchanged. The role only splits the two DERIVED SETS:
//   role 'review'                    → SCORING (ROI, behaviour, dedup, benchmark)
//   all automated (review ∪ quality) → EXCLUSION, the feed, AND bot-only PRs
// Confusing those two is the defect this feature is most likely to ship; see the CLAUDE.md note.
//
// BOT-ONLY PRs DELIBERATELY DO NOT NARROW, and the reason is worth stating because the symmetry
// is tempting: that list answers "did a human look at this before it merged". A PR reviewed only
// by SonarQube has no human reviewer, so it is exactly what the banner exists to surface. Narrowing
// it to role 'review' would leave such a PR with zero qualifying bot reviews, fail the "at least
// one automated review" leg, and drop it from the list — hiding the risk instead of flagging it.
// The scoring sets narrow because a linter's volume makes a REVIEWER's numbers lie; the risk set
// does not, because a linter's approval is not a human's.
export type ReviewerRole = 'review' | 'quality_check';

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
  // null = NO PRICE SET. 0 is a real, deliberate price meaning "we pay nothing for this". TWO
  // STATES, and NOTHING INHERITS — so `??` vs `||` is an ordinary display bug here, not a silent
  // wrong-price trap.
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
export type BotWindowKind = 'rolling_7' | 'rolling_14' | 'rolling_30' | 'sprint';
export type BotVerdict = 'keep' | 'tune' | 'noisy';
export interface BotVendorTrendPoint { weekStart: string; threads: number; actedOnPct: number | null; untouched: number; }
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
  // ── ML severity mix (CORE, free — docs/ML-SEVERITY.md), WINDOWED like every other column ──
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
  // Cost is CORE/free: it is read from a core table, so an OSS/npx install can set and see it.
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

// ── Bot THEMES (Pro, AI) — GET/POST /api/pro/bot-themes ─────────────────────────────────────
// An AI (Haiku) QUALITATIVE summary layer over the Bots console — the one bot surface that reads
// what the automated reviewers actually SAY (every other bot surface is deterministic volume /
// timing / area). It funnels the in-window, WORKSPACE-SCOPED bot review + PR comments (dedup + strip),
// then a single Haiku pass extracts the recurring THEMES (nature + criticality + where) plus a
// short narrative. The deterministic aggregates (per-bot volume, area distribution, acted-on %)
// are computed in-plugin from the raw rows; the themes + narrative are the model's read
// (approximate — the UI says so). STRICTLY Pro (rides the activityDigest AI-summary tier); cached +
// credit-metered like the preset prompts. Scoped to the current Workspace (`?workspace=<id>`),
// windowed like ROI.
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
  enabled: boolean;             // the Pro AI-summary tier is on (else the tab shouldn't render)
  result: BotThemesResult | null; // the last generated report for this (scope, window); null = none yet
  throttled?: boolean;          // a generation was already in flight
  creditsExhausted?: boolean;   // out of the monthly AI-credit allowance
  empty?: boolean;              // no bot comments in scope/window → nothing to summarize
}

// ── Human "Discussion" THEMES (Pro, AI) — GET/POST /api/pro/human-themes ─────────────────────
// The HUMAN sibling of the Bot "Themes" summary: the same themed AI read, but over PEOPLE'S review
// comments (non-bot authors, INCLUDING human replies inside bot threads) rather than the bots'. It
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

// ── Bot BEHAVIOUR analytics (EXPERIMENTAL) — GET /api/bot-behaviour ────────────────────────
// A SEPARATE, deterministic (no-AI) CORE surface from the Bot-ROI panel, developed in its own
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
export interface SprintChatBody {
  question: string;
  // Which WORKSPACE to ground the answer in — the wire value is the workspace id (the same plain
  // integer `?workspace=` carries, as a string on this body). Absent = the account's Default.
  // The sentinel vocabulary it used to accept ('all' | 'none' | 'teams' | '<teamId>') is gone with
  // the scope union; the plugin parses this with parseWorkspaceId and persists `ws:<id>` as the
  // cache `scope_key`, whose prefix is what stops a legacy '3' aliasing workspace 3.
  scope?: string;
  wantChart?: boolean;
  wantBots?: boolean;
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
  model?: string;
  generatedAt?: string; // ISO-8601
  throttled?: boolean;
  creditsExhausted?: boolean;
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
}

export interface SyncStatus {
  repoId: number;
  status: SyncRunStatus;
  progress: SyncProgress | null;
  lastFullSyncAt: string | null;
  lastIncrementalSyncAt: string | null;
  lastSyncError: string | null;
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

// The rendered form of a verdict: one label, one tone, one sentence of WHY, and whether a
// merge button should be live. `detail` is user-facing prose ("2 approvals required", "3
// commits behind main"), null when there's nothing more to say than the label.
export interface MergeVerdictInfo {
  verdict: MergeVerdict;
  label: string;
  tone: 'ok' | 'warn' | 'bad' | 'muted';
  canMerge: boolean;
  detail: string | null;
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

export interface ArmedMergeRequest {
  prId: number;
  mergeMethod: MergeMethod;
  // Whether to bring the branch up to date first when it's merely behind, and how.
  // 'none' = never update; a behind PR just waits (or expires).
  updateStrategy: 'rebase' | 'merge' | 'none';
  armedAt: string; // ISO-8601
  // The head SHA at arming time. The watcher refuses to merge a different head — arming is
  // consent to merge THIS code, not whatever lands next.
  expectedHeadOid: string;
  state: ArmedMergeState;
  lastCheckedAt: string | null; // ISO-8601; null until the watcher has looked once
  // Machine-ish reason for the current state ('required reviews missing', 'head moved
  // abc1234→def5678', 'github: base branch modified'). Null while cleanly armed.
  lastReason: string | null;
  expiresAt: string; // ISO-8601 — the hard stop, so an intent can't linger for weeks
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
// straight out of a GitHub payload and stored in `reviewRequests.teamName`. It is one `sed` away
// from `WorkspaceComparisonRow.workspaceName`, which is the OPPOSITE category and WAS renamed;
// renaming this one breaks GitHub-team review-request rendering. Do not touch it.
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

export interface MyTurnCounts {
  awaitingReview: number;
  yourPrsActivity: number;
  // Your authored, still-open PRs that have a standing approval (ready to merge).
  approvedPrs: number;
  threadsAwaiting: number;
  // New open PRs by others in your repos (opened at or after the repo was added — see
  // `Repo.createdAt`), not yet dismissed. 0 when the account has no repos.
  watchedRepoPrs: number;
  // Completed Claude reviews not yet actioned (no comments/review posted). Always 0
  // when Claude Review is disabled (cloud / flag off).
  claudeReviewsToAction: number;
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
  // PRO_DIGEST_ENABLED. Config (provider + base URL) lives in pro_settings.
  issueLinks: boolean;
  // Review-bot triage tier — CORE/FREE. The Bots rail view reads the core bot routes and shows
  // regardless; this flag is true whenever the plugin is LOADED (independent of the paid PRO_*
  // flags) so the free bot Settings section + the ROI cost overlay (both pro_settings-backed)
  // stay reachable. All-false only when the plugin is absent.
  botTriage: boolean;
  // Bot Tuning Advisor (paid, gated like workspaceInsights): the Bots "Advisor" inner tab,
  // the per-row Tune/Drop pills, findings → config-PR/brief/issue outputs, the effect panel.
  // The free amber TuningSuggestions box renders regardless of this flag.
  botAdvisor: boolean;
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

export interface MeResponse {
  user: LocalUser | null;
  counts: MyTurnCounts;
  // Server-side Activity-Feed "seen" marker: when the account last viewed the feed
  // (ISO, null until the first view), and how many "My Turn" feed items are new
  // since then. Drives the Welcome-back banner (server-truth, consistent across devices).
  feedLastSeenAt: string | null;
  newFeedItems: number;
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
export type AiUpdateMode = 'manual' | 'interval' | 'on_change';
export type IssueProvider = 'jira' | 'linear';

// Read shape (GET /api/pro/settings). The Slack webhook URL is WRITE-ONLY — never returned;
// `slack.configured` reflects only whether one is stored.
// How the Insights flow-metrics + sprint report frame their comparison window:
//  - 'rolling_7' / 'rolling_14': the trailing N days vs the immediately-preceding N days. No sprint
//    needed; always a full window (no "day-1 cliff"), good for teams that don't run sprints.
//  - 'sprint': like-for-like by SPRINT POSITION — this sprint SO FAR vs the SAME elapsed slice of
//    the previous sprint. Requires a configured sprint (start + cadence); with none it falls back
//    to 'rolling_14'.
export type SprintComparisonMode = 'rolling_7' | 'rolling_14' | 'sprint';

export interface ProSettings {
  // Sprint that defines the Insights metrics window. cadenceDays = sprint length; the current
  // sprint auto-rolls (start + N whole cadence-lengths up to today). Open PRs always count.
  // `comparisonMode` picks the window model (default 'rolling_14'); 'sprint' uses cadence+start.
  sprint: {
    cadenceDays: number | null;
    startDate: string | null; // ISO (date @ midnight); null = no sprint configured
    comparisonMode: SprintComparisonMode;
  };
  slack: {
    configured: boolean;
    cadence: SlackDigestCadence;
    hour1: number; // 0-23, local to `timezone`
    hour2: number; // second daily send, used only for 'twice_daily'
    timezone: string | null; // IANA tz; null = server tz
  };
  aiUpdate: { mode: AiUpdateMode; intervalMinutes: number };
  // provider/baseUrl configure the deep-link target; projectKeys is an optional allowlist of
  // project prefixes (e.g. ['ENG','PROJ']) — when non-empty, ONLY keys with a listed prefix are
  // detected (near-zero false positives). Empty → heuristic detection.
  issue: { provider: IssueProvider | null; baseUrl: string | null; projectKeys: string[] };
  // Bot-Triage Platform (WS8 control surface). Toggles + scalars for detection, Pierre
  // tagging, Slack bot digest, standing auto-resolve, and per-vendor cost.
  bots: {
    inhouseDetect: boolean;
    autoTagHighConfidence: boolean;
    loginAllowlist: string[];
    deepDetect: boolean;        // WS1f app-attribution REST enrich
    aiTiebreak: boolean;        // WS1.6 Haiku medium-band tie-break
    tagPierreReviews: boolean;  // WS2a/b
    pierreFooter: boolean;      // WS2c visible footer
    slackDigest: boolean;       // WS5
    autoResolve: boolean;       // WS6b master enable
    autoResolveDays: number;
    /**
     * @deprecated LEGACY, READ-ONLY. Per-bot monthly cost stored in the plugin-owned
     * `pro_settings.bot_cost_json` blob, superseded by `account_reviewers.monthly_cents` in CORE
     * (one row per (account, actor), nullable — NULL is "no price set", 0 is "free" — edited on
     * the bot row in Activity → Bots → Settings). Cost became CORE/free in the move: an OSS/npx
     * install can now set and see a price.
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
  // Pass startDate:null + cadenceDays:null to CLEAR the sprint (disable sprints entirely → the
  // metrics fall back to a rolling window). comparisonMode switches the window model.
  sprint?: {
    cadenceDays?: number | null;
    startDate?: string | null;
    comparisonMode?: SprintComparisonMode;
  };
  slack?: {
    webhookUrl?: string;
    cadence?: SlackDigestCadence;
    hour1?: number;
    hour2?: number;
    timezone?: string | null;
  };
  aiUpdate?: { mode?: AiUpdateMode; intervalMinutes?: number };
  // projectKeys: an allowlist of project prefixes; [] / null clears it (→ heuristic detection).
  issue?: { provider?: IssueProvider | null; baseUrl?: string | null; projectKeys?: string[] | null };
  // Bot-Triage settings patch (WS8). Only present fields change.
  //
  // `cost` was REMOVED here on purpose: per-bot cost is now written through
  // `PUT /api/bot-reviewers/:userId/cost` (`ReviewerCostBody`) into core `account_reviewers`.
  // Two live writers to one price is how the two silently disagree, so this one was
  // retired rather than mirrored.
  // The read (`ProSettings.bots.cost`) survives as a deprecated legacy fallback — see there.
  //
  // Failure mode for a stale client that still sends `bots.cost`: the PUT body schema has
  // `additionalProperties: false`, so the key is SILENTLY STRIPPED rather than 400'd. That is the
  // right outcome (nothing changes, the request still succeeds) but it is silent, so it is
  // written down here.
  bots?: {
    inhouseDetect?: boolean; autoTagHighConfidence?: boolean; loginAllowlist?: string[];
    deepDetect?: boolean; aiTiebreak?: boolean; tagPierreReviews?: boolean; pierreFooter?: boolean;
    slackDigest?: boolean; autoResolve?: boolean; autoResolveDays?: number;
  };
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
  // Whether a user-supplied Anthropic API key is stored locally (local mode
  // only). When true, that key overrides the ambient Claude auth at run time.
  hasUserKey: boolean;
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

// Set (non-empty) or clear (empty) the locally-stored Anthropic API key.
export interface SetClaudeKeyBody {
  key: string;
}

export interface ClaudeKeyResponse {
  hasUserKey: boolean;
  auth: ClaudeAuthStatus;
}

// GET /api/claude-review/key — a non-PR-scoped read of whether a local Anthropic key is
// stored (for the Settings modal, which manages the key outside any PR).
export interface ClaudeKeyStatusResponse {
  hasUserKey: boolean;
}

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

// What seeded the fix prompt: the stored CI analysis, the latest Claude review, or a
// plain request (summary/description only).
export type AiFixSeed = 'ci_analysis' | 'review' | 'plain';

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
}

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
  // 'review_comment' | 'pr_comment' | 'commit_pushed'), or 'claude_review' for a
  // Claude Review run surfaced in the stream.
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
  | 'stalled_review' // an open PR awaiting review too long
  | 'untouched_thread' // a review thread nobody has responded to
  | 'reviewer_load' // a reviewer's pending-queue depth (+ sprint load)
  | 'reviewer_routing' // a PR with no reviewer + who should review it
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

export interface StalledReviewCard extends InsightCardBase, InsightPrRef {
  kind: 'stalled_review';
  ageHours: number; // hours the PR has been open awaiting review
  requestedReviewerIds: number[]; // reviewers still on the hook (GitHub-pending)
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

export type InsightCard =
  | StalledReviewCard
  | UntouchedThreadCard
  | ReviewerLoadCard
  | ReviewerRoutingCard
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
}

// The attention cards (stalled reviews / untouched threads / reviewer load / needs-a-reviewer),
// served CORE/free by GET /api/attention for the Feed "Needs attention" tab — the same cards the
// (Pro) Insights pane computes in core getWorkspaceInsights, minus the bot-signal cards (those live
// in the free Bots console). No AI, no capability gate.
export interface AttentionCardsResponse {
  cards: InsightCard[];
  users: User[];
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
export type WorkspaceMetricKey =
  | 'open_prs' // ALL currently-open PRs across the repos, oldest first
  | 'merges' // deploy frequency → all merged PRs (per repo)
  | 'lead_time' // open → merge, merged + open, longest first
  | 'review_latency' // open → first review, longest first
  | 'merge_ci' // merged PRs by CI-at-merge (failures first)
  | 'ci_recovery' // red → green recovery, slowest first
  | 'ci_red'; // currently CI-failing open branches

export const WORKSPACE_METRIC_KEYS: WorkspaceMetricKey[] = [
  'open_prs',
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
  openPrs: MetricPr[]; // ALL currently-open non-draft PRs, longest-open first
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

// The workspace flow-metric header (DORA-ish tiles + trend charts) as a standalone CORE/free
// payload, served by /api/workspace-metrics — moved out of the Pro Insights bundle into the Feed.
export interface WorkspaceMetricsResponse {
  metrics: WorkspaceMetrics | null; // null = the workspace has no repos
}

// ---- Cross-workspace comparison (the "Compare workspaces" rail line) ----
// One row per WORKSPACE: that workspace's full flow metrics (the same WorkspaceMetrics shape the
// DORA header uses), so the SPA can render a compact metric×workspace comparison matrix with
// per-workspace throughput sparklines. `metrics` null when the workspace has no repos/data.
//
// ⚠ IT COVERS EVERY WORKSPACE, ALWAYS — Default included — and takes NO scope parameter. The
// selection cannot narrow a comparison whose entire purpose is to place the selected workspace
// against the others; its predecessor was scoped, which is what made it disappear the moment fewer
// than two teams were selected. The surface is simply hidden when the account owns fewer than two
// workspaces (`workspaces.length >= 2`), a count over the roster — never a test on a scope value.
//
// ⚠ COST IS NOT TOTALLED HERE, and no other cross-workspace surface may total it either: prices are
// per workspace (see WorkspaceReviewer.costMonthlyUsd), so six workspaces each listing a $120
// CodeRabbit is either six subscriptions or one seen six ways, and this screen must not assert
// which. Show the figures side by side.
//
// WINDOW: core cannot read the plugin-owned `pro_settings`, so this uses the same trailing-14d
// default `/api/workspace-metrics` does — NOT the account's configured sprint window. That makes
// Compare agree with the free header elsewhere in the app, at the cost of possibly differing from a
// Pro user's custom-window Insights header. Deliberate, and a visible change for those users.
export interface WorkspaceComparisonRow {
  workspaceId: number;
  // The workspace's display name. NOTE, because the two are one `sed` apart and are opposites:
  // this is OUR name for a grouping of repos, whereas `RequestedReviewer.teamName` and
  // `ReviewerSuggestion.teamName`/`teamSlug` are GITHUB's own teams (`@org/team`) and must never
  // be renamed — they parse GitHub payloads and address GitHub's review-request API.
  workspaceName: string;
  isDefault: boolean;
  repoCount: number;
  metrics: WorkspaceMetrics | null;
}

export interface WorkspaceComparisonResponse {
  // Always true from the core route — kept on the wire (rather than removed) because the client
  // never read it and dropping a field buys nothing, while a future gate might want it back.
  enabled: boolean;
  generatedAt: string; // ISO-8601
  sprint: { from: string; to: string };
  workspaces: WorkspaceComparisonRow[]; // one per workspace, in listWorkspaces order (name asc)
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

// One commit on a repo's default branch. `authorLogin` is the GitHub login when we could
// resolve one (a synced `users` row or the GraphQL author); `authorName` is the raw git
// author name, which is all a commit made by a non-GitHub identity carries. Both nullable
// and independently useful — prefer the login, fall back to the name.
export interface BranchCommit {
  sha: string;
  messageHeadline: string;
  authorLogin: string | null;
  authorName: string | null;
  authorAvatarUrl: string | null;
  committedAt: string; // ISO-8601
  ciStatus: CiStatus;
  // The checks that were FAILING on this commit — NEVER the passing ones. So this is empty for
  // every green commit (the DB stores null there, and the read layer resolves null → []), which
  // is what keeps a healthy repo's rows exactly as small as they are today. A per-commit
  // expander is shown iff this is non-empty — the caret is driven by the DATA, not by the dot's
  // colour, so a caret can never open onto an empty drawer.
  //
  // Empty on a RED commit is a real, expected state: a row written before the failing-checks
  // migration (until that repo's next branch sync), or a repo whose check `contexts` the token
  // can't read. The dot still shows the rollup; there is simply no detail to expand.
  failingChecks: BranchCheckRun[];
  // The PR this commit landed from (GitHub's `associatedPullRequests` for the commit), or null
  // for a direct push to trunk — which is a legitimate, common state, not a sync gap. A commit
  // can be reachable from several PRs (a cherry-pick, a revert-then-reland, a branch merged into
  // another open PR); the sync stores exactly ONE, picked deterministically so a re-sync can
  // never flip the displayed number.
  prNumber: number | null;
  // The LOCAL `pullRequests.id` for `prNumber`, resolved per request within (accountId, repoId)
  // — a PR number is unique only WITHIN a repo, so it is never resolved by number alone.
  //
  // Null while `prNumber` is set means "that PR isn't synced for this account": squash-merged
  // longer ago than the backfill window, or in a repo added after the fact. This PAIR is the
  // client's whole decision:
  //   prId != null                   → open the PR's own detail tab in-app
  //   prNumber != null && prId null  → link out to github.com (better than dropping the ref)
  //   both null                      → no PR chip at all
  prId: number | null;
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
  // Most-recent-first, capped server-side. Empty until the first branch sync.
  commits: BranchCommit[];
}

// GET /api/branch-status?repoIds= — one entry per repo in scope (repos with no synced branch
// data still appear, with nulls, so the strip's row count matches the repo list).
export interface BranchStatusResponse {
  repos: RepoBranchStatus[];
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
