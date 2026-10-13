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
 *  2 (2026-10-12): the criteria cap 20 → 40 — real stories itemise past 20 and were cut. */
export const SPRINT_BRIEF_VERSION = 2;

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
}

export interface SprintBrief {
  /** One or two sentences: what the ticket delivers. */
  summary: string;
  /** The acceptance criteria, itemised; [] only when the text gives nothing to derive from. */
  criteria: SprintBriefCriterion[];
  /** The ticket has no acceptance criteria of its own: these were derived from the description. */
  criteriaDerived: boolean;
  references: SprintBriefReference[];
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
