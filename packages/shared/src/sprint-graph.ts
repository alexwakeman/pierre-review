import type { AiProviderId, CiStatus, JiraStatusCategory, TrackerProvider } from './types.js';
import type { StoryReferenceRelation } from './story-health.js';
import type { SprintNodeBuild } from './story-build.js';
import type {
  SprintReadState,
  SprintSource,
  SprintStage,
  SprintStatusLayout,
} from './sprint-stories.js';

// REPORTS → THIS SPRINT AS A GRAPH — the wire contract (docs/API.md § This sprint; docs/TRACKERS.md §
// The sprint list read → Ghost chains; docs/CLAUDE-REVIEW.md § Sprint briefs). Pro with the rest of
// Reports (`periodReports`): every route 402s before any DB work.
//
//   GET  /api/sprint-graph?workspace=<id>                 → SprintGraphResponse    (DB only, stamps the view)
//   GET  /api/sprint-graph/token?workspace=<id>           → SprintGraphTokenResponse (DB only, stamps nothing)
//   GET  /api/ticket-story?workspace=<id>&ident=…         → TicketStoryResponse (ticket-prs.ts; DB only)
//   POST /api/sprint-graph/ask                            → SprintAskResponse      (Haiku, LOCAL ONLY)
//
//   • NODES are the sprint's tickets plus GHOSTS: tickets outside the sprint that a sprint ticket (or a
//     ghost) points at through an EDGE kind, read by the sprint read itself (≤ SPRINT_GHOST_DEPTH_MAX
//     hops, ≤ SPRINT_GHOST_MAX tickets). Never a tracker call on a view.
//   • EDGES come from two places: a BLOCKING tracker link (`source: 'tracker'`, kind `depends_on`) and
//     the ticket's BRIEF — Haiku's reading of which tickets the text names and how (`source: 'text'`,
//     the rubric-4 relation vocabulary). `out_of_scope` and `context` draw NO edge.
//     Direction is always FROM the ticket TO what it depends on / runs alongside / builds on / replaces.
//   • THE BRIEF (`SprintBrief`) is a cheap Haiku pass per ticket after each sprint read: a short
//     summary, the acceptance criteria ITEMISED one short sentence each (DERIVED from the description
//     when the ticket has none — `criteriaDerived`), and the references. Current while the ticket's
//     text hash and SPRINT_BRIEF_VERSION match; otherwise it is `pending` until the next pass.

/** Bumped when the brief's prompt or shape changes: every stored brief turns `pending`.
 *  2 (2026-10-12): the criteria cap 20 → 40 — real stories itemise past 20 and were cut.
 *  3 (2026-10-14): every reference — and every TRACKER link, now sent in the brief's input — carries
 *  `why`, one plain sentence on why the two tickets are tied.
 *  4 (2026-10-14): `why` must say what is needed or shared, never restate the relation (3's first run
 *  answered "Listed under Dependencies, so the story relies on it").
 *  5 (2026-10-20): `oneLiner`, one plain line (≤ SPRINT_BRIEF_CAPS.oneLiner) for the card face. */
export const SPRINT_BRIEF_VERSION = 5;

/** The brief's model (a user decision: the cheap one). */
export const SPRINT_BRIEF_MODEL = 'claude-haiku-5-5';

/** Tickets one brief pass sends at most (sprint tickets first, then ghosts by depth). */
export const SPRINT_BRIEF_RUN_CAP = 120;

/** The brief's caps — the server's validator; the SPA never re-checks. */
export const SPRINT_BRIEF_CAPS = {
  /** Characters: one or two sentences. */
  summary: 400,
  /** Characters: the card's one line. REQUIRED like `summary`: blank → refused, longer → refused
   *  (never cut), retried once in the pass. */
  oneLiner: 90,
  /** One criterion's sentence. */
  criterion: 200,
  /** Criteria one brief may itemise (real stories reach ~35). */
  criteria: 40,
  /** References one brief may name (rubric 4's cap). */
  references: 20,
  /** One `why` sentence (a reference's or a tracker link's). Longer → that `why` is DROPPED (null),
   *  never cut, and the rest of the brief stands. */
  why: 160,
} as const;

/** Ghost tickets a sprint holds at most, and the hops from the sprint a chain is followed. */
export const SPRINT_GHOST_MAX = 60;
export const SPRINT_GHOST_DEPTH_MAX = 3;

/** The edge kinds, strongest first. `depends_on` is drawn as a directed arrow, `concurrent` soft and
 *  dashed, `builds_on` / `supersedes` faint and thin. */
export type SprintEdgeKind = 'depends_on' | 'concurrent' | 'builds_on' | 'supersedes';
export const SPRINT_EDGE_KINDS: readonly SprintEdgeKind[] = ['depends_on', 'concurrent', 'builds_on', 'supersedes'];

export const SPRINT_EDGE_LABEL: Record<SprintEdgeKind, string> = {
  depends_on: 'Depends on',
  concurrent: 'Built alongside',
  builds_on: 'Builds on',
  supersedes: 'Replaces',
};

/** Is this reference relation one the graph draws? (`out_of_scope` / `context` draw no edge.) */
export function isSprintEdgeRelation(r: string): r is SprintEdgeKind {
  return (SPRINT_EDGE_KINDS as readonly string[]).includes(r);
}

// ── The brief ────────────────────────────────────────────────────────────────────────────────────

export interface SprintBriefCriterion {
  /** 1-based, in order. "Check against code" numbers its checks by it. */
  n: number;
  /** One short sentence (≤ SPRINT_BRIEF_CAPS.criterion). */
  text: string;
}

/** One other ticket the text names, as the brief reads it. `quote` is VERIFIED against the ticket text
 *  (null when none was given or it did not hold). */
export interface SprintBriefReference {
  /** The key as the text spells it, canonicalised (`ABC-123`, `owner/repo#12`). */
  ticketKey: string;
  relation: StoryReferenceRelation;
  quote: string | null;
  /** One plain sentence (≤ SPRINT_BRIEF_CAPS.why) on why this ticket names that one — what it needs
   *  from it or shares with it. null when the text gives no reason. Always
   *  set by the server since SPRINT_BRIEF_VERSION 3; optional so older literals still type. */
  why?: string | null;
}

/** Why the ticket carries one of its TRACKER links (`TicketLinkBlocker`), as the brief reads the
 *  ticket text and the linked ticket's title. Only links the text gives a reason for are listed. */
export interface SprintBriefLinkReason {
  /** The linked ticket's key, as the tracker sent it. */
  ticketKey: string;
  why: string;
}

/** One entry of the stored `sprint_briefs.references_json`: a text reference, or (tagged `link: true`)
 *  a tracker link's reason. ONE column holds both, so the shape grew without a migration. */
export type SprintBriefStoredReference = SprintBriefReference | (SprintBriefLinkReason & { link: true });

export interface SprintBrief {
  /** One or two sentences: what the ticket delivers. */
  summary: string;
  /** One plain line (≤ SPRINT_BRIEF_CAPS.oneLiner) for the card face. Always set by the server since
   *  SPRINT_BRIEF_VERSION 5; optional so older literals still type. */
  oneLiner?: string | null;
  /** The acceptance criteria, itemised; [] only when the text gives nothing to derive from. */
  criteria: SprintBriefCriterion[];
  /** The ticket has no acceptance criteria of its own: these were derived from the description. */
  criteriaDerived: boolean;
  references: SprintBriefReference[];
  /** Why each tracker link is there, where the text says (a link with no entry: no reason given).
   *  Always set by the server; optional so older literals still type. */
  linkReasons?: SprintBriefLinkReason[];
  /** ISO-8601 of the pass that wrote it. */
  createdAt: string;
}

/** 'current' = a brief for today's text; 'pending' = none yet, or the text changed since (the next
 *  pass writes it); 'off' = briefs are not made here (cloud, AI disabled). */
export type SprintBriefState = 'current' | 'pending' | 'off';

// ── The graph ────────────────────────────────────────────────────────────────────────────────────

export interface SprintGraphPr {
  prId: number;
  number: number;
  /** owner/name */
  repoFullName: string;
  title: string;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  /** The synced head CI rollup; null when the PR carries none. */
  ciState: CiStatus | null;
  /** https://github.com/… */
  url: string;
  /** Who opened it on GitHub (`users`): the login and the profile's display name. null when the PR
   *  carries no author. The Members filter folds this person into a ticket assignee whose name is the
   *  same once spacing, case and punctuation are set aside (`sprintMembers`). `isBot` is the GLOBAL
   *  automation set (`users.isBot` ∪ GitHub's Bot type ∪ vendor logins); a bot is never a member. */
  author: { login: string; name: string | null; isBot: boolean } | null;
}

export interface SprintGraphNode {
  /** shared `trackerTicketIdent` — THE node id; edges name it. */
  ident: string;
  key: string;
  /** '' when never read (a ghost the tracker would not return). */
  title: string;
  /** Browse URL — render through `safeExternalUrl`. */
  url: string | null;
  provider: TrackerProvider;
  /** Outside the sprint, reached through an edge. */
  ghost: boolean;
  /** 0 = in the sprint; 1–SPRINT_GHOST_DEPTH_MAX = hops from the sprint. */
  depth: number;
  status: { name: string; category: JiraStatusCategory | null } | null;
  /** Its bucket's MEANING (`statusLayout`) — a ghost's status is placed by the same rule. null when
   *  its status is not known. */
  stage: SprintStage | null;
  /** The bucket its status sits in (`statusLayout.buckets`); null when its status is not known. */
  bucketId: string | null;
  /** The column it is drawn in (`statusLayout.columns`, one per bucket): its bucket, or — while the
   *  merge rule (`settings.mergedColumn`) is on, its bucket means Code review, and it has ≥ 1 merged
   *  pull request and none open (closed unmerged ones ignored) — the FIRST bucket meaning Product
   *  review. Computed ONCE, in the graph fold. `stage` and `bucketId` stay its status's. null when its
   *  status is not known. */
  column: string | null;
  issueType: string | null;
  assignee: { name: string; avatarUrl: string | null } | null;
  /** Sprint tickets only (a ghost's epic is not read). */
  epic: { key: string; title: string | null } | null;
  brief: {
    state: SprintBriefState;
    /** The CURRENT brief's summary; null otherwise. */
    summary: string | null;
    /** The CURRENT brief's one line (≤ SPRINT_BRIEF_CAPS.oneLiner); null otherwise. */
    oneLiner: string | null;
    /** The CURRENT brief's criteria count (0 when there is no current brief). */
    criteriaCount: number;
    criteriaDerived: boolean;
  };
  /** The latest SUCCEEDED ticket check (the ticket review, "Story check") of this ticket, from the DB;
   *  null when none ever succeeded, for a ghost, and whenever AI is off (cloud). */
  check: SprintTicketCheck | null;
  /** A ticket check of this ticket is queued or running now. */
  checkRunning: boolean;
  /** EVERY pull request on the ticket (open, merged and closed) in this workspace's repos, open first,
   *  then merged (newest first), then closed. */
  prs: SprintGraphPr[];
  /** Edges touching this node (in + out). The SPA sizes a node by the edges it DRAWS, not this. */
  degree: number;
  /** The sprint THEME this ticket was put in (`SprintGraphResponse.themes`); null for a ghost, and
   *  when no current theme pass covers it. */
  theme: string | null;
  /** "Will this ticket need code?" — asked ONLY of a sprint ticket in a Not started bucket with no pull
   *  request of any state (`sprintCodeAsked`); null / absent for every other ticket (a ticket with a
   *  pull request needs no guess). The SPA's "Needs code" filter reads it. */
  codeJudgement?: SprintCodeJudgement | null;
  /** "Implement story" (docs/STORY-BUILD.md): the ticket's latest OPEN build session, coarse (status +
   *  repository counts — it rides the change token). null when none is open, for a ghost, and whenever
   *  AI is off. Absent from an older server. The card's mark is `storyBuildMark(build)`; the Implement
   *  button's gate is `storyBuildOffered(node)`. */
  build?: SprintNodeBuild | null;
}

// ── "Needs code": the judgement on not-started tickets ──────────────────────────────────────────
//
// A cheap one-shot (the brief model) judges, after a sprint read, whether each NOT-STARTED sprint ticket
// with no pull request will most likely need code changes. Cached per ticket by a hash of its text
// (`sprint_code_judgements`), so it re-runs only when the text changes or this version moves.

/** Bumped when the judgement's prompt or shape changes: every stored judgement turns `pending`. */
export const SPRINT_CODE_JUDGE_VERSION = 1;
/** Tickets one call judges at most. */
export const SPRINT_CODE_JUDGE_BATCH = 12;
/** Tickets one pass judges at most. */
export const SPRINT_CODE_JUDGE_RUN_CAP = 60;
/** The reason's characters at most; longer → no reason (never cut). */
export const SPRINT_CODE_JUDGE_REASON_MAX = 120;

/** 'code' = likely needs code; 'no_code' = likely not (design, analysis, content, configuration…);
 *  'pending' = not judged for today's text yet; 'off' = AI is off here. */
export type SprintCodeJudgementState = 'code' | 'no_code' | 'pending' | 'off';

export interface SprintCodeJudgement {
  state: SprintCodeJudgementState;
  /** One short plain sentence (≤ SPRINT_CODE_JUDGE_REASON_MAX, no numerals); null when none. */
  reason: string | null;
}

/** Is this ticket one the judgement is asked about? A sprint ticket (never a ghost) whose bucket means
 *  Not started and that has no pull request of any state. Pure — the server's to-do list and the fold
 *  share it. */
export function sprintCodeAsked(n: { ghost: boolean; stage: SprintStage | null; prs: ReadonlyArray<unknown> }): boolean {
  return !n.ghost && n.stage === 'not_started' && n.prs.length === 0;
}

/** A ticket check's criteria verdicts (shared fold `criteriaCounts` over its stored assessment). Its
 *  criteria list is the CHECK's own itemisation of the ticket, so `total` may differ from the brief's
 *  `criteriaCount`. */
export interface SprintTicketCheck {
  met: number;
  partlyMet: number;
  notMet: number;
  /** Criteria the check could not settle (unclear or not checked). */
  unsettled: number;
  total: number;
  /** ISO-8601 of the run's completion. */
  checkedAt: string;
  /** A member PR was added, left, pushed or merged since that run (a DB-only compare of the run's
   *  stored members against the synced pull requests). ⚠ An edit to the ticket TEXT is not detected
   *  here — the Story check's own state says so. */
  stale: boolean;
}

/** Ticket checks a manual This Sprint refresh starts at most (tickets with ≥ 1 open or merged PR and
 *  no current check; never-checked first). */
export const SPRINT_REFRESH_TICKET_CHECKS = 3;

/** How often the SPA may poll `GET /api/sprint-graph/token` while This Sprint is on screen. */
export const SPRINT_CHANGE_TOKEN_POLL_MS = 60_000;

/** GET /api/sprint-graph/token?workspace=<id> — DB only. Stamps no view, kicks no read, records no
 *  "since you last looked" snapshot. Equals `SprintGraphResponse.changeToken` for the same stored
 *  state; a difference means the cards changed since the page loaded. */
export interface SprintGraphTokenResponse {
  workspaceId: number;
  changeToken: string;
}

export interface SprintGraphEdge {
  /** Node idents. Direction: `from` depends on / runs alongside / builds on / replaces `to`. */
  from: string;
  to: string;
  kind: SprintEdgeKind;
  /** 'tracker' = a blocking tracker link; 'text' = the brief's reading of the ticket text. When both
   *  say the same thing it is ONE edge, 'tracker'. */
  source: 'tracker' | 'text';
  /** The words that show it (a text edge's verified quote); null for a tracker link. */
  quote: string | null;
  /** The brief's one-sentence reason for the tie (`SprintBriefReference.why` /
   *  `SprintBriefLinkReason.why`); null when none was given. */
  why?: string | null;
}

/** GET /api/sprint-graph?workspace=<id> — Pro (402 before any DB work). DB ONLY. Stamps the workspace
 *  as VIEWED, which is what makes the worker read its sprint at all (`SPRINT_VIEW_TTL_DAYS`), and kicks
 *  a read that is due. */
export interface SprintGraphResponse {
  workspaceId: number;
  /** false = no tracker: everything else is empty and the page prints one sentence. */
  trackerOn: boolean;
  /** A hash of what the cards show (tickets, their statuses and columns, assignees, briefs' one-liners
   *  and counts, ticket checks, PR count/state/draft/CI, edges, the last read) — never anything
   *  clock-derived. `GET /api/sprint-graph/token` answers the same value for the same stored state. */
  changeToken: string;
  provider: TrackerProvider | null;
  /** null until the first read finished. */
  source: SprintSource | null;
  read: SprintReadState;
  /** The status buckets, their statuses and the drawn columns. null when there is no tracker. */
  statusLayout: SprintStatusLayout | null;
  /** Sprint tickets first (stage, then key), then ghosts (depth, then key). */
  nodes: SprintGraphNode[];
  /** Deduped per (from, to, kind); only between listed nodes. */
  edges: SprintGraphEdge[];
  /** More ghosts were reachable than SPRINT_GHOST_MAX. */
  ghostsTruncated: boolean;
  /** Briefs: how many nodes have a current one / are waiting for one. */
  briefs: { current: number; pending: number };
  /** `MeResponse.ai.enabled` on the server: briefs, the sprint builder and Ask exist. */
  aiEnabled: boolean;
  /** The sprint's THEMES (largest first), from the CURRENT theme pass; null when there is none (AI
   *  off, not run yet, or the sprint changed since and the next pass has not finished). */
  themes: SprintTheme[] | null;
  /** Which Claude passes are running for this workspace RIGHT NOW (in memory), for the status line.
   *  Briefs progress is `briefs` (current / pending); the builder's is `pathsStatus.state`. Absent on
   *  a response with no tracker. */
  passes?: { briefsRunning: boolean; themesRunning: boolean };
  /** The LAST critical paths the sprint builder wrote (any SPRINT_PATHS_VERSION), even when the sprint
   *  has moved since — the next pass replaces them (`pathsStatus.stale` says so); null when AI is off,
   *  the sprint is too small, or none have been written. */
  paths: SprintPaths | null;
  /** Where the sprint builder stands for TODAY's sprint (db/sprint-paths.ts `sprintPathsStatusOf`). */
  pathsStatus: SprintPathsStatus;
  /** CODE's pace facts (db/sprint-paths.ts `sprintPaceOf`), free, no model. null with no tracker. */
  pace: SprintPace | null;
  /** One entry per distinct sprint ASSIGNEE (db/sprint-paths.ts `sprintPeopleOf`), alphabetical.
   *  [] with no tracker or no assigned ticket. */
  people: SprintPerson[];
  /** The current sprint's dates — the TRACKER's own (Jira sprint, Linear cycle, GitHub milestone due
   *  date; stored on `sprint_reads` by the read), else the workspace's sprint cadence (reporting-window
   *  mode 'sprint'); null when neither gives any. Day counts: `sprintDayOf`. */
  sprintDates: SprintDates | null;
  /** Limn's CODE-WRITTEN cards (`SprintSignal`; db/sprint-signals.ts), free, from the DB only — in
   *  order: since you last looked, pace, out of step, blocked outside the sprint. Each is omitted when it has nothing to say; [] with no tracker. */
  signals: SprintSignal[];
}

// ── Limn's code-written cards ────────────────────────────────────────────────────────────────────
//
// Four cards Limn writes itself (templated sentences, digits, no model, free on every tier), computed
// on every GET /api/sprint-graph from what is stored (db/sprint-signals.ts). Each carries the idents it
// is about; the Critical path view draws them as call-outs (pace excepted: that is the pace strip), each
// ticket key a button that opens its story view.
//   • 'since_last'      — what moved since the reader's previous visit (stage changes, tickets added,
//                         pull requests merged), against a per-(account, workspace) BASELINE snapshot
//                         rolled forward only after a gap of SPRINT_VISIT_GAP_MS between views.
//   • 'pace'            — the share of the sprint's days gone beside the share of its tickets complete.
//   • 'out_of_step'     — the tracker's stage disagrees with the code (Code review with no open pull
//                         request — merged code or none at all, said apart, merged code only when
//                         the merge rule did not move it to Product review; Complete with one
//                         still open; Not started with one open).
//   • 'blocked_outside' — sprint tickets waiting on an unfinished ticket outside the sprint.

/** A new VISIT starts after this long without a view: the previous visit's last snapshot becomes the
 *  baseline "Since you last looked" compares against. Background refetches (every few seconds) never
 *  roll it. */
export const SPRINT_VISIT_GAP_MS = 30 * 60_000;

export type SprintSignalKind = 'since_last' | 'pace' | 'out_of_step' | 'blocked_outside';

export interface SprintSignal {
  kind: SprintSignalKind;
  title: string;
  sentence: string;
  /** The node idents it is about — drawn as ticket-key buttons. */
  idents: string[];
}

/** The card's visible label. */
export const SPRINT_SIGNAL_LABEL: Record<SprintSignalKind, string> = {
  since_last: 'Since you last looked',
  pace: 'Pace',
  out_of_step: 'Out of step',
  blocked_outside: 'Blocked outside the sprint',
};

/** The sprint's dates. Either end may be missing (a GitHub milestone has only a due date). */
export interface SprintDates {
  /** ISO-8601 instants. */
  startsAt: string | null;
  endsAt: string | null;
  /** 'tracker' = the tracker's own sprint; 'cadence' = the workspace's sprint cadence. */
  source: 'tracker' | 'cadence';
}

/** Where `nowMs` sits in a sprint, in WHOLE days counted from its start instant: `day` is the day you
 *  are in (1-based, clamped to the sprint), `days` its length (a part day counts; at least 1), `daysLeft` the days
 *  after today. null when the window is not a real span. The ONE day count: the pace, the code cards
 *  and the page header all use it. Pure. */
export function sprintDayOf(startMs: number, endMs: number, nowMs: number): { day: number; days: number; daysLeft: number } | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  // A part day counts as a day (Jira's "Oct 14 10:15 → Oct 27 17:00" is 14 days, not 13); a sliver over
  // a whole number of days (an end a few minutes late) does not.
  const days = Math.max(1, Math.ceil((endMs - startMs) / 86_400_000 - 0.05));
  const day = Math.min(days, Math.max(1, Math.floor((nowMs - startMs) / 86_400_000) + 1));
  return { day, days, daysLeft: days - day };
}

// ── Themes ───────────────────────────────────────────────────────────────────────────────────────
//
// ONE sprint-wide Haiku call (review/sprint-themes/, LOCAL + aiEnabled) after the brief pass names 3–8
// short shared THEMES over the sprint tickets' titles + brief summaries, writes each a one-to-two
// sentence SUMMARY (what the work is and whether it is development work; NO figures — progress is
// counted by code, `sprintLaneSummary`), and puts each ticket in exactly one. Stored per (account,
// workspace) with an INPUT HASH (keys + summaries) and SPRINT_THEME_VERSION; it runs again only when
// that hash changes. The SPA lays the Theme view out by it (one lane per theme).

/** Bumped when the theme prompt or shape changes: the stored themes stop counting. 2 = summaries. */
export const SPRINT_THEME_VERSION = 2;

export const SPRINT_THEME_CAPS = {
  /** Themes one pass may name (after empty ones are dropped). */
  minThemes: 3,
  maxThemes: 8,
  /** A theme name's words and characters. */
  nameWords: 4,
  nameChars: 40,
  /** A sprint with fewer tickets is not themed (nothing to group). */
  minTickets: 6,
  /** A theme summary's characters. Longer, or carrying a digit, and the summary is dropped (null). */
  summaryChars: 240,
} as const;

export interface SprintTheme {
  name: string;
  /** One or two plain sentences: what the work is and whether it is development work. Model-written,
   *  never a figure. null when the pass gave none (or a stored pre-summary row). */
  summary: string | null;
}

// ── The sprint builder: critical paths ───────────────────────────────────────────────────────────
//
// ONE agentic Sonnet 5 run per sprint (review/sprint-paths/, LOCAL + aiEnabled) after the theme pass:
// up to SPRINT_PATHS_CAPS.maxPaths CRITICAL PATHS ranked by risk to the sprint (each an ordered list of
// ticket keys, a short title, one sentence of advice and a risk level) and up to
// SPRINT_PATHS_CAPS.maxCallouts CALL-OUTS (a short title and the tickets it is about). ⚠ CODE owns every
// ticket, column and number: the model reads a code-built, nonce-fenced map (db/sprint-paths.ts
// `sprintPathsInput`), may name only the keys it listed, and its titles and advice carry NO digit at all
// (the D4 gate, review/sprint-paths/validate.ts). Stored per (account, workspace) in `sprint_paths` with
// an INPUT HASH over everything it was sent except the now-derived day facts + SPRINT_PATHS_VERSION.

/** The sprint builder's model. */
export const SPRINT_PATHS_MODEL = 'claude-sonnet-5';

/** Bumped when the builder's prompt, input or answer shape changes: the stored paths stop counting
 *  (still shown, marked stale, until the next pass replaces them). */
export const SPRINT_PATHS_VERSION = 2;

export const SPRINT_PATHS_CAPS = {
  /** A sprint with fewer tickets gets no paths. */
  minTickets: 4,
  maxPaths: 5,
  maxCallouts: 3,
  /** A path's or call-out's title (characters). */
  titleChars: 40,
  /** A path's one sentence of advice (characters). */
  adviceChars: 200,
  /** Tickets one path may list. */
  pathTickets: 12,
  /** Tickets one call-out may list. */
  calloutTickets: 20,
  /** `submit_paths` calls one run may make (a refusal answers with what to fix). */
  maxSubmits: 3,
} as const;

/** Defaults of the env-only knobs (config.ts): SPRINT_PATHS_DAILY_CAP — passes per workspace per UTC
 *  day; SPRINT_PATHS_BUDGET_USD — one pass's spend cap; SPRINT_PATHS_MAX_TURNS. */
export const SPRINT_PATHS_DAILY_CAP_DEFAULT = 12;
export const SPRINT_PATHS_BUDGET_USD_DEFAULT = 1;
export const SPRINT_PATHS_MAX_TURNS_DEFAULT = 8;

export type SprintPathRisk = 'high' | 'medium' | 'low';
export const SPRINT_PATH_RISKS: readonly SprintPathRisk[] = ['high', 'medium', 'low'];
export const SPRINT_PATH_RISK_LABEL: Record<SprintPathRisk, string> = {
  high: 'High risk',
  medium: 'Medium risk',
  low: 'Low risk',
};

export interface SprintPath {
  /** ≤ SPRINT_PATHS_CAPS.titleChars, no digits. */
  title: string;
  /** Ordered ticket keys (sprint or outside the sprint), as the input spelled them. */
  tickets: string[];
  /** The node idents of `tickets`, same order — resolved by CODE, never the model's. */
  idents: string[];
  /** One sentence, ≤ SPRINT_PATHS_CAPS.adviceChars, no digits. */
  advice: string;
  risk: SprintPathRisk;
}

export interface SprintCallout {
  title: string;
  tickets: string[];
  idents: string[];
}

export interface SprintPaths {
  /** Highest risk first (code sorts by `risk`, keeping the model's order within one level). */
  paths: SprintPath[];
  callouts: SprintCallout[];
  /** ISO-8601 of the pass that wrote them. */
  createdAt: string;
  // What ran it (docs/CODEX-PLAN.md Phase 4): the model id and its provider. Optional: an older
  // server or row omits them — read through `aiRunLabel(provider, model)`.
  model?: string | null;
  provider?: AiProviderId;
}

/** Why the last builder pass stored nothing. */
export type SprintPathsFailure = 'refused' | 'no_submit' | 'stopped' | 'daily_cap' | 'error';

/**
 * The builder for TODAY's input:
 *   • 'current' — the paths shown were written for today's input.
 *   • 'writing' — a pass is running now.
 *   • 'queued'  — a sprint read just finished; the pass runs after the summaries and themes.
 *   • 'waiting' — no pass yet for today's input; the next sprint read starts one.
 *   • 'failed'  — the pass for today's input stored nothing (`failure`); not retried until the input
 *                 changes ('daily_cap': not before the next UTC day).
 *   • 'none'    — no pass can run (AI off, no Claude credential, too few tickets).
 */
export type SprintPathsState = 'current' | 'writing' | 'queued' | 'waiting' | 'failed' | 'none';

export interface SprintPathsStatus {
  state: SprintPathsState;
  /** Paths are shown but were written for an older input (or an older SPRINT_PATHS_VERSION). */
  stale: boolean;
  /** ISO-8601 of the last pass that called Claude (stored or not); null = none recorded. */
  lastAttemptAt: string | null;
  failure: SprintPathsFailure | null;
}

/** The plain-English reason for a failed builder pass. `by`: the provider that ran it (default Claude). */
export function sprintPathsFailureText(f: SprintPathsFailure, by: 'Claude' | 'Codex' = 'Claude'): string {
  switch (f) {
    case 'refused':
      return `${by}’s answer did not pass Limn’s checks.`;
    case 'no_submit':
      return `${by} finished without an answer.`;
    case 'stopped':
      return `${by} ran out of turns or budget.`;
    case 'daily_cap':
      return 'Today’s limit is used up.';
    case 'error':
      return `The call to ${by} failed.`;
  }
}

/** THE PACE — counted by CODE from the same fold the page draws (db/sprint-paths.ts `sprintPaceOf`).
 *  Sprint tickets only (never an outside ticket). */
export interface SprintPace {
  /** The day the sprint is in (1-based, today counts) and its length (`sprintDayOf`); null with no
   *  real sprint window. */
  daysElapsed: number | null;
  daysTotal: number | null;
  /** round(100 × daysElapsed ÷ daysTotal); null with no real sprint window. */
  timeUsedPct: number | null;
  tickets: number;
  /** Not in a bucket meaning Complete (status unknown counts as live). */
  live: number;
  /** In a bucket meaning Complete. */
  done: number;
  /** Drawn in a Product review column: a status placed there, or moved there by the merge rule. */
  productReview: number;
  /** At least one merged pull request and none open, whatever the column. */
  codeMerged: number;
  /** `depends_on` edges from a live sprint ticket onto a ticket (sprint or outside) not Complete. */
  openDependencies: number;
  /** Dependency chains code found (two or more tickets, each link waiting on unfinished work). */
  chains: number;
}

/** One sprint assignee (shared `sprintMembers`, the Members filter's identity). */
export interface SprintPerson {
  /** The member's label (a real name where one is on offer). */
  name: string;
  /** The assignee names, as the tracker spells them, that are this person — what tickets carry. */
  names: string[];
  /** Open pull requests in this workspace's repos with an outstanding review request for this
   *  person's GitHub account(s) (`review_requests`, the same population as the People report's
   *  "reviews waiting"). null when the person has no GitHub account mapped — never 0. */
  reviewsWaiting: number | null;
}

// ── Ask Claude about this sprint ─────────────────────────────────────────────────────────────────

/** Conversation depth, COUNTING the live question: the server reads at most the newest
 *  SPRINT_ASK_MAX_TURNS − 1 prior pairs. */
export const SPRINT_ASK_MAX_TURNS = 10;
/** A question's longest spelling (characters); an answer carried back is re-capped too. */
export const SPRINT_ASK_QUESTION_MAX = 500;
export const SPRINT_ASK_ANSWER_MAX = 4000;

export interface SprintAskTurn {
  question: string;
  answer: string;
}

/** POST /api/sprint-graph/ask — LOCAL ONLY (registerAgenticRoutes), Pro. One Haiku completion grounded
 *  in the stored graph (nodes, edges, statuses, brief summaries; ticket text nonce-fenced). */
export interface SprintAskRequest {
  workspaceId: number;
  question: string;
  /** Prior turns of THIS conversation, oldest → newest. Older than the cap: dropped, counted. */
  history?: SprintAskTurn[];
}

export interface SprintAskResponse {
  workspaceId: number;
  /** Short markdown naming ticket keys. */
  answer: string;
  /** Prior turns dropped by the depth cap. */
  trimmedTurns: number;
  model: string;
  costUsd: number | null;
}
