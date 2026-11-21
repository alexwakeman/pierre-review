// IMPLEMENT, PLAN FIRST (docs/STORY-BUILD.md § Plan first; docs/SANDBOX.md § The plan and its checks). A
// story session (Implement / Fill gaps) opens with a PLANNING turn Limn sends itself. The agent ends that
// turn with ONE fenced ```limn-plan block holding a `BuildPlanRaw`. The host checks its shape with ONE
// validator text (backend sandbox/workspace/plan-check.ts) and VERIFIES every piece of evidence itself
// (code and data files against Limn's clone cache at the session's base commit, docs against the built
// library, data runs against Limn's own log of `limn-svc run`). What survives is a stored PLAN REVISION.
// The reader answers each point of contention (Agree / Keep the story / Reply), then approves; only then
// does the build start.
//
// Names avoid the dormant `StoryBuildPlan*` types of the removed plan/build flow (they stay, unused).
import type { ReviewDocReference } from './reference-docs.js';

export const BUILD_PLAN_SCHEMA = 'limn.plan/1' as const;
/** The fenced block's info string. */
export const BUILD_PLAN_FENCE = 'limn-plan' as const;
/** The largest plan block Limn reads (bytes). */
export const BUILD_PLAN_MAX_BYTES = 128 * 1024;
/** Plan revisions per session. */
export const BUILD_PLAN_MAX_REVISIONS = 12;

export const BUILD_PLAN_LIMITS = {
  summary: 1_500,
  repoWhy: 600,
  criteria: 60,
  criterionHow: 800,
  contentions: 12,
  storySays: 600,
  problem: 800,
  proposal: 800,
  ifKept: 600,
  evidenceMin: 1,
  evidenceMax: 4,
  /** A quote's length (characters) and its least number of letters and digits. */
  quoteMax: 1_500,
  quoteMinLetters: 12,
  /** A docs quote is a review doc reference's (REVIEW_DOC_QUOTE_MAX_CHARS). */
  docsQuoteMax: 300,
  lineSpan: 120,
  stackTotal: 6,
  stackPerRepo: 3,
  prTitle: 120,
  prContains: 1_000,
  stackReason: 600,
  ticketField: 12_000,
  ticketWhy: 600,
  /** A reader's reply (the composer's own cap is SANDBOX_MESSAGE_MAX). */
  reply: 4_000,
  // The UI section (`ui`, docs/IMPLEMENT-UI-PLAN.md § 4).
  uiReason: 600,
  uiSummary: 800,
  uiDesignInputs: 30,
  uiNote: 300,
  uiEvidenceMax: 6,
  uiScreensMax: 3,
  uiNewComponents: 10,
  uiComponentName: 80,
  uiWhy: 300,
  uiGaps: 10,
  uiGap: 300,
} as const;

// ---- what the agent writes (the raw shape) -------------------------------------------------------------

export type BuildPlanCriterionStatus = 'planned' | 'met' | 'not_planned';
export type BuildPlanDataKind = 'fixture' | 'seed' | 'schema' | 'migration' | 'other';

export type BuildPlanEvidenceRaw =
  | { kind: 'code'; repo: string; path: string; lines: [number, number]; quote: string }
  | { kind: 'docs'; link: string; quote: string }
  | { kind: 'data_file'; what: BuildPlanDataKind; repo: string; path: string; lines: [number, number]; quote: string }
  | { kind: 'data_run'; run: string; quote: string };

/** Where the planned screens render, for a look in a browser (docs/IMPLEMENT-UI-PLAN.md § 4). */
export type BuildPlanRenderTarget = 'storybook' | 'dev_server' | 'test_page' | 'none';
export const BUILD_PLAN_RENDER_TARGETS: readonly BuildPlanRenderTarget[] = ['storybook', 'dev_server', 'test_page', 'none'];

export type BuildPlanCodeEvidenceRaw = Extract<BuildPlanEvidenceRaw, { kind: 'code' }>;

/**
 * THE UI SECTION (optional; docs/IMPLEMENT-UI-PLAN.md § 4): whether the work changes a screen, what design the
 * ticket gives (manifest ids from `ensemble-ticket list`), the design system and the nearest existing screens AS
 * CODE QUOTES (verified like every other code evidence), and what the agent would add or has to choose.
 */
export interface BuildPlanUiRaw {
  needed: boolean;
  /** The agent's recommendation: the build should get a browser to look at its screens. */
  browser: boolean;
  reason: string;
  renderTarget: BuildPlanRenderTarget;
  designInputs: Array<{ id: string; used: boolean; note: string }>;
  designSystem: { summary: string; evidence: BuildPlanCodeEvidenceRaw[] };
  nearestScreens: BuildPlanCodeEvidenceRaw[];
  newComponents: Array<{ name: string; why: string }>;
  /** What the design does not show (empty, error or mobile states, …) and the agent will choose. */
  gaps: string[];
}

/** What the agent writes inside the ```limn-plan block. */
export interface BuildPlanRaw {
  schema: typeof BUILD_PLAN_SCHEMA;
  summary: string;
  repos: Array<{ repo: string; why: string }>;
  criteria: Array<{ ref: string; status: BuildPlanCriterionStatus; how: string; prs: string[]; openPoints?: number[] }>;
  contentions: Array<{
    id: string;
    about: string[];
    storySays: string;
    problem: string;
    proposal: string;
    ifKept: string;
    evidence: BuildPlanEvidenceRaw[];
  }>;
  stack: Array<{ id: string; repo: string; title: string; contains: string; criteria: string[]; dependsOn: string[] }>;
  stackReason: string | null;
  ticketUpdate: null | { description: string | null; acceptanceCriteria: string | null; why: string; contentions: string[] };
  /** Absent or null: the work changes no screen (or an older plan). */
  ui?: BuildPlanUiRaw | null;
}

// ---- what the host stores and sends (the verified shape) ------------------------------------------------

export type BuildPlanSource = 'opening' | 'reply' | 'message' | 'repair';

export type BuildPlanEvidence =
  | {
      kind: 'code';
      repoId: number;
      fullName: string;
      path: string;
      startLine: number;
      endLine: number;
      baseSha: string;
      /** The HOST's own text of those lines (never the agent's quote), cut at 40 lines / 4 KB. */
      excerpt: string;
      /** The agent's line numbers were wrong: the quote is unique elsewhere in the file, so they were moved. */
      linesCorrected: boolean;
    }
  | ({ kind: 'docs' } & ReviewDocReference)
  | {
      kind: 'data_file';
      what: BuildPlanDataKind;
      repoId: number;
      fullName: string;
      path: string;
      startLine: number;
      endLine: number;
      baseSha: string;
      excerpt: string;
      linesCorrected: boolean;
    }
  | {
      kind: 'data_run';
      run: string;
      stack: string;
      service: string;
      command: string[];
      exitCode: number | null;
      at: string;
      /** The matched lines of the output Limn recorded (± 3 lines). */
      excerpt: string;
    };

export interface BuildPlanContention {
  id: string;
  /** sha1 of the problem (folded) and the sorted evidence keys: a decision carries forward on it. */
  fingerprint: string;
  about: string[];
  /** A quote from TICKET.md, or null when Limn did not find it there. */
  storySays: string | null;
  problem: string;
  proposal: string;
  ifKept: string;
  evidence: BuildPlanEvidence[];
}

export interface BuildPlanPr {
  key: string;
  repoId: number;
  fullName: string;
  /** 1..3 within the repository. */
  stackIndex: number;
  title: string;
  contains: string;
  criteria: string[];
  dependsOn: string[];
  /** The sandbox branch = the push branch (host-assigned). */
  branch: string;
}

export interface BuildPlanTicketUpdate {
  description: string | null;
  acceptanceCriteria: string | null;
  why: string;
  contentions: string[];
  /** Host: the layout check (shared `compareTicketLayout`) against the ticket as Limn held it at plan
   *  time. [] or absent = the layout is kept. Shown in the plan panel; never rejects a plan. */
  layoutProblems?: string[];
}

export interface BuildPlanCriterion {
  ref: string;
  /** The criterion's text from TICKET.md ('' for a Fill gaps M<n> item Limn does not know). */
  text: string;
  status: BuildPlanCriterionStatus;
  how: string;
  prs: string[];
  openPoints: number[];
}

/** The UI section as the host verified it. Design inputs not in the ticket's list, and code evidence Ensemble
 *  could not find, are removed (counted in `dropped`). */
export interface BuildPlanUi {
  needed: boolean;
  browser: boolean;
  reason: string;
  renderTarget: BuildPlanRenderTarget;
  /** `name` and `kind` are the ticket's (the manifest), never the agent's. */
  designInputs: Array<{ id: string; name: string; kind: string; used: boolean; note: string }>;
  designSystem: { summary: string; evidence: BuildPlanEvidence[] };
  nearestScreens: BuildPlanEvidence[];
  newComponents: Array<{ name: string; why: string }>;
  gaps: string[];
}

export interface BuildPlanRevision {
  revision: number;
  source: BuildPlanSource;
  createdAt: string;
  summary: string;
  repos: Array<{ repoId: number; fullName: string; why: string }>;
  criteria: BuildPlanCriterion[];
  contentions: BuildPlanContention[];
  stack: BuildPlanPr[];
  stackReason: string | null;
  ticketUpdate: BuildPlanTicketUpdate | null;
  /** The UI section (absent on an older revision, null when the work changes no screen). */
  ui?: BuildPlanUi | null;
  /** What Limn removed: counts and plain reasons, never the dropped claims' text. */
  dropped: { contentions: number; evidence: number; reasons: string[] };
}

export type BuildPlanDecision = 'agree' | 'keep_story';

/** The plan stage's state line. */
export type BuildPlanStage = 'planning' | 'revising' | 'ready' | 'failed' | 'approved';

/** `StoryBuildSession.plan` — null on a session without a plan (old sessions, AI Fix). */
export interface BuildPlanView {
  latest: BuildPlanRevision | null;
  revisions: number;
  /** contention id → the decision on the LATEST revision (carried forward by id + fingerprint). */
  decisions: Record<string, { decision: BuildPlanDecision; at: string }>;
  /** Replies sent, newest last (the decision log the reader sees). */
  replies: Array<{ contentionId: string | null; text: string; at: string; revision: number }>;
  unanswered: number;
  approvedRevision: number | null;
  approvedAt: string | null;
  status: BuildPlanStage;
  /** Why there is no usable plan (the first problems, in one line). */
  problem: string | null;
  withDocs: boolean;
  /** Fill gaps: the plan is about the gaps the story check found. */
  fillGaps: boolean;
}

/** Every contention of `latest` has a decision (Approve may be pressed). */
export function buildPlanUnanswered(latest: Pick<BuildPlanRevision, 'contentions'> | null, decisions: Readonly<Record<string, unknown>>): number {
  if (latest == null) return 0;
  return latest.contentions.filter((c) => decisions[c.id] == null).length;
}

/**
 * The live view of an agent's text while it streams (the deltas, accumulated): everything after an opened
 * ```limn-plan fence is hidden behind `line` ("Writing the plan…"). Pure.
 */
export function hidePartialPlanText(text: string, line: string): string {
  const at = text.search(/(^|\n) {0,3}```limn-plan[ \t]*(\n|$)/);
  if (at < 0) return text;
  return `${text.slice(0, at).trimEnd()}\n\n${line}`.trim();
}

// ---- the planned pull requests (created at Approve) ------------------------------------------------------

export type StoryBuildPrStatus = 'planned' | 'ready' | 'empty' | 'failed' | 'pushed';

/** A check the agent says it ran for one planned PR (the build report: a SELF-REPORT, never a gate). */
export interface StoryBuildPrCheck {
  command: string;
  result: 'passed' | 'failed' | 'not_run';
  note: string | null;
}

/** One planned PR on the wire (`StoryBuild.prs`); no patch (fetched on demand). */
export interface StoryBuildPr {
  id: number;
  key: string;
  repoId: number;
  fullName: string;
  /** Global plan order (0-based). */
  position: number;
  stackIndex: number;
  title: string;
  contains: string;
  criteria: string[];
  dependsOn: string[];
  branch: string;
  status: StoryBuildPrStatus;
  /** Why extraction refused it (`failed`), or why it has nothing (`empty`). */
  error: string | null;
  /** Host-computed from the verified commits (null until extracted). */
  stat: { files: number; insertions: number; deletions: number; commits: number } | null;
  filesChanged: string[];
  /** The build report's words for this PR ("The agent says"), else null. */
  summary: string | null;
  /** The build report's checks for this PR; null when the report did not say ("not reported"). */
  checks: StoryBuildPrCheck[] | null;
  /** The agent's own word on this PR in the build report. */
  reported: 'done' | 'partly' | 'not_done' | null;
  pushedBranch: string | null;
  pushedPrNumber: number | null;
  pushedPrUrl: string | null;
  pushError: string | null;
  /** The code beside `pushError` (`BRANCH_EXISTS` ⇒ the tab offers a new branch name); null otherwise. */
  pushErrorCode?: string | null;
}

/** `GET …/prs/:prId/diff` — one planned PR's host-computed patch (against the previous PR, or the base). */
export interface StoryBuildPrDiffResponse {
  prId: number;
  key: string;
  repoId: number;
  patch: string | null;
  filesChanged: string[];
  stat: StoryBuildPr['stat'];
}

/** One planned PR's push outcome (`StoryBuildPushResponse.prs`). Codes beside the per-repository ones:
 *  STACK_PREVIOUS_NOT_PUSHED · STACK_PREVIOUS_CLOSED · DEPENDS_ON_NOT_PUSHED · STACK_BELOW_FAILED · TREE_MISMATCH. */
export interface StoryBuildPrPushResult {
  prId: number;
  key: string;
  repoId: number;
  outcome: 'pushed' | 'failed' | 'skipped';
  prNumber: number | null;
  prUrl: string | null;
  code: string | null;
  error: string | null;
}

// ---- routes, bodies, errors --------------------------------------------------------------------------------

/** `POST …/plan/decisions`. `decision: null` clears the answer. DB only, no turn. */
export interface BuildPlanDecisionBody {
  revision: number;
  contentionId: string;
  decision: BuildPlanDecision | null;
}

/** `POST …/plan/reply`: a revision turn. `contentionId: null` ⇒ about the whole plan. */
export interface BuildPlanReplyBody {
  revision: number;
  contentionId: string | null;
  text: string;
}

/** `POST …/plan/approve`: the build starts. `text`: optional words added to the build instruction. */
export interface BuildPlanApproveBody {
  revision: number;
  text?: string;
}

/** `GET …/plan?revision=` — one revision (the history list). */
export interface BuildPlanRevisionResponse {
  revision: BuildPlanRevision;
  decisions: Record<string, { decision: BuildPlanDecision; at: string }>;
}

export type BuildPlanErrorCode = 'PlanStale' | 'PlanUnanswered' | 'PlanNotApproved' | 'NoDocs' | 'NoPlan';

export const BUILD_PLAN_API = {
  plan: '/api/story-builds/:id/plan',
  decisions: '/api/story-builds/:id/plan/decisions',
  reply: '/api/story-builds/:id/plan/reply',
  approve: '/api/story-builds/:id/plan/approve',
} as const;

export type BuildPlanApiRoute = keyof typeof BUILD_PLAN_API;

export function buildPlanPath(route: BuildPlanApiRoute, id: number): string {
  return BUILD_PLAN_API[route].replace(':id', String(id));
}
