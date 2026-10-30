import {
  AI_FIX_REVIEW_ITEM_LABELS,
  aiRunProviderName,
  type AiFix,
  type AiFixReviewItem,
  type PrDetail,
} from '@pierre-review/shared';
import { useFilters } from '../../store/filters.js';
import { InfoButton } from '../InfoModal.js';
import { CHANGE_REPORT_CHIP, CHANGE_REPORT_HEADING, ChangeReportSections } from './ChangeReport.js';

// THE FINISHED FIX, EXPLAINED: per changed file, what changed and why and which review items it
// answers; then the items the agent left alone and why. Everything here is the agent's SELF-REPORT,
// validated server-side (refs it was not shown are dropped, a file the diff does not contain is
// dropped) — the diff below it is the authoritative changeset.

const CHIP = CHANGE_REPORT_CHIP;
const HEADING = CHANGE_REPORT_HEADING;

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
        aria-label={`${label}: ${item?.title ?? ''}. Show in AI Review`}
        className={`${CHIP} max-w-[22rem] hover:bg-ui-hover`}
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
      // No source review ⇒ the CI-only seed ("Fix with AI" beside a finished CI check).
      const from = fix.sourceReviewId == null ? 'the CI check' : 'the AI review';
      return `Fix from ${from}${n > 0 ? ` (${n} item${n === 1 ? '' : 's'})` : ''}.`;
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
  // The provider that ran THIS fix (its stored model).
  const by = aiRunProviderName(fix);
  const jump = useJumpToFinding(pr);
  const report = fix.changeReport;
  const items = new Map((fix.reviewItems ?? []).map((i) => [i.ref, i]));
  const leftOut = (fix.reviewItems ?? []).filter((i) => !i.included);
  if (!report && leftOut.length === 0) return null;

  const hasRefs = items.size > 0;

  return (
    <div className="mt-2 text-meta">
      <ChangeReportSections
        report={report}
        filesChanged={fix.filesChanged}
        by={by}
        refsInfo={
          hasRefs ? (
            <p>
              Each tag is a review item the change answers. A finding tag opens it in the AI
              Review tab.
            </p>
          ) : null
        }
        renderRef={(r) => <RefChip key={r} refId={r} item={items.get(r)} onJump={jump} />}
      />

      {leftOut.length > 0 && (
        <section>
          <div className={HEADING}>
            Left out
            <InfoButton title="Left out">
              <p>These review items did not fit in what {by} was sent, so it never saw them.</p>
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
