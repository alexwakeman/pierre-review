import { Arcs } from './Arcs';
import { spiralQuarters } from './geometry';
import type { Corner, Quarter, RunName } from './geometry';

// ---------------------------------------------------------------------------
// The compositions. Every picture on the site is one of these, drawn from the same
// banded quarter (geometry.ts): no photographs, no product screenshots.
//
//   Spiral     the signature: a golden spiral of quarters, each a different voice,
//              that only reads as one shape together (the hero)
//   Quartet    four equal quarters facing one centre: "four sensible people
//              conversing" (beside Goethe's line)
//   Orchestra  the seating plan from above: rows of chairs in sections around
//              the conductor
//   Combo      a jazz band: four players of different weight, facing in, their
//              sound overlapping and mixing in the middle
// ---------------------------------------------------------------------------

/** A golden spiral, portrait (13 × 21 units of `u`), turning clockwise inward. */
interface PieceProps {
  className?: string;
  label?: string;
  lead?: boolean;
}

export function Spiral({ className, label, lead }: PieceProps): JSX.Element {
  return (
    <Arcs
      lead={lead}
      viewBox="0 0 130 210"
      quarters={spiralQuarters(10)}
      className={className}
      label={label}
      preserveAspectRatio="xMidYMid meet"
    />
  );
}

export function Quartet({ className, label }: PieceProps): JSX.Element {
  const R = 50;
  const q = (cx: number, cy: number, corner: Corner, run: RunName): Quarter => ({ cx, cy, R, corner, run, n: 11 });
  return (
    <Arcs
      viewBox="0 0 100 100"
      className={className}
      label={label}
      preserveAspectRatio="xMidYMid meet"
      quarters={[q(0, 0, 'tl', 'ember'), q(100, 0, 'tr', 'dawn'), q(100, 100, 'br', 'dusk'), q(0, 100, 'bl', 'bloom')]}
    >
      {[
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ].map(([x, y], i) => (
        <circle key={i} className="player" cx={x} cy={y} r={3.2} />
      ))}
    </Arcs>
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
