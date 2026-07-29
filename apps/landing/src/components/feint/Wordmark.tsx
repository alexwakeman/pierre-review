import { SITE_NAME } from '../../lib/site';

// ---------------------------------------------------------------------------
// The wordmark — the ONLY place the product name is rendered as identity.
//
// Plain Archivo 600 plus a vermilion full stop. There is no logotype, no
// mascot, no custom letterforms and no image: nothing in the visual system
// depends on the shape of the name, which is what makes the rename a one-line
// change in lib/site.ts.
//
// (This replaced a cursive "Pierre" set in a bundled Great Vibes face, whose
// whole reason for existing was that one word.)
//
// The full stop is the one sanctioned decorative use of vermilion. It is
// `signal-text` (#C13A20), not `signal-fill` (#E2492C), because it is TEXT —
// see the accessibility contract in tailwind.config.ts.
// ---------------------------------------------------------------------------

export function Wordmark({ className = 'text-[21px]' }: { className?: string }): JSX.Element {
  return (
    <span className={`font-display font-semibold tracking-[-0.02em] text-ink ${className}`}>
      {SITE_NAME}
      <span className="text-signal-text">.</span>
    </span>
  );
}
