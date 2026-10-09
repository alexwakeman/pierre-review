/* ═══════════════════════════════════════════════════════════════════════════════════════
   RESOLVE WITH CLAUDE — the agentic merge-conflict resolver's wire (CORE, free, LOCAL ONLY).

   Claude reads the conflicts of ONE resolver session (`conflicts.ts`) plus the repository at the
   PR's head, and answers with RESOLVER DECISIONS — one per region it settles, each an enum member
   the region allows or an `'edited'` region whose lines went through the SAME server-side
   validation as `POST …/conflicts/edit` and travel as an opaque `editId`. It never writes bytes
   outside a region, and nothing is committed or pushed by the run: the reader reviews the answer
   IN THE RESOLVER and presses "Commit and push" themselves.

   ⚠ NOTHING HERE IS STORED. The answer lives on the in-memory conflict session it was computed
   against, pinned to the same (headSha, baseSha, modelHash), and dies with it — no table, no
   migration. Its cost is recorded on the usage ledger like every agent run.
   ═══════════════════════════════════════════════════════════════════════════════════════ */

import type { ConflictDecision } from './conflicts.js';

/** `preparing` — the conflict session is being built (clone, fetch, merge-tree).
 *  `running`   — Claude is reading and deciding.
 *  The rest are terminal. */
export type ConflictAiStatus = 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** How sure Claude says it is about ONE region. Its own words, shown beside the choice — never an
 *  input to anything. */
export type ConflictAiConfidence = 'high' | 'medium' | 'low';

/** One region Claude settled. ⚠ `decision` is never `'suggestion'`; an `'edited'` choice carries
 *  the handle the commit body sends and the SERVER's own split of the stored lines (what the
 *  centre pane renders — the edit route's rule). */
export interface ConflictAiChoice {
  fileIndex: number;
  regionId: number;
  decision: ConflictDecision;
  editId: string | null;
  lines: string[] | null;
  /** One line, Claude's. Clipped server-side. */
  rationale: string;
  confidence: ConflictAiConfidence;
}

export interface ConflictAiResolution {
  /** A fresh id per run, so the SPA applies one answer once. */
  runId: string;
  prId: number;
  /** The conflict session this answer belongs to. Empty while `preparing` has not got one yet. */
  sessionId: string;
  headSha: string;
  baseSha: string;
  modelHash: string;
  baseRef: string;
  status: ConflictAiStatus;
  /** Server-authored, one sentence, rendered verbatim. Null unless failed. */
  error: string | null;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  /** Every region Claude settled that passed validation. */
  choices: ConflictAiChoice[];
  /** Decidable regions in the files the resolver supports — the denominator of "Claude decided
   *  N of M". */
  decidableTotal: number;
  /** Claude's own one-paragraph summary, or null. */
  summary: string | null;
  costUsd: number | null;
  /** The last few things the agent did, for the progress line. Absent once settled. */
  recentActivity?: string[];
}

export interface ConflictAiStartBody {
  /** One of `CLAUDE_REVIEW_MODELS`. Omitted ⇒ `DEFAULT_AI_FIX_MODEL`. */
  model?: string;
}

export interface ConflictAiStatusResponse {
  /** This account's latest answer for the PR, or null when there is none (never run, or its
   *  session has expired). */
  resolution: ConflictAiResolution | null;
}

/** The model may decide these; `'suggestion'` is the Pro per-hunk handle and never Claude's. */
export const CONFLICT_AI_DECISIONS: readonly ConflictDecision[] = [
  'base',
  'ours',
  'theirs',
  'both_ours_first',
  'both_theirs_first',
  'disjoint_merge',
  'edited',
];
