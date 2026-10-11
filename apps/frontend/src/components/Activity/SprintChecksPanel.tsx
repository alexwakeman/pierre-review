import { useState } from 'react';
import { STORY_ISSUES, type SprintChecks, type SprintStatusLayout, type StoryIssueId } from '@pierre-review/shared';
import { useSprintSetChecks } from '../../hooks/useSprintStories.js';
import { CloseIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { checkTypeChoices, toggleCheckType } from './sprintModel.js';
import { SprintStatusSettings } from './SprintStatusSettings.js';

// Reports → This sprint → SETTINGS (per workspace), two independent parts, each saved on its own:
//   • CHECKS — three on/off switches (one per story issue) and ONE issue-type list for the whole tab.
//     The server applies them (`applyStoryIssueChecks`), so the list, the issue counts, the order and
//     Copy all follow. A DRAFT until Save; Cancel closes without saving.
//   • STATUSES (SprintStatusSettings) — the section order and the "code delivered from" status.

const MUTED = 'text-gray-500 dark:text-gray-400';

export function SprintChecksPanel({
  workspaceId,
  checks,
  issueTypes,
  layout,
  onClose,
}: {
  workspaceId: number;
  checks: SprintChecks;
  layout: SprintStatusLayout | null;
  /** Issue type names seen on this sprint's tickets. */
  issueTypes: string[];
  onClose: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<SprintChecks>(() => ({ off: [...checks.off], issueTypes: [...checks.issueTypes] }));
  const save = useSprintSetChecks(workspaceId);
  // Saved types not in this sprint stay choosable, so saving never drops them silently.
  const typeChoices = checkTypeChoices(issueTypes, draft.issueTypes);
  const selected = (type: string): boolean => draft.issueTypes.some((x) => x.trim().toLowerCase() === type.trim().toLowerCase());

  const toggleOn = (id: StoryIssueId): void =>
    setDraft((d) => ({ ...d, off: d.off.includes(id) ? d.off.filter((x) => x !== id) : [...d.off, id] }));

  const chipBtn = (active: boolean): string =>
    `rounded-full border px-2 py-0.5 text-[11px] ${
      active
        ? 'border-blue-500 bg-blue-50 text-blue-800 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-200'
        : 'border-gray-300 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300'
    }`;

  return (
    <section data-testid="sprint-settings" className="space-y-4 rounded-lg border border-gray-200 p-3 dark:border-gray-800" aria-label="Settings">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-gray-800 dark:text-gray-100">Settings</h4>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="rounded p-0.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <CloseIcon size={12} />
        </button>
      </div>
      <section data-testid="sprint-checks" className="space-y-3" aria-label="Checks">
        <h5 className="flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
          Checks
          <InfoButton title="Checks">
            <p>Switch off an issue your team does not want raised. Every issue is on until you change it.</p>
            <p>
              Pick issue types to raise issues only on tickets of those types, for example Story. With none picked, every
              type is checked. A ticket of another type is still listed, with no issues.
            </p>
            <p>Applies to everyone viewing this workspace.</p>
          </InfoButton>
        </h5>
        <ul className="space-y-1">
          {STORY_ISSUES.map((m) => (
            <li key={m.id}>
              <label className="flex items-center gap-2 text-xs text-gray-800 dark:text-gray-100">
                <input type="checkbox" checked={!draft.off.includes(m.id)} onChange={() => toggleOn(m.id)} />
                {m.label}
              </label>
            </li>
          ))}
        </ul>
        {typeChoices.length > 0 && (
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Issue types">
            <span className={`mr-1 text-xs ${MUTED}`}>Issue types</span>
            <button
              type="button"
              className={chipBtn(draft.issueTypes.length === 0)}
              aria-pressed={draft.issueTypes.length === 0}
              onClick={() => setDraft((d) => ({ ...d, issueTypes: [] }))}
            >
              All types
            </button>
            {typeChoices.map((t) => (
              <button
                key={t}
                type="button"
                className={chipBtn(selected(t))}
                aria-pressed={selected(t)}
                onClick={() => setDraft((d) => ({ ...d, issueTypes: toggleCheckType(d.issueTypes, t) }))}
              >
                {t}
              </button>
            ))}
          </div>
        )}
        {save.isError && <p className="text-xs text-rose-700 dark:text-rose-400">{save.error.message}</p>}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate(draft, { onSuccess: onClose })}
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save checks'}
          </button>
          <button type="button" onClick={onClose} className={`rounded px-2 py-1 text-xs ${MUTED} hover:text-gray-800 dark:hover:text-gray-100`}>
            Cancel
          </button>
        </div>
      </section>
      {layout != null && (
        <SprintStatusSettings
          // A saved layout re-seeds the draft.
          key={`${layout.order.map((o) => o.name).join('\u0000')}|${layout.deliveredFrom ?? ''}|${layout.orderSource}`}
          workspaceId={workspaceId}
          layout={layout}
        />
      )}
    </section>
  );
}
