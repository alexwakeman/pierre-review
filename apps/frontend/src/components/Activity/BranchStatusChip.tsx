import type { CiStatus, RepoBranchStatus } from '@pierre-review/shared';
import { CI_META, relativeTime } from '../../lib/ui.js';

// CI_META is null for `unknown`, and this dot draws it as a hollow grey ring: visibly distinct
// from green/red, and it keeps the row's shape stable. Most PR surfaces SAY "no checks" for it
// rather than drawing nothing (the Pending card, the open-PR lists, the Overview Status row, the
// PR-detail header); only the Timeline bar and the Feed's opened-PR line leave it blank.
// `className` is ADDITIVE (the header adds an edge ring so green/yellow keep a visible edge on
// white). The span always carries a `title`, so a control wrapping the dot passes its OWN title
// here, or hovering the dot and hovering the control's words show two different tooltips.
export function CiDot({
  status,
  size = 6,
  title,
  className = '',
}: {
  status: CiStatus;
  size?: number;
  title?: string;
  className?: string;
}): JSX.Element {
  const meta = CI_META[status];
  const label = title ?? meta?.label ?? 'No CI reported';
  return (
    <span
      aria-hidden="true"
      title={label}
      className={`inline-block shrink-0 rounded-full ${className}`}
      style={
        meta
          ? { width: size, height: size, background: meta.color }
          : {
              width: size,
              height: size,
              border: '1px solid #9ca3af',
              background: 'transparent',
            }
      }
    />
  );
}

/**
 * The compact per-repo trunk readout: CI dot + branch name + how long since the last commit
 * landed on it. Sized for a rail row, so it is text-only (no borders, no button) and degrades
 * to nothing at all when the repo has never been branch-synced.
 *
 * Informational: it is never a link and never a control. Clicking the rail row still selects
 * the repo, exactly as before.
 */
export function BranchStatusChip({
  status,
  className = '',
}: {
  status: RepoBranchStatus | null | undefined;
  className?: string;
}): JSX.Element | null {
  // Nothing synced yet (a repo added a minute ago) → render nothing rather than a row of
  // em-dashes. The strip in the Feed is where "unknown" is worth stating explicitly.
  if (status == null || status.branchName == null) return null;
  const ciMeta = CI_META[status.ciStatus];
  return (
    <span
      className={`flex min-w-0 items-center gap-1 text-[10px] text-gray-400 ${className}`}
      title={`${status.branchName}: ${ciMeta?.label ?? 'no CI reported'}${
        status.lastCommitAt != null
          ? ` · last commit ${relativeTime(status.lastCommitAt)}`
          : ''
      }`}
    >
      <CiDot status={status.ciStatus} size={5} />
      <span className="min-w-0 truncate font-mono">{status.branchName}</span>
      {status.lastCommitAt != null && (
        <span className="shrink-0 tabular-nums">{relativeTime(status.lastCommitAt)}</span>
      )}
    </span>
  );
}
