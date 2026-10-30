import type { StoryBuildCandidate } from '@pierre-review/shared';
import {
  addWorktree,
  cleanupCloneCache,
  ensureClone,
  fetchPrHead,
  fetchRefIntoClone,
  removeWorktreeLocked,
  scrubGitError,
  withRepoLock,
} from '../../review/clone-manager.js';
import { withWorktreeOwner } from '../../review/worktree-owner.js';

// THE PLAN PASS'S READ-ONLY CHECKOUTS ("Implement story", docs/STORY-BUILD.md § The plan). One per-run
// worktree per candidate, at its BASE:
//
//   stacked     (the reader's own open PR) `pull/<n>/head`, at the PR head the candidate names;
//   default     the default branch fetched into a NAMESPACED ref (never FETCH_HEAD — one file per
//               repository, shared across jobs) — the FIRST pass records the sha it found as `baseSha`;
//               a re-plan checks out THAT sha again (still in the shared clone's object store), so
//               every revision of one plan reads the same code. A sha the store has lost fails that
//               candidate (unreadable this pass), never a silent move to a newer commit.
//
// Every tree is LEDGERED `story_plan` (runId = story_builds.id, docs/BACKEND.md § Worktree cleanup), and
// removed when the pass ends (`cleanup`, idempotent, never throws). A failure is PER CANDIDATE (`path`
// null, a scrubbed one-line `error`); the others still prepare. Different repositories prepare in
// parallel, each under its own repo lock.

export interface PlanCheckout {
  candidate: StoryBuildCandidate;
  /** The worktree, or null when it could not be prepared. */
  path: string | null;
  /** The commit checked out (the candidate's `baseSha` from now on), or null. */
  sha: string | null;
  error: string | null;
}

export interface PlanCheckouts {
  checkouts: PlanCheckout[];
  cleanup(): Promise<void>;
}

export interface CheckOutArgs {
  accountId: number;
  buildId: number;
  ident: string;
  candidates: readonly StoryBuildCandidate[];
}

export type CheckOutFn = (a: CheckOutArgs) => Promise<PlanCheckouts>;

const DEST_REF = 'refs/pierre/story-plan-base';

const splitName = (fullName: string): { owner: string; name: string } => {
  const i = fullName.indexOf('/');
  return { owner: fullName.slice(0, i), name: fullName.slice(i + 1) };
};

/** The real checkouts (git + the network). */
export const checkOutCandidates: CheckOutFn = async (a) => {
  const { getAccessToken } = await import('../../auth/account.js');
  const token = await getAccessToken(a.accountId);
  const made: Array<{ owner: string; name: string; dir: string; path: string }> = [];
  const checkouts = await withWorktreeOwner({ kind: 'story_plan', accountId: a.accountId, ticket: a.ident, runId: a.buildId }, () =>
    Promise.all(
      a.candidates.map(async (c): Promise<PlanCheckout> => {
        const { owner, name } = splitName(c.fullName);
        try {
          return await withRepoLock(`${owner}/${name}`, async () => {
            const dir = await ensureClone(owner, name, token);
            let sha: string;
            if (c.stackedOnPrNumber != null && c.baseSha !== '') {
              await fetchPrHead(dir, owner, name, c.stackedOnPrNumber, c.baseSha, token);
              sha = c.baseSha;
            } else {
              const tip = await fetchRefIntoClone({
                cloneDir: dir,
                owner,
                name,
                token,
                remoteRef: c.baseRef === 'HEAD' ? 'HEAD' : `refs/heads/${c.baseRef}`,
                destRef: DEST_REF,
              });
              sha = c.baseSha !== '' ? c.baseSha : tip;
            }
            const path = await addWorktree(dir, sha, { owner, name });
            made.push({ owner, name, dir, path });
            return { candidate: c, path, sha, error: null };
          });
        } catch (err) {
          return { candidate: c, path: null, sha: null, error: scrubGitError(err) };
        }
      }),
    ),
  );
  let cleaned = false;
  return {
    checkouts,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await Promise.all(made.map((m) => removeWorktreeLocked(m.owner, m.name, m.dir, m.path).catch(() => {})));
      setImmediate(() => {
        try {
          cleanupCloneCache();
        } catch {
          /* advisory cleanup — never surface */
        }
      });
    },
  };
};
