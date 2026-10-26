import { useEffect, type ReactNode } from 'react';
import { Wordmark } from './Wordmark';
import { CloseIcon, WorkspaceIcon } from './Icons.js';
import { closeActivePopover } from '../lib/activePopover.js';
import { weightPhrase } from './settings/myTurnSettingsForm.js';
import { aiCredentialWords } from '@pierre-review/shared';
import { useAiProvider } from '../hooks/useAiCapabilities.js';

// Compact, scrollable help overlay opened from the header "?" button. A very brief
// tour of the core flows — tracking repos, the timeline, focus mode, navigation.
// Dismissed via the backdrop, the X, or Escape. The Escape handler runs in the
// capture phase and stops propagation so a stray dismiss doesn't also reach the
// global keyboard hook (which would exit focus / clear the selection).
export function HelpModal({ onClose }: { onClose: () => void }): JSX.Element {
  const provider = useAiProvider();
  // A board popover opened from the keyboard would otherwise stay open over this dialog, and take
  // its first Escape (lib/activePopover.ts).
  useEffect(() => {
    closeActivePopover();
  }, []);
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
            className="flex items-center self-stretch text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            <CloseIcon size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
          <p className="text-gray-500 dark:text-gray-400">
            A dashboard for GitHub pull-request activity across a Workspace of repos —
            built for sprint situational-awareness: who’s doing what, which PRs are
            stalled, which review threads sit untouched, and what needs <em>you</em>. It
            opens on <strong>Pending</strong>, in the <strong>Activity</strong> console; the{' '}
            <strong>Timeline</strong> is a second lens. Runs on your machine off your{' '}
            <Code>gh</Code> login.
          </p>

          <Section title="Add repos & scope with Workspaces">
            Every repo lives in exactly one <strong>Workspace</strong>, and a Workspace is the
            only scope there is: the <WorkspaceIcon className="inline-block align-[-0.1em]" />{' '}
            selector top-left picks <em>one</em>, and that
            choice narrows the whole app — Activity, Insights and the Timeline — at once. There
            is no “all repos” and no “unassigned” bucket. <strong>Default</strong> is made for
            you: you can rename it, you can’t delete it, and new repos land there. Add repos,
            create Workspaces and move repos between them under{' '}
            <strong>Manage repos &amp; workspaces</strong> — assigning a repo elsewhere{' '}
            <em>moves</em> it, it is never in two places. Inside the selected Workspace, the
            repo show/hide dropdown narrows further without changing scope.
          </Section>

          <Section title="Activity console (the default)">
            The left rail is your state of play: <strong>Pending</strong>, where the app opens,
            then a cross-repo <strong>Feed</strong>, <strong>Bots</strong> and{' '}
            <strong>Reports</strong>, then the Workspace’s repos as a flat list. The Feed is one
            chronological stream of real activity
            — opens, merges, reviews, comments, and pushes that addressed a thread. Filter it with
            the pills: <strong>My Turn</strong> (things that concern you — you authored it, were
            asked to review, or already chimed in), <strong>Comments</strong> /{' '}
            <strong>PR events</strong> by category, and the <strong>Bots</strong> lens (all → hide
            → only). Click any card to open that PR; <strong>Back</strong> returns you to the exact
            card. To compare Workspaces, expand any metric row in <strong>Reports</strong> — the
            “By workspace” breakdown shows every Workspace side by side for that period.
          </Section>

          <Section title="Review-bot triage">
            Third-party review bots (CodeRabbit, Greptile, Copilot, …) are a triaged signal,
            not noise. A PR’s <strong>Bots</strong> chip filters its threads to that vendor;
            you can <strong>bulk-resolve</strong> the ones a later commit likely addressed —
            always a confirm-gated, one-click action that resolves the threads on GitHub, never
            automatic. Who counts as a bot <em>in this Workspace</em> is set on{' '}
            <strong>Feed → Bot classification</strong>: it is exactly what the Feed and the
            Timeline hide by default. A bot is <em>one card per Workspace</em>, merged by GitHub
            handle however many repos it runs in: bot or person, its role (a{' '}
            <strong>quality&nbsp;check</strong> such as SonarCloud is kept out of the review-bot
            figures), its vendor name and its <strong>price</strong>. Prices are per Workspace
            and never added up across Workspaces. The <strong>Bots Monitoring</strong> console
            measures them: per-vendor keep / tune / rarely used verdicts, cost and
            severity inflation (<strong>ROI</strong>), what they keep flagging (
            <strong>Themes</strong>) and how your bots compare with the same vendor elsewhere (
            <strong>Benchmark</strong>).
          </Section>

          <Section title="Pending">
            Everything waiting on you or your Workspace, in one list: items on your plate, red
            builds you are on the hook for, stalled reviews, untouched threads, un-assigned PRs,
            PRs that are simply ready to land, and dependency updates and security alerts — in six
            tabs, each showing how many it holds. Every tab lists its cards by a score that weighs{' '}
            {weightPhrase('proximity')}, {weightPhrase('stall')} and {weightPhrase('relevance')} (My
            turn groups by type in the order you set, and Dependencies lists security items first);
            the top five are{' '}
            <strong>Do next</strong>. <strong>Settings → My Turn</strong> chooses what counts as
            your turn and how the three are weighed. The{' '}
            <strong>i</strong> beside the title, and on every card, explains the order.{' '}
            <strong>Plan my day</strong> adds a sentence per item saying why it is worth doing now.
          </Section>

          <Section title="Reports">
            <strong>Flow metrics</strong> for the selected Workspace — throughput, lead time,
            time-to-first-review, CI success &amp; recovery — sit at the top of this pane, with
            the period-over-period report below them. The attention cards are not here — they live
            on <strong>Pending</strong>.
          </Section>

          <Section title="PR detail & threads">
            Opening a PR shows <strong>Overview</strong> (checks, reviewers &amp; approvals,
            summary, comments), <strong>Threads</strong> (grouped by file, with code
            anchors), and <strong>Activity</strong>. Reply or resolve inline.
          </Section>

          <Section title="Timeline">
            Rows are grouped <strong>repo → contributor</strong>; each PR is a bar, the
            markers are events. Scroll to pan, hold the zoom key to zoom. <strong>Show</strong>{' '}
            centres a PR on the shared board; <strong>Focus</strong> (or double-clicking a
            bar) opens the PR in its own isolated tab. The tab strip carries{' '}
            <strong>Activity</strong> and <strong>Timeline</strong> plus any PR tabs you open.
          </Section>

          <Section title="AI Review and AI Fix (on your machine)">
            The <strong>AI Review</strong> tab reviews a PR into findings; you pick which to
            post as one GitHub review. <strong>AI Fix</strong> edits the branch for you to push.
            Both run on {aiCredentialWords(provider)} — Limn stores no key and charges
            nothing. The reviewer reads code; it cannot edit files, run commands or reach the web.
            The fixer edits files but has no shell, and builds and tests nothing. Nothing is posted
            or pushed until you press the button.
          </Section>

          <Section title="Bot comment scoring (on your machine)">
            A small model labels each comment a review bot leaves, from <strong>nit</strong> to{' '}
            <strong>critical</strong>, so you can see which ones matter. With{' '}
            <Code>npx limn-review</Code>, turn it on once: <strong>Settings → Bot comment
            scoring → Set up</strong> (<strong>Set up AI</strong> does it too), or run{' '}
            <Code>npx limn-review ml install</Code>. That downloads about 240 MB into{' '}
            <Code>~/.limn</Code>. It scores on this machine and sends nothing anywhere. It runs in
            the background at low priority, using at most half of one CPU core, and pauses on
            battery, so a large backlog of old comments takes a while. To score faster, start Limn
            with <Code>LIMN_ML_CPU_SHARE=1</Code>; to keep scoring on battery,{' '}
            <Code>LIMN_ML_ON_BATTERY=run</Code>; to turn it off, <Code>LIMN_ML_DISABLED=true</Code>.
            Check it with <Code>npx limn-review ml status</Code>.
          </Section>

          <Section title="Keyboard">
            <Kbd>/</Kbd> focus search · <Kbd>j</Kbd>/<Kbd>k</Kbd> cycle PRs ·{' '}
            <Kbd>i</Kbd> Activity console · <Kbd>Esc</Kbd> leave a tab/overlay, else clear the
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
