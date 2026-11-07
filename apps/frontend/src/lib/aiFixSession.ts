// THE AI FIX TAB ON THE WORKSPACE SESSION (docs/SANDBOX.md § AI Fix sessions; docs/FRONTEND.md § The AI
// Fix tab), pure and React-free so test/aiFixSession.test.ts pins it: when the session view shows, what
// the status line says, what each repository row says, and how a closed session's line reads.
import type { AiFix, AiFixLeftOutRepo, SandboxSessionRepo, StoryBuildSession } from '@pierre-review/shared';

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
  o: { prRepoId: number; headRef: string | null; filesChanged: number; pushed: boolean; leftOut: readonly AiFixLeftOutRepo[] },
): { status: string; note: string | null } {
  if (r.repoId === o.prRepoId) {
    const status = o.pushed ? 'Pushed' : o.filesChanged > 0 ? `${o.filesChanged} file${o.filesChanged === 1 ? '' : 's'} changed` : 'No changes yet';
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
