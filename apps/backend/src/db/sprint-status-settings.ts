// Reports → This sprint — the workspace's STATUS LAYOUT override. The ONE reader and writer of
// `workspaces.sprint_statuses` (migration 0103 / pg 0090; shared `SprintStatusSettings`). OVERRIDES
// ONLY: NULL (or the default `{sections: null}`, stored as NULL) = the automatic layout
// (db/sprint-status-layout.ts). Each of the four stages lists the status NAMES the reader placed there,
// in order; the fold matches names case-insensitively.
//
// A STORED value is read tolerantly (bad names dropped, a malformed value read as automatic) — and a
// stored value of the RETIRED shape `{order, deliveredFrom}` is read into the new one (`legacyToSections`,
// which needs each status's category, so the layout fold passes `categoryOf`). Only a POSTED value is
// strict (shared `SprintStatusesUpdate`).
import { and, eq } from 'drizzle-orm';
import {
  SPRINT_STAGES,
  SPRINT_STATUS_NAME_MAX,
  SPRINT_STATUS_ORDER_MAX,
  SPRINT_STATUS_SETTINGS_DEFAULT,
  type JiraStatusCategory,
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

const emptySections = (): Record<SprintStage, string[]> => ({ not_started: [], in_progress: [], in_review: [], done: [] });

/** The retired `{order, deliveredFrom}` override as sections: the order is kept; category `new` → Not
 *  started, `done` → Done; any other status before `deliveredFrom` → In progress, from it on → In
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

/** Clean names out of one raw list; null (strict) on any bad entry. `seen` spans every stage. */
function cleanNames(raw: unknown, strict: boolean, seen: Set<string>): string[] | null {
  if (!Array.isArray(raw)) return strict ? null : [];
  const out: string[] = [];
  for (const n of raw) {
    const t = typeof n === 'string' ? n.trim() : '';
    if (typeof n !== 'string' || badName(t)) {
      if (strict) return null;
      continue;
    }
    const k = t.toLowerCase();
    if (seen.has(k)) {
      if (strict) return null;
      continue;
    }
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** A stored or posted value as clean settings, or null when a POSTED one is malformed (`strict`): a
 *  non-object; `sections` neither null nor an object with exactly the four stage keys, each an array;
 *  a non-string, empty, over-long or control-character name; one name in two places
 *  (case-insensitive); more than SPRINT_STATUS_ORDER_MAX names in all. A stored value never reads as
 *  null; a stored RETIRED `{order, deliveredFrom}` value is converted (`legacyToSections`, with
 *  `categoryOf` — absent → every status reads as in progress). An override naming nothing is the
 *  default. */
export function parseSprintStatusSettings(
  raw: unknown,
  strict: boolean,
  categoryOf: (name: string) => JiraStatusCategory | null = () => null,
): SprintStatusSettings | null {
  const fallback = (): SprintStatusSettings | null => (strict ? null : { ...SPRINT_STATUS_SETTINGS_DEFAULT });
  if (raw == null) return fallback();
  if (typeof raw !== 'object' || Array.isArray(raw)) return fallback();
  const r = raw as { sections?: unknown; order?: unknown; deliveredFrom?: unknown };

  if (!strict && !('sections' in r) && ('order' in r || 'deliveredFrom' in r)) {
    // The retired shape (stored before the four stages).
    const seen = new Set<string>();
    const order = cleanNames(r.order, false, seen) ?? [];
    const df = typeof r.deliveredFrom === 'string' && !badName(r.deliveredFrom.trim()) ? r.deliveredFrom.trim() : null;
    if (order.length === 0) return { ...SPRINT_STATUS_SETTINGS_DEFAULT };
    return { sections: legacyToSections(order.slice(0, SPRINT_STATUS_ORDER_MAX), df, categoryOf) };
  }

  if (!('sections' in r)) return fallback();
  if (r.sections === null) return { sections: null };
  if (typeof r.sections !== 'object' || Array.isArray(r.sections)) return fallback();
  const raws = r.sections as Record<string, unknown>;
  if (strict) {
    const keys = Object.keys(raws);
    if (keys.length !== SPRINT_STAGES.length || !SPRINT_STAGES.every((k) => keys.includes(k))) return null;
  }
  const seen = new Set<string>();
  const sections = emptySections();
  let total = 0;
  for (const stage of SPRINT_STAGES) {
    const names = raws[stage] == null && !strict ? [] : cleanNames(raws[stage], strict, seen);
    if (names == null) return null;
    const room = SPRINT_STATUS_ORDER_MAX - total;
    if (names.length > room) {
      if (strict) return null;
      names.length = Math.max(0, room);
    }
    sections[stage] = names;
    total += names.length;
  }
  return total === 0 ? { sections: null } : { sections };
}

const isDefault = (s: SprintStatusSettings): boolean =>
  s.sections == null || SPRINT_STAGES.every((k) => (s.sections?.[k] ?? []).length === 0);

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
    .set({ sprintStatuses: isDefault(settings) ? null : { sections: settings.sections } })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
    .returning({ id: workspaces.id })
    .execute();
  return rows.length > 0;
}
