// ---------------------------------------------------------------------------
// THE SNAKE beside the review story (HomeSections.tsx, pages/home.css § the snake): ONE
// line that runs down the left side of the first box, rounds its bottom-left corner,
// crosses its bottom, turns down across the gap and runs down the RIGHT side of the box
// below, and so on, alternating, to the bottom of the last box. Every turn has the same
// radius and the line never breaks. Pure geometry here; the page draws it as a mask over
// the shared colour wheel.
// ---------------------------------------------------------------------------

export interface SnakeBox {
  top: number;
  bottom: number;
}

/** The SVG path of the snake through `boxes` (top to bottom) in a column `width` wide. */
export function snakePath(boxes: SnakeBox[], width: number, radius: number, stroke: number): string {
  if (boxes.length === 0) return '';
  const h = stroke / 2;
  const left = h;
  const right = width - h;
  const f = (n: number): string => (Math.round(n * 100) / 100).toString();
  const r = f(radius);
  let d = `M${f(left)} ${f(boxes[0]!.top)}`;
  boxes.forEach((b, i) => {
    const side = i % 2 === 0 ? left : right; // the edge this box's line runs down
    const other = i % 2 === 0 ? right : left;
    const dir = i % 2 === 0 ? 1 : -1; // across the bottom: rightward from the left side
    const y = b.bottom - h;
    // down the side, then round the box's own bottom corner
    d += `L${f(side)} ${f(y - radius)}A${r} ${r} 0 0 ${dir > 0 ? 0 : 1} ${f(side + dir * radius)} ${f(y)}`;
    if (i === boxes.length - 1) {
      d += `L${f(other)} ${f(y)}`;
      return;
    }
    // along the seam, then round the next box's top corner and down its side
    d += `L${f(other - dir * radius)} ${f(y)}A${r} ${r} 0 0 ${dir > 0 ? 1 : 0} ${f(other)} ${f(y + radius)}`;
  });
  return d;
}

/** The snake as an SVG mask image: a white line on nothing, the column's own size. */
export function snakeMask(boxes: SnakeBox[], width: number, height: number, radius: number, stroke: number): string {
  const d = snakePath(boxes, width, radius, stroke);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<path d="${d}" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="butt" stroke-linejoin="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
