import { useEffect, type ReactNode } from 'react';

// Compact, scrollable help overlay opened from the header "?" button. A very brief
// tour of the core flows — tracking repos, the timeline, focus mode, navigation.
// Dismissed via the backdrop, the X, or Escape. The Escape handler runs in the
// capture phase and stops propagation so a stray dismiss doesn't also reach the
// global keyboard hook (which would exit focus / clear the selection).
export function HelpModal({ onClose }: { onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[80vh] w-[34rem] max-w-[92vw] flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Pierre help"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2 dark:border-gray-800">
          <h2 className="brand-title">Pierre</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          <p className="text-gray-500 dark:text-gray-400">
            A local dashboard for your team’s GitHub pull-request activity across
            repos, drawn as an interactive timeline. Everything runs on your machine.
          </p>

          <Section title="Track repositories">
            Add repos in the filter bar’s <em>add repo</em> box as <Code>owner/name</Code>.
            Pierre syncs their PR activity every few minutes into a local file — nothing
            leaves your machine.
          </Section>

          <Section title="Read the timeline">
            Rows are grouped <strong>repo → contributor</strong>. Each PR is a bar; the
            markers beneath it are events — commits, comments, reviews. Scroll to pan,
            hold the zoom key while scrolling to zoom. Click a marker for its details,
            or a PR bar to select it.
          </Section>

          <Section title="Focus mode">
            To isolate one PR and just its contributors: double-click its bar, click{' '}
            <strong>Focus</strong> in the detail pane, or click a cross-person marker.
            Leave focus with the <strong>✕</strong> on the header{' '}
            <strong>Focus mode</strong> badge, <Kbd>Esc</Kbd>, or the browser{' '}
            <strong>Back</strong> button.
          </Section>

          <Section title="Detail pane">
            Selecting a PR opens the bottom pane with <strong>Overview</strong> (checks,
            summary, comments), <strong>Threads</strong>, and <strong>Activity</strong>.
            The <em>Show</em> links jump back to that moment on the timeline; drag the
            divider to resize the pane.
          </Section>

          <Section title="Filter">
            Narrow by date range, members (auto-scoped to who’s active in view), event
            categories, and thread states. <em>Exclude bots</em> hides
            renovate&nbsp;/&nbsp;dependabot&nbsp;/&nbsp;CI noise.
          </Section>

          <Section title="Open-PRs strip">
            The collapsible strip up top lists currently-open PRs — toggle between{' '}
            <strong>all</strong>, <strong>my turn</strong>, and{' '}
            <strong>needs attention</strong>.
          </Section>

          <Section title="My Turn &amp; Insights">
            The header <strong>My Turn</strong> button isolates the timeline to the PRs
            that need you now; <strong>Insights</strong> opens a per-repo snapshot
            (open&nbsp;/&nbsp;merged&nbsp;/&nbsp;stalled, time-to-first-review, review
            load). Save filter combinations as named <strong>Views</strong>, and use the
            bell to get notified when something new lands in your queue.
          </Section>

          <Section title="Keyboard">
            <Kbd>/</Kbd> focus the filter · <Kbd>j</Kbd>/<Kbd>k</Kbd> cycle PRs ·{' '}
            <Kbd>m</Kbd> toggle My Turn · <Kbd>i</Kbd> Insights · <Kbd>Esc</Kbd> exit
            focus, else clear the selection.
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section>
      <h3 className="mb-1 font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
      <p>{children}</p>
    </section>
  );
}

function Code({ children }: { children: ReactNode }): JSX.Element {
  return (
    <code className="rounded bg-gray-100 px-1 font-mono text-[12px] text-gray-700 dark:bg-gray-800 dark:text-gray-300">
      {children}
    </code>
  );
}

function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return (
    <kbd className="rounded border border-gray-300 bg-gray-100 px-1 text-[11px] font-medium text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
      {children}
    </kbd>
  );
}
