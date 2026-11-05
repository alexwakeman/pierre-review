// MY TURN: A POINT A LIMN HOLDS OPEN ON YOUR PR (docs/CLAUDE-REVIEW.md § Still-open points → My Turn).
//
// The reader's own open PR has a review thread whose point a Limn — the reader's own, or a
// teammate's posted review — judged STILL OPEN (the thread cards' fold,
// review/claude-review/thread-judgements.ts `getThreadJudgements`, so the card and the thread say the
// same thing). It joins the `own_thread` card kind ("Unanswered thread"), with its own line.
//
// THE BALL RULE, state-derived: the card stands only while
//   • the judgement was made at the PR's CURRENT head (a push since is the author's answer: the next
//     review judges the new code),
//   • the thread is unresolved on GitHub (resolving it again is the author's answer), and
//   • the author has not replied on the thread since the judgement (a Limn post never counts:
//     `trueAuthorId`, and Limn's marker).
// DB only, account-scoped. Never throws (a failed read is no card).
import { and, inArray } from 'drizzle-orm';
import type { ClaudeThreadStillOpen } from '@pierre-review/shared';
import { db, schema } from './client.js';
import type { AgentContext } from '../review/agent-context.js';

const LIMN_MARKER_RE = /<!--\s*pierre:claude-review/i;

export interface OwnStillOpenThread {
  prId: number;
  threadId: number;
  stillOpen: ClaudeThreadStillOpen;
  // ms: when the judgement was made (the card's `since`).
  at: number;
}

/** Is a still-open word still the author's to answer? Pure (exported for the test). */
export function stillOpenOwesAuthor(a: {
  stillOpen: Pick<ClaudeThreadStillOpen, 'headSha' | 'threadResolved' | 'at'>;
  prHeadSha: string | null;
  authorRepliesAt: readonly number[];
}): boolean {
  if (a.stillOpen.threadResolved) return false;
  if (a.prHeadSha == null || a.stillOpen.headSha === '') return false;
  if (a.stillOpen.headSha.toLowerCase() !== a.prHeadSha.toLowerCase()) return false;
  const at = a.stillOpen.at != null ? Date.parse(a.stillOpen.at) : 0;
  return !a.authorRepliesAt.some((t) => t > at);
}

export async function stillOpenThreadsForOwnPrs(
  accountId: number,
  prs: ReadonlyArray<{ id: number; headSha: string | null }>,
  authorUserId: number,
): Promise<OwnStillOpenThread[]> {
  if (prs.length === 0) return [];
  try {
    const { getThreadJudgements } = await import('../review/claude-review/thread-judgements.js');
    // The fold reads only the schema and the DB.
    const ctx = { db, schema } as unknown as AgentContext;
    const byPr = await getThreadJudgements(ctx, prs.map((p) => p.id), accountId);
    const held = byPr.flatMap((p) => p.judgements.filter((j) => j.stillOpen != null).map((j) => ({ prId: p.prId, j })));
    if (held.length === 0) return [];
    const rc = schema.reviewComments;
    const replies = (await db
      .select({ threadId: rc.threadId, createdAt: rc.createdAt, body: rc.body, poster: rc.limnPostedByUserId, authorId: rc.authorId })
      .from(rc)
      .where(and(inArray(rc.threadId, held.map((h) => h.j.threadId)), inArray(rc.prId, prs.map((p) => p.id))))
      .execute()) as Array<{ threadId: number; createdAt: Date | null; body: string | null; poster: number | null; authorId: number | null }>;
    const authorReplies = new Map<number, number[]>();
    for (const r of replies) {
      if ((r.poster ?? r.authorId) !== authorUserId || r.poster != null || LIMN_MARKER_RE.test(r.body ?? '')) continue;
      const list = authorReplies.get(r.threadId) ?? [];
      list.push(r.createdAt?.getTime() ?? 0);
      authorReplies.set(r.threadId, list);
    }
    const headOf = new Map(prs.map((p) => [p.id, p.headSha]));
    const out: OwnStillOpenThread[] = [];
    for (const { prId, j } of held) {
      const so = j.stillOpen!;
      if (!stillOpenOwesAuthor({ stillOpen: so, prHeadSha: headOf.get(prId) ?? null, authorRepliesAt: authorReplies.get(j.threadId) ?? [] })) continue;
      out.push({ prId, threadId: j.threadId, stillOpen: so, at: so.at != null ? Date.parse(so.at) : 0 });
    }
    return out;
  } catch {
    return [];
  }
}

