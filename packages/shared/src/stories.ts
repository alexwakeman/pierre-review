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
//   • The agentic story report that headed this tab was REMOVED 2026-10-18 (its `story_reports`
//     table is dormant).
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
