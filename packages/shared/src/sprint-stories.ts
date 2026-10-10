import type { JiraStatusCategory, TrackerProvider } from './types.js';
import type { StoryCriteriaSource, StoryPrRef } from './stories.js';

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
//   • THE CHIPS are deterministic over the ticket text and its STORED story labels (the existing
//     `story_labels` rows, Haiku, `STORY_RUBRIC_VERSION`): a label chip appears only while the label
//     is CURRENT. The fix text on a chip is TEMPLATED here (`sprintChipFix`) — never model text.
//   • THE ASSESSMENT ("Assess with code") is a local-only Sonnet 5 agent run over read-only default
//     branch checkouts of the repos the reader ACCEPTED for the ticket. Its cited paths are VERIFIED
//     by the server against the checkout; an unverified path is DROPPED.
//   • THE WRITE-BACK writes exactly the text the reader confirmed, to ONE ticket, on ONE press. No
//     bulk, no automatic setting, no agent tool can write. Claimed before the write, never retried.
//
// ⚠ ORDER: Not started first, then In progress; within each, most flags first, then key. NEVER by
// assignee, and there is no team or person score anywhere on this surface.

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
  /** Criteria judged per run (the ticket's numbered criteria, in order). */
  criteria: 30,
  /** `landsIn` entries per criterion. */
  landsInPerCriterion: 8,
  /** Entries per gap list, per suggestion list. */
  listItems: 10,
  /** Parts a split may propose. */
  splitParts: 5,
  /** Characters, after trimming. Over-long text is cut (with "…"), never refused. */
  text: { short: 300, long: 1200, summary: 1500 },
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

// ── The chips ────────────────────────────────────────────────────────────────────────────────────

/** Where a chip came from: deterministic code, or a stored story label. Labelled apart on screen. */
export type SprintChipSource = 'code' | 'label';

export type SprintChipId =
  // code, story-level
  | 'no_criteria'
  | 'criteria_not_in_field'
  | 'user_value_missing'
  // label, criterion-level
  | 'criterion_not_testable'
  | 'criterion_bundled'
  | 'criterion_depends_on_other_work'
  // label, story-level
  | 'out_of_scope_missing'
  | 'dependency_not_named'
  | 'non_code_work';

export interface SprintChipMeta {
  id: SprintChipId;
  source: SprintChipSource;
  /** Chip text, plain English, ≤ 4 words. */
  label: string;
  /** criterion = one chip per flagged criterion (carries its text); story = one per ticket. */
  grain: 'criterion' | 'story';
}

export const SPRINT_CHIPS: Readonly<Record<SprintChipId, SprintChipMeta>> = {
  no_criteria: { id: 'no_criteria', source: 'code', label: 'No criteria', grain: 'story' },
  criteria_not_in_field: { id: 'criteria_not_in_field', source: 'code', label: 'Criteria not in field', grain: 'story' },
  user_value_missing: { id: 'user_value_missing', source: 'code', label: 'No user value', grain: 'story' },
  criterion_not_testable: { id: 'criterion_not_testable', source: 'label', label: 'Not testable', grain: 'criterion' },
  criterion_bundled: { id: 'criterion_bundled', source: 'label', label: 'More than one outcome', grain: 'criterion' },
  criterion_depends_on_other_work: {
    id: 'criterion_depends_on_other_work',
    source: 'label',
    label: 'Waits on other work',
    grain: 'criterion',
  },
  out_of_scope_missing: { id: 'out_of_scope_missing', source: 'label', label: 'No out of scope', grain: 'story' },
  dependency_not_named: { id: 'dependency_not_named', source: 'label', label: 'Dependency not named', grain: 'story' },
  non_code_work: { id: 'non_code_work', source: 'label', label: 'Work code cannot show', grain: 'story' },
};

/** Display order of chips on a card (and of fixes in "Copy all"). */
export const SPRINT_CHIP_ORDER: readonly SprintChipId[] = [
  'no_criteria',
  'criteria_not_in_field',
  'user_value_missing',
  'criterion_not_testable',
  'criterion_bundled',
  'criterion_depends_on_other_work',
  'dependency_not_named',
  'out_of_scope_missing',
  'non_code_work',
];

export interface SprintChip {
  id: SprintChipId;
  /** For a criterion chip: the 1-based number (= position in `extractCriteria`) and its text, AS
   *  JUDGED. null for a story chip. */
  criterion: { n: number; text: string } | null;
  /** The templated fix (`sprintChipFix`) — never model text. */
  fix: string;
}

/** THE ONE fix template per chip. Pure; the server fills `SprintChip.fix` with it. */
export function sprintChipFix(id: SprintChipId, criterion: { n: number; text: string } | null): string {
  const q = criterion != null ? `“${criterion.text}”` : '';
  switch (id) {
    case 'no_criteria':
      return 'Add acceptance criteria: a short list of outcomes a tester could check, one per line.';
    case 'criteria_not_in_field':
      return 'Move the acceptance criteria out of the description into the criteria field.';
    case 'user_value_missing':
      return 'Say who benefits and why, for example: “As a <role>, I want <goal>, so that <benefit>.”';
    case 'criterion_not_testable':
      return `Rewrite ${q} as an outcome someone could check: name the input, the action and the result they should see.`;
    case 'criterion_bundled':
      return `Split ${q} into separate criteria, one outcome each.`;
    case 'criterion_depends_on_other_work':
      return `Name the work ${q} waits on, link its ticket, and say what happens if it is late.`;
    case 'out_of_scope_missing':
      return 'Add an “Out of scope” line listing what this story will not do.';
    case 'dependency_not_named':
      return 'Name the other ticket or team this story depends on, and link it.';
    case 'non_code_work':
      return 'Split out the work code cannot show (sign-off, docs, config, comms) into its own task or a named criterion with an owner.';
  }
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

// ── The assessment ───────────────────────────────────────────────────────────────────────────────

/** Does the code already do what the criterion asks? */
export type SprintExisting = 'none' | 'partial' | 'full' | 'unclear';

export const SPRINT_EXISTING_LABEL: Record<SprintExisting, string> = {
  none: 'Not in the code yet',
  partial: 'Partly in the code',
  full: 'Already in the code',
  unclear: 'Unclear',
};

export interface SprintCodeRef {
  /** owner/name — one of the run's accepted repos. */
  repo: string;
  /** Repo-relative POSIX path, VERIFIED to exist in the checkout. */
  path: string;
  /** A function / class / route name the agent named; not verified. */
  symbol: string | null;
}

export interface SprintCriterionAssessment {
  /** 1-based, = the ticket's criterion number. */
  n: number;
  /** The criterion text as the agent was sent it. */
  criterion: string;
  testableAgainstCode: boolean;
  /** Where the change lands. Unverified paths were dropped (`dropped.paths`). */
  landsIn: SprintCodeRef[];
  existing: SprintExisting;
  /** One or two sentences on why. */
  note: string;
}

export interface SprintAssessmentGaps {
  unnamedDependencies: string[];
  unstatedBehaviourChanges: string[];
  dataOrMigrationImpact: string[];
  edgeCases: string[];
}

export const SPRINT_GAP_LABEL: Record<keyof SprintAssessmentGaps, string> = {
  unnamedDependencies: 'Dependencies not named',
  unstatedBehaviourChanges: 'Behaviour changes not stated',
  dataOrMigrationImpact: 'Data or migration impact',
  edgeCases: 'Edge cases',
};

export interface SprintAssessmentSuggestion {
  /** A better wording of criterion `n`. */
  rewrittenCriteria: Array<{ n: number; text: string }>;
  addedCriteria: string[];
  /** A proposed split, or null when the story is one piece of work. */
  split: Array<{ title: string; criteria: string[] }> | null;
  questionsForOwner: string[];
  summary: string;
}

/** Field names are the `submit_assessment` tool's, verbatim (after server validation). */
export interface SprintAssessmentBody {
  criteria: SprintCriterionAssessment[];
  gaps: SprintAssessmentGaps;
  suggestion: SprintAssessmentSuggestion;
}

/** What validation removed — stored, behind an ⓘ. */
export interface SprintAssessmentDropped {
  /** `landsIn` entries whose path does not exist in the checkout (or names an unaccepted repo). */
  paths: number;
  /** Criteria with an unknown `n`, empty items, items over a cap. */
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
  /** Set only on 'succeeded'. */
  body: SprintAssessmentBody | null;
  dropped: SprintAssessmentDropped | null;
  error: SprintAssessmentErrorCode | null;
  costUsd: number | null;
  numTurns: number | null;
  createdAt: string;
  completedAt: string | null;
}

/** 'current' = same ticket text and the same default-branch commits as the run read; 'stale' = the
 *  button reads "Re-assess". null for an unfinished or failed run. */
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

export type SprintAssessRefusal = 'busy' | 'no_repos' | 'no_ticket' | 'no_criteria' | 'bad_request';

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

export interface SprintTicketRow {
  /** shared `trackerTicketIdent`. */
  ident: string;
  key: string;
  title: string;
  /** Browse URL — render through `safeExternalUrl`. */
  url: string | null;
  provider: TrackerProvider;
  phase: SprintPhase;
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
  chips: SprintChip[];
  /** = `chips.length` — the within-phase sort key. */
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
  /** Not started first, then In progress; most flags first; then key. */
  tickets: SprintTicketRow[];
  /** Tickets in the sprint already done — counted, not listed. */
  doneCount: number;
  /** `MeResponse.ai.enabled` on the server: labels and Assess exist. */
  aiEnabled: boolean;
  /** The workspace's repos, for the picker. */
  repos: SprintRepoRef[];
}

/** POST /api/sprint-stories/refresh {workspaceId} — read the sprint list now (bypasses the interval,
 *  not the backoff). 202 with the read state as it stands. */
export interface SprintRefreshResponse {
  workspaceId: number;
  read: SprintReadState;
}

// ── Composers for copy and for the proposed update (pure; the SPA and tests share them) ──────────

/** The proposed criteria list as Markdown: rewritten criteria replace their originals in place,
 *  added ones follow. `original` = the ticket's numbered criteria. */
export function proposedCriteriaMarkdown(original: readonly string[], s: SprintAssessmentSuggestion): string {
  const rewritten = new Map(s.rewrittenCriteria.map((r) => [r.n, r.text]));
  const lines = original.map((c, i) => `- ${rewritten.get(i + 1) ?? c}`);
  for (const a of s.addedCriteria) lines.push(`- ${a}`);
  return lines.join('\n');
}

/** The default "Add as a comment" text: the proposal, the questions, and nothing the reader did not
 *  see. Plain Markdown; the server converts it per provider. */
export function sprintCommentMarkdown(original: readonly string[], body: SprintAssessmentBody): string {
  const parts: string[] = [];
  if (body.suggestion.summary.trim() !== '') parts.push(body.suggestion.summary.trim());
  parts.push(`**Proposed acceptance criteria**\n\n${proposedCriteriaMarkdown(original, body.suggestion)}`);
  if (body.suggestion.split != null && body.suggestion.split.length > 0) {
    parts.push(
      `**Proposed split**\n\n${body.suggestion.split
        .map((p) => `- ${p.title}${p.criteria.map((c) => `\n  - ${c}`).join('')}`)
        .join('\n')}`,
    );
  }
  if (body.suggestion.questionsForOwner.length > 0) {
    parts.push(`**Questions for the owner**\n\n${body.suggestion.questionsForOwner.map((q) => `- ${q}`).join('\n')}`);
  }
  return parts.join('\n\n');
}
