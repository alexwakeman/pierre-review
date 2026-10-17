import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  SPRINT_BUCKET_NAME_MAX,
  SPRINT_BUCKETS_MAX,
  SPRINT_MERGED_COLUMN_LABEL,
  SPRINT_STAGE_LABEL,
  SPRINT_STAGES,
  SPRINT_STATUS_SETTINGS_DEFAULT,
  type SprintStage,
  type SprintStatusLayout,
} from '@pierre-review/shared';
import { useSprintSetStatuses } from '../../hooks/useSprintStories.js';
import { ChevronIcon, CloseIcon, GripIcon, PlusIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import {
  addBucket,
  bucketsDraftChanged,
  bucketsDraftOf,
  bucketsDraftProblem,
  bucketsToSave,
  canMoveStatusStep,
  codingBoundsOf,
  moveBucket,
  moveStatusStep,
  moveStatusTo,
  removeBucket,
  renameBucket,
  reviewRuleSentence,
  setBucketMeaning,
  statusEvidenceLine,
  statusOrderSourceLabel,
  statusPlaceOf,
  unplacedStatuses,
  type StatusBucketsDraft,
} from './sprintModel.js';

// Activity → This Sprint → Settings → STATUSES: the workspace's BUCKETS of tracker statuses (shared
// sprint-stories.ts § The status layout). Each bucket has a name and a MEANING (Not started, In
// progress, In review, Complete) — meanings may not go backwards. AUTOMATIC (four buckets, one per
// stage) until a reader changes it here, per workspace. A DRAFT until Save; Cancel drops it; "Reset to
// automatic" clears the override. The "Merged, not signed off" column switch rides the same Save.
//
// TWO WAYS TO MOVE A STATUS, one draft:
//   • NATIVE HTML5 drag and drop (no library) — within a bucket and between buckets, a drop line at the
//     slot, and an EMPTY bucket is a drop target (`moveStatusTo`, test/sprintModel.test.ts).
//   • Move up / Move down buttons — keyboard reachable, named per status — crossing into the next
//     bucket at either end (`moveStatusStep`). Focus follows the moved status, and a polite live region
//     says where it landed.
// Buckets move with their own earlier / later buttons. What blocks Save is the server's own check
// (`bucketsDraftProblem` → shared `sprintBucketsProblem`), printed in its words. ⚠ Explanations live
// behind the ⓘ only.

const MUTED = 'text-gray-500 dark:text-gray-400';

type Place = { bucket: number; index: number };

export function SprintStatusSettings({
  workspaceId,
  layout,
}: {
  workspaceId: number;
  layout: SprintStatusLayout;
}): JSX.Element {
  const save = useSprintSetStatuses(workspaceId);
  const [draft, setDraft] = useState<StatusBucketsDraft>(() => bucketsDraftOf(layout));
  const [dragging, setDragging] = useState<Place | null>(null);
  const [slot, setSlot] = useState<Place | null>(null);
  const [announce, setAnnounce] = useState('');
  const [refocus, setRefocus] = useState<{ name: string; dir: 'up' | 'down' } | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  const counts = new Map(layout.order.map((o) => [o.name, o.count]));
  const unplaced = unplacedStatuses(layout);
  const isDefault =
    layout.settings.buckets == null && layout.settings.mergedColumn === SPRINT_STATUS_SETTINGS_DEFAULT.mergedColumn;
  const empty = draft.buckets.every((b) => b.statuses.length === 0);
  const changed = bucketsDraftChanged(layout, draft);
  const problem = changed ? bucketsDraftProblem(draft) : null;
  const bounds = codingBoundsOf(draft);

  // Keep focus on the moved status's button (a move across buckets remounts its row).
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

  const landed = (d: StatusBucketsDraft, name: string): void => {
    const p = statusPlaceOf(d, name);
    const b = p == null ? null : d.buckets[p.bucket];
    if (p != null && b != null) setAnnounce(`${name} moved to ${b.name}, position ${p.index + 1} of ${b.statuses.length}.`);
  };

  const step = (bucket: number, index: number, dir: -1 | 1): void => {
    const name = draft.buckets[bucket]?.statuses[index];
    if (name == null) return;
    const next = moveStatusStep(draft, bucket, index, dir);
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
    const name = draft.buckets[dragging.bucket]?.statuses[dragging.index];
    const next = moveStatusTo(draft, dragging, to.bucket, to.index);
    setDraft(next);
    if (name != null) landed(next, name);
    endDrag();
  };

  /** Over a row: the slot above or below it, by the pointer against the row's middle. */
  const overRow = (e: DragEvent<HTMLLIElement>, bucket: number, index: number): void => {
    if (dragging == null) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const at = e.clientY < r.top + r.height / 2 ? index : index + 1;
    if (slot?.bucket !== bucket || slot.index !== at) setSlot({ bucket, index: at });
  };

  /** Over the bucket itself (empty, or below its last row): the end slot. */
  const overList = (e: DragEvent<HTMLElement>, bucket: number): void => {
    if (dragging == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const at = draft.buckets[bucket]?.statuses.length ?? 0;
    if (slot?.bucket !== bucket || slot.index !== at) setSlot({ bucket, index: at });
  };

  const btn =
    'rounded p-1 text-gray-600 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-gray-800';
  const line = 'pointer-events-none absolute inset-x-0 h-0.5 rounded bg-blue-600 dark:bg-blue-400';
  const field =
    'rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100';

  return (
    <section ref={rootRef} data-testid="sprint-status-settings" className="space-y-2" aria-label="Statuses">
      <h5 className="flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
        Statuses
        <span className={`font-normal ${MUTED}`}>· {statusOrderSourceLabel(changed ? 'override' : layout.orderSource)}</span>
        <InfoButton title="Statuses">
          <p>
            Each bucket is a column on This Sprint. Put any of your tracker’s statuses in a bucket, and say what the
            bucket means: Not started, In progress, In review or Complete. Buckets must go in that order, but you can
            have two of one kind, such as two review stages.
          </p>
          <p>
            Drag a status to move it, within a bucket or into another one. The arrow buttons do the same from the
            keyboard; moving past the top or bottom of a bucket carries it into the next.
          </p>
          <p>Coding begins at the first In progress status, and ends at the first In review status.</p>
          <p>Until you save buckets, they come from {statusOrderSourceLabel(layout.orderSource, { inSentence: true })}.</p>
          <p>{reviewRuleSentence()}</p>
          {layout.evidence.length > 0 && (
            <ul className="list-disc pl-5">
              {layout.evidence.map((e) => (
                <li key={e.status}>{statusEvidenceLine(e)}</li>
              ))}
            </ul>
          )}
          <p>
            A status your buckets do not name, such as a new one on the board, is marked “not placed yet”. It sits in the
            first bucket of its automatic kind, or the nearest kind when there is none.
          </p>
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
      {empty && <p className={`text-xs ${MUTED}`}>No statuses read yet.</p>}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {draft.buckets.map((bucket, bi) => {
          const list = bucket.statuses;
          const headingId = `sprint-bucket-${bucket.id}`;
          const endSlot = slot?.bucket === bi && slot.index === list.length;
          const label = bucket.name.trim() === '' ? 'this bucket' : bucket.name.trim();
          return (
            <div
              key={bucket.id}
              data-testid={`sprint-status-bucket-${bucket.id}`}
              onDragOver={(e) => overList(e, bi)}
              onDrop={(e) => {
                e.preventDefault();
                drop({ bucket: bi, index: slot?.bucket === bi ? slot.index : list.length });
              }}
              className={`flex min-w-0 flex-col gap-1 rounded border p-2 ${
                slot?.bucket === bi
                  ? 'border-blue-400 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/30'
                  : 'border-gray-200 dark:border-gray-700'
              }`}
            >
              <div className="flex items-center gap-1">
                <input
                  id={headingId}
                  type="text"
                  value={bucket.name}
                  maxLength={SPRINT_BUCKET_NAME_MAX}
                  aria-label="Bucket name"
                  onChange={(e) => setDraft(renameBucket(draft, bucket.id, e.target.value))}
                  className={`${field} min-w-0 flex-1 font-semibold`}
                />
                <span className={`text-xs tabular-nums ${MUTED}`}>{list.length}</span>
                <button
                  type="button"
                  className={btn}
                  disabled={bi === 0}
                  aria-label={`Move ${label} earlier`}
                  onClick={() => setDraft(moveBucket(draft, bi, -1))}
                >
                  <ChevronIcon dir="left" size={11} />
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={bi === draft.buckets.length - 1}
                  aria-label={`Move ${label} later`}
                  onClick={() => setDraft(moveBucket(draft, bi, 1))}
                >
                  <ChevronIcon dir="right" size={11} />
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={draft.buckets.length <= 1}
                  aria-label={`Delete ${label}`}
                  onClick={() => {
                    const next = removeBucket(draft, bucket.id);
                    setDraft(next);
                    const p = list[0] == null ? null : statusPlaceOf(next, list[0]);
                    const heir = p == null ? null : next.buckets[p.bucket]?.name.trim();
                    setAnnounce(heir != null && heir !== '' ? `${label} deleted. Its statuses moved to ${heir}.` : `${label} deleted.`);
                  }}
                >
                  <CloseIcon size={11} />
                </button>
              </div>
              <label className={`flex items-center gap-1 text-xs ${MUTED}`}>
                Means
                <select
                  value={bucket.meaning}
                  onChange={(e) => setDraft(setBucketMeaning(draft, bucket.id, e.target.value as SprintStage))}
                  className={field}
                >
                  {SPRINT_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {SPRINT_STAGE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              <ol aria-label={`Statuses in ${label}`} className="relative flex-1 space-y-1">
                {list.map((name, i) => {
                  const above = slot?.bucket === bi && slot.index === i;
                  const isDragged = dragging?.bucket === bi && dragging.index === i;
                  const n = counts.get(name) ?? 0;
                  return (
                    <li
                      key={name}
                      data-status-row={name}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', name);
                        setDragging({ bucket: bi, index: i });
                      }}
                      onDragEnd={endDrag}
                      onDragOver={(e) => overRow(e, bi, i)}
                      className={`relative flex cursor-grab items-center gap-1 rounded border border-gray-200 bg-white py-0.5 pl-1 pr-0.5 text-xs text-gray-800 active:cursor-grabbing dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 ${
                        isDragged ? 'opacity-40' : ''
                      }`}
                    >
                      {above && <span aria-hidden="true" className={`${line} -top-[3px]`} />}
                      <GripIcon size={11} className="decorative-mark shrink-0 text-gray-400 dark:text-gray-500" />
                      <span className="min-w-0 flex-1 break-words">
                        {name}
                        {unplaced.has(name) && <span className={MUTED}> · not placed yet</span>}
                      </span>
                      <span className={`tabular-nums ${MUTED}`} aria-label={`${n} ${n === 1 ? 'ticket' : 'tickets'}`}>
                        {n}
                      </span>
                      <button
                        type="button"
                        data-dir="up"
                        className={btn}
                        disabled={!canMoveStatusStep(draft, bi, i, -1)}
                        aria-label={`Move ${name} up`}
                        onClick={() => step(bi, i, -1)}
                      >
                        <ChevronIcon dir="up" size={11} />
                      </button>
                      <button
                        type="button"
                        data-dir="down"
                        className={btn}
                        disabled={!canMoveStatusStep(draft, bi, i, 1)}
                        aria-label={`Move ${name} down`}
                        onClick={() => step(bi, i, 1)}
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
      {draft.buckets.length < SPRINT_BUCKETS_MAX && (
        <button
          type="button"
          onClick={() => {
            const next = addBucket(draft);
            setDraft(next);
            setAnnounce(`${next.buckets[next.buckets.length - 1]?.name ?? 'Bucket'} added at the end.`);
          }}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
        >
          <PlusIcon size={11} />
          Add bucket
        </button>
      )}
      <div className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-200">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={draft.mergedColumn}
            onChange={(e) => setDraft({ ...draft, mergedColumn: e.target.checked })}
          />
          Show a “{SPRINT_MERGED_COLUMN_LABEL}” column
        </label>
        <InfoButton title={SPRINT_MERGED_COLUMN_LABEL}>
          <p>
            A ticket moves to this column when its bucket means In progress or In review, and every pull request on it is
            merged. Closed pull requests that were never merged do not count.
          </p>
          <p>It sits after your last In review bucket, so you can see code that is in but not yet signed off.</p>
        </InfoButton>
      </div>
      {problem != null && <p className="text-xs text-rose-700 dark:text-rose-400">{problem}</p>}
      {save.isError && <p className="text-xs text-rose-700 dark:text-rose-400">{save.error.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={save.isPending || !changed || problem != null}
          onClick={() => save.mutate(bucketsToSave(layout, draft), { onSuccess: (d) => setDraft(bucketsDraftOf(d.statusLayout)) })}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save statuses'}
        </button>
        <button
          type="button"
          disabled={!changed}
          onClick={() => {
            setDraft(bucketsDraftOf(layout));
            setAnnounce('Changes dropped.');
          }}
          className="rounded px-2 py-1 text-xs text-gray-600 hover:text-gray-800 disabled:opacity-50 dark:text-gray-300 dark:hover:text-gray-100"
        >
          Cancel
        </button>
        {!isDefault && (
          <button
            type="button"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({ ...SPRINT_STATUS_SETTINGS_DEFAULT }, { onSuccess: (d) => setDraft(bucketsDraftOf(d.statusLayout)) })
            }
            className="rounded px-2 py-1 text-xs text-gray-600 hover:text-gray-800 disabled:opacity-50 dark:text-gray-300 dark:hover:text-gray-100"
          >
            Reset to automatic
          </button>
        )}
      </div>
    </section>
  );
}
