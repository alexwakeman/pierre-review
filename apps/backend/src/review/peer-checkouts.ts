import type { ReviewRunPeer } from '../platform/contract.js';
import { prepDefaultBranchCheckouts, prepPeerWorktrees } from './clone-manager.js';

// THE PEERS' READ-ONLY CHECKOUTS, shared by a deep review (review/agent.ts) and the replies pass
// (claude-review/replies-check.ts: the related repos' peers and the pull requests a reply links to).
// Split out of agent.ts unchanged, so both read related code through ONE mechanism.

export type RunPeer = ReviewRunPeer;

/**
 * Check out every peer, read-only: PR peers at their heads (`prepPeerWorktrees`), branch and
 * default-branch peers at the branch tip (`prepDefaultBranchCheckouts`, one per repo). Returns the
 * path per ref (absent = not checked out); each preparation's cleanup is pushed to `cleanups`.
 */
export async function checkOutPeers(
  peers: readonly RunPeer[],
  cleanups: Array<() => Promise<void>>,
): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const prPeers = peers.filter((p): p is Extract<RunPeer, { prNumber: number }> => p.kind == null || p.kind === 'pr');
  const refPeers = peers.filter((p): p is Extract<RunPeer, { branch: string | null }> => p.kind === 'branch' || p.kind === 'default_branch');
  const [pr, refs] = await Promise.all([
    prPeers.length > 0
      ? prepPeerWorktrees(prPeers.map((p) => ({ owner: p.owner, name: p.name, number: p.prNumber, headSha: p.headSha })))
      : null,
    refPeers.length > 0
      ? prepDefaultBranchCheckouts(refPeers.map((p) => ({ owner: p.owner, name: p.name, branch: p.branch })))
      : null,
  ]);
  if (pr) {
    cleanups.push(pr.cleanup);
    prPeers.forEach((p, i) => {
      const path = pr.peers[i]?.path;
      if (path) paths.set(p.ref, path);
    });
  }
  if (refs) {
    cleanups.push(refs.cleanup);
    // One checkout per repository (deduplicated, case-insensitively), so match by owner/name.
    for (const p of refPeers) {
      const key = `${p.owner}/${p.name}`.toLowerCase();
      const c = refs.checkouts.find((x) => `${x.owner}/${x.name}`.toLowerCase() === key);
      if (c?.path) paths.set(p.ref, c.path);
    }
  }
  return paths;
}
