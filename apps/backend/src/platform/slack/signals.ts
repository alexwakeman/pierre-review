import { and, eq } from 'drizzle-orm';
import type { ClaudeReviewVerdict } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import { proSchemaFor } from '../db.js';
import { escapeSlack, prLink, slackLink } from './links.js';
import type { SlackMessage } from './report.js';
import { postToSlack } from './send.js';
import { readTargetRow, type SlackTargetRow } from './targets.js';

// ── THE TWO SLACK EVENT SIGNALS (Pro, `slackDigest`; plugin migration 0040) ──────────────────
//
// Per workspace, each its own switch on the delivery row, both OFF by default:
//   • "Claude Review ran"   — `notify_reviews`: PR, author, verdict and the run's OWN summary,
//     trimmed. Never the findings. Failed / cancelled runs never reach here (the host fires only
//     on success), and a `skip`-routed run (nothing to review) posts nothing.
//   • "Pull request merged" — `notify_merges`: PR, repo and WHO merged it. The host fires only for
//     a merge SEEN live (core sync/merge-notice.ts), never for history.
//
// ⚠ CLAIM, THEN SEND, NEVER RETRY. A row in `slack_signal_notices` is inserted (ON CONFLICT DO
// NOTHING) BEFORE the webhook call; no row returned ⇒ somebody already sent it. A failed post is
// logged and stays claimed: a retry double-posts whenever Slack accepted but answered late.
// ⚠ GATED BY the row's own switch (`notify_reviews` / `notify_merges`, both off by default).
// ⚠ NEVER LOG THE WEBHOOK URL.

const SUMMARY_MAX = 700;

const VERDICT_TEXT: Record<ClaudeReviewVerdict, string> = {
  APPROVE: 'Approve',
  REQUEST_CHANGES: 'Request changes',
  COMMENT: 'Comment',
};

const mrkdwn = (text: string) => ({ type: 'mrkdwn', text, verbatim: true });

/** The PR's facts, account-scoped. null when the PR is not this account's. */
interface PrFacts {
  prId: number;
  repoId: number;
  number: number;
  title: string;
  owner: string;
  name: string;
  authorLogin: string | null;
  mergedByLogin: string | null;
}

async function prFacts(ctx: ProContext, accountId: number, prId: number): Promise<PrFacts | null> {
  const pr = ctx.schema.pullRequests;
  const repos = ctx.schema.repos;
  const rows = (await ctx.db
    .select({
      prId: pr.id,
      repoId: pr.repoId,
      number: pr.number,
      title: pr.title,
      owner: repos.owner,
      name: repos.name,
      authorId: pr.authorId,
      mergedById: pr.mergedById,
    })
    .from(pr)
    .innerJoin(repos, eq(repos.id, pr.repoId))
    .where(and(eq(pr.id, prId), eq(pr.accountId, accountId)))
    .limit(1)
    .execute()) as Array<Omit<PrFacts, 'authorLogin' | 'mergedByLogin'> & {
    authorId: number | null;
    mergedById: number | null;
  }>;
  const row = rows[0];
  if (row == null) return null;
  const loginOf = async (id: number | null): Promise<string | null> => {
    if (id == null) return null;
    const users = ctx.schema.users;
    const u = (await ctx.db
      .select({ login: users.githubLogin })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
      .execute()) as Array<{ login: string }>;
    return u[0]?.login ?? null;
  };
  const { authorId, mergedById, ...rest } = row;
  return { ...rest, authorLogin: await loginOf(authorId), mergedByLogin: await loginOf(mergedById) };
}

/** The ONE workspace a repo belongs to (a repo is in exactly one). */
async function workspaceOfRepo(
  ctx: ProContext,
  accountId: number,
  repoId: number,
): Promise<number | null> {
  const wr = ctx.schema.workspaceRepos;
  const rows = (await ctx.db
    .select({ workspaceId: wr.workspaceId })
    .from(wr)
    .where(and(eq(wr.accountId, accountId), eq(wr.repoId, repoId)))
    .limit(1)
    .execute()) as Array<{ workspaceId: number }>;
  return rows[0]?.workspaceId ?? null;
}

/** Claim the (account, kind, ref) marker. true = this caller owns the send. */
export async function claimNotice(
  ctx: ProContext,
  accountId: number,
  kind: 'merge' | 'review',
  refId: number,
): Promise<boolean> {
  const pro = proSchemaFor(ctx.isPg);
  const t = pro.slackSignalNotices;
  const rows = await ctx.db
    .insert(t)
    .values({ accountId, kind, refId })
    .onConflictDoNothing({ target: [t.accountId, t.kind, t.refId] })
    .returning({ id: t.id })
    .execute();
  return rows.length > 0;
}

const githubPrUrl = (f: PrFacts): string =>
  `https://github.com/${encodeURIComponent(f.owner)}/${encodeURIComponent(f.name)}/pull/${f.number}`;

/** `<limn|owner/name#12 Title> · <github|GitHub>` — the Limn link when the host gave a base. */
function prLine(ctx: ProContext, workspaceId: number, f: PrFacts): string {
  const label = `${f.owner}/${f.name}#${f.number} ${f.title}`;
  const limn = prLink(ctx, workspaceId, f.prId);
  const gh = githubPrUrl(f);
  return limn == null
    ? slackLink(gh, label)
    : `${slackLink(limn, label)} · ${slackLink(gh, 'GitHub')}`;
}

const trimSummary = (s: string): string => {
  const flat = s.replace(/\s+\n/g, '\n').trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : flat;
};

/** Pure builder for the "Claude Review ran" message. Exported for its test. */
export function reviewMessage(
  ctx: ProContext,
  workspaceId: number,
  f: PrFacts,
  verdict: ClaudeReviewVerdict | null,
  summary: string | null,
): SlackMessage {
  const by = f.authorLogin ? ` by @${escapeSlack(f.authorLogin)}` : '';
  const head = `*Claude Review ran* on ${prLine(ctx, workspaceId, f)}${by}`;
  const lines = [head];
  if (verdict != null) lines.push(`Verdict: *${VERDICT_TEXT[verdict] ?? verdict}*`);
  const body = summary == null ? '' : trimSummary(summary);
  if (body !== '') lines.push(body.split('\n').map((l) => `> ${escapeSlack(l)}`).join('\n'));
  return {
    blocks: [{ type: 'section', text: mrkdwn(lines.join('\n')) }],
    text: `Claude Review ran on ${escapeSlack(`${f.owner}/${f.name}#${f.number}`)}`,
  };
}

/** Pure builder for the "Pull request merged" message. Exported for its test. */
export function mergeMessage(ctx: ProContext, workspaceId: number, f: PrFacts): SlackMessage {
  const who = f.mergedByLogin ? `@${escapeSlack(f.mergedByLogin)}` : 'Someone';
  const author = f.authorLogin ? ` (opened by @${escapeSlack(f.authorLogin)})` : '';
  return {
    blocks: [
      {
        type: 'section',
        text: mrkdwn(`*Merged* · ${who} merged ${prLine(ctx, workspaceId, f)}${author}`),
      },
    ],
    text: `${who} merged ${escapeSlack(`${f.owner}/${f.name}#${f.number}`)}`,
  };
}

/** The delivery row for the PR's workspace, if this signal may fire for it at all. */
async function targetFor(
  ctx: ProContext,
  accountId: number,
  repoId: number,
  flag: 'notifyReviews' | 'notifyMerges',
): Promise<{ row: SlackTargetRow; workspaceId: number } | null> {
  const workspaceId = await workspaceOfRepo(ctx, accountId, repoId);
  if (workspaceId == null) return null;
  const row = await readTargetRow(ctx, accountId, workspaceId);
  if (row == null || row.webhookUrl.trim() === '' || !(row[flag] ?? false)) return null;
  return { row, workspaceId };
}

export async function onClaudeReviewCompleted(
  ctx: ProContext,
  e: { accountId: number; prId: number; reviewId: number },
): Promise<void> {
  const facts = await prFacts(ctx, e.accountId, e.prId);
  if (facts == null) return;
  const target = await targetFor(ctx, e.accountId, facts.repoId, 'notifyReviews');
  if (target == null) return;
  const cr = ctx.schema.claudeReviews;
  const runs = (await ctx.db
    .select({
      status: cr.status,
      verdict: cr.verdict,
      summary: cr.summary,
      reviewMode: cr.reviewMode,
    })
    .from(cr)
    .where(and(eq(cr.id, e.reviewId), eq(cr.accountId, e.accountId), eq(cr.prId, e.prId)))
    .limit(1)
    .execute()) as Array<{
    status: string;
    verdict: ClaudeReviewVerdict | null;
    summary: string | null;
    reviewMode: string | null;
  }>;
  const run = runs[0];
  // Succeeded runs only, and not a `skip` (no code to review — a message would be noise).
  if (run == null || run.status !== 'succeeded' || run.reviewMode === 'skip') return;
  if (!(await claimNotice(ctx, e.accountId, 'review', e.reviewId))) return;
  try {
    await postToSlack(
      target.row.webhookUrl,
      reviewMessage(ctx, target.workspaceId, facts, run.verdict, run.summary),
    );
  } catch (err) {
    ctx.log.warn(
      { err, accountId: e.accountId, workspaceId: target.workspaceId, reviewId: e.reviewId },
      'slack review signal send failed',
    );
  }
}

export async function onPullRequestMerged(
  ctx: ProContext,
  e: { accountId: number; repoId: number; prId: number },
): Promise<void> {
  const target = await targetFor(ctx, e.accountId, e.repoId, 'notifyMerges');
  if (target == null) return;
  const facts = await prFacts(ctx, e.accountId, e.prId);
  if (facts == null) return;
  if (!(await claimNotice(ctx, e.accountId, 'merge', e.prId))) return;
  try {
    await postToSlack(target.row.webhookUrl, mergeMessage(ctx, target.workspaceId, facts));
  } catch (err) {
    ctx.log.warn(
      { err, accountId: e.accountId, workspaceId: target.workspaceId, prId: e.prId },
      'slack merge signal send failed',
    );
  }
}

/** Wire both hooks to the host. */
export function registerSlackSignals(ctx: ProContext): void {
  ctx.registerEventHooks?.({
    onClaudeReviewCompleted: (e) => onClaudeReviewCompleted(ctx, e),
    onPullRequestMerged: (e) => onPullRequestMerged(ctx, e),
  });
}
