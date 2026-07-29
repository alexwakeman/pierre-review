import type { ReactNode } from 'react';

// Shared shell + typography for the legal pages (Privacy, Cookies, Terms).
// Deliberately plain: no figures, no screenshots, no marketing voice. These pages
// are read when something has gone wrong or when a procurement checklist demands
// them, and both audiences want a wide measure, real headings and a visible
// last-updated date — not a hero.
//
// Ported to the Feint language: paper, hairlines, a Newsreader reading column and
// Archivo headings. Note that NOTHING here uses vermilion except an in-copy link
// rule — the signal colour means "a human is still needed" and a privacy note is
// not that.

/** Single source of truth for the "last updated" line on every legal page. */
export const LEGAL_LAST_UPDATED = '26 July 2026';

/** The controller's contact point, referenced from all three documents. */
export const LEGAL_CONTACT_EMAIL = 'wakemana@gmail.com';
export const LEGAL_CONTROLLER = 'Alex Wakeman';

export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="max-w-[78ch] px-gutter py-16">
      <h1 className="font-display text-h2-sm font-semibold text-ink type:text-h2-minor">
        {title}
      </h1>
      <p className="mt-3.5 font-mono text-mono-label uppercase text-secondary">
        Last updated {LEGAL_LAST_UPDATED}
      </p>
      <div className="mt-6 space-y-3.5 text-body-sm">{intro}</div>
      <div className="mt-10 space-y-10">{children}</div>
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
    <section id={id} className="scroll-mt-16 border-t border-rule pt-7">
      <h2 className="font-display text-h4 font-semibold text-ink">{heading}</h2>
      <div className="mt-3.5 space-y-3.5 text-body-sm">{children}</div>
    </section>
  );
}

export function P({ children }: { children: ReactNode }): JSX.Element {
  return <p>{children}</p>;
}

export function UL({ children }: { children: ReactNode }): JSX.Element {
  return <ul className="ml-5 list-disc space-y-2 text-body-sm">{children}</ul>;
}

/** An emphasised term at the start of a bullet, e.g. "**Your GitHub identity** — …". */
export function T({ children }: { children: ReactNode }): JSX.Element {
  return <span className="font-display font-semibold text-ink">{children}</span>;
}

/**
 * A responsive definition table. Wrapped in its own overflow-x container so a wide
 * row scrolls itself rather than the page (the same rule the app's tables follow).
 */
export function LegalTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: ReactNode[][];
}): JSX.Element {
  return (
    <div className="overflow-x-auto border border-rule">
      <table className="w-full min-w-[36rem] border-collapse text-left text-list">
        <thead>
          <tr className="border-b border-rule bg-paper-alt">
            {columns.map((c) => (
              <th
                key={c}
                className="px-3.5 py-3 font-mono text-mono-label uppercase text-secondary"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-rule-hair align-top last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="px-3.5 py-3">
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

/** A callout for the local-vs-cloud distinction, which every page has to make. */
export function LegalNote({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="border-t border-ink bg-paper-alt px-5 py-4">
      <p className="font-mono text-mono-label uppercase text-secondary">{title}</p>
      <div className="mt-2.5 space-y-2 text-list">{children}</div>
    </div>
  );
}

export function Mail(): JSX.Element {
  return (
    <a
      href={`mailto:${LEGAL_CONTACT_EMAIL}`}
      className="border-b border-signal-fill text-ink transition-colors duration-hover ease-standard hover:text-signal-text focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      {LEGAL_CONTACT_EMAIL}
    </a>
  );
}
