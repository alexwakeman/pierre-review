// ---------------------------------------------------------------------------
// THE SNAKE beside the review story (HomeSections.tsx, pages/home.css § the snake): ONE
// line through the boxes, which stand APART with every corner rounded alike. It starts
// along the first box's top edge, rounds its top-left corner, runs down its left side,
// rounds its bottom-left corner and runs along its bottom; near the far end it curves
// down across the gap and back along the next box's top edge, rounds that box's top-right
// corner and runs down its RIGHT side, and so on, alternating, ending along the last box's
// bottom where its far corner begins. Every bend has one radius: the boxes' own corners,
// traced exactly, and the two curves of each crossing. Pure geometry here; the page draws
// it as a mask over one band of colour.
// ---------------------------------------------------------------------------

export interface SnakeBox {
  top: number;
  bottom: number;
}

/**
 * The SVG path of the snake through `boxes` (top to bottom) in a column `width` wide.
 * `radius` is the boxes' corner radius; the line's centre sits half a `stroke` inside each
 * box's edge, so it bends with radius − stroke / 2 and traces the corners exactly. The gap
 * between two boxes must be at least 2 × radius − 2 × stroke for the crossing to fit.
 */
export function snakePath(boxes: SnakeBox[], width: number, radius: number, stroke: number): string {
  if (boxes.length === 0) return '';
  const h = stroke / 2;
  const R = radius - h; // every bend
  const left = h;
  const right = width - h;
  const f = (n: number): string => (Math.round(n * 100) / 100).toString();
  const r = f(R);
  const arc = (sweep: number, x: number, y: number): string => `A${r} ${r} 0 0 ${sweep} ${f(x)} ${f(y)}`;

  // box 0: from the start of its top-right corner, leftward along the top, round the top-left corner
  const top0 = boxes[0]!.top + h;
  let d = `M${f(right - R)} ${f(top0)}L${f(left + R)} ${f(top0)}${arc(0, left, top0 + R)}`;

  boxes.forEach((b, i) => {
    const side = i % 2 === 0 ? left : right; // the edge this box's line runs down
    const other = i % 2 === 0 ? right : left;
    const dir = i % 2 === 0 ? 1 : -1; // along the bottom: toward `other`
    const y = b.bottom - h;
    // down the side, round the box's bottom corner on that side
    d += `L${f(side)} ${f(y - R)}${arc(dir > 0 ? 0 : 1, side + dir * R, y)}`;
    const next = boxes[i + 1];
    if (!next) {
      // the last box: along its bottom to where its far corner begins
      d += `L${f(other - dir * R)} ${f(y)}`;
      return;
    }
    // along the bottom, then the crossing: curve down into the gap, down, curve back
    // along the next box's top edge, round its top corner on that side
    const x = other - dir * 3 * R; // where the crossing runs down
    const t = next.top + h;
    d += `L${f(x - dir * R)} ${f(y)}${arc(dir > 0 ? 1 : 0, x, y + R)}`;
    d += `L${f(x)} ${f(t - R)}${arc(dir > 0 ? 0 : 1, x + dir * R, t)}`;
    d += `L${f(other - dir * R)} ${f(t)}${arc(dir > 0 ? 1 : 0, other, t + R)}`;
  });
  return d;
}

/** The snake as an SVG mask image: a white line on nothing, the column's own size. */
export function snakeMask(boxes: SnakeBox[], width: number, height: number, radius: number, stroke: number): string {
  const d = snakePath(boxes, width, radius, stroke);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<path d="${d}" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
