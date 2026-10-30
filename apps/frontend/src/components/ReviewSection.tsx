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
//
// THE REDESIGN'S QUIET SECTIONS (docs/redesign/DESIGN.md): inside `<QuietReviewSections>` (the AI
// Review and AI Fix tabs, the story view) a section is a 15px title over its content — no box, no
// band; sections are separated by space and items by tone. Outside it (Settings) the boxed shell
// stays until that screen is redesigned.
import { createContext, useContext, type ReactNode } from 'react';

const QuietContext = createContext(false);

/** Every ReviewSection under this draws quiet (title + content, no box). */
export function QuietReviewSections({ children }: { children: ReactNode }): JSX.Element {
  return <QuietContext.Provider value>{children}</QuietContext.Provider>;
}

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
  const quiet = useContext(QuietContext);
  if (quiet) {
    return (
      <section aria-label={title} className="min-w-0">
        <header className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 pb-2">
          <h3 className="text-title text-ui-ink">{title}</h3>
          {pills}
          {info}
          {actions != null && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
        {hasBody && <div className="space-y-2 text-body text-ui-ink">{children}</div>}
      </section>
    );
  }
  return (
    <section
      aria-label={title}
      className="rounded-ui border border-ui-line bg-ui-surface"
    >
      <header
        className={`flex flex-wrap items-center gap-x-2 gap-y-1 bg-ui-surface px-3 py-2 ${
          hasBody ? 'rounded-t-ui border-b border-ui-line' : 'rounded-ui'
        }`}
      >
        <h3 className="text-body font-semibold text-ui-ink">{title}</h3>
        {pills}
        {info}
        {actions != null && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {hasBody && <div className="space-y-2 px-3 py-3 text-body">{children}</div>}
    </section>
  );
}

// A count pill for a section header ("3 findings"). Neutral; a coloured status chip is the caller's.
export function SectionCount({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center rounded-ui bg-ui-raise px-1.5 py-0.5 text-meta font-medium tabular-nums text-ui-mute">
      {children}
    </span>
  );
}
