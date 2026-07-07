import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// A single, app-wide screenshot lightbox. Any image surface (the macOS-framed
// <Shot>, the hero carousel, the Pro walkthrough steps) calls `useLightbox().open`
// to blow a screenshot up to effectively full-screen on a dark scrim, framed with a
// dark border. Two view modes toggle on tap:
//   • fit  (default) — the whole image contained in the viewport
//   • zoom          — scaled up + scrollable, so dense UI text is readable on a phone
// Closes on the ✕, a backdrop tap, or Esc; locks body scroll while open.

export interface LightboxItem {
  src: string;
  alt: string;
  /** Optional chrome-bar title (defaults to a neutral label). */
  title?: string;
}

interface LightboxApi {
  open: (item: LightboxItem) => void;
}

const LightboxContext = createContext<LightboxApi | null>(null);

/** Open the app-wide screenshot lightbox. Must be used under <LightboxProvider>. */
export function useLightbox(): LightboxApi {
  const ctx = useContext(LightboxContext);
  if (!ctx) throw new Error('useLightbox must be used within a LightboxProvider');
  return ctx;
}

export function LightboxProvider({ children }: { children: ReactNode }): JSX.Element {
  const [item, setItem] = useState<LightboxItem | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const open = useCallback((next: LightboxItem) => {
    setItem(next);
    setZoomed(false);
  }, []);
  const close = useCallback(() => setItem(null), []);

  // Esc to close, lock body scroll, and move focus to the close button so the
  // dialog is keyboard-dismissable and the page underneath can't scroll away.
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [item, close]);

  return (
    <LightboxContext.Provider value={{ open }}>
      {children}
      {item && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={item.title ?? item.alt}
          onClick={close}
          className="fixed inset-0 z-[100] flex flex-col bg-gray-950/95 backdrop-blur-md"
        >
          {/* top bar — title + close. Clicks here fall through to the scrim and
              dismiss too (only the image swallows its click, to toggle zoom). */}
          <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
            <span className="min-w-0 truncate text-xs text-gray-400 sm:text-sm">
              {item.title ?? 'pierre'}
            </span>
            <button
              ref={closeRef}
              type="button"
              onClick={close}
              aria-label="Close"
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-gray-200 transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-skySoft"
            >
              <CloseIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Close</span>
              <span className="sm:hidden">Esc</span>
            </button>
          </div>

          {/* stage — the backdrop click here also closes; the image swallows its own */}
          <div
            className={`min-h-0 flex-1 overflow-auto px-3 pb-2 sm:px-6 ${
              zoomed ? '' : 'flex items-center justify-center'
            }`}
          >
            <img
              src={item.src}
              alt={item.alt}
              onClick={(e) => {
                e.stopPropagation();
                setZoomed((z) => !z);
              }}
              style={zoomed ? { width: 'min(1600px, 240vw)' } : undefined}
              className={
                zoomed
                  ? 'mx-auto block h-auto max-w-none cursor-zoom-out rounded-lg border-2 border-gray-800 shadow-2xl shadow-black/60 ring-1 ring-black/40'
                  : 'block max-h-full max-w-full cursor-zoom-in rounded-lg border-2 border-gray-800 shadow-2xl shadow-black/60 ring-1 ring-black/40'
              }
            />
          </div>

          {/* hint */}
          <p className="pointer-events-none px-4 pb-3 pt-1 text-center text-[11px] text-gray-500">
            Tap the image to {zoomed ? 'fit it to the screen' : 'zoom in'} · tap outside or
            press Esc to close
          </p>
        </div>
      )}
    </LightboxContext.Provider>
  );
}

function CloseIcon({ className }: { className?: string }): JSX.Element {
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
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
