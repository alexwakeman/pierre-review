// ---------------------------------------------------------------------------
// THE SNAKE beside the review story (HomeSections.tsx, pages/home.css § the snake): ONE
// line through the boxes, which stand APART with every corner rounded alike. It starts
// at the foot of the first box's top-right corner, rounds it, runs along the top, rounds
// its top-left corner, runs down its left side,
// rounds its bottom-left corner and runs along its bottom to the far corner, where it bends
// down and drops straight across the gap onto the RIGHT side of the box below, runs down
// it, and so on, alternating, ending round the last box's far bottom corner. Every bend has one radius: the boxes' own corners where the line traces them,
// and the drop at each far corner. Pure geometry here; the page draws
// it as a mask over one band of colour.
// ---------------------------------------------------------------------------

export interface SnakeBox {
  top: number;
  bottom: number;
}

/**
 * The SVG path of the snake through `boxes` (top to bottom) in a column `width` wide.
 * `radius` is the boxes' corner radius; the line's centre sits half a `stroke` inside each
 * box's edge, so it bends with radius − stroke / 2 and traces the corners exactly.
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

  // box 0: from the foot of its top-right corner, round that corner, leftward along the top,
  // round the top-left corner
  const top0 = boxes[0]!.top + h;
  let d = `M${f(right)} ${f(top0 + R)}${arc(0, right - R, top0)}L${f(left + R)} ${f(top0)}${arc(0, left, top0 + R)}`;

  boxes.forEach((b, i) => {
    const side = i % 2 === 0 ? left : right; // the edge this box's line runs down
    const other = i % 2 === 0 ? right : left;
    const dir = i % 2 === 0 ? 1 : -1; // along the bottom: toward `other`
    const y = b.bottom - h;
    // down the side, round the box's bottom corner on that side
    d += `L${f(side)} ${f(y - R)}${arc(dir > 0 ? 0 : 1, side + dir * R, y)}`;
    const next = boxes[i + 1];
    if (!next) {
      // the last box: along its bottom and round its far corner, ending at its foot
      d += `L${f(other - dir * R)} ${f(y)}${arc(dir > 0 ? 0 : 1, other, y - R)}`;
      return;
    }
    // along the bottom to the far corner, then down from it: one bend, and straight down
    // the gap onto the next box's side (the next loop carries on down it)
    d += `L${f(other - dir * R)} ${f(y)}${arc(dir > 0 ? 1 : 0, other, y + R)}`;
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
