// THE TICKETS' OPEN POINTS IN THE AI REVIEW TAB (docs/CLAUDE-REVIEW.md § Open points): what the
// ticket left undecided (a decision, content or a design), each with the code in this PR that depends
// on it, so the developer can chase it. NOT findings: they never move the verdict or the counts, and
// the section says so. Absent when the run was given none. Text is PLAIN TEXT — the ticket's words.
import type { ClaudeFindingSide, ClaudeReviewOpenPoints } from '@pierre-review/shared';
import { REVIEW_CHIP, REVIEW_META } from '../lib/reviewStyles.js';
import { InfoButton } from './InfoModal.js';
import { ReviewSection, SectionCount } from './ReviewSection.js';

type OpenInChanges = (path: string, line: number | null, side: ClaudeFindingSide) => void;

const shortDate = (iso: string | null): string | null => {
  if (iso == null) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export function ClaudeReviewOpenPointsSection({
  openPoints,
  changedPaths,
  onOpenInChanges,
}: {
  openPoints: ClaudeReviewOpenPoints | null | undefined;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element | null {
  if (openPoints == null || openPoints.points.length === 0) return null;
  const n = openPoints.points.length;
  const readAt = shortDate(openPoints.readAt);
  return (
    <ReviewSection
      title="Open points"
      section="open"
      pills={
        <>
          <SectionCount>{n}</SectionCount>
          <span className={`${REVIEW_CHIP} bg-ui-raise text-ui-ink`}>Not blocking</span>
        </>
      }
      info={
        <InfoButton title="Open points">
          <p>
            Points the ticket left undecided when it was written: a decision, some content or a design still to be
            confirmed. Under each is the code in this pull request that depends on it, so it can be chased.
          </p>
          <p>They do not change the verdict or the counts. A posted review lists them too, marked as not blocking.</p>
          <p>
            Limn reads the ticket again before each review. They come from the issue type&rsquo;s open points field
            (Settings → Integrations), else from an &ldquo;Open points&rdquo; section of the description.
          </p>
        </InfoButton>
      }
    >
      {!openPoints.fresh && (
        <p className={`${REVIEW_META} mb-2`}>
          The ticket could not be read again, so these are from Limn&rsquo;s stored copy{readAt ? ` (${readAt})` : ''}.
        </p>
      )}
      <ul className="space-y-1.5">
        {openPoints.points.map((p) => (
          <li key={p.ref} className="rounded-ui border border-ui-line px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={REVIEW_META}>{p.ticketKey}</span>
              <span className="min-w-0 break-words text-body text-ui-ink">{p.text}</span>
            </div>
            {p.code.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {p.code.map((c, i) => {
                  const where = `${c.path}${c.line != null ? `:${c.line}` : ''}`;
                  const canJump = onOpenInChanges != null && changedPaths.has(c.path);
                  return (
                    <li key={`${c.path}:${c.line ?? ''}:${i}`} className="text-meta text-ui-ink">
                      {canJump ? (
                        <button
                          type="button"
                          className="hit break-all font-mono text-meta text-ui-ink hover:underline"
                          onClick={() => onOpenInChanges(c.path, c.line, 'RIGHT')}
                        >
                          {where}
                        </button>
                      ) : (
                        <span className="break-all font-mono">{where}</span>
                      )}{' '}
                      <span className="break-words">{c.note}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={`${REVIEW_META} mt-1`}>No code in this PR depends on it.</p>
            )}
          </li>
        ))}
      </ul>
    </ReviewSection>
  );
}
