// MANUAL REVIEWS AND TEAM CLAIMS (docs/CLAUDE-REVIEW.md § Team claims → Manual reviews; gap 4,
// 2026-11-05). A review the reader starts is never held back and never posts a pending line — a click is
// never refused. Two light touches instead:
//
//   SEEN (`readTeammateLinesForManualRun`): when a manual run starts, its providers' contexts are read
//     once; a teammate's live claim or "reviewed" line for the same model is stored (team_claim_seen),
//     so the AI Review tab names it beside the run ("Robin Dunn is reviewing this commit with Claude").
//     When the run ends, a stored "is reviewing" line is read again (`refreshTeammateLinesAfterRun`),
//     so it does not outlive the teammate's run.
//   POSTED (`markPostedReviewLines`): when a review the READER chose to post reaches GitHub ("Review and
//     post", or the Post button — on any run, auto ones kept in Limn included), each model in it gets
//     the same success line an automatic review writes: "<login> reviewed · approved" / "· 3 comments".
//     Teammates' automatic runs then step aside for that model at that commit. ⚠ Never a pending line,
//     never over a teammate's success or live claim, never twice (our own success already newest), never
//     on the reader's own PR (the author's lines hold nothing). Written ONCE, never retried.
//
// Only where the workspace has team claims on. Never throws; never inside a transaction.
import type { AiProviderId, ClaudeReviewVerdict } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import {
  decideTeamClaim,
  defaultTeamClaimGithub,
  isFreeTeamClaimLine,
  newestLine,
  postedTeammateReviewsAtHead,
  prAuthorLogin,
  reviewedLine,
  sameGithubLogin,
  teamClaimContext,
  teammateHolds,
  type TeamClaimGithub,
} from './team-claim.js';
import { forgetTeammateLine, recordTeammateLine, teammateLinesAtHead } from './team-claim-seen.js';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface ManualClaimTarget {
  accountId: number;
  prId: number;
  owner: string;
  name: string;
  number: number;
  headSha: string;
}

export type ManualSeenOutcome = 'no_login' | 'read';

/** Read the providers' lines once and store what a teammate holds (see the header). Never throws. */
export async function readTeammateLinesForManualRun(
  ctx: AgentContext,
  t: ManualClaimTarget,
  providers: readonly AiProviderId[],
  gh: TeamClaimGithub = defaultTeamClaimGithub,
  nowMs: () => number = Date.now,
): Promise<ManualSeenOutcome> {
  try {
    const login = await gh.login(t.accountId).catch(() => null);
    if (!login) return 'no_login';
    const author = await prAuthorLogin(ctx, t.accountId, t.prId);
    for (const provider of new Set(providers)) {
      try {
        const lines = await gh.listLines(t.accountId, t.owner, t.name, t.headSha, teamClaimContext(provider));
        const posted = await postedTeammateReviewsAtHead(ctx, t.accountId, t.prId, t.headSha, provider);
        const d = decideTeamClaim(lines, login, nowMs(), author, posted);
        if (d.kind === 'reviewed' || d.kind === 'reviewing') {
          await recordTeammateLine(ctx, t.accountId, t.prId, {
            provider,
            kind: d.kind,
            login: d.login,
            headSha: t.headSha,
            at: new Date(d.kind === 'reviewed' ? d.atMs : d.firstAtMs).toISOString(),
            description: d.description,
          });
        } else {
          await forgetTeammateLine(ctx, t.accountId, t.prId, t.headSha, provider);
        }
      } catch (err) {
        ctx.log.warn(`team claim pr ${t.prId}: ${provider} lines not read for a manual run: ${errText(err)}`);
      }
    }
    return 'read';
  } catch (err) {
    ctx.log.warn(`team claim pr ${t.prId}: manual run lines not read: ${errText(err)}`);
    return 'read';
  }
}

/** After a manual run: read again only the providers whose stored line still says "is reviewing". */
export async function refreshTeammateLinesAfterRun(
  ctx: AgentContext,
  t: ManualClaimTarget,
  gh: TeamClaimGithub = defaultTeamClaimGithub,
): Promise<void> {
  try {
    const reviewing = (await teammateLinesAtHead(ctx, t.accountId, t.prId, t.headSha))
      .filter((x) => x.kind === 'reviewing')
      .map((x) => x.provider);
    if (reviewing.length > 0) await readTeammateLinesForManualRun(ctx, t, reviewing, gh);
  } catch (err) {
    ctx.log.warn(`team claim pr ${t.prId}: lines not read again after a manual run: ${errText(err)}`);
  }
}

/** One model's share of a posted review. */
export interface PostedRunLine {
  provider: AiProviderId;
  /** This model's findings the post put on GitHub (0 = none of them, the review still went out). */
  comments: number;
}

export type MarkPostedOutcome =
  | 'posted'
  | 'no_login'
  | 'author' // the reader's own PR: their lines hold nothing
  | 'teammate' // a teammate's success or live claim stands
  | 'already' // our own success line is already the newest
  | 'failed';

/**
 * A REVIEW THE READER POSTED holds its commit for each model in it (see the header). One outcome per
 * provider. Never throws; never retried.
 */
export async function markPostedReviewLines(
  ctx: AgentContext,
  t: ManualClaimTarget,
  post: { runs: readonly PostedRunLine[]; verdict: ClaudeReviewVerdict | null; reviewUrl: string | null },
  gh: TeamClaimGithub = defaultTeamClaimGithub,
  nowMs: () => number = Date.now,
): Promise<Partial<Record<AiProviderId, MarkPostedOutcome>>> {
  const out: Partial<Record<AiProviderId, MarkPostedOutcome>> = {};
  const all = (o: MarkPostedOutcome) => {
    for (const r of post.runs) out[r.provider] = o;
    return out;
  };
  try {
    if (post.runs.length === 0) return out;
    const login = await gh.login(t.accountId).catch(() => null);
    if (!login) return all('no_login');
    const author = await prAuthorLogin(ctx, t.accountId, t.prId);
    if (sameGithubLogin(author, login)) return all('author');
    for (const run of post.runs) {
      if (out[run.provider] != null) continue; // one line per model
      const context = teamClaimContext(run.provider);
      try {
        const lines = await gh.listLines(t.accountId, t.owner, t.name, t.headSha, context);
        if (teammateHolds(lines, login, nowMs(), author) != null) {
          out[run.provider] = 'teammate';
          continue;
        }
        const last = newestLine(lines);
        if (last && last.state === 'success' && sameGithubLogin(last.login, login) && !isFreeTeamClaimLine(last)) {
          out[run.provider] = 'already';
          continue;
        }
        await gh.postLine(t.accountId, t.owner, t.name, t.headSha, context, {
          state: 'success',
          description: reviewedLine(login, run.comments, post.verdict),
          targetUrl: post.reviewUrl,
        });
        out[run.provider] = 'posted';
      } catch (err) {
        ctx.log.warn(`team claim pr ${t.prId}: posted review's ${run.provider} line not written: ${errText(err)}`);
        out[run.provider] = 'failed';
      }
    }
    return out;
  } catch (err) {
    ctx.log.warn(`team claim pr ${t.prId}: posted review's lines not written: ${errText(err)}`);
    return out;
  }
}
