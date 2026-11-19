// THE AI FIX TAB ON THE WORKSPACE SESSION (docs/SANDBOX.md § AI Fix sessions; docs/FRONTEND.md § The AI
// Fix tab), pure and React-free so test/aiFixSession.test.ts pins it: when the session view shows, what
// the status line says, what each repository row says, and how a closed session's line reads.
import { aiFixLoopProgressLine, aiFixLoopRunning, cannotMeetLine, type AiFix, type AiFixLeftOutRepo, type AiFixLoop, type AiFixLoopRound, type AiFixMerge, type SandboxSessionRepo, type StoryBuildSession } from '@pierre-review/shared';

/**
 * The session view shows while the sandbox runs, and for a closed session the reader can Resume (a
 * built, unpushed patch). A pushed, discarded or failed session shows only its result.
 */
export function fixSessionShown(s: Pick<StoryBuildSession, 'phase' | 'live' | 'resumable'> | null | undefined): boolean {
  if (s == null) return false;
  if (s.live) return s.phase !== 'discarded' && s.phase !== 'failed';
  return s.phase === 'built' && s.resumable;
}

/** A live session holds the PR: no second fix starts until it ends (the server answers AlreadyRunning). */
export function fixSessionHoldsPr(s: Pick<StoryBuildSession, 'live'> | null | undefined): boolean {
  return s?.live === true;
}

/** The one status sentence above the session. */
export function fixSessionStatusLine(s: Pick<StoryBuildSession, 'phase' | 'live' | 'mode'>, unattended: boolean): string {
  switch (s.phase) {
    case 'booting':
      return 'Setting up the sandbox.';
    case 'ready':
      return 'The plan is ready. Talk to the agent, then press Start fix.';
    case 'chatting':
      return s.mode === 'chat' ? 'The agent is making a plan.' : 'The agent is answering.';
    // A story session's plan stage; an AI Fix never enters it.
    case 'planning':
    case 'revising':
      return 'The agent is making a plan.';
    case 'plan_ready':
      return 'The plan is ready. Talk to the agent, then press Start fix.';
    case 'building':
      return 'The agent is fixing and testing.';
    case 'built':
      if (s.live) return 'Fixed. Review the changes and push them, or ask for more.';
      return unattended
        ? 'An automatic fix. The sandbox is closed and the changes are kept: push them, or resume.'
        : 'The sandbox is closed. The changes are kept: push them, or resume.';
    case 'pushed':
      return 'Pushed.';
    case 'discarded':
      return 'Discarded.';
    case 'failed':
      return 'The session failed.';
  }
}

/**
 * A repository row of the rail. The PR's repository is the ONLY one pushed (to the PR's own branch);
 * every other one is read only, and edits there are left out.
 */
export function fixRepoStatus(
  r: Pick<SandboxSessionRepo, 'repoId'>,
  o: {
    prRepoId: number;
    headRef: string | null;
    filesChanged: number;
    pushed: boolean;
    leftOut: readonly AiFixLeftOutRepo[];
    // The fix's merge (AiFix.merge), when it had the "Resolve merge conflicts" item.
    merge?: Pick<AiFixMerge, 'status' | 'baseRef'> | null;
  },
): { status: string; note: string | null } {
  if (r.repoId === o.prRepoId) {
    const files = o.filesChanged > 0 ? `${o.filesChanged} file${o.filesChanged === 1 ? '' : 's'} changed` : null;
    const m = o.merge;
    const status = o.pushed
      ? 'Pushed'
      : m != null && m.status === 'valid'
        ? files != null ? `${m.baseRef} merged · ${files}` : `${m.baseRef} merged`
        : m != null && (m.status === 'invalid' || m.status === 'missing')
          ? 'Merge not valid'
          : files ?? 'No changes yet';
    return { status, note: o.headRef != null ? `Pushes to ${o.headRef}` : 'Pushes to the PR branch' };
  }
  const left = o.leftOut.find((x) => x.repoId === r.repoId);
  if (left != null && left.files.length > 0) {
    return { status: `${left.files.length} file${left.files.length === 1 ? '' : 's'} left out`, note: 'Read only. Edits here are left out.' };
  }
  return { status: 'Read only', note: null };
}

/** The line under a finished fix for each repository whose edits were left out. */
export function leftOutLine(x: Pick<AiFixLeftOutRepo, 'fullName'>, prRepoFullName: string): string {
  return `Edits in ${x.fullName} are left out. AI Fix pushes only ${prRepoFullName}.`;
}

/**
 * A succeeded row's `error`: an AUTOMATIC push that failed ("Automatic push failed: …", a warning: Push
 * still works) or a closed session's line (idle close, a restart: a plain note).
 */
export function fixErrorTone(fix: Pick<AiFix, 'error' | 'session'>): 'warn' | 'note' | null {
  if (fix.error == null || fix.error === '') return null;
  if (fix.session == null || fix.error.startsWith('Automatic push failed')) return 'warn';
  return 'note';
}

// ── THE MERGE (AiFix.merge: the "Resolve merge conflicts with <base>" item; docs/SANDBOX.md § AI Fix sessions)

const short = (sha: string | null | undefined): string => (sha ?? '').slice(0, 7);

/**
 * Can Push send this fix? A fix with the merge sends ONLY a merge Limn checked as valid (the server
 * refuses the rest with 409); a fix without one, only a non-empty patch.
 */
export function fixPushable(fix: Pick<AiFix, 'patch' | 'filesChanged' | 'merge'>): boolean {
  if (fix.merge != null) return fix.merge.status === 'valid';
  return (fix.patch ?? '') !== '' && fix.filesChanged.length > 0;
}

/**
 * The merge's one line under a finished fix: Limn's check of the merge commit's parents and markers,
 * or why nothing will be pushed. `headSha` is the PR head the fix started from (AiFix.baseSha).
 */
export function fixMergeLine(
  m: Pick<AiFixMerge, 'status' | 'reason' | 'baseRef' | 'baseSha' | 'conflictedFiles'>,
  headSha: string | null,
): { tone: 'ok' | 'bad' | 'pending'; text: string } {
  const n = m.conflictedFiles.length;
  switch (m.status) {
    case 'valid': {
      const head = headSha != null && headSha !== '' ? ` (${short(headSha)})` : '';
      const markers = n === 0 ? '' : n === 1 ? ' No conflict markers are left in the file that was in conflict.' : ` No conflict markers are left in the ${n} files that were in conflict.`;
      return {
        tone: 'ok',
        text: `Ensemble checked the merge commit. Its parents are the PR head${head} and ${m.baseRef} (${short(m.baseSha)}).${markers}`,
      };
    }
    case 'invalid':
    case 'missing':
      return { tone: 'bad', text: `Nothing will be pushed: ${m.reason ?? 'the merge did not pass Ensemble’s check.'}` };
    case 'pending':
      return { tone: 'pending', text: `The merge of ${m.baseRef} is not finished.` };
  }
}

/** The status line above a built session whose merge is not valid: Push is not offered. */
export function fixMergeBlockedLine(m: Pick<AiFixMerge, 'status'> | null | undefined, s: Pick<StoryBuildSession, 'phase'>): string | null {
  if (m == null || s.phase !== 'built') return null;
  if (m.status !== 'invalid' && m.status !== 'missing') return null;
  return 'The merge did not pass Ensemble’s check, so nothing can be pushed. Ask for more, or discard.';
}

// ── THE PUSH FOOTER (docs/CLAUDE-REVIEW.md § Push when done): what the bottom of a finished fix shows ──────────
// ONE pure fold of the wire (AiFix.pushedAt / pushing / pushHold / error), so the footer never offers Push while
// an automatic push ("Push when done", "Push automatically") is on its way or after it landed. A new state (a
// review loop's "Reviewing, round k of N") is one more member here, ranked where it belongs.
export type FixPushFooter =
  // A record, nothing more: no Push. `sha` null on a fix pushed before the commit was stored.
  | { kind: 'pushed'; branch: string | null; sha: string | null; shortSha: string | null; commitUrl: string | null; automatic: boolean }
  // THE REVIEW LOOP works ("Reviewing, round 2 of 5."): nothing is pushed until it ends, so no Push.
  | { kind: 'reviewing'; line: string }
  // An automatic push runs: no button.
  | { kind: 'pushing'; branch: string | null }
  // Push, with one line above it: the automatic push failed (never retried), or "Push when done" held.
  | { kind: 'failed'; line: string }
  | { kind: 'held'; line: string }
  // Push, as it is.
  | { kind: 'plain' };

export function fixPushFooter(
  fix: Pick<AiFix, 'pushedAt' | 'pushedBranch' | 'pushedCommitSha' | 'pushedAutomatically' | 'pushing' | 'pushHold' | 'error' | 'loop'>,
  o: { headRef: string | null; repoFullName: string },
): FixPushFooter {
  if (fix.pushedAt != null) {
    const sha = fix.pushedCommitSha != null && fix.pushedCommitSha !== '' ? fix.pushedCommitSha : null;
    return {
      kind: 'pushed',
      branch: fix.pushedBranch,
      sha,
      shortSha: sha != null ? short(sha) : null,
      commitUrl: sha != null ? `https://github.com/${o.repoFullName}/commit/${sha}` : null,
      automatic: fix.pushedAutomatically === true,
    };
  }
  if (aiFixLoopRunning(fix.loop)) return { kind: 'reviewing', line: aiFixLoopProgressLine(fix.loop!) ?? 'Reviewing the fix.' };
  if (fix.pushing === true) return { kind: 'pushing', branch: o.headRef };
  if (fix.error != null && fix.error.startsWith('Automatic push failed')) return { kind: 'failed', line: fix.error };
  if (fix.pushHold != null && fix.pushHold.line !== '') return { kind: 'held', line: fix.pushHold.line };
  return { kind: 'plain' };
}

// ── THE REVIEW LOOP (AiFix.loop; docs/CLAUDE-REVIEW.md § AI Fix → The review loop): the rounds strip and its lines ──

/** The session's status line while the loop works (null when it does not: the usual line applies). */
export function fixLoopStatusLine(loop: AiFixLoop | null | undefined): string | null {
  if (!aiFixLoopRunning(loop)) return null;
  const line = aiFixLoopProgressLine(loop!);
  return line == null ? null : loop!.state === 'fixing' ? `${line} The agent is answering the review.` : `${line} Nothing is pushed until the review ends.`;
}

export interface FixLoopStripCell {
  label: 'found' | 'fixed' | 'answered' | 'pushed back' | 'cannot meet';
  n: number;
}

export interface FixLoopStripRow {
  round: number;
  /** "Round 2" or "Closing review". */
  title: string;
  /** One word for the round's review: what it is doing or how it ended. */
  status: string;
  tone: 'ok' | 'open' | 'running' | 'bad';
  /** Only the non-zero counts (found always) — and none at all unless the review SUCCEEDED (unknown is never zero). */
  cells: FixLoopStripCell[];
}

const REVIEW_WORD: Record<NonNullable<AiFixLoopRound['review']>, string> = {
  running: 'Reviewing',
  succeeded: 'Reviewed',
  failed: 'Review failed',
  skipped: 'Skipped',
  cancelled: 'Stopped',
};

/** The rounds strip (newest last): per round, what the review found and what the fix turn after it did. Pure. */
export function fixLoopStrip(loop: Pick<AiFixLoop, 'history'>): FixLoopStripRow[] {
  return loop.history.map((r) => {
    // A review still running, failed, skipped or stopped found nothing KNOWN: no counts, never "0 found".
    const known = r.review === 'succeeded';
    const cells: FixLoopStripCell[] = known ? [{ label: 'found', n: r.counts.found }] : [];
    const more: Array<[FixLoopStripCell['label'], number]> = [
      ['fixed', r.counts.fixed],
      ['answered', r.counts.answered],
      ['pushed back', r.counts.pushedBack],
      ['cannot meet', r.counts.cannotMeet],
    ];
    if (known) for (const [label, n] of more) if (n > 0) cells.push({ label, n });
    const review = r.review ?? 'running';
    const status = r.fix === 'running' ? 'Fixing' : REVIEW_WORD[review];
    const tone: FixLoopStripRow['tone'] =
      review === 'running' || r.fix === 'running' ? 'running' : review === 'failed' || review === 'cancelled' || review === 'skipped' ? 'bad' : r.counts.found === 0 ? 'ok' : 'open';
    return { round: r.round, title: r.closing ? 'Closing review' : `Round ${r.step}`, status, tone, cells };
  });
}

/** The lines under the strip for criteria the agent says cannot be done (they stay NOT MET). */
export function fixLoopCannotMeetLines(loop: Pick<AiFixLoop, 'cannotMeet'>): Array<{ ref: string; text: string; line: string }> {
  return loop.cannotMeet.map((c) => ({ ref: c.ref, text: c.text, line: cannotMeetLine(c.reason) }));
}
