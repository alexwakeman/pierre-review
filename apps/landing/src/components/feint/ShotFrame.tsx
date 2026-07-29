import { useLightbox } from '../Lightbox';

// ---------------------------------------------------------------------------
// A product screenshot, framed as printed matter.
//
// The whole frame is a 1px hairline plus an 11–12px mono caption bar. No window
// chrome, no traffic lights, no rounded corners, no shadow, no ring, no tint and
// no filter on the image itself. The brief is emphatic about this and the reason
// is the argument the site is making: the product has to look like real software,
// not like a marketing render of software.
//
// (This replaced a macOS-style frame with `rounded-xl`, `shadow-2xl`,
// `ring-1 ring-white/5` and three coloured traffic lights.)
//
// KNOWN AND ACCEPTED: every /shots/*.png is a DARK-MODE capture — the capture
// script hardcodes `colorScheme: 'dark'` and the app has no light theme — so
// these are dark blocks sitting on warm paper behind a hairline. Shipping them
// un-stylised is the deliberate choice; the alternative was tinting them, which
// the brief forbids outright.
//
// FIT: `cover` fills the frame and crops from the bottom; `contain` shows the
// whole capture and gutters the sides. Which is right depends on the frame's
// width, so it is per-call, not a default with an override:
//   · the full-width hero (430px tall in a ~1166px frame) must be `cover` —
//     `contain` there would gutter ~418px of empty paper.
//   · the right-column shots sit in a ~500px column where the natural height is
//     only 10–21% over the frame, so `contain` costs ~50px of gutter and shows
//     the whole thing.
// ---------------------------------------------------------------------------

export function ShotFrame({
  src,
  alt,
  caption,
  height,
  fit,
  note,
  strong = false,
  className = '',
}: {
  src: string;
  alt: string;
  /** The left-hand label in the caption bar, e.g. "limn · bot triage". */
  caption: string;
  /** The image area's fixed height in px, from the design. */
  height: number;
  fit: 'cover' | 'contain';
  /** Optional explanatory line rendered below the frame, outside it. */
  note?: string;
  /** Use the heavier hairline — for frames sitting on the `paper-alt` ground. */
  strong?: boolean;
  className?: string;
}): JSX.Element {
  const { open } = useLightbox();
  const enlarge = (): void => open({ src, alt, title: caption });

  return (
    <div className={className}>
      <figure className={`border ${strong ? 'border-rule-strong' : 'border-rule'}`}>
        <figcaption className="flex items-center justify-between border-b border-rule px-4 py-[11px] font-mono text-mono-caption text-secondary">
          <span>{caption}</span>
          {/* A real button, not decorative text — it is the only affordance in
              the bar and the brief has it opening a native-resolution lightbox. */}
          <button
            type="button"
            onClick={enlarge}
            className="text-signal-text transition-colors duration-hover ease-standard hover:text-ink focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Enlarge
          </button>
        </figcaption>
        <button
          type="button"
          onClick={enlarge}
          aria-label={`Enlarge screenshot: ${alt}`}
          className="block w-full cursor-zoom-in focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
        >
          {/* The fixed height lives on this span, NOT on the <button>. A button
              lays its content out in an anonymous box that does not propagate a
              definite height, so `h-full` on the <img> resolves to auto there and
              the image collapses to nothing. A <span> (display:block) is also the
              correct element inside a button, which may only contain phrasing
              content — a <div> here is invalid HTML. */}
          <span style={{ height }} className="block w-full overflow-hidden bg-paper">
            <img
              src={src}
              alt={alt}
              loading="lazy"
              decoding="async"
              className={`h-full w-full ${
                fit === 'cover' ? 'object-cover object-top' : 'object-contain'
              }`}
            />
          </span>
        </button>
      </figure>
      {note && <p className="mt-[18px] max-w-caption text-list text-muted">{note}</p>}
    </div>
  );
}
