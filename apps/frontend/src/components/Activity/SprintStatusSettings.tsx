import { useId, useState } from 'react';
import type { SprintStatusLayout } from '@pierre-review/shared';
import { useSprintSetStatuses } from '../../hooks/useSprintStories.js';
import { ChevronIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import {
  canMoveStatus,
  deliveredRuleSentence,
  moveStatus,
  statusEvidenceLine,
  statusOrderSourceLabel,
  statusSettingsToSave,
  statusSplittable,
} from './sprintModel.js';

// Reports → This sprint → Settings → STATUSES: the order the sections follow and the status "code
// delivered" starts at. Both are AUTOMATIC (the tracker's board / workflow order; PR evidence) until a
// reader changes them here, per workspace. A DRAFT until Save; Cancel drops it; "Reset to automatic"
// clears the override (`{order: null, deliveredFrom: null}`).
//
// ⚠ NO DRAG LIBRARY: each row has Move up / Move down buttons — keyboard reachable, named per status.
// ⚠ Category beats position: a status moves only among statuses of its own category (the server keeps
// not started → in progress → done, so a cross-category move would snap back on Save), and a
// not-started or done status is never split on, so it has no "Code delivered from here" choice.

const MUTED = 'text-gray-500 dark:text-gray-400';

const CATEGORY_NOTE: Record<'new' | 'done', string> = { new: 'Not started', done: 'Done' };

export function SprintStatusSettings({
  workspaceId,
  layout,
}: {
  workspaceId: number;
  layout: SprintStatusLayout;
}): JSX.Element {
  const radioName = useId();
  const save = useSprintSetStatuses(workspaceId);
  const initial = (): { order: string[]; deliveredFrom: string | null; deliveredTouched: boolean } => ({
    order: layout.order.map((o) => o.name),
    deliveredFrom: layout.deliveredFrom,
    deliveredTouched: false,
  });
  const [draft, setDraft] = useState(initial);
  const byName = new Map(layout.order.map((o) => [o.name, o]));
  const categoryOf = (n: string): string | null => byName.get(n)?.category ?? null;
  const auto = layout.settings.order == null && layout.settings.deliveredFrom == null;
  const btn =
    'rounded p-0.5 text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-gray-800';

  return (
    <section data-testid="sprint-status-settings" className="space-y-2" aria-label="Statuses">
      <h5 className="flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
        Statuses
        <span className={`font-normal ${MUTED}`}>· {statusOrderSourceLabel(layout.orderSource)}</span>
        <InfoButton title="Statuses">
          <p>Order: {statusOrderSourceLabel(layout.orderSource)}.</p>
          <p>
            Code delivered from {layout.deliveredFromAuto ?? 'no status yet'}, worked out automatically.{' '}
            {deliveredRuleSentence()}
          </p>
          {layout.evidence.length > 0 && (
            <ul className="list-disc pl-5">
              {layout.evidence.map((e) => (
                <li key={e.status}>{statusEvidenceLine(e)}</li>
              ))}
            </ul>
          )}
        </InfoButton>
      </h5>
      {draft.order.length === 0 ? (
        <p className={`text-xs ${MUTED}`}>No statuses read yet.</p>
      ) : (
        <ol className="space-y-0.5">
          {draft.order.map((name, i) => {
            const e = byName.get(name);
            const cat = e?.category ?? null;
            const splittable = e == null || statusSplittable(e);
            const chosen = draft.deliveredFrom != null && draft.deliveredFrom.trim().toLowerCase() === name.trim().toLowerCase();
            return (
              <li key={name} className="flex flex-wrap items-center gap-2 text-xs text-gray-800 dark:text-gray-100">
                <span className="inline-flex items-center">
                  <button
                    type="button"
                    className={btn}
                    disabled={!canMoveStatus(draft.order, i, -1, categoryOf)}
                    aria-label={`Move ${name} up`}
                    onClick={() => setDraft((d) => ({ ...d, order: moveStatus(d.order, i, -1, categoryOf) }))}
                  >
                    <ChevronIcon dir="up" size={11} />
                  </button>
                  <button
                    type="button"
                    className={btn}
                    disabled={!canMoveStatus(draft.order, i, 1, categoryOf)}
                    aria-label={`Move ${name} down`}
                    onClick={() => setDraft((d) => ({ ...d, order: moveStatus(d.order, i, 1, categoryOf) }))}
                  >
                    <ChevronIcon dir="down" size={11} />
                  </button>
                </span>
                <span className="min-w-0 break-words">{name}</span>
                {e != null && e.count > 0 && <span className={`tabular-nums ${MUTED}`}>{e.count}</span>}
                {(cat === 'new' || cat === 'done') && <span className={MUTED}>· {CATEGORY_NOTE[cat]}</span>}
                {splittable && (
                  <label className={`ml-auto inline-flex items-center gap-1 ${chosen ? '' : MUTED}`}>
                    <input
                      type="radio"
                      name={radioName}
                      checked={chosen}
                      onChange={() => setDraft((d) => ({ ...d, deliveredFrom: name, deliveredTouched: true }))}
                    />
                    Code delivered from here
                  </label>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {save.isError && <p className="text-xs text-rose-700 dark:text-rose-400">{save.error.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate(statusSettingsToSave(layout, draft))}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save statuses'}
        </button>
        <button
          type="button"
          onClick={() => setDraft(initial())}
          className={`rounded px-2 py-1 text-xs ${MUTED} hover:text-gray-800 dark:hover:text-gray-100`}
        >
          Cancel
        </button>
        {!auto && (
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate({ order: null, deliveredFrom: null })}
            className={`rounded px-2 py-1 text-xs ${MUTED} hover:text-gray-800 disabled:opacity-50 dark:hover:text-gray-100`}
          >
            Reset to automatic
          </button>
        )}
      </div>
    </section>
  );
}
