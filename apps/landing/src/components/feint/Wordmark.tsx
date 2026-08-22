import { SITE_NAME } from '../../lib/site';
import { Sprite } from './Sprite';

// ---------------------------------------------------------------------------
// The wordmark — the ONLY place the product name is rendered as identity.
//
// A mark plus a name: the game's "group" sprite (two speech bubbles, one
// cluster — the multi-repo team in eleven pixels) set in ink at cell 2 (22×18),
// then plain Archivo 600 with a vermilion full stop.
//
// EXACTLY ONE of the two bubbles is lit. The LOWER bubble's interior is the
// mark's only accent run; the top bubble's interior is ink. Both were vermilion
// once, which spread the colour evenly and made it read as decoration — two red
// things. With one lit it reads as a SELECTION instead: the top bubble is the
// noise, the lower one is the exchange that still needs a human. That is the
// hero's "40 flagged, 3 matter" claim stated in eleven pixels, so this mark may
// never go back to two accent runs.
//
// The bitmap is the SHARED one (`lib/sprites.ts`, `SOURCE.group`), so the logo
// and the game can never drift apart — the accepted price is that the arcade's
// rank-1 "group" alien lost its top accent cells too. Keeping a logo-only copy
// of the grid would trade a visible-once pixel change for a permanent silent
// drift, which is the worse deal. (There IS such a hand copy in the app:
// `apps/frontend/src/components/Wordmark.tsx` inlines the same 11×9 grid as
// <rect>s and must be changed in lockstep.)
//
// The mark's accent run and the full stop are the brand's two sanctioned
// decorative uses of vermilion — both use `signal-text` (#C13A20, passed
// literally to <Sprite> since it takes colours not classes), not `signal-fill`,
// because they sit at glyph scale (see the contract in tailwind.config.ts).
//
// Nothing else in the visual system depends on the letterforms, which is what
// keeps the rename a one-line change in lib/site.ts.
// ---------------------------------------------------------------------------

export function Wordmark({ className = 'text-[21px]' }: { className?: string }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-2.5 font-display font-semibold tracking-[-0.02em] text-ink ${className}`}
    >
      <Sprite name="group" cell={2} fill="#16161A" accent="#C13A20" className="shrink-0" />
      <span>
        {SITE_NAME}
        <span className="text-signal-text">.</span>
      </span>
    </span>
  );
}
