// The small, dependency-free half of finding-replies.ts: the reply shape and its clips. Split out
// so follow-up.ts (pure) can read it without importing the DB loader.

/** One person's reply on a finding's GitHub thread, as the prompt and the follow-up record read it. */
export interface FindingReply {
  author: string;
  body: string;
  at: string; // ISO-8601
  // Posted from Limn under the account's login (a reply Claude drafted, or an earlier auto reply).
  // Kept as CONTEXT so the conversation reads whole; only a reply WITHOUT it can be judged.
  fromLimn?: boolean;
}

/** The people's replies a re-review may judge (everything but the Limn-posted ones). */
export function judgeableReplies(replies: readonly FindingReply[] | null | undefined): FindingReply[] {
  return (replies ?? []).filter((r) => !r.fromLimn);
}

// The quoted excerpt stored on the follow-up item (shown on screen).
export const REPLY_EXCERPT_CHARS = 280;
// What Limn may post back: the acknowledgement or the pushback.
export const RESPONSE_CHARS = 600;

/** The short excerpt of a reply stored on the follow-up item. */
export function replyExcerpt(r: FindingReply): { author: string; excerpt: string } {
  const one = r.body.replace(/\s+/g, ' ').trim();
  return { author: r.author, excerpt: one.length > REPLY_EXCERPT_CHARS ? `${one.slice(0, REPLY_EXCERPT_CHARS)}…` : one };
}
