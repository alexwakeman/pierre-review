import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// A SCENE: one big arc picture PINNED to the screen while the page scrolls over it
// (the home page's ring under the hero, and the same ring in reverse after "Dependency
// updates": it arrives assembled and comes apart).
//
//   section.scene                       its own scroll timeline (--scene, a view timeline)
//     .scene-art   sticky, one screen   the picture, full width, behind everything
//       .scene-in  > .scene-out          two opacity layers: fade IN, then fade OUT
//     .scene-over  pulled up one screen  what scrolls over it: `before` (the hero's text),
//                                         an empty RUNWAY where the picture plays alone,
//                                         then `after` (the next section)
//
// THE TIMING, in vh of scroll after the scene's top reaches the screen's top (S):
//   S 0 → gather     the quarters come together (arc-gather, on every layer); with
//                    `reverse` they start together and come apart over the same span
//   S 0 → fadeIn     the picture fades up from FADED_START to full
//   outStart → outEnd it fades down to FADED_END as `after` slides over it
// `after` enters at the screen's bottom when S = (height of `before`) + runway − 100vh,
// so the caller sets `runway` to land that at outStart, near the end of the gather.
// Scrolling back plays it all in reverse: everything is a function of S.
//
// Everything runs on the compositor (transforms and opacity only), from CSS
// (board.css § scenes). arcMotion.ts reproduces it where scroll-driven animations
// are missing. Reduced motion: no pin, no runway, the picture assembled and faded.
// ---------------------------------------------------------------------------

/** Opacity of the picture before it plays, and once content covers it. */
export const FADED_START = 0.35;
export const FADED_END = 0.15;

export interface SceneTiming {
  /** vh of scroll for the quarters to come together. */
  gather: number;
  /** vh of scroll to fade up to full. */
  fadeIn: number;
  /** vh of empty scroll between `before` and `after`. */
  runway: number;
  /** vh where `after` starts to cover the picture (it fades down from here) … */
  outStart: number;
  /** … to here. */
  outEnd: number;
}

export function Scene({
  art,
  timing,
  before,
  after,
  className,
  reverse,
}: {
  art: ReactNode;
  timing: SceneTiming;
  before?: ReactNode;
  after: ReactNode;
  className?: string;
  /** Play the gather backwards: the picture arrives assembled and comes APART as the page
   *  scrolls (the home page's closing ring, the hero's in reverse). */
  reverse?: boolean;
}): JSX.Element {
  const t = timing;
  const vars = {
    '--sc-gather': `${t.gather}vh`,
    '--sc-in': `${t.fadeIn}vh`,
    '--sc-out-start': `${t.outStart}vh`,
    '--sc-out-end': `${t.outEnd}vh`,
    '--sc-runway': `${t.runway}vh`,
  } as React.CSSProperties;
  return (
    <div
      className={['scene', reverse && 'scene-reverse', className].filter(Boolean).join(' ')}
      style={vars}
      data-gather={t.gather}
      data-in={t.fadeIn}
      data-out-start={t.outStart}
      data-out-end={t.outEnd}
    >
      <div className="scene-art">
        <div className="scene-in">
          <div className="scene-out">{art}</div>
        </div>
      </div>
      <div className="scene-over">
        {before}
        <div className="scene-runway" aria-hidden="true" />
        {after}
      </div>
    </div>
  );
}
