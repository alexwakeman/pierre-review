import type { CiStatus, JiraStatusCategory, TrackerProvider } from './types.js';
import type { StoryReferenceRelation } from './story-health.js';
import type { TicketPrsResponse } from './ticket-prs.js';
import type {
  SprintAssessmentCurrency,
  SprintAssessmentRecord,
  SprintReadState,
  SprintRepoRef,
  SprintRepoSuggestion,
  SprintSource,
  SprintStage,
  SprintStatusLayout,
} from './sprint-stories.js';

// REPORTS → THIS SPRINT AS A GRAPH — the wire contract (docs/API.md § This sprint; docs/TRACKERS.md §
// The sprint list read → Ghost chains; docs/CLAUDE-REVIEW.md § Sprint briefs). Pro with the rest of
// Reports (`periodReports`): every route 402s before any DB work.
//
//   GET  /api/sprint-graph?workspace=<id>                 → SprintGraphResponse    (DB only, stamps the view)
//   GET  /api/sprint-graph/ticket?workspace=<id>&ident=…  → SprintTicketDetailResponse (DB only)
//   POST /api/sprint-graph/ask                            → SprintAskResponse      (Haiku, LOCAL ONLY)
//
//   • NODES are the sprint's tickets plus GHOSTS: tickets outside the sprint that a sprint ticket (or a
//     ghost) points at through an EDGE kind, read by the sprint read itself (≤ SPRINT_GHOST_DEPTH_MAX
//     hops, ≤ SPRINT_GHOST_MAX tickets). Never a tracker call on a view.
//   • EDGES come from two places: a BLOCKING tracker link (`source: 'tracker'`, kind `depends_on`) and
//     the ticket's BRIEF — Haiku's reading of which tickets the text names and how (`source: 'text'`,
//     the rubric-4 relation vocabulary). `out_of_scope` and `context` draw NO edge (drawer only).
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
 *  answered "Listed under Dependencies, so the story relies on it"). */
export const SPRINT_BRIEF_VERSION = 4;

/** The brief's model (a user decision: the cheap one). */
export const SPRINT_BRIEF_MODEL = 'claude-haiku-5-5';

/** Tickets one brief pass sends at most (sprint tickets first, then ghosts by depth). */
export const SPRINT_BRIEF_RUN_CAP = 120;

/** The brief's caps — the server's validator; the SPA never re-checks. */
export const SPRINT_BRIEF_CAPS = {
  /** Characters: one or two sentences. */
  summary: 400,
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

/** Is this reference relation one the graph draws? (`out_of_scope` / `context` are drawer-only.) */
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
   *  from it or shares with it. null when the text gives no reason (the drawer then shows none). Always
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
  /** The four configured stages (`statusLayout`) — a ghost's status is placed by the same rule. null
   *  when its status is not known. */
  stage: SprintStage | null;
  issueType: string | null;
  assignee: { name: string; avatarUrl: string | null } | null;
  /** Sprint tickets only (a ghost's epic is not read). */
  epic: { key: string; title: string | null } | null;
  brief: {
    state: SprintBriefState;
    /** The CURRENT brief's summary; null otherwise. */
    summary: string | null;
    criteriaCount: number;
    criteriaDerived: boolean;
  };
  /** EVERY pull request on the ticket (open, merged and closed) in this workspace's repos, open first,
   *  then merged (newest first), then closed. */
  prs: SprintGraphPr[];
  /** Edges touching this node (in + out). The SPA sizes a node by the edges it DRAWS, not this. */
  degree: number;
  /** The sprint THEME this ticket was put in (`SprintGraphResponse.themes`); null for a ghost, and
   *  when no current theme pass covers it. */
  theme: string | null;
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
  provider: TrackerProvider | null;
  /** null until the first read finished. */
  source: SprintSource | null;
  read: SprintReadState;
  /** The four stages and their statuses. null when there is no tracker. */
  statusLayout: SprintStatusLayout | null;
  /** Sprint tickets first (stage, then key), then ghosts (depth, then key). */
  nodes: SprintGraphNode[];
  /** Deduped per (from, to, kind); only between listed nodes. */
  edges: SprintGraphEdge[];
  /** More ghosts were reachable than SPRINT_GHOST_MAX. */
  ghostsTruncated: boolean;
  /** Briefs: how many nodes have a current one / are waiting for one. */
  briefs: { current: number; pending: number };
  /** `MeResponse.ai.enabled` on the server: briefs, "Check against code" and Ask exist. */
  aiEnabled: boolean;
  /** The workspace's repos, for the picker. */
  repos: SprintRepoRef[];
  /** The sprint's THEMES (largest first), from the CURRENT theme pass; null when there is none (AI
   *  off, not run yet, or the sprint changed since and the next pass has not finished). */
  themes: SprintTheme[] | null;
  /** The LAST sprint STORY written (any SPRINT_STORY_VERSION), even when the sprint has moved since —
   *  the next pass replaces it (`storyStatus.stale` says so); null when AI is off, the sprint is too
   *  small for one, or none has been written. */
  story: SprintStory | null;
  /** Where the story pass stands for TODAY's sprint (db/sprint-story.ts `sprintStoryStatusOf`). */
  storyStatus: SprintStoryStatus;
  /** The current sprint's dates — the TRACKER's own (Jira sprint, Linear cycle, GitHub milestone due
   *  date; stored on `sprint_reads` by the read), else the workspace's sprint cadence (reporting-window
   *  mode 'sprint'); null when neither gives any. Day counts: `sprintDayOf`. */
  sprintDates: SprintDates | null;
  /** The strip's CODE-WRITTEN cards (`SprintSignal`; db/sprint-signals.ts), free, from the DB only — in
   *  strip order: since you last looked, pace, then (after the model's storylines) out of step, blocked
   *  outside the sprint. Each is omitted when it has nothing to say; [] with no tracker. */
  signals: SprintSignal[];
}

// ── The strip's code-written cards ───────────────────────────────────────────────────────────────
//
// Four cards Limn writes itself (templated sentences, digits, no model, free on every tier), computed
// on every GET /api/sprint-graph from what is stored (db/sprint-signals.ts). Each carries the idents it
// is about: clicking it frames and highlights them exactly like a storyline card.
//   • 'since_last'      — what moved since the reader's previous visit (stage changes, tickets added,
//                         pull requests merged), against a per-(account, workspace) BASELINE snapshot
//                         rolled forward only after a gap of SPRINT_VISIT_GAP_MS between views.
//   • 'pace'            — the share of the sprint's days gone beside the share of its tickets complete.
//   • 'out_of_step'     — the tracker's stage disagrees with the code (In review with no open pull
//                         request — merged code or none at all, said apart; Complete with one
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
  /** The node idents it is about — the graph frames and highlights them. */
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
 *  after today. null when the window is not a real span. The ONE day count: the story's facts and the
 *  page header both use it. Pure. */
export function sprintDayOf(startMs: number, endMs: number, nowMs: number): { day: number; days: number; daysLeft: number } | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  // A part day counts as a day (Jira's "Oct 14 10:15 → Oct 27 17:00" is 14 days, not 13); a sliver over
  // a whole number of days (an end a few minutes late) does not.
  const days = Math.max(1, Math.ceil((endMs - startMs) / 86_400_000 - 0.05));
  const day = Math.min(days, Math.max(1, Math.floor((nowMs - startMs) / 86_400_000) + 1));
  return { day, days, daysLeft: days - day };
}

/** Why the last story pass stored nothing. Validation codes are review/sprint-story/validate.ts';
 *  'error' = the call itself failed. */
export type SprintStoryFailure =
  | 'not_json'
  | 'shape'
  | 'too_long'
  | 'count'
  | 'unknown_id'
  | 'duplicate'
  | 'coverage'
  | 'numeral'
  | 'number_word'
  | 'unknown_key'
  | 'number'
  | 'error';

/**
 * The story pass for TODAY's input:
 *   • 'current' — the story shown was written for today's input.
 *   • 'writing' — a pass is running now.
 *   • 'queued'  — a sprint read just finished; the pass runs after the ticket summaries.
 *   • 'waiting' — no pass yet for today's input; the next sprint read starts one.
 *   • 'failed'  — the pass for today's input could not write one (`failure`); it is not retried until
 *                 the input changes (a later sprint read with new facts, or the next sprint day).
 *   • 'none'    — no pass can run (AI off, no Claude credential, too few tickets).
 */
export type SprintStoryState = 'current' | 'writing' | 'queued' | 'waiting' | 'failed' | 'none';

export interface SprintStoryStatus {
  state: SprintStoryState;
  /** A story is shown but was written for an older input (or an older SPRINT_STORY_VERSION). */
  stale: boolean;
  /** ISO-8601 of the last pass that called Claude (stored or not); null = none recorded. */
  lastAttemptAt: string | null;
  /** The failure of the last pass, when it stored nothing; null otherwise. */
  failure: SprintStoryFailure | null;
}

/** The plain-English reason for a failed story pass. */
export function sprintStoryFailureText(f: SprintStoryFailure): string {
  switch (f) {
    case 'number':
    case 'number_word':
    case 'numeral':
      return 'Claude used a number Limn did not count.';
    case 'unknown_key':
      return 'Claude named a ticket that is not in the sprint.';
    case 'too_long':
      return 'Claude\u2019s answer was too long.';
    case 'count':
    case 'unknown_id':
    case 'duplicate':
    case 'coverage':
      return 'Claude did not pick the storylines it was asked for.';
    case 'not_json':
    case 'shape':
      return 'Claude\u2019s answer was not in the expected shape.';
    case 'error':
      return 'The call to Claude failed.';
  }
}

// ── Themes ───────────────────────────────────────────────────────────────────────────────────────
//
// ONE sprint-wide Haiku call (review/sprint-themes/, LOCAL + aiEnabled) after the brief pass names 3–8
// short shared THEMES over the sprint tickets' titles + brief summaries and puts each ticket in exactly
// one. Stored per (account, workspace) with an INPUT HASH (keys + summaries) and SPRINT_THEME_VERSION;
// it runs again only when that hash changes. The SPA groups the graph by it ("Group by → Theme").

/** Bumped when the theme prompt or shape changes: the stored themes stop counting. */
export const SPRINT_THEME_VERSION = 1;

export const SPRINT_THEME_CAPS = {
  /** Themes one pass may name (after empty ones are dropped). */
  minThemes: 3,
  maxThemes: 8,
  /** A theme name's words and characters. */
  nameWords: 4,
  nameChars: 40,
  /** A sprint with fewer tickets is not themed (nothing to group). */
  minTickets: 6,
} as const;

export interface SprintTheme {
  name: string;
}

// ── The sprint story ─────────────────────────────────────────────────────────────────────────────
//
// ONE sprint-wide Haiku call (review/sprint-story/, LOCAL + aiEnabled) after the theme pass: a one-line
// HEADLINE, a one-sentence SPRINT FOCUS (its main areas of work, from the AREAS the code lists — themes or
// epics and their stages) and 0–4 STORYLINES picked from CANDIDATES the code built out of the graph
// (dependency chains with an unfinished prerequisite; risks: tickets waiting inside the sprint, failing
// checks, work not started, unassigned work). ⚠ CODE owns every count, every ticket and every kind — the model picks candidates by id and
// words them, and its text may carry no number the code did not hand it (validate.ts). Stored per
// (account, workspace) with an INPUT HASH over everything it was sent + SPRINT_STORY_VERSION.

/** Bumped when the story prompt, candidates or shape change: the stored story stops counting.
 *  2 = digits only (spelled-out counts refused) + the sprint day / days left + the late risk.
 *  3 = the tracker's own sprint dates drive the day facts; the sprint name's short forms are quotable;
 *      a refused first answer is told why on its retry.
 *  4 = the theme storylines become ONE "Sprint focus" sentence; chains only with an unfinished
 *      prerequisite; the waiting risk only for blockers inside the sprint (outside ones are a code card). */
export const SPRINT_STORY_VERSION = 4;

/** "NOT STARTED LATE IN THE SPRINT" (db/sprint-story.ts): a risk candidate when at least
 *  `minNotStarted` sprint tickets are not started and at most `maxLeftPct`% of the sprint's days are
 *  left. Needs a REAL sprint window (the tracker's own sprint dates, else the workspace's cadence in mode 'sprint'); the
 *  trailing-14-day fallback is not a sprint and earns no day facts and no late risk. */
export const SPRINT_STORY_LATE = {
  minNotStarted: 2,
  maxLeftPct: 40,
} as const;

export const SPRINT_STORY_CAPS = {
  /** A sprint with fewer tickets gets no story. */
  minTickets: 4,
  /** Storylines are chains and risks only, and a sprint may have none worth telling. */
  minStorylines: 0,
  maxStorylines: 4,
  /** The validator's hard caps (refuse, never cut). The prompt asks for less (the `ask*` targets), so an
   *  answer that overshoots the target a little still stands. */
  headlineChars: 200,
  focusChars: 240,
  titleWords: 6,
  titleChars: 56,
  sentenceChars: 280,
  askHeadlineWords: 25,
  askFocusWords: 30,
  askTitleWords: 5,
  askSentenceWords: 30,
} as const;

/** 'chain' = a dependency path with an unfinished prerequisite; 'risk' = what may slip. (The retired
 *  'theme' kind became `SprintStory.focus`; a stored theme storyline is dropped on read.) */
export type SprintStorylineKind = 'chain' | 'risk';

export interface SprintStoryline {
  kind: SprintStorylineKind;
  title: string;
  sentence: string;
  /** The node idents it covers (code-chosen, never the model's) — the graph zooms to them. */
  idents: string[];
}

export interface SprintStory {
  headline: string;
  /** One sentence on what the sprint is focused on (its main areas of work). null for a story written
   *  before SPRINT_STORY_VERSION 4 — no focus line until the next pass rewrites it. */
  focus: string | null;
  /** Most important first, as the model ordered them. */
  storylines: SprintStoryline[];
  /** ISO-8601 of the pass that wrote it. */
  createdAt: string;
}

// ── The drawer ───────────────────────────────────────────────────────────────────────────────────

/** How a referenced ticket is tied to the opened one: a brief relation, or a tracker link
 *  ('blocked_by' = a blocking link, 'linked' = any other). */
export type SprintReferenceRelation = StoryReferenceRelation | 'blocked_by' | 'linked';

export interface SprintTicketReference {
  ident: string;
  key: string;
  title: string | null;
  status: string | null;
  /** The status category is done; null when not known. */
  done: boolean | null;
  relation: SprintReferenceRelation;
  quote: string | null;
  /** The brief's one sentence on why the two are tied (a reference's `why`, or a tracker link's
   *  reason); null when the brief gave none or there is no current brief. */
  why: string | null;
  /** It is a node of the graph (the drawer can move to it). */
  inGraph: boolean;
  url: string | null;
  /** Its assignee, from the stored sprint / referenced-ticket rows: null = unassigned; ABSENT = Limn has
   *  not read that ticket (never shown as "Unassigned"). */
  assignee?: { name: string; avatarUrl: string | null } | null;
}

/** GET /api/sprint-graph/ticket?workspace=<id>&ident=<ident> — Pro (402), DB ONLY. An ident that is not
 *  a node of this workspace's graph answers `found: false` with nulls — never a 404. The ticket review
 *  (per-criterion delivery) is the existing `POST /api/ticket-reviews/states` + `GET
 *  /api/ticket-reviews/:id`, keyed by the same ident. */
export interface SprintTicketDetailResponse {
  workspaceId: number;
  ident: string;
  found: boolean;
  ticket: {
    ident: string;
    key: string;
    title: string;
    url: string | null;
    provider: TrackerProvider;
    ghost: boolean;
    depth: number;
    status: { name: string; category: JiraStatusCategory | null } | null;
    stage: SprintStage | null;
    issueType: string | null;
    assignee: { name: string; avatarUrl: string | null } | null;
    epic: { key: string; title: string | null } | null;
  } | null;
  briefState: SprintBriefState;
  /** The CURRENT brief; null when pending / off. */
  brief: SprintBrief | null;
  /** Every ticket it names or links (brief references + tracker links), deduped, itself excluded. */
  references: SprintTicketReference[];
  /** The SAME fold as the ticket tab (`GET /api/ticket-prs`): `TimelinePr` rows the Open PRs cards
   *  draw. Empty lists for a ticket with no PR. */
  prs: TicketPrsResponse;
  /** Sprint tickets only (null for a ghost): the accepted + suggested repos for "Check against code". */
  repos: { accepted: SprintRepoRef[]; suggested: SprintRepoSuggestion[]; defaulted: boolean } | null;
  /** The latest "Check against code" run of any status; sprint tickets only. */
  assessment: { record: SprintAssessmentRecord; currency: SprintAssessmentCurrency } | null;
  aiEnabled: boolean;
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
