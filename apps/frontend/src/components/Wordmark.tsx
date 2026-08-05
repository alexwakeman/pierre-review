// The wordmark — the ONLY place the product name is rendered as identity in the
// app, mirroring the marketing site's <Wordmark/>. A mark plus a name: the
// Inbox Invaders "group" sprite (two critters, one cluster), then plain
// Archivo 600 with a vermilion full stop.
//
// The sprite is sized in em (the 11×9 grid at 0.9em tall is exactly 1.1em
// wide), so the one component serves both the header and the sign-in gate's
// text-4xl render, and it fills with currentColor so it follows the chrome
// through light and dark without a prop.
//
// The full stop takes the darker vermilion on light grounds and the lighter one
// on dark — #E2492C is only 3.85:1 on paper, so it may never carry a glyph.

export const APP_NAME = 'Limn';

/**
 * The "group" sprite from the arcade game, in the current text colour with its
 * two accent runs (the critters' cores) in vermilion — darker stop on light
 * grounds, lighter on dark, matching the full stop.
 */
function LogoSprite(): JSX.Element {
  const accent = 'fill-[#C13A20] dark:fill-[#F26B4E]';
  return (
    <svg
      width="1.1em"
      height="0.9em"
      viewBox="0 0 11 9"
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="inline-block shrink-0"
    >
      <rect x="0" y="0" width="6" height="1" />
      <rect x="0" y="1" width="1" height="1" />
      <rect x="2" y="1" width="2" height="1" className={accent} />
      <rect x="5" y="1" width="1" height="1" />
      <rect x="0" y="2" width="6" height="1" />
      <rect x="1" y="3" width="1" height="1" />
      <rect x="3" y="4" width="7" height="1" />
      <rect x="3" y="5" width="1" height="1" />
      <rect x="9" y="5" width="1" height="1" />
      <rect x="3" y="6" width="1" height="1" />
      <rect x="5" y="6" width="3" height="1" className={accent} />
      <rect x="9" y="6" width="1" height="1" />
      <rect x="3" y="7" width="7" height="1" />
      <rect x="5" y="8" width="1" height="1" />
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span className={`brand-title inline-flex items-center gap-[0.35em] ${className}`}>
      <LogoSprite />
      <span>
        {APP_NAME}
        <span className="text-[#C13A20] dark:text-[#F26B4E]">.</span>
      </span>
    </span>
  );
}
