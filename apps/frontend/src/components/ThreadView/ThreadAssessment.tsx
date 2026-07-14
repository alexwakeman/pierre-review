import type { CommentAssessmentVerdict } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useCommentAssessment, useAssessComment } from '../../hooks/useCommentAssessment.js';
import { Markdown } from '../Markdown.js';

// Inline "assess this comment's validity" affordance (Pro; reuses the prSummary capability).
// One cheap Haiku call judges whether the thread's ORIGINATING review comment holds up, given
// the thread + diff. The verdict + rationale are RETAINED (loaded on mount, kept after switching
// tabs) so it reads as a durable second opinion. Critical-but-fair — the user decides what to do
// (and can reply inline via the composer below). Absent the capability → renders nothing.

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
  const assess = useAssessComment(threadId);

  if (!prSummary) return null;

  const resp = query.data;
  const enabled = resp?.enabled ?? true;
  if (resp != null && !enabled) return null; // capability off server-side

  const assessment = assess.data?.assessment ?? resp?.assessment ?? null;
  const busy = assess.isPending;
  const outOfCredits = (assess.data?.creditsExhausted ?? resp?.creditsExhausted) === true;
  const noAuth = assess.data?.noAuth === true;
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
        <button
          type="button"
          onClick={() => assess.mutate()}
          disabled={busy || outOfCredits}
          className="ml-auto flex shrink-0 items-center gap-0.5 rounded border border-violet-300 px-1.5 py-0.5 text-[11px] font-medium text-violet-600 hover:border-violet-400 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600"
          title={
            outOfCredits
              ? 'Out of AI credits — resets next month'
              : assessment
                ? 'Re-check this comment (runs the Haiku model)'
                : 'Assess this comment’s validity with context (runs the Haiku model)'
          }
        >
          {busy ? (
            'Assessing…'
          ) : (
            <>
              <span aria-hidden="true">{assessment ? '↻' : '✦'}</span>
              {assessment ? ' Re-check' : ' Assess validity'}
            </>
          )}
        </button>
      </div>

      {noAuth && (
        <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          No Claude credential available to run the check.
        </div>
      )}
      {outOfCredits && !assessment && (
        <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          Out of AI credits this month — resumes on the 1st.
        </div>
      )}
      {assess.isError && (
        <div className="mt-1.5 text-[11px] text-red-500">
          {(assess.error as Error)?.message ?? 'Couldn’t assess the comment.'}
        </div>
      )}

      {busy ? (
        <div className="mt-1.5 space-y-1" aria-hidden="true">
          <div className="digest-skeleton-line h-3" style={{ width: '90%' }} />
          <div className="digest-skeleton-line h-3" style={{ width: '78%' }} />
        </div>
      ) : assessment != null ? (
        <div className="prose-thread mt-1.5 text-[12px] text-gray-700 dark:text-gray-200">
          <Markdown>{assessment.assessment}</Markdown>
          <div className="mt-1 text-[10px] text-gray-400">
            Checked {new Date(assessment.generatedAt).toLocaleString()} · critical read, your call
          </div>
        </div>
      ) : (
        <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          Get a critical second opinion on this comment, with the thread and diff as context.
        </p>
      )}
    </div>
  );
}
