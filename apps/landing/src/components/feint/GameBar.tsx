import { useCallback, useEffect, useState } from 'react';
import { Link } from '../../router';
import { ARCADE_ENABLED, ARCADE_PATH } from '../../lib/site';
import { Sprite, SPRITE_PALETTE } from './Sprite';

// ---------------------------------------------------------------------------
// The arcade entry bar.
//
// It is a RULE-BOUNDED STRIP — never a card, never a colour-block banner. The
// only saturated pixels above the footer live inside the small black sprite
// block at its left, and that contrast is the whole strategy: the game is loud,
// the site is quiet, and coming back from the game should feel like relief.
//
// Three rules from the brief, all load-bearing:
//   · it sits AFTER the hero's CTAs, never above them — it must never compete
//     with or delay the primary action;
//   · dismissal persists and must not re-appear on a route change; and
//   · it is the only game entry point above the footer.
//
// GATED OFF for now — see ARCADE_ENABLED in lib/site.ts. The component is
// finished; the game is not.
// ---------------------------------------------------------------------------

// A NEW key, so it takes the new prefix rather than the legacy `pierre:*` one
// that the rest of the app still uses. Nothing to migrate — it has never been
// written before. Purely functional (a UI preference), so it needs no consent.
const DISMISS_KEY = 'limn:arcade-dismissed';

/** The three sprites in the black block, in the game's inverted palette. */
const BAR_SPRITES = ['bell', 'bot', 'ci'] as const;

export function GameBar(): JSX.Element | null {
  // Mirrors CookieBanner: render nothing until localStorage has been read, so a
  // visitor who dismissed the bar never sees it flash back on the next page.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!ARCADE_ENABLED) return;
    try {
      setVisible(window.localStorage.getItem(DISMISS_KEY) !== '1');
    } catch {
      // Storage can throw in private modes / with cookies blocked. Showing the
      // bar is the safe failure — it just won't remember the dismissal.
      setVisible(true);
    }
  }, []);

  const dismiss = useCallback(() => {
    setVisible(false);
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* nothing to do — the bar is already hidden for this session */
    }
  }, []);

  if (!visible) return null;

  return (
    <div className="mx-gutter mb-10 flex items-center gap-[18px] border-b border-t border-b-rule border-t-ink py-3.5">
      <div className="flex shrink-0 items-center gap-2 bg-ink px-2.5 py-2">
        {BAR_SPRITES.map((name) => (
          <Sprite key={name} name={name} cell={3} {...SPRITE_PALETTE.inGame} />
        ))}
      </div>

      <p className="min-w-0 flex-1 text-list text-ink-soft">
        <span className="mr-3 font-mono text-mono-label uppercase text-signal-text">
          Optional
        </span>
        Ninety seconds of the problem, as an arcade game.{' '}
        <Link
          to={ARCADE_PATH}
          className="border-b border-signal-fill text-ink transition-colors duration-hover ease-standard hover:text-signal-text focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Play Inbox Invaders →
        </Link>
      </p>

      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 p-1.5 font-mono text-mono-caption text-secondary transition-colors duration-hover ease-standard hover:text-ink focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        Dismiss ✕
      </button>
    </div>
  );
}
