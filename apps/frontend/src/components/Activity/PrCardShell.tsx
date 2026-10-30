import { Fragment, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { CiStatus } from '@pierre-review/shared';
import { CI_META } from '../../lib/ui.js';

// THE PR CARD SHELL — the one card layout the Open PRs tab (OpenPrsCards.tsx) and the Pending board
// (AttentionCards.tsx) share, so a pull request looks the same wherever it is listed:
//
//   1. the TITLE line — the card's largest, heaviest text, then anything that belongs beside it
//      (a Draft marker, an external link, the Pending info button) at the end.
//   2. the CHIPS row, LEFT-aligned under the title (right-aligned they read as a separate column).
//      `empty:hidden`, so a card with nothing true to say has no blank row.
//   3. whatever the surface adds (a ticket row, a reason sentence, a review row, actions).
//   4. the META line — "#12 · repo · author · opened 3d · …" in 11px grey, parts separated by a
//      decorative "·"; size figures and flags trail it without separators.
//
// Each surface keeps its own content: the shell owns the frame, the type sizes, the spacing and
// the whole-card click, nothing else. It fetches nothing (the Pending board may not fetch on mount).

export const CARD_CHIP =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-px text-meta font-medium';
export const CARD_NEUTRAL_CHIP = `${CARD_CHIP} border-ui-line text-ui-mute`;
export const CARD_TONE_CHIP = `${CARD_CHIP} border-transparent`;
export const CARD_RED_CHIP = `${CARD_TONE_CHIP} bg-ui-danger/10 text-ui-danger`;

/** The selector a whole-card click ignores: a click on a control belongs to that control. */
export const CARD_CONTROL_SELECTOR = 'a,button,textarea,input,select,[data-noactivate]';

/** The meta line's separator. Decorative, so it is the one sanctioned contrast opt-out. */
export function CardSep(): JSX.Element {
  return (
    <span aria-hidden className="decorative-mark text-ui-faint">
      ·
    </span>
  );
}

/** The CI chip: a dot and the label, red-toned when the checks failed. Nothing when there is no
 *  checks reading — no "no checks" chip. */
export function CiChip({ ci }: { ci: CiStatus | null | undefined }): JSX.Element | null {
  const meta = ci != null ? CI_META[ci] : null;
  if (meta == null) return null;
  const red = ci === 'failure' || ci === 'error';
  return (
    <span className={red ? CARD_RED_CHIP : CARD_NEUTRAL_CHIP}>
      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}

/** "3 files", singular when one. */
export function filesLabel(n: number): string {
  return `${n} file${n === 1 ? '' : 's'}`;
}

/** The green/red line delta. */
export function LineDelta({ additions, deletions }: { additions: number; deletions: number }): JSX.Element {
  return (
    <span className="font-mono">
      <span className="text-ui-success">+{additions}</span>{' '}
      <span className="text-ui-danger">−{deletions}</span>
    </span>
  );
}

/** Should a whole-card click on `target` open the card? False when it landed on a control. */
export function cardClickActivates(target: EventTarget | null): boolean {
  const el = target as { closest?: (s: string) => unknown } | null;
  if (el == null || typeof el.closest !== 'function') return true;
  return el.closest(CARD_CONTROL_SELECTOR) == null;
}

/**
 * The card's frame: an `<li>`, rounded and bordered. With `onOpen` the WHOLE CARD is clickable and
 * keyboard-focusable (Enter / Space on the card itself); a click on any control inside is left to
 * that control. Without it the card is inert and takes no tab stop.
 */
export function PrCardFrame({
  labelledBy,
  onOpen,
  nested = false,
  accentClass,
  flash = false,
  innerRef,
  children,
}: {
  /** The title's id — the card's accessible name. */
  labelledBy?: string;
  onOpen?: () => void;
  /** Sits on a tray (an Open PRs ticket stack): in dark mode it takes the PAGE ground to stay
   *  distinct from the tray. */
  nested?: boolean;
  /** A left accent (the Pending board's severity), e.g. `border-l-4 border-l-red-400`. */
  accentClass?: string;
  /** The back-from-a-click highlight. */
  flash?: boolean;
  innerRef?: (el: HTMLLIElement | null) => void;
  children: ReactNode;
}): JSX.Element {
  const onKey = onOpen
    ? (e: KeyboardEvent<HTMLLIElement>): void => {
        // Only the card itself: a key on a control inside belongs to that control.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }
    : undefined;
  const onClick = onOpen
    ? (e: MouseEvent<HTMLLIElement>): void => {
        if (!cardClickActivates(e.target)) return;
        onOpen();
      }
    : undefined;
  const ground = nested ? '' : '';
  // A hover border colour would beat the accent's `border-l-*` (higher specificity) and grey out the
  // severity signal under the pointer, so an accented card changes only its background.
  const hoverBorder = accentClass != null ? '' : ' hover:border-ui-line';
  const hover = onOpen
    ? ` cursor-pointer hover:bg-ui-hover${hoverBorder} ${
        nested ? '' : ''
      }`
    : '';
  return (
    <li
      ref={innerRef}
      tabIndex={onOpen ? 0 : undefined}
      aria-labelledby={labelledBy}
      onClick={onClick}
      onKeyDown={onKey}
      className={`rounded-ui bg-ui-surface px-3.5 py-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent ${ground}${hover}${
        accentClass != null ? ` ${accentClass}` : ''
      }${flash ? ' ring-2 ring-ui-accent' : ''}`}
    >
      {children}
    </li>
  );
}

/** The title text's style — exported so a title that is a button (the Pending board's "open this
 *  PR on its Overview tab") reads exactly like one that is not. */
export const CARD_TITLE_TEXT = 'min-w-0 truncate text-body font-semibold text-ui-ink';

/** Line 1: the heading — the title, things that belong to it (`after`), and an end slot. */
export function PrCardTitle({
  id,
  level = 3,
  children,
  after,
  end,
}: {
  id?: string;
  level?: 3 | 4;
  /** The title itself: plain text (rendered in CARD_TITLE_TEXT) or a ready element. */
  children: ReactNode;
  after?: ReactNode;
  /** Right-aligned, OUTSIDE the heading (a link, the info button) so the accessible name stays the
   *  title. */
  end?: ReactNode;
}): JSX.Element {
  const Heading = level === 4 ? 'h4' : 'h3';
  const title =
    typeof children === 'string' ? (
      <span className={CARD_TITLE_TEXT} title={children}>
        {children}
      </span>
    ) : (
      children
    );
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Heading id={id} className="flex min-w-0 items-center gap-2">
        {title}
        {after}
      </Heading>
      {end != null && <div className="ml-auto flex shrink-0 items-center gap-1.5">{end}</div>}
    </div>
  );
}

/** Line 2: the status chips, left-aligned under the title. */
export function PrCardChips({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mt-1.5 flex flex-wrap items-center gap-1.5 empty:hidden">{children}</div>;
}

/**
 * The meta line. `parts` are separated by "·" (null/false parts are skipped, so no double or
 * dangling separator); `trailing` follows with a plain gap — the line delta and the flags.
 */
export function PrCardMeta({
  parts,
  trailing,
}: {
  parts: ReadonlyArray<ReactNode>;
  trailing?: ReactNode;
}): JSX.Element {
  const shown = parts.filter((p) => p != null && p !== false && p !== '');
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-meta text-ui-mute">
      {shown.map((p, i) => (
        // Positional keys: the parts are a fixed, ordered list per card.
        <Fragment key={i}>
          {i > 0 && <CardSep />}
          {p}
        </Fragment>
      ))}
      {trailing}
    </div>
  );
}

// ── THE EVENT-HEADING SLOT (Pending, layout B) ───────────────────────────────────────────────
//
// A Pending card leads with WHAT HAPPENED, not with the PR's title: "David Buckley replied: "…" · 2d".
// The Open PRs card keeps its title-first look; this is the optional slot a card uses instead of
// `PrCardTitle` when its subject is an event. Composed by `lib/pendingHeadings.ts` — this only
// draws it: the lead in the title's weight, the quote a step lighter, the time once at the end.
//
// ⚠ NO VISUAL LINE CLAMP. The quote is bounded by CHARACTERS (`HEADING_QUOTE_MAX_CHARS`, cut on a
// word with "…"), which is what `replyBlockShown` reads. A CSS clamp on the heading hid the age —
// the card's one time stamp — whenever the heading wrapped to a third line (a phone, or a long
// lead), and cut the quote without the reply block below knowing it had been cut.

export function PrCardEventHeading({
  id,
  lead,
  quote,
  age,
  ageTitle,
  icon,
}: {
  id?: string;
  /** The card type's mark (decorative), leading the heading. */
  icon?: ReactNode;
  lead: string;
  /** Plain text — rendered as a text node, never markup (third-party words). */
  quote?: string | null;
  /** "2d", "opened 9d"; null for none. */
  age?: string | null;
  /** The absolute time, for the age's tooltip. */
  ageTitle?: string;
}): JSX.Element {
  return (
    <h3
      id={id}
      className="min-w-0 break-words text-body font-semibold leading-snug text-ui-ink [overflow-wrap:anywhere]"
    >
      {icon != null && (
        <span className="mr-1.5 inline-flex translate-y-[2px] align-baseline text-ui-mute">
          {icon}
        </span>
      )}
      {lead}
      {quote != null && quote !== '' && (
        <>
          {': '}
          <span className="font-medium text-ui-ink">“{quote}”</span>
        </>
      )}
      {age != null && (
        <span className="whitespace-nowrap text-meta font-normal text-ui-mute" title={ageTitle}>
          {' · '}
          {age}
        </span>
      )}
    </h3>
  );
}

/** The Pending panel's action-bar buttons (docs/redesign/DESIGN.md § Controls): the one primary
 *  action (accent fill), the secondaries (raised tone), and the quiet text buttons (Details). The
 *  same shapes as the shared `Button` primitive — one radius, 32px (44px on touch). */
export const CARD_PRIMARY_BUTTON =
  'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-ui bg-ui-accent-fill px-3 text-body font-medium text-ui-on-accent hover:brightness-110 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent focus-visible:ring-offset-1 focus-visible:ring-offset-ui-bg disabled:opacity-50 touch:h-11 touch:px-4';
export const CARD_SECONDARY_BUTTON =
  'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-ui bg-ui-raise px-3 text-body font-medium text-ui-ink hover:bg-ui-hover outline-none focus-visible:ring-2 focus-visible:ring-ui-accent focus-visible:ring-offset-1 focus-visible:ring-offset-ui-bg disabled:opacity-50 touch:h-11 touch:px-4';
export const CARD_QUIET_BUTTON =
  'inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-ui px-2 text-body text-ui-mute hover:bg-ui-hover hover:text-ui-ink outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-60 touch:h-10';
