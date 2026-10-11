import type { JiraStatusCategory, TrackerProvider } from './types.js';
import type { StoryCriteriaSource, StoryPrRef } from './stories.js';
import {
  STORY_ISSUE_CHECKS_DEFAULT,
  STORY_ISSUE_IDS,
  applyStoryIssueChecks,
  isStoryIssueId,
  storyIssueBullet,
  type StoryIssue,
  type StoryIssueChecks,
  type StoryIssueId,
} from './story-issues.js';

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
//     Haiku, `STORY_RUBRIC_VERSION`); a label half appears only while the label is CURRENT. Chip text
//     and bullets are TEMPLATED — never model text.
//   • THE SECTIONS follow the workspace's STATUS LAYOUT (`SprintStatusLayout`): Not started, then
//     "Writing code" (one section per status before the code-delivered status), then "Code delivered"
//     (one per status from it on). The order and the code-delivered status are AUTOMATIC (the tracker's
//     board / workflow order; PR evidence) unless the workspace overrides them (`SprintStatusSettings`).
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
  /** Characters, after trimming. Over-long text is cut (with "…"), never refused. */
  summary: 200,
  issueText: 220,
  criterionText: 200,
  /** One per issue id. */
  issues: 3,
  revisedCriteria: 12,
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
// A ticket's issues are the THREE story issues (`story-issues.ts`: `foldStoryIssues`, folded by the
// server from the criteria and the CURRENT stored label), filtered by the workspace's checks
// (`applyStoryIssueChecks`) — so `flagCount`, the order and Copy all agree with what is on screen.

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
  /** Strongest first. */
  reasons: SprintRepoReason[];
  /** Earlier merged PRs behind the history reasons (0 for a text-only reason). */
  prCount: number;
}

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
export const SPRINT_ASSESS_FORMAT_VERSION = 3;

export interface SprintCodeRef {
  /** owner/name — one of the run's accepted repos. */
  repo: string;
  /** Repo-relative POSIX path, VERIFIED to exist in the checkout. */
  path: string;
}

/** Claude's one sentence for one of the three issues, backed by the ticket or the code. "Blocked" must
 *  name WHAT it waits on and WHO; "Spec gaps" must name the missing detail. */
export interface SprintAssessmentIssue {
  id: StoryIssueId;
  /** One sentence, ≤ SPRINT_ASSESS_CAPS.issueText. */
  text: string;
  /** A verified file it rests on; null when none was cited or the path did not verify. */
  ref: SprintCodeRef | null;
}

/** Field names are the `submit_assessment` tool's (after server validation). */
export interface SprintAssessmentBody {
  /** The single most important finding, one sentence (e.g. "This may already be done: …"). */
  summary: string;
  /** At most one per issue id, at most 3, in STORY_ISSUES order. */
  issues: SprintAssessmentIssue[];
  /** A proposed criteria list (≤ 12), each ≤ SPRINT_ASSESS_CAPS.criterionText. [] = keep them. */
  revisedCriteria: string[];
}

/** What validation removed — stored, behind an ⓘ. */
export interface SprintAssessmentDropped {
  /** Cited paths that do not exist in the checkout (or name an unaccepted repo); the text is kept. */
  paths: number;
  /** Issues with an unknown or repeated id, empty items, items over a cap. */
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
  /** For 'replace': the target the dialog SHOWED. A server-side mismatch refuses `target_changed`. */
  target?: SprintReplaceTarget;
  /** For 'replace' (required there): the row's `replaceBase.hash` the dialog was built on. The server
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

export type SprintPhase = 'not_started' | 'in_progress';

export const SPRINT_PHASE_LABEL: Record<SprintPhase, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
};

// ── The status layout (sections by status) ───────────────────────────────────────────────────────
//
// Statuses are per PROJECT and per TRACKER, so nothing here hard-codes a status name. Two facts are
// worked out automatically and may each be OVERRIDDEN per workspace:
//
//   • THE ORDER — Jira: the board's column order (the sprint's `boardId` →
//     `/rest/agile/1.0/board/{id}/configuration`, status ids → names via `/rest/api/2/status`);
//     Linear: the team's workflow states (type, then `position`); GitHub Issues: Open, Closed. Stored
//     on `sprint_reads.status_order_json` by the sprint read. Unreadable → null, and the fallback is
//     the statuses on the tickets sorted by category (new → indeterminate → done), then name.
//   • "CODE DELIVERED FROM" — the FIRST in-progress (category `indeterminate`) status, in order, where
//     at least SPRINT_DELIVERED_MIN_SHARE of the tickets that have ≥ 1 pull request have ALL of them
//     merged and none open, with at least SPRINT_DELIVERED_MIN_TICKETS such tickets. The evidence is
//     the stored ticket rows joined to `pull_requests` (`SprintStatusEvidence`). None qualifies → null.
//
// A status NAME is matched case-insensitively (trimmed). An override names statuses; a status it does
// not name (new on the board since) keeps its AUTOMATIC position relative to its neighbours.
//
// ⚠ Category beats position: a `new` status is always Not started and a `done` one is always counted
// (never listed), wherever the order puts it. Only `indeterminate` (or unknown-category) statuses are
// split into "Writing code" / "Code delivered".

/** Share of PR-bearing tickets in a status that must be fully merged for it to read as delivered. */
export const SPRINT_DELIVERED_MIN_SHARE = 0.6;
/** Fully-merged tickets a status needs at least, for that share to count. */
export const SPRINT_DELIVERED_MIN_TICKETS = 2;
/** Statuses an override may list at most; a status name's longest spelling. */
export const SPRINT_STATUS_ORDER_MAX = 60;
export const SPRINT_STATUS_NAME_MAX = 100;

/** Where a ticket sits on the page. 'done' tickets are counted, never listed. */
export type SprintStage = 'not_started' | 'writing' | 'delivered' | 'done';

export const SPRINT_STAGE_LABEL: Record<Exclude<SprintStage, 'done'>, string> = {
  not_started: 'Not started',
  writing: 'Writing code',
  delivered: 'Code delivered',
};

/** The heading over the in-progress statuses when no code-delivered status is known (nothing splits). */
export const SPRINT_IN_PROGRESS_HEADING = 'In progress';

/** The automatic order as the sprint read stored it (`sprint_reads.status_order_json`). */
export interface SprintStatusAutoOrder {
  source: 'jira_board' | 'linear_states' | 'github';
  /** In board / workflow order. `id` is the tracker's status id when it has one. */
  statuses: Array<{ id: string | null; name: string; category: JiraStatusCategory | null }>;
  /** ISO-8601 of the read that produced it. */
  readAt: string;
}

/** The workspace's override (`workspaces.sprint_statuses`). OVERRIDES ONLY: a null half = automatic;
 *  both null is stored as NULL. Names are matched case-insensitively. */
export interface SprintStatusSettings {
  order: string[] | null;
  deliveredFrom: string | null;
}

export const SPRINT_STATUS_SETTINGS_DEFAULT: SprintStatusSettings = { order: null, deliveredFrom: null };

/** One status in the resolved order. */
export interface SprintStatusLayoutEntry {
  name: string;
  category: JiraStatusCategory | null;
  /** Listed (not done) tickets in this status right now; 0 for a known status with none. */
  count: number;
  /** Its position came from the automatic order (true) or the override (false). */
  auto: boolean;
  /** The stage tickets in this status are listed under. */
  stage: SprintStage;
}

/** Per in-progress status: the PR evidence behind "code delivered from". */
export interface SprintStatusEvidence {
  status: string;
  /** Tickets in this status with ≥ 1 pull request. */
  withPrs: number;
  /** …of which every pull request is merged and none is open. */
  allMerged: number;
}

export interface SprintStatusLayout {
  /** Every known status (automatic order ∪ statuses on the tickets ∪ the override's names), resolved
   *  order. The page renders a section per entry with `count > 0`. */
  order: SprintStatusLayoutEntry[];
  /** Where the order came from: the override, the tracker, or the category fallback. */
  orderSource: 'override' | SprintStatusAutoOrder['source'] | 'fallback';
  /** The effective code-delivered status (override, else automatic); null = nothing splits. */
  deliveredFrom: string | null;
  /** What the evidence says on its own (shown in the settings ⓘ and as the "Reset" target). */
  deliveredFromAuto: string | null;
  /** In order; in-progress statuses only. */
  evidence: SprintStatusEvidence[];
  /** The stored override (default when none). */
  settings: SprintStatusSettings;
}

/** PUT /api/sprint-stories/statuses — replace the workspace's override (Pro, `periodReports`; the
 *  `read` tier; scope via `resolveWorkspaceScope`). Strict: a non-array `order`, a name over
 *  SPRINT_STATUS_NAME_MAX, NUL / control characters, more than SPRINT_STATUS_ORDER_MAX names, or a
 *  `deliveredFrom` that is not a string or null → 400 and nothing is written. `{order: null,
 *  deliveredFrom: null}` = "Reset to automatic" (stored as NULL). */
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

export interface SprintTicketRow {
  /** shared `trackerTicketIdent`. */
  ident: string;
  key: string;
  title: string;
  /** Browse URL — render through `safeExternalUrl`. */
  url: string | null;
  provider: TrackerProvider;
  phase: SprintPhase;
  /** Where the layout lists it (`statusLayout`); never 'done' on a listed row. */
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
  /** `foldStoryIssues` filtered by the workspace's checks (`applyStoryIssueChecks`), in STORY_ISSUES
   *  order; ≤ 3. [] for a ticket whose type the checks do not cover. */
  issues: StoryIssue[];
  /** = `issues.length` — the within-phase sort key. */
  flagCount: number;
  /** PRs already on this ticket (stored `tracker_tickets`, via `ticketMembers`); [] for most. */
  pullRequests: StoryPrRef[];
  repos: { accepted: SprintRepoRef[]; suggested: SprintRepoSuggestion[] };
  /** The latest assessment of any status, with its currency. */
  assessment: { record: SprintAssessmentRecord; currency: SprintAssessmentCurrency } | null;
  /** = `sprintReplaceTarget(provider, acField)`. */
  replaceTarget: SprintReplaceTarget;
  /** The FULL stored text "Replace" would overwrite: its sha256 (sent back as `baseHash`), and whether
   *  the copy on the wire was cut (`SPRINT_TEXT_MAX`) — then Replace is not offered. */
  replaceBase: { hash: string; truncated: boolean };
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
  /** By stage, then status section (layout order), then most flags, then key. */
  tickets: SprintTicketRow[];
  /** The sections. null when there is no tracker (`trackerOn: false`). */
  statusLayout: SprintStatusLayout | null;
  /** Tickets in the sprint already done — counted, not listed. */
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

// ── Bullets and composers (pure; the SPA and tests share them) ──────────────────────────────────

/** One line of the expanded card: ≤ 3, one per issue. */
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

/** The ticket's issues: code's (already filtered by the checks) PLUS any issue a CURRENT "Check
 *  against code" run raised that code did not (reason 'claude', no criteria numbers), filtered by the
 *  same checks, in STORY_ISSUES order. The server builds `SprintTicketRow.issues` with it, so the
 *  chips, `flagCount`, the order and the bullets always name the same issues. A STALE run adds nothing. */
export function sprintIssuesWithClaude(
  coded: readonly StoryIssue[],
  body: SprintAssessmentBody | null,
  checks: SprintChecks,
  issueType: string | null,
  total: number,
): StoryIssue[] {
  const out = [...coded];
  for (const c of body?.issues ?? []) {
    if (!isStoryIssueId(c.id)) continue;
    if (!out.some((x) => x.id === c.id)) {
      out.push({ id: c.id, criteria: [], blockers: [], gaps: [], total, reasons: ['claude'] });
    }
  }
  return applyStoryIssueChecks(out, checks, issueType).sort(
    (a, b) => STORY_ISSUE_IDS.indexOf(a.id) - STORY_ISSUE_IDS.indexOf(b.id),
  );
}

/** THE bullet rule: one bullet per issue on the row (`t.issues` — code's plus a current run's, see
 *  `sprintIssuesWithClaude`), in STORY_ISSUES order; the CURRENT assessment's sentence for that id
 *  REPLACES the templated one. */
export function sprintBullets(
  t: Pick<SprintTicketRow, 'issues' | 'assessment' | 'issueType'>,
  checks: SprintChecks,
): SprintBullet[] {
  const claude = sprintCurrentAssessmentBodyOf(t)?.issues ?? [];
  // The server already filters `t.issues`; re-applying is idempotent and keeps this pure fold honest.
  const listed = applyStoryIssueChecks(t.issues, checks, t.issueType);
  const out: SprintBullet[] = [];
  for (const id of STORY_ISSUE_IDS) {
    const issue = listed.find((x) => x.id === id);
    if (issue == null) continue;
    const c = claude.find((x) => x.id === id);
    if (c != null) out.push({ id, text: c.text, source: 'claude', ref: c.ref });
    else if (!(issue.reasons.length === 1 && issue.reasons[0] === 'claude')) {
      out.push({ id, text: storyIssueBullet(issue), source: 'code', ref: null });
    }
  }
  return out;
}

/** A criteria list as Markdown bullets. */
export function criteriaListMarkdown(items: readonly string[]): string {
  return items.map((c) => `- ${c}`).join('\n');
}

/** The default "Add as a comment" text: the summary (when a CURRENT assessment exists), the bullets, and the revised
 *  criteria when there are any. Plain Markdown; the server converts it per provider. */
export function sprintCommentMarkdown(bullets: readonly SprintBullet[], body: SprintAssessmentBody | null): string {
  const parts: string[] = [];
  if (body != null && body.summary.trim() !== '') parts.push(body.summary.trim());
  if (bullets.length > 0) parts.push(bullets.map((b) => `- ${b.text}`).join('\n'));
  if (body != null && body.revisedCriteria.length > 0) {
    parts.push(`**Proposed acceptance criteria**\n\n${criteriaListMarkdown(body.revisedCriteria)}`);
  }
  return parts.join('\n\n');
}
