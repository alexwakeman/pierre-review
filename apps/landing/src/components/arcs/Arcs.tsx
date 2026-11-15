import { useId } from 'react';
import { layoutQuarter } from './geometry';
import type { Quarter } from './geometry';

// ---------------------------------------------------------------------------
// <Arcs> draws a composition of banded quarters as a STACK OF LAYERS: one small
// <svg> per quarter, all sharing the composition's viewBox, inside a box that
// keeps the composition's aspect ratio.
//
// WHY LAYERS. Every movement is a CSS transform on a whole layer, which the
// browser hands to the GPU compositor: nothing is restyled or repainted while
// the page scrolls. (One SVG moved by CSS variables repainted hundreds of band
// paths on every scroll frame, and the page juddered.)
//
// THE MOTION (board.css § the arcs; arcMotion.ts). Every layer starts APART
// (--ax, --ay) from the very first paint and a CSS scroll-driven animation
// brings it home, on the compositor:
//   lead     the hero's picture: over the first 60vh of page scroll
//   others   from the moment they appear (a view timeline, entry 0% → contain 30%)
// Browsers without scroll-driven animations get the same mappings from
// arcMotion.ts. No JS (a <noscript> style) and reduced motion: home, still.
// Nothing is ever redrawn: the bands are painted once, only layers move.
// ---------------------------------------------------------------------------

export interface ArcsProps {
  viewBox: string;
  quarters: Quarter[];
  /** Overlapping quarters mix like light (screen), as the artwork's overlaps do. */
  blend?: boolean;
  /** Extra marks drawn above the bands (a conductor's podium, players). */
  children?: React.ReactNode;
  className?: string;
  /** The picture's text alternative. Omit for a purely decorative piece. */
  label?: string;
  /** 'meet' fits the whole composition in the box; 'slice' fills it and crops. */
  fit?: 'meet' | 'slice';
  /** A hero picture: it starts apart and comes together as the reader scrolls. */
  lead?: boolean;
  /** 'end' anchors the composition to the right of its box instead of centring it. */
  align?: 'center' | 'end';
}

/** How far a lead layer starts from home, as a multiple of its offset. */
export const APART = 1.6;

const pct = (n: number, of: number): string => `${Math.round((n / of) * 100000) / 1000}%`;

export function Arcs({
  viewBox,
  quarters,
  blend,
  children,
  className,
  label,
  fit = 'slice',
  lead,
  align = 'center',
}: ArcsProps): JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [, , W = 100, H = 100] = viewBox.split(/\s+/).map(Number);
  const cls = ['arcs', fit, blend && 'blend', lead && 'lead', align === 'end' && 'end', className].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ '--ar': W / H } as React.CSSProperties}
    >
      <div className="arcs-box">
        {quarters.map((q, i) => {
          const l = layoutQuarter(q);
          const id = `${uid}g${i}`;
          const style = {
            '--ax': pct(l.dx * APART, W),
            '--ay': pct(l.dy * APART, H),
          } as React.CSSProperties;
          return (
            <svg
              key={i}
              className={`layer${q.seats ? ' seats' : ''}`}
              viewBox={viewBox}
              preserveAspectRatio="none"
              focusable="false"
              style={style}
            >
              <defs>
                <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={l.line[0]} y1={l.line[1]} x2={l.line[2]} y2={l.line[3]}>
                  {l.stops.map((c, j) => (
                    <stop key={j} offset={l.stops.length > 1 ? j / (l.stops.length - 1) : 0} stopColor={c} />
                  ))}
                </linearGradient>
              </defs>
              <g stroke={`url(#${id})`}>
                {l.paths.map((p, j) => (
                  <path
                    key={j}
                    d={p.d}
                    strokeWidth={p.w}
                    // a solid band draws out along a unit path length; seats fade in
                    pathLength={p.dash ? undefined : 1}
                    strokeDasharray={p.dash}
                    style={{ '--k': p.k } as React.CSSProperties}
                  />
                ))}
              </g>
              {l.dot && <circle className="player" cx={l.dot.cx} cy={l.dot.cy} r={l.dot.r} />}
            </svg>
          );
        })}
        {children && (
          <svg className="layer marks" viewBox={viewBox} preserveAspectRatio="none" focusable="false">
            {children}
          </svg>
        )}
      </div>
    </div>
  );
}
