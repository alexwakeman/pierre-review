// THE REVIEW LOOP'S REVIEW CLAIM LINES (docs/STORY-BUILD.md § The review loop → "The review lines"; docs/
// CLAUDE-REVIEW.md § Team claims). Each half of a loop review posts the SAME per-provider lines an auto
// review does, on the branch head it reviews — written by the review claims' own functions, never a fork:
//
//     ensemble/review-claude | ensemble/review-codex   (team-claim.ts `teamClaimContext`)
//     pending  "alex is reviewing with Claude"         (`reviewingLine`; renewed every TEAM_CLAIM_RENEW_MS)
//     success  "alex reviewed · kept in Ensemble"      (`reviewedLine(login, null)`: the loop posts nothing
//                                                       to GitHub, so the honest line is the kept one)
//     success  "Cleared by alex: review didn't finish · free to claim"   (`unfinishedLine`: failed, stopped)
//
// So every Ensemble reads the head's review state through the ONE fold (`decideTeamClaim`) once the PR
// opens: the reader's other computers see it reviewed; a teammate's Ensemble follows the fold's own rules —
// the PR author's lines never hold a commit for a reviewer and a kept review is free, so a teammate's auto
// review still gives the verdict (docs/TEAM-REVIEW.md § Implement and Fill gaps).
// ⚠ LEDGER FIRST (`story_build_claim_lines`, kind 'review'): a crash mid-round leaves a row the reconciler
//   (build-claim-release.ts) releases once the loop is not working in this process. ⚠ Never blocks the
//   loop: no login, a refused or failed write ⇒ the half runs without a line. ⚠ The final line reads the
//   context first: a teammate's newer line (`teammateHolds`) stands, and nothing is posted.
import type { AiProviderId } from '@pierre-review/shared';
import {
  TEAM_CLAIM_RENEW_MS,
  claimErrorKind,
  reviewedLine,
  reviewingLine,
  teamClaimContext,
  teammateHolds,
  unfinishedLine,
} from '../../../review/claude-review/team-claim.js';
import { buildClaimSeams } from '../build-claim-flow.js';
import { recordBuildClaimIntent, updateBuildClaimLine } from '../build-claim-ledger.js';

export interface LoopReviewLineTarget {
  accountId: number;
  buildId: number;
  workspaceId: number;
  ident: string;
  owner: string;
  name: string;
  branch: string;
  headSha: string;
  provider: AiProviderId;
}

export interface LoopReviewLine {
  target: LoopReviewLineTarget;
  login: string;
  /** Only a marked line posts more lines; an unmarked one may still have a ledger row (a write that may have landed). */
  marked: boolean;
  ledgerId: number | null;
  timer: ReturnType<typeof setInterval> | null;
}

interface Log {
  warn: (msg: string) => void;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);

/** Before a half runs: the ledger intent, then the pending line, then the renewal. Never throws. */
export async function startLoopReviewLine(t: LoopReviewLineTarget, log: Log): Promise<LoopReviewLine | null> {
  const s = buildClaimSeams();
  const login = await s.gh.login(t.accountId).catch(() => null);
  if (!login) return null;
  const context = teamClaimContext(t.provider);
  let ledgerId: number;
  try {
    ledgerId = await recordBuildClaimIntent({
      accountId: t.accountId,
      buildId: t.buildId,
      workspaceId: t.workspaceId,
      ident: t.ident,
      kind: 'review',
      context,
      owner: t.owner,
      name: t.name,
      branch: t.branch,
      headSha: t.headSha,
      provider: t.provider,
      login,
    });
  } catch (err) {
    log.warn(`story loop ${t.buildId}: review line ledger not written (${errText(err)}); reviewing without a line`);
    return null;
  }
  const description = reviewingLine(login, t.provider);
  try {
    await s.gh.postLine(t.accountId, t.owner, t.name, t.headSha, context, { state: 'pending', description });
  } catch (err) {
    const kind = claimErrorKind(err, t.accountId);
    // Refused or rate-limited: nothing landed. Any other failure may have: the row stays for the reconciler.
    await updateBuildClaimLine(ledgerId, kind === 'error' ? { lastError: errText(err) } : { state: 'released', lastError: kind }).catch(() => {});
    log.warn(`story loop ${t.buildId}: review line not posted (${errText(err)}); reviewing without a line`);
    return { target: t, login, marked: false, ledgerId: kind === 'error' ? ledgerId : null, timer: null };
  }
  await updateBuildClaimLine(ledgerId, { state: 'pending', lastDescription: description, lastPostedAt: new Date(s.nowMs()) }).catch(() => {});
  const line: LoopReviewLine = { target: t, login, marked: true, ledgerId, timer: null };
  line.timer = setInterval(() => {
    void s.gh
      .postLine(t.accountId, t.owner, t.name, t.headSha, context, { state: 'pending', description })
      .then(() => updateBuildClaimLine(ledgerId, { lastPostedAt: new Date() }))
      .catch((err) => log.warn(`story loop ${t.buildId}: review line not renewed (${errText(err)})`));
  }, TEAM_CLAIM_RENEW_MS);
  line.timer.unref?.();
  return line;
}

/** After the half: the final line (see the header). Never throws; null posts nothing. */
export async function endLoopReviewLine(line: LoopReviewLine | null, outcome: 'succeeded' | 'failed' | 'cancelled', log: Log): Promise<void> {
  if (line == null) return;
  if (line.timer != null) clearInterval(line.timer);
  line.timer = null;
  const s = buildClaimSeams();
  const { target: t, login, ledgerId } = line;
  const context = teamClaimContext(t.provider);
  const description = outcome === 'succeeded' ? reviewedLine(login, null) : unfinishedLine(login);
  const settled = outcome === 'succeeded' ? 'finished' : 'released';
  try {
    if (!line.marked) {
      // The pending write may have landed: the reconciler posts THIS line only if ours is the newest.
      if (ledgerId != null) await updateBuildClaimLine(ledgerId, { finalDescription: description });
      return;
    }
    let over: string | null = null;
    try {
      over = teammateHolds(await s.gh.listLines(t.accountId, t.owner, t.name, t.headSha, context), login, s.nowMs());
    } catch {
      over = null; // unreadable: post, a line left pending is worse
    }
    if (over != null) {
      if (ledgerId != null) await updateBuildClaimLine(ledgerId, { state: settled, lastError: 'superseded' });
      return;
    }
    try {
      await s.gh.postLine(t.accountId, t.owner, t.name, t.headSha, context, { state: 'success', description });
      if (ledgerId != null) await updateBuildClaimLine(ledgerId, { state: settled, lastDescription: description, lastPostedAt: new Date(s.nowMs()), lastError: null });
    } catch (err) {
      log.warn(`story loop ${t.buildId}: final review line not posted (${errText(err)}); the reconciler retries it`);
      if (ledgerId != null) {
        const kind = claimErrorKind(err, t.accountId);
        await updateBuildClaimLine(ledgerId, kind === 'no_access' ? { state: 'released', lastError: 'no_access' } : { finalDescription: description, lastError: errText(err) });
      }
    }
  } catch (err) {
    log.warn(`story loop ${t.buildId}: review line not settled (${errText(err)})`);
  }
}
