import type { CommentAssessmentVerdict } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useCommentAssessment } from '../../hooks/useCommentAssessment.js';
import { Markdown } from '../Markdown.js';

// The RETAINED "does this comment hold up?" judgement for a thread's ORIGINATING review comment
// (Pro; reuses the prSummary capability). Critical-but-fair — the user decides what to do (and can
// reply inline via the composer below). Absent the capability → renders nothing.
//
// RENDER-ONLY. It used to carry its own "Assess validity" button, which meant a thread card had TWO
// AI buttons that spent money on overlapping things. The single "Check review" button in the card
// header now produces this judgement (as the `validity` annotation) along with the rewrite and the
// addressed verdict, in one call. `POST /api/pro/threads/:id/assess` therefore has no SPA caller
// left, but it stays registered: it writes the SAME row through the same writer with the same
// payload hash, so it is a supported alternate writer, not dead weight.

const VERDICT_META: Record<
  CommentAssessmentVerdict,
  { label: string; cls: string }
> = {
  valid: {
    label: 'Holds up',
    cls: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  },
  partly: {
    label: 'Partly valid',
    cls: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  },
  weak: {
    label: 'Shaky',
    cls: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
  },
  unclear: {
    label: 'Unclear',
    cls: 'border-gray-300 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300',
  },
};

export function ThreadAssessment({ threadId }: { threadId: number }): JSX.Element | null {
  const { prSummary } = useProCapabilities();
  const query = useCommentAssessment(threadId, prSummary);

  if (!prSummary) return null;

  const resp = query.data;
  const enabled = resp?.enabled ?? true;
  if (resp != null && !enabled) return null; // capability off server-side

  const assessment = resp?.assessment ?? null;
  const outOfCredits = resp?.creditsExhausted === true;
  const meta = assessment ? VERDICT_META[assessment.verdict] : null;

  return (
    <div className="mt-2 rounded-md border border-violet-200/70 bg-violet-50/40 px-2.5 py-2 dark:border-violet-900/50 dark:bg-violet-950/20">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-violet-700 dark:text-violet-300">
          <span aria-hidden="true">✨</span> Comment check
        </span>
        <span className="rounded bg-violet-500/10 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro
        </span>
        {meta != null && (
          <span
            className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}
          >
            {meta.label}
          </span>
        )}
      </div>

      {outOfCredits && !assessment && (
        <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          Out of AI credits this month — resumes on the 1st.
        </div>
      )}

      {assessment != null ? (
        <div className="prose-thread mt-1.5 text-[12px] text-gray-700 dark:text-gray-200">
          <Markdown>{assessment.assessment}</Markdown>
          <div className="mt-1 text-[10px] text-gray-400">
            Checked {new Date(assessment.generatedAt).toLocaleString()} · critical read, your call
          </div>
        </div>
      ) : (
        <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          Run <span className="font-semibold">Check review</span> above for a critical second
          opinion on this comment, with the thread and diff as context.
        </p>
      )}
    </div>
  );
}
