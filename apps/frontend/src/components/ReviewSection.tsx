// THE ONE SECTION SHELL of the Claude Review pane. Every section of that pane — the run controls,
// Claude's review, CI failures, Previous review, Review threads, Findings, Story check, Review
// chat, Post to GitHub, Reviews and actions — renders through this, so the hierarchy reads the same
// everywhere:
//
//   pane → SECTION (strong border, a tinted header band: title + count pills + ⓘ + actions)
//        → card (each component's own lighter border)
//
// ⚠ Do not hand-roll a section header inside the pane: the user reported the old mix (some
// sections boxed, some bare, one with no header at all, titles in three sizes) as unreadable.
// Titles are sentence case and all the same size; the count pills sit right after the title.
import type { ReactNode } from 'react';

export function ReviewSection({
  title,
  pills,
  info,
  actions,
  children,
}: {
  title: string;
  // Count pills / short status chips, right after the title.
  pills?: ReactNode;
  // An <InfoButton> explaining the section (instead of a blurb under the title).
  info?: ReactNode;
  // Right-aligned controls in the header row.
  actions?: ReactNode;
  // Absent ⇒ a header-only section (no body, no rule under the header).
  children?: ReactNode;
}): JSX.Element {
  const hasBody = children != null && children !== false;
  return (
    <section
      aria-label={title}
      className="rounded-lg border border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-950"
    >
      <header
        className={`flex flex-wrap items-center gap-x-2 gap-y-1 bg-gray-50 px-3 py-2 dark:bg-gray-900 ${
          hasBody ? 'rounded-t-lg border-b border-gray-200 dark:border-gray-800' : 'rounded-lg'
        }`}
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        {pills}
        {info}
        {actions != null && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {hasBody && <div className="space-y-2 px-3 py-3 text-sm">{children}</div>}
    </section>
  );
}

// A count pill for a section header ("3 findings"). Neutral; a coloured status chip is the caller's.
export function SectionCount({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px] font-medium text-gray-700 dark:text-gray-300">
      {children}
    </span>
  );
}
