import { useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// The hero's dots: 168 squares scatter, gather into a lapis ribbon, then settle
// into three zones (a grey heap, the lapis rows, the coloured rows) under the
// labels Gather / Check / Act. Runs once.
//
// THE FINAL PICTURE IS THE MARKUP. Every square is rendered at its final place
// and colour, and the labels are visible, so the prerendered page (and a page
// with no JS, or reduced motion) shows the settled board. The effect only plays
// the journey from scattered to final with the Web Animations API.
// ---------------------------------------------------------------------------

const N = 168;
const S = 12;

// The mockup's seeded random: the same numbers on the server and in the browser.
function rnd(i: number): number {
  const x = Math.sin(i * 99.13 + 1.7) * 43758.5453;
  return x - Math.floor(x);
}

const COLS = { lapis: '#5b82c2', verdi: '#5fb39d', gold: '#d2b071', madder: '#c99aa3' };

interface Dot {
  zone: number;
  sx: number;
  sy: number;
  rx: number;
  ry: number;
  fx: number;
  fy: number;
  fc: string;
  delay: number;
}

const DOTS: Dot[] = Array.from({ length: N }, (_, i) => {
  const zone = i % 3;
  const k = Math.floor(i / 3);
  const sx = 30 + rnd(i) * 900;
  const sy = 20 + rnd(i + 11) * 330;
  const rx = 380 + (k % 14) * 15;
  const ry = 150 + (Math.floor(k / 14) % 4) * 15;
  let fx: number;
  let fy: number;
  let fc: string;
  if (zone === 0) {
    fx = 30 + rnd(i + 5) * 270;
    fy = 30 + rnd(i + 9) * 290;
    fc = rnd(i + 3) > 0.5 ? '#4a4b50' : '#5c5d63';
  } else if (zone === 1) {
    fx = rx;
    fy = ry;
    fc = COLS.lapis;
  } else {
    fx = 690 + (k % 8) * 31;
    fy = 46 + Math.floor(k / 8) * 42;
    fc = [COLS.gold, COLS.verdi, COLS.madder][Math.floor(k / 8) % 3] ?? COLS.gold;
  }
  return { zone, sx, sy, rx, ry, fx, fy, fc, delay: 200 + rnd(i + 21) * 500 };
});

const LABELS: Array<[string, number]> = [
  ['Gather', 30],
  ['Check', 380],
  ['Act', 690],
];

export function HeroDots() {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const rects = Array.from(svg.querySelectorAll<SVGRectElement>('rect'));
    const texts = Array.from(svg.querySelectorAll<SVGTextElement>('text'));
    const canAnimate = !reduce && rects.length > 0 && typeof rects[0]?.animate === 'function';

    const animations: Animation[] = [];
    if (canAnimate) {
      rects.forEach((r, i) => {
        const d = DOTS[i];
        if (!d) return;
        const mid = d.zone === 0 ? [d.fx, d.fy] : [d.rx, d.ry];
        animations.push(
          r.animate(
            [
              { transform: `translate(${d.sx}px,${d.sy}px)`, fill: '#3a3b40', opacity: 0 },
              { transform: `translate(${d.sx}px,${d.sy}px)`, fill: '#5c5d63', opacity: 1, offset: 0.12 },
              {
                transform: `translate(${mid[0]}px,${mid[1]}px)`,
                fill: d.zone === 0 ? d.fc : COLS.lapis,
                opacity: 1,
                offset: 0.55,
              },
              { transform: `translate(${d.fx}px,${d.fy}px)`, fill: d.fc, opacity: 1 },
            ],
            {
              duration: 3600,
              delay: d.delay,
              easing: 'cubic-bezier(.6,0,.2,1)',
              // 'both' (the mockup said 'forwards'): during the delay a square
              // waits unseen at its scattered start instead of showing at its end.
              fill: 'both',
            },
          ),
        );
      });
    }

    // The labels fade in one by one (.hl is hidden only while the page's reveal
    // is armed, so without that they are simply visible).
    const timers = texts.map((t, j) =>
      window.setTimeout(() => t.classList.add('in'), canAnimate ? 1600 + j * 700 : 0),
    );

    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      animations.forEach((a) => a.cancel());
      texts.forEach((t) => t.classList.remove('in'));
    };
  }, []);

  return (
    <svg ref={svgRef} viewBox="0 0 960 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {DOTS.map((d, i) => (
        <rect key={i} width={S} height={S} transform={`translate(${d.fx} ${d.fy})`} fill={d.fc} />
      ))}
      {LABELS.map(([word, x]) => (
        <text
          key={word}
          x={x}
          y={380}
          fill="#f1f1ef"
          fontFamily="Albert Sans"
          fontSize="26"
          fontWeight="600"
          className="hl"
        >
          {word}
        </text>
      ))}
    </svg>
  );
}
