import type {
  ConflictCommitBody,
  ConflictCommitResult,
  ConflictCommitTarget,
  ConflictDecision,
  ConflictFileContent,
  ConflictLandStrategy,
  ConflictSession,
} from '@pierre-review/shared';
import { CANT_RESOLVE_HERE, serializeFileDecisions, tallyFile } from './mergeResolver.js';

// ── WHAT ACTUALLY GETS COMMITTED ─────────────────────────────────────────────────────────────
//
// The landing step's fold: which files are going into the commit, which ones are staying
// conflicted, and the body the commit route takes. Pure and in a `.ts` file so it can be tested
// — the two rules below are the ones that would otherwise fail silently.
//
// ⚠ A PARTIALLY DECIDED FILE IS OMITTED WHOLE, NEVER HALF-SENT. `ConflictFileResolution.decisions`
// is EXHAUSTIVE over its file's non-`unchanged` regions; a missing id is `IncompleteDecisions` and
// refuses the WHOLE commit, so half-sending one file would take every other file's work down with
// it. The half-decided file is listed on screen under "Still conflicted" instead — which is the
// truth about it either way.
//
// ⚠ A FILE NOBODY OPENED CARRIES NO DECISIONS, and that is not the same as "no conflicts". Its
// regions were never fetched, so there is nothing to serialise; it counts as still conflicted.

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
}

export interface CommitPlan {
  rows: LandingFileRow[];
  /** `state === 'resolved'`, in manifest order. */
  resolved: LandingFileRow[];
  /** Everything else, in manifest order — the "Still conflicted:" list. */
  stillConflicted: LandingFileRow[];
  /** Contested regions across the RESOLVED files only. The success sentence's numerator. */
  conflictsResolved: number;
  /** `session.files.length` — the denominator of "4 of 7 files resolved". Unsupported files are
   *  in it because they are files this pull request still conflicts on. */
  totalFiles: number;
}

/** One file's row, from the manifest entry plus whatever regions have been fetched. */
function classify(
  entry: ConflictSession['files'][number],
  loaded: ConflictFileContent | undefined,
  decisions: Readonly<Record<string, ConflictDecision>>,
): LandingFileRow {
  if (entry.unsupported != null) {
    return {
      index: entry.index,
      path: entry.path,
      state: 'unsupported',
      label: entry.unsupportedLabel ?? CANT_RESOLVE_HERE,
      conflictsDecided: 0,
    };
  }
  if (loaded == null) {
    return {
      index: entry.index,
      path: entry.path,
      state: 'untouched',
      label: 'Not opened',
      conflictsDecided: 0,
    };
  }
  const tally = tallyFile(loaded.regions, entry.index, decisions);
  if (tally.decidable > 0 && tally.decided >= tally.decidable) {
    return {
      index: entry.index,
      path: entry.path,
      state: 'resolved',
      label: 'Resolved',
      conflictsDecided: tally.conflictsDecided,
    };
  }
  if (tally.decided > 0) {
    return {
      index: entry.index,
      path: entry.path,
      state: 'partial',
      label: `${tally.decided} of ${tally.decidable} decided`,
      conflictsDecided: tally.conflictsDecided,
    };
  }
  return {
    index: entry.index,
    path: entry.path,
    state: 'untouched',
    label: 'Nothing decided',
    conflictsDecided: 0,
  };
}

export function commitPlan(
  session: ConflictSession,
  loaded: Readonly<Record<number, ConflictFileContent>>,
  decisions: Readonly<Record<string, ConflictDecision>>,
): CommitPlan {
  const rows = session.files.map((entry) => classify(entry, loaded[entry.index], decisions));
  const resolved = rows.filter((r) => r.state === 'resolved');
  return {
    rows,
    resolved,
    stillConflicted: rows.filter((r) => r.state !== 'resolved'),
    conflictsResolved: resolved.reduce((n, r) => n + r.conflictsDecided, 0),
    totalFiles: session.files.length,
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
 * ⚠ ONLY `resolved` FILES TRAVEL. See the second ⚠ in the module header. The pins are echoed from
 * the session the reader has been looking at, not re-read from anywhere: if the server's model has
 * moved on, `ModelStale` is exactly the answer we want, and nothing is written.
 */
export function buildCommitBody(args: {
  session: ConflictSession;
  loaded: Readonly<Record<number, ConflictFileContent>>;
  decisions: Readonly<Record<string, ConflictDecision>>;
  suggestionIds: Readonly<Record<string, string>>;
  strategy: ConflictLandStrategy;
  target: ConflictCommitTarget;
}): ConflictCommitBody {
  const { session, loaded, decisions, suggestionIds, strategy, target } = args;
  const plan = commitPlan(session, loaded, decisions);
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
