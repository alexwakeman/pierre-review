import type { ReactNode } from 'react';
import { Link } from '../../router';

// ---------------------------------------------------------------------------
// The Feint primitive set.
//
// Deliberately small. This direction has no cards, no tiles, no chips, no
// badges and no icons, so most of what a marketing-site component library
// usually holds does not exist here. What is left is: the section shell (an
// 84px rail plus content), two label forms, four action shapes and a link.
//
// Type is NOT componentised — the Tailwind fontSize tokens carry line-height
// and tracking with the size, so `font-display text-h2 text-ink` is already one
// class per axis and a <H2> wrapper would only add indirection.
// ---------------------------------------------------------------------------

/* ---------------------------------------------------------- labels --------- */

/**
 * The inline uppercase mono label. Used for "Optional", "Works with", "Not
 * another review bot", "Pro · BYO key", "Models / Today / Coming".
 *
 * `wide` is the 0.16em tracking used once, on the hero's opening label.
 */
export function MonoLabel({
  children,
  wide = false,
  className = 'text-secondary',
}: {
  children: ReactNode;
  wide?: boolean;
  className?: string;
}): JSX.Element {
  // A block-level <span>, not a <div>: the BYO-key notes put one of these inside
  // a <p>, and a <div> there is invalid HTML that React renders anyway and the
  // prerenderer bakes into the static output.
  return (
    <span
      className={`block font-mono uppercase ${wide ? 'text-mono-label-wide' : 'text-mono-label'} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * The section rail label — a number over a word ("01 / Problem").
 *
 * Every section is introduced by one of these in the left rail, never by a
 * coloured eyebrow. Below the `rail` breakpoint the label moves ABOVE its
 * section and collapses to a single line, which falls out of the parent grid
 * going one-column: the label is simply the first row, in source order.
 */
export function RailLabel({ n, word }: { n?: string; word: string }): JSX.Element {
  return (
    <div className="mb-6 font-mono text-mono-label uppercase text-secondary rail:mb-0 rail:pt-[10px]">
      {n && (
        <span className="rail:block">
          {n}
          <span className="rail:hidden"> / </span>
        </span>
      )}
      {word}
    </div>
  );
}

/* --------------------------------------------------------- sections -------- */

type SectionProps = {
  id?: string;
  /** `alt` steps the paper one tone darker (#F4F4EF). */
  tone?: 'paper' | 'alt';
  /**
   * The top rule. `rule` is the ordinary between-sections hairline; `ink` marks
   * a hinge in the argument (the final CTA, the top of the tier table).
   */
  divider?: 'rule' | 'ink' | 'none';
  /**
   * `lg` is the 80px padding used by the closing CTA. `none` hands padding to
   * the caller — used by the pricing hero and tier table, which share one
   * uninterrupted region and so cannot each carry the standard rhythm.
   */
  pad?: 'default' | 'lg' | 'none';
  className?: string;
  children: ReactNode;
};

const PAD: Record<NonNullable<SectionProps['pad']>, string> = {
  default: 'py-section-y',
  lg: 'py-section-y-lg',
  none: '',
};

const DIVIDER: Record<NonNullable<SectionProps['divider']>, string> = {
  rule: 'border-t border-rule',
  ink: 'border-t border-ink',
  none: '',
};

/**
 * The section shell: the top rule, the paper tone and the vertical rhythm.
 *
 * It holds one or more <RailGrid>s rather than being a grid itself, because
 * several sections carry two rail-labelled blocks under one rule (Problem +
 * "who it's for"), and the closing CTA carries no rail at all.
 */
export function Section({
  id,
  tone = 'paper',
  divider = 'rule',
  pad = 'default',
  className = '',
  children,
}: SectionProps): JSX.Element {
  return (
    <section
      id={id}
      className={`px-gutter ${PAD[pad]} ${DIVIDER[divider]} ${
        tone === 'alt' ? 'bg-paper-alt' : ''
      } ${className}`}
    >
      {children}
    </section>
  );
}

/**
 * One rail-labelled row: an 84px label column plus one or two content columns.
 *
 * Below the `rail` breakpoint this collapses to a single column, which is what
 * moves the label above its content — in source order, for free.
 */
export function RailGrid({
  rail,
  cols = 'two',
  className = '',
  children,
}: {
  rail?: { n?: string; word: string };
  cols?: 'one' | 'two';
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`grid items-start gap-grid-gutter ${
        cols === 'two' ? 'rail:grid-cols-rail' : 'rail:grid-cols-rail-1'
      } ${className}`}
    >
      {rail && <RailLabel {...rail} />}
      {children}
    </div>
  );
}

/* ---------------------------------------------------------- actions -------- */
//
// No lift, no shadow, no scale — on any of these. Hover is a 120ms colour fade
// and nothing else. focus-visible is a 2px ink outline at 2px offset, square,
// because a rounded focus ring on a site with no rounded corners reads as a bug.

const FOCUS =
  'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';
const FADE = 'transition-colors duration-hover ease-standard';

/** The primary action: ink fill, paper text. "Sign in with GitHub". */
export function InkButton({
  to,
  children,
  className = '',
}: {
  to: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      className={`inline-block bg-ink px-6 py-[15px] font-display text-[16px] font-semibold text-paper hover:bg-[#08080A] ${FADE} ${FOCUS} ${className}`}
    >
      {children}
    </Link>
  );
}

/**
 * The paid action: vermilion fill, paper text. "Get Pro".
 *
 * Note the fill is `signal-text` (#C13A20), NOT `signal-fill` (#E2492C) — this
 * button carries text, and #E2492C is 3.85:1 on paper. Any vermilion that sits
 * under type uses the darker stop.
 */
export function SignalButton({
  to,
  children,
  className = '',
}: {
  to: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      className={`inline-block bg-signal-text px-6 py-[15px] font-display text-[16px] font-semibold text-paper hover:bg-[#A6301A] ${FADE} ${FOCUS} ${className}`}
    >
      {children}
    </Link>
  );
}

/** The secondary action on the pricing CTA: a 1px ink outline, no fill. */
export function OutlineButton({
  to,
  children,
  className = '',
}: {
  to: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      className={`inline-block border border-ink px-5 py-[15px] font-display text-[16px] font-medium text-ink hover:bg-ink hover:text-paper ${FADE} ${FOCUS} ${className}`}
    >
      {children}
    </Link>
  );
}

/** The hero's secondary action: ink text on a 1px ink bottom border only. */
export function UnderlineLink({
  to,
  children,
  className = '',
}: {
  to: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      className={`inline-block border-b border-ink px-1.5 py-[15px] font-display text-[16px] font-medium text-ink hover:text-signal-text ${FADE} ${FOCUS} ${className}`}
    >
      {children}
    </Link>
  );
}

/**
 * The section-closing "→" link: mono, ink, on a vermilion hairline.
 *
 * The underline is `signal-fill` (#E2492C) — legal here precisely because it is
 * a rule and not type.
 */
export function MonoLink({
  to,
  children,
  className = '',
}: {
  to: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      className={`inline-block border-b border-signal-fill pb-[3px] font-mono text-mono-nav text-ink hover:text-signal-text ${FADE} ${FOCUS} ${className}`}
    >
      {children}
    </Link>
  );
}

/** A link inside running copy: ink, on a vermilion hairline at rest. */
export function InlineLink({
  to,
  children,
  className = '',
}: {
  to: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      className={`border-b border-signal-fill text-ink hover:text-signal-text ${FADE} ${FOCUS} ${className}`}
    >
      {children}
    </Link>
  );
}

/* ------------------------------------------------------- section kit ------- */

/**
 * A documented voice from outside — a section's "surprise". REAL quotes only:
 * every quote rendered through this component must be verbatim from a source a
 * human can find (the attribution names it). Nothing here is ever invented or
 * paraphrased into quotation marks. The left rule is `signal-fill`, which is
 * legal vermilion because it is a rule, not type.
 */
export function Evidence({
  quote,
  source,
}: {
  quote: string;
  source: string;
}): JSX.Element {
  return (
    <figure className="my-6 max-w-answer border-l border-signal-fill pl-5">
      <blockquote className="font-serif text-[19px] italic leading-normal text-ink-soft">
        “{quote}”
      </blockquote>
      <figcaption className="mt-2.5 font-mono text-mono-caption text-secondary">
        {source}
      </figcaption>
    </figure>
  );
}

/**
 * One line of the working day — how a section lands in practice. The same
 * shape as the homepage's scenario beats (vermilion dash, ink moment, quiet
 * mono line), so the pages read as one narrative family.
 */
export function Story({
  moment,
  children,
}: {
  moment: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <p className="mt-7 flex items-baseline gap-3.5 border-t border-rule pt-4 font-mono text-mono-nav text-secondary">
      <span aria-hidden="true" className="text-signal-text">
        —
      </span>
      <span>
        <span className="text-ink">{moment}</span> · {children}
      </span>
    </p>
  );
}

/* ------------------------------------------------------------ lists -------- */

/**
 * A copy list item led by a vermilion em-dash. Used by both "who it's for"
 * columns. The dash is the only vermilion in running copy and it is doing the
 * work a bullet or a tick would do in a louder system.
 */
export function DashItem({ children }: { children: ReactNode }): JSX.Element {
  return (
    <li className="flex gap-3.5 text-body-sm">
      <span aria-hidden="true" className="pt-1.5 font-mono text-mono-caption text-signal-text">
        —
      </span>
      <span>{children}</span>
    </li>
  );
}

/**
 * A rule-separated feature row. The pricing tables are ruled rows, not bulleted
 * cards — no ticks, no icons. The last row in a list also takes a bottom rule.
 */
export function RuledItem({
  children,
  last = false,
}: {
  children: ReactNode;
  last?: boolean;
}): JSX.Element {
  return (
    <li className={`border-t border-rule-hair py-3 text-list ${last ? 'border-b' : ''}`}>
      {children}
    </li>
  );
}
