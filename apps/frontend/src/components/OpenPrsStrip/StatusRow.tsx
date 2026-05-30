import type { TimelinePr } from '@gh-team-monitor/shared';
import { CI_META, mergeWarning } from '../../lib/ui.js';

function newSummary(n: TimelinePr['newSinceLastViewed']): string | null {
  if (!n) return null;
  const total = n.commits + n.comments + n.reviews;
  return total > 0 ? `${total} new` : null;
}

// CI dot · mergeable warning · incremental-review badge · thread-count chips.
export function StatusRow({ pr }: { pr: TimelinePr }): JSX.Element {
  const ci = CI_META[pr.ciStatus];
  const warn = mergeWarning(pr.mergeable, pr.mergeStateStatus);
  const fresh = newSummary(pr.newSinceLastViewed);
  const tc = pr.threadCounts;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
      {ci && (
        <span className="inline-flex items-center gap-1" title={ci.label}>
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: ci.color }}
          />
          <span className="text-gray-500">{ci.label}</span>
        </span>
      )}
      {warn && (
        <span className="inline-flex items-center gap-0.5 text-orange-500" title={`Merge state: ${warn}`}>
          ⚠ {warn}
        </span>
      )}
      {fresh && (
        <span className="inline-flex items-center gap-0.5 font-medium text-sky-500" title="New since you last looked">
          👁 {fresh}
        </span>
      )}
      {tc.untouched > 0 && (
        <span className="text-red-500" title="Untouched threads">🔴 {tc.untouched}</span>
      )}
      {tc.replied_unresolved > 0 && (
        <span className="text-amber-500" title="Replied, unresolved">🟡 {tc.replied_unresolved}</span>
      )}
      {tc.likely_addressed > 0 && (
        <span className="text-blue-500" title="Likely addressed">🔵 {tc.likely_addressed}</span>
      )}
      {tc.resolved > 0 && (
        <span className="text-green-600" title="Resolved">✓ {tc.resolved}</span>
      )}
    </div>
  );
}
