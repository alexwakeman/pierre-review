import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { PUSH_SUMMARY_MAX_CHARS } from '@pierre-review/shared';
import type { CompareDiffResult } from '../../github/compare.js';
import type { AgentContext } from '../agent-context.js';
import type { PromptPushes } from './prompts.js';

// THE PUSH SUMMARY (docs/CLAUDE-REVIEW.md § Push summaries). A FULL review run (never a replies pass)
// summarises the pushes since the previous full review on the PR — what changed, and how it bears on
// the open findings and threads — as ONE field of its own result: no extra model run. Rapid
// consecutive pushes between two reviews are one range, so one summary.
//
//   • `previousFullReviewHead` — where the range starts: the newest SUCCEEDED full review before this
//     run (any provider; `kind IS NULL` — a replies pass and a teammate's review are not ranges);
//   • `planPushes` — whether this run is asked for one, and with which diff (pure);
//   • `cleanPushSummary` — the model's raw text → what is stored (plain text, clipped).

/** The head of the newest succeeded full review on the PR before run `beforeReviewId`; null = none. */
export async function previousFullReviewHead(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  beforeReviewId: number,
): Promise<string | null> {
  const cr = (ctx.schema as any).claudeReviews;
  const rows = (await ctx.db
    .select({ headSha: cr.headSha })
    .from(cr)
    .where(
      and(
        eq(cr.accountId, accountId),
        eq(cr.prId, prId),
        eq(cr.status, 'succeeded'),
        isNull(cr.kind),
        lt(cr.id, beforeReviewId),
      ),
    )
    .orderBy(desc(cr.id))
    .limit(1)
    .execute()) as Array<{ headSha: string }>;
  return rows[0]?.headSha ?? null;
}

/**
 * What this run is asked to summarise, or null when nothing is (no push since the previous full
 * review, or no honest diff of the pushes). `followUpSince` is the follow-up's own "changes since"
 * diff and the head it starts from; `fetchSince` reads the pushes' diff when that one does not cover
 * them (one compare call; it never throws).
 */
export async function planPushes(input: {
  prevHead: string | null;
  headSha: string;
  followUp: { priorHeadSha: string; since: CompareDiffResult | null } | null;
  fetchSince: (baseSha: string) => Promise<CompareDiffResult | null>;
}): Promise<PromptPushes | null> {
  const { prevHead, headSha, followUp } = input;
  if (prevHead == null) return { fromSha: null, inFollowUp: false, since: null };
  if (prevHead === headSha) return null;
  if (followUp && followUp.priorHeadSha === prevHead && followUp.since?.ok && followUp.since.files.length > 0) {
    return { fromSha: prevHead, inFollowUp: true, since: null };
  }
  let since: CompareDiffResult | null = null;
  try {
    since = await input.fetchSince(prevHead);
  } catch {
    since = null;
  }
  // No diff, or the pushes changed none of the PR's files (a merge from the base branch): nothing
  // to summarise honestly.
  if (!since?.ok || since.files.length === 0) return null;
  return { fromSha: prevHead, inFollowUp: false, since };
}

const MAX_LINES = 4;

/**
 * The model's raw `pushSummary` → the stored text, or null. Plain text: control characters go, at
 * most four non-empty lines, at most PUSH_SUMMARY_MAX_CHARS (cut at a word, marked with '…').
 */
export function cleanPushSummary(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const lines = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, MAX_LINES);
  let text = lines.join('\n');
  if (text === '') return null;
  if (text.length > PUSH_SUMMARY_MAX_CHARS) {
    const cut = text.slice(0, PUSH_SUMMARY_MAX_CHARS - 1);
    const space = cut.lastIndexOf(' ');
    text = `${(space > PUSH_SUMMARY_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return text;
}
