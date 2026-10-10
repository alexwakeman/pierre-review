import { useState } from 'react';
import { SPRINT_CHIP_ORDER, SPRINT_CHIPS, type SprintChecks, type SprintChipId } from '@pierre-review/shared';
import { useSprintSetChecks } from '../../hooks/useSprintStories.js';
import { InfoButton } from '../InfoModal.js';

// Reports → This sprint — the workspace's CHECKS: which chips it raises, and for which issue types.
// Teams differ (one with a single persona never writes "As a …"), so every check can be switched off
// or limited to some issue types. The server applies them (`sprintChipsFor`), so the list, the flag
// counts, the order and Copy all follow. A DRAFT until Save; Cancel drops it.

const MUTED = 'text-gray-500 dark:text-gray-400';

/** How many checks are switched off or narrowed — the header's one-word disclosure. */
export function changedCheckCount(c: SprintChecks): number {
  return new Set<SprintChipId>([...c.off, ...(Object.keys(c.issueTypes) as SprintChipId[])]).size;
}

export function SprintChecksPanel({
  workspaceId,
  checks,
  issueTypes,
  onClose,
}: {
  workspaceId: number;
  checks: SprintChecks;
  /** Issue type names seen on this sprint's tickets. */
  issueTypes: string[];
  onClose: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<SprintChecks>(() => ({ off: [...checks.off], issueTypes: { ...checks.issueTypes } }));
  const save = useSprintSetChecks(workspaceId);
  // Types stored on a check but not in this sprint stay choosable, so saving never drops them silently.
  const typeChoices = [...new Set([...issueTypes, ...Object.values(draft.issueTypes).flat()])].sort((a, b) => a.localeCompare(b));

  const toggleOn = (id: SprintChipId): void =>
    setDraft((d) => ({ ...d, off: d.off.includes(id) ? d.off.filter((x) => x !== id) : [...d.off, id] }));
  const toggleType = (id: SprintChipId, type: string): void =>
    setDraft((d) => {
      const cur = d.issueTypes[id] ?? [];
      const next = cur.includes(type) ? cur.filter((t) => t !== type) : [...cur, type];
      const issueTypesNext = { ...d.issueTypes };
      if (next.length === 0) delete issueTypesNext[id];
      else issueTypesNext[id] = next;
      return { ...d, issueTypes: issueTypesNext };
    });
  const allTypes = (id: SprintChipId): void =>
    setDraft((d) => {
      const issueTypesNext = { ...d.issueTypes };
      delete issueTypesNext[id];
      return { ...d, issueTypes: issueTypesNext };
    });

  const chipBtn = (active: boolean): string =>
    `rounded-full border px-2 py-0.5 text-[11px] ${
      active
        ? 'border-blue-500 bg-blue-50 text-blue-800 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-200'
        : 'border-gray-300 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300'
    }`;

  return (
    <section
      data-testid="sprint-checks"
      className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800"
      aria-label="Checks"
    >
      <h4 className="flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
        Checks
        <InfoButton title="Checks">
          <p>Choose which chips this workspace raises. Every check is on for every issue type until you change it.</p>
          <p>
            Switch a check off when it does not fit how your team writes tickets, for example &ldquo;No persona&rdquo; when
            everything is for one kind of user. Pick issue types to raise a check only on those, for example Story.
          </p>
          <p>Applies to everyone viewing this workspace.</p>
        </InfoButton>
      </h4>
      <ul className="space-y-2">
        {SPRINT_CHIP_ORDER.map((id) => {
          const on = !draft.off.includes(id);
          const only = draft.issueTypes[id] ?? [];
          return (
            <li key={id} className="space-y-1">
              <label className="flex items-center gap-2 text-xs text-gray-800 dark:text-gray-100">
                <input type="checkbox" checked={on} onChange={() => toggleOn(id)} />
                {SPRINT_CHIPS[id].label}
              </label>
              {on && typeChoices.length > 0 && (
                <div className="ml-6 flex flex-wrap items-center gap-1" role="group" aria-label={`Issue types for ${SPRINT_CHIPS[id].label}`}>
                  <button type="button" className={chipBtn(only.length === 0)} aria-pressed={only.length === 0} onClick={() => allTypes(id)}>
                    All types
                  </button>
                  {typeChoices.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={chipBtn(only.includes(t))}
                      aria-pressed={only.includes(t)}
                      onClick={() => toggleType(id, t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {save.isError && <p className="text-xs text-rose-700 dark:text-rose-400">{save.error.message}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate(draft, { onSuccess: onClose })}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onClose} className={`rounded px-2 py-1 text-xs ${MUTED} hover:text-gray-800 dark:hover:text-gray-100`}>
          Cancel
        </button>
      </div>
    </section>
  );
}
