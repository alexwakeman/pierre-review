import type { JiraStatusCategory, TrackerProvider } from './types.js';
import type { StoryCriteriaSource, StoryPrRef } from './stories.js';
import {
  STORY_CHIP_ISSUE_IDS,
  STORY_ISSUE_BY_ID,
  STORY_ISSUE_CHECKS_DEFAULT,
  applyStoryIssueChecks,
  isStoryIssueId,
  storyIssueBullet,
  storyIssueTypeChecked,
  type StoryBlocker,
  type StoryIssue,
  type StoryIssueChecks,
  type StoryIssueId,
} from './story-issues.js';
import { STORY_SPEC_GAP_TYPE_LABEL, type StorySpecGap, type StorySpecGapType } from './story-health.js';
import type { StoryQuoteWhere, StoryRuleId } from './story-rules.js';

// REPORTS → THIS SPRINT — the wire contract for `GET /api/sprint-stories` and its siblings
// (docs/API.md § This sprint; docs/TRACKERS.md § The sprint list read; docs/CLAUDE-REVIEW.md §
// Sprint assessment). Pro with the rest of Reports (`periodReports`): every route 402s before any
// DB work.
//
//   • THE POPULATION is the workspace tracker's CURRENT SPRINT, read by the tracker worker (the FIRST
//     tracker read that is not triggered by a received pull request — deliberately, and only for a
//     workspace whose This sprint tab was opened in the last `SPRINT_VIEW_TTL_DAYS`): Jira's open
//     sprints, Linear's active cycle, GitHub's nearest-due open milestone, else the status fallback
//     (To do + In progress tickets touched in the reporting window). The `source` says which.
//   • THE ISSUES are the THREE story issues (`story-issues.ts`), folded in code from the criteria, the
//     ticket's stored TRACKER LINKS (`blocked_by_json`) and the STORED story labels (`story_labels`,
//     Haiku, `STORY_RUBRIC_VERSION`); a label half appears only while the label is CURRENT. Two are
//     CHIPS (Unclear when done, Blocked); spec gaps are a section of the opened card (`specGaps`).
//     Chip text and bullets are TEMPLATED — never model text.
//   • THE SECTIONS follow the workspace's STATUS LAYOUT (`SprintStatusLayout`): FOUR stages — Not
//     started, In progress, In review, Done — each with one sub-section per status, in order. Which
//     stage a status sits in, and the order, are AUTOMATIC (category, a review/QA name vocabulary, PR
//     evidence; the tracker's board / workflow order) unless the workspace places them itself
//     (`SprintStatusSettings`). Done tickets are LISTED, last.
//   • THE ASSESSMENT ("Check against code") is a local-only Sonnet 5 agent run over read-only default
//     branch checkouts of the repos the reader ACCEPTED for the ticket: a one-sentence summary, at
//     most one sentence per issue, and an optional revised criteria list. Its cited paths are VERIFIED
//     by the server against the checkout; an unverified path is DROPPED (the sentence stays).
//   • THE WRITE-BACK writes exactly the text the reader confirmed, to ONE ticket, on ONE press. No
//     bulk, no automatic setting, no agent tool can write. Claimed before the write, never retried.
//
// ⚠ ORDER: by stage and status section (above); within a section, most issues first, then key. NEVER
// by assignee, and there is no team or person score anywhere on this surface.

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
  /** A finding's sentence. */
  findingText: 220,
  /** A finding's suggested rewrite of its quote. */
  suggestion: 300,
  criterionText: 200,
  /** Findings one run may store. */
  findings: 6,
  revisedCriteria: 12,
  /** A proposed description (only when the description should change). */
  revisedDescription: 4000,
  /** PLAN mode: high-level changes one run may store, and one change's sentence. */
  planSteps: 6,
  planChange: 200,
  /** VERIFY mode: criteria one run may check, one check's evidence sentence, the coverage line. */
  criterionChecks: 30,
  evidence: 220,
  coverage: 300,
} as const;

/** The write-back's text cap (characters). Jira's own comment limit is 32,767. */
export const SPRINT_WRITE_TEXT_MAX = 20_000;

/** `requestId` shape (the SPA mints one per confirm dialog; the claim key). */
export const SPRINT_WRITE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** `baseHash` shape: a lowercase sha256 hex digest. */
export const SPRINT_BASE_HASH_RE = /^[0-9a-f]{64}$/;

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

// ── The issues and the checks ────────────────────────────────────────────────────────────────────
//
// A ticket's CHIPS are the story issues with `chip: true` (`story-issues.ts`: `foldStoryIssues`,
// folded by the server from the criteria and the CURRENT stored label), filtered by the workspace's
// checks (`applyStoryIssueChecks`) — so `flagCount`, the order and Copy all agree with what is on
// screen. ⚠ Spec gaps is NOT a chip: its gaps ride `specGaps` and the opened card of a NOT-STARTED
// ticket shows the first one as its own section (`sprintSpecGapLines`; the "Spec gaps" check still
// switches that section off).

/** The workspace's checks: `workspaces.sprint_checks` (same JSON column as before; parsed
 *  tolerantly — unknown ids dropped (incl. the retired 'too_big' / 'waits_on_work' /
 *  'scope_unstated'), an old object-shaped `issueTypes` reads as []). Three switches + issue types. */
export type SprintChecks = StoryIssueChecks;

export const SPRINT_CHECKS_DEFAULT: SprintChecks = STORY_ISSUE_CHECKS_DEFAULT;

/** PUT /api/sprint-stories/checks — replace the workspace's checks. Strict: an unknown issue id, a
 *  non-array, or a bad type name 400s and nothing is written. */
export interface SprintChecksUpdate {
  workspaceId: number;
  checks: SprintChecks;
}

export interface SprintChecksResponse {
  workspaceId: number;
  checks: SprintChecks;
}

/** The label half's state on this ticket. 'off' = labels are not made here (cloud, AI disabled);
 *  'pending' = labellable but no current label yet; 'none' = no criteria, nothing to label. */
export type SprintLabelState = 'current' | 'pending' | 'off' | 'none';

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
 *  'stale') and a stored body of another shape is served as `body: null, outdated: true`. */
export const SPRINT_ASSESS_FORMAT_VERSION = 5;

/** "Check against code" is STAGE-AWARE (format 5). The server picks the mode from the ticket's stage
 *  at start (`sprintAssessModeOf`), stores it on the run and folds it into the fingerprint, so a stage
 *  change makes the run stale.
 *   • 'plan'   (Not started, In progress): no code is expected yet — the run lists the few high-level
 *              changes needed and where (`plan`), never "this may already be done".
 *   • 'verify' (In review, Done): the code is expected on the default branch — the run checks each
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
  /** 1-based, the ticket's criterion number (`criteria.items`). */
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

/** One of Claude's findings (format 4), anchored like the labeller's: `rule` from the closed
 *  vocabulary for its issue (story-rules.ts), `quote` an exact passage of the ticket VERIFIED by the
 *  server (null when none was given or it did not verify — the finding is kept, unanchored). */
export interface SprintAssessmentFinding {
  issue: StoryIssueId;
  rule: StoryRuleId;
  /** The ticket's own spelling of the passage (`verifyStoryQuote`); null = unanchored. */
  quote: string | null;
  where: StoryQuoteWhere | null;
  /** One sentence, ≤ SPRINT_ASSESS_CAPS.findingText. */
  text: string;
  /** A rewrite of the quoted text, ≤ SPRINT_ASSESS_CAPS.suggestion; null when none (always null on an
   *  unanchored finding — there is nothing to rewrite). */
  suggestion: string | null;
  /** A verified file it rests on; null when none was cited or the path did not verify. */
  ref: SprintCodeRef | null;
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
  /** ≤ SPRINT_ASSESS_CAPS.findings, in STORY_ISSUES order (stable within an issue). */
  findings: SprintAssessmentFinding[];
  /** A proposed criteria list (≤ 12), each ≤ SPRINT_ASSESS_CAPS.criterionText. [] = keep them. */
  revisedCriteria: string[];
  /** A proposed description (≤ SPRINT_ASSESS_CAPS.revisedDescription), only when the description
   *  should change; null = keep it. */
  revisedDescription: string | null;
}

/** What validation removed — stored, behind an ⓘ. */
export interface SprintAssessmentDropped {
  /** Cited paths that do not exist in the checkout (or name an unaccepted repo); the text is kept. */
  paths: number;
  /** Findings with an unknown issue or a rule outside its issue's vocabulary, empty items, items over
   *  a cap. */
  items: number;
  /** Quotes that did not verify against the ticket text (the finding is kept, unanchored). Absent on
   *  runs stored before format 4. */
  quotes?: number;
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

// ── The write-back ───────────────────────────────────────────────────────────────────────────────

export type SprintWriteMode = 'comment' | 'replace';

/** What "Replace" writes over, decided by `sprintReplaceTarget` (the ONE rule, server and dialog). */
export type SprintReplaceTarget =
  | { kind: 'ac_field'; fieldId: string; fieldName: string }
  | { kind: 'description' };

/** Jira: the ticket's criteria field when its criteria came from one, else the description. Linear
 *  and GitHub Issues keep criteria in the description / body. */
export function sprintReplaceTarget(
  provider: TrackerProvider,
  acField: { id: string; name: string } | null,
): SprintReplaceTarget {
  if (provider === 'jira' && acField != null) return { kind: 'ac_field', fieldId: acField.id, fieldName: acField.name };
  return { kind: 'description' };
}

/** The text "Replace" overwrites: the criteria field or the description, by the ONE target rule. */
export function sprintReplaceBaseText(
  t: { description: string | null; acceptanceCriteria: string | null },
  target: SprintReplaceTarget,
): string {
  return (target.kind === 'ac_field' ? t.acceptanceCriteria : t.description) ?? '';
}

/** Whether that text is longer than the wire carries (`SPRINT_TEXT_MAX`). */
export function sprintReplaceBaseTruncated(text: string, target: SprintReplaceTarget): boolean {
  return text.length > (target.kind === 'ac_field' ? SPRINT_TEXT_MAX.criteria : SPRINT_TEXT_MAX.description);
}

/** Whether a write may replace `target` on a ticket whose criteria live where `criteriaTarget` says:
 *  the description ALWAYS, and the criteria field only when it is the ticket's own (`sprintReplaceTarget`).
 *  The server's check (`409 target_changed` otherwise). */
export function sprintWriteTargetAllowed(target: SprintReplaceTarget, criteriaTarget: SprintReplaceTarget): boolean {
  if (target.kind === 'description') return true;
  return criteriaTarget.kind === 'ac_field' && criteriaTarget.fieldId === target.fieldId && criteriaTarget.fieldName === target.fieldName;
}

/** One replaceable field's base: the sha256 of its FULL stored text (sent back as `baseHash`) and
 *  whether the copy on the wire was cut (`SPRINT_TEXT_MAX`) — a cut field is not editable. */
export interface SprintReplaceBase {
  hash: string;
  truncated: boolean;
}

/** The button's product name ("Update in Jira"). */
export const SPRINT_PROVIDER_LABEL: Record<TrackerProvider, string> = {
  jira: 'Jira',
  linear: 'Linear',
  github: 'GitHub',
};

/** POST /api/sprint-stories/write — ONE ticket, the EXACT text the reader confirmed. */
export interface SprintWriteRequest {
  workspaceId: number;
  ident: string;
  mode: SprintWriteMode;
  /** Markdown. 1..SPRINT_WRITE_TEXT_MAX chars after trim; no NUL, no lone surrogate. */
  text: string;
  /** Minted per confirm dialog (`SPRINT_WRITE_REQUEST_ID_RE`). A second POST with the same id is
   *  answered with the first one's record and never writes again. */
  requestId: string;
  /** For 'replace': the field written — the description, or the ticket's own criteria field
   *  (`sprintWriteTargetAllowed`); anything else refuses `target_changed`. */
  target?: SprintReplaceTarget;
  /** For 'replace' (required there): that field's `replaceBases` hash the draft was built on. The server
   *  re-reads the ticket live first; a different text refuses `ticket_changed` and writes nothing. */
  baseHash?: string;
  /** The assessment the text came from, when it did (history only). */
  assessmentId?: number | null;
}

export type SprintWriteStatus = 'writing' | 'written' | 'failed' | 'maybe_written';

export type SprintWriteErrorCode =
  | 'no_write_permission' // 401/403 on the write: "This token can't write to Jira."
  | 'not_found'
  | 'rate_limited'
  | 'timeout' // cut off: status becomes 'maybe_written'
  | 'interrupted' // server restarted mid-write: 'maybe_written'
  | 'rejected' // the tracker refused the content (4xx other than auth)
  | 'failed';

export interface SprintWriteRecord {
  id: number;
  ident: string;
  mode: SprintWriteMode;
  target: SprintReplaceTarget | null;
  status: SprintWriteStatus;
  error: SprintWriteErrorCode | null;
  /** Plain English, names the provider; null on success. */
  message: string | null;
  /** The comment / ticket link the tracker answered with (render through `safeExternalUrl`). */
  url: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type SprintWriteRefusal =
  | 'bad_request' // shape, mode, requestId
  | 'bad_text' // empty, too long, NUL, lone surrogate
  | 'no_ticket' // not a ticket of this workspace's current sprint list
  | 'no_tracker'
  | 'target_changed' // the replace target moved since the dialog opened
  | 'ticket_changed' // replace: the ticket's text changed since the dialog opened (nothing written)
  | 'too_long' // replace: the ticket's text is longer than the page shows, so it cannot be replaced here
  | 'read_failed' // replace: the live re-read before the write failed (nothing written)
  | 'busy'; // another write on this ticket is in flight

export interface SprintWriteErrorBody {
  error: SprintWriteRefusal;
  message: string;
}

/** 200 with the record — `status` says what happened (a failed write is a record, not a 5xx). */
export interface SprintWriteResponse {
  write: SprintWriteRecord;
}

/** The sentence a ticket shows for a write that may or may not have landed. */
export const SPRINT_WRITE_MAYBE_SENTENCE = 'This may have been written. Check the ticket before trying again.';

export function sprintNoWriteSentence(provider: TrackerProvider): string {
  return `This token can’t write to ${SPRINT_PROVIDER_LABEL[provider]}.`;
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────────

/** The coarse phase of a listed ticket — derived from its `stage` (in_progress = In progress or In
 *  review). */
export type SprintPhase = 'not_started' | 'in_progress' | 'done';

export const SPRINT_PHASE_LABEL: Record<SprintPhase, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
};

// ── The status layout (four stages, sections by status) ───────────────────────────────────────────
//
// Statuses are per PROJECT and per TRACKER, so nothing here hard-codes a status name. Each status is
// placed in ONE of four stages and given a position; both are worked out automatically and the
// workspace may place any status itself:
//
//   • THE ORDER — Jira: the board's column order (the sprint's `boardId` →
//     `/rest/agile/1.0/board/{id}/configuration`, status ids → names via `/rest/api/2/status`);
//     Linear: the team's workflow states (type, then `position`); GitHub Issues: Open, Closed. Stored
//     on `sprint_reads.status_order_json` by the sprint read. Unreadable → null, and the fallback is
//     the statuses on the tickets sorted by category (new → indeterminate → done), then name.
//   • THE AUTOMATIC STAGE — category `new` → Not started, `done` → Done. An in-progress (or
//     unknown-category) status is In review when its NAME reads as review / QA / test / release
//     (`SPRINT_REVIEW_STATUS_RE`), or when it sits at or after the PR-evidence boundary: the FIRST
//     in-progress status, in order, where at least SPRINT_DELIVERED_MIN_SHARE of the tickets that have
//     ≥ 1 pull request have ALL of them merged and none open, with at least
//     SPRINT_DELIVERED_MIN_TICKETS such tickets. Otherwise In progress.
//   • THE OVERRIDE (`SprintStatusSettings.sections`) lists, per stage, the statuses the reader placed,
//     in order. ⚠ PLACEMENT BEATS CATEGORY: a `done`-category status the reader put in In review is In
//     review. A status the override does not name (new on the board since) keeps its AUTOMATIC stage
//     and position.
//   • "Coding begins" = the first status of In progress; "Coding ends" = the first of In review
//     (`codingBegins` / `codingEnds`) — derived, never stored.
//
// A status NAME is matched case-insensitively (trimmed).

/** Share of PR-bearing tickets in a status that must be fully merged for it to start In review. */
export const SPRINT_DELIVERED_MIN_SHARE = 0.6;
/** Fully-merged tickets a status needs at least, for that share to count. */
export const SPRINT_DELIVERED_MIN_TICKETS = 2;
/** Statuses an override may list at most (over all four stages); a status name's longest spelling. */
export const SPRINT_STATUS_ORDER_MAX = 60;
export const SPRINT_STATUS_NAME_MAX = 100;

/** An in-progress status whose NAME matches this is automatically In review ("Code Review", "Ready for
 *  QA", "In Test", "Awaiting Deployment", "UAT", "Sign-off", "Staging", "Demo", "Release"). */
export const SPRINT_REVIEW_STATUS_RE =
  /\b(?:review|qa|tests?|testing|verif\w*|uat|accept\w*|sign.?off|staging|ready for|demo|deploy\w*|release\w*)\b/i;

/** The four stages, in page order. */
export type SprintStage = 'not_started' | 'in_progress' | 'in_review' | 'done';

export const SPRINT_STAGES: readonly SprintStage[] = ['not_started', 'in_progress', 'in_review', 'done'];

export const SPRINT_STAGE_LABEL: Record<SprintStage, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
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

/** The workspace's override (`workspaces.sprint_statuses`). OVERRIDES ONLY: `sections: null` =
 *  automatic (stored as NULL). Each stage lists the statuses the reader placed there, in order; names
 *  are matched case-insensitively. (A stored value of the retired `{order, deliveredFrom}` shape is
 *  read into this one.) */
export interface SprintStatusSettings {
  sections: Record<SprintStage, string[]> | null;
}

export const SPRINT_STATUS_SETTINGS_DEFAULT: SprintStatusSettings = { sections: null };

/** One status in the resolved order. */
export interface SprintStatusLayoutEntry {
  name: string;
  category: JiraStatusCategory | null;
  /** Tickets in this status right now (Done ones included); 0 for a known status with none. */
  count: number;
  /** Its stage AND position came from the automatic layout (true) or the override (false). */
  auto: boolean;
  /** The stage tickets in this status are listed under. */
  stage: SprintStage;
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
  /** Every known status (automatic order ∪ statuses on the tickets ∪ the override's names), grouped
   *  by stage in SPRINT_STAGES order, in order within a stage. The page renders a section per entry
   *  with `count > 0`. */
  order: SprintStatusLayoutEntry[];
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

/** PUT /api/sprint-stories/statuses — replace the workspace's override (Pro, `periodReports`; the
 *  `read` tier; scope via `resolveWorkspaceScope`). Strict: `sections` not null and not an object with
 *  exactly the four stage keys, each an array of names; a name over SPRINT_STATUS_NAME_MAX, empty, or
 *  with NUL / control characters; more than SPRINT_STATUS_ORDER_MAX names in all; or one name in two
 *  places (case-insensitive) → 400 and nothing is written. `{sections: null}` = "Reset to automatic"
 *  (stored as NULL). */
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

/** How a related ticket is tied to this one:
 *   • blocked_by — a stored tracker link that BLOCKS it ("is blocked by", "depends on");
 *   • depends_on / concurrent / builds_on / supersedes / out_of_scope / context — what the CURRENT
 *     label says the text means by it (shared `StoryReferenceRelation`, rubric 4);
 *   • linked — another stored tracker link;
 *   • mentioned — named in the description / criteria with no label reading of it (no current label). */
export type SprintRelation =
  | 'blocked_by'
  | 'depends_on'
  | 'concurrent'
  | 'builds_on'
  | 'supersedes'
  | 'out_of_scope'
  | 'context'
  | 'linked'
  | 'mentioned';

/** Related tickets one card lists at most (blockers first, then build-alongside, then the rest). */
export const SPRINT_RELATED_MAX = 16;

/** Is this related ticket a REAL blocker of the card — a blocking tracker link or a `depends_on`
 *  reference — that is not done? THE ONE rule the collapsed card's "Blocked by" group reads; it agrees
 *  with the Blocked issue (`foldStoryIssues`), which raises exactly these. */
export function isBlockingSprintRelation(r: { relation: SprintRelation; done: boolean | null }): boolean {
  return (r.relation === 'blocked_by' || r.relation === 'depends_on') && r.done !== true;
}

/** The collapsed card's three pill groups: "Blocked by" (`isBlockingSprintRelation`), "Coordinate with"
 *  (concurrent, not done), then "Related" (everything else, done ones muted), each in list order. */
export function sprintRelatedGroups<T extends { relation: SprintRelation; done: boolean | null }>(
  related: readonly T[],
): { blockedBy: T[]; coordinate: T[]; related: T[] } {
  const blockedBy = related.filter(isBlockingSprintRelation);
  const coordinate = related.filter((r) => r.relation === 'concurrent' && r.done !== true);
  return { blockedBy, coordinate, related: related.filter((r) => !blockedBy.includes(r) && !coordinate.includes(r)) };
}

export interface SprintRelatedTicket {
  /** shared `trackerTicketIdent` — opens the ticket tab. */
  ident: string;
  key: string;
  /** From the stored link or a stored ticket row; null when nothing stored names it. */
  title: string | null;
  status: string | null;
  relation: SprintRelation;
  /** The status category is done; null when not known. */
  done: boolean | null;
  /** The tracker's browse link (https; render through `safeExternalUrl`). */
  url: string | null;
}

export interface SprintTicketRow {
  /** shared `trackerTicketIdent`. */
  ident: string;
  key: string;
  title: string;
  /** Browse URL — render through `safeExternalUrl`. */
  url: string | null;
  provider: TrackerProvider;
  /** = `sprintPhaseOfStage(stage)`. */
  phase: SprintPhase;
  /** Where the layout lists it (`statusLayout`). Done tickets are listed too, last. */
  stage: SprintStage;
  status: { name: string; category: JiraStatusCategory | null } | null;
  issueType: string | null;
  assignee: { name: string; avatarUrl: string | null } | null;
  epic: { key: string; title: string | null } | null;
  /** The ticket's text (capped at SPRINT_TEXT_MAX) — the "before" of the editable view. */
  description: string;
  acceptanceCriteria: string;
  acField: { id: string; name: string } | null;
  /** The numbered criteria (`extractCriteria`), in order. */
  criteria: { items: string[]; source: StoryCriteriaSource };
  labels: SprintLabelState;
  /** The CHIP issues (`STORY_CHIP_ISSUE_IDS`: unclear_done, blocked) of `foldStoryIssues`, filtered by
   *  the workspace's checks (`applyStoryIssueChecks`), in STORY_ISSUES order; ≤ 2. [] for a ticket
   *  whose type the checks do not cover. Never spec_gaps. */
  issues: StoryIssue[];
  /** The CURRENT label's spec gaps (≤ STORY_SPEC_GAPS_MAX). [] when there is no current label, the
   *  "Spec gaps" check is off, or the type is not checked. The opened card shows at most ONE of them,
   *  on a not-started ticket only (`sprintSpecGapLines`). */
  specGaps: StorySpecGap[];
  /** = `issues.length` — the within-phase sort key (spec gaps do not count). */
  flagCount: number;
  /** Every ANCHORED FINDING on the ticket (`SprintFinding`), built server-side: code's "no criteria",
   *  the open linked/named blockers, the CURRENT label's criteria / dependencies / gaps (≤ 3 gaps,
   *  every stage) and a CURRENT assessment's findings, all filtered by the workspace's checks. In
   *  STORY_ISSUES order, code before Claude within an issue. */
  findings: SprintFinding[];
  /** Other tickets this one points at (`SprintRelatedTicket`): its stored tracker links first, then
   *  tickets its description / criteria link to or name, deduped, itself excluded, ≤ SPRINT_RELATED_MAX.
   *  Titles and statuses from STORED rows only — never a tracker call on a view. */
  related: SprintRelatedTicket[];
  /** PRs already on this ticket (stored `tracker_tickets`, via `ticketMembers`); [] for most. */
  pullRequests: StoryPrRef[];
  /** `accepted` = the reader's saved set, or — while the reader has NEVER saved one for this ticket —
   *  the CONFIDENT suggestions (≤ SPRINT_REPOS_PER_TICKET_MAX), with `defaulted: true`; "Check against
   *  code" uses the same effective set. A saved set (even an empty one) always wins. `suggested` = the
   *  suggestions NOT in `accepted` (the picker tags them "suggested"). */
  repos: { accepted: SprintRepoRef[]; suggested: SprintRepoSuggestion[]; defaulted: boolean };
  /** The latest assessment of any status, with its currency. */
  assessment: { record: SprintAssessmentRecord; currency: SprintAssessmentCurrency } | null;
  /** = `sprintReplaceTarget(provider, acField)`: where the ticket keeps its criteria — its own field
   *  (editable beside the description) or the description. */
  replaceTarget: SprintReplaceTarget;
  /** Per editable field, the base a write is checked against. `acceptanceCriteria` is null unless the
   *  criteria live in a field of their own (`replaceTarget.kind === 'ac_field'`). */
  replaceBases: { description: SprintReplaceBase; acceptanceCriteria: SprintReplaceBase | null };
  /** The latest write to this ticket, any status. */
  lastWrite: SprintWriteRecord | null;
}

/** GET /api/sprint-stories?workspace=<id> — Pro (402 before any DB work). Stamps the workspace as
 *  VIEWED, which is what makes the worker read its sprint at all (`SPRINT_VIEW_TTL_DAYS`). */
export interface SprintStoriesResponse {
  workspaceId: number;
  /** false = no tracker: everything else is empty and the page prints one sentence. */
  trackerOn: boolean;
  provider: TrackerProvider | null;
  /** null until the first read finished. */
  source: SprintSource | null;
  read: SprintReadState;
  /** By stage (SPRINT_STAGES order, Done last), then status section (layout order), then most flags,
   *  then key. */
  tickets: SprintTicketRow[];
  /** The sections. null when there is no tracker (`trackerOn: false`). */
  statusLayout: SprintStatusLayout | null;
  /** Tickets in the sprint whose stage is Done (they are listed too). */
  doneCount: number;
  /** `MeResponse.ai.enabled` on the server: labels and Assess exist. */
  aiEnabled: boolean;
  /** The workspace's repos, for the picker. */
  repos: SprintRepoRef[];
  /** The workspace's checks; `issues` on `tickets` are already filtered by them. */
  checks: SprintChecks;
  /** Issue type names on this sprint's tickets (open and done), sorted — the checks' type choices. */
  issueTypes: string[];
}

/** POST /api/sprint-stories/refresh {workspaceId} — read the sprint list now (bypasses the interval,
 *  not the backoff). 202 with the read state as it stands. */
export interface SprintRefreshResponse {
  workspaceId: number;
  read: SprintReadState;
}

// ── Anchored findings ────────────────────────────────────────────────────────────────────────────

/** One thing wrong with a ticket, anchored in its text when it can be. The SPA highlights `quote`
 *  (whitespace-normalised match within `where`); an unanchored finding (`quote: null`) shows as a pill.
 *  ⚠ `quote` is VERIFIED by the server against the ticket text (`verifyStoryQuote`) — never a guessed
 *  position. `brief` is TEMPLATED (`STORY_RULE_BY_ID[rule].label`); `detail` is the finding's own
 *  words (the labeller's reason, the blocker phrase, the gap, Claude's sentence). */
export interface SprintFinding {
  /** Stable within the ticket: "u-none", "u-c3" (criterion 3), "b-0", "g-1", "claude-2". */
  id: string;
  issue: StoryIssueId;
  rule: StoryRuleId;
  quote: string | null;
  where: StoryQuoteWhere | null;
  brief: string;
  detail: string;
  /** A rewrite of the quoted text — Claude only; null otherwise. */
  suggestion: string | null;
  source: 'code' | 'claude';
  ref: SprintCodeRef | null;
  /** Blocked findings from code: the blocker it is about. */
  blocker?: StoryBlocker;
}

/** A CURRENT body's first finding per issue — its sentence speaks for that issue in the bullets, the
 *  spec-gap line and the chips (`sprintIssuesWithClaude`). */
function claudeSentenceFor(body: SprintAssessmentBody | null, id: StoryIssueId): SprintAssessmentFinding | null {
  return body?.findings.find((f) => f.issue === id && f.text.trim() !== '') ?? null;
}

// ── Bullets and composers (pure; the SPA and tests share them) ──────────────────────────────────

/** One line of the expanded card: ≤ 2, one per chip issue (spec gaps have their own section). */
export interface SprintBullet {
  id: StoryIssueId;
  text: string;
  /** 'code' = the templated `storyIssueBullet`; 'claude' = the assessment's own sentence. */
  source: 'code' | 'claude';
  ref: SprintCodeRef | null;
}

/** The latest SUCCEEDED assessment body in the current format, or null. */
export function sprintAssessmentBodyOf(t: Pick<SprintTicketRow, 'assessment'>): SprintAssessmentBody | null {
  const r = t.assessment?.record;
  return r != null && r.status === 'succeeded' && !r.outdated ? r.body : null;
}

/** The latest succeeded body only while it is CURRENT (same ticket text, same commits, same format) —
 *  the one body allowed to speak for the ticket: its sentences in the bullets, its summary in the
 *  comment default and in Copy all. A stale body is shown on the card only, tagged out of date. */
export function sprintCurrentAssessmentBodyOf(
  t: Pick<SprintTicketRow, 'assessment'>,
): SprintAssessmentBody | null {
  return t.assessment?.currency === 'current' ? sprintAssessmentBodyOf(t) : null;
}

/** The ticket's CHIP issues: code's (already filtered by the checks) PLUS any chip issue a CURRENT
 *  "Check against code" run raised that code did not (reason 'claude', no criteria numbers), filtered
 *  by the same checks, in STORY_ISSUES order. The server builds `SprintTicketRow.issues` with it, so the
 *  chips, `flagCount`, the order and the bullets always name the same issues. A STALE run adds nothing.
 *  ⚠ A run's spec_gaps sentence is never a chip — it shows in the Spec gaps section
 *  (`sprintSpecGapLines`). */
export function sprintIssuesWithClaude(
  coded: readonly StoryIssue[],
  body: SprintAssessmentBody | null,
  checks: SprintChecks,
  issueType: string | null,
  total: number,
): StoryIssue[] {
  const out = coded.filter((x) => STORY_CHIP_ISSUE_IDS.includes(x.id));
  for (const c of body?.findings ?? []) {
    if (!isStoryIssueId(c.issue) || !STORY_CHIP_ISSUE_IDS.includes(c.issue)) continue;
    if (!out.some((x) => x.id === c.issue)) {
      out.push({ id: c.issue, criteria: [], blockers: [], gaps: [], total, reasons: ['claude'] });
    }
  }
  return applyStoryIssueChecks(out, checks, issueType).sort(
    (a, b) => STORY_ISSUE_BY_ID[a.id].order - STORY_ISSUE_BY_ID[b.id].order,
  );
}

/** THE bullet rule: one bullet per issue on the row (`t.issues` — code's plus a current run's, see
 *  `sprintIssuesWithClaude`), in STORY_ISSUES order; the CURRENT assessment's sentence for that id
 *  REPLACES the templated one. */
export function sprintBullets(
  t: Pick<SprintTicketRow, 'issues' | 'assessment' | 'issueType'>,
  checks: SprintChecks,
): SprintBullet[] {
  const body = sprintCurrentAssessmentBodyOf(t);
  // The server already filters `t.issues`; re-applying is idempotent and keeps this pure fold honest.
  const listed = applyStoryIssueChecks(t.issues, checks, t.issueType);
  const out: SprintBullet[] = [];
  for (const id of STORY_CHIP_ISSUE_IDS) {
    const issue = listed.find((x) => x.id === id);
    if (issue == null) continue;
    const c = claudeSentenceFor(body, id);
    if (c != null) out.push({ id, text: c.text, source: 'claude', ref: c.ref });
    else if (!(issue.reasons.length === 1 && issue.reasons[0] === 'claude')) {
      out.push({ id, text: storyIssueBullet(issue), source: 'code', ref: null });
    }
  }
  return out;
}

/** One line of the opened card's Spec gaps section. */
export interface SprintSpecGapLine {
  text: string;
  /** The gap's type (code's, from the label); null for Claude's sentence. */
  type: StorySpecGapType | null;
  /** 'code' = a labelled gap; 'claude' = a CURRENT "Check against code" run's spec_gaps sentence. */
  source: 'code' | 'claude';
  ref: SprintCodeRef | null;
}

/** THE Spec gaps section — ONE line at most, on a NOT-STARTED ticket only: a CURRENT run's spec_gaps
 *  sentence when there is one, else code's FIRST gap (`t.specGaps[0]`). [] on any other stage (the
 *  work is under way; a missing detail is a question for the person doing it, not for refinement),
 *  when the "Spec gaps" check is off, or when the ticket's type is not checked. The card, Copy all and
 *  the comment default all read this. 2026-10-11, the BNG review: three gaps on every card was the
 *  bulk of the page, and on tickets already in progress none of them was acted on. Pure. */
export function sprintSpecGapLines(
  t: Pick<SprintTicketRow, 'specGaps' | 'assessment' | 'issueType' | 'stage'>,
  checks: SprintChecks,
): SprintSpecGapLine[] {
  if (t.stage !== 'not_started') return [];
  if (checks.off.includes('spec_gaps') || !storyIssueTypeChecked(checks, t.issueType)) return [];
  const c = claudeSentenceFor(sprintCurrentAssessmentBodyOf(t), 'spec_gaps');
  if (c != null && c.text.trim() !== '') return [{ text: c.text, type: null, source: 'claude', ref: c.ref }];
  const g = (t.specGaps ?? [])[0];
  return g == null ? [] : [{ text: g.text, type: g.type, source: 'code', ref: null }];
}

/** One spec gap as plain text: "Edge case: No behaviour when the upload fails". */
export function sprintSpecGapText(g: Pick<SprintSpecGapLine, 'text' | 'type'>): string {
  const text = g.text.replace(/\s*\r?\n\s*/g, ' ').trim();
  return g.type != null ? `${STORY_SPEC_GAP_TYPE_LABEL[g.type]}: ${text}` : text;
}

/** The Spec gaps section as Markdown ("**Spec gaps**" then one bullet per gap); '' when empty. */
export function sprintSpecGapsMarkdown(gaps: readonly SprintSpecGapLine[]): string {
  if (gaps.length === 0) return '';
  const line = (g: SprintSpecGapLine): string =>
    `- ${sprintSpecGapText(g)}${g.ref != null ? ` (\`${g.ref.path}\` in \`${g.ref.repo}\`)` : ''}`;
  return `**Spec gaps**\n\n${gaps.map(line).join('\n')}`;
}

/** A criteria list as Markdown bullets. */
export function criteriaListMarkdown(items: readonly string[]): string {
  return items.map((c) => `- ${c}`).join('\n');
}

/** The default "Add as a comment" text: the summary (when a CURRENT assessment exists), the bullets,
 *  the Spec gaps section, and the revised criteria when there are any. Plain Markdown; the server
 *  converts it per provider. */
export function sprintCommentMarkdown(
  bullets: readonly SprintBullet[],
  body: SprintAssessmentBody | null,
  gaps: readonly SprintSpecGapLine[] = [],
): string {
  const parts: string[] = [];
  if (body != null && body.summary.trim() !== '') parts.push(body.summary.trim());
  if (bullets.length > 0) parts.push(bullets.map((b) => `- ${b.text}`).join('\n'));
  if (gaps.length > 0) parts.push(sprintSpecGapsMarkdown(gaps));
  if (body != null && body.revisedCriteria.length > 0) {
    parts.push(`**Proposed acceptance criteria**\n\n${criteriaListMarkdown(body.revisedCriteria)}`);
  }
  if (body != null && body.revisedDescription != null && body.revisedDescription.trim() !== '') {
    parts.push(`**Proposed description**\n\n${body.revisedDescription.trim()}`);
  }
  return parts.join('\n\n');
}
