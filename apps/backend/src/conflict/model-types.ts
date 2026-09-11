import type {
  ConflictLandStrategy,
  ConflictOpenErrorCode,
  ConflictRegionKind,
  ConflictUnsupportedReason,
  ConflictWandSuggestion,
} from '@pierre-review/shared';

/**
 * BACKEND-INTERNAL model types. ⚠ NONE of this reaches `packages/shared` — the wire types
 * are the whole contract with the SPA, and everything here is either bigger than the wire
 * (raw side buffers) or a detail the client must never depend on (blob oids, stage modes,
 * the merged tree the land path seeds from).
 *
 * The model is pinned to `(headSha, baseSha)` and worthless the instant either moves. It is
 * never stored: no table, no migration, no `accountScopedTables()` entry.
 */

/** One region, as the server holds it. The wire projection empties `ours`/`theirs` on an
 *  `unchanged` region and drops `mergedLines`. */
export interface ConflictModelRegion {
  /** Stable within its file for the life of this pinned pair. Assigned in region order. */
  id: number;
  kind: ConflictRegionKind;
  base: string[];
  ours: string[];
  theirs: string[];
  /** sha256 of `base \0 ours \0 theirs`. The CONTENT pin for the Pro suggestion route. */
  fingerprint: string;
  wand: ConflictWandSuggestion | null;
  /**
   * The wand's deterministic word-level merge, computed EAGERLY for every contested region
   * — it is pure CPU over strings already in memory, it is what the wand button keys on, and
   * a lazy second path could disagree with the first.
   *
   * ⚠ Non-null iff `wand?.reason === 'disjoint_words'`. The land path resolves a
   * `disjoint_merge` decision from HERE, never by recomputing: the fold that lands must be
   * the fold that was reviewed. Its terminator is the OURS side's, per the fold's rule 4.
   */
  mergedLines: string[] | null;
}

/** One file, as the server holds it. */
export interface ConflictModelFile {
  index: number;
  /** Repo-relative, mangling already stripped. */
  path: string;
  /** The other paths named in this file's conflict messages (rename/rename names both). */
  relatedPaths: string[];
  unsupported: ConflictUnsupportedReason | null;
  unsupportedLabel: string | null;
  regions: ConflictModelRegion[];
  terminators: { base: boolean; ours: boolean; theirs: boolean };
  /** Largest of the three sides in bytes, so the SPA can warn before fetching the file. */
  maxSideBytes: number;
  /**
   * The stage-2 mode — the mode the resolved blob is written back with. `null` when stage 2
   * is absent (a path only one side has), which also means the file is not resolvable.
   * ⚠ The land path reads this; differing stage 2/3 modes are `mode_change` and never
   * reach `resolvedPaths`.
   */
  stage2Mode: string | null;
}

export interface ConflictModel {
  accountId: number;
  prId: number;
  owner: string;
  name: string;
  number: number;

  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;

  /** The common ancestor, from `merge-base --all`. `null` when the history is criss-cross.
   *  ⚠ USED ONLY for the rebase commit count. The `base` TEXT of every region comes from
   *  merge-tree's stage 1, which on a criss-cross is a VIRTUAL base matching neither
   *  candidate — MEASURED: two candidates read `x/MID/yA` and `xB/MID/y` while stage 1 was
   *  `xB/MID/yA`. A second base resolution is how "keep the ancestor" comes to commit bytes
   *  the pane never showed. */
  mergeBaseSha: string | null;
  mergeBaseIsVirtual: boolean;

  /** merge-tree's written tree. The land path's FULL branch seeds `read-tree` from it. */
  mergedTreeSha: string;

  files: ConflictModelFile[];
  /** Every conflicted path merge-tree named, including the ones the caps stopped us from
   *  extracting — so the UI can print a denominator instead of a shortened list. */
  totalConflictedPaths: number;
  truncated: boolean;
  renameDetection: 'on' | 'off';

  /** Commits on head above the merge base. Rebase is offered at exactly 1. */
  commitsAboveBase: number;
  strategies: ConflictLandStrategy[];
  rebaseUnavailableReason: string | null;
  /** Can we push to the PR's own head branch? A fork PR without maintainer edits cannot.
   *  ⚠ NOT the authorisation — `landConflictResolution` re-reads both facts from GitHub
   *  immediately before the push. This is what lets the landing step stop OFFERING an option
   *  that can only end in `PushDenied`. Defaults TRUE when the live read failed. */
  prBranchPushable: boolean;
  prBranchUnavailableReason: string | null;
  /** The repo default branch and the PR base ref — refused BY NAME as a new-branch target. */
  reservedBranchNames: string[];
}

/**
 * What the builder returns.
 *
 * `clean` carries a model with no files: the merge has no conflicts at all, which the SPA
 * says out loud. Discovery must never invent work — `text_disjoint_lines` in the fixtures
 * exists to prove two edits git auto-merges land here and not in `ready`.
 *
 * `moved` is the pin mismatch the land path re-derives against: the caller asked for a
 * specific `(headSha, baseSha)` and the refs say otherwise.
 */
export type ConflictModelResult =
  | { status: 'ready'; model: ConflictModel }
  | { status: 'clean'; model: ConflictModel }
  | { status: 'moved'; headSha: string; baseSha: string }
  | { status: 'failed'; code: ConflictOpenErrorCode; message: string };
