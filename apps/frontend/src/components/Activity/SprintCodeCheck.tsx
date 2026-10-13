import {
  SPRINT_CRITERION_STATUS_LABEL,
  type SprintAssessmentBody,
  type SprintCodeRef,
  type SprintCriterionStatus,
} from '@pierre-review/shared';
import { sprintCodeCheckMarkdown } from '../../lib/copy.js';
import { relativeTime } from '../../lib/ui.js';
import { SparkleIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { AssessInfo, type SprintAssessTicket } from './SprintAssessment.js';
import { SprintCopyButton } from './SprintCopyButton.js';

// THE CODE CHECK (Reports → This sprint, a ticket's drawer): what "Check against code" said. STAGE-AWARE
// like the run (format 6):
//   • PLAN (the ticket is not built yet): the summary, then the few high-level changes it needs —
//     repo, the existing file or folder it touches (or a proposed new file), one sentence each.
//   • VERIFY (in review / done): the summary, then each criterion with a Met / Partly met / Not met /
//     Unclear pill, the evidence, the file that shows it and a covering test (or "No test found"),
//     then the coverage line.
// File paths are code. A stale run is shown, tagged "Out of date"; an older-format run shows one line
// asking for a new check. The ⓘ explains the two modes (shared with the button row).

const MUTED = 'text-gray-500 dark:text-gray-400';

const STATUS_PILL: Record<SprintCriterionStatus, string> = {
  met: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  partly: 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
  not_met: 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
  unclear: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100',
};

/** The small "Claude" mark beside model-written text. */
export function ClaudeMark(): JSX.Element {
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 align-middle text-[11px] text-ai-ink">
      <SparkleIcon size={10} className="text-ai-signal" />
      Claude
    </span>
  );
}

export function SprintCodeCheck({ ticket: t }: { ticket: SprintAssessTicket }): JSX.Element | null {
  const record = t.assessment?.record ?? null;
  if (record?.outdated === true) {
    return (
      <p className={`text-xs ${MUTED}`} data-testid="sprint-code-check">
        The last code check is in an older format. Check against code again.
      </p>
    );
  }
  const body = record != null && record.status === 'succeeded' && !record.outdated ? record.body : null;
  if (body == null || record == null) return null;
  const stale = t.assessment?.currency === 'stale';
  const multiRepo = new Set([...body.plan.map((p) => p.repo), ...record.repos.map((r) => r.fullName)]).size > 1;

  return (
    <section className="space-y-2 rounded-md border border-ai-border bg-ai-surface-2/40 p-3" data-testid="sprint-code-check">
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="text-xs font-semibold text-gray-800 dark:text-gray-100">
          {body.mode === 'plan' ? 'Code check · what it needs' : 'Code check · against the criteria'}
        </h5>
        <ClaudeMark />
        {record.completedAt != null && <span className={`text-[11px] ${MUTED}`}>{relativeTime(record.completedAt)}</span>}
        {stale && (
          <span className="rounded bg-gray-100 px-1 text-[11px] text-gray-700 dark:bg-gray-800 dark:text-gray-200">Out of date</span>
        )}
        <InfoButton title="Code check">
          <AssessInfo record={record} />
        </InfoButton>
        <SprintCopyButton markdown={sprintCodeCheckMarkdown(body, t.criteria)} what="the code check" className="ml-auto" />
      </div>
      {body.summary.trim() !== '' && <p className="text-sm text-gray-800 dark:text-gray-100">{body.summary}</p>}
      {body.mode === 'plan' ? <PlanList body={body} multiRepo={multiRepo} /> : <CriteriaChecks body={body} criteria={t.criteria} />}
    </section>
  );
}

function PlanList({ body, multiRepo }: { body: SprintAssessmentBody; multiRepo: boolean }): JSX.Element | null {
  if (body.plan.length === 0) return null;
  return (
    <ol className="list-decimal space-y-1.5 pl-5 text-xs text-gray-800 dark:text-gray-100" data-testid="sprint-code-plan">
      {body.plan.map((p, i) => (
        <li key={i} className="[overflow-wrap:anywhere]">
          {p.change}
          {(p.path != null || p.newPath != null || multiRepo) && (
            <span className={`mt-0.5 block ${MUTED}`}>
              {p.path != null ? (
                <Path path={p.path} />
              ) : p.newPath != null ? (
                <>
                  New file <Path path={p.newPath} />
                </>
              ) : null}
              {multiRepo && (
                <>
                  {p.path != null || p.newPath != null ? ' in ' : 'In '}
                  {p.repo}
                </>
              )}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function CriteriaChecks({ body, criteria }: { body: SprintAssessmentBody; criteria: readonly string[] }): JSX.Element {
  const counts = body.criterionChecks.reduce<Record<SprintCriterionStatus, number>>(
    (acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
    { met: 0, partly: 0, not_met: 0, unclear: 0 },
  );
  return (
    <div className="space-y-2">
      {body.criterionChecks.length > 0 && (
        <>
          <p className="text-xs text-gray-800 dark:text-gray-100">
            {(['met', 'partly', 'not_met', 'unclear'] as const)
              .filter((s) => counts[s] > 0)
              .map((s) => `${counts[s]} ${SPRINT_CRITERION_STATUS_LABEL[s].toLowerCase()}`)
              .join(' · ')}
            {criteria.length > 0 && ` of ${criteria.length} criteria`}
          </p>
          <ul className="space-y-1.5" data-testid="sprint-code-criteria">
            {body.criterionChecks.map((c) => (
              <li key={c.n} className="rounded border border-gray-200 bg-white p-2 text-xs dark:border-gray-800 dark:bg-gray-900">
                <div className="flex flex-wrap items-start gap-1.5">
                  <span className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_PILL[c.status]}`}>
                    {SPRINT_CRITERION_STATUS_LABEL[c.status]}
                  </span>
                  <span className="min-w-0 flex-1 text-gray-800 [overflow-wrap:anywhere] dark:text-gray-100">
                    <span className="font-semibold">Criterion {c.n}</span>
                    {criteria[c.n - 1] != null && <span className={MUTED}> · {clip(criteria[c.n - 1]!)}</span>}
                  </span>
                </div>
                <p className="mt-1 text-gray-800 [overflow-wrap:anywhere] dark:text-gray-100">{c.evidence}</p>
                <p className={`mt-0.5 [overflow-wrap:anywhere] ${MUTED}`}>
                  {c.ref != null && (
                    <>
                      <Path path={c.ref.path} />
                      {' · '}
                    </>
                  )}
                  {c.tests != null ? (
                    <>
                      Test <Path path={c.tests.path} />
                    </>
                  ) : (
                    'No test found'
                  )}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      {body.coverage != null && <p className="text-xs text-gray-800 dark:text-gray-100">{body.coverage}</p>}
    </div>
  );
}

function Path({ path }: { path: SprintCodeRef['path'] }): JSX.Element {
  return <code className="rounded bg-gray-100 px-1 font-mono text-[11px] text-gray-800 dark:bg-gray-800 dark:text-gray-100">{path}</code>;
}

/** A criterion's text, shortened at a word for the row header (the full text is in the ticket). */
function clip(s: string, max = 140): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}
