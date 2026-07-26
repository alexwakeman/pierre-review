import type { ReactNode } from 'react';

// Shared shell + typography for the legal pages (Privacy, Cookies, Terms).
// Deliberately plain: no glows, no screenshots, no marketing voice. These pages are
// read when something has gone wrong or when a procurement checklist demands them,
// and both audiences want a wide measure, real headings and a visible last-updated
// date — not a hero.

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
    <div className="mx-auto max-w-3xl px-5 py-16 sm:px-6 sm:py-24">
      <h1 className="text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
        {title}
      </h1>
      <p className="mt-3 text-xs uppercase tracking-wider text-gray-500">
        Last updated {LEGAL_LAST_UPDATED}
      </p>
      <div className="mt-6 text-[15px] leading-relaxed text-gray-300">{intro}</div>
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
    <section id={id} className="scroll-mt-24">
      <h2 className="text-xl font-semibold text-gray-100">{heading}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-gray-300">
        {children}
      </div>
    </section>
  );
}

export function P({ children }: { children: ReactNode }): JSX.Element {
  return <p>{children}</p>;
}

export function UL({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ul className="ml-5 list-disc space-y-2 text-[15px] leading-relaxed text-gray-300">
      {children}
    </ul>
  );
}

/** An emphasised term at the start of a bullet, e.g. "**Your GitHub identity** — …". */
export function T({ children }: { children: ReactNode }): JSX.Element {
  return <span className="font-semibold text-gray-100">{children}</span>;
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
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-white/10 bg-white/[0.03]">
            {columns.map((c) => (
              <th key={c} className="px-3 py-2.5 font-semibold text-gray-200">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-white/5 last:border-0 align-top">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2.5 text-gray-300">
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
    <div className="rounded-lg border border-brand-sky/25 bg-brand-sky/[0.06] p-4">
      <p className="text-sm font-semibold text-sky-200">{title}</p>
      <div className="mt-1.5 space-y-2 text-sm leading-relaxed text-gray-300">
        {children}
      </div>
    </div>
  );
}

export function Mail(): JSX.Element {
  return (
    <a
      href={`mailto:${LEGAL_CONTACT_EMAIL}`}
      className="text-brand-sky underline hover:text-sky-300"
    >
      {LEGAL_CONTACT_EMAIL}
    </a>
  );
}
