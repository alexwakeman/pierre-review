import { useId } from 'react';
import { arcPath, bands, CUT, gradientLine, RUNS } from './geometry';
import type { Corner, Quarter } from './geometry';

// ---------------------------------------------------------------------------
// <Arcs> draws a composition of banded quarters as ONE inline SVG.
//
// MOTION is CSS only, driven by two custom properties on the <svg> that
// `arcMotion.ts` sets from the scroll position:
//   --draw   0 → 1   the bands draw out, innermost first, and each quarter slides
//                    from its offset (dx, dy) into place: the ensemble assembles
//   --spread 0 → 1   as the piece scrolls away the quarters drift apart again and
//                    the bands open out: the sound expands
// Both default to the finished picture (draw 1, spread 0), so the prerendered HTML,
// no JS and reduced motion all show the whole drawing, still.
// ---------------------------------------------------------------------------

export interface ArcsProps {
  viewBox: string;
  quarters: Quarter[];
  /** Overlapping quarters mix like light (screen), as the artwork's overlaps do. */
  blend?: boolean;
  /** Extra marks drawn above the bands (players, a conductor). */
  children?: React.ReactNode;
  className?: string;
  /** The picture's text alternative. Omit for a purely decorative piece. */
  label?: string;
  preserveAspectRatio?: string;
  /** The page's lead picture: always drawn, it only opens out on scroll. */
  lead?: boolean;
}

const round = (n: number, p = 100): number => Math.round(n * p) / p;

const BULGE: Record<Corner, [number, number]> = {
  br: [-1, -1],
  bl: [1, -1],
  tl: [1, 1],
  tr: [-1, 1],
};

export function Arcs({
  viewBox,
  quarters,
  blend,
  children,
  className,
  label,
  preserveAspectRatio = 'xMidYMid slice',
  lead,
}: ArcsProps): JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <svg
      className={`arcs${blend ? ' blend' : ''}${className ? ` ${className}` : ''}`}
      viewBox={viewBox}
      preserveAspectRatio={preserveAspectRatio}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-lead={lead ? '' : undefined}
    >
      <defs>
        {quarters.map((q, i) => {
          const [x1, y1, x2, y2] = gradientLine(q.cx, q.cy, q.R, q.corner);
          const stops = RUNS[q.run];
          return (
            <linearGradient key={i} id={`${uid}g${i}`} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
              {stops.map((c, j) => (
                <stop key={j} offset={stops.length > 1 ? j / (stops.length - 1) : 0} stopColor={c} />
              ))}
            </linearGradient>
          );
        })}
      </defs>
      {quarters.map((q, i) => {
        const [bx, by] = BULGE[q.corner];
        const dx = q.dx ?? bx * q.R * 0.18;
        const dy = q.dy ?? by * q.R * 0.18;
        // the cut: each quarter pulls back from the lines it shares with its neighbours
        const c = (CUT * q.R) / 2;
        const cx = q.cx + bx * c;
        const cy = q.cy + by * c;
        const style = {
          '--dx': dx,
          '--dy': dy,
          transformOrigin: `${cx}px ${cy}px`,
        } as React.CSSProperties;
        return (
          <g key={i} className={`q${q.seats ? ' seats' : ''}`} stroke={`url(#${uid}g${i})`} style={style}>
            {bands(q.R - c, q.n, q.inner).map((b, j) => (
              <path
                key={j}
                d={arcPath(cx, cy, b.r, q.corner)}
                strokeWidth={Math.round(b.t * 100) / 100}
                // seats are dashes in user units (a chair every ~1.4 band widths);
                // a solid band is drawn out with a unit path length
                pathLength={q.seats ? undefined : 1}
                strokeDasharray={q.seats ? `${round(b.t * 1.5)} ${round(b.t * 0.9)}` : undefined}
                style={{ '--k': round(b.k, 1000) } as React.CSSProperties}
              />
            ))}
          </g>
        );
      })}
      {children}
    </svg>
  );
}
