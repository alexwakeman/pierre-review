import {
  SPRINT_BUCKETS_MAX,
  SPRINT_DELIVERED_MIN_SHARE,
  SPRINT_DELIVERED_MIN_TICKETS,
  SPRINT_MERGED_COLUMN_ID,
  SPRINT_STATUS_ORDER_MAX,
  sprintBucketsProblem,
  isTrackerIdent,
  parseTicketIdent,
  trackerTicketRow,
  type SprintBucket,
  type SprintStage,
  type SprintStatusEvidence,
  type SprintStatusLayout,
  type SprintStatusSettings,
  type TicketSite,
} from '@pierre-review/shared';

// Activity → This Sprint: the pure folds behind the tab that survive the move to the GRAPH (the status
// settings, the ticket's site). test/sprintModel.test.ts.
// ⚠ Nothing here ranks tickets or people.

const normStatus = (s: string): string => s.trim().toLowerCase();

// ── The status settings: buckets ─────────────────────────────────────────────────────────────────

/** One bucket in the editor's draft. */
export interface BucketDraft {
  id: string;
  name: string;
  meaning: SprintStage;
  /** Every status in this bucket, in order. */
  statuses: string[];
}

/** The editor's draft: every bucket with every status, and the merged column switch. */
export interface StatusBucketsDraft {
  buckets: BucketDraft[];
  mergedColumn: boolean;
}

const copyDraft = (d: StatusBucketsDraft): StatusBucketsDraft => ({
  mergedColumn: d.mergedColumn,
  buckets: d.buckets.map((b) => ({ ...b, statuses: [...b.statuses] })),
});

/** The layout as a draft (its resolved buckets, every status in place). */
export function bucketsDraftOf(layout: Pick<SprintStatusLayout, 'buckets' | 'settings'>): StatusBucketsDraft {
  return {
    mergedColumn: layout.settings.mergedColumn,
    buckets: layout.buckets.map((b) => ({ id: b.id, name: b.name, meaning: b.meaning, statuses: b.statuses.map((s) => s.name) })),
  };
}

/** A fresh bucket id the draft does not use (never the merged column's). */
export function newBucketId(draft: StatusBucketsDraft): string {
  const used = new Set(draft.buckets.map((b) => b.id));
  for (let i = 1; ; i += 1) {
    const id = `b${i}`;
    if (!used.has(id) && id !== SPRINT_MERGED_COLUMN_ID) return id;
  }
}

/** Add an empty bucket at the end, meaning what the last one means (so the order stays valid), named
 *  "New bucket" (numbered past any taken). At SPRINT_BUCKETS_MAX → unchanged. */
export function addBucket(draft: StatusBucketsDraft): StatusBucketsDraft {
  const out = copyDraft(draft);
  if (out.buckets.length >= SPRINT_BUCKETS_MAX) return out;
  const taken = new Set(out.buckets.map((b) => b.name.trim().toLowerCase()));
  let name = 'New bucket';
  for (let i = 2; taken.has(name.toLowerCase()); i += 1) name = `New bucket ${i}`;
  out.buckets.push({ id: newBucketId(draft), name, meaning: out.buckets[out.buckets.length - 1]?.meaning ?? 'not_started', statuses: [] });
  return out;
}

export function renameBucket(draft: StatusBucketsDraft, id: string, name: string): StatusBucketsDraft {
  const out = copyDraft(draft);
  const b = out.buckets.find((x) => x.id === id);
  if (b != null) b.name = name;
  return out;
}

export function setBucketMeaning(draft: StatusBucketsDraft, id: string, meaning: SprintStage): StatusBucketsDraft {
  const out = copyDraft(draft);
  const b = out.buckets.find((x) => x.id === id);
  if (b != null) b.meaning = meaning;
  return out;
}

/** Delete a bucket; its statuses move to the first other bucket with the same meaning, else the one
 *  before it, else the one after. The last bucket cannot go (unchanged). */
export function removeBucket(draft: StatusBucketsDraft, id: string): StatusBucketsDraft {
  const out = copyDraft(draft);
  const at = out.buckets.findIndex((b) => b.id === id);
  if (at < 0 || out.buckets.length <= 1) return out;
  const [gone] = out.buckets.splice(at, 1);
  const heir = out.buckets.find((b) => b.meaning === gone!.meaning) ?? out.buckets[at - 1] ?? out.buckets[at]!;
  heir.statuses.push(...gone!.statuses);
  return out;
}

/** Move a bucket one place earlier (-1) or later (+1). Off either end → unchanged. (A move that puts
 *  the meanings out of order is allowed; `bucketsDraftProblem` says so and Save waits.) */
export function moveBucket(draft: StatusBucketsDraft, index: number, dir: -1 | 1): StatusBucketsDraft {
  const out = copyDraft(draft);
  const to = index + dir;
  if (index < 0 || index >= out.buckets.length || to < 0 || to >= out.buckets.length) return out;
  const [b] = out.buckets.splice(index, 1);
  out.buckets.splice(to, 0, b!);
  return out;
}

/** Move one status one step up (-1) or down (+1), crossing into the neighbouring bucket at either end of
 *  its list (it lands last / first there). Off either end of the whole list → unchanged. */
export function moveStatusStep(draft: StatusBucketsDraft, bucket: number, index: number, dir: -1 | 1): StatusBucketsDraft {
  const out = copyDraft(draft);
  const list = out.buckets[bucket]?.statuses;
  if (list == null || index < 0 || index >= list.length) return out;
  const to = index + dir;
  if (to >= 0 && to < list.length) {
    const [x] = list.splice(index, 1);
    list.splice(to, 0, x!);
    return out;
  }
  const next = out.buckets[bucket + dir];
  if (next == null) return out;
  const [x] = list.splice(index, 1);
  if (dir < 0) next.statuses.push(x!);
  else next.statuses.unshift(x!);
  return out;
}

/** Can that step happen at all? */
export function canMoveStatusStep(draft: StatusBucketsDraft, bucket: number, index: number, dir: -1 | 1): boolean {
  const list = draft.buckets[bucket]?.statuses;
  if (list == null || index < 0 || index >= list.length) return false;
  if (dir < 0) return index > 0 || bucket > 0;
  return index < list.length - 1 || bucket < draft.buckets.length - 1;
}

/**
 * THE DRAG MOVE: take the status at `from` and insert it at SLOT `toIndex` of bucket `toBucket` — a slot
 * counted over that list AS SHOWN, before the move (0 = above its first row, `length` = below its
 * last). Within one list a slot just above or below the row itself is a no-op. Bad indexes → unchanged
 * (a copy).
 */
export function moveStatusTo(
  draft: StatusBucketsDraft,
  from: { bucket: number; index: number },
  toBucket: number,
  toIndex: number,
): StatusBucketsDraft {
  const out = copyDraft(draft);
  const src = out.buckets[from.bucket]?.statuses;
  const dst = out.buckets[toBucket]?.statuses;
  if (src == null || dst == null || from.index < 0 || from.index >= src.length) return out;
  if (toIndex < 0 || toIndex > dst.length) return out;
  const [x] = src.splice(from.index, 1);
  const at = toBucket === from.bucket && toIndex > from.index ? toIndex - 1 : toIndex;
  dst.splice(at, 0, x!);
  return out;
}

/** Where a status sits: its bucket index and position, or null when the draft does not list it. */
export function statusPlaceOf(draft: StatusBucketsDraft, name: string): { bucket: number; index: number } | null {
  for (let bucket = 0; bucket < draft.buckets.length; bucket += 1) {
    const index = draft.buckets[bucket]!.statuses.indexOf(name);
    if (index >= 0) return { bucket, index };
  }
  return null;
}

/** "Coding begins" / "Coding ends", read off the DRAFT by the server's rule: the first status in a
 *  bucket meaning In progress, and the first in one meaning In review (null when there is none). */
export function codingBoundsOf(draft: StatusBucketsDraft): { begins: string | null; ends: string | null } {
  const first = (m: SprintStage): string | null => draft.buckets.find((b) => b.meaning === m && b.statuses.length > 0)?.statuses[0] ?? null;
  return { begins: first('in_progress'), ends: first('in_review') };
}

const sameBuckets = (a: readonly BucketDraft[], b: readonly BucketDraft[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]!;
    return (
      x.id === y.id &&
      x.name.trim() === y.name.trim() &&
      x.meaning === y.meaning &&
      x.statuses.length === y.statuses.length &&
      x.statuses.every((n, j) => normStatus(n) === normStatus(y.statuses[j]!))
    );
  });

/** Did the reader change anything from what was shown? (Save is offered only then.) */
export function bucketsDraftChanged(layout: Pick<SprintStatusLayout, 'buckets' | 'settings'>, draft: StatusBucketsDraft): boolean {
  const shown = bucketsDraftOf(layout);
  return shown.mergedColumn !== draft.mergedColumn || !sameBuckets(shown.buckets, draft.buckets);
}

/** What Save sends: buckets unchanged from what was shown → the stored buckets as they were (automatic
 *  stays automatic when only the switch moved); changed → every bucket with every status, names
 *  trimmed, statuses capped at the route's limit overall. */
export function bucketsToSave(layout: Pick<SprintStatusLayout, 'buckets' | 'settings'>, draft: StatusBucketsDraft): SprintStatusSettings {
  if (sameBuckets(bucketsDraftOf(layout).buckets, draft.buckets)) return { buckets: layout.settings.buckets, mergedColumn: draft.mergedColumn };
  let room = SPRINT_STATUS_ORDER_MAX;
  const buckets: SprintBucket[] = draft.buckets.map((b) => {
    const statuses = b.statuses.slice(0, Math.max(0, room));
    room -= statuses.length;
    return { id: b.id, name: b.name.trim(), meaning: b.meaning, statuses };
  });
  return { buckets, mergedColumn: draft.mergedColumn };
}

/** What stops Save, in plain words (the server's own check, shared `sprintBucketsProblem`); null when
 *  the draft may be saved. */
export function bucketsDraftProblem(draft: StatusBucketsDraft): string | null {
  return sprintBucketsProblem(draft.buckets.map((b) => ({ ...b, name: b.name.trim() })));
}

/** Statuses the reader's buckets do not name yet ("not placed yet"): only when buckets are set — under
 *  the automatic layout every status is placed automatically and nothing is marked. */
export function unplacedStatuses(layout: Pick<SprintStatusLayout, 'order' | 'settings'>): Set<string> {
  if (layout.settings.buckets == null) return new Set();
  return new Set(layout.order.filter((o) => o.auto).map((o) => o.name));
}

/** Where the order came from, in words. `inSentence` → the mid-sentence form (proper nouns keep
 *  their capitals; never lower-case the whole label). */
export function statusOrderSourceLabel(
  source: SprintStatusLayout['orderSource'],
  opts: { inSentence?: boolean } = {},
): string {
  if (opts.inSentence) {
    switch (source) {
      case 'override':
        return 'your buckets';
      case 'jira_board':
        return 'your board’s columns';
      case 'linear_states':
        return 'Linear’s workflow';
      case 'github':
        return 'open, then closed';
      case 'fallback':
        return 'status category, then name';
    }
  }
  switch (source) {
    case 'override':
      return 'Your buckets';
    case 'jira_board':
      return 'Your board’s columns';
    case 'linear_states':
      return 'Linear’s workflow';
    case 'github':
      return 'Open, then closed';
    case 'fallback':
      return 'Status category, then name';
  }
}

/** A share as "3 in 5" (smallest denominator up to 10 that states it exactly), else a percentage. */
export function shareWords(share: number): string {
  for (let d = 2; d <= 10; d += 1) {
    const n = share * d;
    if (Math.abs(n - Math.round(n)) < 1e-9) return `${Math.round(n)} in ${d}`;
  }
  return `${Math.round(share * 100)}%`;
}

/** The automatic "In review starts at" rule, read from the shared constants. */
export function reviewRuleSentence(): string {
  return `In review starts at a status whose name reads as review or QA, or the first in-progress status where at least ${shareWords(SPRINT_DELIVERED_MIN_SHARE)} tickets with pull requests have them all merged, and at least ${SPRINT_DELIVERED_MIN_TICKETS} do.`;
}

/** "Ready for QA · 4 of 6 merged". */
export function statusEvidenceLine(e: SprintStatusEvidence): string {
  return `${e.status} · ${e.allMerged} of ${e.withPrs} merged`;
}

/** The ticket's tracker site, from its ident (shared `parseTicketIdent` → `trackerTicketRow`); null for
 *  an ident that is not a tracker's. */
export function sprintTicketSite(t: { ident: string }): TicketSite | null {
  const p = parseTicketIdent(t.ident);
  if (!isTrackerIdent(p)) return null;
  const row = trackerTicketRow(p);
  return { provider: row.provider, root: row.apiRoot };
}
