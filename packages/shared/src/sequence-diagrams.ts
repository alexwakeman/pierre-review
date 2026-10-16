// SEQUENCE DIAGRAMS (CORE, free, LOCAL ONLY — agentic; docs/CLAUDE-REVIEW.md § Sequence diagrams).
//
// A SEPARATE agentic process (Sonnet 5), never inside the PR review, the ticket review or the CI
// review. After every finished Claude Review of a pull request with CODE changes it draws:
//   'pr'     ONE diagram of the flow this PR's change touches, at its head;
//   'story'  when the PR is on a ticket with MORE THAN ONE open or merged PR, ONE diagram of the whole
//            story across every participating repository.
// A diagram is Mermaid source the SERVER validated (one block, an allowed type, no directives, links,
// click handlers or HTML) before storing it. The SPA renders it with Mermaid at securityLevel
// 'strict' and falls back to the source on a render error.

export type SequenceDiagramKind = 'pr' | 'story';
export type SequenceDiagramStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'refused' | 'cancelled';
// 'review' = started by a finished Claude Review (counts against SEQUENCE_DIAGRAM_DAILY_CAP);
// 'manual' = a Redraw click (never counts).
export type SequenceDiagramTrigger = 'review' | 'manual';

// Why a run stored no diagram, decided by the SERVER (never the model).
export type SequenceDiagramRefusal =
  | 'no_code' // the change touches no code (docs, config, lockfiles only)
  | 'head_moved' // the PR (or a member) moved while the run waited; the next review redraws it
  | 'unreadable' // the diff or a checkout could not be read
  | 'too_few_prs' // a story diagram needs more than one open or merged PR on the ticket
  | 'too_many_prs' // more members than SEQUENCE_DIAGRAM_STORY_MAX_PRS
  | 'invalid_diagram'; // the answer did not pass validation

export const SEQUENCE_DIAGRAM_REFUSAL_TEXT: Record<SequenceDiagramRefusal, string> = {
  no_code: 'No code changed, so there is no flow to draw.',
  head_moved: 'New commits arrived while this was waiting. It is drawn again after the next review.',
  unreadable: 'The changes could not be read.',
  too_few_prs: 'The story has only one pull request.',
  too_many_prs: 'The story has too many pull requests to draw.',
  invalid_diagram: 'Claude did not return a usable diagram.',
};

/** A story diagram is drawn over at most this many open or merged pull requests. */
export const SEQUENCE_DIAGRAM_STORY_MAX_PRS = 12;

/** The Mermaid diagram types a stored diagram may declare. Sequence diagrams are preferred. */
export const SEQUENCE_DIAGRAM_TYPES = [
  'sequenceDiagram',
  'flowchart',
  'graph',
  'stateDiagram-v2',
  'stateDiagram',
  'classDiagram',
  'erDiagram',
] as const;
export type SequenceDiagramType = (typeof SEQUENCE_DIAGRAM_TYPES)[number];

/** The largest Mermaid source the server stores (characters). */
export const SEQUENCE_DIAGRAM_MAX_CHARS = 20_000;

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
  // PR diagrams: the PR id. Story diagrams: null.
  prId: number | null;
  // Story diagrams: the tracker ident. PR diagrams: null.
  ticketIdent: string | null;
  // Story diagrams: the ticket's display key (e.g. 'ABC-12'), when known.
  ticketKey: string | null;
  status: SequenceDiagramStatus;
  trigger: SequenceDiagramTrigger;
  title: string | null;
  caption: string | null;
  diagramType: SequenceDiagramType | null;
  // Validated Mermaid source (succeeded runs only).
  source: string | null;
  // PR diagrams: the head drawn.
  headSha: string | null;
  // Story diagrams: the pull requests drawn.
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
 * One subject's diagrams: what to DRAW and, beside it, the newest run when that is a different one
 * (drawing now, refused, failed) — so a failed redraw never hides the last good diagram.
 */
export interface SequenceDiagramSlot {
  // The newest SUCCEEDED diagram (null = none yet).
  diagram: SequenceDiagramView | null;
  // The newest run of any status, when it is not `diagram`.
  latest: SequenceDiagramView | null;
}

export interface StorySequenceDiagramSlot extends SequenceDiagramSlot {
  ident: string;
  ticketKey: string | null;
  // Open + merged pull requests on the ticket right now (a story diagram needs 2+).
  memberCount: number;
}

/** GET /api/prs/:id/sequence-diagrams — the PR's diagram and its tickets' story diagrams. */
export interface PrSequenceDiagramsResponse {
  prId: number;
  pr: SequenceDiagramSlot;
  // Only tickets with 2+ open or merged pull requests, or with a stored story diagram.
  stories: StorySequenceDiagramSlot[];
}

/** GET /api/sequence-diagrams/story?ident= — one ticket's story diagram. */
export type TicketSequenceDiagramResponse = StorySequenceDiagramSlot;

export interface RedrawSequenceDiagramResponse {
  outcome: 'queued' | 'already_running' | 'refused';
  diagramId: number | null;
  refusal?: SequenceDiagramRefusal;
}

export interface RedrawStoryDiagramBody {
  ident: string;
}
