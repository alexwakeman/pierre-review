// The wordmark — the ONLY place the product name is rendered as identity in the
// app: the Ensemble mark (one banded quarter-circle in the ember run) and the
// name in plain type.
//
// The mark's geometry and colours come from ONE place, `brandMark()` in
// @pierre-review/shared (brand-mark.ts), which also renders every favicon
// (scripts/make-favicons.mjs) and the landing's header mark. Never redraw it here.
//
// The mark is sized in em, so the one component serves both the header and the
// sign-in gate's text-4xl render. Its colours are the brand's own on every scheme:
// it is a decorative mark (the name beside it carries the meaning), so it is
// aria-hidden and needs no contrast pair.

import { useId } from 'react';
import { brandMark, PRODUCT_NAME } from '@pierre-review/shared';

export const APP_NAME = PRODUCT_NAME;

// Four bands: legible from the 16px header up to the sign-in gate's 36px.
const MARK = brandMark(4);

function LogoMark(): JSX.Element {
  const id = `mark${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [x1, y1, x2, y2] = MARK.line;
  return (
    <svg
      width="1em"
      height="1em"
      viewBox={MARK.viewBox}
      aria-hidden="true"
      focusable="false"
      className="inline-block shrink-0 decorative-mark"
    >
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
          {MARK.stops.map((s) => (
            <stop key={s.offset} offset={s.offset} stopColor={s.color} />
          ))}
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#${id})`}>
        {MARK.bands.map((b) => (
          <path key={b.d} d={b.d} strokeWidth={b.width} />
        ))}
      </g>
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span className={`brand-title inline-flex items-center gap-[0.35em] ${className}`}>
      <LogoMark />
      <span>{APP_NAME}</span>
    </span>
  );
}
