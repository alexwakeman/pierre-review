import { useId } from 'react';
import { layoutQuarter } from './geometry';
import type { Quarter } from './geometry';

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
  const laid = quarters.map(layoutQuarter);
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
        {laid.map((l, i) => (
          <linearGradient key={i} id={`${uid}g${i}`} gradientUnits="userSpaceOnUse" x1={l.line[0]} y1={l.line[1]} x2={l.line[2]} y2={l.line[3]}>
            {l.stops.map((c, j) => (
              <stop key={j} offset={l.stops.length > 1 ? j / (l.stops.length - 1) : 0} stopColor={c} />
            ))}
          </linearGradient>
        ))}
      </defs>
      {laid.map((l, i) => (
        <g
          key={i}
          className={`q${quarters[i]?.seats ? ' seats' : ''}`}
          stroke={`url(#${uid}g${i})`}
          style={{ '--dx': l.dx, '--dy': l.dy, transformOrigin: `${l.ox}px ${l.oy}px` } as React.CSSProperties}
        >
          {l.paths.map((p, j) => (
            <path
              key={j}
              d={p.d}
              strokeWidth={p.w}
              // a solid band is drawn out with a unit path length; seats fade instead
              pathLength={p.dash ? undefined : 1}
              strokeDasharray={p.dash}
              style={{ '--k': p.k } as React.CSSProperties}
            />
          ))}
        </g>
      ))}
      {children}
    </svg>
  );
}
