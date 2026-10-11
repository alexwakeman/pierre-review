import { useEffect, useState } from 'react';
import {
  SPRINT_PROVIDER_LABEL,
  sprintCurrentAssessmentBodyOf,
  criteriaListMarkdown,
  type SprintReplaceTarget,
  type SprintTicketRow,
} from '@pierre-review/shared';
import { useSprintWrite, useSprintWriting } from '../../hooks/useSprintStories.js';
import { fieldEditable, type DraftField } from '../../lib/ticketDraft.js';
import { relativeTime, safeExternalUrl } from '../../lib/ui.js';
import { listDiff, wordDiff } from '../../lib/wordDiff.js';
import { CloseIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { SprintCopyButton } from './SprintCopyButton.js';
import { DiffText } from './SprintDiffText.js';
import {
  newWriteRequestId,
  proposedCriteriaDraft,
  updateButtonLabel,
  writeRecordLine,
  writeTargetSentence,
  writeTextProblem,
} from './sprintModel.js';
import type { TicketDraftApi } from './useTicketDraft.js';

// The opened ticket's WRITE-BACK (Reports → This sprint), around the reader's DRAFT (`useTicketDraft`).
//
//   • `SprintDraftBar`: the ONE "Update in <tracker>" — enabled when the draft differs from the ticket —
//     and "Discard changes". It opens a dialog that shows, per changed field, the diff (removed words
//     struck through, added ones yellow) and the EXACT text that will be written. Confirm writes each
//     changed field in turn, each with its own requestId (minted when the dialog opened — the server's
//     claim key, so a double click writes once) and its own base hash; the first field that is not
//     written stops the rest. Never retried here.
//   • `SprintProposals`: a current run's "Proposed criteria" / "Proposed description" as word diffs
//     against the ticket's text, each with "Apply to draft" (it replaces the whole field in the draft).
//   • ⚠ NOTHING IS WRITTEN WITHOUT THE DIALOG'S CONFIRM. No bulk control, no automatic setting.

const MUTED = 'text-gray-500 dark:text-gray-400';

const BUTTON_PRIMARY =
  'rounded border border-sky-600 bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-50';
const BUTTON_PLAIN =
  'rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500';

/** The target one draft field writes to. */
function targetOf(t: SprintTicketRow, field: DraftField): SprintReplaceTarget {
  return field === 'criteria' && t.replaceTarget.kind === 'ac_field' ? t.replaceTarget : { kind: 'description' };
}

function fieldLabel(t: SprintTicketRow, field: DraftField): string {
  return field === 'criteria' ? (t.acField?.name ?? 'Acceptance criteria') : 'Description';
}

type FieldOutcome = { tone: 'ok' | 'bad' | 'warn'; text: string };

interface ConfirmState {
  fields: DraftField[];
  requestIds: Record<DraftField, string>;
  texts: Record<DraftField, string>;
  bases: Record<DraftField, string>;
  before: Record<DraftField, string>;
  outcomes: Partial<Record<DraftField, FieldOutcome>>;
  running: boolean;
}

export function SprintDraftBar({
  ticket: t,
  workspaceId,
  draft: d,
}: {
  ticket: SprintTicketRow;
  workspaceId: number;
  draft: TicketDraftApi;
}): JSX.Element {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const writing = useSprintWriting(t.ident);
  const write = useSprintWrite(workspaceId, t.ident);
  const provider = SPRINT_PROVIDER_LABEL[t.provider];
  const last = t.lastWrite;
  const lastLine = last != null ? writeRecordLine(last, t.provider) : null;
  const lastUrl = last != null ? safeExternalUrl(last.url) : undefined;
  const busy = writing || last?.status === 'writing';
  const pending = d.changed.filter((f) => !d.written.includes(f));
  const canUpdate = pending.length > 0 && !d.moved && !busy;
  const body = sprintCurrentAssessmentBodyOf(t);

  const open = (): void => {
    const s = (fn: (f: DraftField) => string): Record<DraftField, string> => ({ description: fn('description'), criteria: fn('criteria') });
    setConfirm({
      fields: pending,
      requestIds: s(() => newWriteRequestId()),
      texts: s((f) => d.draft.text[f] ?? ''),
      bases: s((f) => d.draft.bases[f] ?? ''),
      before: s((f) => d.draft.base[f] ?? ''),
      outcomes: {},
      running: false,
    });
  };

  const run = async (c: ConfirmState): Promise<void> => {
    setConfirm({ ...c, running: true });
    const outcomes: Partial<Record<DraftField, FieldOutcome>> = { ...c.outcomes };
    let allWritten = true;
    for (const field of c.fields) {
      try {
        const res = await write.mutateAsync({
          mode: 'replace',
          text: c.texts[field],
          requestId: c.requestIds[field],
          target: targetOf(t, field),
          // The base this field's draft was built on; the server re-reads the ticket and refuses a
          // replace over text that changed since.
          baseHash: c.bases[field],
          assessmentId: body != null ? (t.assessment?.record.id ?? null) : null,
        });
        const line = writeRecordLine(res.write, t.provider);
        outcomes[field] = { tone: line.tone === 'busy' ? 'warn' : line.tone, text: line.text };
        if (res.write.status === 'written') {
          d.markWritten(field);
        } else {
          allWritten = false;
          break;
        }
      } catch (err) {
        outcomes[field] = { tone: 'bad', text: err instanceof Error ? err.message : 'The update failed.' };
        allWritten = false;
        break;
      }
    }
    if (allWritten) setConfirm(null);
    else setConfirm({ ...c, outcomes, running: false });
  };

  return (
    <div className="space-y-1" data-testid="sprint-draft-bar">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!canUpdate} onClick={open} className={BUTTON_PRIMARY}>
          {busy ? 'Writing…' : updateButtonLabel(t)}
        </button>
        {!d.moved && d.changed.length > 0 && pending.length > 0 && (
          <span className={`text-xs ${MUTED}`}>Changed: {pending.map((f) => fieldLabel(t, f)).join(', ')}</span>
        )}
        {(d.changed.length > 0 || d.draft.replaced.length > 0) && (
          <button type="button" disabled={busy} onClick={d.discard} className={BUTTON_PLAIN}>
            Discard changes
          </button>
        )}
        <InfoButton title={updateButtonLabel(t)}>
          <p>Edit the text on the left. Replace swaps a highlighted passage for Claude’s suggestion; Edit lets you rewrite it yourself.</p>
          <p>Nothing is sent until you press {updateButtonLabel(t)} and confirm the exact text. Each changed field is written once.</p>
          <p>Yellow text with a dashed underline is new or changed. Your draft is kept in this browser until you send or discard it.</p>
        </InfoButton>
      </div>
      {d.moved && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          The ticket changed since you started editing.{' '}
          <button type="button" onClick={d.discard} className="font-medium underline hover:no-underline">
            Discard
          </button>
        </p>
      )}
      {lastLine != null && last != null && (
        <p
          className={`text-xs ${
            lastLine.tone === 'ok'
              ? 'text-emerald-700 dark:text-emerald-400'
              : lastLine.tone === 'bad'
                ? 'text-rose-700 dark:text-rose-400'
                : lastLine.tone === 'warn'
                  ? 'text-amber-700 dark:text-amber-400'
                  : MUTED
          }`}
        >
          {lastLine.text}
          {last.status === 'written' && last.completedAt != null && ` ${relativeTime(last.completedAt)}.`}
          {lastUrl != null && last.status === 'written' && (
            <a href={lastUrl} target="_blank" rel="noreferrer" className="ml-1 text-sky-700 hover:underline dark:text-sky-300">
              Open in {provider}
            </a>
          )}
        </p>
      )}

      {confirm != null && (
        <ConfirmWriteDialog
          ticket={t}
          state={confirm}
          onCancel={() => {
            write.reset();
            setConfirm(null);
          }}
          onConfirm={() => void run(confirm)}
        />
      )}
    </div>
  );
}

/** Whether there are proposals to show for this ticket. */
export function sprintProposalsShown(t: SprintTicketRow): boolean {
  const body = sprintCurrentAssessmentBodyOf(t);
  return body != null && (body.revisedCriteria.length > 0 || (body.revisedDescription ?? '').trim() !== '');
}

export function SprintProposals({ ticket: t, draft: d }: { ticket: SprintTicketRow; draft: TicketDraftApi }): JSX.Element | null {
  if (!sprintProposalsShown(t)) return null;
  const body = sprintCurrentAssessmentBodyOf(t);
  const revised = body?.revisedCriteria ?? [];
  const revisedDescription = body?.revisedDescription != null && body.revisedDescription.trim() !== '' ? body.revisedDescription : null;
  const criteriaApply = revised.length > 0 ? proposedCriteriaDraft(d.draft.text, revised) : null;

  const applyButton = (field: DraftField, text: string): JSX.Element => {
    if (d.draft.text[field] === text) return <span className={`text-xs ${MUTED}`}>In the draft.</span>;
    return (
      <button
        type="button"
        disabled={!fieldEditable(t, field) || d.moved}
        onClick={() => d.setField(field, text)}
        className={BUTTON_PRIMARY}
      >
        Apply to draft
      </button>
    );
  };

  return (
    <section className="space-y-3" data-testid="sprint-update">
      {criteriaApply != null && (
        <div className="space-y-1" data-testid="sprint-proposed-criteria">
          <div className="flex flex-wrap items-center gap-2">
            <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-200">Proposed criteria</h5>
            <SprintCopyButton markdown={criteriaListMarkdown(revised)} what="the proposed criteria" className="ml-auto" />
            {applyButton(criteriaApply.field, criteriaApply.text)}
          </div>
          <ProposedCriteria before={t.criteria.items} after={revised} />
        </div>
      )}
      {revisedDescription != null && (
        <div className="space-y-1" data-testid="sprint-proposed-description">
          <div className="flex flex-wrap items-center gap-2">
            <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-200">Proposed description</h5>
            <SprintCopyButton markdown={revisedDescription} what="the proposed description" className="ml-auto" />
            {applyButton('description', revisedDescription)}
          </div>
          <div className="whitespace-pre-wrap rounded border [overflow-wrap:anywhere] border-gray-200 p-2 text-xs text-gray-800 dark:border-gray-800 dark:text-gray-100">
            <DiffText parts={wordDiff(t.description, revisedDescription)} />
          </div>
        </div>
      )}
    </section>
  );
}

/** The proposed list, each item word-diffed against the current item it most resembles; current items
 *  nothing replaced are listed after it, struck through. */
function ProposedCriteria({ before, after }: { before: readonly string[]; after: readonly string[] }): JSX.Element {
  const { items, removed } = listDiff(before, after);
  return (
    <div className="rounded border border-gray-200 p-2 text-xs text-gray-800 dark:border-gray-800 dark:text-gray-100">
      <ol className="list-decimal space-y-1 pl-5">
        {items.map((it, i) => (
          <li key={i} className="[overflow-wrap:anywhere]">
            <DiffText parts={it.parts} />
          </li>
        ))}
      </ol>
      {removed.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 pl-5">
          {removed.map((r, i) => (
            <li key={i} className="[overflow-wrap:anywhere]">
              <del className={`line-through ${MUTED}`}>{r}</del>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConfirmWriteDialog({
  ticket: t,
  state: c,
  onCancel,
  onConfirm,
}: {
  ticket: SprintTicketRow;
  state: ConfirmState;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const writing = c.running;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !writing) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, writing]);
  const provider = SPRINT_PROVIDER_LABEL[t.provider];
  const problems = c.fields.map((f) => writeTextProblem(c.texts[f]));
  const stopped = Object.values(c.outcomes).some((o) => o != null && o.tone !== 'ok');
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      onClick={() => {
        if (!writing) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Update ${t.key} in ${provider}`}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-[48rem] max-w-[96vw] flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
      >
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Update {t.key} in {provider}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={writing}
            aria-label="Close"
            className="ml-auto text-gray-500 hover:text-gray-800 disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-100"
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="space-y-4 overflow-auto px-4 py-3">
          {c.fields.map((field, i) => {
            const outcome = c.outcomes[field];
            const problem = problems[i];
            return (
              <section key={field} className="space-y-1.5" data-testid={`sprint-confirm-${field}`}>
                <h3 className="text-xs font-semibold text-gray-800 dark:text-gray-100">{fieldLabel(t, field)}</h3>
                <p className="text-xs text-gray-800 dark:text-gray-100">{writeTargetSentence(t.key, targetOf(t, field))}</p>
                <div className="whitespace-pre-wrap rounded border border-gray-200 p-2 text-xs [overflow-wrap:anywhere] text-gray-800 dark:border-gray-800 dark:text-gray-100">
                  <DiffText parts={wordDiff(c.before[field], c.texts[field])} />
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-xs text-gray-800 dark:text-gray-100">This text will be written:</p>
                  <SprintCopyButton markdown={c.texts[field]} what={`the new ${fieldLabel(t, field)}`} className="ml-auto" />
                </div>
                <pre
                  data-testid="sprint-confirm-text"
                  className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded border border-gray-200 bg-gray-50 p-2 font-mono text-xs text-gray-800 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100"
                >
                  {c.texts[field]}
                </pre>
                {problem != null && <p className="text-xs text-rose-700 dark:text-rose-400">{problem}</p>}
                {outcome != null && (
                  <p
                    className={`text-xs ${
                      outcome.tone === 'ok'
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : outcome.tone === 'bad'
                          ? 'text-rose-700 dark:text-rose-400'
                          : 'text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {outcome.text}
                  </p>
                )}
              </section>
            );
          })}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-4 py-2 dark:border-gray-800">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            disabled={writing}
            className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200"
          >
            {stopped ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={writing || stopped || problems.some((p) => p != null)}
            className="rounded border border-sky-600 bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {writing ? 'Writing…' : `Write to ${provider}`}
          </button>
        </div>
      </div>
    </div>
  );
}
