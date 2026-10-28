// THE OPEN PRs WINDOW — how much of the (already sorted, already filtered) Open PRs list is drawn.
//
// Measured 2026-10-28 on the dev DB: GET /api/open-prs for a 739-PR workspace answers in ~130 ms
// (840 KB), and the batched state reads in ~10–20 ms each. The cost was the BROWSER: 760 cards,
// ~46k DOM nodes and ~7 s of main-thread long tasks (one of 2.2 s) before the board settled. So the
// endpoint is NOT paged — counts, sorts, the repo filter and the ticket stacks all keep working on
// the full population — and only the DRAWING is: the first OPEN_PRS_PAGE cards, then the next
// OPEN_PRS_PAGE each time the reader nears the bottom (or presses "Show more").
//
// Pure functions; the hook in OpenPrsCards.tsx owns the state. The rules:
//   - the window counts CARDS. In the ticket stacks it takes a stack of up to a page WHOLE (so a small
//     stack is never split), and CUTS a bigger one — above all the one "No ticket" stack, which can
//     hold hundreds — at the limit; its header still counts every PR in it. So the drawn count runs
//     past the limit by less than a page;
//   - Show more and the scroll trigger grow from what is DRAWN, so each always draws new cards;
//   - the window RESETS to one page when the list's identity changes (workspace, repo filter, sort,
//     layout) — never when the data refreshes under the same identity (a new PR arriving must not
//     snap the reader back to the top);
//   - a jump to something beyond the window (an "Also in" ticket's stack) GROWS the window to
//     include it, never shrinks it.

export const OPEN_PRS_PAGE = 10;

/** The window after one more page, never past the total. */
export function nextLimit(limit: number, total: number, page: number = OPEN_PRS_PAGE): number {
  return Math.min(Math.max(total, page), limit + page);
}

/**
 * How many cards to draw of each stack so they fill `limit`, in order: one entry per drawn stack.
 * A stack of at most `page` cards is drawn whole; a bigger one is cut where the limit falls (at
 * least one card). Stops once the limit is reached; at least one stack whenever there is one.
 */
export function stackRowsWithin(
  sizes: readonly number[],
  limit: number,
  page: number = OPEN_PRS_PAGE,
): number[] {
  const out: number[] = [];
  let cards = 0;
  for (let i = 0; i < sizes.length; i++) {
    if (i > 0 && cards >= limit) break;
    const size = sizes[i] ?? 0;
    const take = size > page ? Math.min(size, Math.max(1, limit - cards)) : size;
    out.push(take);
    cards += take;
  }
  return out;
}

/** The smallest window (a whole number of pages) that draws the item at `index` (list rows) or
 *  the stack at `index` (stack sizes given — every card before it, so it draws at least its first
 *  card). Never smaller than `limit`. */
export function limitToInclude(
  index: number,
  limit: number,
  sizes?: readonly number[],
  page: number = OPEN_PRS_PAGE,
): number {
  if (index < 0) return limit;
  // Cards up to and including the target (a stack target needs every card before it plus one).
  const before = sizes == null ? index : sizes.slice(0, index).reduce((n, s) => n + s, 0);
  const needed = before + 1;
  const pages = Math.ceil(needed / page) * page;
  return Math.max(limit, pages);
}

/** A remembered window: the list's identity and how far the reader had opened it. */
export interface OpenPrsWindowMemo {
  key: string;
  limit: number;
}

/** The window for `key`: what was remembered under the SAME key, else one page. */
export function limitFor(memo: OpenPrsWindowMemo | null, key: string, page: number = OPEN_PRS_PAGE): number {
  return memo != null && memo.key === key ? Math.max(page, memo.limit) : page;
}

/** The memo once the list's identity is `key`: kept for the same key, else one page for the new
 *  one (the old identity is forgotten — going back to it starts at one page too). */
export function settleMemo(
  memo: OpenPrsWindowMemo | null,
  key: string,
  page: number = OPEN_PRS_PAGE,
): OpenPrsWindowMemo {
  return memo != null && memo.key === key ? memo : { key, limit: page };
}

/** Where the list lives, from outside the cards: the workspace and the Open PRs repo filter. */
export interface OpenPrsWindowScope {
  workspaceId: number | null;
  /** null = every repo. */
  repoIds: readonly number[] | null;
}

/**
 * The list's IDENTITY: what, changed, starts the window again at one page — the workspace, the repo
 * filter (order-free), the sort and the layout (ticket stacks or the plain list). Deliberately NOT
 * the data: a refresh that adds or drops a PR keeps the reader where they are.
 */
export function openPrsWindowKey(
  scope: OpenPrsWindowScope,
  sort: { key: string; dir: string } | null,
  stacks: boolean,
): string {
  const repos = scope.repoIds == null ? 'all' : [...scope.repoIds].sort((a, b) => a - b).join(',');
  const order = sort == null ? 'default' : `${sort.key}:${sort.dir}`;
  return `ws:${scope.workspaceId ?? 'none'}|repos:${repos}|sort:${order}|${stacks ? 'stacks' : 'list'}`;
}
