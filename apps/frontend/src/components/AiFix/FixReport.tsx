import {
  AI_FIX_REVIEW_ITEM_LABELS,
  type AiFix,
  type AiFixReviewItem,
  type PrDetail,
} from '@pierre-review/shared';
import { useFilters } from '../../store/filters.js';
import { InfoButton } from '../InfoModal.js';

// THE FINISHED FIX, EXPLAINED: per changed file, what changed and why and which review items it
// answers; then the items the agent left alone and why. Everything here is the agent's SELF-REPORT,
// validated server-side (refs it was not shown are dropped, a file the diff does not contain is
// dropped) — the diff below it is the authoritative changeset.

const CHIP =
  'inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-gray-500/10 text-gray-700 dark:text-gray-200';
const HEADING =
  'mb-1 mt-3 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';

/** Where a chip can jump: a finding of a review shows in the Claude Review tab with a DOM anchor. */
function findingAnchor(item: AiFixReviewItem): string | null {
  return item.kind === 'finding' && item.findingId != null ? `claude-finding-${item.findingId}` : null;
}

// Open the Claude Review tab, then scroll to the finding once it has rendered. The tab mounts
// lazily and loads its review, so the element may take a moment to exist; give up quietly after
// ~3s (an older review's finding is not on screen at all — the tab still opens).
function useJumpToFinding(pr: PrDetail): (anchorId: string) => void {
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  return (anchorId) => {
    openClaudeReview({
      id: pr.id,
      number: pr.number,
      title: pr.title,
      repoFullName: pr.repoFullName,
      authorLogin: null,
      authorDisplayName: null,
      authorAvatarUrl: null,
    });
    const until = Date.now() + 3000;
    const tick = (): void => {
      const el = document.getElementById(anchorId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (Date.now() < until) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
}

function RefChip({
  refId,
  item,
  onJump,
}: {
  refId: string;
  item: AiFixReviewItem | undefined;
  onJump: (anchorId: string) => void;
}): JSX.Element {
  const label = item ? `${AI_FIX_REVIEW_ITEM_LABELS[item.kind]} ${refId}` : refId;
  const body = (
    <>
      <span className="shrink-0">{label}</span>
      {item && <span className="min-w-0 truncate font-normal">· {item.title}</span>}
    </>
  );
  const anchor = item ? findingAnchor(item) : null;
  if (anchor) {
    return (
      <button
        type="button"
        onClick={() => onJump(anchor)}
        aria-label={`${label}: ${item?.title ?? ''}. Show in Claude Review`}
        className={`${CHIP} max-w-[22rem] hover:bg-gray-500/20`}
      >
        {body}
      </button>
    );
  }
  return <span className={`${CHIP} max-w-[22rem]`}>{body}</span>;
}

/** What started this run, in one line. Rows from removed seeds read as history. */
export function fixSourceLine(fix: AiFix): string {
  // An auto-started fix wears the "Auto fix" chip beside this line (AiFixTab.tsx), so the line
  // does not say it twice.
  switch (fix.seed) {
    case 'review': {
      const n = fix.reviewItems?.length ?? 0;
      return `Fix from the Claude review${n > 0 ? ` (${n} item${n === 1 ? '' : 's'})` : ''}.`;
    }
    case 'plain':
      return 'Fix from your instruction.';
    case 'comments':
      return 'Fix from picked comments (no longer offered).';
    case 'ci_analysis':
      return 'Fix from the CI analysis (no longer offered).';
    default:
      return '';
  }
}

export function FixReport({ pr, fix }: { pr: PrDetail; fix: AiFix }): JSX.Element | null {
  const jump = useJumpToFinding(pr);
  const report = fix.changeReport;
  const items = new Map((fix.reviewItems ?? []).map((i) => [i.ref, i]));
  const leftOut = (fix.reviewItems ?? []).filter((i) => !i.included);
  if (!report && leftOut.length === 0) return null;

  const described = new Set(report?.changes.map((c) => c.path) ?? []);
  const undescribed = fix.filesChanged.filter((f) => !described.has(f));
  const hasRefs = items.size > 0;

  return (
    <div className="mt-2 text-xs">
      {report && (report.changes.length > 0 || undescribed.length > 0) && (
        <section>
          <div className={HEADING}>
            Changes
            <InfoButton title="Changes">
              <p>What Claude says it changed in each file, and why.</p>
              {hasRefs && (
                <p>
                  Each tag is a review item the change answers. A finding tag opens it in the Claude
                  Review tab.
                </p>
              )}
              <p>The diff below is what actually changed.</p>
            </InfoButton>
          </div>
          <ul className="space-y-2">
            {report.changes.map((c) => (
              <li key={c.path}>
                <div className="break-all font-mono text-gray-800 dark:text-gray-100">{c.path}</div>
                {c.summary && <p className="mt-0.5 text-gray-700 dark:text-gray-300">{c.summary}</p>}
                {c.refs.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.refs.map((r) => (
                      <RefChip key={r} refId={r} item={items.get(r)} onJump={jump} />
                    ))}
                  </div>
                )}
              </li>
            ))}
            {undescribed.map((p) => (
              <li key={p}>
                <div className="break-all font-mono text-gray-800 dark:text-gray-100">{p}</div>
                <p className="mt-0.5 text-gray-500 dark:text-gray-400">No summary reported.</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report && report.unaddressed.length > 0 && (
        <section>
          <div className={HEADING}>Not addressed</div>
          <ul className="space-y-1.5">
            {report.unaddressed.map((u) => (
              <li key={u.ref}>
                <RefChip refId={u.ref} item={items.get(u.ref)} onJump={jump} />
                <p className="mt-0.5 text-gray-700 dark:text-gray-300">{u.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report && report.notReported.length > 0 && (
        <section>
          <div className={HEADING}>No report</div>
          <div className="flex flex-wrap gap-1">
            {report.notReported.map((r) => (
              <RefChip key={r} refId={r} item={items.get(r)} onJump={jump} />
            ))}
          </div>
        </section>
      )}

      {leftOut.length > 0 && (
        <section>
          <div className={HEADING}>
            Left out
            <InfoButton title="Left out">
              <p>These review items did not fit in what Claude was sent, so it never saw them.</p>
            </InfoButton>
          </div>
          <div className="flex flex-wrap gap-1">
            {leftOut.map((i) => (
              <RefChip key={i.ref} refId={i.ref} item={i} onJump={jump} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
