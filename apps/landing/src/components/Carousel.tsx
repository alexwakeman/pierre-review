import { useCallback, useEffect, useRef, useState } from 'react';
import { useLightbox } from './Lightbox';
import { ExpandIcon } from './ui';

// Auto-advancing product-screenshot carousel for the hero. One macOS-style
// window frame with cross-fading slides inside, a per-slide caption, clickable
// label chips (desktop) / dots (mobile), and a thin progress bar that fills
// over each slide's dwell time. Pauses on hover, focus and touch; disables
// auto-advance entirely under prefers-reduced-motion. All slides render
// stacked (opacity crossfade) so images are decoded before they're shown.

export interface CarouselSlide {
  src: string;
  alt: string;
  /** Short chip label, e.g. "Sprint report". */
  label: string;
  /** Tier tag rendered next to the label in the chrome bar. */
  tier: 'Pro' | 'Pro · BYO key' | 'Free';
  /** One-line caption under the frame. */
  caption: string;
  /**
   * How the image meets the fixed 16/10 stage: images WIDER than the stage
   * letterbox on the dark background ('contain'), TALLER ones crop from the
   * bottom ('cover', top-aligned). Defaults to 'cover'.
   */
  fit?: 'cover' | 'contain';
}

const DWELL_MS = 6500;

export default function Carousel({
  slides,
  className = '',
}: {
  slides: CarouselSlide[];
  className?: string;
}): JSX.Element {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const touchX = useRef<number | null>(null);
  const swiped = useRef(false); // a swipe just fired → swallow the synthetic click
  const { openGallery } = useLightbox();
  const n = slides.length;

  const go = useCallback(
    (next: number) => setIndex(((next % n) + n) % n),
    [n],
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => setReducedMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (paused || reducedMotion || n < 2) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % n), DWELL_MS);
    return () => clearInterval(t);
  }, [paused, reducedMotion, n]);

  const active = slides[index]!;

  return (
    <div
      className={className}
      role="region"
      aria-roledescription="carousel"
      aria-label="Product tour"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') go(index + 1);
        if (e.key === 'ArrowLeft') go(index - 1);
      }}
      onTouchStart={(e) => {
        setPaused(true);
        touchX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const start = touchX.current;
        touchX.current = null;
        setPaused(false);
        if (start == null) return;
        const dx = (e.changedTouches[0]?.clientX ?? start) - start;
        if (Math.abs(dx) > 40) {
          swiped.current = true; // suppress the tap-to-enlarge that follows a swipe
          go(index + (dx < 0 ? 1 : -1));
        }
      }}
    >
      {/* window frame */}
      <figure className="overflow-hidden rounded-lg border border-white/10 bg-gray-900/60 shadow-2xl shadow-black/50 ring-1 ring-white/5 sm:rounded-xl">
        {/* chrome bar: traffic lights + the active slide's label */}
        <div className="flex items-center gap-1.5 border-b border-white/10 bg-gray-900/80 px-3 py-2 sm:gap-2 sm:px-4 sm:py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/70 sm:h-3 sm:w-3" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70 sm:h-3 sm:w-3" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-500/70 sm:h-3 sm:w-3" />
          <span className="ml-2 truncate text-xs text-gray-400 sm:ml-3" aria-live="polite">
            pierre · {active.label}
          </span>
          <span
            className={`ml-auto hidden shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 sm:inline-flex ${
              active.tier === 'Free'
                ? 'bg-brand-green/10 text-green-200 ring-brand-green/30'
                : 'bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30'
            }`}
          >
            {active.tier}
          </span>
        </div>

        {/* stage — fixed 16/10 so mixed-aspect shots never resize the page */}
        <div className="relative aspect-[16/10] bg-gray-950">
          {slides.map((s, i) => (
            <button
              key={s.src}
              type="button"
              // Only the visible slide is interactive; the stacked-but-hidden ones
              // sit on top otherwise and would steal the click.
              aria-hidden={i !== index}
              tabIndex={i === index ? 0 : -1}
              aria-label={`Enlarge ${s.label} (${i + 1} of ${n})`}
              onClick={() => {
                if (swiped.current) {
                  swiped.current = false; // this click came from a swipe — ignore it
                  return;
                }
                // Open the WHOLE tour as a browsable gallery, starting on this slide — so
                // full-screen the viewer can tap / arrow through every shot, not just this one.
                openGallery(
                  slides.map((sl) => ({
                    src: sl.src,
                    alt: sl.alt,
                    title: `pierre · ${sl.label}`,
                  })),
                  i,
                );
              }}
              className={`absolute inset-0 block cursor-zoom-in transition-opacity duration-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-skySoft ${
                i === index ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
            >
              <img
                src={s.src}
                alt={s.alt}
                decoding="async"
                fetchPriority={i === 0 ? 'high' : undefined}
                className={`h-full w-full ${
                  s.fit === 'contain' ? 'object-contain' : 'object-cover object-top'
                }`}
              />
            </button>
          ))}

          {/* enlarge affordance (decorative — the whole slide is the button) */}
          <span className="pointer-events-none absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-white/10 bg-gray-950/70 px-2 py-1 text-[11px] text-gray-300 backdrop-blur">
            <ExpandIcon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Enlarge</span>
          </span>

          {/* dwell progress */}
          {!reducedMotion && !paused && (
            <div
              key={index}
              aria-hidden="true"
              className="absolute bottom-0 left-0 h-0.5 bg-brand-sky/70 motion-safe:animate-[carousel-dwell_6.5s_linear_forwards]"
            />
          )}

          {/* prev / next */}
          <button
            type="button"
            aria-label="Previous screenshot"
            onClick={() => go(index - 1)}
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-gray-950/70 p-2 text-gray-300 opacity-70 backdrop-blur transition hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-skySoft"
          >
            <Chevron className="h-4 w-4 rotate-180" />
          </button>
          <button
            type="button"
            aria-label="Next screenshot"
            onClick={() => go(index + 1)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-gray-950/70 p-2 text-gray-300 opacity-70 backdrop-blur transition hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-skySoft"
          >
            <Chevron className="h-4 w-4" />
          </button>
        </div>
      </figure>

      {/* caption */}
      <p className="mx-auto mt-3 max-w-2xl text-center text-sm leading-relaxed text-gray-400">
        {active.caption}
      </p>

      {/* label chips (sm+) */}
      <div className="mt-3 hidden flex-wrap items-center justify-center gap-1.5 sm:flex" role="tablist" aria-label="Screenshots">
        {slides.map((s, i) => (
          <button
            key={s.src}
            type="button"
            role="tab"
            aria-selected={i === index}
            onClick={() => go(i)}
            className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition ${
              i === index
                ? 'bg-brand-sky/15 text-brand-skySoft ring-brand-sky/40'
                : 'bg-white/5 text-gray-400 ring-white/10 hover:bg-white/10 hover:text-gray-200'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* dots (mobile) */}
      <div className="mt-3 flex items-center justify-center gap-2 sm:hidden">
        {slides.map((s, i) => (
          <button
            key={s.src}
            type="button"
            aria-label={`Go to ${s.label}`}
            onClick={() => go(i)}
            className={`h-2 w-2 rounded-full transition ${
              i === index ? 'bg-brand-sky' : 'bg-white/20'
            }`}
          />
        ))}
      </div>

      {/* progress-bar keyframes (scoped, tiny) */}
      <style>{`@keyframes carousel-dwell { from { width: 0 } to { width: 100% } }`}</style>
    </div>
  );
}

function Chevron({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
