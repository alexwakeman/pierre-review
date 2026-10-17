import type { JiraStatusCategory, TrackerProvider } from './types.js';
import type { ReviewDocReference } from './reference-docs.js';

// REPORTS → THIS SPRINT — the shared constants and the pieces the SPRINT GRAPH (`sprint-graph.ts`)
// builds on: where the list came from, the read state, candidate repos, the status layout (status
// buckets) and "Check against code" (docs/API.md § This sprint; docs/TRACKERS.md § The sprint list
// read; docs/CLAUDE-REVIEW.md § Sprint assessment). Pro with the rest of Reports (`periodReports`):
// every route 402s before any DB work.
//
//   • THE POPULATION is the workspace tracker's CURRENT SPRINT, read by the tracker worker (the FIRST
//     tracker read that is not triggered by a received pull request — deliberately, and only for a
//     workspace whose This sprint tab was opened in the last `SPRINT_VIEW_TTL_DAYS`): Jira's open
//     sprints, Linear's active cycle, GitHub's nearest-due open milestone, else the status fallback
//     (To do + In progress tickets touched in the reporting window). The `source` says which.
//   • THE COLUMNS follow the workspace's STATUS LAYOUT (`SprintStatusLayout`): BUCKETS of statuses, each
//     meaning one of four stages — Not started, In progress, In review, Complete — plus the derived
//     "Merged, not signed off" column. AUTOMATIC (category, a review/QA name vocabulary, PR evidence;
//     the tracker's board / workflow order) unless the workspace sets its own (`SprintStatusSettings`).
//   • THE ASSESSMENT ("Check against code") is a local-only Sonnet 5 agent run over read-only default
//     branch checkouts of the repos the reader ACCEPTED for the ticket: PLAN (not started / in
//     progress) or VERIFY (in review / done) against the ticket's itemised criteria (its brief). Its
//     cited paths are VERIFIED by the server against the checkout; an unverified path is DROPPED.
//   • NOTHING HERE WRITES TO A TRACKER. The write-back was removed (2026-10-12).
//
// ⚠ There is no team or person score anywhere on this surface.

// ── Constants (the ONE spelling the server and the page's copy both read) ────────────────────────

/** The worker re-reads a viewed workspace's sprint list at most this often. */
export const SPRINT_READ_INTERVAL_MS = 20 * 60_000;

/** A workspace whose This sprint tab has not been opened for this many days is not read at all. */
export const SPRINT_VIEW_TTL_DAYS = 7;

/** Tickets one sprint read stores at most; the rest are cut and the page says so (`truncated`). */
export const SPRINT_TICKETS_MAX = 150;

/** The fallback window when the workspace has no reporting window (days). */
export const SPRINT_FALLBACK_DAYS = 14;

/** Ticket text caps on the wire (characters). The stored text is never cut; the wire is. */
export const SPRINT_TEXT_MAX = {
  title: 300,
  description: 20_000,
  criteria: 20_000,
} as const;

/** Candidate repos a reader may accept for one ticket. */
export const SPRINT_REPOS_PER_TICKET_MAX = 6;

/** Suggested (not yet accepted) repos shown per ticket. */
export const SPRINT_REPO_SUGGESTIONS_MAX = 4;

/** The assessment's model (a user decision). */
export const SPRINT_ASSESS_MODEL = 'claude-sonnet-5';

/** Default per-run spending cap (US$); `SPRINT_ASSESS_BUDGET_USD` overrides it on the server. */
export const SPRINT_ASSESS_BUDGET_USD_DEFAULT = 1.5;

/** Agent turns one assessment may take. */
export const SPRINT_ASSESS_MAX_TURNS = 60;

/** The assessment's caps — the server's validator; the SPA never re-checks. */
export const SPRINT_ASSESS_CAPS = {
  /** Characters, after trimming. The tool's schema refuses over-long text (the model rewrites it);
   *  the server's validator cuts anything that still gets through (with "…"). Two or three sentences. */
  summary: 400,
  /** PLAN mode: high-level changes one run may store, and one change's sentence. */
  planSteps: 6,
  planChange: 200,
  /** VERIFY mode: criteria one run may check, one check's evidence sentence, the coverage line. */
  criterionChecks: 30,
  evidence: 220,
  coverage: 300,
} as const;

// ── Where the list came from ─────────────────────────────────────────────────────────────────────

export type SprintFallbackReason =
  /** The tracker has no sprint concept we read (e.g. a Jira site with no sprint field). */
  | 'no_sprint_concept'
  /** It has one, but nothing is active right now. */
  | 'none_active';

/** Per workspace, what the stored list IS. Named on screen through `sprintSourceTitle`. */
export type SprintSource =
  | { kind: 'sprint'; provider: 'jira'; names: string[] }
  | { kind: 'cycle'; provider: 'linear'; names: string[] }
  | { kind: 'milestone'; provider: 'github'; name: string; dueOn: string | null; repos: string[] }
  | {
      kind: 'status_fallback';
      provider: TrackerProvider;
      reason: SprintFallbackReason;
      /** ISO-8601 — the "touched in" window. */
      from: string;
      to: string;
    };

/** The heading's name for a source ("Sprint 42", "Cycle 12 and Cycle 13", "Milestone v2.3"). */
export function sprintSourceTitle(s: SprintSource): string {
  const join = (names: string[]): string =>
    names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  switch (s.kind) {
    case 'sprint':
      return join(s.names) || 'Open sprint';
    case 'cycle':
      return join(s.names) || 'Active cycle';
    case 'milestone':
      return s.name;
    case 'status_fallback':
      return 'To do and in progress';
  }
}

/** The sprint read's state for this workspace. */
export interface SprintReadState {
  /** ISO-8601 of the last SUCCESSFUL read; null = never read yet (the page says "Reading…"). */
  readAt: string | null;
  /** ISO-8601 of the last attempt. */
  checkedAt: string | null;
  /** A plain-English sentence for the last attempt's failure, naming the provider; null = fine. */
  error: string | null;
  /** The read hit `SPRINT_TICKETS_MAX`. */
  truncated: boolean;
}

// ── Candidate repos ──────────────────────────────────────────────────────────────────────────────

export interface SprintRepoRef {
  repoId: number;
  /** owner/name */
  fullName: string;
}

/** Why code suggested a repo. Shown as the suggestion's reason, plain English. */
export type SprintRepoReason =
  /** The GitHub issue lives in this repo. */
  | 'issue_repo'
  /** Earlier PRs on tickets in the same epic landed here. */
  | 'same_epic'
  /** Earlier PRs on tickets with the same component landed here. */
  | 'same_component'
  /** Earlier PRs on tickets in the same Jira project / Linear team landed here. */
  | 'same_project'
  /** The repo's name appears in the ticket text. */
  | 'named_in_ticket'
  /** A PR on this very ticket is in this repo. */
  | 'ticket_pr';

export const SPRINT_REPO_REASON_LABEL: Record<SprintRepoReason, string> = {
  issue_repo: 'The issue is in this repo',
  same_epic: 'Same epic’s PRs landed here',
  same_component: 'Same component’s PRs landed here',
  same_project: 'Same project’s PRs landed here',
  named_in_ticket: 'Named in the ticket',
  ticket_pr: 'This ticket has a PR here',
};

export interface SprintRepoSuggestion extends SprintRepoRef {
  /** Strongest first; [] only for the workspace's ONLY repo when nothing else points at it. */
  reasons: SprintRepoReason[];
  /** Earlier merged PRs behind the history reasons (0 for a text-only reason). */
  prCount: number;
  /** Strong enough to be accepted by default: a `ticket_pr`, `issue_repo` or `named_in_ticket` reason,
   *  a history reason over ≥ SPRINT_REPO_CONFIDENT_MIN_PRS merged PRs, or the workspace's only repo. */
  confident: boolean;
}

/** Merged PRs a history reason needs for its suggestion to be confident. */
export const SPRINT_REPO_CONFIDENT_MIN_PRS = 3;

/** PUT /api/sprint-stories/repos — replace the ACCEPTED set for one ticket (≤ SPRINT_REPOS_PER_TICKET_MAX).
 *  Every id must be a repo of THIS workspace; anything else 400s (`bad_repo`) and nothing is written. */
export interface SprintReposUpdate {
  workspaceId: number;
  ident: string;
  repoIds: number[];
}

export interface SprintReposResponse {
  workspaceId: number;
  ident: string;
  accepted: SprintRepoRef[];
}

// ── The assessment ("Check against code") ────────────────────────────────────────────────────────

/** Bumped when the stored body's SHAPE changes: folded into the run's fingerprint (old runs read
 *  'stale') and a stored body of another shape is served as `body: null, outdated: true`.
 *  Format 6 (2026-10-12): the findings and the revised criteria / description are GONE — the run is
 *  the plan or the criteria check only, over the brief's itemised criteria. */
export const SPRINT_ASSESS_FORMAT_VERSION = 6;

/** "Check against code" is STAGE-AWARE (format 5). The server picks the mode from the ticket's stage
 *  at start (`sprintAssessModeOf`), stores it on the run and folds it into the fingerprint, so a stage
 *  change makes the run stale.
 *   • 'plan'   (Not started, In progress): no code is expected yet — the run lists the few high-level
 *              changes needed and where (`plan`), never "this may already be done".
 *   • 'verify' (In review, Complete): the code is expected on the default branch — the run checks each
 *              criterion against it and names a covering test (`criterionChecks`, `coverage`). */
export type SprintAssessMode = 'plan' | 'verify';

export function sprintAssessModeOf(stage: SprintStage): SprintAssessMode {
  return stage === 'in_review' || stage === 'done' ? 'verify' : 'plan';
}

/** PLAN mode: one high-level change the ticket needs. */
export interface SprintPlanStep {
  /** owner/name — one of the run's accepted repos. */
  repo: string;
  /** An existing file or directory the change touches, VERIFIED in the checkout; null when the step
   *  names a new file (`newPath`) or the path did not verify. */
  path: string | null;
  /** A proposed repo-relative path for a NEW file (not verified — it does not exist yet); null otherwise. */
  newPath: string | null;
  /** One sentence, ≤ SPRINT_ASSESS_CAPS.planChange. */
  change: string;
}

export type SprintCriterionStatus = 'met' | 'partly' | 'not_met' | 'unclear';

export const SPRINT_CRITERION_STATUS_LABEL: Record<SprintCriterionStatus, string> = {
  met: 'Met',
  partly: 'Partly met',
  not_met: 'Not met',
  unclear: 'Unclear',
};

/** VERIFY mode: one numbered criterion checked against the default branch. */
export interface SprintCriterionCheck {
  /** 1-based: the brief's criterion number (`SprintBrief.criteria[].n`). */
  n: number;
  status: SprintCriterionStatus;
  /** One sentence, ≤ SPRINT_ASSESS_CAPS.evidence. */
  evidence: string;
  /** The file showing it, VERIFIED; null when none was cited or it did not verify. */
  ref: SprintCodeRef | null;
  /** A test file covering it, VERIFIED; null = no covering test found (or it did not verify). */
  tests: SprintCodeRef | null;
}

export interface SprintCodeRef {
  /** owner/name — one of the run's accepted repos. */
  repo: string;
  /** Repo-relative POSIX path, VERIFIED to exist in the checkout. */
  path: string;
}

/** Field names are the `submit_assessment` tool's (after server validation). */
export interface SprintAssessmentBody {
  /** Which check this was (format 5). */
  mode: SprintAssessMode;
  /** The most important things, two or three sentences at most. */
  summary: string;
  /** PLAN mode only (≤ SPRINT_ASSESS_CAPS.planSteps); [] in verify mode. */
  plan: SprintPlanStep[];
  /** VERIFY mode only, by criterion number; [] in plan mode. */
  criterionChecks: SprintCriterionCheck[];
  /** VERIFY mode: one sentence on which criteria have tests; null in plan mode. */
  coverage: string | null;
  /** The reference-library passages the check used (docs/REFERENCE-DOCS.md § Use in reviews). Absent
   *  = it did not read the library. */
  references?: ReviewDocReference[];
}

/** What validation removed — stored, behind an ⓘ. */
export interface SprintAssessmentDropped {
  /** Cited paths that do not exist in the checkout (or name an unaccepted repo); the text is kept. */
  paths: number;
  /** Plan steps / criterion checks that were empty, named an unknown repo or criterion, or were over a
   *  cap. */
  items: number;
}

export type SprintAssessmentStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type SprintAssessmentPhase = 'checking_out' | 'reading' | 'writing';

export type SprintAssessmentErrorCode =
  | 'no_assessment' // the agent finished without calling submit_assessment
  | 'invalid_assessment' // nothing usable left after validation
  | 'no_checkout' // no accepted repo could be checked out
  | 'budget_exceeded'
  | 'max_turns'
  | 'auth'
  | 'runtime'
  | 'interrupted'
  | 'failed';

export const SPRINT_ASSESSMENT_ERROR_LABEL: Record<SprintAssessmentErrorCode, string> = {
  no_assessment: 'Claude finished without an assessment.',
  invalid_assessment: 'The assessment came back empty.',
  no_checkout: 'None of the chosen repos could be checked out.',
  budget_exceeded: 'The run hit its spending limit.',
  max_turns: 'The run took too many steps.',
  auth: 'No Claude login or API key found.',
  runtime: 'The AI runtime is not set up.',
  interrupted: 'The server restarted during the run.',
  failed: 'The assessment could not be finished.',
};

export interface SprintAssessmentRecord {
  id: number;
  workspaceId: number;
  ident: string;
  model: string;
  status: SprintAssessmentStatus;
  /** The check this run does (from the ticket's stage at start); null on runs stored before format 5. */
  mode: SprintAssessMode | null;
  /** While queued/running; null once finished. */
  phase: SprintAssessmentPhase | null;
  /** The repos and the default-branch commits the run read. */
  repos: Array<SprintRepoRef & { sha: string | null }>;
  /** Set only on 'succeeded' AND when the stored body is this format (`SPRINT_ASSESS_FORMAT_VERSION`). */
  body: SprintAssessmentBody | null;
  /** 'succeeded', but stored in an older format: the card says it is out of date and offers
   *  "Check against code" again. Never true for any other status. */
  outdated: boolean;
  dropped: SprintAssessmentDropped | null;
  error: SprintAssessmentErrorCode | null;
  costUsd: number | null;
  numTurns: number | null;
  createdAt: string;
  completedAt: string | null;
}

/** 'current' = same ticket text, same default-branch commits and same format as the run read; 'stale'
 *  = the button reads "Check again". null for an unfinished or failed run. */
export type SprintAssessmentCurrency = 'current' | 'stale' | null;

/** POST /api/sprint-stories/assess — local only (registerAgenticRoutes), Pro. */
export interface SprintAssessRequest {
  workspaceId: number;
  ident: string;
}

export interface SprintAssessResponse {
  assessment: SprintAssessmentRecord;
}

/** GET /api/sprint-stories/assessments/:id (the SPA polls while queued/running) and …/cancel. */
export interface SprintAssessmentResponse {
  assessment: SprintAssessmentRecord;
  currency: SprintAssessmentCurrency;
}

export type SprintAssessRefusal = 'busy' | 'no_repos' | 'no_ticket' | 'bad_request';

export interface SprintAssessErrorBody {
  error: SprintAssessRefusal;
  message: string;
  /** For 'busy': the run already in flight on this ticket. */
  runningId?: number;
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────────

/** The coarse phase of a listed ticket — derived from its `stage` (in_progress = In progress or In
 *  review). */
export type SprintPhase = 'not_started' | 'in_progress' | 'done';

export const SPRINT_PHASE_LABEL: Record<SprintPhase, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Complete',
};

// ── The status layout (buckets of statuses) ───────────────────────────────────────────────────────
//
// Statuses are per PROJECT and per TRACKER, so nothing here hard-codes a status name. The workspace
// groups its statuses into BUCKETS (1–SPRINT_BUCKETS_MAX, in reading order), each with a name and a
// MEANING — one of the four stages (Not started, In progress, In review, Complete). A ticket's `stage` is
// its bucket's meaning, so everything that reads a stage keeps working whatever the buckets are. Both
// the buckets and which status sits where are worked out automatically until the workspace sets them:
//
//   • THE ORDER — Jira: the board's column order (the sprint's `boardId` →
//     `/rest/agile/1.0/board/{id}/configuration`, status ids → names via `/rest/api/2/status`);
//     Linear: the team's workflow states (type, then `position`); GitHub Issues: Open, Closed. Stored
//     on `sprint_reads.status_order_json` by the sprint read. Unreadable → null, and the fallback is
//     the statuses on the tickets sorted by category (new → indeterminate → done), then name.
//   • THE AUTOMATIC STAGE — category `new` → Not started, `done` → Complete (so "Won't do" lands there).
//     An in-progress (or unknown-category) status is In review when its NAME reads as review / QA /
//     test / release (`SPRINT_REVIEW_STATUS_RE`), or when it sits at or after the PR-evidence
//     boundary: the FIRST in-progress status, in order, where at least SPRINT_DELIVERED_MIN_SHARE of the
//     tickets that have ≥ 1 pull request have ALL of them merged and none open, with at least
//     SPRINT_DELIVERED_MIN_TICKETS such tickets. Otherwise In progress.
//   • AUTOMATIC BUCKETS (`buckets: null`) — four, one per stage, id = the stage, named
//     SPRINT_STAGE_LABEL; every status sits in the bucket of its automatic stage.
//   • THE WORKSPACE'S BUCKETS (`SprintStatusSettings.buckets`) — meanings NON-DECREASING in order
//     (`sprintBucketsProblem`); each lists the statuses placed there, in order; a status sits in at
//     most one. ⚠ PLACEMENT BEATS CATEGORY. A status no bucket names (new on the board since) keeps
//     its automatic stage and joins the FIRST bucket with that meaning; with none, the bucket of the
//     NEAREST meaning (the earlier one on a tie) — marked `auto` either way.
//   • THE COLUMNS (`SprintStatusLayout.columns`) — the x axis of every This Sprint view: the buckets in
//     order, plus the DERIVED "Merged, not signed off" column (id SPRINT_MERGED_COLUMN_ID) while
//     `mergedColumn` is on (the default): after the last In review bucket, else after the last In
//     progress bucket, else before the first Complete bucket, else last. A ticket sits there when its
//     bucket means In progress or In review and it has ≥ 1 merged pull request and none open (closed
//     unmerged ones ignored) — `SprintGraphNode.column`, computed once in the graph fold.
//   • "Coding begins" = the first status of the first In progress bucket; "Coding ends" = the first
//     of the first In review bucket (`codingBegins` / `codingEnds`) — derived, never stored.
//
// A status NAME is matched case-insensitively (trimmed).

/** Share of PR-bearing tickets in a status that must be fully merged for it to start In review. */
export const SPRINT_DELIVERED_MIN_SHARE = 0.6;
/** Fully-merged tickets a status needs at least, for that share to count. */
export const SPRINT_DELIVERED_MIN_TICKETS = 2;
/** Statuses the buckets may list at most (over all of them); a status name's longest spelling. */
export const SPRINT_STATUS_ORDER_MAX = 60;
export const SPRINT_STATUS_NAME_MAX = 100;
/** Buckets a workspace may have; a bucket name's longest spelling; a bucket id's pattern. */
export const SPRINT_BUCKETS_MAX = 10;
export const SPRINT_BUCKET_NAME_MAX = 24;
export const SPRINT_BUCKET_ID_RE = /^[a-z0-9_-]{1,32}$/;
/** The DERIVED column's id (never a bucket id) and its name. */
export const SPRINT_MERGED_COLUMN_ID = 'merged';
export const SPRINT_MERGED_COLUMN_LABEL = 'Merged, not signed off';

/** An in-progress status whose NAME matches this is automatically In review ("Code Review", "Ready for
 *  QA", "In Test", "Awaiting Deployment", "UAT", "Sign-off", "Staging", "Demo", "Release"). */
export const SPRINT_REVIEW_STATUS_RE =
  /\b(?:review|qa|tests?|testing|verif\w*|uat|accept\w*|sign.?off|staging|ready for|demo|deploy\w*|release\w*)\b/i;

/** The four stages, in page order — a bucket's MEANING. */
export type SprintStage = 'not_started' | 'in_progress' | 'in_review' | 'done';

export const SPRINT_STAGES: readonly SprintStage[] = ['not_started', 'in_progress', 'in_review', 'done'];

export const SPRINT_STAGE_LABEL: Record<SprintStage, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Complete',
};

/** The coarse phase of a stage. */
export function sprintPhaseOfStage(stage: SprintStage): SprintPhase {
  return stage === 'not_started' ? 'not_started' : stage === 'done' ? 'done' : 'in_progress';
}

/** The automatic order as the sprint read stored it (`sprint_reads.status_order_json`). */
export interface SprintStatusAutoOrder {
  source: 'jira_board' | 'linear_states' | 'github';
  /** In board / workflow order. `id` is the tracker's status id when it has one. */
  statuses: Array<{ id: string | null; name: string; category: JiraStatusCategory | null }>;
  /** ISO-8601 of the read that produced it. */
  readAt: string;
}

/** One bucket of statuses, as the workspace set it. */
export interface SprintBucket {
  /** SPRINT_BUCKET_ID_RE, unique, never SPRINT_MERGED_COLUMN_ID. */
  id: string;
  /** 1–SPRINT_BUCKET_NAME_MAX characters. */
  name: string;
  meaning: SprintStage;
  /** The status names placed here, in order. */
  statuses: string[];
}

/** The workspace's override (`workspaces.sprint_statuses`). OVERRIDES ONLY: the default (automatic
 *  buckets, merged column on) is stored as NULL. A stored value of the retired `{sections}` or
 *  `{order, deliveredFrom}` shape is read into four buckets named SPRINT_STAGE_LABEL. */
export interface SprintStatusSettings {
  /** null = automatic. */
  buckets: SprintBucket[] | null;
  /** Draw the "Merged, not signed off" column. */
  mergedColumn: boolean;
}

export const SPRINT_STATUS_SETTINGS_DEFAULT: SprintStatusSettings = { buckets: null, mergedColumn: true };

/** The four automatic buckets (no statuses named). */
export function sprintAutomaticBuckets(): SprintBucket[] {
  return SPRINT_STAGES.map((s) => ({ id: s, name: SPRINT_STAGE_LABEL[s], meaning: s, statuses: [] }));
}

const STAGE_RANK: Record<SprintStage, number> = { not_started: 0, in_progress: 1, in_review: 2, done: 3 };

/** What is wrong with a set of buckets, in plain words; null when it may be saved. The server's
 *  validator (strict, on PUT) and the editor's (before Save) are this ONE function. */
export function sprintBucketsProblem(buckets: ReadonlyArray<SprintBucket>): string | null {
  if (buckets.length === 0) return 'Keep at least one bucket.';
  if (buckets.length > SPRINT_BUCKETS_MAX) return `Use at most ${SPRINT_BUCKETS_MAX} buckets.`;
  const ids = new Set<string>();
  const names = new Set<string>();
  const statuses = new Set<string>();
  let total = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    const b = buckets[i]!;
    if (typeof b.id !== 'string' || !SPRINT_BUCKET_ID_RE.test(b.id) || b.id === SPRINT_MERGED_COLUMN_ID || ids.has(b.id)) {
      return 'Each bucket needs its own id.';
    }
    ids.add(b.id);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name === '') return 'Give every bucket a name.';
    // eslint-disable-next-line no-control-regex
    if (name.length > SPRINT_BUCKET_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
      return `Keep bucket names to ${SPRINT_BUCKET_NAME_MAX} characters.`;
    }
    if (names.has(name.toLowerCase())) return `Two buckets are called “${name}”.`;
    names.add(name.toLowerCase());
    if (!SPRINT_STAGES.includes(b.meaning)) return `Choose what “${name}” means.`;
    const prev = buckets[i - 1];
    if (prev != null && STAGE_RANK[b.meaning] < STAGE_RANK[prev.meaning]) {
      return `“${name}” means ${SPRINT_STAGE_LABEL[b.meaning]}, so it cannot come after a bucket that means ${SPRINT_STAGE_LABEL[prev.meaning]}.`;
    }
    if (!Array.isArray(b.statuses)) return 'Each bucket needs a list of statuses.';
    for (const s of b.statuses) {
      const t = typeof s === 'string' ? s.trim() : '';
      // eslint-disable-next-line no-control-regex
      if (t === '' || t.length > SPRINT_STATUS_NAME_MAX || /[\u0000-\u001f\u007f]/.test(t)) return 'A status name is not valid.';
      if (statuses.has(t.toLowerCase())) return `“${t}” is in two buckets.`;
      statuses.add(t.toLowerCase());
      total += 1;
    }
  }
  if (total > SPRINT_STATUS_ORDER_MAX) return `Place at most ${SPRINT_STATUS_ORDER_MAX} statuses.`;
  return null;
}

/** One status in the resolved order. */
export interface SprintStatusLayoutEntry {
  name: string;
  category: JiraStatusCategory | null;
  /** Tickets in this status right now (Done ones included); 0 for a known status with none. */
  count: number;
  /** No bucket names it: it sits where the automatic rule put it ("not placed yet" in the editor). */
  auto: boolean;
  /** Its bucket's meaning — the stage tickets in this status are listed under. */
  stage: SprintStage;
  /** The bucket it sits in. */
  bucketId: string;
}

/** One resolved bucket: the workspace's (or an automatic one) with every status it holds. */
export interface SprintStatusLayoutBucket {
  id: string;
  name: string;
  meaning: SprintStage;
  /** In order (a slice of `order`). */
  statuses: SprintStatusLayoutEntry[];
}

/** One column of the x axis. `derived` = the "Merged, not signed off" column. */
export interface SprintColumn {
  id: string;
  name: string;
  meaning: SprintStage;
  derived: boolean;
}

/** Per in-progress status: the PR evidence behind the automatic In review boundary. */
export interface SprintStatusEvidence {
  status: string;
  /** Tickets in this status with ≥ 1 pull request. */
  withPrs: number;
  /** …of which every pull request is merged and none is open. */
  allMerged: number;
}

export interface SprintStatusLayout {
  /** Every known status (automatic order ∪ statuses on the tickets ∪ the buckets' names), grouped by
   *  bucket in bucket order, in order within a bucket. */
  order: SprintStatusLayoutEntry[];
  /** The resolved buckets, in order (four automatic ones when none are set). */
  buckets: SprintStatusLayoutBucket[];
  /** The drawn x axis: the buckets, plus the merged column when on. */
  columns: SprintColumn[];
  /** Where the order came from: the override, the tracker, or the category fallback. */
  orderSource: 'override' | SprintStatusAutoOrder['source'] | 'fallback';
  /** The first status of In progress / of In review (null when that stage is empty). */
  codingBegins: string | null;
  codingEnds: string | null;
  /** In order; in-progress (and unknown-category) statuses only. */
  evidence: SprintStatusEvidence[];
  /** The stored override (default when none). */
  settings: SprintStatusSettings;
}

/** PUT /api/sprint-stories/statuses — replace the workspace's override (FREE; the `read` tier; scope
 *  via `resolveWorkspaceScope`, an id that does not resolve to itself → 400 `bad_workspace`). Strict:
 *  `buckets` null or an array passing `sprintBucketsProblem`; `mergedColumn` a boolean → otherwise 400
 *  `bad_request` with the problem in `message`, and nothing is written. `{buckets: null, mergedColumn:
 *  true}` = "Reset to automatic" (stored as NULL). */
export interface SprintStatusesUpdate {
  workspaceId: number;
  settings: SprintStatusSettings;
}

export interface SprintStatusesResponse {
  workspaceId: number;
  settings: SprintStatusSettings;
  /** The layout recomputed with the new settings (same fold as the list GET). */
  statusLayout: SprintStatusLayout;
}

/** POST /api/sprint-stories/refresh {workspaceId} — read the sprint list now (bypasses the interval,
 *  not the backoff). 202 with the read state as it stands. */
export interface SprintRefreshResponse {
  workspaceId: number;
  read: SprintReadState;
}

