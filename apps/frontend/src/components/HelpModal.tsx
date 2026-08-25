import { useEffect, type ReactNode } from 'react';
import { Wordmark } from './Wordmark';

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
        aria-label="Limn help"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2 dark:border-gray-800">
          <h2><Wordmark /></h2>
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
            A dashboard for GitHub pull-request activity across a Workspace of repos —
            built for sprint situational-awareness: who’s doing what, which PRs are
            stalled, which review threads sit untouched, and what needs <em>you</em>. It
            opens on the <strong>Activity</strong> console; the <strong>Timeline</strong>{' '}
            is a second lens. Runs locally off your <Code>gh</Code> login (or hosted, with
            GitHub sign-in).
          </p>

          <Section title="Add repos & scope with Workspaces">
            Every repo lives in exactly one <strong>Workspace</strong>, and a Workspace is the
            only scope there is: the <em>◈</em> selector top-left picks <em>one</em>, and that
            choice narrows the whole app — Activity, Insights and the Timeline — at once. There
            is no “all repos” and no “unassigned” bucket. <strong>Default</strong> is made for
            you: you can rename it, you can’t delete it, and new repos land there. Add repos,
            create Workspaces and move repos between them under{' '}
            <strong>Manage repos &amp; workspaces</strong> — assigning a repo elsewhere{' '}
            <em>moves</em> it, it is never in two places. Inside the selected Workspace, the
            repo show/hide dropdown narrows further without changing scope.
          </Section>

          <Section title="Activity console (the default)">
            The left rail is your state of play: <strong>Insights</strong>, a cross-repo{' '}
            <strong>Feed</strong>, <strong>Bots</strong>, <strong>Needs&nbsp;attention</strong>,
            then the Workspace’s repos as a flat list. The Feed is one chronological stream of
            real activity — opens, merges, reviews, comments, and pushes that addressed a thread —
            under the free flow-metric header (throughput, lead time, time-to-first-review, CI
            success &amp; recovery). Filter it with the pills: <strong>My Turn</strong> (things
            that concern you — you authored it, were asked to review, or already chimed in),{' '}
            <strong>Comments</strong> / <strong>PR events</strong> by category, and the
            <strong> Bots</strong> lens (all → hide → only). Click any card to open that PR;{' '}
            <strong>Back</strong> returns you to the exact card. To compare Workspaces, expand any
            metric row in Insights → <strong>Reports</strong> — the “By workspace” breakdown shows
            every Workspace side by side for that period.
          </Section>

          <Section title="Insights (Pro)">
            AI review-intelligence over the selected Workspace.{' '}
            <strong>Ask about the sprint</strong> answers a question from that Workspace&rsquo;s own
            sprint data — pick a quick-question pill (sprint report, retro, bottlenecks,
            biggest changes, …) or type your own, <Code>@</Code>-mention a contributor, and
            optionally attach a chart. PR mentions in an answer are clickable, and answers can
            be pinned. <strong>Track&nbsp;usage</strong> shows your month-to-date AI credits.
            The flow metrics and the attention cards are not here — they are free, and live on
            the Feed and the <strong>Needs&nbsp;attention</strong> rail entry.
          </Section>

          <Section title="Review-bot triage">
            Third-party review bots (CodeRabbit, Greptile, Copilot, …) are a triaged signal,
            not noise. A PR’s <strong>Bots</strong> chip filters its threads to that vendor;
            you can <strong>bulk-resolve</strong> the ones a later commit likely addressed —
            always a confirm-gated, one-click action that resolves the threads on GitHub, never
            automatic. The rail&rsquo;s <strong>Bots</strong> console shows per-vendor keep /
            tune / noisy verdicts (<strong>ROI</strong>), timing and coverage
            (<strong>Behaviour</strong>), and — under <strong>Settings</strong> — who counts as
            a review bot <em>in this Workspace</em>. A bot is <em>one row per Workspace</em>,
            merged by GitHub handle however many repos it runs in, and everything about it is
            edited there: whether it&rsquo;s automated, whether it&rsquo;s a{' '}
            <strong>quality&nbsp;check</strong> (SonarCloud, Codecov &amp; co, kept out of the
            ROI verdicts), its vendor name, and its <strong>price</strong>. All of those are
            per Workspace — setting a price in one leaves the others untouched, and prices are
            never added up across Workspaces. How we detect bots and how Limn attributes its own
            reviews stay account-wide, in <strong>Settings → Review bots</strong>.
          </Section>

          <Section title="PR detail & threads">
            Opening a PR shows <strong>Overview</strong> (checks, reviewers &amp; approvals,
            summary, comments), <strong>Threads</strong> (grouped by file, with code
            anchors), and <strong>Activity</strong>. Reply or resolve inline. On the Pro
            tier, each thread offers a <strong>Comment check</strong> — a critical,
            retained AI read of whether the comment holds up, with the thread and diff as
            context, so you can decide what to do.
          </Section>

          <Section title="Timeline">
            Rows are grouped <strong>repo → contributor</strong>; each PR is a bar, the
            markers are events. Scroll to pan, hold the zoom key to zoom. <strong>Show</strong>{' '}
            centres a PR on the shared board; <strong>Focus</strong> (or double-clicking a
            bar) opens the PR in its own isolated tab. The tab strip carries{' '}
            <strong>Activity</strong> and <strong>Timeline</strong> plus any PR tabs you open.
          </Section>

          <Section title="Claude Review (opt-in, local)">
            When enabled, a <strong>Claude Review</strong> tab runs an agentic review of a PR
            into structured findings. You author your own review and tick which findings to
            post — Limn posts one GitHub review. It costs real money per run, so it’s off
            by default and never runs in the hosted mode.
          </Section>

          <Section title="Keyboard">
            <Kbd>/</Kbd> focus search · <Kbd>j</Kbd>/<Kbd>k</Kbd> cycle PRs ·{' '}
            <Kbd>i</Kbd> Insights · <Kbd>Esc</Kbd> leave a tab/overlay, else clear the
            selection.
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
