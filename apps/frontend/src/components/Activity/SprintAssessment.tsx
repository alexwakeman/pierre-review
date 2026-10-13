import { useEffect, useState, type ReactNode } from 'react';
import {
  SPRINT_ASSESSMENT_ERROR_LABEL,
  sprintAssessModeOf,
  type SprintAssessmentRecord,
  type SprintAssessMode,
  type SprintAssessmentCurrency,
  type SprintStage,
} from '@pierre-review/shared';
import {
  useCancelSprintAssess,
  useSprintAssessment,
  useSprintAssessStarting,
  useStartSprintAssess,
} from '../../hooks/useSprintStories.js';
import { AiRunGate } from '../AiSetup.js';
import { SparkleIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { RegenProgressBar } from './RegenProgressBar.js';
import { assessButtonLabel, assessmentActive, assessmentProgressLine, assessmentProgressPct, elapsedLabel } from './sprintModel.js';

// "Check against code" for one ticket (core, agentic, LOCAL-ONLY — Sonnet 5 over read-only default
// branch checkouts of the repos the reader accepted). The button shows only when AI is on here
// (`aiEnabled`) and goes through the ONE `AiRunGate`. This is the button row and, while a run is
// queued or running, its PROGRESS BAR (`RegenProgressBar`, phase-based — the agent reports no
// fraction — with the phase in words, the elapsed time and Cancel). The result renders in the
// "Code check" section (`SprintCodeCheck`). The check is STAGE-AWARE (the server picks
// the mode from the ticket's stage): a plan for a ticket not built yet, a criteria check for one in
// review or done. What the server's checks dropped is mentioned only in the ⓘ.

const MUTED = 'text-gray-500 dark:text-gray-400';

/** What the check needs of one ticket — the drawer's detail (`SprintTicketDetailResponse`) gives it. */
export interface SprintAssessTicket {
  ident: string;
  /** The ticket's stage (null = unknown → plan). */
  stage: SprintStage | null;
  assessment: { record: SprintAssessmentRecord; currency: SprintAssessmentCurrency } | null;
  repos: { accepted: Array<{ repoId: number; fullName: string }> };
  /** The brief's itemised criteria (numbers the checks). */
  criteria: readonly string[];
}

export function SprintAssessment({
  ticket: t,
  workspaceId,
  aiEnabled,
}: {
  ticket: SprintAssessTicket;
  workspaceId: number;
  aiEnabled: boolean;
}): JSX.Element | null {
  const stored = t.assessment?.record ?? null;
  const pollId = stored != null && assessmentActive(stored.status) ? stored.id : null;
  const live = useSprintAssessment(pollId, workspaceId);
  const record: SprintAssessmentRecord | null =
    live.data != null && live.data.assessment.id === stored?.id ? live.data.assessment : stored;
  const active = record != null && assessmentActive(record.status);
  const starting = useSprintAssessStarting(t.ident);
  const start = useStartSprintAssess(workspaceId, t.ident);
  const cancel = useCancelSprintAssess(workspaceId);
  const buttonLabel = assessButtonLabel({ assessment: record != null ? { record, currency: t.assessment?.currency ?? null } : null });
  const noRepos = t.repos.accepted.length === 0;

  const mode: SprintAssessMode = record?.mode ?? sprintAssessModeOf(t.stage ?? 'not_started');
  const now = useNow(active || starting);
  const elapsed = record != null && active ? now - Date.parse(record.createdAt) : 0;

  let action: ReactNode = null;
  let progress: ReactNode = null;
  if (active || starting) {
    action = (
      <span className={`flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200`}>
        {record != null && active ? assessmentProgressLine(record.status, record.phase, mode) : 'Starting…'}
        {record != null && active && (
          <button
            type="button"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(record.id)}
            className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
          >
            Cancel
          </button>
        )}
      </span>
    );
    progress = (
      <div className="w-72 max-w-full" data-testid="sprint-assess-progress">
        <RegenProgressBar
          active
          label={mode === 'verify' ? 'Checking the ticket against the code' : 'Planning the ticket against the code'}
          value={record != null && active ? assessmentProgressPct(record.status, record.phase, elapsed) : 2}
          sub={record != null && active ? elapsedLabel(elapsed) : '0s'}
        />
      </div>
    );
  } else if (aiEnabled && buttonLabel != null) {
    action = noRepos ? (
      <span className={`text-xs ${MUTED}`}>Choose at least one repo first.</span>
    ) : (
      <AiRunGate>
        <button
          type="button"
          onClick={() => start.mutate()}
          className="inline-flex items-center gap-1 rounded border border-ai-border px-2 py-1 text-xs font-medium text-ai-ink hover:bg-ai-surface-2"
        >
          <SparkleIcon size={12} className="text-ai-signal" />
          {buttonLabel}
        </button>
      </AiRunGate>
    );
  }
  // A current run has nothing to press: its result is the Code check section below (`SprintCodeCheck`,
  // with its own ⓘ), so this row says nothing.
  if (action == null && (record == null || record.status === 'succeeded')) return null;

  return (
    <section className="space-y-1" data-testid="sprint-assessment">
      <div className="flex flex-wrap items-center gap-2">
        {action}
        <InfoButton title="Check against code">
          <AssessInfo record={record} />
        </InfoButton>
      </div>
      {progress}
      {start.isError && <p className="text-xs text-rose-700 dark:text-rose-400">{start.error.message}</p>}
      {record != null && record.status === 'failed' && (
        <p className="text-xs text-rose-700 dark:text-rose-400">
          {record.error != null ? SPRINT_ASSESSMENT_ERROR_LABEL[record.error] : SPRINT_ASSESSMENT_ERROR_LABEL.failed}
        </p>
      )}
      {record != null && record.status === 'cancelled' && <p className={`text-xs ${MUTED}`}>Cancelled.</p>}
    </section>
  );
}

/** Re-renders every second while `on` (the elapsed time beside the bar). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

/** The ⓘ: what the check does in each mode, what it read, what was removed, what it cost. Shared with
 *  the Code check section. */
export function AssessInfo({ record }: { record: SprintAssessmentRecord | null }): JSX.Element {
  return (
    <>
      <p>
        Claude Sonnet 5 reads the default branch of each repo you chose. It can read files but cannot run or change
        anything. What it checks depends on where the ticket is:
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Not started or in progress:</strong> the code is not expected yet. It lists the few high-level changes
          the ticket needs and where they go.
        </li>
        <li>
          <strong>In review or complete:</strong> the code should be on the default branch. It checks each criterion (met,
          partly met, not met or unclear) and looks for a test that covers it.
        </li>
      </ul>
      <p>It reads the criteria from the ticket&rsquo;s brief: one short sentence each, worked out from the description when the ticket has none.</p>
      <p>Every file it cites was checked to exist. Citations that did not check out were removed; the line stays.</p>
      {record != null && record.status === 'succeeded' && !record.outdated && (
        <>
          {record.repos.length > 0 && (
            <p>
              Read:{' '}
              {record.repos.map((r, i) => (
                <span key={r.repoId}>
                  {i > 0 && ', '}
                  <code>{r.fullName}</code>
                  {r.sha != null && <> at <code>{r.sha.slice(0, 7)}</code></>}
                </span>
              ))}
              .
            </p>
          )}
          {record.dropped != null && (record.dropped.paths > 0 || record.dropped.items > 0) && (
            <p>
              Removed: {record.dropped.paths} {record.dropped.paths === 1 ? 'file citation' : 'file citations'},{' '}
              {record.dropped.items} {record.dropped.items === 1 ? 'item' : 'items'}.
            </p>
          )}
          {record.costUsd != null && <p>Cost: US${record.costUsd.toFixed(2)}.</p>}
        </>
      )}
      <p>It goes out of date when the ticket text, its stage or a repo&rsquo;s default branch changes.</p>
    </>
  );
}
