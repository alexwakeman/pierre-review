import { create } from 'zustand';
import { usePinnedTabs, type TabMeta } from './pinnedTabs.js';
// TYPE-ONLY, and from the pure drill-down layer that also renders it (`botNarrowLabel` /
// `selectorLabel`): the seed and the label must describe the same shape, and a second inline
// spelling here is how the chip and the page come to disagree about a narrowing.
import type { BotFlaggingBotNarrowing } from '../lib/severityAgreement.js';
import {
  EVENT_CATEGORY_BY_TYPE,
  PR_STATUSES,
  REVIEW_FILTER_STATES,
  type BotFlaggingSelector,
  type BotTheme,
  type BotWindowKind,
  type DerivedState,
  type EventCategory,
  type EventType,
  type InsightKind,
  type MlSeverity,
  type PrStatus,
  type ReviewBotKind,
  type ReviewState,
  type VendorDisagreeDirection,
  type WorkspaceMetricKey,
  type SprintChatResponse,
} from '@pierre-review/shared';

// Feed bot lens (the Activity "Feed" bot-vs-human view): show everything, hide bot noise,
// or bot activity only. Transient, URL-silent — like feedMyTurnOnly.
export type FeedBotLens = 'all' | 'hide' | 'only';

// The Activity "Feed" CI-failure lens. THREE states, cycled by one pill:
//   'feed' (DEFAULT) — CI rows are interleaved into the stream by time, alongside human activity
//   'only'           — the stream is narrowed to CI rows
//   'off'            — no CI rows are fetched at all
//
// The default is 'feed', i.e. ON. It shipped OFF, and the reason it changed is worth keeping:
// an include-only toggle produces NO VISIBLE CHANGE in a busy workspace. CI rows are placed
// chronologically, so in a high-traffic workspace (bevy/three.js: ~23 non-CI events in the 11.5h
// since the newest CI failure) the first CI card lands ~23 rows down while the pill's count
// cheerfully reads 34 — indistinguishable from a broken toggle. In a quiet workspace the same
// code puts it at index 0 and looks perfect. 'only' is what makes the pill's effect legible
// regardless of traffic.
export type FeedCiLens = 'feed' | 'only' | 'off';

// The Activity repo-console sub-tab strip (Activity | Bots). Store-remembered (see
// repoConsoleTabs) so returning to a rail entry restores its last-active sub-tab.
//
// `InsightsSubTab` ('overview' | 'sprint' | 'reports') is GONE, with its whole apparatus
// (`insightsSubTab`, `setInsightsSubTab`, InsightsView's tablist + normalization): the pane is
// Reports-FIRST now (plan C5) — PeriodReportsPanel is its only body and the ad-hoc chat lives
// inside the report as "Ask about this period". Safe to delete outright because the field was
// transient (freshDefaults only, never persisted, never URL-emitted — `?report=` reads into
// `insightsReportKey` alone), so no stored blob or link can carry a stale value anywhere.
export type RepoConsoleTab = 'activity' | 'bots';
// PrDetail's inner tab strip. It lives HERE, not in PrDetail's local state, because it is
// URL-ADDRESSABLE: `?view=pr:<id>&prTab=changes` names one screen, so browser Back/Forward can
// move between "the PR's diff" and "the PR's threads" like every other view. Which member is
// VISIBLE is still derived per PR (bot_activity / claude_review / ai_fix are capability- or
// data-gated) — the store holds the CHOICE, never a computed effective tab.
export type PrDetailTab =
  | 'overview'
  | 'threads'
  | 'activity'
  | 'changes'
  | 'bot_activity'
  | 'claude_review'
  | 'ai_fix';
export const PR_DETAIL_TABS: readonly PrDetailTab[] = [
  'overview',
  'threads',
  'activity',
  'changes',
  'bot_activity',
  'claude_review',
  'ai_fix',
];
// The all-open-PRs drill-down's scope: one repo | 'feed' (every repo in the active Workspace —
// the Flow metrics "Open PRs" tile) | a named repo GROUP (label + the exact repo set behind it —
// see openPrsScope).
export type OpenPrsScope = number | 'feed' | { label: string; repoIds: number[] };
// One picked subject of the People report (see peopleReportSeed): a human or a bot, with the
// label metadata the report tab needs captured at open time — `userId` is the `users.id` slot
// every per-section query keys on; `label` is the display name (humans) / classification label
// (bots) AT OPEN TIME, which is also the tab's alphabetical section order key.
export interface PeopleReportSelection {
  kind: 'human' | 'bot';
  userId: number;
  login: string | null;
  label: string;
  avatarUrl: string | null;
}

/**
 * The cache/result key for a workspace-scoped client-side memo — `ws:<id>`.
 *
 * It deliberately shares its vocabulary with the plugin's `scopeKeyFor` (packages/pro
 * `insights/workspace-scope.ts`), which is what the server persists in `scope_key`. The prefix is
 * load-bearing: a bare `String(workspaceId)` would alias a legacy team scope string ('3') onto
 * workspace 3, whose repo set is different, and the stale answer would be served under the new
 * name. Use this everywhere a workspace has to key a Record — never hand-roll the template.
 */
export function workspaceScopeKey(workspaceId: number): string {
  return `ws:${workspaceId}`;
}

// One completed turn of the LIVE ad-hoc chat conversation: what was asked + the wire response
// VERBATIM (answer, prRefs, chart, window, model, followUps, trimmedTurns). The response is kept
// whole rather than projected so the transcript renders each answer exactly as the single-answer
// panel did — per-turn window caption included — and a wire field added later flows through
// without a store change.
export interface SprintChatTurn {
  question: string;
  response: SprintChatResponse;
}

export type RangePreset = '7d' | '14d' | '30d' | '90d' | 'custom';

// The user-facing event-CATEGORY toggles (Events panel). Two categories are NOT
// here, by design:
//  • 'lifecycle' (PR opened/merged/closed/…) — its events draw no markers (they're
//    implicit in each PR bar), so the toggle was a no-op.
//  • 'reviews' (review_submitted) — replaced by the finer per-verdict toggles
//    (ALL_REVIEW_STATES: approved / changes_requested / commented / dismissed),
//    filtered server-side via the `reviewStates` param.
// Both still FLOW — categoriesToTypes always includes their event types — so
// contributor rows / activity-feed jumps are unaffected; the review verdict filter
// then narrows the review markers. Re-add either here to restore a coarse toggle.
export const ALL_CATEGORIES: EventCategory[] = [
  'review_comments',
  'pr_comments',
  'commits',
];

// Categories shown on a fresh load. Commits are noisy, so they start hidden —
// the user can toggle them on, and that choice round-trips through the URL (see
// useUrlState). This is the baseline the URL serializer diffs against.
export const DEFAULT_CATEGORIES: EventCategory[] = ALL_CATEGORIES.filter(
  (c) => c !== 'commits',
);

export const ALL_PR_STATUSES: PrStatus[] = PR_STATUSES;

// The review verdicts shown in the Events panel (approved / changes_requested /
// commented / dismissed). All four are shown on a fresh load — a review-verdict
// filter is opt-in, so the default selects everything and the URL stays clean.
export const ALL_REVIEW_STATES: ReviewState[] = REVIEW_FILTER_STATES;
export const DEFAULT_REVIEW_STATES: ReviewState[] = [...ALL_REVIEW_STATES];

// PR statuses shown on a fresh load. Closed PRs are noise for most situational-
// awareness views, so they start hidden; the choice round-trips through the URL.
export const DEFAULT_PR_STATUSES: PrStatus[] = ALL_PR_STATUSES.filter(
  (s) => s !== 'closed',
);

const DAY_MS = 24 * 60 * 60 * 1000;
// The backfill horizon — the furthest back the timeline holds any data, and the cap
// on the My Turn Focus Mode range extension (see myTurnFromMs / resolveRange).
export const MAX_RANGE_DAYS = 90;
const PRESET_DAYS: Record<Exclude<RangePreset, 'custom'>, number> = {
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '90d': 90,
};

// ── The shared sync round ────────────────────────────────────────────────────────────────────
//
// One user-visible "sync round" (the GitHub walk + the ML scoring pass that follows it) shared
// between the header sync button and the WorkspaceManager's embedded progress panel. SyncStatus
// (always mounted) is the single DRIVER: it owns the status/ml polls, the completion effects and
// every invalidation, and it is the only writer of this state. Everything else consumes the
// state and calls the actions SyncStatus registers below.
export interface SyncRoundState {
  // The round's progress UI is live — it lingers on the final "done" state for a beat after
  // both halves settle (the driver's auto-close clears it). WHERE it renders is a separate
  // routing decision: managerOpen → the manager's embedded panel; otherwise the standalone
  // SyncProgressModal, and only when `modal` is set.
  open: boolean;
  // May the STANDALONE overlay render this round (while the manager is closed)? True only for
  // rounds opened via requestSyncModal with no manager mounted (the FirstRunOnboarding add
  // path). Header-initiated rounds keep it false — the header never opens a dialog; the icon
  // spin is the whole surface until the manager is opened.
  modal: boolean;
  // The GitHub walk is still in flight (drives the 1.5s status poll + the header spin's first
  // half). The ML pass can outlast it — "round done" is the driver's auto-close, not this flag.
  syncing: boolean;
  // A user-initiated Cancel is in flight.
  cancelling: boolean;
  // Which repos the round tracks. EMPTY = "all repos" (the manual-sync sentinel, same
  // semantics the modal-scope set always had); adds merge their repo id in.
  scopeIds: number[];
}

// ── The **Pending** board's RELEVANCE lens ─────────────────────────────────────────────────────
//
// Which half of the `my_turn` population the board is showing, or null for all of it:
//
//   'mine'   — `MyTurnCard.relevance` is 'direct' OR 'maintained' (== the retired `personal`
//              flag): work tied to you by authorship, a request, a reply, a mention — plus new
//              PRs in repos you maintain.
//   'others' — `relevance === 'none'`: the review-or-reply backlog nobody named you for.
//
// ⚠ THE TWO VALUES PARTITION `my_turn`, so the daily brief's two lines are MUTUALLY EXCLUSIVE
// and each opens a board filtered to ITS OWN number. That is the entire reason this is not a
// boolean: "personal only" and "not personal only" are not expressible as one flag plus its
// negation while `null` (show everything) also has to be a state.
export type AttentionRelevanceLens = 'mine' | 'others';

// ── The Feed's "new since you looked away" cohorts ────────────────────────────────────────────
//
// The cross-repo Activity Feed INSERTS newly-arrived items as they arrive (there is no
// "New activity — Refresh" button any more: content is never withheld behind a click) and marks
// the inserted cards "New". This slice is that marker's whole memory.
//
// ⚠ IT LIVES IN THE STORE, NOT IN FeedView, BECAUSE THE ACTIVITY CONSOLE UNMOUNTS ON EVERY TAB
// SWITCH (see ACTIVITY_GC_TIME in useActivity.ts) while its query data survives 45 minutes. Held
// in component state, every markers-clearing Timeline round-trip would silently repaint the same
// cards as un-new — the reader would open a PR from the feed, come back, and be told nothing
// arrived while they were away.
//
// It is TRANSIENT: freshDefaults() only, NOT in FilterDefaults / freshFilterDefaults /
// pickFilterBarState / sanitizePersistedFilters, and never URL-serialized (the attentionIsolation
// precedent above). "New to you" is a fact about THIS session's reading, so it must not be
// restorable from a stale blob — and consequently no FILTER_STORAGE_VERSION bump is owed for it.
export interface FeedNewCohorts {
  // The feed scope (`ws:<id>` + the feed's own query string) these cohorts were collected under.
  // A scope change discards them wholesale: an item id from another workspace's — or another
  // lens' — stream says nothing about what is new in this one.
  scopeKey: string | null;
  // One entry per auto-inserted BATCH, oldest first.
  //
  // ⚠ `seen` IS A COHORT-LEVEL FACT, NOT A PER-CARD ONE. There is deliberately no per-card
  // visibility observer (the SPA's only IntersectionObservers are bottom-of-list auto-load
  // sentinels, and a feed of markdown-heavy cards is the last place to add one per row): being
  // at — or near — the TOP of the feed is what counts as having seen what is at the top of it.
  cohorts: { ids: string[]; seen: boolean }[];
}

// How many unseen cohorts to remember. A reader who never returns to the top of the feed would
// otherwise accumulate one entry per poll for as long as the tab lives; past this many batches
// "what's new" has stopped being a useful answer anyway, so the oldest fall off.
const FEED_NEW_COHORT_LIMIT = 8;

/** The actions SyncStatus registers so other surfaces (the manager) can drive the round. */
export interface SyncRoundActions {
  /** Cancel the in-scope running syncs (the backend deletes never-synced repos). */
  cancel: () => void;
  /** Shallow sync of ALL repos (the header button's click). No dialog is opened. */
  syncAllShallow: () => void;
  /** Deep (full-backfill) re-sync of ALL repos. Caller is responsible for the confirm gate. */
  syncAllDeep: () => void;
  /**
   * Deep re-sync ONE repo. Resolves 'started' when the POST was accepted (the round then
   * tracks it), 'cooldown' on the per-repo 429 (recently synced — nothing was started),
   * 'error' on any other failure.
   */
  syncOneDeep: (repoId: number) => Promise<'started' | 'cooldown' | 'error'>;
  /** Hide the round's progress UI, leaving both halves running server-side. */
  dismiss: () => void;
}

// Module-level registry (NOT store state: these are per-render closures, and putting them in
// the store would churn every subscriber on each SyncStatus render). SyncStatus re-registers
// after every render so the closures always see fresh data, and unregisters on unmount.
let syncRoundActions: SyncRoundActions | null = null;
export function registerSyncRoundActions(actions: SyncRoundActions | null): void {
  syncRoundActions = actions;
}
/** Null while SyncStatus is unmounted — callers must no-op, never queue. */
export function getSyncRoundActions(): SyncRoundActions | null {
  return syncRoundActions;
}

export interface FilterState {
  // Which of the ACTIVE WORKSPACE's repos are visible. null = every repo in the active workspace
  // (NOT every repo in the account — the workspace already bounds the set). An explicit array is
  // the per-repo show/hide narrowing (RepoSelectPanel) and is sent on the wire even when EMPTY:
  // an empty workspace is a real narrowing, and dropping the param is what made the server fall
  // back to the whole account.
  repoIds: number[] | null;
  // THE ACTIVE WORKSPACE — the single scope selector. A plain id; there is no union, no sentinel
  // and no wire-string form (that whole vocabulary — 'all' / 'none' / 'teams' / 'teams:1,2' —
  // is gone with TeamScope, and so are the five canonicalisation helpers that existed to keep it
  // honest).
  //
  // `null` = NOT RESOLVED YET. Nothing may render workspace-scoped data while it is null: the
  // account's Default id varies per account, so there is no static default to assume. The
  // workspace-sync effect (WorkspaceSelector) fills it from listWorkspaces()' default the moment
  // that query lands, and corrects a stored id that names no live workspace.
  //
  // Persisted in its OWN slice (pickScopeState / a separate storage key) and URL-mirrored as
  // `?workspace=<id>`. It is deliberately NOT in FilterDefaults: persistence and "Clear filters"
  // share that list, so a persisted workspaceId would also be RESET by clearing a date range —
  // silently teleporting the user into Default. See resetAllFilters.
  workspaceId: number | null;
  userIds: number[] | null;
  excludeBots: boolean;
  // Bots to KEEP visible even when excludeBots is on — the per-repo "important bots"
  // allow-list (checked in the Members dropdown's Bots sections). A persisted filter:
  // round-trips through the URL (allowBots=…) and saved views, and only bites when
  // excludeBots is true. Empty → exclude every bot (the historical behaviour).
  allowedBotIds: number[];
  // Hide "stale" open PRs: open PRs with no commits/comments/reviews inside the
  // active range. A server-side timeline filter (drops the PRs and their events).
  excludeStale: boolean;
  preset: RangePreset;
  customFrom: string | null; // ISO date (yyyy-mm-dd)
  customTo: string | null;
  categories: EventCategory[];
  prStatuses: PrStatus[]; // which PR statuses are shown (empty = none)
  // Which review verdicts show as markers (review_submitted events). All four by
  // default; an empty set hides every review marker. Only affects review markers.
  reviewStates: ReviewState[];
  derivedStates: DerivedState[]; // empty = no derived-state filtering
  // Activity "Feed" scope toggle: when true, the consolidated Feed shows only "My Turn"
  // actionables. A TRANSIENT flag owned by the Activity lane (not a persisted filter, not
  // URL-synced) — present in freshDefaults() but NOT in FilterDefaults /
  // pickFilterBarState / sanitizePersistedFilters, so a fresh load starts false.
  feedMyTurnOnly: boolean;
  // Activity "Feed" scope toggle: when true, the consolidated Feed shows only Claude
  // Review items. Transient (like feedMyTurnOnly) — owned by the Activity lane, not a
  // persisted filter, not URL-synced. Mutually exclusive with feedMyTurnOnly.
  feedClaudeOnly: boolean;
  // Activity "Feed" bot lens (Pierre as the layer above your review bot): 'hide' (default —
  // drop bot-authored rows, the anti-fatigue view), 'all', or 'only' (bot activity only).
  // 'hide' is SERVER-side (useConsolidatedFeed sends excludeBots=true, so bots are excluded
  // BEFORE the page cap and a bot-heavy window fills with human rows); 'only' stays a
  // client-side view over the loaded page. ORTHOGONAL to feedMyTurnOnly/feedClaudeOnly (they
  // compose). Transient, URL-silent — the hidden default reasserts every session, deliberately.
  feedBotLens: FeedBotLens;
  // Activity "Feed" event-CATEGORY pills — narrow the stream to comment activity and/or PR
  // events. Both false (default) = no category filter (everything shows). When either is true,
  // the feed shows only items in the enabled categories: 'comments' = review/PR comments,
  // 'pr_events' = opens/merges/closes/reopens/ready + reviews. Client-side, composes with the
  // bot lens, ORTHOGONAL to feedMyTurnOnly/feedClaudeOnly. Transient, URL-silent (like feedBotLens).
  feedCatComments: boolean;
  feedCatPrEvents: boolean;
  // Activity "Feed" "Needs review" pill — narrow the stream to pr_opened/pr_ready_for_review
  // cards whose PR is STILL awaiting a first review (the server-computed prAwaitingReview
  // flag, a live snapshot). Client-side, composes like the category pills. Transient,
  // URL-silent (like feedCatPrEvents).
  feedNeedsReview: boolean;
  // Activity "Feed" opt-in "show individual commits" toggle. false (default) → only commit
  // pushes that ADDRESSED a review thread surface (the existing behaviour); true → the server
  // also emits plain commit-push runs. Server-side (the client can't synthesize plain commits),
  // so it's threaded into the feed query key. Transient, URL-silent (like the other feed toggles).
  feedShowCommits: boolean;
  // Activity "Feed" CI-failure lens (see FeedCiLens). 'off' (DEFAULT) fetches none; 'feed'
  // interleaves ONE item per failed check run — on PR heads AND on the default branch
  // (`ci_failed` / `trunk_ci_failed`); 'only' narrows the stream to them. The fetch half is
  // server-side (the client cannot synthesize these rows), so it is threaded into the feed query
  // key AND the head-poll key; the 'only' half is a client-side narrowing, like the category
  // pills. The pill cycles off → feed → only → off, so one click from rest turns the feature on.
  //
  // ⚠ IT DEFAULTS OFF ON PURPOSE, and that is the SECOND flip of this default. It first shipped
  // as an include-only boolean defaulting off (invisible), was flipped on to make the feature
  // discoverable, and is now off again because "on" is too noisy to be a good first impression:
  // a red matrix build writes a card per failed check per head, and on a busy workspace that is
  // most of what a new user's first feed contains. Discoverability is now the PILL's job — it
  // renders whenever the Feed does, so the feature is one visible click away rather than
  // ambient. The two lessons from the first flip still stand: never ship an include-only toggle
  // whose only feedback is a count, and never re-derive this default from a stored value.
  //
  // ⚠ Unlike the other feed toggles this one is PERSISTED, with the filter bar (it is in
  // FilterDefaults / freshFilterDefaults / pickFilterBarState). "Show me broken builds" is a
  // standing preference, not a per-session lens — a user who narrows to CI should find that
  // tomorrow. It is consequently also reset by "Clear filters", which is the correct reading of
  // that control for a filter-shaped setting.
  //
  // ⚠ AND IT IS URL-SERIALIZED (`ci=only` / `ci=1`; the 'off' default is omitted), which is not
  // optional for a FilterDefaults key. useUrlState's serializer is hand-written per param, so a
  // new key is silently omitted unless someone adds it — and being omitted does NOT merely make
  // it unshareable: `writeToUrl` emits `?workspace=<id>` as soon as the scope resolves, so the
  // address bar is non-bare within a second of every load, and the localStorage restore path
  // runs ONLY on a bare URL. A URL-silent FilterDefaults key therefore round-trips into storage
  // and is read back never.
  feedCiLens: FeedCiLens;
  // Activity "Feed" single-PR isolation: null (default) → every PR in scope; a pr id →
  // the consolidated Feed shows ONLY that PR's items. Driven by the Feed "open PRs" panel.
  // Transient (never persisted); cleared on rail / scope changes.
  //
  // ⚠ URL-SERIALIZED (`?feedPr=<id>`) and a NAVIGATION key, for the same reason as
  // `attentionIsolation`: it is a whole screen the user navigated TO, so Back must be able to
  // leave it. URL-visible ≠ persisted — a fresh tab still opens the un-isolated feed.
  feedIsolatedPrId: number | null;
  // Activity **Pending** single-KIND isolation: null (default) → every attention card in
  // scope; an InsightKind → the board shows ONLY that kind. Set by the daily brief's lines, each
  // of which is ABOUT one kind ("3 PRs stalled awaiting review" → the stalled cards), so the
  // number the user clicked and the list they land on are the same population. Cleared on rail /
  // scope changes.
  //
  // ⚠ It is NOT in FilterDefaults / freshFilterDefaults / pickFilterBarState — a lens set by one
  // click of a brief line is not a standing preference, so it must not persist or need a
  // FILTER_STORAGE_VERSION bump. It lives in freshDefaults() only.
  //
  // ⚠ IT IS, HOWEVER, URL-SERIALIZED (`?attn=<kind>`) and it is a NAVIGATION key: clicking a
  // brief line is the one gesture that takes a reader from "the board" to "this narrowed board",
  // and before it was addressable the browser's Back left the app entirely (the reader's actual
  // complaint). URL-visible and PERSISTED are different questions — a link may name the narrowed
  // board; a fresh tab must not restore it from a stale blob. See hooks/useUrlState.
  attentionIsolation: InsightKind | null;
  // Activity **Pending** RELEVANCE lens: null (default) → the board paints every card;
  // 'mine' → only `my_turn` cards whose `relevance` is direct-or-maintained; 'others' → only the
  // ones whose `relevance` is 'none'.
  //
  // ⚠ THREE-VALUED, NOT A BOOLEAN, AND THAT IS THE PRODUCT DECISION. It shipped as
  // `attentionPersonalOnly: boolean`, which could express "what involves me" but had no way to
  // say "the rest" — so the daily brief's two my-turn lines could not both land on a board
  // filtered to THEIR OWN number. Two mutually exclusive lines need two seatable lenses plus the
  // un-lensed board; a boolean gives you two states for three views. (The CARD LABELS are a
  // separate three-way split, off `MyTurnCard.relevance` — see AttentionCards.cardKindLabel.)
  //
  // ⚠ IT IS A SIBLING OF `attentionIsolation`, NOT A MEMBER OF IT. That field is compared
  // against `card.kind`, so a relevance member would be a kind that matches no card — and the
  // two predicates are orthogonal anyway (you can want a relevance-lensed board of every kind).
  //
  // ⚠ IT EXISTS TO KEEP A NOTIFICATION AND ITS DESTINATION THE SAME POPULATION. The welcome-back
  // banner, the Workspace-dropdown badges and the "Elsewhere" lines count the PERSONAL subset
  // (`DailyBriefCounts.myTurnPersonal` = direct + maintained) — otherwise they nag you about a
  // stranger's PR in a repo you have never touched. A banner reading 4 whose click opened a board
  // of 50 would be the "the strip says 5, the board lists 3" defect in a new place, so the ONE
  // gesture that opens the board from those counts (`openMyTurnInWorkspace`) seats `'mine'` as
  // its last step — and the brief's "M need review or reply" line seats `'others'` for exactly
  // the same reason, in the opposite direction.
  //
  // Transient, exactly like `attentionIsolation`: NOT in FilterDefaults / freshFilterDefaults /
  // pickFilterBarState (so no FILTER_STORAGE_VERSION bump is owed), cleared by any rail or scope
  // change — but URL-SERIALIZED (`?attnRel=mine|others`) and a NAVIGATION key, because it changes
  // what the board shows and a reader must be able to Back out of it. The retired
  // `?attnPersonal=1` is still PARSED as 'mine' (shipped links and history entries), never
  // emitted — see hooks/useUrlState.
  attentionRelevance: AttentionRelevanceLens | null;
  // The cross-repo Feed's "New" markers — see FeedNewCohorts above. Transient, URL-silent,
  // and written ONLY by FeedView's auto-insert path (a batch landed) and its scroll handler
  // (the reader is at the top). Read as a flat id set; never recomputed defensively on render.
  feedNewCohorts: FeedNewCohorts;
  // The rolling window the Bot-ROI panel (Insights) reports over. Transient, URL-silent
  // (like feedBotLens) — owned by the Bot-ROI panel; drives the useBotAnalytics query key.
  botAnalyticsWindow: BotWindowKind;
  // Which inner sub-tab the Bots view shows: 'roi' (the Measure surface — ROI panel + bot feed),
  // 'advisor' (the Pro Bot Tuning Advisor — findings → config-PR/brief/issue outputs), or
  // 'settings' (the "who counts as a review bot in this workspace" classification tab).
  // ('behaviour' was REMOVED in plan P1.1/C1 and 'themes' in plan P2.3/C6 — per-bot depth is the
  // bot-detail drill-down tab, the workspace charts a collapsed section under ROI, and the bot
  // themes summary folded into the synthesis seam's "What they're flagging" card on Measure. The
  // field is transient and URL-silent, so dropping a member is safe: no persisted blob can hold
  // it.) A single scalar (both the cross-repo rail Bots view and the per-repo console Bots tab
  // share one BotsView) — so 'settings' can be selected while a PER-REPO Bots tab is showing,
  // where it is the same list narrowed to one repo's footprint rather than a different judgement
  // (the bot object is keyed per WORKSPACE now, and a repo belongs to exactly one). BotsView's
  // effectiveTab fallback still owns any degradation ('advisor' is capability-gated — the
  // derived-effective-tab rule). Transient, URL-silent.
  //
  // ⚠ URL-SERIALIZED (`?botsTab=advisor|settings`, the 'roi' default omitted) and a NAVIGATION
  // key, but ONLY alongside `activityRepo=bots` — the cross-repo Bots rail, where the strip is on
  // screen. The per-repo console's Bots tab shares this scalar and does NOT emit it; a sub-tab
  // that is not visible is not a view. Still transient: URL-visible ≠ persisted.
  botsInnerTab: 'roi' | 'advisor' | 'settings';
  // The Advisor tab's one-shot focus, set by the Tune/Drop pills on the Bots table: which
  // bot the advisor should open on, and with what intent ('tune' = its tuning findings,
  // 'drop' = the drop-shaped evidence: overlap + suppressions + cost). The PANEL treats it
  // as its selected-bot filter (overwritten by clicking pills or the panel's own picker);
  // it is never written back as a "correction". Transient, URL-silent.
  advisorFocus: { botKey: string; intent: 'tune' | 'drop' } | null;
  // (There is no `botSettingsTeamId` / per-repo judgement picker. The judgement is keyed by the
  // active WORKSPACE, so the panel just reads `workspaceId` like every other Bots panel.)
  //
  // Which inner sub-tab the cross-repo Feed rail shows: 'feed' (the metrics header + consolidated
  // feed) or 'themes' (the Pro "Discussion themes" AI summary). Transient, URL-silent.
  //
  // 'compare' is NOT a member: cross-workspace comparison is the Reports "By workspace" axis
  // (inside PeriodReportsPanel), no longer a surface of its own anywhere.
  //
  // Landmine (still live for 'themes'): it is capability-gated, so this scalar can hold a key
  // whose tab isn't currently rendered. The consumer must DERIVE an effective tab from the
  // visible tab list rather than writing a correction back into the store — a write permanently
  // forgets the user's choice, so losing the capability for a moment would silently forget
  // Themes instead of restoring it when the capability returns. Being transient (freshDefaults
  // only, never persisted, never URL-parsed) a stale value cannot outlive the session, which is
  // why removing 'compare' from the union needs no migration.
  //
  // ⚠ URL-SERIALIZED (`?feedTab=themes`, the 'feed' default omitted) and a NAVIGATION key, but
  // ONLY alongside the cross-repo Feed rail entry, where the strip is on screen. The READ seats
  // this RAW value; the derived-effective-tab rule above is unchanged — a URL naming 'themes' on
  // an account without the capability must not be written back as a correction.
  feedInnerTab: 'feed' | 'themes';
  // Which inner tab the PR-detail overlay shows (see PrDetailTab), PAIRED WITH THE PR IT BELONGS
  // TO. null = nothing chosen yet → 'overview'.
  //
  // ⚠ THE PAIR IS THE POINT. This is a GLOBAL field read by a component mounted per PR, i.e. the
  // `threadStateFilter` trap: a bare scalar would carry the tab you left PR #1 on into PR #2, so
  // "open a PR from the feed" could land on someone else's diff. PrDetail reads it only when
  // `prDetailTab.prId === prId`, and `writeToUrl` emits `?prTab=` only when the pair names the
  // ACTIVE pr-detail tab. Transient (freshDefaults only — never persisted), URL-serialized.
  prDetailTab: { prId: number; tab: PrDetailTab } | null;
  // The ad-hoc "Ask about the sprint" chat's LIVE state, lifted here so it survives the Insights
  // panel unmounting (e.g. clicking a PR then returning) — the mutation result lives in
  // component state and would otherwise be lost. `draft` = the in-progress question + toggles.
  // `threads` = the live CONVERSATION per workspace — completed turns oldest→newest, keyed by
  // `workspaceScopeKey(workspaceId)` (`ws:<id>`) so each workspace keeps its own transcript and
  // switching to one you haven't asked in shows nothing (never the previous workspace's output).
  // The key MUST come from that helper, not from a plausible-looking `String(workspaceId)`: it
  // is the same vocabulary the server persists in `scope_key`, and the `ws:` prefix is what
  // stops a legacy '3' aliasing workspace 3. Depth is capped at SPRINT_CHAT_MAX_TURNS by the
  // panel (the server independently re-caps the prior pairs it reads). Transient, URL-silent;
  // NOT the persisted history — every turn was stored server-side as its own history row at
  // answer time, so clearing a thread destroys no record.
  sprintChatDraft: { question: string; wantChart: boolean; wantBots: boolean };
  sprintChatThreads: Record<string, SprintChatTurn[]>;

  // selection
  selectedPrId: number | null;
  selectedThreadId: number | null;
  // The Insights → Reports period the reader is looking at, as a `periodKey`
  // ('sprint-2026-08-18'). It lives in the store rather than in the panel because it is
  // URL-MIRRORED (`?report=`), and a forwardable link per period is the whole point of the
  // period report — an artifact you cannot send to someone is not an artifact. Selection
  // state, so it is NOT in FilterDefaults and "Clear filters" leaves it alone.
  // null = show the newest completed period.
  insightsReportKey: string | null;
  // PR-detail Threads-tab bot filter: when set, the Threads tab shows ONLY that review
  // vendor's threads (set by clicking a "CodeRabbit · 12 · 3 unresolved" chip in Overview).
  // null = no filter. Transient; cleared when the PR changes / selection clears.
  threadBotFilter: ReviewBotKind | null;
  // PR-detail Threads-tab derived-STATE filter pills (Untouched/Replied/Likely-addressed/
  // Resolved), matching the feed's state pills. Empty = all shown. Preset to
  // {likely_addressed} when arriving from the resolvable-bot-threads tab. Transient; cleared
  // when the PR changes / selection clears.
  threadStateFilter: Set<DerivedState>;
  // PR-detail Threads-tab ML-SEVERITY filter pills (Critical/Major/Minor/Nit). Empty = all
  // shown. A thread matches when ANY of its non-summary bot comments carries a selected
  // severity, so the pills read as "show me threads containing a major finding", not "threads
  // whose worst is exactly major". Transient and cleared alongside threadStateFilter — it is
  // the same GLOBAL-field trap: PrDetail must only apply it when selectedPrId === prId, or a
  // PR opened via a pinned tab inherits a preset from another PR and silently hides threads.
  threadSeverityFilter: Set<MlSeverity>;
  // A specific issue-level PR comment selected from the timeline popover's "Open in
  // detail pane". Drives a PERMANENT amber highlight on that comment card (mirroring
  // selectedThreadId's thread highlight); cleared when another thread/comment/PR is
  // selected. Distinct from the transient `commentFocus` signal, which only scrolls
  // + flashes the card once.
  selectedCommentId: number | null;

  // transient: a timeline → PR-detail deep link that opens the Activity tab and
  // scrolls to a specific entry (e.g. the commit popover's "View in Activity").
  // Matched against the loaded PR by `prId`; cleared by PrDetail after it scrolls.
  activityFocus: { prId: number; type: EventType; refId: number | null } | null;

  // transient: a timeline → PR-detail deep link that opens the Overview tab and
  // scrolls to + flashes a specific issue-level PR comment (the pr_comment
  // marker's "Open in detail pane"). Matched against the loaded PR by `prId`;
  // cleared by PrCommentsList once it scrolls.
  commentFocus: { prId: number; commentId: number } | null;

  // transient: the Claude-review progress banner → open a PR's Claude Review tab.
  // Matched against the loaded PR by `prId`; cleared by PrDetail once it switches.
  claudeTabFocus: { prId: number } | null;

  // transient: "Generate fix from this review" → open the PR's AI Fix tab, seeded
  // with the review text. Matched by `prId`; cleared by PrDetail once it switches.
  aiFixTabFocus: { prId: number; reviewText?: string } | null;

  // transient: a clicked flow-metric tile → which metric the drill-down tab should show.
  // Seeds/re-jumps the MetricsDetail sub-tab (the tab itself is a singleton). null = none.
  metricsFocus: WorkspaceMetricKey | null;

  // transient: a clicked Bot-ROI vendor row → which analytics-row KEY (`u<userId>` | 'pierre')
  // the bot-PR drill-down tab should show. Seeds/re-jumps the BotPrsDetail sub-tab (the tab
  // itself is a singleton). null = none.
  botPrsFocusKey: string | null;
  // transient: the repo the bot-PR drill-down was opened FROM (the per-repo Bots tab), so the
  // drill-down stays scoped to that repo. null = the whole active workspace (the cross-repo
  // Bots rail).
  botPrsFocusRepoId: number | null;

  // transient: the scope the all-open-PRs drill-down tab lists — a repoId (that repo's open
  // PRs), 'feed' (every repo in the active workspace — the Flow metrics "Open PRs" tile), or a
  // named GROUP (label + the exact repo set behind a FeedOpenPrsPanel group — a repoId list, so
  // the footer's promised count ≡ the tab).
  // Read (not consumed) for the tab's lifetime, like botPrsFocusRepoId. null = never opened.
  openPrsScope: OpenPrsScope | null;

  // transient: the repo the bot-only-PRs drill-down was opened FROM (the per-repo Bots tab).
  // null = the whole active workspace (the cross-repo Bots rail). Read-not-consumed, like above.
  botOnlyFocusRepoId: number | null;
  // transient: the repo the resolvable-bot-threads tab was opened FROM. null = the whole active
  // workspace. Read-not-consumed, like the above.
  botThreadsFocusRepoId: number | null;
  // transient: the theme whose review threads / PR comments the theme-threads drill-down renders
  // (carries the theme's resolved `threads` + `prs`) + which summary it came from (for labels).
  // Read-not-consumed, like the above.
  themeThreadsSeed: { theme: BotTheme; source: 'bot' | 'human' } | null;
  // transient: the query string the cross-repo search-results tab renders. Read-not-consumed
  // (survives the tab's lifetime), like the drill-down seeds above. null = never opened.
  searchSeed: string | null;
  // transient: which tile/chip of the Bots rail's ML totals strip the flagging drill-down renders,
  // plus the repo it was opened FROM (null = the whole active workspace, i.e. the cross-repo Bots
  // rail). Read-not-consumed for the tab's lifetime and overwritten by the next open — the
  // themeThreadsSeed discipline, because the tab is a singleton RE-SEEDED IN PLACE.
  // ⚠ NOT in FilterDefaults, NOT URL-serialized, NOT persisted: it carries a selector union, and a
  // stale one restored from storage would render a tile the strip may no longer show.
  // The two OPENING refinements ride the seed rather than the tab's local state, for the same
  // reason the selector does: the chip's label is derived from the seed, so a bot narrowing the
  // chip cannot see would leave two opens for two different bots reading identically.
  //   • `bots` — narrow to a SET of automated reviewers (`users.id`s + the name to call them by).
  //     A SET, not one id, because the inflation card's "View all N →" sums over the BEHAVIOUR
  //     panel's bots (role `'review'`) while the drill-down resolves role `'all'` — both
  //     deliberate — so only carrying the exact ids makes the number and the list agree.
  //   • `disagree` — the direction an inflation bar was clicked in. RE-APPLIED, not cleared, by
  //     BotFlaggingDetail's reset effect: it is what the tab was opened AS, so a window change
  //     must not silently widen "CodeRabbit called it worse" to "every finding". Null for every
  //     tile-opened drill-down, which is why that behaviour is unchanged there.
  botFlaggingSeed: {
    selector: BotFlaggingSelector;
    repoId: number | null;
    bots: BotFlaggingBotNarrowing | null;
    disagree: VendorDisagreeDirection | null;
  } | null;
  // transient: which bot's "bot comments per PR" cell the volume drill-down was opened on, plus
  // the repo the COLUMN was measured at (null = the whole active workspace, i.e. the cross-repo
  // Bots rail). Read-not-consumed for the tab's lifetime and overwritten by the next open — the
  // botFlaggingSeed discipline, because this tab is a singleton RE-SEEDED IN PLACE too.
  // ⚠ NOT in FilterDefaults, NOT URL-serialized, NOT persisted: a stale narrowing restored from
  // storage would name a bot the current workspace may not even have.
  //
  // `bots` reuses `BotFlaggingBotNarrowing` deliberately — ONE bot-narrowing shape on this
  // surface, not two, so the chip label (`botNarrowLabel`) and the wire spelling (`users.id`s,
  // never vendor key strings) are shared with the flagging drill-down. It rides the SEED rather
  // than the tab's local state because the CHIP names it: two opens for two different bots would
  // otherwise render identical chips. null = every bot in scope (the column's totals reading).
  botVolumeSeed: {
    repoId: number | null;
    bots: BotFlaggingBotNarrowing | null;
  } | null;
  // transient: what the people-report tab renders — the period + the picked people/bots
  // (label metadata captured at Begin time, so a section headers itself without a roster
  // lookup). themeThreadsSeed discipline verbatim: the tab is a SINGLETON RE-SEEDED IN PLACE
  // by the next Begin; read-not-consumed for the tab's lifetime.
  // ⚠ NOT in FilterDefaults, NOT URL-serialized, NOT persisted: a restored selection could
  // name users this workspace no longer has, and the periodKey could be off the current
  // cadence grid — the tab dies on reload by design.
  // ⚠ `workspaceId` IS PART OF THE SEED. Period keys are cadence-grid strings, so a workspace
  // sharing the grid still resolves the key — and the open report would then render the OLD
  // workspace's selections against the NEW workspace's data under the same heading, with humans
  // degrading to "no activity from them in this Workspace" and a bot silently showing different
  // numbers. Pinning it lets the detail route that mismatch to its existing empty state.
  peopleReportSeed: {
    workspaceId: number;
    periodKey: string;
    selections: PeopleReportSelection[];
  } | null;

  // Activity tab (the master-detail triage console). Which detail is shown:
  // 'feed' = the cross-repo consolidated Feed (the default landing detail), a number =
  // that single repo's console, null = nothing selected yet (treated as 'feed'). Client-
  // side narrow, no refetch. (The old 'all' briefing-feed pseudo-row was removed — it was
  // redundant with the Feed + per-repo entries.) Transient (mirrors myTurnOnly/
  // insightsOpen): in freshDefaults() but NOT in pickFilterBarState /
  // sanitizePersistedFilters. `?activityRepo=<id>` / `bots` / `attention` are the
  // URL mirrors (see useUrlState); the active TAB lives in the pinnedTabs store. 'bots' = the
  // CORE/free review-bot triage console (BotsView); 'insights' is the Pro Insights rail entry.
  // (The 'retro' rail value was REMOVED with the Retro panel — it was already unreachable:
  // nothing called setActivityRepo('retro') and useUrlState never parsed it. 'compare' was
  // REMOVED with the "Compare workspaces" rail entry — cross-workspace comparison is Reports'
  // "By workspace" axis now. This field is transient and 'compare' is no longer URL-parsed, so a
  // stale value cannot enter the store; a legacy `?activityRepo=compare` link falls through the
  // read side's parseInt branch and lands on the 'feed' default — normalization by construction.)
  activityRepoId: number | 'feed' | 'attention' | 'insights' | 'bots' | null;
  // Soft thread-state filter inside an Activity repo console: clicking a thread-state
  // segment narrows the PRs-by-author list to PRs carrying that derived state.
  // null = no filter. Transient, URL-silent.
  activityThreadFilter: DerivedState | null;
  // Per-repo memory of the repo console's Activity|Bots sub-tab, so returning to a rail
  // repo (or Back from a pr-detail tab / a Timeline round-trip — all of which unmount
  // ActivityView) restores the last-active sub-tab. Transient like activityThreadFilter
  // (freshDefaults() only — not persisted, not URL-synced); deliberately NOT cleared by
  // setActivityRepo — surviving rail switches is the point.
  repoConsoleTabs: Record<number, RepoConsoleTab>;

  // file groups + diff hunks (PR detail thread view)
  expandedFileGroups: string[]; // paths explicitly toggled by the user
  collapsedFileGroups: string[]; // paths explicitly collapsed by the user
  expandedDiffHunks: number[]; // thread ids with the full hunk shown

  // transient: request the timeline to scroll/focus a PR (cleared after use)
  timelineFocusPr: number | null;
  // optional instant to recenter on (e.g. a clicked event's time) so focusing a
  // long-running PR doesn't jump to its far-off midpoint
  timelineFocusAt: string | null;
  // optional specific event marker to glow once the timeline recenters, resolved
  // against the loaded timeline events by (type, refId). null = recenter only.
  timelineFocusEvent: { type: EventType; refId: number | null } | null;
  // transient: request the timeline to recenter its window on a given instant
  // (epoch ms) keeping the current zoom width — drives the "Now" button. Store-
  // only (NOT URL-synced); cleared after the Timeline consumes it.
  timelineCenterAt: number | null;

  // `rangeResetSignal`: a monotonic counter bumped on every range-preset click
  // (even re-selecting the already-active preset). The Timeline watches it to
  // re-apply the preset's window — so clicking "14d" again snaps the view back to
  // the last 14 days after you've panned/zoomed away. A counter (not derived from
  // `preset`) so a same-value re-click still fires.
  rangeResetSignal: number;
  // `syncModalSignal`: a monotonic counter bumped when a freshly-added repo should
  // surface the sync-progress modal (so the user sees the initial backfill is
  // underway and may take a while). SyncStatus watches it, opens the modal and
  // starts polling. Store-only / transient (NOT URL-synced).
  syncModalSignal: number;
  // The repo ids queued by `requestSyncModal` since the driver last drained them, so
  // the add-flow modal can scope itself to ONLY those repos (a concurrent scheduled
  // sync of the OTHER repos would otherwise bounce their progress bars). A LIST, not
  // a single slot: a multi-add (FirstRunOnboarding) calls requestSyncModal N times in
  // one synchronous batch, so the driver's effect runs ONCE and must see every id,
  // not just the last writer's. SyncStatus drains (reads then clears) it. Read
  // alongside syncModalSignal.
  syncModalRepoIds: number[];
  // THE SHARED SYNC ROUND — lifted out of SyncStatus's local state so the header button and
  // the WorkspaceManager's embedded progress panel describe the SAME round. SyncStatus stays
  // the single DRIVER (it owns every poll, effect and invalidation and is always mounted);
  // everything else reads this slice and calls the registered sync-round actions
  // (getSyncRoundActions). Transient: not persisted, not URL-synced, not in FilterDefaults.
  syncRound: SyncRoundState;
  // Whether the WorkspaceManager modal is currently mounted. Routing for the progress UI
  // hangs off it: while true an active round renders as the manager's embedded panel and the
  // standalone SyncProgressModal must NOT open. Mirrored by the manager itself
  // (mount/unmount), so it is correct regardless of which host opened it. Transient.
  managerOpen: boolean;
  // `claudeReviewKickoff`: a monotonic counter bumped when the user starts a Claude
  // review, so the global progress banner knows a run is in flight and begins
  // polling (and stops once the active list drains). Store-only / transient.
  claudeReviewKickoff: number;

  setRepoIds: (ids: number[] | null) => void;
  // Switch the active WORKSPACE and set the resolved repo visibility together. The caller
  // resolves `repoIds` from the workspaces data (workspaceRepoIds(workspaceId, workspaces));
  // pass null for "every repo in the workspace".
  //
  // ⚠ This is the REPLACE path — it is for switching workspace (and for the sync effect
  // adopting a Default / correcting an id that names no live workspace). A PRUNE (dropping ids
  // that left the workspace while leaving a user-narrowed subset alone) must go through
  // setRepoIds, or the per-repo show/hide would be reverted by the next background refetch.
  setWorkspace: (workspaceId: number, repoIds: number[] | null) => void;
  toggleRepo: (id: number) => void;
  // Make a repo visible WITHOUT clearing an active filter: a no-op when all repos
  // are already shown (repoIds == null) or the id is already in the visible set,
  // otherwise it appends. Used by the add-repo flow so a freshly-added repo isn't
  // hidden when a repo filter is active (the repos-list refetch reconciles).
  showRepo: (id: number) => void;
  setUserIds: (ids: number[] | null) => void;
  setExcludeBots: (v: boolean) => void;
  // Set/toggle the per-repo "allowed bots" list (bots kept visible under excludeBots).
  setAllowedBotIds: (ids: number[]) => void;
  toggleAllowedBot: (id: number) => void;
  setExcludeStale: (v: boolean) => void;
  setPreset: (p: RangePreset) => void;
  setCustomRange: (from: string | null, to: string | null) => void;
  toggleCategory: (c: EventCategory) => void;
  setCategories: (c: EventCategory[]) => void;
  togglePrStatus: (s: PrStatus) => void;
  setPrStatuses: (s: PrStatus[]) => void;
  toggleReviewState: (s: ReviewState) => void;
  setReviewStates: (s: ReviewState[]) => void;
  toggleDerivedState: (s: DerivedState) => void;
  setDerivedStates: (s: DerivedState[]) => void;
  // Toggle / set the Activity "Feed" My-Turn-only scope (see feedMyTurnOnly). Toggling
  // it on clears feedClaudeOnly (the two pills are mutually exclusive).
  toggleFeedMyTurnOnly: () => void;
  setFeedMyTurnOnly: (v: boolean) => void;
  // Toggle / set the Activity "Feed" Claude-Reviews-only scope (see feedClaudeOnly).
  // Toggling it on clears feedMyTurnOnly.
  toggleFeedClaudeOnly: () => void;
  setFeedClaudeOnly: (v: boolean) => void;
  // Feed bot lens: cycle all → hide → only → all, or set directly.
  cycleFeedBotLens: () => void;
  setFeedBotLens: (v: FeedBotLens) => void;
  // Feed event-category pills (see feedCatComments/feedCatPrEvents) — independent toggles.
  toggleFeedCatComments: () => void;
  toggleFeedCatPrEvents: () => void;
  // Feed "Needs review" pill (see feedNeedsReview) — independent toggle.
  toggleFeedNeedsReview: () => void;
  // Feed "show individual commits" toggle (see feedShowCommits).
  toggleFeedShowCommits: () => void;
  // Feed CI-failure lens (see feedCiLens): cycles off → feed → only → off, so ONE click from the
  // default turns the feature on. Persisted with the filter bar and URL-serialized
  // (`ci=only` / `ci=1`; the 'off' default is omitted).
  cycleFeedCiLens: () => void;
  setFeedCiLens: (v: FeedCiLens) => void;
  // Isolate the Feed to a single PR (or clear with null) — the Feed "open PRs" panel.
  setFeedIsolatedPrId: (id: number | null) => void;
  // Isolate the **Pending** board to one card kind (or clear with null) — the daily
  // brief's lines.
  //
  // ⚠ ORDERING: `setActivityRepo` CLEARS this (and early-returns `{}` when the rail id is
  // unchanged), so a caller that wants to both switch to the board AND isolate it must call
  // `setActivityRepo('attention')` FIRST and this SECOND. The same rule the PR-detail /
  // bot-only-PRs "Show in Activity feed" buttons follow for `setFeedIsolatedPrId`.
  setAttentionIsolation: (kind: InsightKind | null) => void;
  /**
   * Narrow the **Pending** board to one half of the `my_turn` population — 'mine' (work
   * tied to you) or 'others' (the review-or-reply backlog) — or `null` for the whole board.
   *
   * ⚠ SAME ORDERING TRAP AS `setAttentionIsolation`, and one more: `setActivityRepo` clears this
   * too AND early-returns `{}` on an unchanged rail, so a caller that wants a DIFFERENT lens (or
   * none) while already standing on the board must set it EXPLICITLY. The daily brief's lines all
   * do: each seats its own value, `null` included, because relying on the rail switch to clear
   * works only when the rail actually changes.
   */
  setAttentionRelevance: (lens: AttentionRelevanceLens | null) => void;
  /**
   * THE ONE "show me my turn — over there" navigation, in ONE gesture.
   *
   * Used by the Welcome-back banner's per-workspace lines: the whole point of that banner is that
   * it names work sitting in a workspace you are NOT currently in, so a click has to change scope
   * AND land on the list it named. It exists as a store action rather than a closure in the
   * banner because the sequence below is order-sensitive in two independent ways and every extra
   * spelling of it is a chance to get one of them wrong.
   *
   * ⚠ SCOPE FIRST, RAIL SECOND, ISOLATION LAST:
   *  1. `setWorkspace` clears `repoIds` / `feedIsolatedPrId` / `attentionIsolation` — so any
   *     isolation set before it is wiped. `repoIds: null` is load-bearing twice over: it shows all
   *     of the DESTINATION workspace (a subset belongs to the one being left), and it keeps
   *     `useWorkspaceSync`'s case-2 branch from issuing a SECOND `setWorkspace` on the next effect
   *     tick, which would wipe the isolation seated in step 3.
   *  2. `setActivityRepo` also clears the isolation, AND early-returns an empty patch when the
   *     rail id is unchanged — the asymmetry that makes a wrong-ordered caller work on every
   *     second click. (Pinned by attentionIsolation.test.ts.)
   *  3. Only then are the two lenses seated.
   *
   * ⚠ IT SEATS `attentionRelevance: 'mine'` TOO, and that is not decoration. Every caller of this
   * action is a NOTIFICATION surface whose figure is the PERSONAL count (banner line, dropdown
   * badge, the brief's "Elsewhere" rows) — direct + maintained, which is exactly what 'mine'
   * paints. Landing them on the broad board would put back the defect 747c9c9 fixed — a line that
   * says 4 opening a list of 50.
   *
   * ⚠ The workspace write is SKIPPED when we are already there. Re-writing the same id would
   * throw away a repo narrowing the user chose on the Timeline for no reason at all.
   */
  openMyTurnInWorkspace: (workspaceId: number) => void;
  /**
   * Record ONE auto-inserted batch of feed items as a "new" cohort, under `scopeKey`.
   *
   * This is also the ONLY place markers are removed, and the removal rule is the product one:
   * a cohort the reader has already SEEN clears WHOLESALE the moment more content arrives —
   * "new" then means the batch that just landed. A cohort they never saw SURVIVES the next
   * batch: it is still news to them, and silently dropping it would hide exactly the content
   * the marker exists to point at.
   *
   * `atTop` is the reader's scroll position AT THE MOMENT THE BATCH LANDED. Landing at the top
   * means the cards arrived in front of their eyes, so the cohort is born seen — it still shows
   * its marker, it just clears on the NEXT batch like any other.
   */
  pushFeedNewCohort: (scopeKey: string, ids: string[], atTop: boolean) => void;
  /** Credit every live cohort as seen — the reader is at (or near) the top of the feed. */
  markFeedNewCohortsSeen: (scopeKey: string) => void;
  // Set the Bot-ROI analytics window (the Insights Bot-ROI panel's window picker).
  setBotAnalyticsWindow: (v: BotWindowKind) => void;
  // Switch the Bots view's inner sub-tab (ROI / experimental Behaviour / Themes / Settings).
  setBotsInnerTab: (v: 'roi' | 'advisor' | 'settings') => void;
  // The Tune/Drop pills' entry point: focus the advisor on one bot AND switch the Bots view
  // to the Advisor tab in one action.
  focusAdvisor: (botKey: string, intent: 'tune' | 'drop') => void;
  clearAdvisorFocus: () => void;
  setFeedInnerTab: (v: 'feed' | 'themes') => void;
  /**
   * Seat PrDetail's inner tab FOR ONE PR (see prDetailTab). Always call it with the prId the
   * component is rendering — the pair is what keeps one PR's tab out of another's.
   */
  setPrDetailTab: (prId: number, tab: PrDetailTab) => void;
  // Persist the ad-hoc chat's live draft + conversation across Insights remounts.
  setSprintChatDraft: (
    patch: Partial<{ question: string; wantChart: boolean; wantBots: boolean }>,
  ) => void;
  // Append one completed turn to a workspace's live thread (the panel's ask() onSuccess — only
  // responses carrying a real answer become turns; throttled/credit shapes stay notices).
  appendSprintChatTurn: (scope: string, turn: SprintChatTurn) => void;
  // Seed a thread wholesale (a history pick's fresh 1-turn transcript) or clear it with []
  // (the "Start a new conversation" affordance).
  setSprintChatThread: (scope: string, turns: SprintChatTurn[]) => void;
  // Set/clear the PR-detail Threads-tab bot filter (a ChecksTab bot chip → filter Threads to
  // that vendor). Re-selecting the same vendor toggles it off.
  setThreadBotFilter: (kind: ReviewBotKind | null) => void;
  // Toggle one state pill on the PR-detail Threads tab (rebuilds the Set so subscribers rerender).
  toggleThreadStateFilter: (s: DerivedState) => void;
  setThreadStateFilter: (states: Set<DerivedState>) => void;
  toggleThreadSeverityFilter: (s: MlSeverity) => void;
  setThreadSeverityFilter: (severities: Set<MlSeverity>) => void;
  selectPr: (id: number | null) => void;
  selectThread: (prId: number | null, threadId: number | null) => void;
  clearSelection: () => void;
  // Open a PR's detail tab landing on its Threads tab with a derived-state pill preset (the
  // resolvable-bot-threads row click → the PR's likely-addressed threads). Does NOT touch the
  // Activity rail / feed isolation — navigation goes to the PR detail, not back to the Bots pane.
  openPrThreadsFiltered: (meta: TabMeta, state: DerivedState) => void;
  // Open a PR from the strip / my-turn / a timeline event: select it AND ask
  // the timeline to scroll to it (optionally recentering on `focusAt`). Pass `event`
  // to also glow a specific marker once the timeline recenters (e.g. a thread's
  // review_comment marker, resolved by (type, refId)) — like a "Show" link, but it
  // also records the thread/PR selection for the detail pane.
  openPrFocused: (
    id: number,
    threadId?: number | null,
    focusAt?: string | null,
    event?: { type: EventType; refId: number | null } | null,
  ) => void;
  // Show a specific activity entry on the timeline: keep its PR selected, recenter
  // on the event's instant, and glow the matching marker.
  showEventOnTimeline: (
    prId: number,
    focusAt: string,
    event: { type: EventType; refId: number | null },
  ) => void;
  // Highlight a specific event WITHIN a PR-focus tab (the thread/comment magnifier flow):
  // set the PR (and optional thread) selection + the timeline focus signals so the
  // just-opened isolate tab centres + glows the event's marker after it boots. Unlike
  // showEventOnTimeline it does NOT touch the active tab — the caller opens the pr-focus
  // tab first (openPrFocusTab), and this drives the isolate instance's focus consumer.
  focusEventInTab: (
    prId: number,
    focusAt: string,
    event: { type: EventType; refId: number | null },
    threadId?: number | null,
  ) => void;
  consumeTimelineFocus: () => void;
  // Recenter the timeline window on the current instant ("Now"); the Timeline
  // consumes the signal and clears it.
  centerTimelineNow: () => void;
  consumeTimelineCenter: () => void;
  // Open the selected PR's Activity tab scrolled to a specific entry (timeline
  // commit popover → PR Activity). PrDetail consumes it once it has scrolled.
  showActivityEntry: (
    prId: number,
    event: { type: EventType; refId: number | null },
  ) => void;
  consumeActivityFocus: () => void;
  // Open the selected PR's Overview tab scrolled to a specific issue-level PR
  // comment (timeline pr_comment popover → "Open in detail pane"). PrCommentsList
  // consumes it once it has scrolled to + flashed the card.
  showPrComment: (prId: number, commentId: number) => void;
  consumeCommentFocus: () => void;
  // Open a PR's Claude Review tab (the global progress banner → a running/finished
  // review). PrDetail consumes it once it has switched tabs.
  openClaudeReview: (
    meta: TabMeta,
    opts?: { fromActivity?: boolean; returnItemId?: string | null },
  ) => void;
  consumeClaudeTabFocus: () => void;
  // Open a PR's AI Fix tab, optionally seeded with a review to fix. PrDetail consumes
  // it once it has switched tabs.
  openAiFixFromReview: (prId: number, reviewText?: string) => void;
  consumeAiFixTabFocus: () => void;
  // Open (or re-focus) the flow-metric drill-down tab on a specific metric. Sets the
  // metricsFocus signal + opens the singleton metrics tab; MetricsDetail consumes it.
  openMetricsDetail: (metric: WorkspaceMetricKey) => void;
  consumeMetricsFocus: () => void;
  // Open (or re-focus) the bot-vendor PR drill-down tab on a specific analytics-row key
  // (`u<userId>` | 'pierre'). Sets the botPrsFocusKey signal + opens the singleton bot-PRs tab;
  // BotPrsDetail consumes it.
  openBotPrsDetail: (key: string, repoId?: number | null) => void;
  consumeBotPrsFocus: () => void;
  // Open (or re-focus) the sortable all-open-PRs drill-down tab on a scope (a repoId | the
  // workspace-wide 'feed' scope | a named repo group). Sets the openPrsScope seed + opens the
  // singleton tab; OpenPrsDetail reads (never consumes) the seed.
  openOpenPrsDetail: (scope: OpenPrsScope) => void;
  // Open (or re-focus) the bot-only-PRs drill-down tab (the amber "only a bot reviewed
  // these" caption). repoId scopes it to one repo; null = the whole active workspace.
  openBotOnlyDetail: (repoId: number | null) => void;
  // Open (or re-focus) the resolvable-bot-threads review & resolve tab (the Bot-ROI
  // backlog banner). repoId scopes it to one repo; null = the whole active workspace.
  openBotThreadsDetail: (repoId: number | null) => void;
  openThemeThreadsDetail: (theme: BotTheme, source: 'bot' | 'human') => void;
  // Open (or re-seed) the People-report drill-down tab for one workspace + period + selection
  // set (the Reports People picker's "Begin report"). The seed is read-not-consumed for the
  // tab's lifetime; a second Begin RE-SEEDS the singleton tab in place. PeopleReportDetail
  // renders sections ALPHABETICALLY from it — the seed preserves click order, the render
  // ignores it — and refuses to render at all once the active workspace has moved off
  // `workspaceId` (see the seed's own note).
  openPeopleReport: (
    workspaceId: number,
    periodKey: string,
    selections: PeopleReportSelection[],
  ) => void;
  openSearchDetail: (query: string) => void;
  // Open (or re-seed) the ML-strip drill-down tab on one tile/chip selector. `repoId` scopes it to
  // the repo the strip was measured at (the per-repo Bots tab); null = the whole active workspace.
  // BotFlaggingDetail reads (never consumes) the seed.
  //
  // `refine` is the OPENING narrowing — omitted by every tile on the strip, supplied by the
  // Behaviour tab's inflation card (one bot × one direction from a bar, or the card's whole
  // summed bot SET × one direction from "View all"). Optional so the tile callers are untouched,
  // and defaulted to nulls so the seed always holds a complete shape.
  openBotFlaggingDetail: (
    selector: BotFlaggingSelector,
    repoId: number | null,
    refine?: {
      bots?: BotFlaggingBotNarrowing | null;
      disagree?: VendorDisagreeDirection | null;
    },
  ) => void;
  // The bot pill's ✕ on the open drill-down (and nothing else): drop the bot narrowing while
  // keeping the population, the scope and the direction. In the store rather than local state
  // because the CHIP names it — see the seed's own note.
  setBotFlaggingBots: (bots: BotFlaggingBotNarrowing | null) => void;
  // The drill-down's "Clear" — every refinement the SEED carries, in one write. The tab's local
  // `cell`/`disagree` are cleared by the caller in the same event; this is the half that must not
  // come back when the reset effect re-applies the seed.
  clearBotFlaggingRefine: () => void;
  // Re-point the ALREADY-OPEN flagging drill-down at a different population — the severity and
  // topic dropdowns on the page itself. Replaces the seed's selector in place (the repo scope is
  // preserved), opens no tab and touches no other filter state; a null seed is a no-op.
  //
  // ⚠ THIS LIVES IN THE STORE, not in BotFlaggingDetail's local state, because the pinned tab's
  // CHIP LABEL is derived from this very selector (PinnedTabsBar → selectorLabel(seed.selector)).
  // A local override would leave the chip advertising the tile the user has since navigated away
  // from — the tab would read "Nits" while the page showed Security, which is worse than no label.
  setBotFlaggingSelector: (selector: BotFlaggingSelector) => void;
  // Open (or re-seed) the bot-comment-VOLUME drill-down — the merged PRs behind the ROI table's
  // "bot comments per PR" cell. `repoId` is the scope the COLUMN was measured at (the per-repo
  // Bots tab); null = the whole active workspace. `bots` is the cell's own bot, or null for the
  // whole-workspace reading.
  //
  // ⚠ The tab MUST inherit the same (workspace, window, repoIds) triple the cell was computed at —
  // workspace and window come from the store (`workspaceId` / `botAnalyticsWindow`, which is why
  // the tab keeps no local window), and this `repoId` is the third leg. A list measured at a
  // different scope would silently contradict the number that was clicked.
  openBotVolumeDetail: (repoId: number | null, bots?: BotFlaggingBotNarrowing | null) => void;
  // The bot pill's ✕ on the open volume drill-down: widen to EVERY bot while keeping the scope.
  // `null`, never an empty set — `[]` reads as "no bots" on the wire, the opposite of "clear".
  setBotVolumeBots: (bots: BotFlaggingBotNarrowing | null) => void;
  // Ask SyncStatus to pop the sync-progress modal (used right after adding a repo
  // so the initial backfill's load time is visible). Bumps syncModalSignal and
  // dedup-appends the added repo id to syncModalRepoIds so the modal can scope to
  // just the added repos.
  requestSyncModal: (repoId: number) => void;
  // Merge a partial into the shared sync round. ONLY the driver (SyncStatus) and its
  // registered actions may write it — consumers read + call getSyncRoundActions().
  setSyncRound: (patch: Partial<SyncRoundState>) => void;
  // Mirror of the WorkspaceManager's mounted state (set by the manager itself).
  setManagerOpen: (open: boolean) => void;
  bumpClaudeReviewKickoff: () => void;
  // Select an Activity detail target (a repo id, or one of the pseudo-rows: 'feed' for the
  // cross-repo consolidated Feed, 'bots', 'attention', 'insights').
  setActivityRepo: (id: number | 'feed' | 'attention' | 'insights' | 'bots') => void;
  // Set/clear the Activity repo console's soft thread-state filter (toggles off when
  // the same state is re-selected).
  setActivityThreadFilter: (s: DerivedState | null) => void;
  // Remember a repo console's Activity|Bots sub-tab (see repoConsoleTabs).
  setRepoConsoleTab: (repoId: number, tab: RepoConsoleTab) => void;
  // Select the Reports period (see insightsReportKey). `null` = the newest completed period.
  setInsightsReportKey: (periodKey: string | null) => void;
  toggleFileGroup: (path: string, defaultExpanded: boolean) => void;
  toggleDiffHunk: (threadId: number) => void;
  // Reset every user-set FILTER (repos, members, range, categories, PR statuses,
  // derived states, search, excludeBots, excludeStale, strip filter) back to its
  // fresh-load default. Selection and focus state are deliberately left intact —
  // "Clear filters" only clears filters, it doesn't deselect the PR or exit focus.
  // ⚠ `workspaceId` is NOT a filter and is explicitly PRESERVED: clearing a date range must
  // never teleport the user into another workspace. That is the whole reason it lives outside
  // FilterDefaults (persistence and reset share that one list).
  // The filter defaults mirror freshFilterDefaults() so useUrlState's diff-against-
  // defaults drops those params from the URL. (The FilterBar disables this while a
  // focus overlay is active, so it never runs mid-focus.)
  resetAllFilters: () => void;
  hydrate: (partial: Partial<FilterState>) => void;
}

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];
}

// Every non-action piece of state. freshDefaults() restores exactly these keys.
type FilterData = Omit<
  FilterState,
  {
    [K in keyof FilterState]: FilterState[K] extends (...args: never[]) => unknown
      ? K
      : never;
  }[keyof FilterState]
>;

// The user-set FILTERS — exactly what "Clear all" (resetAllFilters) resets.
// Selection, focus, transient signals and detail-view state are NOT here: Clear
// all leaves them alone. These values are what useUrlState diffs against, so a
// reset drops the filter params from the URL.
//
// ⚠ `workspaceId` MUST NOT JOIN THIS LIST. Persistence (pickFilterBarState), restore
// (sanitizePersistedFilters, which whitelists against freshFilterDefaults()) and reset
// (resetAllFilters) are all driven by it, so anything here is reset by "Clear filters" — and a
// workspace that resets to Default whenever a user clears a date range is a silent context
// switch. The scope is persisted in its own slice (pickScopeState) instead.
//
// A happy consequence of the same structure: because sanitizePersistedFilters whitelists against
// freshFilterDefaults(), a returning user's LEGACY persisted `teamScope` ('all' | 'none' |
// 'teams' | 'teams:1,2' | a bare number) is dropped automatically by its absence here — there is
// no coercion path that could read a bare team id as a workspace id.
type FilterDefaults = Pick<
  FilterState,
  | 'repoIds'
  | 'userIds'
  | 'excludeBots'
  | 'allowedBotIds'
  | 'excludeStale'
  | 'preset'
  | 'customFrom'
  | 'customTo'
  | 'categories'
  | 'prStatuses'
  | 'reviewStates'
  | 'derivedStates'
  // The one FEED toggle that is a standing preference rather than a per-session lens: "show me
  // broken builds" should still be on tomorrow. Every other feed*/bot* toggle stays transient
  // and out of this list. Adding a key here needs NO FILTER_STORAGE_VERSION bump — restore
  // whitelists against freshFilterDefaults(), so an older blob just lacks it and the default
  // applies. (A bump WITHOUT a migratePersistedFilters entry would discard the user's whole
  // remembered filter bar, which is why that is the wrong tool for an additive key.)
  //
  // ⚠ A KEY IN THIS LIST MUST ALSO BE URL-SERIALIZED in hooks/useUrlState (both directions).
  // Persistence alone does not survive a reload: writeToUrl makes the address bar non-bare the
  // moment the workspace resolves, and the persisted blob is only read on a BARE url.
  | 'feedCiLens'
>;

// Single source of truth for the filter defaults; array defaults are rebuilt per
// call so callers never share a mutable reference.
export function freshFilterDefaults(): FilterDefaults {
  return {
    // null = every repo in the ACTIVE WORKSPACE (see FilterState.repoIds). The URL serializer
    // diffs against this, so a fresh load stays clean (no repos= param).
    repoIds: null,
    userIds: null,
    // Bots are HIDDEN on a fresh load (default ON) — bot chatter is clutter for situational
    // awareness, same reasoning as excludeStale below. The hidden set is the UNION definition
    // server-side (users.isBot ∪ the workspace's automated-reviewer verdict, with a manual
    // "this is a human" beating the global flag both ways). The user can show bots via the
    // Members dropdown, and that non-default choice round-trips as bots=0 (see useUrlState).
    // This is the baseline the URL serializer diffs against.
    excludeBots: true,
    // No bots allow-listed on a fresh load — round-trips as allowBots=… when non-empty. Now
    // that excludeBots defaults on, this list bites for every user out of the box.
    allowedBotIds: [],
    // Stale open PRs (no commit/comment/review in the active range) are clutter for
    // situational awareness, so they're HIDDEN on a fresh load. This is the baseline
    // the URL serializer diffs against; turning the filter off round-trips as stale=0.
    excludeStale: true,
    preset: '14d',
    customFrom: null,
    customTo: null,
    categories: [...DEFAULT_CATEGORIES],
    prStatuses: [...DEFAULT_PR_STATUSES],
    reviewStates: [...DEFAULT_REVIEW_STATES],
    derivedStates: [],
    // CI-failure rows are OUT of the feed on a fresh load — they are too noisy to be a new
    // user's first impression (one card per failed check per head, so a red matrix build can
    // dominate the stream). The pill is always rendered, so the feature stays one click away;
    // discoverability is its job, not the default's. See FeedCiLens for the full history.
    feedCiLens: 'off',
  };
}

// The filter-bar subset of the current state, for persisting to localStorage so a
// fresh tab (no URL params) restores the user's last filters. EXACTLY the fields
// the URL also encodes — selection / focus / transient state is deliberately left
// out. Mirrors freshFilterDefaults() / FilterDefaults so persistence and the URL
// serializer stay in lockstep. See hooks/useUrlState.
export function pickFilterBarState(s: FilterState): FilterDefaults {
  return {
    repoIds: s.repoIds,
    userIds: s.userIds,
    excludeBots: s.excludeBots,
    allowedBotIds: s.allowedBotIds,
    excludeStale: s.excludeStale,
    preset: s.preset,
    customFrom: s.customFrom,
    customTo: s.customTo,
    categories: s.categories,
    prStatuses: s.prStatuses,
    reviewStates: s.reviewStates,
    derivedStates: s.derivedStates,
    feedCiLens: s.feedCiLens,
  };
}

// Restore an UNTRUSTED persisted blob (old localStorage / a saved view) down to the
// known persisted filter-bar keys, dropping everything else. Critically this drops:
//  • a LEGACY persisted `myTurnOnly` — older builds persisted it as a filter, but it's now
//    a TRANSIENT focus mode, so blindly re-hydrating it would silently re-enter My Turn
//    Focus Mode on load / on applying an old view (a fresh load must be the full board);
//  • a LEGACY persisted `teamScope` in ANY of its five old shapes ('all' | 'none' | 'teams' |
//    'teams:1,2' | a bare team id). It is NOT half-migrated into `workspaceId`: the migration
//    preserved team ids, so a bare `3` would read as a plausible workspace id and silently
//    select a workspace whose repo membership is not the team's. Discarding leaves
//    `workspaceId` null and the sync effect resolves the account's Default — the only honest
//    answer. Three of the five shapes have no image at all, and half-migrating persisted state
//    is worse than discarding it.
// New writes never include such keys (pickFilterBarState), but blobs written by an
// older build can. Whitelisting against freshFilterDefaults() also future-proofs this.
export function sanitizePersistedFilters(
  raw: Partial<FilterState>,
): Partial<FilterDefaults> {
  const allowed = freshFilterDefaults();
  const out: Partial<FilterDefaults> = {};
  for (const key of Object.keys(allowed) as (keyof FilterDefaults)[]) {
    if (key in raw && raw[key] !== undefined) {
      (out as Record<string, unknown>)[key] = raw[key];
    }
  }
  // `feedCiLens` is the one whitelisted key that is a string UNION rather than a boolean/array,
  // so the whitelist alone would let a tampered or future blob seat a value the type says cannot
  // exist. Drop anything that isn't a member and let the default apply.
  //
  // Note what is deliberately NOT here: a migration from the legacy boolean `feedShowCiFailures`.
  // It is not in the whitelist, so it is ignored — which is the intended outcome. Mapping the old
  // `false` (its default, i.e. what nearly every stored blob holds) onto 'off' would preserve the
  // very invisibility this change exists to fix, for exactly the users who never found the pill.
  if (
    out.feedCiLens !== undefined &&
    out.feedCiLens !== 'feed' &&
    out.feedCiLens !== 'only' &&
    out.feedCiLens !== 'off'
  ) {
    delete out.feedCiLens;
  }
  return out;
}

// ── The SCOPE slice — persisted separately from the filters, on purpose ──────────────────────
//
// The active workspace is not a filter: it is the context the filters apply INSIDE. Sharing the
// filter list would make "Clear filters" reset it (see FilterDefaults), and sharing the storage
// key would make one legacy blob poison both. It gets its own pick/sanitize pair and its own
// storage key (see hooks/useUrlState).
export interface ScopeState {
  workspaceId: number | null;
}

/** The persisted scope slice — the active workspace and nothing else. */
export function pickScopeState(s: FilterState): ScopeState {
  return { workspaceId: s.workspaceId };
}

/**
 * Restore an UNTRUSTED persisted scope blob. Only a POSITIVE INTEGER survives; anything else —
 * including every legacy `teamScope` shape that might land here by accident ('all', 'teams',
 * 'teams:1,2', an array) — yields `{}`, leaving `workspaceId` null so the sync effect resolves
 * the account's Default. The id is still only a HINT: it may name a workspace that was deleted
 * or belongs to another account, which is exactly what that effect corrects.
 */
export function sanitizePersistedScope(raw: unknown): Partial<ScopeState> {
  if (!raw || typeof raw !== 'object') return {};
  const id = (raw as { workspaceId?: unknown }).workspaceId;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return {};
  return { workspaceId: id };
}

// The fresh-load defaults for every (non-action) piece of state: the filters above
// plus selection, transient signals and detail-view state. Used for the initial
// store. (resetAllFilters resets only the filter subset.)
function freshDefaults(): FilterData {
  return {
    ...freshFilterDefaults(),
    // NOT RESOLVED YET. There is no static default — the account's Default workspace id varies
    // per account — so a fresh store starts null and the workspace-sync effect fills it once
    // listWorkspaces() lands. Nothing may render workspace-scoped data before then.
    // Deliberately outside freshFilterDefaults(): see FilterDefaults.
    workspaceId: null,
    // Transient Activity "Feed" scope toggles (not persisted filters): fresh load = false.
    feedMyTurnOnly: false,
    feedClaudeOnly: false,
    // Bots hidden by default (matches the Timeline's excludeBots default; same union
    // definition server-side). Transient, so the calm view reasserts every session.
    feedBotLens: 'hide',
    feedCatComments: false,
    feedCatPrEvents: false,
    feedNeedsReview: false,
    feedShowCommits: false,
    feedIsolatedPrId: null,
    attentionIsolation: null,
    // The board is BROAD by default: every card, whatever its relevance. A lens is only ever
    // seated by arriving from a count that was itself one half of the split.
    attentionRelevance: null,
    // No batch has landed yet — a freshly-opened feed is all equally new, so nothing is marked.
    feedNewCohorts: { scopeKey: null, cohorts: [] },
    botAnalyticsWindow: 'rolling_14',
    botsInnerTab: 'roi',
    advisorFocus: null,
    feedInnerTab: 'feed',
    prDetailTab: null,
    sprintChatDraft: { question: '', wantChart: false, wantBots: false },
    sprintChatThreads: {},
    selectedPrId: null,
    selectedThreadId: null,
    insightsReportKey: null,
    threadBotFilter: null,
    threadStateFilter: new Set<DerivedState>(),
    threadSeverityFilter: new Set<MlSeverity>(),
    selectedCommentId: null,
    activityFocus: null,
    commentFocus: null,
    claudeTabFocus: null,
    aiFixTabFocus: null,
    metricsFocus: null,
    botPrsFocusKey: null,
    botPrsFocusRepoId: null,
    openPrsScope: null,
    botOnlyFocusRepoId: null,
    botThreadsFocusRepoId: null,
    themeThreadsSeed: null,
    searchSeed: null,
    botFlaggingSeed: null,
    botVolumeSeed: null,
    peopleReportSeed: null,
    // Activity detail state — transient (like myTurnOnly / insightsOpen). A fresh open
    // lands on the cross-repo consolidated Feed (the relevance-ranked state of play)
    // with no thread-state filter.
    activityRepoId: 'feed',
    activityThreadFilter: null,
    repoConsoleTabs: {},
    expandedFileGroups: [],
    collapsedFileGroups: [],
    expandedDiffHunks: [],
    timelineFocusPr: null,
    timelineFocusAt: null,
    timelineFocusEvent: null,
    timelineCenterAt: null,
    rangeResetSignal: 0,
    syncModalSignal: 0,
    syncModalRepoIds: [],
    syncRound: {
      open: false,
      modal: false,
      syncing: false,
      cancelling: false,
      scopeIds: [],
    },
    managerOpen: false,
    claudeReviewKickoff: 0,
  };
}

// ── The URL-OWNED slice: state the query string names that is NOT a persisted filter ─────────
//
// `FilterDefaults` answers "what does Clear filters reset / what is persisted"; this answers a
// different question the URL layer alone needs: **which keys must a browser Back RESET when the
// popped URL does not mention them?** `readFromUrl` is PARTIAL by design (an absent param sets
// nothing), which is right on a cold load — the store starts at defaults — and WRONG on a pop,
// where the previous view's value would otherwise stay seated (Back off a narrowed attention
// board would keep the narrowing). So `applyUrlToStores` resets exactly these before applying the
// patch (see hooks/useUrlState).
//
// ⚠ It is deliberately NOT `freshDefaults()`: that would also wipe `sprintChatThreads`,
// `syncRound`, `repoConsoleTabs` and every drill-down seed — transient state the URL never
// serialized and therefore cannot restore.
// ⚠ `workspaceId` is NOT here either. Writing `null` means "not resolved yet", which stops every
// workspace-scoped surface from rendering and re-triggers the workspace-sync effect; the pop
// handler preserves the live id when the URL names none.
export type UrlOwnedState = Pick<
  FilterData,
  | 'activityRepoId'
  | 'insightsReportKey'
  | 'selectedPrId'
  | 'selectedThreadId'
  | 'attentionIsolation'
  | 'attentionRelevance'
  | 'feedIsolatedPrId'
  | 'prDetailTab'
  | 'feedInnerTab'
  | 'botsInnerTab'
>;

/** The fresh values of the URL-owned keys — read off freshDefaults() so the two cannot drift. */
export function freshUrlOwnedDefaults(): UrlOwnedState {
  const d = freshDefaults();
  return {
    activityRepoId: d.activityRepoId,
    insightsReportKey: d.insightsReportKey,
    selectedPrId: d.selectedPrId,
    selectedThreadId: d.selectedThreadId,
    attentionIsolation: d.attentionIsolation,
    attentionRelevance: d.attentionRelevance,
    feedIsolatedPrId: d.feedIsolatedPrId,
    prDetailTab: d.prDetailTab,
    feedInnerTab: d.feedInnerTab,
    botsInnerTab: d.botsInnerTab,
  };
}

export const useFilters = create<FilterState>((set, get) => ({
  ...freshDefaults(),

  setRepoIds: (ids) => set({ repoIds: ids }),
  // Switching workspace re-scopes everything; an isolated PR almost certainly falls out of the
  // new scope, so drop the isolation to avoid a confusing empty feed. The attention board's
  // kind isolation goes with it for the same reason — the new workspace may have none of that
  // kind, and an empty board with an unexplained filter on it is the worse outcome.
  setWorkspace: (workspaceId, repoIds) =>
    set({
      workspaceId,
      repoIds,
      feedIsolatedPrId: null,
      attentionIsolation: null,
      // The relevance lens goes with them: it was seated by a count taken in the workspace being
      // LEFT, so carrying it into the next one would filter a board against a number nobody
      // showed the reader.
      attentionRelevance: null,
    }),
  toggleRepo: (id) =>
    set((s) => ({ repoIds: toggle(s.repoIds ?? [], id) })),
  showRepo: (id) => {
    const { repoIds } = get();
    if (repoIds == null || repoIds.includes(id)) return; // already visible
    set({ repoIds: [...repoIds, id] });
  },
  setUserIds: (ids) => set({ userIds: ids }),
  setExcludeBots: (v) => set({ excludeBots: v }),
  setAllowedBotIds: (ids) => set({ allowedBotIds: ids }),
  toggleAllowedBot: (id) => set((s) => ({ allowedBotIds: toggle(s.allowedBotIds, id) })),
  setExcludeStale: (v) => set({ excludeStale: v }),
  setPreset: (p) =>
    // Bump rangeResetSignal so the Timeline re-applies the window even when the
    // preset is unchanged (re-clicking the active preset resets the view).
    set((s) => ({ preset: p, rangeResetSignal: s.rangeResetSignal + 1 })),
  setCustomRange: (from, to) =>
    set({ preset: 'custom', customFrom: from, customTo: to }),
  toggleCategory: (c) => set((s) => ({ categories: toggle(s.categories, c) })),
  setCategories: (c) => set({ categories: c }),
  togglePrStatus: (st) => set((s) => ({ prStatuses: toggle(s.prStatuses, st) })),
  setPrStatuses: (s) => set({ prStatuses: s }),
  toggleReviewState: (st) =>
    set((s) => ({ reviewStates: toggle(s.reviewStates, st) })),
  setReviewStates: (st) => set({ reviewStates: st }),
  toggleDerivedState: (st) =>
    set((s) => ({ derivedStates: toggle(s.derivedStates, st) })),
  setDerivedStates: (st) => set({ derivedStates: st }),
  toggleFeedMyTurnOnly: () =>
    set((s) => ({ feedMyTurnOnly: !s.feedMyTurnOnly, feedClaudeOnly: false })),
  setFeedMyTurnOnly: (v) =>
    set(v ? { feedMyTurnOnly: true, feedClaudeOnly: false } : { feedMyTurnOnly: false }),
  toggleFeedClaudeOnly: () =>
    set((s) => ({ feedClaudeOnly: !s.feedClaudeOnly, feedMyTurnOnly: false })),
  setFeedClaudeOnly: (v) =>
    set(v ? { feedClaudeOnly: true, feedMyTurnOnly: false } : { feedClaudeOnly: false }),
  cycleFeedBotLens: () =>
    set((s) => ({
      feedBotLens: s.feedBotLens === 'all' ? 'hide' : s.feedBotLens === 'hide' ? 'only' : 'all',
    })),
  setFeedBotLens: (v) => set({ feedBotLens: v }),
  toggleFeedCatComments: () => set((s) => ({ feedCatComments: !s.feedCatComments })),
  toggleFeedCatPrEvents: () => set((s) => ({ feedCatPrEvents: !s.feedCatPrEvents })),
  toggleFeedNeedsReview: () => set((s) => ({ feedNeedsReview: !s.feedNeedsReview })),
  toggleFeedShowCommits: () => set((s) => ({ feedShowCommits: !s.feedShowCommits })),
  cycleFeedCiLens: () =>
    set((s) => ({
      feedCiLens: s.feedCiLens === 'feed' ? 'only' : s.feedCiLens === 'only' ? 'off' : 'feed',
    })),
  setFeedCiLens: (v) => set({ feedCiLens: v }),
  setFeedIsolatedPrId: (id) => set({ feedIsolatedPrId: id }),
  // ⚠ Callers switching rail AND isolating must call setActivityRepo('attention') FIRST — see
  // the setter's declaration comment (setActivityRepo clears this, and no-ops when unchanged).
  setAttentionIsolation: (kind) => set({ attentionIsolation: kind }),
  // ⚠ Independent of the kind isolation on purpose (see the field): a caller that wants the broad
  // board must pass `null` itself, because setActivityRepo's clear does not fire on an unchanged
  // rail.
  setAttentionRelevance: (lens) => set({ attentionRelevance: lens }),
  // See the declaration above for the two ordering traps this sequence exists to encapsulate.
  // It deliberately calls the PUBLIC setters rather than one fused `set({...})`: a fused write
  // would be a second definition of what a workspace switch clears, free to drift from
  // `setWorkspace`'s.
  openMyTurnInWorkspace: (workspaceId) => {
    const s = get();
    if (s.workspaceId !== workspaceId) s.setWorkspace(workspaceId, null);
    // The banner can be clicked from the Timeline, a drill-down tab, anywhere — so the console
    // has to be brought forward before the rail inside it means anything.
    usePinnedTabs.getState().showActivity();
    s.setActivityRepo('attention');
    s.setAttentionIsolation('my_turn');
    // Last, and never conditionally: the figure the reader clicked was the PERSONAL one
    // (direct + maintained), so the list they land on has to be the same population — which is
    // what 'mine' paints. Seated AFTER both clears above it, exactly like the isolation.
    s.setAttentionRelevance('mine');
  },
  pushFeedNewCohort: (scopeKey, ids, atTop) =>
    set((s) => {
      if (ids.length === 0) return {};
      // A scope change (workspace, lens, "show commits", …) invalidates every remembered id.
      const prev = s.feedNewCohorts.scopeKey === scopeKey ? s.feedNewCohorts.cohorts : [];
      const next = [...prev.filter((c) => !c.seen), { ids, seen: atTop }];
      return {
        feedNewCohorts: {
          scopeKey,
          cohorts:
            next.length > FEED_NEW_COHORT_LIMIT
              ? next.slice(next.length - FEED_NEW_COHORT_LIMIT)
              : next,
        },
      };
    }),
  markFeedNewCohortsSeen: (scopeKey) =>
    set((s) => {
      const st = s.feedNewCohorts;
      // Called from a scroll handler, so the no-change case must be an EMPTY patch — a fresh
      // object every scroll event would re-render every subscriber of this slice.
      if (st.scopeKey !== scopeKey || st.cohorts.every((c) => c.seen)) return {};
      return {
        feedNewCohorts: {
          scopeKey: st.scopeKey,
          cohorts: st.cohorts.map((c) => (c.seen ? c : { ...c, seen: true })),
        },
      };
    }),
  setBotAnalyticsWindow: (v) => set({ botAnalyticsWindow: v }),
  setBotsInnerTab: (v) => set({ botsInnerTab: v }),
  focusAdvisor: (botKey, intent) =>
    set({ advisorFocus: { botKey, intent }, botsInnerTab: 'advisor' }),
  clearAdvisorFocus: () => set({ advisorFocus: null }),
  setFeedInnerTab: (v) => set({ feedInnerTab: v }),
  setPrDetailTab: (prId, tab) =>
    set((s) =>
      s.prDetailTab?.prId === prId && s.prDetailTab.tab === tab
        ? {}
        : { prDetailTab: { prId, tab } },
    ),
  setSprintChatDraft: (patch) =>
    set((s) => ({ sprintChatDraft: { ...s.sprintChatDraft, ...patch } })),
  appendSprintChatTurn: (scope, turn) =>
    set((s) => ({
      sprintChatThreads: {
        ...s.sprintChatThreads,
        [scope]: [...(s.sprintChatThreads[scope] ?? []), turn],
      },
    })),
  setSprintChatThread: (scope, turns) =>
    set((s) => ({ sprintChatThreads: { ...s.sprintChatThreads, [scope]: turns } })),
  setThreadBotFilter: (kind) =>
    set((s) => ({ threadBotFilter: s.threadBotFilter === kind ? null : kind })),
  toggleThreadStateFilter: (st) =>
    set((s) => {
      const next = new Set(s.threadStateFilter);
      if (next.has(st)) next.delete(st);
      else next.add(st);
      return { threadStateFilter: next };
    }),
  setThreadStateFilter: (states) => set({ threadStateFilter: states }),
  toggleThreadSeverityFilter: (sev) =>
    set((s) => {
      const next = new Set(s.threadSeverityFilter);
      if (next.has(sev)) next.delete(sev);
      else next.add(sev);
      return { threadSeverityFilter: next };
    }),
  setThreadSeverityFilter: (severities) => set({ threadSeverityFilter: severities }),
  selectPr: (id) =>
    set({
      selectedPrId: id,
      selectedThreadId: null,
      selectedCommentId: null,
      threadBotFilter: null,
      threadStateFilter: new Set<DerivedState>(),
      threadSeverityFilter: new Set<MlSeverity>(),
    }),
  selectThread: (prId, threadId) =>
    set((s) => ({
      selectedPrId: prId ?? s.selectedPrId,
      selectedThreadId: threadId,
      selectedCommentId: null,
      // Focusing a SPECIFIC thread must guarantee it's visible — a leftover state-pill preset
      // (from the resolvable-bot-threads tab) could otherwise filter the target thread out and
      // it would never scroll into view.
      threadStateFilter: threadId != null ? new Set<DerivedState>() : s.threadStateFilter,
      threadSeverityFilter:
        threadId != null ? new Set<MlSeverity>() : s.threadSeverityFilter,
    })),
  clearSelection: () =>
    set({
      selectedPrId: null,
      selectedThreadId: null,
      selectedCommentId: null,
      threadBotFilter: null,
      threadStateFilter: new Set<DerivedState>(),
      threadSeverityFilter: new Set<MlSeverity>(),
    }),
  openPrFocused: (id, threadId = null, focusAt = null, event = null) => {
    // Any timeline navigation leaves an open focus/PR tab so the move is visible on the
    // shared board (no-op when the board is already showing — the common case). When the
    // move is launched FROM an Activity-opened detail tab (the repurposed PR-title "Show"),
    // this pushes a back-step so browser Back returns to that detail tab first.
    usePinnedTabs.getState().showBoardFromDetail();
    set((s) => ({
      selectedPrId: id,
      selectedThreadId: threadId,
      selectedCommentId: null,
      timelineFocusPr: id,
      timelineFocusAt: focusAt,
      timelineFocusEvent: event,
      // Clear a leftover Threads-tab state preset when focusing a specific thread (see selectThread).
      threadStateFilter: threadId != null ? new Set<DerivedState>() : s.threadStateFilter,
      threadSeverityFilter:
        threadId != null ? new Set<MlSeverity>() : s.threadSeverityFilter,
    }));
  },
  showEventOnTimeline: (prId, focusAt, event) => {
    usePinnedTabs.getState().showBoardFromDetail();
    set({
      selectedPrId: prId,
      timelineFocusPr: prId,
      timelineFocusAt: focusAt,
      timelineFocusEvent: event,
    });
  },
  focusEventInTab: (prId, focusAt, event, threadId = null) =>
    set({
      selectedPrId: prId,
      selectedThreadId: threadId,
      selectedCommentId: null,
      timelineFocusPr: prId,
      timelineFocusAt: focusAt,
      timelineFocusEvent: event,
    }),
  consumeTimelineFocus: () =>
    set({
      timelineFocusPr: null,
      timelineFocusAt: null,
      timelineFocusEvent: null,
    }),
  centerTimelineNow: () => {
    usePinnedTabs.getState().showTimeline();
    set({ timelineCenterAt: Date.now() });
  },
  consumeTimelineCenter: () => set({ timelineCenterAt: null }),
  showActivityEntry: (prId, event) =>
    set({
      selectedPrId: prId,
      selectedThreadId: null,
      selectedCommentId: null,
      activityFocus: { prId, ...event },
    }),
  consumeActivityFocus: () => set({ activityFocus: null }),
  // Select the comment (permanent amber highlight) AND fire the transient scroll/
  // flash signal — the highlight persists, the flash plays once.
  showPrComment: (prId, commentId) =>
    set({
      selectedPrId: prId,
      selectedThreadId: null,
      selectedCommentId: commentId,
      commentFocus: { prId, commentId },
    }),
  consumeCommentFocus: () => set({ commentFocus: null }),
  // Open the PR's Claude Review pane. Crucially, ensure a pr-detail TAB is mounted first
  // (like the Feed path does) — the `claudeTabFocus` signal is consumed only by an effect
  // inside a mounted PrDetail, so setting it alone is a silent no-op whenever a full-screen
  // overlay (Flow metrics / Activity console) is up and no PrDetail is rendered.
  openClaudeReview: (meta, opts) => {
    usePinnedTabs.getState().openPrDetailTab(meta, opts);
    set({
      selectedPrId: meta.id,
      selectedThreadId: null,
      selectedCommentId: null,
      claudeTabFocus: { prId: meta.id },
    });
  },
  consumeClaudeTabFocus: () => set({ claudeTabFocus: null }),
  openAiFixFromReview: (prId, reviewText) =>
    set({
      selectedPrId: prId,
      selectedThreadId: null,
      selectedCommentId: null,
      aiFixTabFocus: { prId, reviewText },
    }),
  consumeAiFixTabFocus: () => set({ aiFixTabFocus: null }),
  openMetricsDetail: (metric) => {
    set({ metricsFocus: metric });
    usePinnedTabs.getState().openMetricsTab({ fromActivity: true });
  },
  consumeMetricsFocus: () => set({ metricsFocus: null }),
  openBotPrsDetail: (key, repoId) => {
    set({ botPrsFocusKey: key, botPrsFocusRepoId: repoId ?? null });
    usePinnedTabs.getState().openBotPrsTab({ fromActivity: true });
  },
  consumeBotPrsFocus: () => set({ botPrsFocusKey: null }),
  openOpenPrsDetail: (scope) => {
    set({ openPrsScope: scope });
    usePinnedTabs.getState().openOpenPrsTab({ fromActivity: true });
  },
  openBotOnlyDetail: (repoId) => {
    set({ botOnlyFocusRepoId: repoId });
    usePinnedTabs.getState().openBotOnlyPrsTab({ fromActivity: true });
  },
  openBotThreadsDetail: (repoId) => {
    set({ botThreadsFocusRepoId: repoId });
    usePinnedTabs.getState().openBotThreadsTab({ fromActivity: true });
  },
  openThemeThreadsDetail: (theme, source) => {
    set({ themeThreadsSeed: { theme, source } });
    usePinnedTabs.getState().openThemeThreadsTab({ fromActivity: true });
  },
  openPeopleReport: (workspaceId, periodKey, selections) => {
    set({ peopleReportSeed: { workspaceId, periodKey, selections } });
    usePinnedTabs.getState().openPeopleReportTab({ fromActivity: true });
  },
  // Open (or re-seed) the ML-strip drill-down on one tile/chip. `repoId` is the scope the strip
  // was MEASURED at, carried through verbatim so the drill-down's total is the number the user
  // just clicked rather than the same tile recomputed at a wider scope.
  openBotFlaggingDetail: (selector, repoId, refine) => {
    set({
      botFlaggingSeed: {
        selector,
        repoId,
        bots: refine?.bots ?? null,
        disagree: refine?.disagree ?? null,
      },
    });
    usePinnedTabs.getState().openBotFlaggingTab({ fromActivity: true });
  },
  setBotFlaggingBots: (bots) => {
    const seed = get().botFlaggingSeed;
    if (!seed) return; // never opened — nothing to narrow (same rule as setBotFlaggingSelector)
    set({ botFlaggingSeed: { ...seed, bots } });
  },
  clearBotFlaggingRefine: () => {
    const seed = get().botFlaggingSeed;
    if (!seed) return;
    // `null`, never `{userIds: [], …}` — an empty SET means "no bots" on the wire, which is the
    // opposite of what "Clear" promises.
    set({ botFlaggingSeed: { ...seed, bots: null, disagree: null } });
  },
  // The on-page dropdowns' writer — navigation WITHIN the open tab, so no openBotFlaggingTab call
  // (the tab is already showing; re-opening it would re-arm the Back-to-Activity affordance from a
  // control that never left Activity).
  setBotFlaggingSelector: (selector) => {
    const seed = get().botFlaggingSeed;
    // No seed = the drill-down was never opened, so there is nothing to re-point. Synthesising one
    // here would create a tab-less seed with no repo scope, silently measured at a scope the
    // reader never chose.
    if (!seed) return;
    // repoId rides through UNCHANGED: it is the scope the strip was MEASURED at, and these
    // dropdowns change which population is shown, never where it was counted. The bot narrowing
    // and the opening direction ride through for the same reason — "CodeRabbit's over-calls,
    // now among the nits" is a population the reader asked for one half of at a time.
    set({ botFlaggingSeed: { ...seed, selector } });
  },
  // Open (or re-seed) the bot-comment-VOLUME drill-down on one bot's cell (or on the whole
  // workspace, from the totals line). The repo scope is carried through verbatim so the list's
  // population is the one the clicked number was folded from.
  openBotVolumeDetail: (repoId, bots) => {
    set({ botVolumeSeed: { repoId, bots: bots ?? null } });
    usePinnedTabs.getState().openBotVolumeTab({ fromActivity: true });
  },
  setBotVolumeBots: (bots) => {
    const seed = get().botVolumeSeed;
    if (!seed) return; // never opened — nothing to narrow (the setBotFlaggingBots rule)
    set({ botVolumeSeed: { ...seed, bots } });
  },
  // Open (or re-seed) the cross-team search-results tab for `query`. No forced fromActivity — the
  // search box is global (openable from any view), so openTab infers the Back-to-Activity arming
  // from whether Activity is showing; re-searching from inside the tab just updates the seed.
  openSearchDetail: (query) => {
    set({ searchSeed: query });
    usePinnedTabs.getState().openSearchTab();
  },
  openPrThreadsFiltered: (meta, state) => {
    // Open the PR's detail tab (Back returns to the Activity console via fromActivity), then
    // select the PR + seed the Threads-tab pill in ONE set() — done together so selectPr's
    // reset can't race away the preset. PrDetail's threadStateFilter effect forces the Threads
    // tab. No setActivityRepo / setFeedIsolatedPrId: we go to the PR, not back to the Bots pane.
    usePinnedTabs.getState().openPrDetailTab(meta, { fromActivity: true });
    set({
      selectedPrId: meta.id,
      selectedThreadId: null,
      selectedCommentId: null,
      threadBotFilter: null,
      threadStateFilter: new Set<DerivedState>([state]),
      // Reset the severity pills too. This set() is a deliberate "seed the filters for the PR we
      // are opening", and it is the ONLY place that seeds one of them — so anything it does NOT
      // name survives from the PREVIOUS PR and silently hides threads on the new one. The same
      // reasoning as `threadBotFilter: null` on the line above.
      threadSeverityFilter: new Set<MlSeverity>(),
    });
  },
  requestSyncModal: (repoId: number) =>
    set((s) => ({
      syncModalSignal: s.syncModalSignal + 1,
      syncModalRepoIds: s.syncModalRepoIds.includes(repoId)
        ? s.syncModalRepoIds
        : [...s.syncModalRepoIds, repoId],
    })),
  setSyncRound: (patch) => set((s) => ({ syncRound: { ...s.syncRound, ...patch } })),
  setManagerOpen: (open) => set({ managerOpen: open }),
  bumpClaudeReviewKickoff: () =>
    set((s) => ({ claudeReviewKickoff: s.claudeReviewKickoff + 1 })),
  // Selecting a different repo console drops any lingering thread-state filter, the Feed's
  // single-PR isolation and the attention board's kind isolation so a narrow from one view
  // doesn't carry over to the next.
  //
  // ⚠ THE EARLY `{}` IS AN ORDERING TRAP for every caller that pairs this with an isolation
  // setter: re-selecting the CURRENT rail entry returns an empty patch, so a caller that
  // isolated FIRST and switched SECOND would have its isolation silently survive on some paths
  // and be wiped on others. Always switch first, isolate second.
  setActivityRepo: (id) =>
    set((s) =>
      s.activityRepoId === id
        ? {}
        : {
            activityRepoId: id,
            activityThreadFilter: null,
            feedIsolatedPrId: null,
            attentionIsolation: null,
            attentionRelevance: null,
          },
    ),
  setActivityThreadFilter: (st) =>
    set((s) => ({ activityThreadFilter: s.activityThreadFilter === st ? null : st })),
  setRepoConsoleTab: (repoId, tab) =>
    set((s) => ({ repoConsoleTabs: { ...s.repoConsoleTabs, [repoId]: tab } })),
  setInsightsReportKey: (periodKey) => set({ insightsReportKey: periodKey }),
  toggleFileGroup: (path, defaultExpanded) =>
    set((s) => {
      // Track explicit user intent against the default so re-renders are stable.
      const isExpanded = defaultExpanded
        ? !s.collapsedFileGroups.includes(path)
        : s.expandedFileGroups.includes(path);
      if (defaultExpanded) {
        return {
          collapsedFileGroups: isExpanded
            ? [...s.collapsedFileGroups, path]
            : s.collapsedFileGroups.filter((p) => p !== path),
        };
      }
      return {
        expandedFileGroups: isExpanded
          ? s.expandedFileGroups.filter((p) => p !== path)
          : [...s.expandedFileGroups, path],
      };
    }),
  toggleDiffHunk: (threadId) =>
    set((s) => ({ expandedDiffHunks: toggle(s.expandedDiffHunks, threadId) })),
  resetAllFilters: () =>
    // Reset only the user-set filters (selection / focus state is preserved);
    // bumping rangeResetSignal snaps the window back to the default range. The
    // FilterBar disables this control during focus, so it never runs mid-focus.
    //
    // ⚠ `workspaceId` is PRESERVED, structurally: it is not in freshFilterDefaults(), and this
    // set() writes a PARTIAL, so the active workspace is untouched. Adding it to
    // FilterDefaults would silently turn "Clear filters" into "go to the Default workspace".
    set((s) => ({ ...freshFilterDefaults(), rangeResetSignal: s.rangeResetSignal + 1 })),
  hydrate: (partial) => set(partial),
}));

/** Resolve the active [from, to] window from the preset or custom range. */
export function resolveRange(s: FilterState): { from: Date; to: Date } {
  return resolveBaseRange(s);
}

// (The five TeamScope canonicalisation helpers that lived here — scopeToParam, teamSetToScope,
// scopeToTeamSet, teamIdsInScope, isMultiTeamScope — are DELETED, with no replacement. They
// existed only to keep a five-shape union ('all' | 'none' | 'teams' | number | number[]) honest:
// a canonical wire string, a set→scope collapse, and a "how many teams am I actually looking at"
// predicate that neither `Array.isArray(scope)` nor `scope === 'teams'` could answer. The scope
// is a plain workspace id now, so there is nothing left to canonicalise and no predicate that
// two surfaces could disagree about. Surfaces that need the workspace's repos ask
// workspaceRepoIds(workspaceId, workspaces); the "2+ workspaces" gate on the Compare rail entry
// counts the ACCOUNT's workspaces, not the selection.)

function resolveBaseRange(s: FilterState): { from: Date; to: Date } {
  if (s.preset === 'custom' && (s.customFrom || s.customTo)) {
    const to = s.customTo ? new Date(`${s.customTo}T23:59:59Z`) : new Date();
    const from = s.customFrom
      ? new Date(`${s.customFrom}T00:00:00Z`)
      : new Date(to.getTime() - 14 * DAY_MS);
    return { from, to };
  }
  const days = PRESET_DAYS[(s.preset === 'custom' ? '14d' : s.preset) as Exclude<RangePreset, 'custom'>];
  const to = new Date();
  return { from: new Date(to.getTime() - days * DAY_MS), to };
}

/** Map the selected coarse categories to concrete event types. */
export function categoriesToTypes(categories: EventCategory[]): EventType[] {
  const set = new Set(categories);
  // 'lifecycle' and 'reviews' have no coarse UI toggle (see ALL_CATEGORIES), but
  // their events must still flow: lifecycle keeps contributor rows + activity-feed
  // jumps; review_submitted is filtered by the separate per-verdict `reviewStates`
  // param, so it's always fetched here and narrowed there. Always include both.
  set.add('lifecycle');
  set.add('reviews');
  return (Object.keys(EVENT_CATEGORY_BY_TYPE) as EventType[]).filter((t) =>
    set.has(EVENT_CATEGORY_BY_TYPE[t]),
  );
}

// Floor to the start of the minute so a relative "to = now" window yields a
// stable query string across renders (avoids refetch-on-every-render).
function floorMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60000) * 60000);
}

/**
 * Build the /api/open-prs query string. Respects the workspace scope + repo/member narrowing
 * but ignores the date range — open PRs are always open.
 *
 * ⚠ `repoIds` is emitted whenever it is NON-NULL, **including when it is empty**. `[]` is a real
 * narrowing ("nothing visible / this workspace has no repos"), not the absence of one, and the
 * old `length > 0` guard is exactly what let an empty workspace fall back to the whole account.
 * `workspace` is omitted only while the id is unresolved (null) — callers must keep the query
 * DISABLED until then rather than letting the server silently answer for Default.
 */
export function buildOpenPrsSearch(s: FilterState, includeMembers = true): string {
  const params = new URLSearchParams();
  if (s.workspaceId != null) params.set('workspace', String(s.workspaceId));
  if (s.repoIds) params.set('repoIds', s.repoIds.join(','));
  if (includeMembers && s.userIds && s.userIds.length > 0)
    params.set('userIds', s.userIds.join(','));
  return params.toString();
}

/**
 * Build the /api/timeline query string from current filters. `includeMembers` /
 * `includeStatuses` default true; pass false for the PR-title search index,
 * which is a global "jump to any PR" tool and so must ignore the member AND PR-
 * status filters (you can still search a closed/draft PR that's hidden on the
 * timeline). When all statuses are selected the `statuses` param is omitted (=
 * no filter); a non-full selection — including empty (= show none) — is sent.
 * `includeStaleFilter` defaults true; the search index passes false so the global
 * "jump to any PR" tool still finds a PR the stale filter hides from the timeline.
 * `includeReviewStates` defaults true; the search index passes false so the review-
 * verdict filter never narrows the member-derivation feed (it only hides markers).
 */
export function buildTimelineSearch(
  s: FilterState,
  includeMembers = true,
  includeStatuses = true,
  includeStaleFilter = true,
  includeReviewStates = true,
  // Embedded-tab range override (epoch ms): when set AND earlier than the resolved
  // `from`, widens the fetched window back to it (e.g. a PR-focus / My-Turn tab needs
  // ~90 days so its subject/inbox PRs are present) WITHOUT touching the store or URL.
  // Floored to the minute like the base range so it yields a stable query string.
  fromOverrideMs?: number | null,
  // `includeBots` defaults true (honour excludeBots + the allow-list). The member/PR
  // search index passes false so it ALWAYS fetches bot activity — the Members dropdown's
  // per-repo Bots sections need every bot even while the board hides them.
  includeBots = true,
  // When provided (non-empty), fetch EXACTLY these PRs (+ all their events), bypassing the
  // date/repo/status/member filters entirely — a pr-focus tab passes its subject PR's id so the
  // PR loads + highlights even when its repo/date isn't on the board. Undefined → normal filtering.
  prIdsOverride?: number[],
): string {
  // A pr-focus tab: fetch exactly the subject PR + its events, ignoring the board filters.
  // Emit ONLY `prIds` (no from/to) so the query key is STABLE per mount — the board's live
  // `to` (=now) would otherwise churn every minute, refetching + resetting the isolate boot.
  // Deliberately NO `workspace` either: getTimeline's prIds path BYPASSES the repo scope (an
  // isolate tab must load its subject PR even when the board's scope would hide it), so naming
  // a workspace could not change the response — it would only churn the key, and the request is
  // still bound by accountId. A scope bypass, never a tenancy one.
  if (prIdsOverride && prIdsOverride.length > 0) {
    return `prIds=${prIdsOverride.join(',')}`;
  }
  const { from, to } = resolveRange(s);
  const effectiveFrom =
    fromOverrideMs != null && fromOverrideMs < from.getTime()
      ? new Date(fromOverrideMs)
      : from;
  const params = new URLSearchParams();
  // The board's SCOPE. Omitted only while unresolved (null) — callers must keep the query
  // disabled until then rather than letting the server answer for Default under another name.
  if (s.workspaceId != null) params.set('workspace', String(s.workspaceId));
  params.set('from', floorMinute(effectiveFrom).toISOString());
  params.set('to', floorMinute(to).toISOString());
  // NON-NULL, including EMPTY (see buildOpenPrsSearch): `[]` narrows to nothing, it is not the
  // absence of a narrowing, and dropping it is what made an empty workspace show the account.
  if (s.repoIds) params.set('repoIds', s.repoIds.join(','));
  if (includeMembers && s.userIds && s.userIds.length > 0)
    params.set('userIds', s.userIds.join(','));
  if (s.categories.length < ALL_CATEGORIES.length) {
    params.set('types', categoriesToTypes(s.categories).join(','));
  }
  if (includeStatuses && s.prStatuses.length < ALL_PR_STATUSES.length) {
    params.set('statuses', s.prStatuses.join(','));
  }
  // Review-verdict filter: omit when all verdicts are selected (= no filter); send a
  // non-full selection — including empty (= hide all review markers) — like statuses.
  if (includeReviewStates && s.reviewStates.length < ALL_REVIEW_STATES.length) {
    params.set('reviewStates', s.reviewStates.join(','));
  }
  if (includeBots) {
    params.set('excludeBots', String(s.excludeBots));
    // The allow-list only bites under excludeBots; send it so the server keeps those
    // "important" bots visible even while hiding the rest.
    if (s.excludeBots && s.allowedBotIds.length > 0)
      params.set('allowBotIds', s.allowedBotIds.join(','));
  } else {
    // The search / member-derivation index always wants bots visible (the Members dropdown's
    // Bots sections must list every bot even while the board hides them). Explicit `false`
    // still matches the board's string whenever the user is SHOWING bots — one shared cache
    // entry then — but with hidden-by-default the two strings diverge on a fresh load, a
    // permanent extra lean fetch accepted by design. Do NOT "fix" this by hiding bots here.
    params.set('excludeBots', 'false');
  }
  if (includeStaleFilter && s.excludeStale) params.set('excludeStale', 'true');
  return params.toString();
}
