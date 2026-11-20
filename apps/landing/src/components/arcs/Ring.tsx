import { useId } from 'react';
import { ringLines, SITE_RING } from './geometry';

// ---------------------------------------------------------------------------
// <Ring> — the home page's big picture: ONE disc of banded quarters, broken into its
// single band LINES (4 × 16), each its own small <svg> laid over the ring's box.
//
// THE MOTION (board.css § the ring; arcMotion.ts). Every line is painted at its own
// START in 3D space from the first paint (geometry.ts ringLines: a translation in box
// widths, three turns, a dimmer opacity when far back), inside a box with perspective,
// so nearer lines read bigger and further ones smaller. A scene's scroll timeline brings
// each line home (transform: none, opacity 1); the inner bands land first and the rim
// last. In a `reverse` scene the ring arrives whole and the lines fly apart.
// Only transforms and opacity move, on the compositor; the bands are painted once.
// Each line's box is its own band's box, never the whole stage, so 64 layers stay cheap.
// No JS without scroll-driven animations (a <noscript> style) and reduced motion: home.
// THE RIPPLE (ringWave.ts): each time the lines close into the ring, its bands swell and
// settle like the voice tiles' corners, inner band first.
// ---------------------------------------------------------------------------

const RING = ringLines(100, SITE_RING.margin, SITE_RING.scatter, SITE_RING.spreadX);

const pct = (n: number, of: number): string => `${Math.round((n / of) * 100000) / 1000}%`;

export function Ring({ className, label }: { className?: string; label?: string }): JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const { width: W, height: H, lines } = RING;
  return (
    <div
      className={['arcs', 'ring3d', className].filter(Boolean).join(' ')}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ '--ar': W / H } as React.CSSProperties}
      data-w={W}
      data-h={H}
    >
      <div className="arcs-box">
        {lines.map((l, i) => {
          const [x, y, w, h] = l.box;
          const id = `${uid}r${i}`;
          const style = {
            left: pct(x, W),
            top: pct(y, H),
            width: pct(w, W),
            height: pct(h, H),
            '--tx': l.tx,
            '--ty': l.ty,
            '--tz': l.tz,
            '--rx': l.rx,
            '--ry': l.ry,
            '--rz': l.rz,
            '--o0': l.o0,
            '--e': l.e,
          } as React.CSSProperties;
          return (
            <svg
              key={i}
              className="line"
              viewBox={`${x} ${y} ${w} ${h}`}
              preserveAspectRatio="none"
              focusable="false"
              style={style}
              data-o0={l.o0}
              data-b={l.b}
            >
              <defs>
                <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={l.line[0]} y1={l.line[1]} x2={l.line[2]} y2={l.line[3]}>
                  {l.stops.map((c, j) => (
                    <stop key={j} offset={l.stops.length > 1 ? j / (l.stops.length - 1) : 0} stopColor={c} />
                  ))}
                </linearGradient>
              </defs>
              <path d={l.d} stroke={`url(#${id})`} strokeWidth={l.w} />
            </svg>
          );
        })}
      </div>
    </div>
  );
}
