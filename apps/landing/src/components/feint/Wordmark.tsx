import { SITE_NAME } from '../../lib/site';
import { Sprite } from './Sprite';

// ---------------------------------------------------------------------------
// The wordmark — the ONLY place the product name is rendered as identity.
//
// A mark plus a name: the game's "group" sprite (two critters, one cluster —
// the multi-repo team in eleven pixels) set in ink at cell 2 (22×18) with its
// accent cells in vermilion, then plain Archivo 600 with a vermilion full
// stop. The sprite comes from the shared <Sprite> registry, so the logo and
// the game can never drift apart. The mark's accent cells and the full stop
// are the brand's two sanctioned decorative uses of vermilion — both use
// `signal-text` (#C13A20), not `signal-fill`, because they sit at glyph scale
// (see the accessibility contract in tailwind.config.ts).
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
