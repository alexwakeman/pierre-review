// REPORTS → STORIES — STORY LABELS: the stored Haiku labels (`story_labels`) and the label run
// (`/api/story-health/label*`, the path kept from the retired Story health charts). docs/API.md §
// Story labels; docs/CLAUDE-REVIEW.md § Story labels.
//
// Labels feed the ticket chips and findings (Reports → This sprint) and the story report's rates.
// Made only by the local agentic run (`registerAgenticRoutes`): in cloud — or with
// `LIMN_AI_DISABLED=true` — no label exists and only what code knows is shown.
//
// ⚠ A RUBRIC CHANGE IS A NEW METRIC. `STORY_RUBRIC_VERSION` is folded into a label's identity
// (unique `(account_id, ident, rubric_version, text_hash)`), so a bump relabels from scratch and old
// rows stop counting. A label is never redefined in place.

import type { StoryIssueId } from './story-issues.js';
import type { StoryUnclearRuleId } from './story-rules.js';

// ── Constants (the ONE spelling the folds and the page's copy both read) ───────────────────────────

/** The labelling rubric's version. Bump = every story is relabelled; never redefine a label in place. */
export const STORY_RUBRIC_VERSION = 4;

/** Weeks the label run looks back over (13 × 7 = 91 days), the current partial week included: the
 *  stories with an open or merged PR whose ticket was created (else first PR opened) in that span. */
export const STORY_LABEL_SPAN_WEEKS = 13;

/** The labeller's model — Haiku 5.5 through the core cheap seam (`review/llm.ts` `cheapComplete`). */
export const STORY_LABEL_MODEL = 'claude-haiku-5-5';

/** Stories one label run will label at most (the rest wait for the next press). */
export const STORY_LABEL_RUN_CAP = 150;

/** Labelling calls in flight at once within one run. */
export const STORY_LABEL_CONCURRENCY = 4;

/** Default per-run spending cap (US$); the server's config may override it. The run stops — never
 *  overspends — once its recorded cost reaches the cap. */
export const STORY_LABEL_BUDGET_USD_DEFAULT = 1;

/** The labeller's MEASURED run-to-run noise on a weekly percentage (40 stories × 2 runs, the
 *  prototype): median 2–4 points, 90th percentile 7–12. The ⓘ quotes `typicalPoints`. */
export const STORY_LABEL_NOISE = {
  typicalPoints: 4,
  p90Points: 12,
} as const;

// ── The model's labels (what `story_labels` stores; shared so both halves name the fields once) ────
//
// RUBRIC 2 (2026-10-11): per criterion "testable" + a short REASON when not; per story the
// DEPENDENCIES it names (what, owner, a ticket key) and up to three SPEC GAPS. Rubric 1's
// bundled / dependsOnOtherWork / outOfScopeStated / dependencyNamed / nonCodeWork are GONE: a
// rubric-1 row is never read (every reader filters on `STORY_RUBRIC_VERSION`), so its old JSON shape
// never reaches these types.
// RUBRIC 3 (2026-10-11): every answer carries an ANCHOR — `quote`, an exact passage of the ticket,
// verified by the server (`verifyStoryQuote`) — and an untestable criterion names its RULE from the
// closed vocabulary (story-rules.ts). The `testable` question's wording is UNCHANGED (the measured one).

/** Caps the label validator enforces (characters, after trimming; over-long text is REFUSED as a
 *  failed label and retried, never cut — the reader sees these strings verbatim). */
export const STORY_LABEL_TEXT_MAX = {
  /** A criterion's reason ("no expected result"). */
  reason: 80,
  /** A dependency's `what`. */
  what: 80,
  /** A dependency's `owner`. */
  owner: 60,
  /** A spec gap's `text`. */
  gap: 100,
} as const;

/** Dependencies one label may name; more is a failed label. */
export const STORY_LABEL_DEPENDENCIES_MAX = 8;

/** Per numbered criterion, in order (`criteria_json`). */
export interface StoryCriterionLabel {
  /** 1-based, = the criterion's position in `extractCriteria(...)`. */
  n: number;
  /** A tester could decide pass or fail from the words alone, with an observable result. */
  testable: boolean;
  /** Why not, ≤ STORY_LABEL_TEXT_MAX.reason ("no expected result", "'intuitive' can't be checked",
   *  "no input given"). Required (non-empty) when `testable` is false; null when true. */
  reason: string | null;
  /** RUBRIC 3: the rule it breaks (story-rules.ts `STORY_CRITERION_RULE_IDS`) when `testable` is
   *  false; null when true. Optional on the type only so older fixtures still build. */
  rule?: StoryUnclearRuleId | null;
  /** RUBRIC 3: the shortest EXACT passage showing the problem, VERIFIED against the text sent
   *  (`verifyStoryQuote`); null when none was given or it did not verify. */
  quote?: string | null;
}

/** What a named dependency is. 'ticket' = another ticket (a key may be given). */
export type StoryDependencyKind = 'ticket' | 'api' | 'design' | 'data' | 'environment' | 'decision' | 'other';

export const STORY_DEPENDENCY_KINDS: readonly StoryDependencyKind[] = [
  'ticket',
  'api',
  'design',
  'data',
  'environment',
  'decision',
  'other',
];

export const STORY_DEPENDENCY_KIND_LABEL: Record<StoryDependencyKind, string> = {
  ticket: 'Another ticket',
  api: 'An API',
  design: 'A design',
  data: 'Data',
  environment: 'An environment',
  decision: 'A decision',
  other: 'Other work',
};

/** One dependency the ticket's TEXT names (it may also be linked; code dedupes by key). */
export interface StoryDependencyLabel {
  kind: StoryDependencyKind;
  /** ≤ STORY_LABEL_TEXT_MAX.what ("cookie banner", "design for the map page"). */
  what: string;
  /** ≤ STORY_LABEL_TEXT_MAX.owner ("UCD team"); null when the ticket names nobody. */
  owner: string | null;
  /** A ticket key the text gives for it (`BMD-568`), as written; null when none. */
  ticketKey: string | null;
  /** RUBRIC 3: the passage naming it, verified (`verifyStoryQuote`); null when none. */
  quote?: string | null;
}

/** RUBRIC 3 added 'error_handling'. Each maps to a spec_gaps rule (story-rules.ts `STORY_SPEC_GAP_RULE`). */
export type StorySpecGapType = 'rule' | 'edge_case' | 'error_handling' | 'design' | 'data' | 'non_functional';

export const STORY_SPEC_GAP_TYPES: readonly StorySpecGapType[] = ['rule', 'edge_case', 'error_handling', 'design', 'data', 'non_functional'];

export const STORY_SPEC_GAP_TYPE_LABEL: Record<StorySpecGapType, string> = {
  rule: 'Business rule',
  edge_case: 'Edge case',
  error_handling: 'Error handling',
  design: 'Design',
  data: 'Data',
  non_functional: 'Non-functional',
};

/** One specific missing detail. */
export interface StorySpecGap {
  type: StorySpecGapType;
  /** ≤ STORY_LABEL_TEXT_MAX.gap ("No behaviour when the upload fails"). */
  text: string;
  /** RUBRIC 3: the passage the gap is about ("the user uploads a file"), verified; null when the gap
   *  is about something absent altogether. */
  quote?: string | null;
}

/** RUBRIC 4 (2026-10-11): how ANOTHER ticket the text names relates to this one. A ticket key in the
 *  text says nothing about its meaning — one real story named fifteen: the work it supersedes, shipped
 *  work it extends, an existing page it sends the user to, siblings explicitly out of scope, one to
 *  build alongside. Only `depends_on` can make the story Blocked (`storyBlockers`).
 *   • depends_on   this story cannot be finished until that ticket is.
 *   • concurrent   built alongside it — coordinate, never a blocker.
 *   • builds_on    extends shipped / existing work, or uses an existing feature or page.
 *   • supersedes   replaces what that ticket built.
 *   • out_of_scope a follow-up or sibling the text explicitly leaves out.
 *   • context      related / see also / background / a destination page. */
export type StoryReferenceRelation = 'depends_on' | 'concurrent' | 'builds_on' | 'supersedes' | 'out_of_scope' | 'context';

/** In PRIORITY order: when the text names one ticket in two roles, the first listed here wins
 *  (`storyReferencesByKey`) — "out of scope" and "must be built alongside" is a ticket to coordinate with. */
export const STORY_REFERENCE_RELATIONS: readonly StoryReferenceRelation[] = [
  'depends_on',
  'concurrent',
  'builds_on',
  'supersedes',
  'out_of_scope',
  'context',
];

export const STORY_REFERENCE_RELATION_LABEL: Record<StoryReferenceRelation, string> = {
  depends_on: 'Depends on',
  concurrent: 'Build alongside',
  builds_on: 'Builds on',
  supersedes: 'Replaces',
  out_of_scope: 'Out of scope',
  context: 'Related',
};

/** References one label may carry; more is a failed label. */
export const STORY_LABEL_REFERENCES_MAX = 20;

/** RUBRIC 4: one other ticket the TEXT names (by key or browse link), and how it relates. */
export interface StoryTicketReference {
  /** The key as written (`BMD-568`); the validator keeps only a key the sent text names. */
  ticketKey: string;
  relation: StoryReferenceRelation;
  /** The passage showing the relation, verified (`verifyStoryQuote`); null when none held. */
  quote: string | null;
  /** ≤ STORY_LABEL_TEXT_MAX.owner — the team or person the text names for it; null otherwise. */
  owner: string | null;
}

/** Per story (`story_json`). */
export interface StoryLevelLabels {
  /** ≤ STORY_LABEL_DEPENDENCIES_MAX; [] = the text names none. RUBRIC 4: a dependency with a
   *  `ticketKey` agrees with `references` — that key's relation is `depends_on` (the validator drops
   *  any other). */
  dependencies: StoryDependencyLabel[];
  /** RUBRIC 4: every other ticket the text names (≤ STORY_LABEL_REFERENCES_MAX). Optional on the type
   *  only so older fixtures still build; a rubric-4 label always carries it. */
  references?: StoryTicketReference[];
  /** ≤ STORY_SPEC_GAPS_MAX (story-issues.ts); [] = none found. */
  gaps: StorySpecGap[];
}

/** The change-point bar for TIME / COUNT series: a step of at least this many robust SDs (sigma
 *  floored at the series' `minScale`). The ONE spelling — backend db/changepoint.ts re-exports it. */
export const CHANGEPOINT_Z = 3;

/** Story-issue RATES held back from the story report until their Haiku judgement passes an agreement
 *  test (two independent runs, Cohen's kappa ≥ 0.6, and not saturated). The ticket cards still show
 *  the judgement. Each entry says why.
 *  • spec_gaps — 2026-10-11, 37 BNG tickets labelled twice: every ticket got 3 gaps (saturated: the
 *    rate is 100% by construction) and gap TYPES agreed at κ 0.13–0.47. */
export const STORY_ISSUE_RATES_HELD: Readonly<Partial<Record<StoryIssueId, string>>> = {
  spec_gaps: 'every labelled story gets gaps, and two readings disagree on their type',
};

// ── The label run (core, agentic, LOCAL-ONLY: registered only via `registerAgenticRoutes`) ────────
//
//   POST /api/story-health/label         {workspaceId}  → 202 StoryLabelRunResponse   (ai + ai_hourly)
//   GET  /api/story-health/label                         → StoryLabelRunResponse       (read)
//   POST /api/story-health/label/cancel                  → StoryLabelRunResponse       (read)
//
// ONE run in flight per ACCOUNT, claimed SYNCHRONOUSLY (before any await). The run's state lives in
// process memory (the labels it writes are the durable part); a restart loses the progress, never a
// label. Each label call's cost is recorded via `recordAiUsage` (feature 'story_labels'); the run stops
// at `budgetUsd`. A failed label (bad JSON, wrong criterion count) is NOT stored and is retried on the
// next press.

export type StoryLabelRunState = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Why a run stopped short. 'budget' = hit `budgetUsd`; 'auth' / 'runtime' = no Claude credential /
 *  AI runtime; 'failed' = anything else (the log has the detail). */
export type StoryLabelRunStop = 'budget' | 'cancelled' | 'auth' | 'runtime' | 'failed';

export interface StoryLabelRunStatus {
  /** Opaque, unique per process. */
  id: string;
  workspaceId: number;
  state: StoryLabelRunState;
  /** Stories this run set out to label (≤ `STORY_LABEL_RUN_CAP`). */
  total: number;
  /** Stories finished (labelled + failed). `done / total` drives the progress bar. */
  done: number;
  labelled: number;
  /** Labels refused by validation or a failed call (not stored). */
  failed: number;
  /** Recorded spend so far (US$; local spend is shown in US$, never credits). */
  costUsd: number;
  budgetUsd: number;
  stoppedBy: StoryLabelRunStop | null;
  /** ISO-8601. */
  startedAt: string;
  finishedAt: string | null;
}

export interface StartStoryLabelRunBody {
  workspaceId: number;
}

export interface StoryLabelRunResponse {
  /** GET: the account's current run, else its most recent finished run this process, else null. */
  run: StoryLabelRunStatus | null;
}

/** Refusals are HTTP errors with `StoryLabelRunErrorBody`: 409 'busy' (`runningId` set),
 *  400 'no_tracker', 422 'nothing_to_label', 402 not entitled. */
export type StoryLabelRunRefusal = 'busy' | 'no_tracker' | 'nothing_to_label';

export interface StoryLabelRunErrorBody {
  error: StoryLabelRunRefusal | string;
  message: string;
  runningId?: string;
}

