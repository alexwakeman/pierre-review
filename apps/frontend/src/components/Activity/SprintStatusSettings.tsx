import { useEffect, useRef, useState, type DragEvent } from 'react';
import { SPRINT_STAGES, SPRINT_STAGE_LABEL, type SprintStage, type SprintStatusLayout } from '@pierre-review/shared';
import { useSprintSetStatuses } from '../../hooks/useSprintStories.js';
import { ChevronIcon, GripIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import {
  canMoveInSections,
  codingBoundsOf,
  moveInSections,
  moveStatusTo,
  reviewRuleSentence,
  statusDraftChanged,
  statusEvidenceLine,
  statusOrderSourceLabel,
  statusPlaceOf,
  statusSectionsOf,
  statusSettingsToSave,
  type StatusSectionsDraft,
} from './sprintModel.js';

// Reports → This sprint → Settings → STATUSES: FOUR LISTS — Not started, In progress, In review, Done —
// holding every status, in order. AUTOMATIC (the tracker's board / workflow order, category, review
// names, PR evidence) until a reader changes it here, per workspace. A DRAFT until Save; Cancel drops
// it; "Reset to automatic" clears the override (`{sections: null}`). "Coding begins / ends" is read
// off the DRAFT (`codingBoundsOf`: the first status of In progress / of In review), never stored.
//
// TWO WAYS TO MOVE A STATUS, one draft:
//   • NATIVE HTML5 drag and drop (no library) — within a list and between lists, a drop line at the
//     slot, and an EMPTY list is a drop target. The slot is decided by the pointer against the row's
//     middle; the move itself is the pure `moveStatusTo` (test/sprintModel.test.ts).
//   • Move up / Move down buttons — keyboard reachable, named per status — crossing into the next list
//     at either end (`moveInSections`). Focus follows the moved status, and a polite live region says
//     where it landed.
// ⚠ Placement beats category. ⚠ Explanations live behind the ⓘ only.

const MUTED = 'text-gray-500 dark:text-gray-400';

type Place = { stage: SprintStage; index: number };

export function SprintStatusSettings({
  workspaceId,
  layout,
}: {
  workspaceId: number;
  layout: SprintStatusLayout;
}): JSX.Element {
  const save = useSprintSetStatuses(workspaceId);
  const [draft, setDraft] = useState<StatusSectionsDraft>(() => statusSectionsOf(layout));
  const [dragging, setDragging] = useState<Place | null>(null);
  const [slot, setSlot] = useState<Place | null>(null);
  const [announce, setAnnounce] = useState('');
  const [refocus, setRefocus] = useState<{ name: string; dir: 'up' | 'down' } | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  const counts = new Map(layout.order.map((o) => [o.name, o.count]));
  const auto = layout.settings.sections == null;
  const empty = SPRINT_STAGES.every((k) => draft[k].length === 0);
  const changed = statusDraftChanged(layout, draft);
  const bounds = codingBoundsOf(draft);

  // Keep focus on the moved status's button (a move across lists remounts its row).
  useEffect(() => {
    if (refocus == null || rootRef.current == null) return;
    const rows = rootRef.current.querySelectorAll<HTMLElement>('[data-status-row]');
    for (const row of rows) {
      if (row.dataset.statusRow !== refocus.name) continue;
      const want = row.querySelector<HTMLButtonElement>(`button[data-dir="${refocus.dir}"]`);
      const other = row.querySelector<HTMLButtonElement>(`button[data-dir="${refocus.dir === 'up' ? 'down' : 'up'}"]`);
      (want != null && !want.disabled ? want : other)?.focus();
    }
    setRefocus(null);
  }, [refocus]);

  const landed = (d: StatusSectionsDraft, name: string): void => {
    const p = statusPlaceOf(d, name);
    if (p != null) setAnnounce(`${name} moved to ${SPRINT_STAGE_LABEL[p.stage]}, position ${p.index + 1} of ${d[p.stage].length}.`);
  };

  const step = (stage: SprintStage, index: number, dir: -1 | 1): void => {
    const name = draft[stage][index];
    if (name == null) return;
    const next = moveInSections(draft, stage, index, dir);
    setDraft(next);
    landed(next, name);
    setRefocus({ name, dir: dir < 0 ? 'up' : 'down' });
  };

  const endDrag = (): void => {
    setDragging(null);
    setSlot(null);
  };

  const drop = (to: Place): void => {
    if (dragging == null) return;
    const name = draft[dragging.stage][dragging.index];
    const next = moveStatusTo(draft, dragging, to.stage, to.index);
    setDraft(next);
    if (name != null) landed(next, name);
    endDrag();
  };

  /** Over a row: the slot above or below it, by the pointer against the row's middle. */
  const overRow = (e: DragEvent<HTMLLIElement>, stage: SprintStage, index: number): void => {
    if (dragging == null) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const at = e.clientY < r.top + r.height / 2 ? index : index + 1;
    if (slot?.stage !== stage || slot.index !== at) setSlot({ stage, index: at });
  };

  /** Over the list itself (empty, or below its last row): the end slot. */
  const overList = (e: DragEvent<HTMLElement>, stage: SprintStage): void => {
    if (dragging == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const at = draft[stage].length;
    if (slot?.stage !== stage || slot.index !== at) setSlot({ stage, index: at });
  };

  const btn =
    'rounded p-1 text-gray-600 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-gray-800';
  const line = 'pointer-events-none absolute inset-x-0 h-0.5 rounded bg-blue-600 dark:bg-blue-400';

  return (
    <section ref={rootRef} data-testid="sprint-status-settings" className="space-y-2" aria-label="Statuses">
      <h5 className="flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
        Statuses
        <span className={`font-normal ${MUTED}`}>· {statusOrderSourceLabel(changed ? 'override' : layout.orderSource)}</span>
        <InfoButton title="Statuses">
          <p>
            Each status sits in one of four stages: Not started, In progress, In review and Done. Tickets are listed by
            stage, then by status in this order.
          </p>
          <p>
            Drag a status to move it, within a stage or into another one. The arrow buttons do the same from the keyboard;
            moving past the top or bottom of a stage carries it into the next.
          </p>
          <p>
            Coding begins at the first status of In progress, and ends at the first status of In review.
          </p>
          <p>Until you save an order, it comes from {statusOrderSourceLabel(layout.orderSource, { inSentence: true })}.</p>
          <p>{reviewRuleSentence()}</p>
          {layout.evidence.length > 0 && (
            <ul className="list-disc pl-5">
              {layout.evidence.map((e) => (
                <li key={e.status}>{statusEvidenceLine(e)}</li>
              ))}
            </ul>
          )}
          <p>A status you have not placed, such as a new one on the board, keeps its automatic place.</p>
        </InfoButton>
      </h5>
      <p className="text-xs text-gray-700 dark:text-gray-200" data-testid="sprint-coding-bounds">
        Coding begins: <strong className="font-medium">{bounds.begins ?? 'none'}</strong>
        <span className={MUTED}> · </span>
        Coding ends: <strong className="font-medium">{bounds.ends ?? 'none'}</strong>
      </p>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      {empty ? (
        <p className={`text-xs ${MUTED}`}>No statuses read yet.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {SPRINT_STAGES.map((stage) => {
            const list = draft[stage];
            const headingId = `sprint-stage-${stage}`;
            const endSlot = slot?.stage === stage && slot.index === list.length;
            return (
              <div
                key={stage}
                data-testid={`sprint-status-list-${stage}`}
                onDragOver={(e) => overList(e, stage)}
                onDrop={(e) => {
                  e.preventDefault();
                  drop({ stage, index: slot?.stage === stage ? slot.index : list.length });
                }}
                className={`flex min-w-0 flex-col rounded border p-2 ${
                  slot?.stage === stage
                    ? 'border-blue-400 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/30'
                    : 'border-gray-200 dark:border-gray-700'
                }`}
              >
                <h6 id={headingId} className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
                  {SPRINT_STAGE_LABEL[stage]} <span className={`font-normal tabular-nums ${MUTED}`}>· {list.length}</span>
                </h6>
                <ol aria-labelledby={headingId} className="relative flex-1 space-y-1">
                  {list.map((name, i) => {
                    const above = slot?.stage === stage && slot.index === i;
                    const isDragged = dragging?.stage === stage && dragging.index === i;
                    const n = counts.get(name) ?? 0;
                    return (
                      <li
                        key={name}
                        data-status-row={name}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', name);
                          setDragging({ stage, index: i });
                        }}
                        onDragEnd={endDrag}
                        onDragOver={(e) => overRow(e, stage, i)}
                        className={`relative flex cursor-grab items-center gap-1 rounded border border-gray-200 bg-white py-0.5 pl-1 pr-0.5 text-xs text-gray-800 active:cursor-grabbing dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 ${
                          isDragged ? 'opacity-40' : ''
                        }`}
                      >
                        {above && <span aria-hidden="true" className={`${line} -top-[3px]`} />}
                        <GripIcon size={11} className="decorative-mark shrink-0 text-gray-400 dark:text-gray-500" />
                        <span className="min-w-0 flex-1 break-words">{name}</span>
                        {n > 0 && (
                          <span className={`tabular-nums ${MUTED}`}>
                            {n}
                          </span>
                        )}
                        <button
                          type="button"
                          data-dir="up"
                          className={btn}
                          disabled={!canMoveInSections(draft, stage, i, -1)}
                          aria-label={`Move ${name} up`}
                          onClick={() => step(stage, i, -1)}
                        >
                          <ChevronIcon dir="up" size={11} />
                        </button>
                        <button
                          type="button"
                          data-dir="down"
                          className={btn}
                          disabled={!canMoveInSections(draft, stage, i, 1)}
                          aria-label={`Move ${name} down`}
                          onClick={() => step(stage, i, 1)}
                        >
                          <ChevronIcon dir="down" size={11} />
                        </button>
                      </li>
                    );
                  })}
                  {list.length === 0 ? (
                    <li
                      aria-hidden="true"
                      className={`relative rounded border border-dashed px-2 py-2 text-center text-xs ${
                        endSlot ? 'border-blue-500 text-blue-700 dark:text-blue-300' : `border-gray-300 dark:border-gray-600 ${MUTED}`
                      }`}
                    >
                      Drop a status here
                    </li>
                  ) : (
                    endSlot && (
                      <li aria-hidden="true" className="relative h-0">
                        <span className={`${line} -top-[3px]`} />
                      </li>
                    )
                  )}
                </ol>
              </div>
            );
          })}
        </div>
      )}
      {save.isError && <p className="text-xs text-rose-700 dark:text-rose-400">{save.error.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={save.isPending || !changed}
          onClick={() => save.mutate(statusSettingsToSave(layout, draft))}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save statuses'}
        </button>
        <button
          type="button"
          disabled={!changed}
          onClick={() => {
            setDraft(statusSectionsOf(layout));
            setAnnounce('Changes dropped.');
          }}
          className="rounded px-2 py-1 text-xs text-gray-600 hover:text-gray-800 disabled:opacity-50 dark:text-gray-300 dark:hover:text-gray-100"
        >
          Cancel
        </button>
        {!auto && (
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate({ sections: null })}
            className="rounded px-2 py-1 text-xs text-gray-600 hover:text-gray-800 disabled:opacity-50 dark:text-gray-300 dark:hover:text-gray-100"
          >
            Reset to automatic
          </button>
        )}
      </div>
    </section>
  );
}
