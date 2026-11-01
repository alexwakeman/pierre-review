// THE BOARD UNDER THE STORY TRAY (docs/FRONTEND.md § This Sprint): on a wide screen the tray lies ON
// TOP of the board's right side, so these DOM reads keep the open card in view, step through the cards
// in board order and count the cards of the open card's row that the tray covers. They read the cards
// AS RENDERED (`[data-ident]` with a `[data-card-button]`), so every view (Theme, Critical path,
// People) is stepped in its own order — the lane board renders its cards row by row, column by column
// — and a card folded away in a collapsed column is skipped.

/** The space kept between a revealed card and the tray's edge (px). */
const EDGE_GAP = 16;
/** The room kept above a revealed card, for the overlay's sticky header (px). */
const TOP_GAP = 64;

/** The cards on the board, in board order. */
export function boardCards(board: HTMLElement): HTMLElement[] {
  return Array.from(board.querySelectorAll<HTMLElement>('[data-ident]')).filter((el) => el.querySelector('[data-card-button]') != null);
}

export function findCard(board: HTMLElement, ident: string): HTMLElement | null {
  return boardCards(board).find((el) => el.dataset.ident === ident) ?? null;
}

/** The ident `dir` cards on from `ident` in board order (none past either end). */
export function stepIdent(board: HTMLElement, ident: string | null, dir: 1 | -1): string | null {
  const idents = boardCards(board).map((el) => el.dataset.ident ?? '');
  if (idents.length === 0) return null;
  const at = ident != null ? idents.indexOf(ident) : -1;
  if (at === -1) return idents[dir === 1 ? 0 : idents.length - 1] ?? null;
  return idents[at + dir] ?? null;
}

/** Where the open card sits in board order (1-based), of how many; null when it is not on the board. */
export function cardPosition(board: HTMLElement, ident: string): { index: number; total: number } | null {
  const idents = boardCards(board).map((el) => el.dataset.ident);
  const at = idents.indexOf(ident);
  return at === -1 ? null : { index: at + 1, total: idents.length };
}

/** The nearest ancestor that scrolls on `axis` (from `el` itself up). */
function scroller(el: HTMLElement | null, axis: 'x' | 'y', stop?: HTMLElement): HTMLElement | null {
  for (let p = el; p != null && p !== stop; p = p.parentElement) {
    const s = getComputedStyle(p);
    const o = axis === 'x' ? s.overflowX : s.overflowY;
    if ((o === 'auto' || o === 'scroll') && (axis === 'x' ? p.scrollWidth > p.clientWidth : true)) return p;
  }
  return null;
}

/** The page's vertical scroll box the board (and the tray's dock) sits in. */
export function pageScroller(board: HTMLElement): HTMLElement | null {
  return scroller(board.parentElement, 'y');
}

/** The tray's left edge on screen: the dock's right edge less the tray's width (the tray's own rect
 *  is mid-slide while it opens). */
export function trayLeftEdge(board: HTMLElement, trayPx: number): number {
  const page = pageScroller(board);
  const right = page != null ? page.getBoundingClientRect().right : window.innerWidth;
  return right - trayPx;
}

function smooth(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/**
 * Scroll the board so `card` sits just left of the tray (and inside the page's visible height). Only
 * when it is hidden or covered: a card already in view does not move the board.
 */
export function revealCard(board: HTMLElement, card: HTMLElement, trayPx: number): void {
  const c = card.getBoundingClientRect();
  const h = scroller(card.parentElement, 'x', board);
  if (h != null && trayPx > 0) {
    const box = h.getBoundingClientRect();
    const right = Math.min(box.right, trayLeftEdge(board, trayPx)) - EDGE_GAP;
    const left = box.left + EDGE_GAP;
    let dx = 0;
    if (c.right > right) dx = Math.min(c.right - right, c.left - left);
    else if (c.left < left) dx = c.left - left;
    if (dx !== 0) h.scrollBy({ left: dx, behavior: smooth() });
  }
  const v = pageScroller(board);
  if (v != null) {
    const box = v.getBoundingClientRect();
    let dy = 0;
    if (c.top < box.top + TOP_GAP) dy = c.top - box.top - TOP_GAP;
    else if (c.bottom > box.bottom - EDGE_GAP) dy = Math.min(c.bottom - box.bottom + EDGE_GAP, c.top - box.top - TOP_GAP);
    if (dy !== 0) v.scrollBy({ top: dy, behavior: smooth() });
  }
}

/** The cards in the open card's row (same grid row: the same slot top) that the tray covers, nearest
 *  first, and where that row's top is on screen. */
export function coveredInRow(board: HTMLElement, ident: string, trayPx: number): { idents: string[]; rowTop: number; edge: number } | null {
  const card = findCard(board, ident);
  if (card == null || trayPx <= 0) return null;
  const slotTop = (el: HTMLElement): number => (el.parentElement ?? el).getBoundingClientRect().top;
  const top = slotTop(card);
  const edge = trayLeftEdge(board, trayPx);
  const grid = card.parentElement?.parentElement ?? null;
  const covered = boardCards(board)
    .filter((el) => el !== card && el.parentElement?.parentElement === grid && Math.abs(slotTop(el) - top) < 2)
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.left + r.width / 2 > edge)
    .sort((a, b) => a.r.left - b.r.left);
  return { idents: covered.map(({ el }) => el.dataset.ident ?? ''), rowTop: card.getBoundingClientRect().top, edge };
}
