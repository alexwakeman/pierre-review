// "EXPLAIN WHAT'S BLOCKING" on This Sprint → Releases (docs/RELEASES.md § Explain what's blocking;
// docs/CLAUDE-REVIEW.md § Release blockers). A reader's press runs ONE model completion over the RELEASE
// GRAPH (shared `releaseGraph`: the ladders and the code's plan) and stores a short report per workspace.
// The wire shapes live here.
//
//   • THE TEXTS CARRY IDS. The model cites work ONLY as short ids in braces — "Finish {T3} and merge {P7}
//     so {R2} can be released." — and `refs` resolves every id the texts keep (tickets `T…`, pull requests
//     `P…`, release points `R…`). Draw a text with `releaseBlockersSegments`: plain text and refs, in order,
//     so every ticket and pull request is an INLINE link. An id `refs` does not hold stays plain text.
//   • The server drops any point that cites an id or a key not in the input (`dropped` counts them).
//   • `stale`: the graph changed since the report was written (its input hash differs). Nothing re-runs on
//     its own. A report stored in an older shape reads as NO report (`version` below).

/** The stored report's shape. A stored report without it (the shape before ids) reads as none. */
export const RELEASE_BLOCKERS_REPORT_VERSION = 2;

/** A ticket a text cites. `ident` null = the tracker names it, the check does not (no story view: link `url`). */
export interface ReleaseBlockersTicketRef {
  kind: 'ticket';
  id: string;
  ident: string | null;
  key: string;
  title: string | null;
  /** The tracker link (→ `safeExternalUrl` before use). */
  url: string | null;
}

/** A pull request a text cites. `prId` = the PR tab (with `repoFullName`); else link `url` (→ `safeExternalUrl`). */
export interface ReleaseBlockersPrRef {
  kind: 'pr';
  id: string;
  repoName: string;
  repoFullName: string | null;
  number: number;
  title: string | null;
  url: string | null;
  prId: number | null;
  /** Merged after the newest version tag: it needs a new version tag. */
  needsNewTag: boolean;
}

/** A release point a text cites: a version tag, or (released from pull requests) `#539`. Plain text. */
export interface ReleaseBlockersPointRef {
  kind: 'point';
  id: string;
  repoName: string;
  tagName: string;
}

export type ReleaseBlockersRef = ReleaseBlockersTicketRef | ReleaseBlockersPrRef | ReleaseBlockersPointRef;

/** One thing to do, in the plan's order. `text` carries `{id}`s. */
export interface ReleaseBlockersStep {
  text: string;
}

/** Why one repository's newer tags cannot be released. `text` carries `{id}`s. */
export interface ReleaseBlockersRepoNote {
  repoName: string;
  text: string;
}

export interface ReleaseBlockersReport {
  version: typeof RELEASE_BLOCKERS_REPORT_VERSION;
  /** One or two sentences: what holds the newest reachable release back. Null = it was left out. */
  headline: string | null;
  steps: ReleaseBlockersStep[];
  repos: ReleaseBlockersRepoNote[];
  /** Every id the texts keep → what it names. */
  refs: Record<string, ReleaseBlockersRef>;
  /** Points left out because they named work that is not in the check. */
  dropped: number;
  /** ISO. */
  writtenAt: string;
  /** What ran (`aiRunLabel`). */
  model: string | null;
  provider: 'claude' | 'codex' | null;
  costUsd: number | null;
  /** How long the run took, every attempt included (null = not recorded). */
  durationMs: number | null;
}

/** The report's state, carried on GET /api/releases (absent / null = AI is off here). */
export interface ReleaseBlockersState {
  /** The check is decided and some repository has newer tags it cannot release: the button shows. */
  explainable: boolean;
  /** The last report for this workspace (null = none yet, or one in an older shape). */
  report: ReleaseBlockersReport | null;
  /** The check changed since the report was written. */
  stale: boolean;
}

/** POST /api/releases/blockers?workspace=<id> — run the report (a reader's press). */
export interface ReleaseBlockersRunResponse {
  workspaceId: number;
  blockers: ReleaseBlockersState;
}

/** Caps on what the model may write (characters / items). A text over its cap is dropped, never cut. */
export const RELEASE_BLOCKERS_CAPS = {
  headline: 300,
  step: 240,
  /** = the plan's most moves (`RELEASE_PLAN_MOVES_MAX`). */
  steps: 8,
  repoNote: 280,
  repos: 6,
} as const;

/** One piece of a text: plain words, or a cited ref (an inline link). */
export type ReleaseBlockersSegment = { kind: 'text'; text: string } | { kind: 'ref'; ref: ReleaseBlockersRef };

/** `{T3}` / `{P12}` / `{R1}`: an id as the texts carry it. */
export const RELEASE_BLOCKERS_ID_IN_TEXT = /\{([TPR]\d{1,4})\}/g;

/**
 * A text as segments, in order: each `{id}` that `refs` holds becomes a ref; everything else (an id it does
 * not hold included) stays text. Adjacent text is merged; empty text is never emitted. Pure.
 */
export function releaseBlockersSegments(text: string, refs: Record<string, ReleaseBlockersRef>): ReleaseBlockersSegment[] {
  const out: ReleaseBlockersSegment[] = [];
  const pushText = (s: string): void => {
    if (s === '') return;
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text += s;
    else out.push({ kind: 'text', text: s });
  };
  let at = 0;
  for (const m of text.matchAll(RELEASE_BLOCKERS_ID_IN_TEXT)) {
    const ref = Object.prototype.hasOwnProperty.call(refs, m[1]!) ? refs[m[1]!] : undefined;
    const i = m.index ?? 0;
    pushText(text.slice(at, i));
    if (ref != null) out.push({ kind: 'ref', ref });
    else pushText(m[0]);
    at = i + m[0].length;
  }
  pushText(text.slice(at));
  return out;
}

/** A ref's visible words: the ticket key, "web #518", "api 0.330.0". */
export function releaseBlockersRefLabel(ref: ReleaseBlockersRef): string {
  switch (ref.kind) {
    case 'ticket':
      return ref.key;
    case 'pr':
      return `${ref.repoName} #${ref.number}`;
    case 'point':
      return `${ref.repoName} ${ref.tagName}`;
  }
}
