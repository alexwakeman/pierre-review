import { useMemo, useState } from 'react';
import { repoStatusSummary, type ActivityRepo, type RepoStatusLine, type RepoStatusPr } from '@pierre-review/shared';
import { useBranchStatus } from '../../hooks/useBranchStatus.js';
import { useMarkRepoSeen } from '../../hooks/useMarkRepoSeen.js';
import { relativeTime } from '../../lib/ui.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { InfoButton } from '../InfoModal.js';
import { RepoStatusDot } from '../RepoStatusDot.js';
import { Button } from '../ui/Button.js';
import { cx, FOCUS_RING, TEXT_LINK_PHONE } from '../ui/cx.js';

// THE REPO STATUS PANEL — the top of a repo's view (docs/FRONTEND.md § The repo status panel).
//
// It spells out the sidebar row's two dots, one line per fact, each led by the SAME dot
// (`RepoStatusDot`) and built by the SAME fold (shared `repoStatusSummary`), so opening a repo
// explains its dots. Red lines say what needs someone to act; the blue line says what is new on
// pull requests you have opened before, since you last opened them. Each line links to where you act.
//
// ⚠ NOTHING HERE FETCHES. It reads the `/api/activity` repo entry its caller already holds and the
// whole-workspace `/api/branch-status` key the sidebar keeps live. "Mark all seen" is a click.
//
// ⚠ OPENING THE REPO VIEW DOES NOT CLEAR THE BLUE. The seen stamp is per PR (`pr_views`): opening
// a PR clears that PR's share; "Mark all seen" clears the repo's. Clearing on view would wipe the
// very list the reader came here to read.

/** PR links shown on a line before "N more". */
const PRS_SHOWN = 3;

export function RepoStatusPanel({ repo }: { repo: ActivityRepo }): JSX.Element {
  const { data: branchData } = useBranchStatus();
  const branch = useMemo(
    () => (branchData?.repos ?? []).find((b) => b.repoId === repo.repoId) ?? null,
    [branchData, repo.repoId],
  );
  const summary = useMemo(() => repoStatusSummary(repo, branch), [repo, branch]);
  const markSeen = useMarkRepoSeen(repo.repoId);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const setRepoConsoleTab = useFilters((s) => s.setRepoConsoleTab);

  const openPr = (p: RepoStatusPr): void => {
    openPrDetailTab(
      {
        id: p.prId,
        number: p.number,
        title: p.title,
        repoFullName: repo.repoFullName,
        authorLogin: null,
        authorDisplayName: null,
        authorAvatarUrl: null,
      },
      { fromActivity: true },
    );
  };
  // The default branch's CI and what landed on it live in the header below (BranchStatusPanel) —
  // on the Activity tab, so come back to it first.
  const showBranch = (): void => {
    setRepoConsoleTab(repo.repoId, 'activity');
    window.requestAnimationFrame(() => {
      document
        .querySelector('[data-testid="repo-console"] [data-testid="branch-status-panel"]')
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  };

  return (
    <section
      aria-label="Repository status"
      data-testid="repo-status-panel"
      data-attention={summary.attention ? 'true' : undefined}
      data-new={summary.hasNew ? 'true' : undefined}
      className="rounded-ui border border-ui-line p-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-body font-medium text-ui-ink">Status</h2>
        <InfoButton title="What the dots mean">
          <p>The same dots mark this repo in the sidebar. Each line here is one reason for them.</p>
          <ul className="space-y-1">
            <li className="flex items-baseline gap-2">
              <RepoStatusDot tone="attention" className="relative -top-px" />
              <span>
                <strong className="font-medium">Red: needs attention.</strong> A pull request is waiting for your
                review, the default branch is failing CI, or a pull request is failing CI or has merge conflicts.
                Drafts are not counted for CI or conflicts.
              </span>
            </li>
            <li className="flex items-baseline gap-2">
              <RepoStatusDot tone="new" className="relative -top-px" />
              <span>
                <strong className="font-medium">Blue: new to you.</strong> Comments, reviews and commits by someone
                else on pull requests you have opened before, since you last opened each one. Your own are not
                counted.
              </span>
            </li>
          </ul>
          <p>
            Blue clears for a pull request when you open it, or for the whole repo with Mark all seen. Opening this
            page does not clear it. Everything here comes from synced GitHub data.
          </p>
        </InfoButton>
        {summary.hasNew && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            busy={markSeen.isPending}
            busyLabel="Marking…"
            onClick={() => markSeen.mutate()}
            data-testid="repo-status-mark-seen"
          >
            Mark all seen
          </Button>
        )}
      </div>
      {summary.lines.length === 0 ? (
        <p className="mt-1.5 text-body text-ui-mute" data-testid="repo-status-calm">
          Nothing needs attention here, and nothing is new since you last looked.
        </p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {summary.lines.map((line) => (
            <StatusLine
              key={line.kind}
              line={line}
              onOpenPr={openPr}
              onShowBranch={line.kind === 'trunk_failing' ? showBranch : undefined}
            />
          ))}
        </ul>
      )}
      {markSeen.isError && (
        <p className="mt-1.5 text-meta text-ui-danger" role="alert">
          Could not mark these seen. Try again.
        </p>
      )}
    </section>
  );
}

function StatusLine({
  line,
  onOpenPr,
  onShowBranch,
}: {
  line: RepoStatusLine;
  onOpenPr: (p: RepoStatusPr) => void;
  onShowBranch?: () => void;
}): JSX.Element {
  const [all, setAll] = useState(false);
  const shown = all ? line.prs : line.prs.slice(0, PRS_SHOWN);
  const hidden = line.prs.length - shown.length;
  // PR refs and "Show the branch" are links (underlined on a phone, docs/FRONTEND.md § Text links);
  // "N more" is a disclosure toggle, so it is not.
  const linkClass = cx('rounded-ui text-left text-ui-accent hover:underline', TEXT_LINK_PHONE, FOCUS_RING);
  const toggleClass = cx('rounded-ui text-left text-ui-accent hover:underline', FOCUS_RING);
  return (
    <li className="flex items-start gap-2" data-testid="repo-status-line" data-kind={line.kind} data-tone={line.tone}>
      {/* The dot sits on the first line's centre (text-body is 13px on a 20px line). */}
      <span className="flex h-5 w-2 shrink-0 items-center justify-center">
        <RepoStatusDot tone={line.tone} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-body text-ui-ink">
          {line.text}
          {onShowBranch != null && (
            <>
              {' '}
              <button type="button" onClick={onShowBranch} className={linkClass}>
                Show the branch
              </button>
            </>
          )}
        </p>
        {line.prs.length > 0 &&
          (line.tone === 'new' ? (
            // One PR per row: what is new on it, and when you last opened it.
            <ul className="mt-0.5 space-y-0.5">
              {shown.map((p) => (
                <li key={p.prId} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-meta text-ui-mute">
                  <button type="button" onClick={() => onOpenPr(p)} className={cx(linkClass, 'min-w-0 max-w-full truncate')} title={`Open #${p.number} ${p.title}`}>
                    #{p.number} {p.title}
                  </button>
                  <span className="min-w-0">
                    {p.detail}
                    {p.since != null && ` · you last opened it ${relativeTime(p.since)}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-meta">
              {shown.map((p) => (
                <button
                  key={p.prId}
                  type="button"
                  onClick={() => onOpenPr(p)}
                  className={cx(linkClass, 'min-w-0 max-w-full truncate sm:max-w-[18rem]')}
                  title={`Open #${p.number} ${p.title}`}
                >
                  #{p.number} {p.title}
                </button>
              ))}
            </p>
          ))}
        {hidden > 0 && (
          <button type="button" onClick={() => setAll(true)} className={cx(toggleClass, 'mt-0.5 text-meta')}>
            {hidden} more
          </button>
        )}
      </div>
    </li>
  );
}
