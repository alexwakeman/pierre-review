/* ═══════════════════════════════════════════════════════════════════════════════════════
   MERGE-CONFLICT RESOLVER — the wire (CORE / free, BOTH MODES).

   LEFT is the PR branch ("Your version"), RIGHT is the base branch ("Changes from <base>"),
   CENTRE is the result, seeded from the merge base and changed only by per-region decisions.
   The merge base is not a pane.

   ⚠ ONE ROUTE ON THIS WIRE ACCEPTS TYPED TEXT, AND THE COMMIT IS NOT IT. This used to read
   "NOTHING ON THIS WIRE ACCEPTS FILE CONTENT FROM THE CLIENT", full stop. Half of that moved
   and half of it did not, and the two halves are worth separating because only one of them was
   ever the safety property.

     WHAT MOVED. `POST …/conflicts/edit` takes the lines a reader typed for ONE region — region
     -scoped, pinned by `fingerprint`, and validated SERVER-SIDE (text-ness, no surviving
     conflict marker, a size cap) BEFORE an id exists for it. A refusal mints nothing, so there
     is no handle to redeem.

     WHAT DID NOT. The COMMIT body still carries nothing but indexes, ids and enum members. The
     server folds its OWN regions through `foldFile` and hashes the result with
     `git hash-object`; a `'suggestion'` or `'edited'` decision names text the SERVER holds, by
     an opaque handle it minted. So the property that actually mattered — the server commits
     only bytes it folded, from a request that names no content — survives verbatim.

   Resolved text therefore still exists in exactly two places: the server's in-memory session,
   and the read-only payloads the server sends down.

   ⚠ NOTHING HERE IS STORED. No table, no migration. The model is pinned to (headSha, baseSha)
   and worthless the instant either moves.
   ═══════════════════════════════════════════════════════════════════════════════════════ */

export type ConflictSessionStatus = 'preparing' | 'ready' | 'clean' | 'failed';

/** Progress while `preparing`. Wire vocabulary, NOT copy — the SPA renders its own sentence. */
export type ConflictPreparePhase = 'cloning' | 'fetching' | 'merging' | 'reading';

export type ConflictOpenErrorCode =
  | 'git_too_old'
  | 'unrelated_histories'
  | 'objects_unavailable'
  | 'too_many_files'
  | 'timeout'
  | 'not_open';

/** Why a file cannot be resolved here. Listed and DISABLED, never hidden — an unlisted file
 *  is why the PR stays conflicted after a commit, with nothing on screen to explain it. */
export type ConflictUnsupportedReason =
  | 'binary'
  | 'submodule'
  | 'symlink'
  | 'file_directory'
  | 'rename_rename'
  | 'rename_delete'
  | 'modify_delete'
  | 'mode_change'
  | 'not_text' //           legal bytes, not valid UTF-8 — refused, never lossily decoded
  | 'too_large'
  | 'too_many_conflicts'
  | 'no_common_ancestor'
  | 'engine_disagreement' // git contests something our chunker merged silently
  | 'budget_exhausted'; //  the per-session byte/file cap stopped before this one

export interface ConflictFileEntry {
  /** Index into `ConflictSession.files`. THE addressing key for the per-file route. */
  index: number;
  /** Repo-relative, display only. `~<sha>` mangling already stripped. */
  path: string;
  /** The other paths in this file's conflict messages (rename/rename names both). */
  relatedPaths: string[];
  /** null ⇒ resolvable. Non-null ⇒ the dropdown row is disabled. */
  unsupported: ConflictUnsupportedReason | null;
  /** A NOUN PHRASE naming the reason — no instruction, no trailing full stop.
   *  The panel states "N files need resolving on GitHub." once, above the list. */
  unsupportedLabel: string | null;
  /** Every region, all kinds. 0 when unsupported. */
  regionCount: number;
  /** Regions where both sides disagree. */
  conflictCount: number;
  /** Regions that take a decision — every kind except `unchanged`.
   *  ⚠ THE COMMIT GATE COUNTS THESE ACROSS EVERY FILE, INCLUDING ONES NOBODY OPENED, so it can
   *  be neither `regionCount` (which includes context) nor `conflictCount` (which leaves out
   *  one-sided changes). It is also the header's denominator. */
  decidableCount: number;
  /** Of `conflictCount`, how many the wand can settle without picking a side. */
  wandResolvableCount: number;
  /** Largest of the three sides, so the SPA can warn before fetching the file. */
  maxSideBytes: number;
}

/** One line on one side. `n` is that SIDE's 1-based file line number. No padding on the
 *  wire — aligning the panes is the renderer's job. Text NEVER carries its terminator. */
export interface ConflictLine {
  n: number;
  text: string;
}

/**  `unchanged`   — identical in all three. `ours`/`theirs` are EMPTY; read `base`.
 *   `ours_only`   — only the PR branch changed it.
 *   `theirs_only` — only the base branch changed it.
 *   `both_same`   — both made the identical edit.
 *   `conflict`    — both changed it, differently. */
export type ConflictRegionKind =
  | 'unchanged'
  | 'ours_only'
  | 'theirs_only'
  | 'both_same'
  | 'conflict';

/**  `base`              — the merge base's lines for THIS region. On a one-sided region it
 *                         means "don't apply that change"; on a contested one it means
 *                         "keep the ancestor". SAME BYTES, so ONE member — the distinction
 *                         the reader needs is a LABEL, derived from `region.kind`, and a
 *                         second member for identical output invites a fold that diverges.
 *   `ours` / `theirs`   — that side's lines.
 *   `both_ours_first`   — ours then theirs.  `both_theirs_first` — theirs then ours.
 *   `disjoint_merge`    — the wand's deterministic word-level merge. ITS LINES RIDE THE WIRE on
 *                         `region.mergedLines`; see the ⚠ there for why the client may not
 *                         recompute them.
 *   `suggestion`        — a Pro per-hunk model resolution the user accepted, addressed by
 *                         `suggestionId`; the lines live in the server session.
 *   `edited`            — lines the READER typed for this region, addressed by `editId`; the
 *                         lines live in the server session, exactly as a suggestion's do.
 *
 *  ⚠ THE RULE IS NOT "NO TYPED TEXT" — IT IS THAT TEXT REACHES THE FOLD ONLY THROUGH A
 *  SERVER-HELD HANDLE, NEVER INLINE ON THE COMMIT. This replaces "there is no `custom` member
 *  and there must never be one", which `'edited'` makes false as written. A `custom` member
 *  carrying its lines in the commit body would still be forbidden, and for the reason that
 *  sentence was really protecting: the server would then be committing bytes it never read,
 *  validated, or showed anybody. `'edited'` carries an ID. The text was validated on its own
 *  route, before the id existed, and is spliced from the session — the `'suggestion'`
 *  mechanism, reused. */
export type ConflictDecision =
  | 'base'
  | 'ours'
  | 'theirs'
  | 'both_ours_first'
  | 'both_theirs_first'
  | 'disjoint_merge'
  | 'suggestion'
  | 'edited';

/** Why the wand would take a region, in its own words — it must be able to say exactly what
 *  it did, so the reason rides every region it touches.
 *  ⚠ There is no member meaning "we picked the better one", because it never does. */
export type ConflictWandReason =
  | 'only_ours'
  | 'only_theirs'
  | 'both_same'
  | 'disjoint_words';

export interface ConflictWandSuggestion {
  decision: ConflictDecision;
  reason: ConflictWandReason;
}

export interface ConflictRegion {
  /** Stable within its file for the life of this pinned (headSha, baseSha) pair. */
  id: number;
  kind: ConflictRegionKind;
  /** sha256 of `base \0 ours \0 theirs` as the server derived them. The CONTENT pin for the
   *  Pro suggestion route; `id` is the ADDRESS. */
  fingerprint: string;
  /** ⚠ On `unchanged`, `ours` and `theirs` are EMPTY ARRAYS — not copies of `base`. */
  base: ConflictLine[];
  ours: ConflictLine[];
  theirs: ConflictLine[];
  /** What the centre starts on. Auto-apply on (the default) ⇒ a one-sided region defaults to
   *  its own side, `both_same` to `ours`, and a genuine conflict to `base` (undecided). */
  defaultDecision: ConflictDecision;
  /** Offerable buttons. `unchanged` → `['base']`; one-sided → its side + `base`; `both_same`
   *  → `['ours','base']`; `conflict` → the five deterministic members, plus `disjoint_merge`
   *  iff `wand?.reason === 'disjoint_words'`.
   *  ⚠ NEITHER `'suggestion'` NOR `'edited'` EVER APPEARS HERE — both are session facts, not
   *  model facts. Whether a region may be edited is `kind !== 'unchanged'`, which this list
   *  already says by existing at all. */
  allowed: ConflictDecision[];
  /** null when the wand would leave this region alone — including every contested conflict
   *  whose two edits are not provably disjoint. */
  wand: ConflictWandSuggestion | null;
  /**
   * The wand's word-level merge, as lines — the EXACT bytes a `'disjoint_merge'` decision
   * splices at commit. Non-null iff `wand?.reason === 'disjoint_words'`.
   *
   * ⚠ IT RIDES THE WIRE BECAUSE THE CLIENT MAY NOT RECOMPUTE IT. This field used to be absent
   * on the argument that "the server recomputes it from the same word diff" — but the server
   * does not recompute anything, it stores what it computed at model build, and the SPA's
   * second implementation of the same algorithm was not the same algorithm. Cross-checked over
   * 4,000 generated three-way regions: the client dropped every pure INSERTION (its base→side
   * position mapping counted a zero-width change as lying before the position it starts at), so
   * the centre pane rendered the ANCESTOR for a region the commit landed MERGED. Two
   * implementations of one fold is the defect; `packages/shared/src/conflict-fold.ts` exists so
   * there is exactly one, and this is the payload that lets the SPA use it.
   */
  mergedLines: string[] | null;
}

/** Does each side's file end with a newline? The FOLD rule: the terminator of the committed
 *  file is the one belonging to the LAST region's chosen source — the second side for a
 *  both-ordering, `ours` for `disjoint_merge`, and its own stored one for `suggestion` and
 *  `edited` (the server sets an edit's from the OURS side; a reader edits lines inside a
 *  region, not the file's final newline). */
export interface ConflictFileTerminators {
  base: boolean;
  ours: boolean;
  theirs: boolean;
}

/** The regions of ONE file. Fetched on selection, never as part of the session: a 30-file
 *  conflict carrying regions inline is a multi-megabyte manifest. */
export interface ConflictFileContent {
  index: number;
  path: string;
  terminators: ConflictFileTerminators;
  regions: ConflictRegion[];
}

export type ConflictLandStrategy = 'merge' | 'rebase';

export type ConflictCommitPhase =
  | 'preparing'
  | 'fetching'
  | 'merging'
  | 'committing'
  | 'pushing'
  | 'confirming';

export type ConflictLandErrorCode =
  | 'ModelStale'
  | 'HeadMoved'
  | 'BaseMoved'
  | 'SessionExpired'
  | 'NoConflicts'
  | 'NotPermitted'
  | 'NothingToCommit'
  | 'UnknownFileIndex'
  | 'IncompleteDecisions'
  | 'UnknownSuggestion'
  /** An `editId` the session no longer holds, or one addressing a DIFFERENT region or file.
   *  Its own code beside `UnknownSuggestion` because they are two different facts with two
   *  different sentences — one sends the reader back to Claude, the other back to their own
   *  text. */
  | 'UnknownEdit'
  | 'InvalidBranch'
  | 'ReservedBranch'
  | 'BranchExists'
  | 'PushDenied'
  | 'RebaseNotOffered'
  | 'GitFailed'
  | 'Cancelled';

export interface ConflictCommitState {
  status: 'running' | 'done' | 'failed';
  phase: ConflictCommitPhase | null;
  result: ConflictCommitResult | null;
  error: { code: ConflictLandErrorCode; message: string } | null;
}

export interface ConflictSession {
  sessionId: string;
  prId: number;
  status: ConflictSessionStatus;
  phase: ConflictPreparePhase | null;
  error: { code: ConflictOpenErrorCode; message: string } | null;

  /* ---- The pins. The commit refuses if head moved, or if `modelHash` differs. ---- */
  headSha: string;
  baseSha: string;
  /** sha256 over the canonical model serialisation, `CONFLICT_MODEL_VERSION` included.
   *  Echoed back on commit; a mismatch is `ModelStale` and nothing is written. */
  modelHash: string;
  /** The common ancestor. `null` when the history is criss-cross and merge-tree used a
   *  VIRTUAL base — the region's own `base` lines are authoritative either way. */
  mergeBaseSha: string | null;
  mergeBaseIsVirtual: boolean;
  baseRef: string;
  headRef: string;

  /* ---- The model ---- */
  files: ConflictFileEntry[];
  /** A SUBSET of `files` by index, not a second population — carried so the SPA can say
   *  "3 of 12 need resolving on GitHub" without a fold. */
  unsupportedIndexes: number[];
  fullyResolvable: boolean;
  /** True when `defaultDecision` already includes the auto-apply pass. */
  autoApplied: boolean;
  /** Rename detection was turned off to stay inside the blob-prefetch cap; rename/rename and
   *  rename/delete then present as add/delete pairs. Stated on screen, never silently. */
  renameDetection: 'on' | 'off';
  /** Conflicted paths merge-tree named but the caps stopped us extracting. */
  truncated: boolean;
  totalConflictedPaths: number;

  /* ---- Landing ---- */
  strategies: ConflictLandStrategy[];
  /** Why `rebase` is absent, when it is. One sentence, server-authored. */
  rebaseUnavailableReason: string | null;
  /** Can the resolution be pushed to the pull request's OWN head branch? False for a fork PR
   *  whose author did not allow maintainer edits — that branch lives in somebody else's
   *  repository. The landing step HIDES the "Push to <headRef>" option when this is false.
   *
   *  ⚠ A UI AFFORDANCE, NEVER THE AUTHORISATION. The land route re-reads both facts from
   *  GitHub milliseconds before the push and answers `PushDenied`; this field exists so the
   *  option is not offered, not so the check can move to the client.
   *  ⚠ TRUE IS THE FALLBACK. It comes from one live REST call at session build, which is
   *  deliberately non-fatal: when that call fails the session says `true` with a null reason
   *  and the land route refuses — the behaviour that shipped before this field existed. */
  prBranchPushable: boolean;
  /** Why the PR branch cannot be pushed to, when it cannot. One sentence, server-authored and
   *  rendered verbatim, exactly like `rebaseUnavailableReason`. Null when pushable. */
  prBranchUnavailableReason: string | null;
  /** The repo default branch and the PR base ref — refused BY NAME as a new-branch target. */
  reservedBranchNames: string[];
  commit: ConflictCommitState | null;
}

/* ---- Requests ---- */

export interface ConflictOpenBody {
  /** Default true. False starts every region at `base`. */
  autoApply?: boolean;
  /** Discard a live session and rebuild against the CURRENT shas. */
  restart?: boolean;
}

export interface ConflictRegionDecision {
  id: number;
  decision: ConflictDecision;
  /** Required iff `decision === 'suggestion'`. Addresses text the SERVER holds. */
  suggestionId?: string;
  /** Required iff `decision === 'edited'`. Addresses text the SERVER holds — minted by
   *  `POST …/conflicts/edit` AFTER validating the lines, so an id that exists is an id whose
   *  text was checked. ⚠ It must be DECLARED in the commit route's ajv schema: that schema is
   *  `additionalProperties: false`, and a field it does not name is stripped SILENTLY, which
   *  would resolve an edited region with nothing. */
  editId?: string;
}

export interface ConflictFileResolution {
  index: number;
  /** EXHAUSTIVE over the file's NON-`unchanged` regions. A missing or unknown id is
   *  `IncompleteDecisions`, never a default — a silently defaulted region is a line of code
   *  nobody chose, and both one-sided kinds are decidable. */
  decisions: ConflictRegionDecision[];
}

export type ConflictCommitTarget =
  | { kind: 'pr_branch' }
  | { kind: 'new_branch'; branch: string; openPr: boolean };

export interface ConflictCommitBody {
  sessionId: string;
  expectedHeadSha: string;
  expectedBaseSha: string;
  modelHash: string;
  strategy: ConflictLandStrategy;
  target: ConflictCommitTarget;
  /** May be a SUBSET of `files` — the unsupported ones are simply absent, which is how
   *  "commit the files you did resolve" is expressed. */
  files: ConflictFileResolution[];
}

/* ---- CORE: editing one region's result by hand ---- */

/**
 * THE ONE REQUEST IN THIS FAMILY THAT CARRIES TYPED TEXT — see the ⚠ in the file header for
 * which half of the old invariant moved and which half did not.
 *
 * It is scoped to ONE region of ONE file, pinned exactly as `ConflictHunkSuggestBody` is: `id`
 * is the ADDRESS, `fingerprint` is the CONTENT. Without the fingerprint a handle minted against
 * one region's bytes could be redeemed, after a rebuild, against a region that kept its id and
 * changed its content — "text nobody read, in the place it lands", which is the sentence the
 * land route already uses for the suggestion guard.
 *
 * ⚠ IT DOES NOT DECIDE THE REGION. A successful edit mints a handle; the reader's decision is a
 * separate write carrying `{decision:'edited', editId}`, exactly as accepting a suggestion is.
 */
export interface ConflictRegionEditBody {
  sessionId: string;
  fileIndex: number;
  regionId: number;
  /** The region's `fingerprint`, as the CONTENT pin beside the id's ADDRESS. */
  fingerprint: string;
  /** What the reader typed. The SERVER splits it into lines, so the line vocabulary of the fold
   *  is never something a client gets to assert. */
  text: string;
}

/** Why an edit was refused. Every member is a REFUSAL, not a degraded answer: nothing is
 *  stored, no id is minted, and the reader's text stays in their textarea for them to fix.
 *  ⚠ A DEAD SESSION IS NOT IN HERE. That is a 409 `SessionExpired`, the same status and the same
 *  sentence as on the other six routes — the reader's whole resolve is gone, which is a fact
 *  about the session rather than about the text they typed, and the SPA already recovers from it
 *  in one place. */
export type ConflictRegionEditRefusal =
  | 'unknown_region'
  /** An `unchanged` region. Context lines are read-only — they are what the reader's edit sits
   *  BETWEEN, and the commit gate never asks about them. */
  | 'not_editable'
  /** The bytes moved under the id: the model was rebuilt while the textarea was open. */
  | 'moved'
  /** A NUL, a lone surrogate or a BOM. ⚠ A lone surrogate is a REAL hazard rather than a
   *  formality: the land path does `Buffer.from(text, 'utf8')`, which substitutes U+FFFD
   *  silently, and its byte-for-byte claim rests on every side having decoded STRICTLY as UTF-8
   *  at model build. Typed text does not inherit that provenance. */
  | 'not_text'
  /** A conflict marker survived. */
  | 'markers'
  /** Over `config.conflictSuggestMaxChars` — ONE budget governs both text ingresses. */
  | 'too_long'
  /** This session is already holding as much typed text as it may. */
  | 'too_many_edits';

export interface ConflictRegionEdit {
  fileIndex: number;
  regionId: number;
  /** The handle the commit body carries. Valid only within this session, and only for this
   *  region. */
  editId: string;
  /** The SERVER's own split of the text it stored, echoed so the centre pane renders exactly
   *  the lines the commit will splice. ⚠ NOT the client's copy of what it typed: rendering that
   *  instead would be a second implementation of "what you saw is what lands". */
  lines: string[];
}

export type ConflictRegionEditResponse =
  | { ok: true; edit: ConflictRegionEdit }
  /** The server's own sentence, rendered verbatim. */
  | { ok: false; refusal: ConflictRegionEditRefusal; message: string };

/* ---- Results ---- */

export interface ConflictSkippedFile {
  index: number;
  path: string;
  reason: ConflictUnsupportedReason;
  label: string;
}

export interface ConflictCommitResult {
  strategy: ConflictLandStrategy;
  branch: string;
  pushedToPrBranch: boolean;
  commitSha: string;
  resolvedPaths: string[];
  skipped: ConflictSkippedFile[];
  /** Non-empty `skipped`, or any undecided file ⇒ true. The PR stays conflicted. */
  stillConflicting: boolean;
  /** True when the merge picked up base-branch commits landed after the session opened but
   *  before the push, with the conflict content unchanged. Reported, never silent. */
  baseAdvanced: boolean;
  baseShaUsed: string;
  /** An armed "merge when ready" intent was disarmed before the push. */
  autoMergeDisarmed: boolean;
  /** Set for a new branch. The SPA still routes it through `safeExternalUrl()`. */
  compareUrl: string | null;
  /** The resync tail could not confirm the push locally. Copy contract: "it'll show up here
   *  shortly", never "it failed", and NEVER a retry — a retry double-pushes. */
  visible: boolean;
}

/* ---- The stream ---- */

export type ConflictSessionEvent =
  | { type: 'snapshot' | 'progress' | 'ready' | 'failed'; session: ConflictSession }
  | { type: 'commit_progress'; session: ConflictSession }
  | { type: 'commit_done'; session: ConflictSession; result: ConflictCommitResult }
  | {
      type: 'commit_failed';
      session: ConflictSession;
      error: { code: ConflictLandErrorCode; message: string };
    }
  | { type: 'done' };

/* ---- PRO: the per-hunk model suggestion (plugin route; wire type lives here) ---- */

/** Why a suggestion was refused. Every member is a REFUSAL, not a degraded answer —
 *  a suggestion that fails validation never reaches the centre pane. */
export type ConflictSuggestionRefusal =
  | 'unparseable' //          did not come back in the fenced shape, or leaked outside it
  | 'markers' //              a conflict marker survived
  | 'context_duplicated' //   it repeats the lines it sits between
  | 'dropped_side_lines' //   a line one side added, and base does not have, is gone
  | 'dropped_common_lines' // lines BOTH versions kept are gone
  | 'too_long'
  | 'empty'
  | 'not_text'
  | 'cannot_reconcile' //     the model said the two sides genuinely contest — a DESIGNED path
  | 'model_error'
  | 'no_credits';

export interface ConflictHunkSuggestBody {
  sessionId: string;
  fileIndex: number;
  regionId: number;
  /** The region's `fingerprint`, as the CONTENT pin beside the id's ADDRESS. */
  fingerprint: string;
}

export interface ConflictHunkSuggestion {
  fileIndex: number;
  regionId: number;
  /** For the user to READ before accepting. Accepting sends `suggestionId`, never these. */
  lines: string[];
  /** CODE-derived, not model-derived: lines both versions already had that survived. */
  keptCommonLines: number;
  /** The handle the commit body uses. Valid only within this session. */
  suggestionId: string;
  model: string;
  generatedAt: string;
}

export type ConflictHunkSuggestResponse =
  | { enabled: true; ok: true; suggestion: ConflictHunkSuggestion }
  | { enabled: true; ok: false; refusal: ConflictSuggestionRefusal; message: string }
  | { enabled: false };
