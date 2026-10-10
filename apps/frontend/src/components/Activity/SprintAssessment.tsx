import type { ReactNode } from 'react';
import {
  SPRINT_ASSESSMENT_ERROR_LABEL,
  SPRINT_EXISTING_LABEL,
  SPRINT_GAP_LABEL,
  type SprintAssessmentBody,
  type SprintAssessmentGaps,
  type SprintAssessmentRecord,
  type SprintTicketRow,
} from '@pierre-review/shared';
import {
  useCancelSprintAssess,
  useSprintAssessment,
  useSprintAssessStarting,
  useStartSprintAssess,
} from '../../hooks/useSprintStories.js';
import { assessmentSectionMarkdown } from '../../lib/copy.js';
import { relativeTime } from '../../lib/ui.js';
import { AiRunGate } from '../AiSetup.js';
import { SparkleIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { SprintCopyButton } from './SprintCopyButton.js';
import { assessButtonLabel, assessmentActive, assessmentProgressLine } from './sprintModel.js';

// "Assess with code" for one ticket (core, agentic, LOCAL-ONLY — Sonnet 5 over read-only default
// branch checkouts of the repos the reader accepted). The button shows only when AI is on here
// (`aiEnabled`) and goes through the ONE `AiRunGate`. A stored assessment still renders without it.
//
// Every section has its own Copy button. What the server's checks dropped is mentioned only in the ⓘ.

const MUTED = 'text-gray-500 dark:text-gray-400';

export function SprintAssessment({
  ticket: t,
  workspaceId,
  aiEnabled,
}: {
  ticket: SprintTicketRow;
  workspaceId: number;
  aiEnabled: boolean;
}): JSX.Element {
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
  const stale = record?.status === 'succeeded' && t.assessment?.currency === 'stale';

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
  }

  const body = record?.status === 'succeeded' ? record.body : null;

  return (
    <section className="space-y-3" data-testid="sprint-assessment">
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
          Assessment against the code
          <InfoButton title="Assessment against the code">
            <AssessInfo record={record} />
          </InfoButton>
        </h5>
        {record?.status === 'succeeded' && record.completedAt != null && (
          <span className={`text-[11px] ${MUTED}`}>
            {relativeTime(record.completedAt)}
            {stale && ' · out of date'}
          </span>
        )}
        <div className="ml-auto">{action}</div>
      </div>
      {start.isError && <p className="text-xs text-rose-700 dark:text-rose-400">{start.error.message}</p>}
      {record != null && record.status === 'failed' && (
        <p className="text-xs text-rose-700 dark:text-rose-400">
          {record.error != null ? SPRINT_ASSESSMENT_ERROR_LABEL[record.error] : SPRINT_ASSESSMENT_ERROR_LABEL.failed}
        </p>
      )}
      {record != null && record.status === 'cancelled' && <p className={`text-xs ${MUTED}`}>Cancelled.</p>}
      {body != null && <AssessmentBody ticket={t} body={body} />}
    </section>
  );
}

function AssessInfo({ record }: { record: SprintAssessmentRecord | null }): JSX.Element {
  return (
    <>
      <p>
        Claude Sonnet 5 reads the default branch of each repo you chose and judges every criterion against the code.
        It can read files but cannot run anything or change anything.
      </p>
      <p>Every file it cites was checked to exist. Citations that did not check out were removed.</p>
      {record != null && record.status === 'succeeded' && (
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

function Section({ title, markdown, children }: { title: string; markdown: string; children: ReactNode }): JSX.Element {
  return (
    <div className="space-y-1.5 rounded-md border border-gray-100 p-2 dark:border-gray-800">
      <div className="flex items-center gap-2">
        <h6 className="text-[11px] font-semibold text-gray-700 dark:text-gray-200">{title}</h6>
        <SprintCopyButton markdown={markdown} what={title.toLowerCase()} className="ml-auto" />
      </div>
      {children}
    </div>
  );
}

function List({ items }: { items: string[] }): JSX.Element {
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-xs text-gray-800 dark:text-gray-100">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

function AssessmentBody({ ticket: t, body }: { ticket: SprintTicketRow; body: SprintAssessmentBody }): JSX.Element {
  const gapKeys = (Object.keys(SPRINT_GAP_LABEL) as Array<keyof SprintAssessmentGaps>).filter((k) => body.gaps[k].length > 0);
  const s = body.suggestion;
  const rewritten = new Map(s.rewrittenCriteria.map((r) => [r.n, r.text]));
  return (
    <div className="space-y-2">
      {body.criteria.length > 0 && (
        <Section title="Criteria" markdown={assessmentSectionMarkdown('criteria', t, body)}>
          <ol className="space-y-2">
            {body.criteria.map((c) => (
              <li key={c.n} className="space-y-0.5 text-xs">
                <div className="text-gray-800 dark:text-gray-100">
                  <span className={`mr-1 ${MUTED}`}>{c.n}.</span>
                  {c.criterion}
                </div>
                <div className={`text-[11px] ${MUTED}`}>
                  {SPRINT_EXISTING_LABEL[c.existing]} · {c.testableAgainstCode ? 'Testable against the code' : 'Not testable against the code'}
                </div>
                {c.landsIn.length > 0 && (
                  <ul className="space-y-0.5">
                    {c.landsIn.map((r, i) => (
                      <li key={i} className="font-mono text-[11px] text-gray-700 dark:text-gray-200">
                        {r.repo} · {r.path}
                        {r.symbol != null && r.symbol !== '' && ` · ${r.symbol}`}
                      </li>
                    ))}
                  </ul>
                )}
                {c.note !== '' && <p className="text-gray-700 dark:text-gray-200">{c.note}</p>}
              </li>
            ))}
          </ol>
        </Section>
      )}
      <Section title="Gaps" markdown={assessmentSectionMarkdown('gaps', t, body)}>
        {gapKeys.length === 0 ? (
          <p className={`text-xs ${MUTED}`}>None found.</p>
        ) : (
          gapKeys.map((k) => (
            <div key={k} className="space-y-0.5">
              <div className="text-[11px] font-medium text-gray-700 dark:text-gray-200">{SPRINT_GAP_LABEL[k]}</div>
              <List items={body.gaps[k]} />
            </div>
          ))
        )}
      </Section>
      <Section title="Suggestion" markdown={assessmentSectionMarkdown('suggestion', t, body)}>
        {s.summary !== '' && <p className="text-xs text-gray-800 dark:text-gray-100">{s.summary}</p>}
        {(t.criteria.items.length > 0 || s.addedCriteria.length > 0) && (
          <div className="space-y-0.5">
            <div className="text-[11px] font-medium text-gray-700 dark:text-gray-200">Proposed acceptance criteria</div>
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-gray-800 dark:text-gray-100">
              {t.criteria.items.map((c, i) => {
                const r = rewritten.get(i + 1);
                return (
                  <li key={`o${i}`}>
                    {r ?? c}
                    {r != null && <span className={`ml-1 text-[11px] ${MUTED}`}>(reworded)</span>}
                  </li>
                );
              })}
              {s.addedCriteria.map((a, i) => (
                <li key={`a${i}`}>
                  {a}
                  <span className={`ml-1 text-[11px] ${MUTED}`}>(new)</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {s.split != null && s.split.length > 0 && (
          <div className="space-y-0.5">
            <div className="text-[11px] font-medium text-gray-700 dark:text-gray-200">Proposed split</div>
            <ul className="list-disc space-y-1 pl-5 text-xs text-gray-800 dark:text-gray-100">
              {s.split.map((p, i) => (
                <li key={i}>
                  {p.title}
                  {p.criteria.length > 0 && <List items={p.criteria} />}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
      {s.questionsForOwner.length > 0 && (
        <Section title="Questions for the owner" markdown={assessmentSectionMarkdown('questions', t, body)}>
          <List items={s.questionsForOwner} />
        </Section>
      )}
    </div>
  );
}
