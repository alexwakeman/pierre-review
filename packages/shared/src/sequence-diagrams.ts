// DESIGN DIAGRAMS (CORE, free, LOCAL ONLY — agentic; docs/CLAUDE-REVIEW.md § Design diagrams).
//
// A SEPARATE agentic process (Sonnet 5), never inside the PR review, the ticket review or the CI
// review. After every finished Claude Review of a pull request with CODE changes it draws:
//   'pr'     ONE diagram of how data moves through this PR's change, at its head;
//   'story'  when the PR is on a ticket with MORE THAN ONE open or merged PR, ONE diagram of the whole
//            story across every participating repository.
// Since DESIGN_DIAGRAM_VERSION 2 a run draws a DATA-FLOW SEQUENCE (`FlowDiagram`, below): who touches
// the data across the top, numbered steps down the page. Before it a run drew a small GRID of stages
// and layers (`DesignDiagram`); old rows keep that shape and still render. A change with no data path
// gets NO diagram: a free deterministic pre-check refuses copy-only, test-only and tiny changes, and
// the model may refuse with a reason. The SERVER validates every field before storing it. The type and
// route names keep "sequence diagram" (the table, routes and queue are the retired Mermaid ones').
//
// Every cap below is spelled ONCE here and read by the validator, the prompt and the renderer.
import type { AiProviderId } from './types.js';
import type { AiProviderName } from './ai-run-label.js';

/** The fixed layer vocabulary, id → display label. */
export const DESIGN_LAYERS = {
  ui: 'UI',
  api: 'API / route',
  domain: 'Domain / service',
  data: 'Data / store',
  external: 'External / integration',
  tests: 'Tests / CI',
} as const;
export type DesignLayer = keyof typeof DESIGN_LAYERS;
/** The CANONICAL (top-to-bottom) order of the layers. */
export const DESIGN_LAYER_ORDER: readonly DesignLayer[] = ['ui', 'api', 'domain', 'data', 'external', 'tests'];

export const DESIGN_MAX_ACTS = 4;
export const DESIGN_MAX_LAYERS = 5;
export const DESIGN_MAX_CELLS = 14;
export const DESIGN_MAX_ARROWS = 8;
export const DESIGN_ACT_TITLE_MAX = 24;
export const DESIGN_CELL_LABEL_MAX = 40;
export const DESIGN_PATTERN_MAX = 24;
export const DESIGN_ARROW_LABEL_MAX = 24;
export const DESIGN_ARROW_LABEL_WORDS = 3;
export const DESIGN_CELL_FILES_MAX = 6;
export const DESIGN_TITLE_MAX = 80;
export const DESIGN_CAPTION_MAX = 220;
export const DESIGN_CAPTION_SENTENCES = 2;
/** Act and cell ids: letters, digits, `-` and `_`, at most this long. */
export const DESIGN_ID_MAX = 24;

export type DesignChange = 'new' | 'changed' | 'unchanged';
export const DESIGN_CHANGES: readonly DesignChange[] = ['new', 'changed', 'unchanged'];

export interface DesignAct {
  id: string;
  // The stage as a reader tells it ("Import", "Check", "Calculate", "Save").
  title: string;
}

export interface DesignCell {
  id: string;
  act: string;
  layer: DesignLayer;
  // A RESPONSIBILITY, not a function name.
  label: string;
  // The pattern used ('Guard clause', 'Pipeline', 'Adapter', …), or null.
  pattern: string | null;
  change: DesignChange;
  // Story designs: the pull request that does this part — 'PR1', 'PR2', …, the 1-based index into the
  // view's `members`. PR designs: always null.
  pr: string | null;
  // Changed file paths (repo-relative), filtered SERVER-side to the change — the cell's click-through.
  files: string[];
}

export interface DesignArrow {
  from: string;
  to: string;
  label: string | null;
}

export interface DesignDiagram {
  acts: DesignAct[];
  // The layers used, in DESIGN_LAYER_ORDER.
  layers: DesignLayer[];
  cells: DesignCell[];
  arrows: DesignArrow[];
}

// ---- THE DATA-FLOW DIAGRAM (2026-10-31; DESIGN_DIAGRAM_VERSION 2) -------------------------------
//
// What a run draws NOW: a SEQUENCE diagram of how data moves through the change, in process order.
// The `DesignDiagram` grid above is the PREVIOUS shape: old rows still hold it and render as they did,
// marked as drawn in the old layout (a Redraw draws the flow).
//
//   PARTICIPANTS  the lanes across the top, left to right: who touches the data (a screen, a route, a
//                 service, a table, an outside API, a queue). Each is used by at least one step.
//   STEPS         numbered 1..n DOWN the page, each one arrow from one participant to another (or to
//                 itself, for a check or a transform) saying WHAT data passes and what kind of step it
//                 is. Every step after the first starts where the data already is — a participant an
//                 earlier step reached — so the flow is one connected chain, never a list of areas.
//
// Every cap is spelled ONCE here, read by the validator (review/diagrams/validate.ts), the prompt and
// the renderer (components/FlowDiagram.tsx).

/** The participant (lane) vocabulary, id → display label. */
export const FLOW_LANES = {
  ui: 'Screen',
  api: 'API route',
  service: 'Service',
  queue: 'Queue / job',
  db: 'Database',
  store: 'File / cache',
  external: 'Outside API',
} as const;
export type FlowLaneKind = keyof typeof FLOW_LANES;
export const FLOW_LANE_KINDS: readonly FlowLaneKind[] = ['ui', 'api', 'service', 'queue', 'db', 'store', 'external'];
/** Where data is KEPT: a `write` step must end at one of these. */
export const FLOW_STORE_LANES: readonly FlowLaneKind[] = ['queue', 'db', 'store', 'external'];

/** What a step does with the data. */
export type FlowStepKind = 'read' | 'validate' | 'transform' | 'write' | 'call' | 'emit' | 'return';
export const FLOW_STEP_KINDS: readonly FlowStepKind[] = ['read', 'validate', 'transform', 'write', 'call', 'emit', 'return'];
/** The steps that may stay on one participant (an arrow to itself). */
export const FLOW_SELF_STEP_KINDS: readonly FlowStepKind[] = ['validate', 'transform'];
/** The word each step kind reads as (on the arrow and in the list). */
export const FLOW_STEP_WORD: Record<FlowStepKind, string> = {
  read: 'Read',
  validate: 'Check',
  transform: 'Transform',
  write: 'Write',
  call: 'Call',
  emit: 'Emit',
  return: 'Return',
};

export const FLOW_MIN_PARTICIPANTS = 2;
export const FLOW_MAX_PARTICIPANTS = 7;
export const FLOW_MIN_STEPS = 2;
export const FLOW_MAX_STEPS = 16;
export const FLOW_PARTICIPANT_LABEL_MAX = 28;
export const FLOW_STEP_LABEL_MAX = 56;
export const FLOW_STEP_FILES_MAX = 4;
/** A change with at most this many changed code files (tests aside) must put EVERY one on a step;
 *  a bigger one must put at least this many on steps. */
export const FLOW_FILES_MUST_MAP = 8;
/** The model's "no diagram" reason, finishing the sentence "No diagram: …". */
export const FLOW_DECLINE_MAX = 120;
/** Participant ids: letters, digits, `-` and `_`, at most this long. */
export const FLOW_ID_MAX = 24;
/** The deterministic pre-check: fewer changed code lines than this (tests aside) is too small to draw. */
export const FLOW_MIN_CODE_LINES = 4;

export interface FlowParticipant {
  id: string;
  kind: FlowLaneKind;
  // What it is, in a reader's words ("Orders route", "pull_requests table", "GitHub API").
  label: string;
  change: DesignChange;
  // Story designs: 'PR1'… (planned designs: 'R1'…) — who builds it. PR designs: null.
  pr: string | null;
}

export interface FlowStep {
  // 1-based, contiguous, in process order.
  n: number;
  from: string;
  to: string;
  kind: FlowStepKind;
  // WHAT data passes or is checked ("order rows without an account", "rate per currency").
  label: string;
  // Story designs: the PR that does this step ('PR1'…; planned: 'R1'…). PR designs: null.
  pr: string | null;
  // Changed file paths, filtered SERVER-side to the change — the step's click-through.
  files: string[];
}

export interface FlowDiagram {
  participants: FlowParticipant[];
  steps: FlowStep[];
}

/** Is a stored design JSON the data-flow shape (not the older grid)? */
export function isFlowDiagram(v: unknown): v is FlowDiagram {
  return (
    typeof v === 'object' &&
    v != null &&
    Array.isArray((v as { steps?: unknown }).steps) &&
    Array.isArray((v as { participants?: unknown }).participants)
  );
}

/** Is a stored design JSON the older grid shape? */
export function isLegacyDesignDiagram(v: unknown): v is DesignDiagram {
  return typeof v === 'object' && v != null && Array.isArray((v as { cells?: unknown }).cells) && !isFlowDiagram(v);
}

export type SequenceDiagramKind = 'pr' | 'story';
export type SequenceDiagramStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'refused' | 'cancelled';
// 'review' = started by a finished Claude Review (counts against SEQUENCE_DIAGRAM_DAILY_CAP);
// 'manual' = a Redraw click (never counts).
export type SequenceDiagramTrigger = 'review' | 'manual';

// Automatic draws of ONE subject (a PR, a story) per UTC day that count against the cap: its draw and
// one redraw. A story whose pull requests changed (one joined, left) is drawn past it — that is a new
// picture, not a redraw. (2026-10-28: one story was drawn 11 times and one PR 9 times in a day, and
// the cap of 30 was gone by 14:52.) Redraws also never take the cap's last slots (`repeatRunLimit`).
export const SEQUENCE_DIAGRAM_SUBJECT_DAILY_DRAWS = 2;

// Why a finished review did not draw a design that is out of date, said on the slot (`autoSkipped`):
//   daily_limit   the account's automatic designs for today are used (resets 00:00 UTC)
//   redraw_limit  this design was already redrawn today
export type SequenceDiagramAutoSkip = 'daily_limit' | 'redraw_limit';

// Why a run stored no design, decided by the SERVER (never the model).
export type SequenceDiagramRefusal =
  | 'no_code' // the change touches no code (docs, config, lockfiles only)
  // THE PRE-CHECK (review/diagrams/precheck.ts — free, no model; a click to Draw skips these three):
  | 'tests_only' // the only code it changes is tests
  | 'copy_only' // every changed code line differs only in its text (strings, JSX text)
  | 'too_small' // fewer than FLOW_MIN_CODE_LINES changed code lines
  // THE MODEL said no data moves through it (its reason, finishing "No diagram: …", is the view's
  // `refusalDetail`). A billed run, so it counts against the cap.
  | 'no_flow'
  | 'head_moved' // the PR (or a member) moved while the run waited; the next review redraws it
  | 'unreadable' // the diff or a checkout could not be read
  | 'too_few_prs' // a story design needs more than one open or merged PR on the ticket
  | 'too_many_prs' // more members than SEQUENCE_DIAGRAM_STORY_MAX_PRS
  | 'invalid_diagram'; // the answer did not pass validation

export const SEQUENCE_DIAGRAM_REFUSAL_TEXT: Record<SequenceDiagramRefusal, string> = {
  no_code: 'No diagram: this change edits no code.',
  tests_only: 'No diagram: this change only edits tests.',
  copy_only: 'No diagram: this change only edits copy.',
  too_small: 'No diagram: this change is too small to need one.',
  no_flow: 'No diagram: no data moves through this change.',
  head_moved: 'New commits arrived while this was waiting. It is drawn again after the next review.',
  unreadable: 'The changes could not be read.',
  too_few_prs: 'The story has only one pull request.',
  too_many_prs: 'The story has too many pull requests to draw.',
  invalid_diagram: 'Claude did not return a usable design.',
};

/** A refusal in words, naming the provider that RAN the drawing (Claude's text is the table above). */
export function sequenceDiagramRefusalText(
  r: SequenceDiagramRefusal,
  by: AiProviderName = 'Claude',
  // A `no_flow` refusal's own reason (the view's `refusalDetail`), finishing "No diagram: …".
  detail?: string | null,
): string {
  if (r === 'invalid_diagram') return `${by} did not return a usable design.`;
  if (r === 'no_flow' && detail != null && detail.trim() !== '') return `No diagram: ${detail.trim().replace(/\.*$/, '')}.`;
  return SEQUENCE_DIAGRAM_REFUSAL_TEXT[r];
}

/** A story design is drawn over at most this many open or merged pull requests. */
export const SEQUENCE_DIAGRAM_STORY_MAX_PRS = 12;

export interface SequenceDiagramMember {
  prId: number;
  repo: string;
  number: number;
  title: string;
  state: 'open' | 'merged';
  headSha: string;
}

export interface SequenceDiagramView {
  id: number;
  kind: SequenceDiagramKind;
  // PR designs: the PR id. Story designs: null.
  prId: number | null;
  // Story designs: the tracker ident. PR designs: null.
  ticketIdent: string | null;
  // Story designs: the ticket's display key (e.g. 'ABC-12'), when known.
  ticketKey: string | null;
  status: SequenceDiagramStatus;
  trigger: SequenceDiagramTrigger;
  title: string | null;
  caption: string | null;
  // The validated data-flow diagram (succeeded runs only).
  flow: FlowDiagram | null;
  // A succeeded run drawn in the OLDER grid layout (before DESIGN_DIAGRAM_VERSION 2): rendered as it
  // was, marked as the old layout. Null on every new run.
  design: DesignDiagram | null;
  // PR designs: the head drawn.
  headSha: string | null;
  // Story designs: the pull requests drawn, in ref order (members[0] is 'PR1').
  members: SequenceDiagramMember[];
  refusal: SequenceDiagramRefusal | null;
  // A `no_flow` refusal: the model's reason, finishing "No diagram: …". Null otherwise.
  refusalDetail: string | null;
  // A failed run's message (plain words).
  error: string | null;
  // False when the PR's head (or the story's members) moved since this was drawn.
  current: boolean;
  createdAt: string;
  completedAt: string | null;
  costUsd: number | null;
  // What ran it (docs/CODEX-PLAN.md Phase 4): the model id and its provider. Optional: an older
  // server or row omits them — read through `aiRunLabel(provider, model)`.
  model?: string | null;
  provider?: AiProviderId;
}

/**
 * One subject's designs: what to DRAW and, beside it, the newest run when that is a different one
 * (drawing now, refused, failed) — so a failed redraw never hides the last good design.
 */
export interface SequenceDiagramSlot {
  // The newest SUCCEEDED design (null = none yet).
  diagram: SequenceDiagramView | null;
  // The newest run of any status, when it is not `diagram`.
  latest: SequenceDiagramView | null;
  // The last finished review skipped an automatic draw of this subject at its CURRENT inputs, and
  // why (in memory: lost on restart). Absent / null otherwise.
  autoSkipped?: SequenceDiagramAutoSkip | null;
}

export interface StorySequenceDiagramSlot extends SequenceDiagramSlot {
  ident: string;
  ticketKey: string | null;
  // Open + merged pull requests on the ticket right now (a story design needs 2+).
  memberCount: number;
}

/** GET /api/prs/:id/sequence-diagrams — the PR's design and its tickets' story designs. */
export interface PrSequenceDiagramsResponse {
  prId: number;
  pr: SequenceDiagramSlot;
  // Only tickets with 2+ open or merged pull requests, or with a stored story design.
  stories: StorySequenceDiagramSlot[];
}

/** GET /api/sequence-diagrams/story?ident= — one ticket's story design. */
export type TicketSequenceDiagramResponse = StorySequenceDiagramSlot;

export interface RedrawSequenceDiagramResponse {
  outcome: 'queued' | 'already_running' | 'refused';
  diagramId: number | null;
  refusal?: SequenceDiagramRefusal;
}

export interface RedrawStoryDiagramBody {
  ident: string;
}
