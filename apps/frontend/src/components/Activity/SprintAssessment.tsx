import type { ReactNode } from 'react';
import { SPRINT_ASSESSMENT_ERROR_LABEL, type SprintAssessmentRecord, type SprintTicketRow } from '@pierre-review/shared';
import {
  useCancelSprintAssess,
  useSprintAssessment,
  useSprintAssessStarting,
  useStartSprintAssess,
} from '../../hooks/useSprintStories.js';
import { AiRunGate } from '../AiSetup.js';
import { SparkleIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { assessButtonLabel, assessmentActive, assessmentProgressLine } from './sprintModel.js';

// "Check against code" for one ticket (core, agentic, LOCAL-ONLY — Sonnet 5 over read-only default
// branch checkouts of the repos the reader accepted). The button shows only when AI is on here
// (`aiEnabled`) and goes through the ONE `AiRunGate`. This is the button row only: the result (a
// summary and one sentence per issue) renders in the card's issue bullets (`sprintBullets`). What the
// server's checks dropped is mentioned only in the ⓘ.

const MUTED = 'text-gray-500 dark:text-gray-400';

export function SprintAssessment({
  ticket: t,
  workspaceId,
  aiEnabled,
}: {
  ticket: SprintTicketRow;
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

  let action: ReactNode = null;
  if (active || starting) {
    action = (
      <span className={`flex items-center gap-2 text-xs ${MUTED}`}>
        {record != null && active ? assessmentProgressLine(record.status, record.phase) : 'Starting…'}
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
  } else if (record != null && record.status === 'succeeded') {
    // Current: nothing to press, so say what happened (a bare ⓘ on its own line read as broken).
    action = <span className={`text-xs ${MUTED}`}>Checked against the code</span>;
  }
  if (action == null && (record == null || record.status === 'succeeded')) return null;

  return (
    <section className="space-y-1" data-testid="sprint-assessment">
      <div className="flex flex-wrap items-center gap-2">
        {action}
        <InfoButton title="Check against code">
          <AssessInfo record={record} />
        </InfoButton>
      </div>
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

function AssessInfo({ record }: { record: SprintAssessmentRecord | null }): JSX.Element {
  return (
    <>
      <p>
        Claude Sonnet 5 reads the default branch of each repo you chose and checks the ticket against the code. It
        writes one line per issue it can back up, a one-line summary (for example, that the work may already be
        done) and, when needed, a better list of criteria. It can read files but cannot run or change anything.
      </p>
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
      <p>It goes out of date when the ticket text or a repo&rsquo;s default branch changes.</p>
    </>
  );
}
