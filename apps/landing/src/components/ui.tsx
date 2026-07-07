import type { ReactNode } from 'react';
import { useLightbox } from './Lightbox';

// Shared, mobile-first building blocks for the marketing pages: a macOS-style
// window frame for screenshots, section/heading primitives, stat tiles, pills and
// accent glows. Everything scales down cleanly on small screens (the frame chrome
// shrinks, images stay w-full h-auto so nothing forces horizontal scroll).

/** A macOS-style window frame around a product screenshot. Fully responsive, and
 *  clickable — tapping it opens the shot in the full-screen Lightbox (unless
 *  `zoomable={false}`). */
export function Shot({
  src,
  alt,
  title = 'pierre · /app',
  eager = false,
  className = '',
  priority,
  width,
  height,
  zoomable = true,
}: {
  src: string;
  alt: string;
  title?: string;
  eager?: boolean;
  className?: string;
  /** Hint browsers to fetch the LCP/hero image first. */
  priority?: boolean;
  /** Intrinsic pixel dimensions — set on above-the-fold shots to reserve space (no CLS). */
  width?: number;
  height?: number;
  /** Set false to render a plain, non-interactive frame. */
  zoomable?: boolean;
}): JSX.Element {
  const { open } = useLightbox();
  const enlarge = (): void => open({ src, alt, title });

  return (
    <figure
      className={`group/shot overflow-hidden rounded-lg border border-white/10 bg-gray-900/60 shadow-2xl shadow-black/50 ring-1 ring-white/5 sm:rounded-xl ${className}`}
    >
      {/* window chrome — traffic lights shrink on mobile */}
      <div className="flex items-center gap-1.5 border-b border-white/10 bg-gray-900/80 px-3 py-2 sm:gap-2 sm:px-4 sm:py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-red-500/70 sm:h-3 sm:w-3" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70 sm:h-3 sm:w-3" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-500/70 sm:h-3 sm:w-3" />
        <span className="ml-2 hidden truncate text-xs text-gray-500 sm:ml-3 sm:inline">
          {title}
        </span>
        {zoomable && (
          <span className="ml-auto hidden items-center gap-1 text-[11px] text-gray-500 transition group-hover/shot:text-gray-300 sm:inline-flex">
            <ExpandIcon className="h-3.5 w-3.5" />
            Enlarge
          </span>
        )}
      </div>
      {zoomable ? (
        <button
          type="button"
          onClick={enlarge}
          aria-label={`Enlarge screenshot: ${alt}`}
          className="block w-full cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-skySoft"
        >
          <img
            src={src}
            alt={alt}
            width={width}
            height={height}
            loading={eager ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : undefined}
            decoding="async"
            className="block h-auto w-full"
          />
        </button>
      ) : (
        <img
          src={src}
          alt={alt}
          width={width}
          height={height}
          loading={eager ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : undefined}
          decoding="async"
          className="block h-auto w-full"
        />
      )}
    </figure>
  );
}

/** Corner-arrows expand glyph (used on interactive Shots + the carousel). */
export function ExpandIcon({ className }: { className?: string }): JSX.Element {
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
      <path d="M9 3H3v6M21 9V3h-6M3 15v6h6M15 21h6v-6" />
    </svg>
  );
}

/** Outer section wrapper with consistent vertical rhythm + max width. */
export function Section({
  id,
  children,
  className = '',
  width = 'default',
}: {
  id?: string;
  children: ReactNode;
  className?: string;
  width?: 'default' | 'wide' | 'narrow';
}): JSX.Element {
  const max =
    width === 'wide' ? 'max-w-6xl' : width === 'narrow' ? 'max-w-3xl' : 'max-w-5xl';
  return (
    <section id={id} className={`mx-auto px-5 sm:px-6 ${max} ${className}`}>
      {children}
    </section>
  );
}

/** Small uppercase label above a heading. */
export function Eyebrow({
  children,
  className = 'text-brand-sky',
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <p className={`text-xs font-semibold uppercase tracking-[0.18em] ${className}`}>
      {children}
    </p>
  );
}

/** Centred section heading with optional eyebrow + lead paragraph. */
export function SectionHeading({
  eyebrow,
  eyebrowClass,
  title,
  lead,
  align = 'center',
}: {
  eyebrow?: ReactNode;
  eyebrowClass?: string;
  title: ReactNode;
  lead?: ReactNode;
  align?: 'center' | 'left';
}): JSX.Element {
  const wrap = align === 'center' ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl';
  return (
    <div className={wrap}>
      {eyebrow && <Eyebrow className={eyebrowClass}>{eyebrow}</Eyebrow>}
      <h2
        className={`text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl ${
          eyebrow ? 'mt-3' : ''
        }`}
      >
        {title}
      </h2>
      {lead && (
        <p className="mt-4 text-pretty text-base leading-relaxed text-gray-400 sm:text-lg">
          {lead}
        </p>
      )}
    </div>
  );
}

/** A stat tile (big number + label). */
export function Stat({
  value,
  label,
  accent = 'text-brand-sky',
}: {
  value: ReactNode;
  label: ReactNode;
  accent?: string;
}): JSX.Element {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 text-center backdrop-blur">
      <div className={`text-2xl font-bold tracking-tight sm:text-3xl ${accent}`}>{value}</div>
      <div className="mt-1 text-xs text-gray-400 sm:text-sm">{label}</div>
    </div>
  );
}

/** A small rounded badge / pill. */
export function Pill({
  children,
  className = 'bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30',
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * An alternating image / copy feature block. On mobile the screenshot stacks
 * above the copy; on large screens they sit side by side (image side flips with
 * `flip`).
 */
export function FeatureRow({
  shot,
  flip = false,
  children,
}: {
  shot: ReactNode;
  flip?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="grid items-center gap-7 lg:grid-cols-5 lg:gap-10">
      <div className={`lg:col-span-3 ${flip ? 'lg:order-2' : ''}`}>{shot}</div>
      <div className={`lg:col-span-2 ${flip ? 'lg:order-1' : ''}`}>{children}</div>
    </div>
  );
}

/** Reusable soft accent glow (decorative, behind content). */
export function Glow({
  className,
}: {
  className: string;
}): JSX.Element {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className={className} />
    </div>
  );
}
