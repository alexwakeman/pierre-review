// DESIGN DIAGRAMS (CORE, free, LOCAL ONLY — agentic; docs/CLAUDE-REVIEW.md § Design diagrams).
//
// A SEPARATE agentic process (Sonnet 5), never inside the PR review, the ticket review or the CI
// review. After every finished Claude Review of a pull request with CODE changes it draws:
//   'pr'     ONE design of how this PR's change is built, at its head;
//   'story'  when the PR is on a ticket with MORE THAN ONE open or merged PR, ONE design of the whole
//            story across every participating repository.
// A design is a small GRID, not a picture: at most DESIGN_MAX_ACTS stages (columns) across at most
// DESIGN_MAX_LAYERS layers (rows) of the FIXED `DESIGN_LAYERS` vocabulary, at most one card per
// (stage, layer), each naming a RESPONSIBILITY and the pattern used. The SERVER validates every field
// (caps, plain text, file paths filtered to the change) before storing it; the SPA draws it as a CSS
// grid (components/DesignGrid.tsx). The type and route names keep "sequence diagram" (the table,
// routes and queue are the ones the retired Mermaid sequence diagrams used); what a run produces is a
// `DesignDiagram`.
//
// ⚠ THE LAYER VOCABULARY IS PROVISIONAL — the user is trialling it. Every cap below is spelled ONCE
// here and read by the validator, the prompt and the renderer.

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

export type SequenceDiagramKind = 'pr' | 'story';
export type SequenceDiagramStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'refused' | 'cancelled';
// 'review' = started by a finished Claude Review (counts against SEQUENCE_DIAGRAM_DAILY_CAP);
// 'manual' = a Redraw click (never counts).
export type SequenceDiagramTrigger = 'review' | 'manual';

// Why a run stored no design, decided by the SERVER (never the model).
export type SequenceDiagramRefusal =
  | 'no_code' // the change touches no code (docs, config, lockfiles only)
  | 'head_moved' // the PR (or a member) moved while the run waited; the next review redraws it
  | 'unreadable' // the diff or a checkout could not be read
  | 'too_few_prs' // a story design needs more than one open or merged PR on the ticket
  | 'too_many_prs' // more members than SEQUENCE_DIAGRAM_STORY_MAX_PRS
  | 'invalid_diagram'; // the answer did not pass validation

export const SEQUENCE_DIAGRAM_REFUSAL_TEXT: Record<SequenceDiagramRefusal, string> = {
  no_code: 'No code changed, so there is no design to draw.',
  head_moved: 'New commits arrived while this was waiting. It is drawn again after the next review.',
  unreadable: 'The changes could not be read.',
  too_few_prs: 'The story has only one pull request.',
  too_many_prs: 'The story has too many pull requests to draw.',
  invalid_diagram: 'Claude did not return a usable design.',
};

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
  // The validated design (succeeded runs only).
  design: DesignDiagram | null;
  // PR designs: the head drawn.
  headSha: string | null;
  // Story designs: the pull requests drawn, in ref order (members[0] is 'PR1').
  members: SequenceDiagramMember[];
  refusal: SequenceDiagramRefusal | null;
  // A failed run's message (plain words).
  error: string | null;
  // False when the PR's head (or the story's members) moved since this was drawn.
  current: boolean;
  createdAt: string;
  completedAt: string | null;
  costUsd: number | null;
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
