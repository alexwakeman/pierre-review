import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// A screen recording, framed exactly like a screenshot.
//
// The frame is `ShotFrame`'s: a 1px hairline plus an 11–12px mono caption bar.
// No window chrome, no play-button chrome borrowed from a video site, no
// rounded corners, no shadow. Same argument as the stills — the product has to
// look like real software, not like a marketing render of software.
//
// ---------------------------------------------------------------------------
// ⚠ THIS COMPONENT OWNS THE SITE'S MOTION POLICY, because a <video> escapes the
// one that was already there.
//
// The standing rule is that the site does not move. The blanket in index.css
// kills `animation` and `transition`, and a playing video is NEITHER — exactly
// the hole the hero rain already had to fill for a rAF canvas loop. So:
//
//   · `autoplay` clips read `matchMedia('(prefers-reduced-motion: reduce)')`
//     themselves, subscribe to its `change` event, and under reduced motion
//     render the POSTER STILL and mount no <video> at all. No element, no
//     bytes, nothing to play.
//   · they are `muted` + `playsInline` + `loop`, and the files carry no audio
//     track whatsoever — the mute is belt and braces, not the guarantee.
//   · if `play()` rejects anyway (a Permissions-Policy on the serving origin, a
//     browser policy, a data-saver mode), the poster stays up. A play that
//     failed must not leave a black rectangle where a screenshot was.
//
// ⚠ DO NOT RELY ON A HEADER TO ENFORCE ANY OF THAT. `Permissions-Policy:
// autoplay=(...)` is the server's opinion about whether autoplay is ALLOWED; it
// says nothing about what the reader asked for, and it is not delivered at all
// by the Vite dev server. The check has to be in the page.
//
// ⚠ A CLICK-TO-PLAY CLIP IS NOT COVERED BY THAT RULE AND MUST NOT BE. Reduced
// motion means "do not move unless I ask", not "never move". A reader who
// presses Play has asked. So the walkthrough plays under reduced motion too —
// it simply never starts on its own.
//
// ---------------------------------------------------------------------------
// WHY THE CLICK-TO-PLAY VARIANT MOUNTS NO <video> UNTIL THE CLICK. Two reasons,
// and the second is the real one:
//   · a visitor who never presses Play pays nothing for the clip;
//   · the file is a FRAGMENTED MP4 straight out of MediaRecorder, and a
//     fragmented MP4 carries no total duration in its header — the browser
//     discovers the length as it downloads. Deferring the whole fetch to the
//     click means the scrub bar fills in during the first second or two of
//     playback rather than sitting visibly wrong on a page nobody has clicked.
// ---------------------------------------------------------------------------

export function VideoFrame({
  src,
  poster,
  alt,
  caption,
  meta,
  width,
  height,
  autoplay = false,
  note,
  strong = false,
  className = '',
}: {
  /** The .mp4, from `public/demo/`. */
  src: string;
  /** The still shown before play, and instead of play under reduced motion. */
  poster: string;
  /** What the recording shows, for a reader who cannot see it. */
  alt: string;
  /** The left-hand label in the caption bar, e.g. "limn · the walkthrough". */
  caption: string;
  /** The right-hand fact in the caption bar, e.g. "30 seconds · no sound". */
  meta: string;
  /**
   * The RECORDING's own pixel dimensions — 1180 x (664 + the caption strip).
   *
   * ⚠ A VIDEO GETS AN ASPECT RATIO, NOT A FIXED HEIGHT, and that is the one place
   * this frame departs from `ShotFrame`. A still is cropped to a design height by
   * `object-cover` and loses only the bottom of a long panel. This clip carries
   * its caption in a strip BELOW the app's pixels, so a fixed height crops the
   * caption off — the reader would lose the words the scene is explained by.
   */
  width: number;
  height: number;
  /** Play by itself, muted and looping. Carries the reduced-motion obligation. */
  autoplay?: boolean;
  /** Optional explanatory line rendered below the frame, outside it. */
  note?: string;
  /** Use the heavier hairline — for frames sitting on the `paper-alt` ground. */
  strong?: boolean;
  className?: string;
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [started, setStarted] = useState(false);
  const [playFailed, setPlayFailed] = useState(false);

  // ⚠ `mounted` IS LOAD-BEARING, NOT CEREMONY. The landing is PRERENDERED per
  // route, so without it the autoplay variant renders a <video> into the static
  // HTML — before anything has been able to ask about reduced motion, and on a
  // page a reader with JS off never hydrates. The first paint has to be the
  // still; the clip is a decision the browser makes afterwards.
  useEffect(() => {
    setMounted(true);
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(q.matches);
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    q.addEventListener('change', onChange);
    return () => q.removeEventListener('change', onChange);
  }, []);

  const shouldPlay = autoplay ? mounted && !reduced : started;

  useEffect(() => {
    if (!shouldPlay) return;
    const el = videoRef.current;
    if (!el) return;
    el.play().catch(() => setPlayFailed(true));
  }, [shouldPlay]);

  const showVideo = shouldPlay && !playFailed;

  return (
    <div className={className}>
      <figure className={`border ${strong ? 'border-rule-strong' : 'border-rule'}`}>
        <figcaption className="flex items-center justify-between border-b border-rule px-4 py-[11px] font-mono text-mono-caption text-secondary">
          <span>{caption}</span>
          <span>{meta}</span>
        </figcaption>

        {/* The ratio lives on this span, not on the media, so the frame reserves
            its space before either loads and never reflows when the poster is
            swapped for the video. */}
        <span
          style={{ aspectRatio: `${width} / ${height}` }}
          className="relative block w-full overflow-hidden bg-paper"
        >
          {showVideo ? (
            <video
              ref={videoRef}
              src={src}
              poster={poster}
              muted
              loop={autoplay}
              playsInline
              controls={!autoplay}
              preload={autoplay ? 'metadata' : 'auto'}
              aria-label={alt}
              className="h-full w-full object-cover"
            />
          ) : (
            <img
              src={poster}
              alt={alt}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          )}

          {/* The play affordance, only on the click-to-play variant and only
              before it has started. A real <button> over the still, not a glyph
              painted into the poster — it has to be reachable by keyboard. */}
          {!autoplay && !started && (
            <button
              type="button"
              onClick={() => setStarted(true)}
              className="absolute inset-0 flex items-center justify-center focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
            >
              <span className="border border-ink bg-paper px-5 py-2.5 font-mono text-mono-nav text-ink transition-colors duration-hover ease-standard hover:bg-ink hover:text-paper">
                Play the walkthrough
              </span>
            </button>
          )}
        </span>
      </figure>
      {note && <p className="mt-[18px] max-w-caption text-list text-muted">{note}</p>}
    </div>
  );
}
