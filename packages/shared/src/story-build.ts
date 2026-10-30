// "IMPLEMENT STORY" — THE WIRE CONTRACT (docs/STORY-BUILD.md). One SESSION per (workspace, ticket, click):
// assess what the ticket's existing PRs already deliver, plan the rest across ≤ STORY_BUILD_MAX_REPOS
// repositories (a READ-ONLY agent, steered by chat), optionally weigh the workspace docs (the story wins),
// then build each repository IN PLAN ORDER in its own worktree (a write agent with no shell), and push
// each one as a new pull request ONLY when the reader presses Push.
//
// Every cap is spelled ONCE, here. The backend validates against these; the SPA words its limits from them.
// The ONLY entry point is the This Sprint card of a NOT-STARTED ticket with no pull request
// (`storyBuildOffered`); once a session exists the card shows its mark (`storyBuildMark`).

import type { DesignDiagram } from './sequence-diagrams.js';
import type { SprintStage } from './sprint-stories.js';
import type { StoryDocsCriteriaSource, StoryDocsRef } from './story-docs-alignment.js';
import type {
  AiFixChangeReport,
  AiFixChecks,
  AiFixChecksPreview,
  AiFixPlanMessage,
  AiProviderId,
  ClaudeTicketCriterionStatus,
} from './types.js';

// ---- caps (each spelled once) ---------------------------------------------------------------------

/** Repositories a plan may CHANGE (owner decision 3). Built sequentially, in plan order. */
export const STORY_BUILD_MAX_REPOS = 4;
/** Repositories checked out READ-ONLY for the plan pass (the candidates shown to the planner). */
export const STORY_BUILD_MAX_CANDIDATES = 6;
/** The plan summary: this many sentences, inclusive. */
export const STORY_BUILD_SUMMARY_MIN_SENTENCES = 2;
export const STORY_BUILD_SUMMARY_MAX_SENTENCES = 3;
/** Re-plans (chat messages) one session may run. */
export const STORY_BUILD_PLAN_MAX_REVISIONS = 12;
/** The longest steering message the chat route takes. */
export const STORY_BUILD_MESSAGE_MAX = 2_000;
/** Steps per changed repository, and a step title's length. */
export const STORY_BUILD_MAX_STEPS_PER_REPO = 12;
export const STORY_BUILD_STEP_TITLE_MAX = 120;
/** Risks a plan may list. */
export const STORY_BUILD_MAX_RISKS = 3;
/** A branch name's length (the reader may edit it until push). */
export const STORY_BUILD_BRANCH_MAX = 120;
/** Docs consideration: a note's and a suggestion's length, and the references per item. */
export const STORY_BUILD_DOCS_NOTE_MAX = 400;
export const STORY_BUILD_DOCS_SUGGESTION_MAX = 240;
export const STORY_BUILD_DOCS_REFS_MIN = 1;
export const STORY_BUILD_DOCS_REFS_MAX = 3;

// ---- spend and run limits: the DEFAULTS (the backend reads the env overrides, coding/story-build/limits.ts)

/** STORY_BUILD_SESSION_BUDGET_USD — the whole session: assess + plan passes + docs + every repo build. */
export const STORY_BUILD_SESSION_BUDGET_USD_DEFAULT = 30;
/** STORY_PLAN_BUDGET_USD — the assess + plan passes, summed across revisions. */
export const STORY_PLAN_BUDGET_USD_DEFAULT = 4;
/** STORY_BUILD_REPO_BUDGET_USD — one repository's build (+ its hook repairs). */
export const STORY_BUILD_REPO_BUDGET_USD_DEFAULT = 8;
/** A pass is refused when less than this is left of its budget. */
export const STORY_BUILD_MIN_BUDGET_LEFT_USD = 0.25;
export const STORY_PLAN_MAX_TURNS_DEFAULT = 40;
export const STORY_BUILD_MAX_TURNS_DEFAULT = 80;
/** STORY_BUILD_PATCH_MAX_BYTES — a stored patch (AI Fix's 1 MB is too small for features). */
export const STORY_BUILD_PATCH_MAX_BYTES_DEFAULT = 4 * 1024 * 1024;

// ---- the spend ledger (`ai_usage.feature`) ------------------------------------------------------------

/** One spelling per pass. Grouped with AI Fix in Reports → AI usage (`aiUsageFeatureGroup`). */
export const STORY_BUILD_LEDGER_FEATURES = {
  /** The assess + plan passes and every chat re-plan (agent, `story_plan`). */
  plan: 'story_plan',
  /** The repository shortlist (one-shot, fast role). */
  repos: 'story_build_repos',
  /** One repository's build + its hook repairs (agent, `story_build`). */
  build: 'story_build',
  /** The docs consideration's read (its Haiku shortlist records `story_docs_shortlist`). */
  docs: 'story_build_docs',
} as const;

// ---- the tab ------------------------------------------------------------------------------------

/** The build tab's key: `story-build:<ident>` (ephemeral and self-describing, like `ticket:`). */
export const STORY_BUILD_TAB_PREFIX = 'story-build:';

// ---- state --------------------------------------------------------------------------------------

export type StoryBuildStatus =
  | 'assessing'
  | 'planning'
  | 'plan_ready'
  | 'building'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'discarded';

export const STORY_BUILD_STATUSES: readonly StoryBuildStatus[] = [
  'assessing',
  'planning',
  'plan_ready',
  'building',
  'ready',
  'failed',
  'cancelled',
  'discarded',
];

/** ONE OPEN SESSION PER TICKET: the partial unique index in migration 0149 lists exactly these. */
export const STORY_BUILD_OPEN_STATUSES: readonly StoryBuildStatus[] = ['assessing', 'planning', 'plan_ready', 'building', 'ready'];

/** A model pass is in flight (the SPA streams and polls only then). */
export const STORY_BUILD_RUNNING_STATUSES: readonly StoryBuildStatus[] = ['assessing', 'planning', 'building'];

export function isStoryBuildOpen(s: StoryBuildStatus): boolean {
  return STORY_BUILD_OPEN_STATUSES.includes(s);
}

export function isStoryBuildRunning(s: StoryBuildStatus): boolean {
  return STORY_BUILD_RUNNING_STATUSES.includes(s);
}

export type StoryBuildRepoStatus =
  | 'planned'
  | 'queued'
  | 'preparing'
  | 'building'
  | 'checking'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'pushed';

/** A repository's build is in flight (restart reconcile turns these into `failed`, or `ready` with a patch). */
export const STORY_BUILD_REPO_RUNNING_STATUSES: readonly StoryBuildRepoStatus[] = ['preparing', 'building', 'checking'];

export type StoryBuildDocsStatus = 'none' | 'running' | 'ready' | 'failed' | 'refused';

/** The live step word (SSE `StoryBuildProgress.phase`, and `StoryBuild.phase` while running). */
export type StoryBuildPhase =
  | 'reading_story'
  | 'checking_coverage'
  | 'picking_repos'
  | 'checking_out'
  | 'planning'
  | 'docs_shortlisting'
  | 'docs_reading'
  | 'preparing'
  | 'preparing_checks'
  | 'building'
  | 'running_checks'
  | 'capturing'
  | 'pushing';

// ---- inputs: what the ticket's existing PRs already deliver (the gap fold) ------------------------

/** One acceptance criterion, as the latest ticket check judged it. `ref` is `AC1`…. */
export interface StoryBuildCoverageCriterion {
  ref: string;
  text: string;
  /** The ticket check's verdict; `not_checked` when no check ran. A gap is anything but `met`. */
  verdict: ClaudeTicketCriterionStatus;
  /** The PRs that deliver it (a `met` criterion), local ids. */
  coveredByPrIds: number[];
}

/** Something the ticket asks for outside its criteria (the ticket check's `missing` items). `ref` is `M1`…. */
export interface StoryBuildCoverageMissing {
  ref: string;
  text: string;
}

/**
 * THE GAP FOLD, frozen at assess time (`story_builds.coverage_json`).
 *   checked — a current succeeded ticket check was folded
 *   stale   — the latest check is out of date and a fresh one could not run (or was not needed)
 *   none    — the ticket has no PRs: every criterion is a gap
 *   failed  — a check was needed and failed: every criterion is a gap (`note` says so)
 */
export interface StoryBuildCoverage {
  state: 'checked' | 'stale' | 'none' | 'failed';
  ticketReviewId: number | null;
  /** ISO. */
  checkedAt: string | null;
  criteria: StoryBuildCoverageCriterion[];
  missing: StoryBuildCoverageMissing[];
  existingPrs: Array<{ prId: number; repoId: number; number: number; state: 'open' | 'merged' | 'closed'; headSha: string | null }>;
  /** One line when the fold could not use a check ("Couldn't check the existing PRs: building every criterion."). */
  note: string | null;
}

/** Is this criterion a gap the build should close? */
export function storyBuildIsGap(c: Pick<StoryBuildCoverageCriterion, 'verdict'>): boolean {
  return c.verdict !== 'met';
}

/** Why a repository is a candidate. */
export type StoryBuildCandidateSource = 'ticket_pr' | 'related' | 'picked';

/**
 * A repository shown to the planner (`story_builds.candidates_json`), with its BASE.
 * STACKING (owner decision 1): an OPEN ticket PR in this repo that is the READER'S OWN ⇒ stack on it
 * (`stackedOnPrId`, base = its head branch, the new PR targets that branch). Someone else's open PR ⇒
 * base = the default branch, and `baseNote` says so in one line.
 */
export interface StoryBuildCandidate {
  /** `R1`, `R2` … in the order shown. */
  ref: string;
  repoId: number;
  /** owner/name. */
  fullName: string;
  source: StoryBuildCandidateSource;
  baseRef: string;
  baseSha: string;
  stackedOnPrId: number | null;
  stackedOnPrNumber: number | null;
  baseNote: string | null;
}

// ---- the plan (the `story_plan` agent's accepted `submit_story_plan`, normalised) -----------------

export interface StoryBuildPlanStep {
  /** ≤ STORY_BUILD_STEP_TITLE_MAX. */
  title: string;
  files: string[];
  change: string;
  /** Gap refs it closes: `AC2`, `M1`. Checked against the gap fold. */
  refs: string[];
}

/** A repository the plan CHANGES. ≤ STORY_BUILD_MAX_REPOS of these, in BUILD ORDER. */
export interface StoryBuildPlanRepo {
  ref: string;
  repoId: number;
  why: string;
  /** The proposed branch name's slug (the reader edits the branch at Accept). */
  branchSlug: string;
  /** ≤ STORY_BUILD_MAX_STEPS_PER_REPO. */
  steps: StoryBuildPlanStep[];
  /** Tests the plan expects to add or change, one line each. */
  tests: string[];
}

export interface StoryBuildPlanReadOnlyRepo {
  ref: string;
  repoId: number;
  why: string;
}

export type StoryBuildCriterionHow = 'existing' | 'planned' | 'not_planned';

/** Every gap appears once. `repo` names a changed repo's ref when `how === 'planned'`. */
export interface StoryBuildPlanCriterion {
  ref: string;
  how: StoryBuildCriterionHow;
  repo: string | null;
  reason: string | null;
}

export interface StoryBuildPlan {
  revision: number;
  /** STORY_BUILD_SUMMARY_MIN..MAX_SENTENCES sentences. */
  summary: string;
  repos: StoryBuildPlanRepo[];
  readOnlyRepos: StoryBuildPlanReadOnlyRepo[];
  criteria: StoryBuildPlanCriterion[];
  /** ≤ STORY_BUILD_MAX_RISKS. */
  risks: string[];
}

/** One chat line: the reader's steering, or the pass's one-line answer. The AI Fix plan chat's shape,
 *  so the generalised `PlanChat` takes both. */
export type StoryBuildMessage = AiFixPlanMessage;

// ---- docs consideration (the story wins over the docs) --------------------------------------------

/**
 *   grounded    the docs agree with the plan — informational, no checkbox
 *   superseded  the story changes what the docs say — default UNTICKED ("the story wins, acknowledged")
 *   suggestion  the docs require something the story is silent on — default TICKED
 */
export type StoryBuildDocsItemKind = 'grounded' | 'superseded' | 'suggestion';

export interface StoryBuildDocsItem {
  /** Stable within one docs run (`D1`…); the decisions map is keyed by it. */
  id: string;
  kind: StoryBuildDocsItemKind;
  /** What it is about: `AC2`, `M1`, `R1:step 3`, or `story`. Validated against the plan and the gaps. */
  about: string;
  /** ≤ STORY_BUILD_DOCS_NOTE_MAX. */
  note: string;
  /** kind 'suggestion' only, ≤ STORY_BUILD_DOCS_SUGGESTION_MAX. */
  suggestion: string | null;
  /** STORY_BUILD_DOCS_REFS_MIN..MAX checked references. */
  refs: StoryDocsRef[];
}

export interface StoryBuildDocs {
  summary: string;
  items: StoryBuildDocsItem[];
  /** Every item lacked a checked reference and was dropped. */
  nothingGrounded: boolean;
  /** The plan revision the docs were weighed against. */
  planRevision: number;
}

export type StoryBuildDocsDecision = 'include' | 'ignore';
export type StoryBuildDocsDecisions = Record<string, StoryBuildDocsDecision>;

/** The default decision (owner decision 6): suggestions ticked, superseded unticked, grounded: none. */
export function storyBuildDocsDefaultDecision(kind: StoryBuildDocsItemKind): StoryBuildDocsDecision | null {
  if (kind === 'suggestion') return 'include';
  if (kind === 'superseded') return 'ignore';
  return null;
}

/** The decisions in force: the stored ones over the defaults; grounded items carry none. */
export function storyBuildDocsEffectiveDecisions(docs: StoryBuildDocs | null, stored: StoryBuildDocsDecisions | null): StoryBuildDocsDecisions {
  const out: StoryBuildDocsDecisions = {};
  for (const it of docs?.items ?? []) {
    const def = storyBuildDocsDefaultDecision(it.kind);
    if (def == null) continue;
    out[it.id] = stored?.[it.id] ?? def;
  }
  return out;
}

// ---- tests ("Run tests"): the AI Fix shapes, named for both features --------------------------------

/** What "Run tests" did on one run. The AI Fix shape (`AiFixChecks`), named for both features. */
export type CheckRunReport = AiFixChecks;
/** The checks picker for one repository at its base (`GET …/repos/:repoId/checks`). */
export type StoryBuildChecksPreview = AiFixChecksPreview;

// ---- the wire shapes --------------------------------------------------------------------------------

export interface StoryBuildRepo {
  /** `story_build_repos.id`. */
  id: number;
  repoId: number;
  /** owner/name. */
  fullName: string;
  ref: string;
  include: boolean;
  status: StoryBuildRepoStatus;
  /** The plan's build order (0-based). */
  order: number;
  baseRef: string;
  baseSha: string;
  stackedOnPrId: number | null;
  /** One line about the base (someone else's open PR on this ticket, …); null when there is nothing to say. */
  baseNote: string | null;
  /** The branch to push (editable until push). */
  branch: string | null;
  summary: string | null;
  commitMessage: string | null;
  filesChanged: string[];
  /** The `submit_build` report, validated against the shown refs and the captured diff. */
  changeReport: AiFixChangeReport | null;
  checksWanted: string[];
  checks: CheckRunReport | null;
  /** A stored patch exists (fetch it through `…/diff`; never inline here). */
  hasPatch: boolean;
  prTitle: string | null;
  pushedBranch: string | null;
  pushedPrNumber: number | null;
  pushedPrUrl: string | null;
  pushedCommitSha: string | null;
  /** ISO. */
  pushedAt: string | null;
  pushError: string | null;
  provider?: AiProviderId;
  model: string | null;
  effort: string | null;
  costUsd: number | null;
  numTurns: number | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** `GET /api/story-builds/:id`. Never carries a patch, the frozen prompt seed, or a token. */
export interface StoryBuild {
  id: number;
  workspaceId: number;
  ident: string;
  ticketKey: string;
  ticketTitle: string | null;
  status: StoryBuildStatus;
  /** The live step while running; null otherwise. */
  phase: StoryBuildPhase | null;
  error: string | null;
  /** What the plan passes ran on (the session's provider; follow-ups stay on it). */
  provider?: AiProviderId;
  model: string | null;
  effort: string | null;
  wantDiagram: boolean;
  wantDocs: boolean;
  criteriaSource: StoryDocsCriteriaSource | null;
  coverage: StoryBuildCoverage | null;
  candidates: StoryBuildCandidate[];
  plan: StoryBuildPlan | null;
  planRevision: number;
  transcript: StoryBuildMessage[];
  /** The planned design (`want_diagram`); cells name repo refs, never PRs. */
  design: DesignDiagram | null;
  docsStatus: StoryBuildDocsStatus;
  docs: StoryBuildDocs | null;
  /** The decisions in force (stored over defaults: `storyBuildDocsEffectiveDecisions`). */
  docsDecisions: StoryBuildDocsDecisions;
  /** Set at Accept: the plan revision and the docs decisions the build took. */
  acceptedRevision: number | null;
  acceptedDocs: StoryBuildDocsDecisions | null;
  /** In plan order. */
  repos: StoryBuildRepo[];
  planCostUsd: number | null;
  docsCostUsd: number | null;
  /** Every pass of the session (plan + docs + repos). */
  totalCostUsd: number | null;
  /** STORY_BUILD_SESSION_BUDGET_USD in force. */
  sessionBudgetUsd: number;
  /** Derived: every ready repository is pushed (status stays `ready`). */
  pushedAll: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** A row of the ticket's session history. */
export interface StoryBuildSummary {
  id: number;
  status: StoryBuildStatus;
  createdAt: string;
}

/** `GET /api/story-builds?workspace=&ident=` — the latest session for the ticket + the earlier ones. */
export interface StoryBuildForTicketResponse {
  workspaceId: number;
  build: StoryBuild | null;
  earlier: StoryBuildSummary[];
}

/** SSE `GET /api/story-builds/:id/stream`. `repoId` set during a repository's build/push. */
export interface StoryBuildProgress {
  phase: StoryBuildPhase;
  repoId?: number;
  message?: string;
  recentActivity?: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estCostUsd: number;
  };
}

// ---- request / response bodies -----------------------------------------------------------------------

/** `POST /api/story-builds`. `provider`/`model` = the reader's manual pick (absent ⇒ the default, deep). */
export interface StoryBuildStartBody {
  workspaceId: number;
  ident: string;
  provider?: AiProviderId;
  model?: string;
  diagram: boolean;
  docs: boolean;
}

/** 202 `{outcome:'started'}` · 200 `{outcome:'already_open'}` (one open session per ticket). */
export interface StoryBuildStartResponse {
  outcome: 'started' | 'already_open';
  buildId: number;
}

/** `POST /api/story-builds/:id/plan/message`. ≤ STORY_BUILD_MESSAGE_MAX characters. */
export interface StoryBuildPlanMessageBody {
  text: string;
}

/** `POST /api/story-builds/:id/docs`. */
export interface StoryBuildDocsBody {
  force?: boolean;
}

/** `PUT /api/story-builds/:id/docs/decisions` (DB only). Ids not in the current docs are dropped. */
export interface StoryBuildDocsDecisionsBody {
  decisions: StoryBuildDocsDecisions;
}

export interface StoryBuildAcceptRepo {
  repoId: number;
  include: boolean;
  branch: string;
  /** Check names ticked in the picker (empty ⇒ no tests). */
  checks: string[];
}

/** `POST /api/story-builds/:id/accept`. 409 `PlanMoved` when `planRevision` is not the latest. */
export interface StoryBuildAcceptBody {
  planRevision: number;
  repos: StoryBuildAcceptRepo[];
}

/** `POST …/repos/:repoId/push` and `POST …/push`. Draft unless `draft === false` (owner decision 2). */
export interface StoryBuildPushBody {
  draft?: boolean;
}

/** The default for `StoryBuildPushBody.draft`. */
export const STORY_BUILD_PUSH_DRAFT_DEFAULT = true;

export type StoryBuildPushOutcome = 'pushed' | 'failed' | 'skipped';

export interface StoryBuildRepoPushResult {
  repoId: number;
  outcome: StoryBuildPushOutcome;
  prNumber: number | null;
  prUrl: string | null;
  /** The AI Fix push codes (`BRANCH_EXISTS`, `NO_PUSH_PERMISSION`, …) or null. */
  code: string | null;
  error: string | null;
}

/** Push-one answers one result; Push all answers every unpushed ready repository, in plan order. */
export interface StoryBuildPushResponse {
  results: StoryBuildRepoPushResult[];
}

/** `GET …/repos/:repoId/diff` — the stored patch. */
export interface StoryBuildDiffResponse {
  repoId: number;
  baseSha: string;
  patch: string | null;
  filesChanged: string[];
}

/** Error codes the routes answer (`{ error: code, message }`). */
export type StoryBuildErrorCode =
  | 'NoClaudeAuth'
  | 'ModelNotOnProvider'
  | 'NoStory'
  | 'Busy'
  | 'NotReady'
  | 'PlanRevisionCap'
  | 'PlanBudgetSpent'
  | 'SessionBudgetSpent'
  | 'PlanMoved'
  | 'BadRequest'
  | 'NotFound';

// ---- the routes (one spelling for the backend's registration, the client and the rate-limit tiers) ----

export const STORY_BUILD_API = {
  list: '/api/story-builds',
  one: '/api/story-builds/:id',
  stream: '/api/story-builds/:id/stream',
  planMessage: '/api/story-builds/:id/plan/message',
  docs: '/api/story-builds/:id/docs',
  docsDecisions: '/api/story-builds/:id/docs/decisions',
  accept: '/api/story-builds/:id/accept',
  pushAll: '/api/story-builds/:id/push',
  cancel: '/api/story-builds/:id/cancel',
  discard: '/api/story-builds/:id/discard',
  repoChecks: '/api/story-builds/:id/repos/:repoId/checks',
  repoRetry: '/api/story-builds/:id/repos/:repoId/retry',
  repoDiff: '/api/story-builds/:id/repos/:repoId/diff',
  repoPush: '/api/story-builds/:id/repos/:repoId/push',
} as const;

export type StoryBuildApiRoute = keyof typeof STORY_BUILD_API;

/** A concrete path: `storyBuildPath('repoPush', { id: 7, repoId: 3 })`. */
export function storyBuildPath(route: StoryBuildApiRoute, params: { id?: number; repoId?: number } = {}): string {
  return STORY_BUILD_API[route]
    .replace(':id', params.id == null ? ':id' : String(params.id))
    .replace(':repoId', params.repoId == null ? ':repoId' : String(params.repoId));
}

// ---- the sprint card ----------------------------------------------------------------------------------

/**
 * `SprintGraphNode.build`: the ticket's latest OPEN session (null when none, or AI is off). Coarse on
 * purpose — it rides the sprint `changeToken`, so only the status and the repository counts are here.
 *   readyRepos   repositories built and not pushed yet
 *   pushedRepos  repositories pushed
 */
export interface SprintNodeBuild {
  id: number;
  status: StoryBuildStatus;
  readyRepos: number;
  pushedRepos: number;
}

/** The card's mark for a session: 'building' (a pass running) · 'plan_ready' (waiting for the reader) ·
 *  'ready_to_push' · 'pushed'. null ⇒ no mark (no open session). */
export type StoryBuildMark = 'building' | 'plan_ready' | 'ready_to_push' | 'pushed';

export function storyBuildMark(b: SprintNodeBuild | null | undefined): StoryBuildMark | null {
  if (b == null || !isStoryBuildOpen(b.status)) return null;
  if (isStoryBuildRunning(b.status)) return 'building';
  if (b.status === 'plan_ready') return 'plan_ready';
  if (b.readyRepos > 0) return 'ready_to_push';
  return b.pushedRepos > 0 ? 'pushed' : 'building';
}

/** The words for a mark (card, `BorderKey`, accessible name). */
export const STORY_BUILD_MARK_WORDS: Readonly<Record<StoryBuildMark, string>> = {
  building: 'Building…',
  plan_ready: 'Plan ready',
  ready_to_push: 'Ready to push',
  pushed: 'Pushed',
};

/**
 * THE ONE ENTRY GATE (owner decision 4): "Implement" shows ONLY on a This Sprint card of a sprint ticket
 * (not a ghost) whose status sits in the Not started bucket and that has NO pull request, and only while
 * no session is open (then the card shows the mark instead). The SPA also requires `me.ai.enabled`.
 */
export function storyBuildOffered(n: { ghost: boolean; stage: SprintStage | null; prs: ReadonlyArray<unknown>; build?: SprintNodeBuild | null }): boolean {
  return !n.ghost && n.stage === 'not_started' && n.prs.length === 0 && n.build == null;
}
