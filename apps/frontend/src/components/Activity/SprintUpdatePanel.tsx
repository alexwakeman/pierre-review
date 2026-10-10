import { useEffect, useState } from 'react';
import {
  SPRINT_PROVIDER_LABEL,
  sprintCurrentAssessmentBodyOf,
  type SprintChecks,
  type SprintTicketRow,
  type SprintWriteMode,
} from '@pierre-review/shared';
import { useSprintWrite, useSprintWriting } from '../../hooks/useSprintStories.js';
import { relativeTime, safeExternalUrl } from '../../lib/ui.js';
import { CloseIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { SprintCopyButton } from './SprintCopyButton.js';
import {
  currentTextFor,
  newWriteRequestId,
  proposedDefault,
  replaceModeLabel,
  updateButtonLabel,
  writeRecordLine,
  writeTargetSentence,
  writeTextProblem,
} from './sprintModel.js';

// The write-back for ONE ticket. ⚠ NOTHING IS WRITTEN WITHOUT THE DIALOG'S CONFIRM.
//
//   • Left: the ticket's current text (criteria field or description, by the ONE `sprintReplaceTarget`
//     rule the server also applies). Right: the proposed text, editable.
//   • "Add as a comment" is preselected; "Replace …" names exactly what it overwrites.
//   • "Update in <tracker>" opens a dialog that shows EXACTLY the text that will be sent (read-only,
//     selectable, copyable) and the target. Confirm posts that text with a requestId minted when the
//     dialog opened — the server's claim key, so a double click writes once. Never retried here; a
//     "may have been written" record offers nothing but a NEW dialog.
//   • No bulk control and no automatic setting exist anywhere.

const MUTED = 'text-gray-500 dark:text-gray-400';

type Drafts = Record<SprintWriteMode, string | null>;

export function SprintUpdatePanel({
  ticket: t,
  workspaceId,
  checks,
}: {
  ticket: SprintTicketRow;
  workspaceId: number;
  checks: SprintChecks;
}): JSX.Element {
  const [picked, setMode] = useState<SprintWriteMode>('comment');
  // A ticket whose text is longer than the page carries cannot be replaced here (the server refuses
  // it too): Replace is not offered. Derived for the render, never written back.
  const mode: SprintWriteMode = t.replaceBase.truncated ? 'comment' : picked;
  // null = the default for that mode (follows a new assessment); a string = the reader's edit.
  const [drafts, setDrafts] = useState<Drafts>({ comment: null, replace: null });
  const [confirm, setConfirm] = useState<{ requestId: string; text: string; mode: SprintWriteMode; baseHash: string } | null>(null);
  const writing = useSprintWriting(t.ident);
  const write = useSprintWrite(workspaceId, t.ident);

  const text = drafts[mode] ?? proposedDefault(t, mode, checks);
  const problem = writeTextProblem(text);
  const before = currentTextFor(t, t.replaceTarget);
  const provider = SPRINT_PROVIDER_LABEL[t.provider];
  const last = t.lastWrite;
  const lastLine = last != null ? writeRecordLine(last, t.provider) : null;
  const lastUrl = last != null ? safeExternalUrl(last.url) : undefined;

  return (
    <section className="space-y-2" data-testid="sprint-update">
      <div className="flex flex-wrap items-center gap-3">
        <h5 className="flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
          Update the ticket
          <InfoButton title="Update the ticket">
            <p>Edit the proposed text on the right, then press {updateButtonLabel(t)}.</p>
            <p>
              Nothing is written until you confirm the exact text in the dialog. Each confirm writes once, to this ticket
              only.
            </p>
            <p>
              {t.replaceTarget.kind === 'ac_field'
                ? `Replace overwrites the ticket’s ${t.replaceTarget.fieldName} field.`
                : 'Replace overwrites the ticket’s description.'}
            </p>
          </InfoButton>
        </h5>
        <div role="radiogroup" aria-label="How to update" className="flex flex-wrap items-center gap-3 text-xs text-gray-700 dark:text-gray-200">
          {(t.replaceBase.truncated ? (['comment'] as const) : (['comment', 'replace'] as const)).map((m) => (
            <label key={m} className="inline-flex items-center gap-1">
              <input type="radio" name={`sprint-mode-${t.ident}`} checked={mode === m} onChange={() => setMode(m)} />
              {m === 'comment' ? 'Add as a comment' : replaceModeLabel(t.replaceTarget)}
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <div className="space-y-1">
          <div className={`text-[11px] font-medium ${MUTED}`}>
            Now · {t.replaceTarget.kind === 'ac_field' ? t.replaceTarget.fieldName : 'Description'}
          </div>
          <pre className="max-h-64 min-h-[6rem] overflow-auto whitespace-pre-wrap break-words rounded border border-gray-200 bg-gray-50 p-2 font-sans text-xs text-gray-800 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100">
            {before.trim() === '' ? <span className={MUTED}>Empty</span> : before}
          </pre>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className={`text-[11px] font-medium ${MUTED}`}>{mode === 'comment' ? 'Comment' : 'New text'}</span>
            {drafts[mode] != null && (
              <button
                type="button"
                onClick={() => setDrafts((d) => ({ ...d, [mode]: null }))}
                className="text-[11px] text-sky-700 hover:underline dark:text-sky-300"
              >
                Reset
              </button>
            )}
            <SprintCopyButton markdown={text} what="the proposed update" className="ml-auto" />
          </div>
          <textarea
            value={text}
            onChange={(e) => {
              const v = e.target.value;
              setDrafts((d) => ({ ...d, [mode]: v }));
            }}
            aria-label={mode === 'comment' ? 'Comment text' : 'New text'}
            rows={10}
            className="w-full rounded border border-gray-300 bg-white p-2 font-mono text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={problem != null || writing || last?.status === 'writing'}
          onClick={() => setConfirm({ requestId: newWriteRequestId(), text, mode, baseHash: t.replaceBase.hash })}
          className="rounded border border-sky-600 bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {writing ? 'Writing…' : updateButtonLabel(t)}
        </button>
        {problem != null && text.trim() !== '' && <span className="text-xs text-rose-700 dark:text-rose-400">{problem}</span>}
        {lastLine != null && last != null && (
          <span
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
          </span>
        )}
      </div>

      {confirm != null && (
        <ConfirmWriteDialog
          ticket={t}
          mode={confirm.mode}
          text={confirm.text}
          writing={writing}
          error={write.isError ? write.error.message : null}
          onCancel={() => {
            write.reset();
            setConfirm(null);
          }}
          onConfirm={() => {
            write.mutate(
              {
                mode: confirm.mode,
                text: confirm.text,
                requestId: confirm.requestId,
                target: confirm.mode === 'replace' ? t.replaceTarget : undefined,
                // The "before" this dialog was built on; the server re-reads the ticket and refuses
                // a replace over text that changed since.
                baseHash: confirm.mode === 'replace' ? confirm.baseHash : undefined,
                assessmentId: sprintCurrentAssessmentBodyOf(t) != null ? (t.assessment?.record.id ?? null) : null,
              },
              // UI-only: close the dialog. The record lands in the list cache in the hook's onSuccess.
              { onSuccess: () => setConfirm(null) },
            );
          }}
        />
      )}
    </section>
  );
}

function ConfirmWriteDialog({
  ticket: t,
  mode,
  text,
  writing,
  error,
  onCancel,
  onConfirm,
}: {
  ticket: SprintTicketRow;
  mode: SprintWriteMode;
  text: string;
  writing: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !writing) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, writing]);
  const provider = SPRINT_PROVIDER_LABEL[t.provider];
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
        className="flex max-h-[88vh] w-[44rem] max-w-[96vw] flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
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
        <div className="space-y-2 overflow-auto px-4 py-3">
          <div className="flex items-center gap-2">
            <p className="text-xs text-gray-800 dark:text-gray-100">{writeTargetSentence(t.key, mode, t.replaceTarget)} This text will be written:</p>
            <SprintCopyButton markdown={text} what="the text to be written" className="ml-auto" />
          </div>
          <pre
            data-testid="sprint-confirm-text"
            className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded border border-gray-200 bg-gray-50 p-2 font-mono text-xs text-gray-800 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100"
          >
            {text}
          </pre>
          {error != null && <p className="text-xs text-rose-700 dark:text-rose-400">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-4 py-2 dark:border-gray-800">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            disabled={writing}
            className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={writing || error != null}
            className="rounded border border-sky-600 bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {writing ? 'Writing…' : `Write to ${provider}`}
          </button>
        </div>
      </div>
    </div>
  );
}
