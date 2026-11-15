import { Arcs } from './Arcs';
import { chainQuarters, quartetQuarters, SITE_CHAIN } from './geometry';
import type { Corner, Quarter, RunName } from './geometry';

// ---------------------------------------------------------------------------
// The compositions. Every picture on the site is one of these, drawn from the same
// banded quarter (geometry.ts): no photographs, no product screenshots.
//
//   Quartet    four equal quarters facing one centre, "four sensible people
//              conversing", in the close at the foot of the page. Its quarters
//              start well beyond the opposite corners, cross through the middle as
//              it scrolls into view, and land overlapping.
//   Chain      quarters linked end to end, each a different voice, whose bands run
//              on from link to link (the hero's big picture). Its links start
//              mirrored across the tile and cross through each other into place as
//              the reader scrolls down.
//   Orchestra  the seating plan from above: rows of chairs in sections around
//              the conductor
//   Combo      a jazz band: four players of different weight, facing in, their
//              sound overlapping and mixing in the middle
// ---------------------------------------------------------------------------

interface PieceProps {
  className?: string;
  label?: string;
  lead?: boolean;
}

const CHAIN = chainQuarters(100, SITE_CHAIN.steps, SITE_CHAIN.first, SITE_CHAIN.margin, SITE_CHAIN.cross);

export function Chain({ className, label, lead }: PieceProps): JSX.Element {
  return (
    <Arcs
      lead={lead}
      align="end"
      viewBox={`0 0 ${CHAIN.width} ${CHAIN.height}`}
      quarters={CHAIN.quarters}
      // the links cross through each other on the way in: overlaps mix like light
      blend
      className={className}
      label={label}
      fit="meet"
    />
  );
}

// R 62: the quarters overlap in the middle and land on crossing lines. They cross
// into place like the hero's Chain, starting at TWICE the mirror distance, beyond
// the opposite corner (the tile clips them until they fly in). The margin leaves
// room for the corner dots.
const QUARTET = quartetQuarters(4, 62, true, 2);

export function Quartet({ className, label, lead }: PieceProps): JSX.Element {
  return (
    <Arcs
      lead={lead}
      viewBox={QUARTET.viewBox}
      className={className}
      label={label}
      fit="meet"
      blend
      quarters={QUARTET.quarters}
    />
  );
}

/** Rows of chairs around the conductor, in four sections, front to back. */
export function Orchestra({ className, label }: PieceProps): JSX.Element {
  const cx = 100;
  const cy = 108;
  const sections: [number, number, number, RunName][] = [
    // inner, outer, rows, run
    [16, 50, 5, 'ember'], // strings
    [55, 70, 3, 'dawn'], // woodwinds
    [75, 86, 2, 'dusk'], // brass
    [91, 98, 2, 'bloom'], // percussion
  ];
  const quarters: Quarter[] = [];
  for (const [inner, R, n, run] of sections) {
    quarters.push({ cx, cy, R, inner, n, run, corner: 'br', seats: true });
    quarters.push({ cx, cy, R, inner, n, run, corner: 'bl', seats: true });
  }
  return (
    <Arcs viewBox="0 0 200 120" className={className} label={label} quarters={quarters}>
      <rect className="player" x={cx - 4} y={cy - 3} width={8} height={6} />
    </Arcs>
  );
}

/** Four players of different weight, facing in; their sound mixes in the middle. */
export function Combo({ className, label }: PieceProps): JSX.Element {
  const players: Quarter[] = [
    { cx: 4, cy: 6, R: 64, corner: 'tl', run: 'ember', n: 14 }, // drums
    { cx: 100, cy: 30, R: 50, corner: 'tr', run: 'dusk', n: 12 }, // bass
    { cx: 14, cy: 100, R: 46, corner: 'bl', run: 'bloom', n: 11 }, // sax
    { cx: 96, cy: 96, R: 38, corner: 'br', run: 'meadow', n: 9 }, // piano
  ];
  return (
    <Arcs viewBox="0 0 100 100" className={className} label={label} quarters={players} blend>
      {players.map((p, i) => (
        <circle key={i} className="player" cx={p.cx} cy={p.cy} r={2.6} />
      ))}
    </Arcs>
  );
}
