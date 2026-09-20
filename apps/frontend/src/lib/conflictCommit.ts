import type {
  ConflictCommitBody,
  ConflictCommitResult,
  ConflictCommitTarget,
  ConflictDecision,
  ConflictFileContent,
  ConflictLandStrategy,
  ConflictSession,
} from '@pierre-review/shared';
import {
  CANT_RESOLVE_HERE,
  NOTHING_TO_DECIDE,
  serializeFileDecisions,
  tallyFile,
} from './mergeResolver.js';

// ── WHAT ACTUALLY GETS COMMITTED ─────────────────────────────────────────────────────────────
//
// The landing step's fold: which files are going into the commit, which ones are staying
// conflicted, and the body the commit route takes. Pure and in a `.ts` file so it can be tested
// — the rules below are the ones that would otherwise fail silently.
//
// ⚠ NOTHING IS EXCLUDED FROM A COMMIT WITHOUT THE READER CHOOSING IT. A half-decided file used to
// be dropped from the body and listed under "Still conflicted", which is a silent exclusion
// wearing a label. `canCommit` is now FALSE while any supported file has an unanswered region,
// and the landing step names each one with a click that goes there. The only thing still left out
// is an `unsupported` file, which the MODEL excluded and which the server cannot take either.
//
// ⚠ A PARTIALLY DECIDED FILE IS STILL OMITTED WHOLE RATHER THAN HALF-SENT.
// `ConflictFileResolution.decisions` is EXHAUSTIVE over its file's non-`unchanged` regions; a
// missing id is `IncompleteDecisions` and refuses the WHOLE commit. That rule survives as the
// second line of defence behind the gate, not as the way a partial file is handled.
//
// ⚠ A FILE NOBODY OPENED CARRIES NO DECISIONS, and that is not the same as "no conflicts". Its
// regions were never fetched, so there is nothing to serialise — and its whole `decidableCount`
// (off the MANIFEST, which is all we have for it) is outstanding.

/** Why a file is not going into the commit — or that it is. */
export type LandingFileState =
  /** Every decidable region answered. Goes on the wire. */
  | 'resolved'
  /** Some regions answered, some not. Omitted whole. */
  | 'partial'
  /** Never opened, or opened and nothing decided. */
  | 'untouched'
  /** The model cannot represent it. The server's own noun phrase rides along. */
  | 'unsupported';

export interface LandingFileRow {
  index: number;
  path: string;
  state: LandingFileState;
  /** A noun phrase, never an instruction. The server's for `unsupported`, ours otherwise. */
  label: string;
  /** Contested regions in this file that the reader answered. Sums into the success sentence. */
  conflictsDecided: number;
  /** Regions in this file that take a decision. From the file's regions once they are here, from
   *  the manifest's `decidableCount` before that. 0 for an unsupported file. */
  decidable: number;
  /** Of those, how many the reader has answered. 0 for a file whose regions never arrived. */
  decided: number;
  /** Have this file's regions been fetched? False ⇒ nothing in it can have been decided. */
  opened: boolean;
}

/** A supported file with regions still unanswered. The commit is blocked until this list is
 *  empty, and the landing step names every entry with a click that jumps there. */
export interface OutstandingFile {
  index: number;
  path: string;
  /** Regions still needing an answer. For a file nobody opened this is the manifest's whole
   *  `decidableCount` — nothing can have been decided in a file whose regions never arrived. */
  remaining: number;
  /** False ⇒ the regions have not been fetched; the click that jumps there fetches them. */
  opened: boolean;
}

export interface CommitPlan {
  rows: LandingFileRow[];
  /** `state === 'resolved'`, in manifest order. */
  resolved: LandingFileRow[];
  /** Everything else, in manifest order. The post-commit panel's population — see
   *  `stillConflictingPaths` — and the SUPERSET `notCarried` is cut from. */
  stillConflicted: LandingFileRow[];
  /**
   * The "Still conflicted:" list: every file this commit will NOT carry and the reader cannot
   * finish here — `stillConflicted` minus whatever `outstanding` already names above it.
   *
   * ⚠ IT IS NOT "the unsupported ones". `classify` also produces a SUPPORTED row with
   * `decidable === 0` (every region came out `unchanged` — a mode-only conflict, say). That row
   * never reaches `resolved`, so `buildCommitBody` never sends it, and `remaining` is 0, so it
   * never blocks. Filter this list to `state === 'unsupported'` and that file is dropped from the
   * commit with NOTHING on screen about it — the exact silent exclusion the gate exists to end.
   */
  notCarried: LandingFileRow[];
  /** Contested regions across the RESOLVED files only. The success sentence's numerator. */
  conflictsResolved: number;
  /** `session.files.length` — the denominator of "4 of 7 files resolved". Unsupported files are
   *  in it because they are files this pull request still conflicts on. */
  totalFiles: number;
  /** ⚠ THE ONE GATE. Every other "can we commit?" in the SPA reads this — a second predicate is
   *  how a button and the list under it come to disagree. */
  outstanding: OutstandingFile[];
  canCommit: boolean;
  /** The counter's population, and the gate's: regions that take a decision, across every
   *  SUPPORTED file, with the denominator off the manifest so a file nobody opened is counted. */
  decidableTotal: number;
  decidedTotal: number;
}

/** One file's row, from the manifest entry plus whatever regions have been fetched. */
function classify(
  entry: ConflictSession['files'][number],
  loaded: ConflictFileContent | undefined,
  decisions: Readonly<Record<string, ConflictDecision>>,
): LandingFileRow {
  const at = { index: entry.index, path: entry.path };
  if (entry.unsupported != null) {
    // ⚠ NEVER OUTSTANDING. The MODEL excluded it, the server cannot take it, and it is named on
    // screen with the server's own noun phrase — a choice the reader can see, not a silent drop.
    return {
      ...at,
      state: 'unsupported',
      label: entry.unsupportedLabel ?? CANT_RESOLVE_HERE,
      conflictsDecided: 0,
      decidable: 0,
      decided: 0,
      opened: false,
    };
  }
  if (loaded == null) {
    return {
      ...at,
      state: 'untouched',
      label: entry.decidableCount === 0 ? NOTHING_TO_DECIDE : 'Not opened',
      conflictsDecided: 0,
      decidable: entry.decidableCount,
      decided: 0,
      opened: false,
    };
  }
  const tally = tallyFile(loaded.regions, entry.index, decisions);
  const counts = {
    conflictsDecided: tally.conflictsDecided,
    decidable: tally.decidable,
    decided: tally.decided,
    opened: true,
  };
  // ⚠ `decidable === 0` IS NOT "Nothing decided". There was nothing to decide, so accusing the
  // reader of not deciding it is a sentence about them rather than about the file. It neither
  // ships (`classify` never calls it resolved) nor blocks (`remaining` is 0).
  if (tally.decidable === 0) {
    return { ...at, state: 'untouched', label: NOTHING_TO_DECIDE, ...counts };
  }
  if (tally.decided >= tally.decidable) {
    return { ...at, state: 'resolved', label: 'Resolved', ...counts };
  }
  if (tally.decided > 0) {
    return {
      ...at,
      state: 'partial',
      label: `${tally.decided} of ${tally.decidable} decided`,
      ...counts,
    };
  }
  return { ...at, state: 'untouched', label: 'Nothing decided', ...counts };
}

export function commitPlan(
  session: ConflictSession,
  loaded: Readonly<Record<number, ConflictFileContent>>,
  decisions: Readonly<Record<string, ConflictDecision>>,
): CommitPlan {
  const rows = session.files.map((entry) => classify(entry, loaded[entry.index], decisions));
  const resolved = rows.filter((r) => r.state === 'resolved');
  const supported = rows.filter((r) => r.state !== 'unsupported');
  const outstanding: OutstandingFile[] = [];
  let decidableTotal = 0;
  let decidedTotal = 0;
  for (const row of supported) {
    decidableTotal += row.decidable;
    decidedTotal += row.decided;
    const remaining = row.decidable - row.decided;
    if (remaining > 0) {
      outstanding.push({ index: row.index, path: row.path, remaining, opened: row.opened });
    }
  }
  const outstandingIndexes = new Set(outstanding.map((o) => o.index));
  const stillConflicted = rows.filter((r) => r.state !== 'resolved');
  return {
    rows,
    resolved,
    stillConflicted,
    notCarried: stillConflicted.filter((r) => !outstandingIndexes.has(r.index)),
    conflictsResolved: resolved.reduce((n, r) => n + r.conflictsDecided, 0),
    totalFiles: session.files.length,
    outstanding,
    // The second clause keeps an all-unsupported pull request blocked — there is nothing this
    // commit could carry, and the landing step says so in the server's own words.
    canCommit: outstanding.length === 0 && resolved.length > 0,
    decidableTotal,
    decidedTotal,
  };
}

/** Which "Where to put it" options the landing step offers, and where the commit is going. */
export interface LandingTargets {
  /** Render the "Push to <headRef>" option at all. */
  offerPrBranch: boolean;
  /** The server's one sentence for why the PR branch is absent. Null when it is offered. */
  prBranchNote: string | null;
  /** The target the commit body will carry. */
  toNewBranch: boolean;
}

/**
 * The target fold.
 *
 * ⚠ HIDE, NEVER DISABLE. A fork pull request whose author did not allow maintainer edits has a
 * head branch in somebody else's repository, and pushing to it can only end in the land route's
 * `PushDenied`. The option is therefore ABSENT, the new branch is where the commit goes, and the
 * server's own sentence says why once — an absent option needs no explanation, a disabled one
 * invites the reader to work out why.
 *
 * ⚠ `toNewBranch` IS DERIVED, not the reader's radio state. It is the same rule as a derived
 * sub-tab: a corrective `setState` would win a race against a session that arrives, or changes,
 * after the mount, and the commit body would carry `pr_branch` for a branch the screen never
 * offered.
 *
 * ⚠ AND IT IS STILL NOT THE AUTHORISATION. `session.prBranchPushable` is a live read taken at
 * session build that defaults TRUE when it fails; the land route re-reads it milliseconds before
 * the push.
 */
export function landingTargets(session: ConflictSession, newBranchChosen: boolean): LandingTargets {
  const offerPrBranch = session.prBranchPushable;
  return {
    offerPrBranch,
    prBranchNote: offerPrBranch ? null : session.prBranchUnavailableReason,
    toNewBranch: newBranchChosen || !offerPrBranch,
  };
}

/**
 * The commit body.
 *
 * ⚠ ONLY `resolved` FILES TRAVEL, and when `plan.canCommit` that IS every supported file. See the
 * module header: the gate is what makes the two the same set, so the old "omitted whole" rule is
 * now the second line of defence rather than the behaviour.
 *
 * ⚠ IT MAY ONLY BE CALLED WITH `plan.canCommit`. The caller's `submit()` gates on the SAME plan
 * object this takes — passed in, not recomputed, so the button and the body cannot be looking at
 * two folds. The route's `IncompleteDecisions` stays where it is: a client gate is never the
 * gate.
 *
 * The pins are echoed from the session the reader has been looking at, not re-read from anywhere:
 * if the server's model has moved on, `ModelStale` is exactly the answer we want, and nothing is
 * written.
 */
export function buildCommitBody(args: {
  session: ConflictSession;
  plan: CommitPlan;
  loaded: Readonly<Record<number, ConflictFileContent>>;
  decisions: Readonly<Record<string, ConflictDecision>>;
  suggestionIds: Readonly<Record<string, string>>;
  strategy: ConflictLandStrategy;
  target: ConflictCommitTarget;
}): ConflictCommitBody {
  const { session, plan, loaded, decisions, suggestionIds, strategy, target } = args;
  const files = plan.resolved.flatMap((row) => {
    const content = loaded[row.index];
    if (content == null) return [];
    return [
      {
        index: row.index,
        decisions: serializeFileDecisions(content.regions, row.index, decisions, suggestionIds),
      },
    ];
  });
  return {
    sessionId: session.sessionId,
    expectedHeadSha: session.headSha,
    expectedBaseSha: session.baseSha,
    modelHash: session.modelHash,
    strategy,
    target,
    files,
  };
}

/**
 * The paths still conflicting AFTER the push, for the terminal panel's sentence.
 *
 * ⚠ THE UNION OF TWO POPULATIONS, NOT ONE. `result.skipped` is what the SERVER refused; a file we
 * never sent because the reader half-decided it never reaches the server at all, so it can only
 * be named from the plan. Naming only one of the two leaves the reader with a pull request that
 * is still conflicted for a reason nothing on screen mentioned.
 */
export function stillConflictingPaths(result: ConflictCommitResult, plan: CommitPlan): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of [...result.skipped.map((s) => s.path), ...plan.stillConflicted.map((r) => r.path)]) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}
