import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { SITE_NAME } from '../lib/site';
import './chrome.css';

// A single, app-wide screenshot lightbox. Any image surface (the screenshots on
// Getting started and Reporting) calls `useLightbox().open` to blow a screenshot up to
// effectively full-screen on a dark scrim (styles: chrome.css, .lb-lightbox).
//
// The image itself carries NO border, radius, shadow or filter — the design's rule
// is that a product screenshot ships un-stylised, and "Enlarge opens a lightbox at
// native resolution" is exactly where that matters most. The scrim is the
// board's dark ground; its buttons are board buttons.
//
// Two ways to open:
//   • open(item)                 — a single image. Tapping it toggles fit ⇄ zoom
//                                  (scaled up + scrollable so dense UI text is
//                                  readable on a phone).
//   • openGallery(items, index)  — a browsable set (the hero carousel). Tapping the
//                                  image advances to the NEXT one (wrapping); ‹ ›
//                                  buttons + ← → arrow keys also step through it, and
//                                  a counter shows the position. (No tap-to-zoom in
//                                  gallery mode — tap is reserved for "next".)
// Closes on the ✕, a backdrop tap, or Esc; locks body scroll while open.

export interface LightboxItem {
  src: string;
  alt: string;
  /** Optional chrome-bar title (defaults to a neutral label). */
  title?: string;
}

interface LightboxApi {
  /** Open a single image (tap toggles zoom). */
  open: (item: LightboxItem) => void;
  /** Open a browsable set starting at `index` (tap / arrows step to the next). */
  openGallery: (items: LightboxItem[], index: number) => void;
}

const LightboxContext = createContext<LightboxApi | null>(null);

/** Open the app-wide screenshot lightbox. Must be used under <LightboxProvider>. */
export function useLightbox(): LightboxApi {
  const ctx = useContext(LightboxContext);
  if (!ctx) throw new Error('useLightbox must be used within a LightboxProvider');
  return ctx;
}

export function LightboxProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<LightboxItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const open = useCallback((next: LightboxItem) => {
    setItems([next]);
    setIndex(0);
    setZoomed(false);
  }, []);
  const openGallery = useCallback((list: LightboxItem[], start: number) => {
    if (list.length === 0) return;
    setItems(list);
    setIndex(((start % list.length) + list.length) % list.length);
    setZoomed(false);
  }, []);
  const close = useCallback(() => setItems(null), []);

  const count = items?.length ?? 0;
  const isGallery = count > 1;
  const current = items?.[index] ?? null;

  // Step through a gallery (wraps). Always resets to the fit view so the next shot
  // starts framed rather than mid-zoom.
  const go = useCallback(
    (delta: number) => {
      setZoomed(false);
      setIndex((i) => (count <= 1 ? i : ((i + delta) % count + count) % count));
    },
    [count],
  );

  // Esc to close (← / → to browse a gallery), lock body scroll, and move focus to the
  // close button so the dialog is keyboard-dismissable and the page underneath can't
  // scroll away.
  useEffect(() => {
    if (!items) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
      else if (isGallery && e.key === 'ArrowRight') {
        e.preventDefault();
        go(1);
      } else if (isGallery && e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [items, close, isGallery, go]);

  return (
    <LightboxContext.Provider value={{ open, openGallery }}>
      {children}
      {current && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={current.title ?? current.alt}
          onClick={close}
          className="lb-lightbox"
        >
          {/* top bar — title (+ gallery position) + close. Clicks here fall through to
              the scrim and dismiss too (only the image swallows its click). */}
          <div className="top">
            <span className="ttl">
              <span>{current.title ?? SITE_NAME.toLowerCase()}</span>
              {isGallery && (
                <span className="pos" aria-live="polite">
                  {index + 1} / {count}
                </span>
              )}
            </span>
            <button
              ref={closeRef}
              type="button"
              onClick={close}
              aria-label="Close"
              className="btn alt"
            >
              <CloseIcon />
              <span className="lg">Close</span>
              <span className="sm">Esc</span>
            </button>
          </div>

          {/* stage — the backdrop click here also closes; the image swallows its own */}
          <div className={zoomed ? 'stage' : 'stage fit'}>
            <img
              src={current.src}
              alt={current.alt}
              onClick={(e) => {
                e.stopPropagation();
                // Gallery → tap advances to the next shot; single image → toggle zoom.
                if (isGallery) go(1);
                else setZoomed((z) => !z);
              }}
              style={zoomed ? { width: 'min(1600px, 240vw)' } : undefined}
              className={zoomed ? 'zoom' : isGallery ? 'fit next' : 'fit'}
            />

            {/* prev / next — only for a gallery. Fixed to the viewport edges so they
                don't scroll with a zoomed image (gallery mode never zooms anyway). */}
            {isGallery && (
              <>
                <button
                  type="button"
                  aria-label="Previous screenshot"
                  onClick={(e) => {
                    e.stopPropagation();
                    go(-1);
                  }}
                  className="btn alt step prev"
                >
                  <Chevron />
                </button>
                <button
                  type="button"
                  aria-label="Next screenshot"
                  onClick={(e) => {
                    e.stopPropagation();
                    go(1);
                  }}
                  className="btn alt step next"
                >
                  <Chevron />
                </button>
              </>
            )}
          </div>

          {/* hint */}
          <p className="hint">
            {isGallery
              ? 'Tap the image or use ‹ › / arrow keys for the next shot · tap outside or press Esc to close'
              : `Tap the image to ${zoomed ? 'fit it to the screen' : 'zoom in'} · tap outside or press Esc to close`}
          </p>
        </div>
      )}
    </LightboxContext.Provider>
  );
}

function CloseIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function Chevron(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
