// Activity → This Sprint — the workspace's STATUS BUCKETS override. The ONE reader and writer of
// `workspaces.sprint_statuses` (migration 0103 / pg 0090; shared `SprintStatusSettings`). OVERRIDES
// ONLY: NULL (or the default `{buckets: null, mergedColumn: true}`, stored as NULL) = the automatic
// layout (db/sprint-status-layout.ts). Each bucket lists the status NAMES the reader placed there, in
// order; the fold matches names case-insensitively.
//
// A STORED value is read tolerantly (bad names and bad buckets dropped, a malformed value read as
// automatic) — and a stored value of a RETIRED shape is read into four buckets named
// SPRINT_STAGE_LABEL: `{sections}` (per-stage lists) directly, `{order, deliveredFrom}` through
// `legacyToSections` (which needs each status's category, so the layout fold passes `categoryOf`).
// Only a POSTED value is strict (`parseSprintStatusSettingsStrict`, whose problem is the 400's message).
import { and, eq } from 'drizzle-orm';
import {
  SPRINT_BUCKET_ID_RE,
  SPRINT_BUCKET_NAME_MAX,
  SPRINT_BUCKETS_MAX,
  SPRINT_MERGED_COLUMN_ID,
  SPRINT_STAGE_LABEL,
  SPRINT_STAGES,
  SPRINT_STATUS_NAME_MAX,
  SPRINT_STATUS_ORDER_MAX,
  SPRINT_STATUS_SETTINGS_DEFAULT,
  sprintBucketsProblem,
  type JiraStatusCategory,
  type SprintBucket,
  type SprintStage,
  type SprintStatusSettings,
} from '@pierre-review/shared';

// ⚠ db/client is imported LAZILY: the pure parser is imported by the pure layout fold (and its tests),
// which must not open a database at import.
const dbMods = async () => {
  const client = await import('./client.js');
  return { db: client.db, workspaces: client.schema.workspaces };
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const badName = (n: string): boolean => n === '' || n.length > SPRINT_STATUS_NAME_MAX || CONTROL.test(n);
const norm = (s: string): string => s.trim().toLowerCase();
const STAGE_RANK: Record<SprintStage, number> = { not_started: 0, in_progress: 1, in_review: 2, done: 3 };
const isStage = (v: unknown): v is SprintStage => typeof v === 'string' && (SPRINT_STAGES as readonly string[]).includes(v);

const emptySections = (): Record<SprintStage, string[]> => ({ not_started: [], in_progress: [], in_review: [], done: [] });

/** Four buckets named SPRINT_STAGE_LABEL from per-stage lists (the retired shapes). Pure. */
export function sectionsToBuckets(sections: Record<SprintStage, string[]>): SprintBucket[] {
  return SPRINT_STAGES.map((s) => ({ id: s, name: SPRINT_STAGE_LABEL[s], meaning: s, statuses: [...sections[s]] }));
}

/** The retired `{order, deliveredFrom}` override as sections: the order is kept; category `new` → Not
 *  started, `done` → Complete; any other status before `deliveredFrom` → In progress, from it on → In
 *  review (no `deliveredFrom`, or one not in the order → all In progress). Pure. */
export function legacyToSections(
  order: readonly string[],
  deliveredFrom: string | null,
  categoryOf: (name: string) => JiraStatusCategory | null,
): Record<SprintStage, string[]> {
  const out = emptySections();
  const fromAt = deliveredFrom == null ? -1 : order.findIndex((n) => norm(n) === norm(deliveredFrom));
  order.forEach((name, i) => {
    const cat = categoryOf(name);
    if (cat === 'new') out.not_started.push(name);
    else if (cat === 'done') out.done.push(name);
    else if (fromAt >= 0 && i >= fromAt) out.in_review.push(name);
    else out.in_progress.push(name);
  });
  return out;
}

/** Clean names out of one raw list, tolerantly (bad entries and repeats dropped). `seen` spans every
 *  bucket; `room` caps the total. */
function cleanNames(raw: unknown, seen: Set<string>, room: { left: number }): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const n of raw) {
    const t = typeof n === 'string' ? n.trim() : '';
    if (typeof n !== 'string' || badName(t)) continue;
    const k = t.toLowerCase();
    if (seen.has(k) || room.left <= 0) continue;
    seen.add(k);
    room.left -= 1;
    out.push(t);
  }
  return out;
}

/** A STORED value's buckets, tolerantly: bad buckets and names dropped, names cut to length, a bucket
 *  whose name repeats an earlier one's (case-insensitive) dropped; null (automatic) when nothing usable
 *  is left or the meanings go backwards. */
function tolerantBuckets(raw: unknown): SprintBucket[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SprintBucket[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const seen = new Set<string>();
  const room = { left: SPRINT_STATUS_ORDER_MAX };
  for (const b of raw.slice(0, SPRINT_BUCKETS_MAX)) {
    if (b == null || typeof b !== 'object') continue;
    const r = b as { id?: unknown; name?: unknown; meaning?: unknown; statuses?: unknown };
    if (typeof r.id !== 'string' || !SPRINT_BUCKET_ID_RE.test(r.id) || r.id === SPRINT_MERGED_COLUMN_ID || ids.has(r.id)) continue;
    if (!isStage(r.meaning)) continue;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, SPRINT_BUCKET_NAME_MAX) : '';
    if (name === '' || CONTROL.test(name) || names.has(name.toLowerCase())) continue;
    ids.add(r.id);
    names.add(name.toLowerCase());
    out.push({ id: r.id, name, meaning: r.meaning, statuses: cleanNames(r.statuses, seen, room) });
  }
  if (out.length === 0) return null;
  for (let i = 1; i < out.length; i += 1) if (STAGE_RANK[out[i]!.meaning] < STAGE_RANK[out[i - 1]!.meaning]) return null;
  return out;
}

/** A POSTED value, strictly: the settings, or the problem in plain words (the 400's message). A
 *  non-object; `buckets` neither null nor an array passing `sprintBucketsProblem`; `mergedColumn`
 *  present and not a boolean. Names are trimmed. */
export function parseSprintStatusSettingsStrict(
  raw: unknown,
): { ok: true; settings: SprintStatusSettings } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return bad('Send the status settings.');
  const r = raw as { buckets?: unknown; mergedColumn?: unknown };
  if (!('buckets' in r)) return bad('Send the status settings.');
  if (r.mergedColumn !== undefined && typeof r.mergedColumn !== 'boolean') return bad('Say whether to show the merged column.');
  const mergedColumn = r.mergedColumn ?? true;
  if (r.buckets === null) return { ok: true, settings: { buckets: null, mergedColumn } };
  if (!Array.isArray(r.buckets)) return bad('Send the buckets as a list.');
  for (const b of r.buckets) {
    if (b == null || typeof b !== 'object' || Array.isArray(b)) return bad('Each bucket needs an id, a name, a meaning and its statuses.');
  }
  const buckets = (r.buckets as Array<Record<string, unknown>>).map((b) => ({
    id: b.id as string,
    name: typeof b.name === 'string' ? b.name.trim() : (b.name as string),
    meaning: b.meaning as SprintStage,
    statuses: Array.isArray(b.statuses) ? b.statuses.map((s) => (typeof s === 'string' ? s.trim() : s)) : (b.statuses as string[]),
  }));
  const problem = sprintBucketsProblem(buckets);
  if (problem != null) return bad(problem);
  return { ok: true, settings: { buckets, mergedColumn } };
}

/** A stored or posted value as clean settings, or null when a POSTED one is malformed (`strict`, see
 *  `parseSprintStatusSettingsStrict`). A stored value never reads as null: malformed → the default; a
 *  RETIRED `{sections}` value → four buckets; a RETIRED `{order, deliveredFrom}` value → four buckets
 *  via `legacyToSections` (with `categoryOf` — absent → every status reads as in progress). */
export function parseSprintStatusSettings(
  raw: unknown,
  strict: boolean,
  categoryOf: (name: string) => JiraStatusCategory | null = () => null,
): SprintStatusSettings | null {
  if (strict) {
    const p = parseSprintStatusSettingsStrict(raw);
    return p.ok ? p.settings : null;
  }
  const dflt = (): SprintStatusSettings => ({ ...SPRINT_STATUS_SETTINGS_DEFAULT });
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return dflt();
  const r = raw as { buckets?: unknown; mergedColumn?: unknown; sections?: unknown; order?: unknown; deliveredFrom?: unknown };
  const mergedColumn = typeof r.mergedColumn === 'boolean' ? r.mergedColumn : true;

  if ('buckets' in r) return { buckets: tolerantBuckets(r.buckets), mergedColumn };

  if ('sections' in r) {
    // The retired per-stage shape (stored before buckets).
    if (r.sections == null || typeof r.sections !== 'object' || Array.isArray(r.sections)) return dflt();
    const raws = r.sections as Record<string, unknown>;
    const seen = new Set<string>();
    const room = { left: SPRINT_STATUS_ORDER_MAX };
    const sections = emptySections();
    for (const stage of SPRINT_STAGES) sections[stage] = cleanNames(raws[stage], seen, room);
    return seen.size === 0 ? dflt() : { buckets: sectionsToBuckets(sections), mergedColumn };
  }

  if ('order' in r || 'deliveredFrom' in r) {
    // The oldest retired shape (stored before the four stages).
    const order = cleanNames(r.order, new Set(), { left: SPRINT_STATUS_ORDER_MAX });
    const df = typeof r.deliveredFrom === 'string' && !badName(r.deliveredFrom.trim()) ? r.deliveredFrom.trim() : null;
    if (order.length === 0) return dflt();
    return { buckets: sectionsToBuckets(legacyToSections(order, df, categoryOf)), mergedColumn };
  }
  return dflt();
}

/** Is this the default (stored as NULL)? */
export const isDefaultSprintStatusSettings = (s: SprintStatusSettings): boolean => s.buckets == null && s.mergedColumn;

/** The stored JSON as it is (null = none), for a caller that parses it with categories. */
export async function getSprintStatusSettingsRaw(accountId: number, workspaceId: number): Promise<unknown> {
  const { db, workspaces } = await dbMods();
  const row = (
    await db
      .select({ sprintStatuses: workspaces.sprintStatuses })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  return row?.sprintStatuses ?? null;
}

/** The workspace's override (the default for a workspace that is not this account's). `categoryOf`
 *  converts a stored value of the retired shape. */
export async function getSprintStatusSettings(
  accountId: number,
  workspaceId: number,
  categoryOf?: (name: string) => JiraStatusCategory | null,
): Promise<SprintStatusSettings> {
  const raw = await getSprintStatusSettingsRaw(accountId, workspaceId);
  return parseSprintStatusSettings(raw, false, categoryOf) ?? { ...SPRINT_STATUS_SETTINGS_DEFAULT };
}

/** Replace the override (already validated; the default is stored as NULL). False when the workspace
 *  is not this account's. */
export async function setSprintStatusSettings(
  accountId: number,
  workspaceId: number,
  settings: SprintStatusSettings,
): Promise<boolean> {
  const { db, workspaces } = await dbMods();
  const rows = await db
    .update(workspaces)
    .set({ sprintStatuses: isDefaultSprintStatusSettings(settings) ? null : { buckets: settings.buckets, mergedColumn: settings.mergedColumn } })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
    .returning({ id: workspaces.id })
    .execute();
  return rows.length > 0;
}
