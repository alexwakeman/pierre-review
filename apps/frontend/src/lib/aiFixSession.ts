// THE AI FIX TAB ON THE WORKSPACE SESSION (docs/SANDBOX.md § AI Fix sessions; docs/FRONTEND.md § The AI
// Fix tab), pure and React-free so test/aiFixSession.test.ts pins it: when the session view shows, what
// the status line says, what each repository row says, and how a closed session's line reads.
import type { AiFix, AiFixLeftOutRepo, AiFixMerge, SandboxSessionRepo, StoryBuildSession } from '@pierre-review/shared';

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
        text: `Limn checked the merge commit. Its parents are the PR head${head} and ${m.baseRef} (${short(m.baseSha)}).${markers}`,
      };
    }
    case 'invalid':
    case 'missing':
      return { tone: 'bad', text: `Nothing will be pushed: ${m.reason ?? 'the merge did not pass Limn’s check.'}` };
    case 'pending':
      return { tone: 'pending', text: `The merge of ${m.baseRef} is not finished.` };
  }
}

/** The status line above a built session whose merge is not valid: Push is not offered. */
export function fixMergeBlockedLine(m: Pick<AiFixMerge, 'status'> | null | undefined, s: Pick<StoryBuildSession, 'phase'>): string | null {
  if (m == null || s.phase !== 'built') return null;
  if (m.status !== 'invalid' && m.status !== 'missing') return null;
  return 'The merge did not pass Limn’s check, so nothing can be pushed. Ask for more, or discard.';
}
