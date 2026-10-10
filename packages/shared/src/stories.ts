import type {
  ClaudeTicketAlignment,
  ReportingWindowInfo,
  TrackerProvider,
} from './types.js';

// ── REPORTS → STORIES ───────────────────────────────────────────────────────────────────────────
//
// How well the team's TICKETS were written, judged from what was merged for them. Pro with the rest
// of Reports (`periodReports`): every core route here 402s like GET /api/merged-prs.
//
//   • THE POPULATION is every tracker ticket (ident through the ONE `trackerTicketIdent` fold) with
//     at least one pull request MERGED in the window. Nothing else.
//   • THE TWO LISTS are server-ordered ident lists over `stories`, so the order is decided once.
//   • THE STORY REPORT (below) is ONE agentic report across 10-20 stories picked BY CODE — core,
//     local-only, Haiku 5.5. It REPLACED the plugin's per-story notes (deleted).
//
// ⚠ UNKNOWN IS NEVER ZERO: `linesChanged` / `files` are null when any pull request's size is unknown
// (`unsizedPrs` says how many), and such a story is listed under the size chart, never plotted at 0.

/** Where a story's criteria count came from. `review` = the latest ticket review's criteria list;
 *  `acceptance_criteria` = lines/bullets of the tracker's criteria field; `description_heading` =
 *  bullets under an "Acceptance criteria" heading in the description; `none` = nothing to count. */
export type StoryCriteriaSource = 'review' | 'acceptance_criteria' | 'description_heading' | 'none';

export const STORY_CRITERIA_SOURCE_LABEL: Record<StoryCriteriaSource, string> = {
  review: 'From the review',
  acceptance_criteria: 'From the ticket’s criteria',
  description_heading: 'From the description',
  none: 'No criteria found',
};

/** A pull request on the story, for the row's links. */
export interface StoryPrRef {
  prId: number;
  repoFullName: string;
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  /** ISO-8601; null unless merged. */
  mergedAt: string | null;
  githubUrl: string;
}

/** The latest SUCCEEDED ticket review of the story (any age), folded to counts. */
export interface StoryReviewSummary {
  /** `ticket_reviews.id` — the SPA can open it. */
  id: number;
  alignment: ClaudeTicketAlignment;
  met: number;
  partlyMet: number;
  notMet: number;
  unclear: number;
  notChecked: number;
  /** Criteria the review listed (= `criteria.length` of its assessment). */
  total: number;
  /** `assessment.missing.length` — asked for, delivered by no PR. */
  missing: number;
  /** ISO-8601 — when the run finished. */
  checkedAt: string | null;
}

export interface StoryRow {
  /** `<provider>:<root>#<KEY>` — shared `trackerTicketIdent`, never a second fold. */
  ident: string;
  key: string;
  title: string | null;
  /** The tracker's browse URL (render through `safeExternalUrl`). */
  url: string | null;
  provider: TrackerProvider;
  /** Every PR on the ticket (this account, any workspace — `ticketMembers`), and how many of them
   *  merged inside the window. `total = open + merged + closed`. */
  prs: { total: number; open: number; merged: number; closed: number; mergedInWindow: number };
  /** At most `STORY_PR_REFS_MAX`, merged first (newest merge first), then open. */
  pullRequests: StoryPrRef[];
  /** ISO-8601: the earliest `openedAt` of any PR on the ticket, and the latest `mergedAt`. */
  firstOpenedAt: string;
  lastMergedAt: string;
  /** First PR opened → last PR merged, in the workspace's WORKING hours (`buildWorkingCalendar` over
   *  `getResolvedFlowSettings`, as Chronology does) and in clock hours. Raw hours; the SPA formats. */
  workingHours: number;
  clockHours: number;
  /** Σ (additions + deletions) over every MERGED PR on the ticket. null when ANY of them has an
   *  unknown size — never a partial sum, never zero. */
  linesChanged: number | null;
  /** Σ changed files over the same PRs; null under the same rule. */
  files: number | null;
  /** How many merged PRs have no known size (0 when `linesChanged` is a number). */
  unsizedPrs: number;
  /** null when `source === 'none'`. */
  criteria: { count: number | null; source: StoryCriteriaSource };
  /** The latest succeeded ticket review, or null (never reviewed — e.g. every story in cloud). */
  review: StoryReviewSummary | null;
  /** `review.notMet + review.partlyMet + review.missing`; 0 with no review. */
  unmetCount: number;
}

/** GET /api/stories?workspace=<id> — core, Pro on `periodReports` (402 before any DB work). */
export interface StoriesResponse {
  workspaceId: number;
  window: ReportingWindowInfo;
  /** false = the workspace has no tracker: `stories` is [] and the SPA prints one sentence. */
  trackerOn: boolean;
  /** Working hours in one working day under this workspace's calendar (for "N working days"). */
  workingDayHours: number;
  /** Every story in the population, newest `lastMergedAt` first. */
  stories: StoryRow[];
  /** Reviewed stories whose latest review is not 'aligned' OR has any not_met / partly_met / missing
   *  item — idents, `unmetCount` desc, then `lastMergedAt` desc. */
  shortfall: string[];
  /** Stories with no succeeded ticket review — idents, `lastMergedAt` desc. */
  unchecked: string[];
  /** The population hit `STORIES_MAX`: the newest `stories.length` are listed and the page says so. */
  truncated: boolean;
}

export const STORIES_MAX = 200;
export const STORY_PR_REFS_MAX = 30;
/** Chart (a) "Time and pull requests": rows shown, the rest stated as "N more not shown". */
export const STORY_TIME_CHART_ROWS = 15;

// ── THE STORY REPORT (core, agentic, local-only, Pro on `periodReports`) ────────────────────────
//
// ONE report across 10-20 stories, written by a read-only multi-step agent (Haiku 5.5) for an
// engineering manager to take upstairs: what the team does well when writing stories, where they fall
// short, and what to try next sprint.
//
//   • CODE PICKS THE STORIES (`db/story-selection.ts`): four groups with caps, each pick carrying
//     code-written `whyPicked` reasons. The agent may drop a weak example, never add one.
//   • CODE WRITES THE FIGURES (`StoryReportPopulation`), over the WHOLE window. The picks are a
//     hand-picked sample, so the agent is told never to state a rate from them; the SPA prints the
//     figures in their own row, apart from the model's text (model-derived vs code-derived figures are
//     LABELLED APART).
//   • THE SERVER VALIDATES what the agent submits (`StoryReportBody`): every ticket key must be a
//     picked candidate's key, enums enforced, text trimmed + capped, arrays capped. A report with no
//     headline or summary after validation is a FAILED run.
//   • LOCAL-ONLY like every agentic feature: the routes register ONLY through
//     `registerAgenticRoutes` (its explicit `isCloud` check), and the SPA shows the controls only
//     when `MeResponse.ai.enabled`. Not entitled → 402.
//   • ONE STORED ROW PER RUN (`story_reports`); the LATEST per (workspace, window choice) is shown.
//     Currency is a server fingerprint; a stale report is SHOWN as stale, never re-run by itself.
//
// ⚠ Ticket references in the report are tracker KEYS (`BMD-123`, `owner/repo#12`), not idents: one
// workspace has ONE tracker site, so a key is unique inside a report, and it is what the agent read.

/** The window picker. 'reporting' = the workspace's reporting window (`getReportingWindow`: this
 *  sprint so far, else the trailing 14 days); the others are trailing day counts ending now. The SAME
 *  string on the URL (`?window=`), in the POST body and in `story_reports.window_choice`. */
export type StoryReportWindowChoice = 'reporting' | '30' | '60' | '90';

export const STORY_REPORT_WINDOW_CHOICES: readonly StoryReportWindowChoice[] = ['reporting', '30', '60', '90'];

/** The picker's default (a user decision): the last 60 days. */
export const STORY_REPORT_DEFAULT_WINDOW: StoryReportWindowChoice = '60';

/** Anything absent or unknown → the default. The ONE parser (route + SPA URL state). */
export function parseStoryReportWindow(raw: unknown): StoryReportWindowChoice {
  return typeof raw === 'string' && (STORY_REPORT_WINDOW_CHOICES as readonly string[]).includes(raw)
    ? (raw as StoryReportWindowChoice)
    : STORY_REPORT_DEFAULT_WINDOW;
}

/** Days of a trailing choice; null for 'reporting' (its length comes from the resolved window). */
export function storyReportWindowDays(choice: StoryReportWindowChoice): number | null {
  return choice === 'reporting' ? null : Number(choice);
}

/** The model this run uses — the ONE agentic run on Haiku (every other agentic run is Opus 5.5 /
 *  Sonnet 5). Shared so the SPA's "how it works" text names the same model. */
export const STORY_REPORT_MODEL = 'claude-haiku-5-5';

/** Why code picked a story. ⚠ A story with NO criteria (`criteria.source === 'none'`) is NEVER filed
 *  under 'fell_short': with nothing written to check against, its outcome is UNKNOWN, not bad. */
export type StoryReportGroup = 'done_well' | 'fell_short' | 'no_criteria' | 'outlier';

export const STORY_REPORT_GROUPS: readonly StoryReportGroup[] = ['done_well', 'fell_short', 'no_criteria', 'outlier'];

/** Picks per group (the prototype's caps). Total at most 19. */
export const STORY_REPORT_GROUP_CAPS: Readonly<Record<StoryReportGroup, number>> = {
  done_well: 6,
  fell_short: 6,
  no_criteria: 4,
  outlier: 3,
};

export const STORY_REPORT_MAX_CANDIDATES = 19;

export const STORY_REPORT_GROUP_LABEL: Record<StoryReportGroup, string> = {
  done_well: 'Done well',
  fell_short: 'Fell short',
  no_criteria: 'No criteria',
  outlier: 'Odd one out',
};

/** One story code picked for the report — exactly what the agent's `list_candidates` shows, as RAW
 *  values (the server formats durations for the agent; the SPA formats them for people). */
export interface StoryReportCandidate {
  ident: string;
  key: string;
  title: string | null;
  /** Tracker browse URL — render through `safeExternalUrl`. */
  url: string | null;
  provider: TrackerProvider;
  group: StoryReportGroup;
  /** Code-written reasons, plain English ("review: all 6 criteria met", "slow (top 5% for working
   *  time)"). Never model text. */
  whyPicked: string[];
  workingHours: number;
  /** = `StoryRow.prs.total`. */
  pullRequests: number;
  linesChanged: number | null;
  /** = `StoryRow.criteria`. */
  criteria: number | null;
  criteriaSource: StoryCriteriaSource;
  review: {
    alignment: ClaudeTicketAlignment;
    met: number;
    partlyMet: number;
    notMet: number;
    missing: number;
  } | null;
}

/** Whole-window figures, computed by CODE over every story in the window (not the picks) — the ONLY
 *  numbers the agent may generalise from, and the report card's figures row. */
export interface StoryReportPopulation {
  storiesInWindow: number;
  /** `criteria.source === 'acceptance_criteria'` (the prototype's definition, verbatim). */
  withWrittenCriteria: number;
  /** `criteria.source === 'description_heading'`. */
  criteriaOnlyInDescription: number;
  /** `criteria.source === 'none'`. */
  noCriteriaFound: number;
  /** Stories with a succeeded ticket review. */
  checkedByTicketReview: number;
  /** Reviewed, `unmetCount === 0` and alignment 'aligned'. */
  checkedAndFullyMet: number;
  /** Reviewed, `unmetCount > 0` or alignment not 'aligned'. */
  checkedWithGaps: number;
  /** Working hours, first PR opened → last PR merged; `sorted[floor(n/2)]`. null when no stories. */
  medianWorkingHours: number | null;
  /** Working hours in one working day (to print "N working days"). */
  workingDayHours: number;
  /** The fold hit `STORIES_MAX`: the figures cover the newest `storiesInWindow` only. */
  truncated: boolean;
}

/** The span a report covers. For 'reporting', `reporting` carries the echo so the SPA names it
 *  through `reportingWindowShortTitle`; for a day choice it is null and the label is "Last N days". */
export interface StoryReportRange {
  choice: StoryReportWindowChoice;
  /** ISO-8601, half-open `[from, to)`; `to` is min(window end, now). */
  from: string;
  to: string;
  /** The window's full length in days. */
  days: number;
  reporting: ReportingWindowInfo | null;
}

// ---- The report body (as the agent submits it, AFTER server validation) ----

/** A point in "What we do well" / "Where stories fall short". */
export interface StoryReportPoint {
  title: string;
  detail: string;
  /** ≥ 1 candidate key; a point left with none after validation is dropped. */
  tickets: string[];
}

export type StoryReportTone = 'positive' | 'negative';

export interface StoryReportSpotlight {
  /** A candidate key; a spotlight on any other key is dropped. */
  ticket: string;
  tone: StoryReportTone;
  headline: string;
  detail: string;
}

export interface StoryReportTheme {
  theme: string;
  detail: string;
  tickets: string[];
}

export interface StoryReportAction {
  action: string;
  why: string;
  tickets: string[];
}

export interface StoryReportLeftOut {
  ticket: string;
  reason: string;
}

/** Field names are the `submit_report` tool's, verbatim. */
export interface StoryReportBody {
  headline: string;
  summary: string;
  doingWell: StoryReportPoint[];
  fallingShort: StoryReportPoint[];
  spotlights: StoryReportSpotlight[];
  themes: StoryReportTheme[];
  actions: StoryReportAction[];
  /** Candidates the agent chose not to cover. */
  leftOut: StoryReportLeftOut[];
}

/** What validation removed — logged and stored, not narrated (an ⓘ may mention it). */
export interface StoryReportDropped {
  /** Ticket keys removed from lists because they were not candidates. */
  unknownTickets: number;
  /** Points / themes / actions left with no ticket, and spotlights on an unknown ticket. */
  items: number;
  /** Items cut by a cap: `STORY_REPORT_ITEMS_MAX` per section, `STORY_REPORT_MAX_CANDIDATES` for leftOut. */
  overCap: number;
}

// ---- Caps (the server's validator; the SPA never re-checks) ----

/** Per report section (doingWell, fallingShort, spotlights, themes, actions). `leftOut` is capped at
 *  `STORY_REPORT_MAX_CANDIDATES` — it lists skipped candidates, not report items. */
export const STORY_REPORT_ITEMS_MAX = 6;
/** Ticket keys per point / theme / action. */
export const STORY_REPORT_TICKETS_PER_ITEM_MAX = 8;
/** Characters, after trimming. Over-long text is cut (with "…"), never refused. */
export const STORY_REPORT_TEXT_MAX = {
  headline: 200,
  summary: 1200,
  /** title, theme, spotlight headline */
  title: 160,
  /** A next-sprint action is a full instruction, not a heading: the first live report's actions
   *  ran 170-260 characters and were cut mid-word at 160. */
  action: 400,
  /** detail, why */
  detail: 900,
  /** leftOut reason */
  reason: 300,
} as const;

// ---- The stored run ----

export type StoryReportStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Why a run failed. 'interrupted' = the server restarted mid-run (swept at boot). */
export type StoryReportErrorCode =
  | 'no_report' // the agent finished without calling submit_report
  | 'invalid_report' // no headline or summary left after validation
  | 'budget_exceeded'
  | 'max_turns'
  | 'no_candidates' // nothing to pick in the window by the time the run started
  | 'auth' // no Claude credential
  | 'runtime' // the AI runtime is not installed / failed to load
  | 'interrupted'
  | 'failed'; // anything else (the log has the detail; the wire never carries a stack)

export const STORY_REPORT_ERROR_LABEL: Record<StoryReportErrorCode, string> = {
  no_report: 'Claude finished without writing a report.',
  invalid_report: 'The report came back without a headline or summary.',
  budget_exceeded: 'The run hit its spending limit.',
  max_turns: 'The run took too many steps.',
  no_candidates: 'No stories to report on in this window.',
  auth: 'No Claude login or API key found.',
  runtime: 'The AI runtime is not set up.',
  interrupted: 'The server restarted during the run.',
  failed: 'The report could not be written.',
};

export interface StoryReportRecord {
  id: number;
  workspaceId: number;
  window: StoryReportWindowChoice;
  range: StoryReportRange;
  model: string;
  status: StoryReportStatus;
  /** The picks AS THEY WERE when the run started (stored; the report's keys resolve against these). */
  picked: StoryReportCandidate[];
  population: StoryReportPopulation;
  /** Set only on 'succeeded'. */
  report: StoryReportBody | null;
  dropped: StoryReportDropped | null;
  error: StoryReportErrorCode | null;
  /** Recorded for every finished run, local spend included (`recordAiUsage`, feature 'story_report'). */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  createdAt: string; // ISO-8601
  completedAt: string | null;
}

/** A pointer to the account's ONE in-flight run (any workspace / window). */
export interface StoryReportRunRef {
  id: number;
  workspaceId: number;
  window: StoryReportWindowChoice;
  status: 'queued' | 'running';
}

/** GET /api/story-reports?workspace=<id>&window=<choice> — free read (no model), Pro on
 *  `periodReports`, local-only. The candidates and figures are computed NOW by code (cheap), so the
 *  card can say what a new report would cover before anybody presses the button. */
export interface StoryReportsResponse {
  workspaceId: number;
  window: StoryReportWindowChoice;
  range: StoryReportRange;
  /** false = no tracker on the workspace: no candidates, the SPA hides "Write report". */
  trackerOn: boolean;
  /** The latest run of ANY status for (workspace, window), or null. */
  latest: StoryReportRecord | null;
  /** The latest SUCCEEDED run for (workspace, window) — what the card renders — or null. Same object
   *  as `latest` when the latest run succeeded. */
  report: StoryReportRecord | null;
  /** `report`'s stored fingerprint vs today's; null when `report` is null. */
  currency: 'current' | 'stale' | null;
  /** The account's in-flight run, or null. */
  running: StoryReportRunRef | null;
  /** What a run started now would pick (code only). */
  candidates: StoryReportCandidate[];
  population: StoryReportPopulation;
}

/** POST /api/story-reports — the ONLY path that runs the model. */
export interface StartStoryReportBody {
  workspaceId: number;
  window: StoryReportWindowChoice;
}

/** 202 with the queued run. Refusals are HTTP errors with `StoryReportErrorBody`:
 *  409 'busy' (the account already has a run in flight; `runningId` set), 400 'no_tracker',
 *  422 'no_candidates', 402 not entitled. */
export interface StartStoryReportResponse {
  report: StoryReportRecord;
}

export type StoryReportRefusal = 'busy' | 'no_tracker' | 'no_candidates';

export interface StoryReportErrorBody {
  error: StoryReportRefusal | string;
  message: string;
  runningId?: number;
}

/** GET /api/story-reports/:id and POST /api/story-reports/:id/cancel. Another account's id → 404. */
export interface StoryReportResponse {
  report: StoryReportRecord;
  /** Only meaningful once succeeded; null otherwise. */
  currency: 'current' | 'stale' | null;
}
