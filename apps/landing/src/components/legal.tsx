import type { ReactNode } from 'react';
import { useReveal } from './board/useReveal';
import '../pages/legal.css';

// Shared shell + typography for the legal pages (Privacy, Cookies, Terms).
// Deliberately plain: no figures, no screenshots, no marketing voice. These pages
// are read when something has gone wrong or when a procurement checklist demands
// them, and both audiences want a readable measure, real headings and a visible
// last-updated date — not a hero.
//
// Drawn in the board style (src/board.css): a small header board (the title tile
// and one pigment tile carrying the date), then one reading column on the dark
// ground. Page-only rules live in ../pages/legal.css, scoped under `.lb.legal`.

/** Single source of truth for the "last updated" line on every legal page.
 *
 * ONE DATE FOR ALL THREE, by design — which means a change to any one of them
 * re-dates the other two. That is the accepted trade: a stale date on a document
 * that HAS changed is a compliance problem, and three separately-maintained dates
 * is the shape in which one of them gets forgotten.
 *
 * Last moved when the terms gained the AI safeguards and liability sections, and the
 * privacy policy's download line changed (Claude and Codex download on first start). */
export const LEGAL_LAST_UPDATED = '30 October 2026';

/** The controller's contact point, referenced from all three documents. */
export const LEGAL_CONTACT_EMAIL = 'wakemana@gmail.com';
export const LEGAL_CONTROLLER = 'Alex Wakeman';

/** The in-copy link style (an underline in the page's ink, gold on hover). */
export const LEGAL_LINK = 'lg-a';

type Pigment = 'lapis' | 'verdigris' | 'madder';

export function LegalPage({
  title,
  intro,
  pigment = 'lapis',
  children,
}: {
  title: string;
  intro: ReactNode;
  /** The header's one pigment tile, so the three documents read apart. */
  pigment?: Pigment;
  children: ReactNode;
}): JSX.Element {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div className="lb legal" ref={ref}>
      <header className="board lg-head">
        <div className="tile lg-name">
          <h1>{title}</h1>
        </div>
        <div className={`tile ${pigment} lg-date`}>
          <p>Last updated {LEGAL_LAST_UPDATED}</p>
        </div>
      </header>
      <article className="lg-col">
        <div className="lg-intro">{intro}</div>
        <div className="lg-body">{children}</div>
      </article>
    </div>
  );
}

export function LegalSection({
  id,
  heading,
  children,
}: {
  id: string;
  heading: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section id={id} className="lg-sec">
      <h2>{heading}</h2>
      <div className="lg-flow">{children}</div>
    </section>
  );
}

export function P({ children }: { children: ReactNode }): JSX.Element {
  return <p>{children}</p>;
}

export function UL({ children }: { children: ReactNode }): JSX.Element {
  return <ul className="lg-ul">{children}</ul>;
}

/** An emphasised term at the start of a bullet, e.g. "**Your GitHub identity** — …". */
export function T({ children }: { children: ReactNode }): JSX.Element {
  return <strong className="lg-t">{children}</strong>;
}

/**
 * A responsive definition table. Wrapped in its own overflow-x container so a wide
 * row scrolls itself rather than the page (the same rule the app's tables follow).
 * The container is a focusable, labelled region so a keyboard can scroll it; on a
 * phone each row stacks into labelled lines instead (legal.css, via `data-label`).
 */
export function LegalTable({
  label,
  columns,
  rows,
}: {
  /** Names the scrollable region for screen readers. */
  label: string;
  columns: string[];
  rows: ReactNode[][];
}): JSX.Element {
  return (
    <div className="lg-table" role="region" aria-label={label} tabIndex={0}>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} data-label={columns[j]}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A callout for the one fact each page leads with. */
export function LegalNote({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="lg-note">
      <p className="lg-note-t">{title}</p>
      <div className="lg-flow">{children}</div>
    </div>
  );
}

export function Mail(): JSX.Element {
  return (
    <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className={LEGAL_LINK}>
      {LEGAL_CONTACT_EMAIL}
    </a>
  );
}
