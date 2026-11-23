// "EXPLAIN WHAT'S BLOCKING" on This Sprint → Releases (docs/RELEASES.md § Explain what's blocking;
// docs/CLAUDE-REVIEW.md § Release blockers). A reader's press runs ONE model completion over the release
// check the server already holds and stores a short report per workspace. The wire shapes live here.
//
//   • The report names ONLY tickets and pull requests that are in the check: the server drops any point
//     that cites anything else (`dropped` counts them) and refuses an answer whose headline does.
//   • `stale`: the check changed since the report was written (its input hash differs). Nothing re-runs
//     on its own.

/** A ticket the report cites, as the check holds it (`url` → `safeExternalUrl` before use). */
export interface ReleaseBlockersTicketRef {
  ident: string;
  key: string;
  title: string | null;
  url: string | null;
}

/** A pull request the report cites (`url` → `safeExternalUrl` before use; `prId` = the PR tab). */
export interface ReleaseBlockersPrRef {
  repoName: string;
  number: number;
  title: string | null;
  url: string;
  prId: number | null;
}

/** One thing to do, in order: what to do, what it unlocks, and the work it names. */
export interface ReleaseBlockersStep {
  text: string;
  /** The release it unlocks ("bng-metric-backend 0.324.0 and later"); null = not said. */
  unlocks: string | null;
  tickets: ReleaseBlockersTicketRef[];
  prs: ReleaseBlockersPrRef[];
}

/** Why one repository's newer tags cannot be released. */
export interface ReleaseBlockersRepoNote {
  repoName: string;
  text: string;
}

export interface ReleaseBlockersReport {
  /** One or two sentences: what holds the newest release back. */
  headline: string;
  steps: ReleaseBlockersStep[];
  repos: ReleaseBlockersRepoNote[];
  /** Points left out because they named work that is not in the check. */
  dropped: number;
  /** ISO. */
  writtenAt: string;
  /** What ran (`aiRunLabel`). */
  model: string | null;
  provider: 'claude' | 'codex' | null;
  costUsd: number | null;
}

/** The report's state, carried on GET /api/releases (absent / null = AI is off here). */
export interface ReleaseBlockersState {
  /** The check is decided and some repository has newer tags it cannot release: the button shows. */
  explainable: boolean;
  /** The last report for this workspace (null = none yet). */
  report: ReleaseBlockersReport | null;
  /** The check changed since the report was written. */
  stale: boolean;
}

/** POST /api/releases/blockers?workspace=<id> — run the report (a reader's press). */
export interface ReleaseBlockersRunResponse {
  workspaceId: number;
  blockers: ReleaseBlockersState;
}

/** Caps on what the model may write (characters / items). */
export const RELEASE_BLOCKERS_CAPS = {
  headline: 400,
  step: 300,
  unlocks: 200,
  steps: 8,
  repoNote: 400,
  refsPerStep: 8,
} as const;
