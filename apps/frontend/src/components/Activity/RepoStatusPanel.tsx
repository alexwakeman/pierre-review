import { useMemo } from 'react';
import { isRepoDocsUnreadableShown, repoDocsUnreadableLine, repoStatusSummary, type ActivityRepo, type RepoStatusLine } from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useBranchStatus } from '../../hooks/useBranchStatus.js';
import { useMarkRepoSeen } from '../../hooks/useMarkRepoSeen.js';
import { InfoButton } from '../InfoModal.js';
import { RepoStatusDot } from '../RepoStatusDot.js';
import { Button } from '../ui/Button.js';

// THE REPO STATUS PANEL — the top of a repo's Activity tab, under the sub-tab strip
// (docs/FRONTEND.md § The repo status panel).
//
// It spells out the sidebar row's two dots, one line per fact, each led by the SAME dot
// (`RepoStatusDot`) and built by the SAME fold (shared `repoStatusSummary`), so opening a repo
// explains its dots. Red lines say what needs someone to act; the blue line says what is new on
// pull requests you have opened before, since you last opened them. The lines are PLAIN FACTS — no
// PR links, no "show the branch": everything a line names is further down the same page.
//
// ⚠ NOTHING HERE FETCHES. It reads the `/api/activity` repo entry its caller already holds and the
// whole-workspace `/api/branch-status` key the sidebar keeps live. "Mark all seen" is a click.
//
// One more line, with NO dot (it is neither red nor blue): when Limn could not read the repository's
// files for the docs offers (`repo.docsUnreadable`, the STORED failure; docs/REFERENCE-DOCS.md § A
// repository whose files can't be read), it says so and why — for a LASTING reason only (shared
// `isRepoDocsUnreadableShown`; a transient 'unavailable' is never shown). Shown only where AI runs — the offers
// exist only there.
//
// ⚠ OPENING THE REPO VIEW DOES NOT CLEAR THE BLUE. The seen stamp is per PR (`pr_views`): opening
// a PR clears that PR's share; "Mark all seen" clears the repo's. Clearing on view would wipe the
// very list the reader came here to read.

export function RepoStatusPanel({ repo }: { repo: ActivityRepo }): JSX.Element {
  const { data: branchData } = useBranchStatus();
  const branch = useMemo(
    () => (branchData?.repos ?? []).find((b) => b.repoId === repo.repoId) ?? null,
    [branchData, repo.repoId],
  );
  const summary = useMemo(() => repoStatusSummary(repo, branch), [repo, branch]);
  const markSeen = useMarkRepoSeen(repo.repoId);
  const ai = useAiCapabilities();
  // Only a LASTING reason is shown; a transient 'unavailable' still backs off, silently.
  const docsUnreadable = ai.enabled && isRepoDocsUnreadableShown(repo.docsUnreadable) ? repo.docsUnreadable : null;

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
            <StatusLine key={line.kind} line={line} />
          ))}
        </ul>
      )}
      {docsUnreadable != null && (
        <p className="mt-1.5 text-body text-ui-mute" data-testid="repo-status-docs-unreadable" data-reason={docsUnreadable}>
          {repoDocsUnreadableLine(docsUnreadable)}
        </p>
      )}
      {markSeen.isError && (
        <p className="mt-1.5 text-meta text-ui-danger" role="alert">
          Could not mark these seen. Try again.
        </p>
      )}
    </section>
  );
}

function StatusLine({ line }: { line: RepoStatusLine }): JSX.Element {
  return (
    <li className="flex items-start gap-2" data-testid="repo-status-line" data-kind={line.kind} data-tone={line.tone}>
      {/* The dot sits on the first line's centre (text-body is 13px on a 20px line). */}
      <span className="flex h-5 w-2 shrink-0 items-center justify-center">
        <RepoStatusDot tone={line.tone} />
      </span>
      <p className="min-w-0 flex-1 text-body text-ui-ink">{line.text}</p>
    </li>
  );
}
