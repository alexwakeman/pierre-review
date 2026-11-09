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

// ---- PR-LEVEL FINDINGS: the PR conversation (docs/CLAUDE-REVIEW.md § Replies to Limn's findings) ----
// A finding Limn could not place on a line is posted as a PR COMMENT. GitHub does not thread those,
// so its "replies" are the PR conversation after it: every later PR comment by a person, and every
// non-empty review body by a person. ONE pool per PR, refs C1…Cn, so a comment that answers two
// findings is sent once; each finding names the refs posted after it, the ones that link or quote it
// first. The model must CITE the ref it judged (`replyRef`): a stray comment never settles a finding.

/** One person's PR comment (or review body) in a PR's conversation pool. */
export interface PrConversationReply extends FindingReply {
  // 'C1'…, oldest first across the pool.
  ref: string;
  // The issue comment's id (`#issuecomment-<id>`), or the review's (`#pullrequestreview-<id>`).
  commentId: string | null;
  kind: 'comment' | 'review';
  // github.com link to it, when the PR's repo is known.
  url: string | null;
}

/** A PR-level finding's view of the conversation after it (`PriorFindingForFollowUp.conversation`). */
export interface FindingConversation {
  // The finding row that owns the PR comment (the first POSTED one up the re-raise chain).
  ownerFindingId: number;
  // The finding comment's id, and its github.com link.
  commentId: string | null;
  url: string | null;
  // The candidate replies: linked / quoting ones first, then newest first; at most PR_LEVEL_REPLIES_MAX.
  replies: PrConversationReply[];
  // The refs among `replies` that link to or quote the finding.
  linked: string[];
  // Limn already said "Still open" (or pushed back) about this finding once — ever.
  pushedBack: boolean;
}

/** At most this many candidate comments per PR-level finding. */
export const PR_LEVEL_REPLIES_MAX = 5;

const normText = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Does this comment point at the finding? It links the finding comment (`issuecomment-<id>`), or it
 * quotes the finding's title or its first line (at least 12 characters, so "LGTM" never matches). Pure.
 */
export function linksFinding(
  body: string,
  f: { commentId: string | null; title: string; body: string },
): boolean {
  if (f.commentId && new RegExp(`issuecomment-${f.commentId}(?!\\d)`).test(body)) return true;
  const text = normText(body);
  const firstLine = (f.body.split('\n').find((l) => l.replace(/[*_#>`\s-]/g, '') !== '') ?? '').replace(/[*_#>`]/g, '');
  for (const q of [f.title, firstLine]) {
    const n = normText(q.replace(/[*_#>`]/g, ''));
    if (n.length >= 12 && text.includes(n)) return true;
  }
  return false;
}

/** One person's comment as the pool reads it (already filtered: not automation, not Limn's). */
export interface PoolComment {
  author: string;
  body: string;
  atMs: number;
  commentId: string | null;
  kind: 'comment' | 'review';
  url: string | null;
}

/** One PR-level finding as the pool reads it. */
export interface PoolFinding {
  // The finding the follow-up names (its id), and the owner row that holds the PR comment.
  findingId: number;
  ownerFindingId: number;
  commentId: string | null;
  url: string | null;
  postedAtMs: number;
  title: string;
  body: string;
  pushedBack: boolean;
}

/**
 * THE POOL: each PR-level finding's candidate comments (posted after the finding comment), linked
 * ones first, then newest first, at most PR_LEVEL_REPLIES_MAX; each clipped to `clipChars`. Refs
 * C1…Cn are handed out over the UNION of the kept comments, oldest first, so a comment kept for two
 * findings carries one ref. Pure.
 */
export function buildConversationPool(
  comments: readonly PoolComment[],
  findings: readonly PoolFinding[],
  clipChars: number,
): Map<number, FindingConversation> {
  const sorted = [...comments].sort((a, b) => a.atMs - b.atMs);
  const kept = new Map<number, Array<{ c: PoolComment; linked: boolean }>>();
  const used = new Set<PoolComment>();
  for (const f of findings) {
    const after = sorted.filter((c) => c.atMs > f.postedAtMs);
    const ranked = after
      .map((c) => ({ c, linked: linksFinding(c.body, f) }))
      .sort((a, b) => Number(b.linked) - Number(a.linked) || b.c.atMs - a.c.atMs)
      .slice(0, PR_LEVEL_REPLIES_MAX);
    kept.set(f.findingId, ranked);
    for (const r of ranked) used.add(r.c);
  }
  const refOf = new Map<PoolComment, string>();
  sorted.filter((c) => used.has(c)).forEach((c, i) => refOf.set(c, `C${i + 1}`));
  const out = new Map<number, FindingConversation>();
  for (const f of findings) {
    const ranked = kept.get(f.findingId) ?? [];
    out.set(f.findingId, {
      ownerFindingId: f.ownerFindingId,
      commentId: f.commentId,
      url: f.url,
      replies: ranked.map(({ c }) => ({
        ref: refOf.get(c)!,
        author: c.author,
        body: c.body.length > clipChars ? `${c.body.slice(0, clipChars)}…` : c.body,
        at: new Date(c.atMs).toISOString(),
        commentId: c.commentId,
        kind: c.kind,
        url: c.url,
      })),
      linked: ranked.filter((r) => r.linked).map((r) => refOf.get(r.c)!),
      pushedBack: f.pushedBack,
    });
  }
  return out;
}

/**
 * The shared pool as the prompts list it: every comment any of these conversations names, once,
 * in ref order. Pure.
 */
export function conversationPool(
  conversations: ReadonlyArray<FindingConversation | null | undefined>,
): PrConversationReply[] {
  const byRef = new Map<string, PrConversationReply>();
  for (const c of conversations) for (const r of c?.replies ?? []) if (!byRef.has(r.ref)) byRef.set(r.ref, r);
  return [...byRef.values()].sort((a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1)));
}
